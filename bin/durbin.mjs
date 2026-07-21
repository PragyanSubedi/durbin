#!/usr/bin/env node
// durbin: dictate to Claude Code from your phone and watch your dev server's
// live preview. One token-gated URL serves both:
//
//   /__agent   phone UI that runs Claude Code (via the Claude Agent SDK) in
//              the project you launch durbin from, streaming output live.
//              Permission requests and questions pause the run and surface
//              as cards you answer from the phone.
//   /*         reverse proxy to your dev server (HMR websockets included),
//              so the live preview is the same URL's root.
//
// Usage: run `durbin` in your project root. It enables Tailscale Funnel for
// the port by itself and prints the phone URL (--no-funnel skips). See README.

import http from "node:http";
import os from "node:os";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import qrcode from "qrcode-terminal";

// ---------- CLI ----------
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`durbin: phone-driven Claude Code + live dev-server preview

Usage: durbin [options]              (run from your project root)
       durbin password <password>    set a login password for this project

Options:
  --port <n>        bridge port (default 8787, env DURBIN_PORT)
  --dev-port <n>    dev server port to proxy (default 3000, env DURBIN_DEV_PORT;
                    also changeable live by tapping the port number on the phone)
  --dev-cmd <cmd>   command that starts the dev server (default "npm run dev")
  --claude <path>   claude executable (default: SDK bundled binary)
  --no-funnel       don't set up Tailscale Funnel automatically
  --help            show this help

The access token is printed on startup and stored in .durbin/token. The login
page accepts the token or, if set, your password.`);
  process.exit(0);
}

if (argv[0] === "password") {
  const pw = argv[1];
  if (!pw || pw.length < 6) {
    console.error("usage: durbin password <new-password>   (6+ characters)");
    process.exit(1);
  }
  const dataDir = path.join(process.cwd(), ".durbin");
  fs.mkdirSync(dataDir, { recursive: true });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  fs.writeFileSync(path.join(dataDir, "password"), salt.toString("hex") + ":" + hash.toString("hex"), { mode: 0o600 });
  console.log("Password set for this project. Restart durbin if it is running.");
  process.exit(0);
}

const ROOT = process.cwd();
const PORT = Number(flag("port", process.env.DURBIN_PORT || 8787));
const DEV_PORT_ARG = Number(flag("dev-port", process.env.DURBIN_DEV_PORT || 0)) || 0;
const DEV_CMD = flag("dev-cmd", process.env.DURBIN_DEV_CMD || "npm run dev");
const CLAUDE_BIN = flag("claude", process.env.DURBIN_CLAUDE_BIN || "");
const NO_FUNNEL = argv.includes("--no-funnel") || !!process.env.DURBIN_NO_FUNNEL;

const DATA = path.join(ROOT, ".durbin");
const LOG_DIR = path.join(DATA, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

// Keep .durbin/ out of the project's git status without touching .gitignore.
try {
  const exclude = path.join(ROOT, ".git", "info", "exclude");
  if (fs.existsSync(path.join(ROOT, ".git"))) {
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!cur.includes(".durbin/")) fs.appendFileSync(exclude, "\n.durbin/\n");
  }
} catch {}

// ---------- auth ----------
const TOKEN_FILE = path.join(DATA, "token");
if (!fs.existsSync(TOKEN_FILE)) {
  fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
}
const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();

function cookieToken(req) {
  const m = /(?:^|;\s*)durbin_auth=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
function isAuthed(req) {
  return cookieToken(req) === TOKEN;
}

const PW_FILE = path.join(DATA, "password");
function passwordSet() {
  return fs.existsSync(PW_FILE);
}
function verifyPassword(pw) {
  try {
    const [saltHex, hashHex] = fs.readFileSync(PW_FILE, "utf8").trim().split(":");
    const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
  } catch { return false; }
}
function secretOk(s) {
  s = String(s || "");
  const t = Buffer.from(s), tok = Buffer.from(TOKEN);
  if (t.length === tok.length && crypto.timingSafeEqual(t, tok)) return true;
  return passwordSet() && verifyPassword(s);
}
const AUTH_COOKIE = `durbin_auth=${TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;

// ---------- persisted state (claude session id) ----------
const STATE_FILE = path.join(DATA, "state.json");
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}
let state = loadState();

// Dev-server port to proxy. Precedence: explicit --dev-port/env for this run,
// else the last port picked from the phone (persisted in state), else 3000.
// Changes made from the phone persist; a flag override lasts only this run.
let devPort = DEV_PORT_ARG || Number(state.devPort) || 3000;

// Model / thinking config, set from the phone (⚙) and persisted per project.
// model "" and effort "" mean the Claude Code default; thinking false turns
// extended thinking off. Applied at session boot and live via control requests.
function cfg() {
  if (!state.config) state.config = { model: "", effort: "", thinking: true };
  return state.config;
}

// ---------- sessions (each one is a Claude conversation + its scrollback) ----------
function histFile(key) { return path.join(DATA, `history-${key}.jsonl`); }
function newSessionEntry() {
  return { claudeSessionId: null, title: "", createdAt: Date.now(), updatedAt: Date.now() };
}

// Migrate the pre-sessions single-conversation format.
if (!state.sessions) {
  const key = crypto.randomBytes(4).toString("hex");
  const entry = newSessionEntry();
  entry.claudeSessionId = state.sessionId || null;
  state = { activeKey: key, sessions: { [key]: entry } };
  try {
    const legacy = path.join(DATA, "history.jsonl");
    if (fs.existsSync(legacy)) fs.renameSync(legacy, histFile(key));
  } catch {}
  saveState(state);
}
function activeSess() { return state.sessions[state.activeKey]; }

function loadHistoryFile(key) {
  try {
    return fs.readFileSync(histFile(key), "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    }).slice(-50);
  } catch { return []; }
}
let history = loadHistoryFile(state.activeKey);

function appendHistory(entry) {
  history.push(entry);
  if (history.length > 50) history = history.slice(-50);
  const a = activeSess();
  if (a) {
    a.updatedAt = Date.now();
    if (!a.title && entry.prompt) a.title = String(entry.prompt).slice(0, 48);
    saveState(state);
  }
  try { fs.appendFileSync(histFile(state.activeKey), JSON.stringify(entry) + "\n"); } catch {}
}

// ---------- web push (self-contained VAPID, payload-less pushes) ----------
// The push wakes the service worker; the worker fetches /__agent/status to
// decide what to say. No payload means no RFC 8291 encryption is needed.
const PUSH_FILE = path.join(DATA, "push.json");
const VAPID_FILE = path.join(DATA, "vapid.json");
let vapid;
try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); } catch {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  vapid = {
    publicKey: spki.subarray(spki.length - 65).toString("base64url"),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
}
let pushSubs = [];
try { pushSubs = JSON.parse(fs.readFileSync(PUSH_FILE, "utf8")); } catch {}
function savePushSubs() {
  try { fs.writeFileSync(PUSH_FILE, JSON.stringify(pushSubs)); } catch {}
}

function derToJose(sig) {
  // ECDSA DER (SEQUENCE of two INTEGERs) -> raw r||s as JOSE wants it.
  let o = 2;
  if (sig[1] & 0x80) o += sig[1] & 0x7f;
  const rLen = sig[o + 1];
  let r = sig.subarray(o + 2, o + 2 + rLen);
  o = o + 2 + rLen;
  const sLen = sig[o + 1];
  let s = sig.subarray(o + 2, o + 2 + sLen);
  const trim = (b) => { while (b.length > 32 && b[0] === 0) b = b.subarray(1); return b; };
  const pad = (b) => Buffer.concat([Buffer.alloc(32 - b.length), b]);
  return Buffer.concat([pad(trim(r)), pad(trim(s))]);
}

function vapidJwt(aud) {
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const input = b64u({ typ: "JWT", alg: "ES256" }) + "." +
    b64u({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: "mailto:webpush@durbin.invalid" });
  const sig = crypto.createSign("SHA256").update(input).sign(crypto.createPrivateKey(vapid.privatePem));
  return input + "." + derToJose(sig).toString("base64url");
}

async function sendPush(text) {
  sendFcm(text || "Claude update"); // fire-and-forget; never blocks web push
  if (!pushSubs.length) return;
  const dead = new Set();
  await Promise.all(pushSubs.map(async (sub, idx) => {
    try {
      const aud = new URL(sub.endpoint).origin;
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: { TTL: "120", Authorization: `vapid t=${vapidJwt(aud)}, k=${vapid.publicKey}` },
      });
      if (res.status === 404 || res.status === 410) dead.add(idx);
    } catch {}
  }));
  if (dead.size) {
    pushSubs = pushSubs.filter((_, i) => !dead.has(i));
    savePushSubs();
  }
}

// ---------- native push (FCM, for the durbin phone app) ----------
// Web push can't reach the app's webview (no browser push service there),
// so the app registers an FCM device token instead: the page it renders
// POSTs to /__agent/push/fcm, and the bridge sends to those tokens whenever
// it sends web push. Sending requires a Firebase service-account key at
// ~/.durbin/fcm.json (or DURBIN_FCM_KEY=<path>); without one, FCM is
// silently off and web push works as before. See the app repo's README.
const FCM_TOKENS_FILE = path.join(DATA, "fcm-tokens.json");
let fcmTokens = [];
try { fcmTokens = JSON.parse(fs.readFileSync(FCM_TOKENS_FILE, "utf8")); } catch {}
function saveFcmTokens() {
  try { fs.writeFileSync(FCM_TOKENS_FILE, JSON.stringify(fcmTokens)); } catch {}
}

let fcmCreds = null;
try {
  fcmCreds = JSON.parse(fs.readFileSync(
    process.env.DURBIN_FCM_KEY || path.join(os.homedir(), ".durbin", "fcm.json"), "utf8"));
} catch {}

let publicHost = ""; // set once Funnel reports the hostname; rides FCM data
let fcmAccess = { token: "", exp: 0 };
async function fcmAccessToken() {
  if (fcmAccess.exp > Date.now()) return fcmAccess.token;
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = b64u({ alg: "RS256", typ: "JWT" }) + "." + b64u({
    iss: fcmCreds.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(fcmCreds.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
      input + "." + sig.toString("base64url"),
  });
  if (!res.ok) throw new Error("fcm oauth " + res.status);
  const data = await res.json();
  fcmAccess = { token: data.access_token, exp: Date.now() + (data.expires_in - 300) * 1000 };
  return fcmAccess.token;
}

async function sendFcm(body) {
  if (!fcmCreds || !fcmTokens.length) return;
  let access;
  try { access = await fcmAccessToken(); } catch { return; }
  const dead = new Set();
  await Promise.all(fcmTokens.map(async (t, idx) => {
    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${fcmCreds.project_id}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              token: t.token,
              notification: { title: `durbin — ${path.basename(ROOT)}`, body },
              data: { host: publicHost },
              android: { priority: "high" },
              apns: { headers: { "apns-priority": "10" } },
            },
          }),
        });
      if (res.status === 404) dead.add(idx); // UNREGISTERED: device is gone
    } catch {}
  }));
  if (dead.size) {
    fcmTokens = fcmTokens.filter((_, i) => !dead.has(i));
    saveFcmTokens();
  }
}

const SW_JS = `
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let body = 'Claude update';
    try {
      const r = await fetch('/__agent/status');
      const s = await r.json();
      if (s.pendingKind === 'question') body = 'Claude has a question for you';
      else if (s.pendingKind === 'permission') body = 'Claude is asking for permission';
      else if (s.pendingKind === 'plan') body = 'Claude has a plan ready for you';
      else if (!s.running) body = 'Claude finished the task';
      else body = 'Claude is working';
    } catch {}
    await self.registration.showNotification('durbin', {
      body, icon: '/__agent/icon.png', badge: '/__agent/icon.png', tag: 'durbin',
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) =>
    ws.length ? ws[0].focus() : clients.openWindow('/__agent')));
});
`;

// ---------- claude runner (Agent SDK, persistent session) ----------
// One long-lived Claude Code process serves consecutive messages, so only the
// first message after boot pays startup cost (process spawn, transcript
// resume). The process is closed after 15 minutes idle and lazily rebooted;
// the conversation itself always survives via the on-disk session (resume).
// run.pending = { id, kind: 'question'|'permission', payload, rawInput, resolve }
let run = null; // { id, mode, prompt, lines: [], partial, pending, done, error, startedAt, log }
let session = null; // { push, end, interrupt, setPermissionMode, permMode }
let idleTimer = null;
const IDLE_MS = 15 * 60 * 1000;
const msgQueue = []; // messages sent while a run was active; auto-dispatched in order

// durbin mode -> SDK permission mode. "auto" rides acceptEdits and allows the
// rest in canUseTool, so AskUserQuestion still reaches the phone (true
// bypassPermissions would skip the callback and break the question flow).
const MODES = ["manual", "plan", "edit", "auto"];
const SDK_MODE = { manual: "default", plan: "plan", edit: "acceptEdits", auto: "acceptEdits" };
let currentMode = "edit"; // mode the live session was last set to

function summarizeInput(toolInput) {
  const i = toolInput || {};
  const brief = i.command || i.file_path || i.pattern || i.prompt || i.url;
  if (brief) return String(brief).slice(0, 300);
  try { return JSON.stringify(i).slice(0, 300); } catch { return ""; }
}

function pushEv(ev) {
  if (!run) return;
  run.lines.push(ev);
  try { run.log.write(JSON.stringify(ev) + "\n"); } catch {}
}

function canUseToolCb(toolName, toolInput, { signal } = {}) {
  if (!run || run.done) return Promise.resolve({ behavior: "deny", message: "No active run" });
  const kind = toolName === "AskUserQuestion" ? "question"
    : toolName === "ExitPlanMode" ? "plan" : "permission";
  // Auto mode: everything runs without asking. Questions (and plan approval,
  // though plans don't occur in auto) still pause and surface on the phone.
  if (run.mode === "auto" && kind === "permission") {
    return Promise.resolve({ behavior: "allow", updatedInput: toolInput });
  }
  return new Promise((resolve) => {
    const pid = crypto.randomBytes(4).toString("hex");
    const payload = kind === "question" ? { questions: toolInput.questions || [] }
      : kind === "plan" ? { plan: String(toolInput.plan || "").slice(0, 8000) }
      : { toolName, summary: summarizeInput(toolInput) };
    const settle = (res) => {
      if (run && run.pending && run.pending.id === pid) run.pending = null;
      clearTimeout(timer);
      resolve(res);
    };
    // Auto-deny if the phone never answers, so runs can't hang forever.
    const timer = setTimeout(() => settle({ behavior: "deny", message: "No answer from user within 15 minutes" }), 15 * 60 * 1000);
    if (signal) signal.addEventListener("abort", () => settle({ behavior: "deny", message: "Aborted" }));
    run.pending = { id: pid, kind, payload, rawInput: toolInput, resolve: settle };
    sendPush("Claude is waiting on your answer"); // wake the phone
  });
}

function closeSession() {
  clearTimeout(idleTimer);
  if (!session) return;
  try { session.end(); } catch {}
  session = null;
}

function finishRun(error) {
  if (!run || run.done) return;
  run.done = true;
  run.partial = "";
  if (error) run.error = run.error || error;
  if (run.pending) run.pending.resolve({ behavior: "deny", message: "Run ended" });
  try { run.log.end(); } catch {}
  appendHistory({
    id: run.id, prompt: run.prompt, imageCount: run.imageCount || 0,
    startedAt: run.startedAt, lines: run.lines, error: run.error,
  });
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeSession, IDLE_MS);
  if (msgQueue.length) {
    const next = msgQueue.shift();
    setImmediate(() => startRun(next.prompt, next.mode, next.images));
  } else {
    sendPush("Claude finished the task"); // wake the phone
  }
}

function ensureSession() {
  if (session) return session;
  const queue = [];
  let wake = null;
  let ended = false;
  const push = (m) => { queue.push(m); if (wake) { const w = wake; wake = null; w(); } };
  const end = () => { ended = true; if (wake) { const w = wake; wake = null; w(); } };
  async function* input() {
    for (;;) {
      while (queue.length) yield queue.shift();
      if (ended) return;
      await new Promise((r) => { wake = r; });
      if (ended && !queue.length) return;
    }
  }

  const options = {
    cwd: ROOT,
    includePartialMessages: true,
    permissionMode: SDK_MODE[currentMode],
    canUseTool: canUseToolCb,
    // The bridge is for project work; skipping configured MCP servers saves
    // their connection handshakes on boot.
    mcpServers: {},
    strictMcpConfig: true,
  };
  if (CLAUDE_BIN) options.pathToClaudeCodeExecutable = CLAUDE_BIN;
  const c0 = cfg();
  if (c0.model) options.model = c0.model;
  if (c0.effort) options.effort = c0.effort;
  if (!c0.thinking) options.thinking = { type: "disabled" };
  const a0 = activeSess();
  if (a0 && a0.claudeSessionId) options.resume = a0.claudeSessionId;

  const q = query({ prompt: input(), options });
  const mySession = {
    push, end, interrupt: () => q.interrupt(),
    setPermissionMode: (m) => q.setPermissionMode(m),
    setModel: (m) => q.setModel(m || undefined),
    setEffort: (e) => q.applyFlagSettings({ effortLevel: e || null }),
    setThinking: (on) => q.setMaxThinkingTokens(on ? null : 0),
    supportedModels: () => q.supportedModels(),
    permMode: SDK_MODE[currentMode],
    retired: false, // a replaced session's teardown must not fail the new run
  };
  session = mySession;
  const thinkStart = {};
  (async () => {
    try {
      for await (const msg of q) {
        if (msg.session_id) {
          const a = activeSess();
          if (a && a.claudeSessionId !== msg.session_id) { a.claudeSessionId = msg.session_id; saveState(state); }
        }
        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (!run || run.done) continue;
          if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
            run.partial += ev.delta.text;
          } else if (ev && ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "thinking") {
            thinkStart[ev.index] = Date.now();
          } else if (ev && ev.type === "content_block_stop" && thinkStart[ev.index]) {
            pushEv({ type: "thought", seconds: Math.max(1, Math.round((Date.now() - thinkStart[ev.index]) / 1000)) });
            delete thinkStart[ev.index];
          }
        } else if (msg.type === "assistant") {
          if (run && !run.done) {
            run.partial = "";
            pushEv({ type: "assistant", message: { content: msg.message.content } });
          }
        } else if (msg.type === "user") {
          const c = msg.message && msg.message.content;
          if (Array.isArray(c) && run && !run.done) {
            for (const b of c) {
              if (b.type !== "tool_result") continue;
              let text = "";
              if (typeof b.content === "string") text = b.content;
              else if (Array.isArray(b.content)) {
                text = b.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
              }
              pushEv({ type: "tool_result", id: b.tool_use_id, is_error: !!b.is_error, text: String(text).slice(0, 4000) });
            }
          }
        } else if (msg.type === "result") {
          pushEv({ type: "result", subtype: msg.subtype, duration_ms: msg.duration_ms, result: msg.result });
          finishRun();
          // No break: the process stays warm for the next message.
        }
      }
    } catch (e) {
      if (!mySession.retired) finishRun(String(e && e.message || e));
    } finally {
      if (session === mySession) session = null;
      if (!mySession.retired) finishRun("Claude session ended unexpectedly");
    }
  })();
  return session;
}

// Point the live session at a (possibly different) durbin mode. Mid-run mode
// flips (plan approval) must not kill the session, so failures there are
// swallowed; between runs a failed control request just reboots the process
// (the conversation survives via resume).
function switchMode(mode) {
  currentMode = mode;
  if (run && !run.done) run.mode = mode;
  const s = session;
  if (!s || s.permMode === SDK_MODE[mode]) return Promise.resolve();
  const want = SDK_MODE[mode];
  return s.setPermissionMode(want).then(() => { s.permMode = want; }, () => {});
}

function startRun(prompt, mode, images) {
  const id = crypto.randomBytes(6).toString("hex");
  clearTimeout(idleTimer);
  currentMode = mode;
  run = {
    id, mode, prompt, imageCount: Array.isArray(images) ? images.length : 0,
    lines: [], partial: "", pending: null, done: false, error: null,
    startedAt: Date.now(), log: fs.createWriteStream(path.join(LOG_DIR, `run-${id}.jsonl`)),
  };

  // Attached screenshots become image content blocks ahead of the text.
  let content = prompt;
  if (Array.isArray(images) && images.length) {
    content = images.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.media_type, data: im.data },
    }));
    content.push({ type: "text", text: prompt });
  }

  const s = ensureSession();
  const want = SDK_MODE[mode];
  const ready = s.permMode === want ? Promise.resolve()
    : s.setPermissionMode(want).then(() => { s.permMode = want; }, () => {
        // The control request failed (dying process or an old CLI): retire
        // this session and reboot below with the right mode; the conversation
        // survives via resume.
        s.retired = true;
        if (session === s) session = null;
        try { s.end(); } catch {}
      });
  ready.then(() => {
    ensureSession().push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  });
  return id;
}

// ---------- dev server control ----------
function portUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
function devServerUp() {
  return portUp(devPort);
}

let devStarting = false;
function startDevServer() {
  if (devStarting) return;
  devStarting = true;
  const fd = fs.openSync(path.join(LOG_DIR, "dev.log"), "a");
  const child = spawn(DEV_CMD, {
    cwd: ROOT, shell: true, detached: true, stdio: ["ignore", fd, fd],
  });
  child.unref();
  // Hold the guard until the server actually answers (or 90s passes), so
  // repeat presses can never spawn a second instance on another port.
  const t0 = Date.now();
  const tick = async () => {
    if (await devServerUp() || Date.now() - t0 > 90000) { devStarting = false; return; }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
}

// ---------- proxy ----------
function proxyHttp(req, res) {
  const opts = {
    host: "127.0.0.1", port: devPort, path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": req.headers.host || "" },
  };
  const p = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  p.on("error", () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#262624;color:#faf9f5;display:grid;place-items:center;min-height:100vh;margin:0">
      <div style="text-align:center;padding:24px"><h2>Dev server is not running</h2>
      <p id="hint" style="color:#a5a29a">Start it from the agent page &mdash; this page reloads itself once it answers.</p>
      <p id="open"><a href="/__agent" target="_top" style="color:#d97757">Open agent</a></p></div>
      <script>
      if (window.top !== window) { // embedded in the agent's preview pane: the agent is already here
        document.getElementById('open').style.display = 'none';
        document.getElementById('hint').textContent = 'Start it from the + menu (or ask the agent to) — this page reloads itself once it answers.';
      }
      setInterval(() => {
        fetch(location.href, { method: 'HEAD', cache: 'no-store' })
          .then(r => { if (r.status !== 502) location.reload(); })
          .catch(() => {});
      }, 2000);</script>`);
  });
  req.pipe(p);
}

function proxyUpgrade(req, socket, head) {
  if (!isAuthed(req)) { socket.destroy(); return; }
  const p = http.request({
    host: "127.0.0.1", port: devPort, path: req.url, method: req.method,
    headers: { ...req.headers },
  });
  p.on("upgrade", (pres, psocket, phead) => {
    const headerLines = [];
    for (let i = 0; i < pres.rawHeaders.length; i += 2) {
      headerLines.push(`${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}`);
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (phead && phead.length) socket.write(phead);
    if (head && head.length) psocket.write(head);
    psocket.pipe(socket);
    socket.pipe(psocket);
    const kill = () => { psocket.destroy(); socket.destroy(); };
    psocket.on("error", kill);
    socket.on("error", kill);
  });
  p.on("error", () => socket.destroy());
  p.end();
}

// ---------- helpers ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => { data += d; if (data.length > 30e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ---------- UI ----------
// 180x180 home-screen icon: amber lens ring on dark (durbin = telescope).
const ICON_B64 = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAADYklEQVR42u3dy3EcMQwEUETBEB2Us1JGOvokS1WaIdHg69oAwJ5X0Go/s7VEvkipQOAQOAQOgUPgEDgEDoFD4BA4ROAQOAQOgUPgEDgEDoFD4BA4ROAQOAQOgWNDPv7++f8DDjh++oADjhuVwPEYjnlK4HhRDxygjCUCxyYocEy4wIjci2Pbk80BRIqGV61E+ygmNigJJVJMbFMS56OwQGQyjlYsfnLJU3wUFn2IwHERi28vfPMVUlicJdLZR5HRc4XAcZ2MLB+FRec/MXDcKCPCR5HBRySOU++WHZ+niY+6hEXchHDs6D131OM+aqqMGWOfPdRAHMOGP3i6miRj5CngmCNjko8a0ObIf8U7+CgyEn3AMeTLZLnLo0K7W2lJ9FFk5PqYjOPCGxz8/sg72wjDsfITtDyKjLizb6sFDsujGQ533IpYHhk41sT0Xx5FRqiPDS3BYXm0wUHGS8vjOhzrjrT9y1LWhuWRh2PdFDjgeKWZ90orMiwPOOCAw/8scTjISFwecMCRg2PdHTj64ugwAByNcKQMs//Vjmp14M3XI3ekPcujrl0b6WThaCGj7WxwtJDRczw4ushoOCEccMCxpfqIu43BAQcccMABBxzZrzWNvPHtq5PYHEM2BxxwwAEHHHDA4RVSOOCAIx3HGvquLBwnfTScDY75rzXB4TOkeV359PmQT5/DsWPO4wPA4RtvcLR/2hEqAw447sDBR2I/cMABBxydcfAR1wwccATicAfju3BYHlmd+NUEa6MNDj6CqoADjk44+Egpwa9DLg30wrH8rmzC2eFw9n44lt+yb3/qMBzpPrKOXMpy2KY47vGReMzKLS6FSO7psnH09xF9tFKiQ3XHsRJujnDbWUqnTpGBYz1xZybDw9Gr5dCxw3CsR+8mG3Tj24bPrDvieLz0N3rvP+FYHC9dgF9ehm7zXI3jvevR59G5/O44Zvto3nwAjqk++teegWMYkZTCk3DM8BHUdhiOdB9ZVefhCCWSWHIqjiAiufVm42hOJL3YCTgaEplR6RwcTYhMKnMajlNKRnY4FsceJbOrm4/jWStXdXUdjm/pKAEOgUPgEDgEDoFD4BA4BA6BQwQOgUPgEDgEDoFD4BA4BA6BQ+AQgUPgEDgEDoFD4BA4BA6BQ+AQ+ZdPX3wO5DRbuJsAAAAASUVORK5CYII=";

const MANIFEST = JSON.stringify({
  name: "durbin",
  short_name: "durbin",
  start_url: "/__agent",
  scope: "/",
  display: "standalone",
  background_color: "#262624",
  theme_color: "#262624",
  icons: [{ src: "/__agent/icon.png", sizes: "180x180", type: "image/png", purpose: "any" }],
});

const UI = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>durbin</title>
<link rel="manifest" href="/__agent/manifest.webmanifest">
<link rel="icon" type="image/png" href="/__agent/icon.png">
<link rel="apple-touch-icon" href="/__agent/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#262624">
<style>
  :root { color-scheme: dark;
    --bg:#262624; --surface:#30302e; --raised:#3e3d3a; --border:#3e3d3a; --border-dim:#33322f;
    --text:#faf9f5; --dim:#a5a29a; --accent:#d97757; --green:#8eb572; --red:#e5695c;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:var(--sans); background:var(--bg); color:var(--text);
         display:flex; flex-direction:column; height:100dvh; font-size:14px; }
  header { display:flex; align-items:center; gap:10px; padding:10px 16px;
           border-bottom:1px solid var(--border-dim); position:sticky; top:0; background:var(--bg); }
  header h1 { font-size:14px; margin:0; font-weight:600; flex:1; letter-spacing:.2px; }
  header h1 b { color:var(--accent); font-weight:600; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--red); }
  .dot.up { background:var(--green); }
  #devline { display:none; padding:8px 16px; font-size:12px; font-family:var(--mono); color:var(--dim);
             border-bottom:1px solid var(--border-dim); word-break:break-all; }
  #devline.show { display:block; }
  #devline a { color:var(--accent); text-decoration:none; }
  #devline .ok { color:var(--green); }
  #devline .bad { color:var(--red); }
  #log { flex:1; overflow-y:auto; padding:16px; line-height:1.6;
         -webkit-overflow-scrolling:touch; overscroll-behavior:contain; }
  .msg { margin:0 0 14px; white-space:pre-wrap; word-break:break-word; }
  .me { background:var(--surface); border:1px solid var(--border-dim); border-radius:14px;
        padding:10px 14px; width:fit-content; max-width:100%; }
  .tool { color:var(--dim); font-family:var(--mono); font-size:12.5px; margin:0 0 8px; }
  .ti { margin:0 0 12px; font-family:var(--mono); font-size:12.5px; }
  .trow { display:flex; align-items:baseline; gap:8px; }
  .tdot { color:#57544e; }
  .tdot.ok { color:var(--green); }
  .tdot.bad { color:var(--red); }
  .tsum { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .io { display:flex; gap:10px; margin:8px 0 0 18px; background:#1f1e1d; border:1px solid var(--border-dim);
        border-radius:8px; padding:8px 10px; font-size:12px; color:var(--dim);
        white-space:pre-wrap; word-break:break-word; max-height:220px; overflow-y:auto; }
  .io .lbl { color:#6f6c66; font-size:11px; flex:none; padding-top:1px; }
  .final { color:var(--green); font-family:var(--mono); font-size:12.5px; }
  .err { color:var(--red); font-family:var(--mono); font-size:12.5px; }
  .partial { color:var(--text); opacity:.65; }
  button { border:1px solid var(--border); background:var(--surface); color:var(--text); border-radius:10px;
           padding:11px 14px; font-size:13.5px; font-family:var(--sans); cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .card { border:1px solid var(--border); border-radius:14px; padding:14px; margin:0 0 14px;
          background:var(--surface); }
  .card h4 { margin:0 0 6px; font-size:13px; color:var(--accent); font-weight:600; }
  .card p { margin:0 0 10px; white-space:pre-wrap; word-break:break-word; }
  .opt { display:block; width:100%; text-align:left; margin:0 0 8px; }
  .opt small { display:block; color:var(--dim); font-weight:400; }
  .opt.sel { border-color:var(--accent); background:rgba(217,119,87,.12); }
  .cardrow { display:flex; gap:8px; }
  .cardrow input { flex:1; background:var(--bg); color:var(--text); border:1px solid var(--border);
                   border-radius:10px; padding:10px 12px; font-size:16px; font-family:var(--sans); }
  .allow { background:var(--accent); border-color:var(--accent); color:#262624; font-weight:600; }
  .deny { border-color:var(--border); color:var(--red); }
  footer { padding:8px 12px calc(10px + env(safe-area-inset-bottom)); background:var(--bg); }
  .composer { position:relative; background:var(--surface); border:1px solid var(--border);
              border-radius:18px; padding:10px 12px 8px; display:flex; flex-direction:column; gap:6px;
              transition:border-color .25s ease; }
  .composer:focus-within { border-color:#57544e; }
  body.busy .composer { border-color:var(--accent); animation:glow 2.6s ease-in-out infinite; }
  @keyframes glow { 50% { border-color:rgba(217,119,87,.45); } }
  textarea { width:100%; min-height:48px; max-height:200px; resize:none; background:transparent;
             color:var(--text); border:0; padding:4px 2px; font-size:16px; font-family:var(--sans);
             line-height:1.45; }
  textarea::placeholder { color:#87837b; }
  textarea { scrollbar-width:none; }
  textarea::-webkit-scrollbar { display:none; }
  textarea:focus, .cardrow input:focus, .pbar input:focus { outline:none; }
  .cardrow input:focus, .pbar input:focus { border-color:var(--accent); }
  .crow { display:flex; align-items:center; gap:4px; }
  .spacer { flex:1; }
  .cbtn { border:0; background:transparent; color:var(--dim); width:34px; height:34px; border-radius:9px;
          font-size:22px; font-weight:300; line-height:1; display:grid; place-items:center; padding:0; }
  .cbtn:active { background:var(--raised); color:var(--text); }
  #modebtn { width:auto; height:30px; padding:0 10px; font-size:12.5px; font-weight:500;
             display:flex; align-items:center; gap:5px; }
  #modebtn svg { width:13px; height:13px; }
  #send, #stop { border:0; width:34px; height:34px; border-radius:10px; background:var(--accent);
                 color:#262624; font-size:16px; font-weight:700; display:grid; place-items:center;
                 padding:0; }
  #send { transition:opacity .15s; }
  body:not(.typed) #send { opacity:.4; }
  #stop { display:none; font-size:13px; }
  body.busy #stop { display:grid; }
  body.busy #send { display:none; }
  body.busy.typed #send { display:grid; opacity:1; }
  .pop { position:absolute; bottom:calc(100% + 8px); background:var(--surface); border:1px solid var(--border);
         border-radius:14px; padding:6px; min-width:250px; max-height:50dvh; overflow-y:auto;
         box-shadow:0 12px 32px rgba(0,0,0,.45); display:none; z-index:30; }
  .pop.show { display:block; }
  #plusmenu { left:8px; }
  #modemenu { right:8px; }
  .pop button { display:block; width:100%; text-align:left; border:0; background:transparent;
                color:var(--text); padding:10px 12px; border-radius:9px; font-size:13.5px; }
  .pop button:active { background:var(--raised); }
  .pop button small { display:block; color:var(--dim); font-size:12px; font-weight:400; }
  .pop button.on { background:rgba(217,119,87,.12); color:var(--accent); }
  @media (hover:hover) {
    .cbtn:hover { background:var(--raised); color:var(--text); }
    .pop button:hover { background:var(--raised); }
  }
  #atts { display:none; gap:8px; flex-wrap:wrap; }
  #atts.has { display:flex; }
  #atts img { width:52px; height:52px; object-fit:cover; border-radius:8px; border:1px solid var(--border);
              cursor:pointer; }
  .codeblock { background:#1f1e1d; border:1px solid var(--border-dim); border-radius:8px; padding:10px 12px;
               overflow-x:auto; font-size:12.5px; font-family:var(--mono); margin:8px 0; white-space:pre; }
  .md code { background:var(--raised); border-radius:5px; padding:1px 5px; font-size:12.5px;
             font-family:var(--mono); }
  .md a { color:var(--accent); }
  .md .li { margin-left:8px; }
  .md .hd { font-weight:700; margin:6px 0 4px; }
  .md div { margin:0 0 6px; }
  .seg { display:flex; background:var(--surface); border:1px solid var(--border-dim); border-radius:999px;
         padding:3px; }
  .seg button { border:0; border-radius:999px; padding:6px 14px; font-size:12.5px; background:transparent;
                color:var(--dim); }
  .seg button.on { background:var(--raised); color:var(--text); }
  .cfgseg { margin:0 0 14px; border-radius:12px; }
  .cfgseg button { flex:1; padding:9px 2px; font-size:12px; border-radius:9px; }
  .small { font-size:12.5px; padding:10px 12px; white-space:nowrap; }
  a.btn { text-decoration:none; display:block; }
  #spin { display:none; color:var(--accent); animation:pulse 1.2s ease-in-out infinite; }
  #spin.on { display:block; }
  @keyframes pulse { 50% { opacity:.35; } }
  #sesspanel, #cfgpanel { display:none; position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:20; }
  #sesspanel.show, #cfgpanel.show { display:block; }
  .sinner { position:absolute; bottom:0; left:0; right:0; max-height:70%; overflow-y:auto;
            background:var(--surface); border-top:1px solid var(--border); border-radius:18px 18px 0 0;
            padding:16px 16px calc(16px + env(safe-area-inset-bottom)); }
  .sinner h4 { margin:0 0 10px; color:var(--accent); font-size:13px; }
  .srow { display:flex; gap:8px; margin:0 0 8px; }
  .srow.on .spick { border-color:var(--accent); }
  .spick { flex:1; text-align:left; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .spick small { color:var(--dim); font-weight:400; }
  .sdel { color:var(--red); flex:none; }
  #main { flex:1; display:flex; flex-direction:column; min-height:0; position:relative; }
  #agentcol { flex:1; display:flex; flex-direction:column; min-height:0; }
  /* Hidden with visibility (not display) so the iframe keeps its document,
     scroll position and HMR socket across tab switches instead of reloading. */
  #preview { position:absolute; inset:0; z-index:5; display:flex; flex-direction:column;
             min-height:0; background:var(--bg); visibility:hidden; }
  #preview.show { visibility:visible; }
  #pframe { flex:1; border:0; width:100%; background:#fff; }
  #routes { display:none; gap:6px; padding:8px 12px 0; overflow-x:auto; }
  #routes.has { display:flex; }
  .rchip { flex:none; display:flex; align-items:center; gap:7px; padding:8px 12px; font-size:12px;
           font-family:var(--mono); border-radius:999px; }
  .rchip.on { border-color:var(--accent); color:var(--accent); }
  .rchip .rx { color:var(--dim); padding:0 2px; }
  .pbar { display:flex; gap:8px; padding:8px 12px calc(8px + env(safe-area-inset-bottom));
          border-top:1px solid var(--border-dim); }
  .pbar input { flex:1; min-width:0; background:var(--surface); color:var(--text);
                border:1px solid var(--border); border-radius:10px; padding:10px 12px; font-size:16px;
                font-family:var(--mono); }
  body.previewing #devline { display:none; }
  @media (min-width: 900px) {
    #main { flex-direction:row; }
    #agentcol { flex:0 0 480px; border-right:1px solid var(--border-dim); }
    #preview { position:static; visibility:visible; flex:1; }
    #tabs { display:none; }
    body.previewing #devline { display:block; }
  }
</style></head>
<body>
<header>
  <h1><b>✦</b> durbin</h1>
  <div class="seg" id="tabs">
    <button data-tab="agent" class="on">Agent</button>
    <button data-tab="preview">Preview</button>
  </div>
  <span id="spin">✦</span>
  <span class="dot" id="devdot" title="dev server"></span>
</header>
<div id="devline"></div>
<div id="main">
<div id="agentcol">
<div id="log"></div>
<footer>
  <div class="composer">
    <div id="atts"></div>
    <textarea id="prompt" rows="1" placeholder='Dictate or type, e.g. "make the hero heading smaller"' enterkeyhint="send"></textarea>
    <div class="crow">
      <button class="cbtn" id="plus" title="Attach, sessions &amp; more" aria-label="More">+</button>
      <span class="spacer"></span>
      <button class="cbtn" id="modebtn" title="Permission mode — how much runs without asking"></button>
      <button id="send" title="Send" aria-label="Send">&#8593;</button>
      <button id="stop" title="Stop the current run" aria-label="Stop">&#9632;</button>
    </div>
    <div class="pop" id="plusmenu">
      <button id="attach">Attach photos<small>screenshots for Claude to look at</small></button>
      <button id="startdev">Start dev server</button>
      <button id="newsess">New session</button>
      <button id="sess">Switch session…</button>
      <button id="cfg">Model &amp; thinking…</button>
      <button id="bell">Notify this device<small>a push when Claude finishes or asks</small></button>
      <button id="tts"></button>
    </div>
    <div class="pop" id="modemenu">
      <button data-mode="manual">Manual<small>every tool call asks you first, edits included</small></button>
      <button data-mode="plan">Plan<small>Claude proposes a plan; you approve before it builds</small></button>
      <button data-mode="edit">Edits<small>file edits run without asking; commands still ask</small></button>
      <button data-mode="auto">Auto<small>everything runs without asking; questions still reach you</small></button>
    </div>
    <input type="file" id="file" accept="image/*" multiple hidden>
  </div>
</footer>
</div>
<div id="preview">
  <iframe id="pframe" title="live preview"></iframe>
  <div id="routes"></div>
  <div class="pbar">
    <input id="routein" placeholder="/" enterkeyhint="go" autocapitalize="none" autocomplete="off" spellcheck="false">
    <button class="small" id="routesave" title="Save this route">☆</button>
    <button class="small" id="preload" title="Refresh preview">↻</button>
    <a class="btn" href="/" target="_blank" id="popout" title="Open in browser"><button class="small">↗</button></a>
  </div>
</div>
</div>
<div id="sesspanel"><div class="sinner" id="sessinner"></div></div>
<div id="cfgpanel"><div class="sinner" id="cfginner"></div></div>
<script>
const log = document.getElementById('log');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const spin = document.getElementById('spin');
const MODES = ['manual', 'plan', 'edit', 'auto'];
let mode = localStorage.getItem('durbin_mode');
if (!MODES.includes(mode)) mode = 'edit';
let polling = false;
let partialEl = null;
let cardEl = null;
let cardId = null;

const pframe = document.getElementById('pframe');
const previewEl = document.getElementById('preview');
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  const showPreview = b.dataset.tab === 'preview';
  document.body.classList.toggle('previewing', showPreview);
  previewEl.classList.toggle('show', showPreview);
  if (showPreview) { ensureFrame(); promptEl.blur(); }
});
function reloadFrame() {
  if (!pframe.src) { pframe.src = '/'; return; }
  try { pframe.contentWindow.location.reload(); } catch { pframe.src = '/'; }
}
document.getElementById('preload').addEventListener('click', reloadFrame);

// Desktop widths show agent and preview side by side; load the frame eagerly.
// On mobile the frame loads as soon as the dev server is up (see status()),
// so it is already rendered and HMR-current before the first tab switch.
const wide = matchMedia('(min-width: 900px)');
function ensureFrame() { if (!pframe.src) pframe.src = '/'; }
if (wide.matches) ensureFrame();
wide.addEventListener('change', e => { if (e.matches) ensureFrame(); });

// Saved preview routes: the input mirrors the frame's current path; ★ keeps
// it as a chip. The list lives server-side, so every device sees the same set.
const routesEl = document.getElementById('routes');
const routeIn = document.getElementById('routein');
const routeSave = document.getElementById('routesave');
let routes = [];

function framePath() {
  try {
    const l = pframe.contentWindow.location;
    if (l.host !== location.host) return null;
    return l.pathname + l.search;
  } catch { return null; }
}
function gotoRoute(p) {
  p = String(p || '').trim();
  if (!p) return;
  if (p[0] !== '/') p = '/' + p;
  // replace() keeps in-frame navigation out of the browser's back history.
  try { pframe.contentWindow.location.replace(p); } catch { pframe.src = p; }
  routeIn.value = p;
  syncRouteUi();
}
function syncRouteUi() {
  const cur = routeIn.value.trim() || '/';
  routeSave.textContent = routes.includes(cur) ? '★' : '☆';
  document.getElementById('popout').href = cur[0] === '/' ? cur : '/';
  routesEl.querySelectorAll('.rchip').forEach(c => c.classList.toggle('on', c.dataset.route === cur));
}
function renderRoutes() {
  routesEl.classList.toggle('has', routes.length > 0);
  routesEl.innerHTML = '';
  for (const r of routes) {
    const b = document.createElement('button');
    b.className = 'rchip';
    b.dataset.route = r;
    const name = document.createElement('span');
    name.textContent = r;
    const x = document.createElement('span');
    x.className = 'rx';
    x.textContent = '×';
    x.title = 'Forget this route';
    b.append(name, x);
    routesEl.appendChild(b);
  }
  syncRouteUi();
}
async function saveRoutes(next) {
  const r = await fetch('/__agent/routes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routes: next }),
  });
  if (r.ok) { routes = (await r.json()).routes; renderRoutes(); }
  else add('err', 'failed to save routes');
}
routesEl.addEventListener('click', e => {
  const chip = e.target.closest('.rchip'); if (!chip) return;
  if (e.target.classList.contains('rx')) saveRoutes(routes.filter(x => x !== chip.dataset.route));
  else gotoRoute(chip.dataset.route);
});
routeSave.addEventListener('click', () => {
  let cur = routeIn.value.trim() || framePath() || '/';
  if (cur[0] !== '/') cur = '/' + cur;
  routeIn.value = cur;
  saveRoutes(routes.includes(cur) ? routes.filter(x => x !== cur) : routes.concat(cur));
});
routeIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); gotoRoute(routeIn.value); routeIn.blur(); }
});
pframe.addEventListener('load', () => {
  const p = framePath();
  if (p !== null) { routeIn.value = p; syncRouteUi(); }
});
// Poll for in-frame SPA navigations (pushState never fires the load event).
setInterval(() => {
  if (document.activeElement === routeIn) return;
  const p = framePath();
  if (p !== null && p !== routeIn.value) { routeIn.value = p; syncRouteUi(); }
}, 1000);

const modeBtn = document.getElementById('modebtn');
const modeMenu = document.getElementById('modemenu');
const plusBtn = document.getElementById('plus');
const plusMenu = document.getElementById('plusmenu');
const BOLT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 12-14h-8l1-6z"/></svg>';
const MODE_LABELS = { manual: 'Manual', plan: 'Plan', edit: 'Edits', auto: 'Auto' };
function setMode(m) {
  if (!MODES.includes(m)) return;
  mode = m;
  localStorage.setItem('durbin_mode', m);
  modeMenu.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.mode === m));
  modeBtn.innerHTML = (m === 'auto' ? BOLT : '') + '<span>' + MODE_LABELS[m] + '</span>';
}
setMode(mode);
modeMenu.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  setMode(b.dataset.mode);
  modeMenu.classList.remove('show');
});
modeBtn.addEventListener('click', e => {
  e.stopPropagation();
  plusMenu.classList.remove('show');
  modeMenu.classList.toggle('show');
});
plusBtn.addEventListener('click', e => {
  e.stopPropagation();
  modeMenu.classList.remove('show');
  plusMenu.classList.toggle('show');
});
document.addEventListener('click', e => {
  if (e.target.closest('#plusmenu button')) plusMenu.classList.remove('show');
  else if (!e.target.closest('.pop')) { modeMenu.classList.remove('show'); plusMenu.classList.remove('show'); }
});

function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 100; }
function stick(was) { if (was) log.scrollTop = log.scrollHeight; }

function add(cls, text) {
  const was = nearBottom();
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  log.insertBefore(d, partialEl || cardEl || null);
  stick(was);
  return d;
}

const toolEls = {};
const BT = '\x60';
let replaying = true;
let tts = localStorage.getItem('durbin_tts') === '1';

function setBusy(b) {
  spin.classList.toggle('on', b);
  document.body.classList.toggle('busy', b);
  promptEl.placeholder = b ? 'Queue another message…'
    : 'Dictate or type, e.g. "make the hero heading smaller"';
}

function speak(text) {
  if (!tts || replaying || !('speechSynthesis' in window)) return;
  const clean = text
    .replace(new RegExp(BT + BT + BT + '[\\\\s\\\\S]*?' + BT + BT + BT, 'g'), ' code block. ')
    .replace(new RegExp('[*_#' + BT + ']', 'g'), '');
  speechSynthesis.speak(new SpeechSynthesisUtterance(clean.slice(0, 1200)));
}

function mdInline(el, s) {
  const re = new RegExp('(\\\\*\\\\*[^*]+\\\\*\\\\*|' + BT + '[^' + BT + ']+' + BT + '|\\\\[[^\\\\]]+\\\\]\\\\([^\\\\s)]+\\\\))');
  s.split(re).forEach(tok => {
    if (!tok) return;
    if (tok.startsWith('**') && tok.endsWith('**')) {
      const b = document.createElement('b');
      b.textContent = tok.slice(2, -2);
      el.appendChild(b);
    } else if (tok.startsWith(BT) && tok.endsWith(BT) && tok.length > 2) {
      const c = document.createElement('code');
      c.textContent = tok.slice(1, -1);
      el.appendChild(c);
    } else if (tok.startsWith('[')) {
      const m = /^\\[([^\\]]+)\\]\\(([^\\s)]+)\\)$/.exec(tok);
      const a = document.createElement('a');
      a.textContent = m[1];
      a.href = m[2];
      a.target = '_blank';
      el.appendChild(a);
    } else {
      el.appendChild(document.createTextNode(tok));
    }
  });
}

function mdAdd(text) {
  const was = nearBottom();
  const wrap = document.createElement('div');
  wrap.className = 'msg md';
  text.split(BT + BT + BT).forEach((part, i) => {
    if (i % 2) {
      const pre = document.createElement('pre');
      pre.className = 'codeblock';
      pre.textContent = part.replace(/^[a-zA-Z0-9]*\\n/, '').replace(/\\n$/, '');
      wrap.appendChild(pre);
    } else {
      part.split('\\n').forEach(line => {
        if (!line.trim()) return;
        const d = document.createElement('div');
        const h = /^(#{1,4})\\s+(.*)$/.exec(line);
        const b = /^\\s*[-*]\\s+(.*)$/.exec(line);
        if (h) { d.className = 'hd'; mdInline(d, h[2]); }
        else if (b) { d.className = 'li'; d.appendChild(document.createTextNode('• ')); mdInline(d, b[1]); }
        else mdInline(d, line);
        wrap.appendChild(d);
      });
    }
  });
  log.insertBefore(wrap, partialEl || cardEl || null);
  stick(was);
}

function ioBox(label, text) {
  const box = document.createElement('div');
  box.className = 'io';
  const l = document.createElement('span');
  l.className = 'lbl';
  l.textContent = label;
  const t = document.createElement('span');
  t.textContent = text;
  box.append(l, t);
  return box;
}

function addTool(c) {
  const was = nearBottom();
  const i = c.input || {};
  const d = document.createElement('div');
  d.className = 'ti';
  d.dataset.tool = c.name;
  const row = document.createElement('div');
  row.className = 'trow';
  const dot = document.createElement('span');
  dot.className = 'tdot';
  dot.textContent = '●';
  const name = document.createElement('b');
  name.textContent = c.name;
  const sum = document.createElement('span');
  sum.className = 'tsum';
  sum.textContent = String(c.name === 'Bash' ? (i.description || '') :
    (i.file_path || i.pattern || i.prompt || i.url || i.command || '')).slice(0, 100);
  row.append(dot, name, sum);
  d.appendChild(row);
  if (c.name === 'Bash' && i.command) d.appendChild(ioBox('IN', String(i.command).slice(0, 1000)));
  log.insertBefore(d, partialEl || cardEl || null);
  if (c.id) toolEls[c.id] = d;
  stick(was);
}

function finishTool(ev) {
  const d = toolEls[ev.id];
  if (!d) return;
  const was = nearBottom();
  d.querySelector('.tdot').classList.add(ev.is_error ? 'bad' : 'ok');
  if (d.dataset.tool === 'Bash' && ev.text && ev.text.trim()) {
    d.appendChild(ioBox('OUT', ev.text.trim().slice(0, 2000)));
  }
  stick(was);
}

function render(ev) {
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text.trim()) { mdAdd(c.text.trim()); speak(c.text.trim()); }
      else if (c.type === 'tool_use' && c.name === 'ExitPlanMode') {
        add('tool', 'Claude proposed a plan');
        if (c.input && c.input.plan) mdAdd(String(c.input.plan));
      }
      else if (c.type === 'tool_use' && c.name !== 'AskUserQuestion') addTool(c);
    }
  } else if (ev.type === 'tool_result') {
    finishTool(ev);
  } else if (ev.type === 'thought') {
    add('tool', 'Thought for ' + ev.seconds + 's');
  } else if (ev.type === 'result') {
    const secs = ev.duration_ms ? ' in ' + Math.round(ev.duration_ms / 1000) + 's' : '';
    if (ev.subtype === 'success') add('final', '⎿ done' + secs);
    else add('err', '⎿ ' + (ev.subtype || 'error') + (ev.result ? ': ' + ev.result : ''));
  }
}

function setPartial(text) {
  if (!text) {
    if (partialEl) { partialEl.remove(); partialEl = null; }
    return;
  }
  const was = nearBottom();
  if (!partialEl) {
    partialEl = document.createElement('div');
    partialEl.className = 'msg partial';
    log.insertBefore(partialEl, cardEl || null);
  }
  partialEl.textContent = text + ' ▌';
  stick(was);
}

async function answer(body) {
  await fetch('/__agent/answer', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function clearCard() {
  if (cardEl) { cardEl.remove(); cardEl = null; cardId = null; }
}

function showCard(pending) {
  if (cardId === pending.id) return;
  clearCard();
  cardId = pending.id;
  const was = nearBottom();
  cardEl = document.createElement('div');
  cardEl.className = 'card';

  if (pending.kind === 'permission') {
    const h = document.createElement('h4');
    h.textContent = 'Permission request';
    const p = document.createElement('p');
    p.textContent = pending.payload.toolName + (pending.payload.summary ? ': ' + pending.payload.summary : '');
    const row = document.createElement('div');
    row.className = 'cardrow';
    const ok = document.createElement('button');
    ok.className = 'allow'; ok.textContent = 'Allow'; ok.style.flex = '1';
    const no = document.createElement('button');
    no.className = 'deny'; no.textContent = 'Deny'; no.style.flex = '1';
    ok.onclick = () => { answer({ id: pending.id, allow: true }); add('final', '⎿ allowed ' + pending.payload.toolName); clearCard(); };
    no.onclick = () => { answer({ id: pending.id, allow: false }); add('err', '⎿ denied ' + pending.payload.toolName); clearCard(); };
    row.append(ok, no);
    cardEl.append(h, p, row);
  } else if (pending.kind === 'plan') {
    const h = document.createElement('h4');
    h.textContent = 'Plan ready';
    const p = document.createElement('p');
    p.textContent = 'The plan is above. Build it (edits auto-approved), or send feedback to keep planning.';
    const frow = document.createElement('div');
    frow.className = 'cardrow';
    const inp = document.createElement('input');
    inp.placeholder = 'Optional feedback for the plan…';
    frow.appendChild(inp);
    const row = document.createElement('div');
    row.className = 'cardrow';
    const ok = document.createElement('button');
    ok.className = 'allow'; ok.textContent = 'Build it'; ok.style.flex = '1';
    const no = document.createElement('button');
    no.className = 'deny'; no.textContent = 'Keep planning'; no.style.flex = '1';
    ok.onclick = () => {
      answer({ id: pending.id, allow: true });
      add('final', '⎿ plan approved — building (Edits mode)');
      setMode('edit');
      clearCard();
    };
    no.onclick = () => {
      const fb = inp.value.trim();
      answer({ id: pending.id, allow: false, feedback: fb });
      add('err', '⎿ keep planning' + (fb ? ': ' + fb : ''));
      clearCard();
    };
    row.append(ok, no);
    cardEl.append(h, p, frow, row);
  } else {
    const answers = {};
    const qs = pending.payload.questions || [];
    qs.forEach(q => {
      const h = document.createElement('h4');
      h.textContent = q.header || 'Question';
      const p = document.createElement('p');
      p.textContent = q.question;
      cardEl.append(h, p);
      const sel = new Set();
      (q.options || []).forEach(o => {
        const b = document.createElement('button');
        b.className = 'opt';
        b.textContent = o.label;
        if (o.description) {
          const s = document.createElement('small');
          s.textContent = o.description;
          b.appendChild(s);
        }
        b.onclick = () => {
          if (q.multiSelect) {
            sel.has(o.label) ? sel.delete(o.label) : sel.add(o.label);
            b.classList.toggle('sel');
            answers[q.question] = Array.from(sel);
          } else {
            cardEl.querySelectorAll('.opt').forEach(x => x.classList.remove('sel'));
            b.classList.add('sel');
            answers[q.question] = o.label;
          }
        };
        cardEl.appendChild(b);
      });
      const row = document.createElement('div');
      row.className = 'cardrow';
      const inp = document.createElement('input');
      inp.placeholder = 'Or type / dictate an answer…';
      inp.oninput = () => { if (inp.value.trim()) answers[q.question] = q.multiSelect ? [inp.value.trim()] : inp.value.trim(); };
      row.appendChild(inp);
      cardEl.appendChild(row);
    });
    const row = document.createElement('div');
    row.className = 'cardrow';
    const ok = document.createElement('button');
    ok.className = 'allow'; ok.textContent = 'Send answer'; ok.style.flex = '1';
    ok.onclick = () => {
      if (qs.some(q => answers[q.question] === undefined || answers[q.question].length === 0)) return;
      answer({ id: pending.id, answers: answers });
      add('me', qs.map(q => String(answers[q.question])).join(' · '));
      clearCard();
    };
    row.appendChild(ok);
    cardEl.appendChild(row);
  }
  log.appendChild(cardEl);
  stick(was);
}

async function poll(runId, since) {
  try {
    const r = await fetch('/__agent/poll?run=' + runId + '&since=' + since);
    if (!r.ok) throw new Error('poll ' + r.status);
    const data = await r.json();
    data.lines.forEach(render);
    since += data.lines.length;
    setPartial(data.partial || '');
    if (data.pending) showCard(data.pending); else clearCard();
    if (data.error) add('err', data.error);
    if (!data.done) { setTimeout(() => poll(runId, since), 1000); return; }
  } catch (e) {
    add('err', 'connection lost, retrying…');
    setTimeout(() => poll(runId, since), 2500);
    return;
  }
  setPartial('');
  clearCard();
  polling = false;
  setBusy(false);
  setTimeout(status, 400); // a queued message may have started a new run
}

const attsEl = document.getElementById('atts');
const fileEl = document.getElementById('file');
let images = []; // { media_type, data, url }

document.getElementById('attach').addEventListener('click', () => fileEl.click());

function splitDataUrl(durl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(durl);
  return m ? { media_type: m[1], data: m[2], url: durl } : null;
}

// Keep originals under ~3 MB; downscale bigger photos so they fit API limits.
function processFile(file) {
  return new Promise(resolve => {
    const fr = new FileReader();
    fr.onload = () => {
      if (file.size <= 3000000) { resolve(splitDataUrl(fr.result)); return; }
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(splitDataUrl(c.toDataURL('image/jpeg', 0.85)));
      };
      img.onerror = () => resolve(null);
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function renderAtts() {
  attsEl.innerHTML = '';
  attsEl.classList.toggle('has', images.length > 0);
  images.forEach((im, idx) => {
    const t = document.createElement('img');
    t.src = im.url;
    t.title = 'Tap to remove';
    t.onclick = () => { images.splice(idx, 1); renderAtts(); };
    attsEl.appendChild(t);
  });
}

fileEl.addEventListener('change', async () => {
  for (const f of fileEl.files) {
    if (images.length >= 10) break;
    const im = await processFile(f);
    if (im) images.push(im);
  }
  fileEl.value = '';
  renderAtts();
});

sendBtn.addEventListener('click', async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  add('me', prompt + (images.length ? ' [+' + images.length + ' image' + (images.length > 1 ? 's' : '') + ']' : ''));
  promptEl.value = '';
  syncTyped();
  const payload = { prompt, mode, images: images.map(im => ({ media_type: im.media_type, data: im.data })) };
  images = [];
  renderAtts();
  try {
    const r = await fetch('/__agent/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'failed');
    if (data.queued) { add('tool', '⎿ queued, will send when the current run finishes'); return; }
    polling = true;
    setBusy(true);
    poll(data.runId, 0);
  } catch (e) {
    add('err', String(e.message || e));
  }
});

document.getElementById('stop').addEventListener('click', async () => {
  await fetch('/__agent/stop', { method: 'POST' });
  add('err', '⎿ stop requested');
});

function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

document.getElementById('bell').addEventListener('click', async () => {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      add('err', 'push not supported here; on iOS install the app to your home screen first');
      return;
    }
    const reg = await navigator.serviceWorker.register('/__agent/sw.js', { scope: '/__agent' });
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { add('err', 'notifications blocked'); return; }
    const key = (await (await fetch('/__agent/push/vapid')).json()).key;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    await fetch('/__agent/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub),
    });
    add('final', '⎿ notifications on for this device');
  } catch (e) {
    add('err', 'push setup failed: ' + (e.message || e));
  }
});

const ttsBtn = document.getElementById('tts');
function ttsLabel() { ttsBtn.textContent = tts ? 'Read replies aloud — on' : 'Read replies aloud — off'; }
ttsLabel();
ttsBtn.addEventListener('click', () => {
  tts = !tts;
  localStorage.setItem('durbin_tts', tts ? '1' : '0');
  ttsLabel();
  if (!tts) speechSynthesis.cancel();
  else speechSynthesis.speak(new SpeechSynthesisUtterance('voice on'));
});

promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// Grow the composer with its content, Claude Code style; "typed" also
// controls the send button (dimmed when empty, shown next to ■ while busy).
function syncTyped() {
  document.body.classList.toggle('typed', promptEl.value.trim().length > 0);
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 200) + 'px';
}
promptEl.addEventListener('input', syncTyped);

document.getElementById('newsess').addEventListener('click', async () => {
  const r = await fetch('/__agent/reset', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { add('err', d.error || 'failed'); return; }
  log.innerHTML = '';
  partialEl = null;
  cardEl = null;
  cardId = null;
  add('final', '— new session —');
});

const sessPanel = document.getElementById('sesspanel');
sessPanel.addEventListener('click', e => { if (e.target === sessPanel) sessPanel.classList.remove('show'); });

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function openSessions() {
  const r = await fetch('/__agent/sessions');
  const data = await r.json();
  const inner = document.getElementById('sessinner');
  inner.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = 'Sessions';
  inner.appendChild(h);
  (data.sessions || []).forEach(s => {
    const row = document.createElement('div');
    row.className = 'srow' + (s.active ? ' on' : '');
    const b = document.createElement('button');
    b.className = 'spick';
    b.textContent = s.title || 'untitled';
    b.appendChild(document.createElement('br'));
    const t = document.createElement('small');
    t.textContent = (s.active ? 'active · ' : '') + timeAgo(s.updatedAt);
    b.appendChild(t);
    b.onclick = async () => {
      const rr = await fetch('/__agent/sessions/switch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: s.key }),
      });
      const dd = await rr.json();
      sessPanel.classList.remove('show');
      if (!rr.ok) { add('err', dd.error || 'switch failed'); return; }
      await replayHistory();
      status();
    };
    const del = document.createElement('button');
    del.className = 'sdel';
    del.textContent = '✕';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      const rr = await fetch('/__agent/sessions/delete', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: s.key }),
      });
      if (rr.ok) { if (s.active) await replayHistory(); openSessions(); }
      else { const dd = await rr.json(); add('err', dd.error || 'delete failed'); }
    };
    row.append(b, del);
    inner.appendChild(row);
  });
  sessPanel.classList.add('show');
}
document.getElementById('sess').addEventListener('click', openSessions);

const cfgPanel = document.getElementById('cfgpanel');
cfgPanel.addEventListener('click', e => { if (e.target === cfgPanel) cfgPanel.classList.remove('show'); });

async function postCfg(patch) {
  const r = await fetch('/__agent/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  const d = await r.json();
  if (!r.ok) add('err', d.error || 'settings change failed');
  return r.ok;
}

async function openCfg() {
  const inner = document.getElementById('cfginner');
  inner.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = 'Model & thinking';
  inner.appendChild(h);
  const load = document.createElement('p');
  load.textContent = 'loading… (first open boots Claude to list your models)';
  inner.appendChild(load);
  cfgPanel.classList.add('show');
  let cfg;
  try { cfg = await (await fetch('/__agent/config')).json(); }
  catch { load.textContent = 'failed to load settings'; return; }
  if (!cfgPanel.classList.contains('show')) return;
  load.remove();

  const sec = (title) => {
    const t = document.createElement('h4');
    t.textContent = title;
    inner.appendChild(t);
  };
  const seg = (choices, isOn) => {
    const s = document.createElement('div');
    s.className = 'seg cfgseg';
    choices.forEach(c => {
      const b = document.createElement('button');
      b.textContent = c.label;
      if (isOn(c)) b.className = 'on';
      b.onclick = async () => { if (await postCfg(c.patch)) openCfg(); };
      s.appendChild(b);
    });
    inner.appendChild(s);
  };

  sec('Model');
  // The CLI's list usually leads with its own "Default" row; only synthesize
  // one when it doesn't. Unset ("") selects that row.
  let models = cfg.models || [];
  if (!models.some(m => m.value === 'default')) {
    models = [{ value: '', name: 'Default', desc: 'whatever your Claude Code defaults to' }, ...models];
  }
  models.forEach(m => {
    const b = document.createElement('button');
    const sel = cfg.model === m.value || (cfg.model === '' && m.value === 'default');
    b.className = 'opt' + (sel ? ' sel' : '');
    b.textContent = m.name;
    if (m.desc) {
      const s = document.createElement('small');
      s.textContent = m.desc;
      b.appendChild(s);
    }
    b.onclick = async () => { if (await postCfg({ model: m.value })) openCfg(); };
    inner.appendChild(b);
  });
  if (!(cfg.models || []).length) {
    const p = document.createElement('p');
    p.textContent = 'model list unavailable (is Claude Code logged in?)';
    inner.appendChild(p);
  }

  sec('Thinking effort');
  const cur = (cfg.models || []).find(m => m.value === (cfg.model || 'default'));
  const levels = cur ? (cur.effortLevels || []) : ['low', 'medium', 'high', 'xhigh'];
  if (cur && !levels.length) {
    const p = document.createElement('p');
    p.textContent = 'this model has no effort levels';
    inner.appendChild(p);
  } else {
    seg(
      [{ label: 'default', v: '' }, ...levels.map(l => ({ label: l, v: l }))].map(x => ({ label: x.label, patch: { effort: x.v }, v: x.v })),
      c => cfg.effort === c.v
    );
  }

  sec('Extended thinking');
  seg(
    [{ label: 'on', patch: { thinking: true }, v: true }, { label: 'off', patch: { thinking: false }, v: false }],
    c => cfg.thinking === c.v
  );
}
document.getElementById('cfg').addEventListener('click', openCfg);

document.getElementById('startdev').addEventListener('click', async () => {
  const r = await fetch('/__agent/dev/start', { method: 'POST' });
  const s = await r.json();
  if (s.alreadyUp) add('final', '⎿ dev server already running, nothing to do');
  else if (s.starting) add('final', '⎿ dev server is already starting, hang on…');
  else add('final', '⎿ starting dev server…');
});

// The port number in the status line is tappable: preview any port without
// restarting durbin (Vite's 5173, Rails' 3000, whatever). Persists per project.
document.getElementById('devline').addEventListener('click', async (e) => {
  const a = e.target.closest && e.target.closest('.devport');
  if (!a) return;
  e.preventDefault();
  const v = window.prompt('Preview which port? (where your dev server listens)', a.textContent);
  if (!v) return;
  const p = parseInt(v, 10);
  if (!p || p < 1 || p > 65535) { add('err', 'invalid port: ' + v); return; }
  const r = await fetch('/__agent/dev/port', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: p }),
  });
  const d = await r.json();
  if (r.ok) { add('final', '⎿ preview now proxies port ' + d.devPort); reloadFrame(); status(); }
  else add('err', d.error || 'failed to set port');
});

async function status() {
  try {
    const r = await fetch('/__agent/status');
    const s = await r.json();
    document.getElementById('devdot').classList.toggle('up', s.devUp);
    if (s.devUp) ensureFrame();
    if (Array.isArray(s.routes) && JSON.stringify(s.routes) !== JSON.stringify(routes)) {
      routes = s.routes;
      renderRoutes();
    }
    const dl = document.getElementById('devline');
    dl.classList.add('show');
    const previewUrl = location.protocol + '//' + location.host + '/';
    const portLink = '<a href="#" class="devport" title="change port">' + s.devPort + '</a>';
    if (s.devUp) {
      dl.innerHTML = '<span class="ok">●</span> dev server live on port ' + portLink +
        ' · <a href="/" target="_blank">' + previewUrl + '</a>';
    } else {
      dl.innerHTML = '<span class="bad">●</span> dev server down on port ' + portLink +
        ' · start it from the + menu';
    }
    if (s.running && !polling) { polling = true; setBusy(true); poll(s.runId, 0); }
  } catch {}
}
async function replayHistory() {
  replaying = true;
  log.innerHTML = '';
  partialEl = null;
  cardEl = null;
  cardId = null;
  try {
    const r = await fetch('/__agent/history');
    const data = await r.json();
    for (const h of data.runs || []) {
      add('me', h.prompt + (h.imageCount ? ' [+' + h.imageCount + ' image' + (h.imageCount > 1 ? 's' : '') + ']' : ''));
      (h.lines || []).forEach(render);
      if (h.error) add('err', h.error);
    }
    if ((data.runs || []).length) log.scrollTop = log.scrollHeight;
  } catch {}
  replaying = false;
}
replayHistory().then(status);
setInterval(status, 5000);
</script>
</body></html>`;

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // Token or password in query: set cookie and redirect to the clean URL.
  const qtoken = url.searchParams.get("token");
  if (qtoken) {
    if (secretOk(qtoken)) {
      url.searchParams.delete("token");
      res.writeHead(302, { "set-cookie": AUTH_COOKIE, location: url.pathname + (url.search || "") });
      return res.end();
    }
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("bad token");
  }

  // Login endpoint must be reachable while unauthenticated.
  if (url.pathname === "/__agent/login" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    if (!secretOk(body.secret)) return json(res, 403, { error: "wrong password" });
    res.writeHead(200, { "set-cookie": AUTH_COOKIE, "content-type": "application/json" });
    return res.end('{"ok":true}');
  }

  if (!isAuthed(req)) {
    const label = passwordSet() ? "password" : "access token";
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#262624;color:#faf9f5;display:grid;place-items:center;min-height:100vh;margin:0">
      <form style="text-align:center" onsubmit="fetch('/__agent/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:t.value})}).then(r=>r.ok?location.reload():(m.textContent='wrong ${label}, try again'));return false">
      <h3><b style="color:#d97757">✦</b> durbin</h3>
      <input id="t" name="t" type="password" placeholder="${label}" autocomplete="current-password"
      style="padding:12px;font-size:16px;border-radius:10px;border:1px solid #3e3d3a;background:#30302e;color:#faf9f5;font-family:inherit">
      <button style="padding:12px 16px;font-size:16px;border-radius:10px;border:1px solid #d97757;background:#d97757;color:#262624;margin-left:6px;font-family:inherit;font-weight:600;cursor:pointer">Go</button>
      <p id="m" style="color:#e5695c;font-size:13px;min-height:1em"></p></form>`);
  }

  // Short alias for typing by hand.
  if (url.pathname === "/a") {
    res.writeHead(302, { location: "/__agent" });
    return res.end();
  }

  if (url.pathname === "/__agent") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(UI);
  }

  if (url.pathname === "/__agent/manifest.webmanifest") {
    res.writeHead(200, { "content-type": "application/manifest+json" });
    return res.end(MANIFEST);
  }

  if (url.pathname === "/__agent/icon.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
    return res.end(Buffer.from(ICON_B64, "base64"));
  }

  if (url.pathname === "/__agent/run" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    if (!body.prompt || typeof body.prompt !== "string") return json(res, 400, { error: "missing prompt" });
    let images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
    images = images.filter((im) => im && typeof im.data === "string" && im.data.length < 7e6
      && /^image\/(png|jpeg|webp|gif)$/.test(im.media_type || ""));
    const legacy = { safe: "edit", full: "auto" };
    const mode = MODES.includes(body.mode) ? body.mode : (legacy[body.mode] || "edit");
    if (run && !run.done) {
      msgQueue.push({ prompt: body.prompt, mode, images });
      return json(res, 200, { queued: true, position: msgQueue.length });
    }
    const runId = startRun(body.prompt, mode, images);
    return json(res, 200, { runId });
  }

  if (url.pathname === "/__agent/stop" && req.method === "POST") {
    msgQueue.length = 0;
    if (run && !run.done) {
      if (session) { try { await session.interrupt(); } catch { closeSession(); } }
      // Fallback: if the interrupt did not land, kill the process; the
      // reader's cleanup marks the run failed and the next message reboots.
      setTimeout(() => { if (run && !run.done) closeSession(); }, 5000);
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/__agent/push/vapid") {
    return json(res, 200, { key: vapid.publicKey });
  }

  if (url.pathname === "/__agent/push/subscribe" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    if (!body || typeof body.endpoint !== "string") return json(res, 400, { error: "bad subscription" });
    if (!pushSubs.some((s) => s.endpoint === body.endpoint)) {
      pushSubs.push(body);
      savePushSubs();
    }
    return json(res, 200, { ok: true });
  }

  // The durbin phone app registers its FCM device token here (it calls this
  // from inside the rendered page, so the auth cookie comes along for free).
  // `native` in the reply tells the app whether this bridge can actually
  // send (i.e. a service-account key is installed).
  if (url.pathname === "/__agent/push/fcm" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 4096) return json(res, 400, { error: "bad token" });
    if (!fcmTokens.some((t) => t.token === token)) {
      fcmTokens.push({ token, platform: String(body.platform || ""), addedAt: Date.now() });
      if (fcmTokens.length > 20) fcmTokens = fcmTokens.slice(-20); // oldest devices age out
      saveFcmTokens();
    }
    return json(res, 200, { ok: true, native: !!fcmCreds });
  }

  if (url.pathname === "/__agent/sw.js") {
    res.writeHead(200, { "content-type": "application/javascript", "Service-Worker-Allowed": "/" });
    return res.end(SW_JS);
  }

  if (url.pathname === "/__agent/poll") {
    const since = Number(url.searchParams.get("since") || 0);
    if (!run || run.id !== url.searchParams.get("run")) return json(res, 200, { lines: [], partial: "", pending: null, done: true });
    return json(res, 200, {
      lines: run.lines.slice(since),
      partial: run.partial,
      pending: run.pending ? { id: run.pending.id, kind: run.pending.kind, payload: run.pending.payload } : null,
      done: run.done,
      mode: run.mode,
      error: run.done ? run.error : null,
    });
  }

  if (url.pathname === "/__agent/answer" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    const p = run && run.pending;
    if (!p || p.id !== body.id) return json(res, 409, { error: "nothing pending with that id" });
    if (p.kind === "question") {
      if (!body.answers || typeof body.answers !== "object") return json(res, 400, { error: "missing answers" });
      p.resolve({ behavior: "allow", updatedInput: { questions: p.rawInput.questions, answers: body.answers } });
    } else if (p.kind === "plan") {
      if (body.allow) {
        p.resolve({ behavior: "allow", updatedInput: p.rawInput });
        // Approving the plan moves the session to Edits mode so building flows.
        switchMode("edit");
      } else {
        const fb = String(body.feedback || "").trim().slice(0, 2000);
        p.resolve({ behavior: "deny", message: fb
          ? "Keep planning. Revise the plan based on this feedback: " + fb
          : "Keep planning — the user is not ready to build yet." });
      }
    } else if (body.allow) {
      p.resolve({ behavior: "allow", updatedInput: p.rawInput });
    } else {
      p.resolve({ behavior: "deny", message: "Denied by user from phone" });
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/__agent/reset" && req.method === "POST") {
    if (run && !run.done) return json(res, 409, { error: "stop the current run first" });
    closeSession();
    const key = crypto.randomBytes(4).toString("hex");
    state.sessions[key] = newSessionEntry();
    state.activeKey = key;
    saveState(state);
    history = [];
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/__agent/history") {
    return json(res, 200, { runs: history });
  }

  if (url.pathname === "/__agent/sessions") {
    const sessions = Object.entries(state.sessions).map(([key, s]) => {
      let title = s.title;
      if (!title) {
        const first = loadHistoryFile(key)[0];
        if (first && first.prompt) title = String(first.prompt).slice(0, 48);
      }
      return { key, title, updatedAt: s.updatedAt, active: key === state.activeKey };
    }).sort((x, y) => y.updatedAt - x.updatedAt);
    return json(res, 200, { sessions });
  }

  if (url.pathname === "/__agent/sessions/switch" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    if (!state.sessions[body.key]) return json(res, 404, { error: "no such session" });
    if (run && !run.done) return json(res, 409, { error: "stop the current run first" });
    if (body.key !== state.activeKey) {
      closeSession();
      state.activeKey = body.key;
      saveState(state);
      history = loadHistoryFile(body.key);
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/__agent/sessions/delete" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    const key = body.key;
    if (!state.sessions[key]) return json(res, 404, { error: "no such session" });
    if (key === state.activeKey && run && !run.done) return json(res, 409, { error: "stop the current run first" });
    delete state.sessions[key];
    try { fs.unlinkSync(histFile(key)); } catch {}
    if (state.activeKey === key) {
      closeSession();
      const keys = Object.keys(state.sessions);
      if (keys.length) {
        state.activeKey = keys.sort((x, y) => state.sessions[y].updatedAt - state.sessions[x].updatedAt)[0];
      } else {
        const nk = crypto.randomBytes(4).toString("hex");
        state.sessions[nk] = newSessionEntry();
        state.activeKey = nk;
      }
      history = loadHistoryFile(state.activeKey);
    }
    saveState(state);
    return json(res, 200, { ok: true, activeKey: state.activeKey });
  }

  if (url.pathname === "/__agent/dev/start" && req.method === "POST") {
    if (await devServerUp()) return json(res, 200, { ok: true, alreadyUp: true });
    if (devStarting) return json(res, 200, { ok: true, starting: true });
    startDevServer();
    return json(res, 200, { ok: true, started: true });
  }

  if (url.pathname === "/__agent/dev/port" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    const p = Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return json(res, 400, { error: "port must be 1-65535" });
    devPort = p;
    state.devPort = p;
    saveState(state);
    return json(res, 200, { ok: true, devPort });
  }

  // Saved preview routes: paths the user starred so any device can jump the
  // preview straight to them. The client always sends the full list, so one
  // endpoint covers add, remove and reorder. Persisted per project in state.
  if (url.pathname === "/__agent/routes" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    if (!Array.isArray(body.routes)) return json(res, 400, { error: "routes must be an array" });
    const routes = [...new Set(
      body.routes
        .filter((r) => typeof r === "string")
        .map((r) => r.trim())
        // "//host" is protocol-relative and would send the preview off-origin.
        .filter((r) => r.startsWith("/") && !r.startsWith("//") && r.length <= 300),
    )].slice(0, 50);
    state.routes = routes;
    saveState(state);
    return json(res, 200, { ok: true, routes });
  }

  if (url.pathname === "/__agent/config" && req.method === "GET") {
    const c = cfg();
    let models = state.modelList || [];
    if (!models.length) {
      // First open: boot (or reuse) the Claude process to ask it what models
      // this login offers, then cache the list so later opens are instant.
      try {
        const hadSession = !!session;
        const list = await ensureSession().supportedModels();
        models = list.map((m) => ({
          value: m.value, name: m.displayName || m.value, desc: m.description || "",
          effortLevels: m.supportedEffortLevels || [],
        }));
        state.modelList = models;
        saveState(state);
        // A session booted just for the list should still idle out.
        if (!hadSession && (!run || run.done)) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(closeSession, IDLE_MS);
        }
      } catch {}
    }
    return json(res, 200, { model: c.model, effort: c.effort, thinking: !!c.thinking, models });
  }

  if (url.pathname === "/__agent/config" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
    const c = cfg();
    const changed = {};
    if (typeof body.model === "string" && body.model.length <= 100 && body.model !== c.model) {
      // Only accept models the CLI reported (an unknown id persisted here
      // would break every future session boot). "" = default always works.
      const list = state.modelList || [];
      if (body.model === "" || list.some((m) => m.value === body.model)) {
        c.model = body.model;
        changed.model = true;
      } else {
        return json(res, 400, { error: "unknown model" });
      }
    }
    if (typeof body.effort === "string" && ["", "low", "medium", "high", "xhigh", "max"].includes(body.effort) && body.effort !== c.effort) {
      c.effort = body.effort;
      changed.effort = true;
    }
    if (typeof body.thinking === "boolean" && body.thinking !== c.thinking) {
      c.thinking = body.thinking;
      changed.thinking = true;
    }
    saveState(state);
    // Apply to the warm session via control requests. If one fails between
    // runs, drop the process — the next message reboots with the new config
    // (mid-run failures are left alone so the run can finish).
    const s = session;
    if (s) {
      const fail = () => { if (session === s && (!run || run.done)) closeSession(); };
      if (changed.model) s.setModel(c.model).catch(fail);
      if (changed.effort) s.setEffort(c.effort).catch(fail);
      if (changed.thinking) s.setThinking(c.thinking).catch(fail);
    }
    return json(res, 200, { ok: true, model: c.model, effort: c.effort, thinking: c.thinking });
  }

  if (url.pathname === "/__agent/status") {
    return json(res, 200, {
      devUp: await devServerUp(),
      devPort,
      routes: state.routes || [],
      warm: !!session,
      running: !!(run && !run.done),
      pendingKind: run && run.pending ? run.pending.kind : null,
      queued: msgQueue.length,
      runId: run ? run.id : null,
      sessionId: activeSess() ? activeSess().claudeSessionId : null,
    });
  }

  return proxyHttp(req, res);
});

server.on("upgrade", proxyUpgrade);

// ---------- Tailscale Funnel (automatic) ----------
// Make `npm install -g durbin && durbin` the whole setup: on every start,
// enable Funnel for the bridge port and print the phone URL. Tailscale
// itself must be installed and logged in (a one-time, interactive step);
// everything else durbin handles here.
function setupFunnel() {
  execFile("tailscale", ["funnel", "--bg", String(PORT)], (err, stdout, stderr) => {
    const output = (String(stdout || "") + String(stderr || "")).trim();
    if (err) {
      if (err.code === "ENOENT") {
        console.log(`tailscale not found. One-time setup:
  1. install it: https://tailscale.com/download
  2. log in:     sudo tailscale up
then restart durbin; it turns on Funnel for you. (--no-funnel hides this.)`);
        return;
      }
      if (output) console.log(output);
      if (/denied|not permitted|operator/i.test(output)) {
        console.log(`\nLet your user manage tailscale without sudo, then restart durbin:
  sudo tailscale set --operator=$USER`);
      } else {
        console.log(`\nFunnel isn't on yet. If there's an enable link above, open it once
(activates Funnel for your tailnet), then restart durbin.`);
      }
      return;
    }
    execFile("tailscale", ["status", "--json"], (err2, out) => {
      let host = "";
      if (!err2) {
        try { host = (JSON.parse(out).Self?.DNSName || "").replace(/\.$/, ""); } catch {}
      }
      if (!host) return console.log(output || "Funnel is on.");
      publicHost = host; // lets FCM notification taps route to this project
      const phoneUrl = `https://${host}/__agent?token=${TOKEN}`;
      console.log(`
Funnel is on. Scan this with your phone's camera (or the durbin app):
`);
      qrcode.generate(phoneUrl, { small: true });
      console.log(`Or open it by hand (logs you in once):

  ${phoneUrl}

Bookmark it — or better, add it to your home screen for an app icon that
opens fullscreen (iOS Safari: Share > Add to Home Screen; Android Chrome:
menu > Add to Home screen).

Live preview of the site (same login):  https://${host}/`);
    });
  });
}

// ---------- dev-server port check (startup) ----------
// If nothing answers on the dev port, ask which port the dev server is on
// before going up — sniffing common dev ports for a suggestion — and explain
// how to start one if it simply isn't running yet. The prompt is skipped when
// the port was forced with --dev-port/env or there's no terminal to ask on.
const COMMON_DEV_PORTS = [3000, 5173, 4321, 8080, 8000, 4200, 5000, 3001];
async function resolveDevPort() {
  if (DEV_PORT_ARG || (await portUp(devPort))) return;
  let found = 0;
  for (const p of COMMON_DEV_PORTS) {
    if (p !== devPort && (await portUp(p))) { found = p; break; }
  }
  if (process.stdin.isTTY) {
    const def = found || devPort;
    const note = found ? `, but something is answering on ${found}` : "";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(`No dev server on port ${devPort}${note}. Port to proxy [${def}]: `, resolve));
    rl.close();
    const picked = Number(String(answer).trim()) || def;
    if (picked !== devPort) {
      devPort = picked;
      state.devPort = picked;
      saveState(state);
    }
  } else if (found) {
    console.log(`Note: no dev server on port ${devPort}, but something is answering on ${found}.
If that's it, restart with --dev-port ${found} or switch ports from the phone UI.`);
  }
  if (!(await portUp(devPort))) {
    console.log(`
No dev server is running on port ${devPort} yet — the preview will show a
waiting page until one answers. Start it in another terminal (${DEV_CMD}),
or from the phone UI's + menu, or just ask the agent to. To change the
port later, tap the port number in the phone UI's status bar.`);
  }
}
await resolveDevPort();

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`durbin: port ${PORT} is already in use — another durbin (or something else) is listening there.
Stop it, or start this one on a different port:  durbin --port <n>`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`
durbin is up.

  project:   ${ROOT}
  agent UI:  http://127.0.0.1:${PORT}/__agent?token=${TOKEN}
  login:     ${passwordSet() ? "password is set (or use the token)" : `token only (set a password with: durbin password <pw>)`}
  proxying:  / -> http://127.0.0.1:${devPort} (${DEV_CMD})
`);
  if (NO_FUNNEL) {
    console.log(`Funnel setup skipped (--no-funnel). Expose port ${PORT} over HTTPS yourself,
then open https://<your-host>/__agent?token=<token> and bookmark it.`);
  } else {
    setupFunnel();
  }
});
