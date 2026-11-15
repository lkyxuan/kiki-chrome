// Pure helpers shared by the service worker and the tests. No chrome.* here.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_SERVER = "ws://127.0.0.1:4567/ext";
export const HEARTBEAT_MS = 20_000; // Chrome 116+: WebSocket traffic keeps the service worker alive
export const DEBUGGER_IDLE_MS = 30_000; // detach (and drop the "is debugging" bar) after this long without actions
export const GROUP_TITLE = "Kiki";

/** Actions Kiki may call. Every action except `tabs` and `open` works on one tab Kiki opened. */
export const ACTIONS = {
  tabs: { tab: false },
  open: { tab: false, need: ["url"] },
  navigate: { tab: true, need: ["url"] },
  close: { tab: true },
  snapshot: { tab: true },
  describe: { tab: true, need: ["ref"] },
  click: { tab: true, need: ["ref"] },
  type: { tab: true, need: ["text"] },
  key: { tab: true, need: ["key"] },
  scroll: { tab: true },
  upload: { tab: true, need: ["ref", "files"] },
  screenshot: { tab: true },
  eval: { tab: true, need: ["expression"] },
};

/** Browser names look like "mac-mini-1" or "工作浏览器": letters (any script), digits, - and _. */
export const validName = (s) => typeof s === "string" && /^[\p{L}\p{N}_-]{1,40}$/u.test(s);

/** Parse one message from Kiki. Returns { id, action, params } or throws with a reason Kiki can show. */
export function parseCall(raw) {
  let m;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("bad JSON");
  }
  if (!m || m.type !== "call") throw new Error("not a call");
  if (typeof m.id !== "string" && typeof m.id !== "number") throw new Error("missing id");
  const spec = ACTIONS[m.action];
  if (!spec) throw new Error(`unknown action: ${m.action}`);
  const params = m.params && typeof m.params === "object" ? m.params : {};
  if (spec.tab && !Number.isInteger(params.tabId)) throw new Error(`${m.action} needs tabId`);
  for (const k of spec.need || []) {
    if (params[k] === undefined || params[k] === "") throw new Error(`${m.action} needs ${k}`);
  }
  if (params.url !== undefined && !/^https?:\/\//i.test(String(params.url))) throw new Error("url must start with http:// or https://");
  if (params.files !== undefined && (!Array.isArray(params.files) || !params.files.every((f) => typeof f === "string" && f.startsWith("/")))) {
    throw new Error("files must be a list of absolute paths");
  }
  return { id: m.id, action: m.action, params };
}

export const hello = ({ token, name, version }) => ({ type: "hello", protocol: PROTOCOL_VERSION, token, name, version });
export const ok = (id, result) => ({ type: "result", id, ok: true, result });
export const fail = (id, err) => ({ type: "result", id, ok: false, error: String(err?.message || err) });

/** Reconnect delay: 1s, 2s, 4s … capped at 30s. */
export const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));

const KEYS = {
  enter: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  up: ["ArrowUp", "ArrowUp", 38],
  down: ["ArrowDown", "ArrowDown", 40],
  left: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
};
const MODS = { alt: 1, ctrl: 2, control: 2, cmd: 4, meta: 4, command: 4, shift: 8 };

/**
 * Turn "Enter", "cmd+a", "shift+Tab" into CDP Input.dispatchKeyEvent params (without `type`).
 * Throws on keys we do not know so the model gets a clear error instead of a silent no-op.
 */
export function keyEvent(combo) {
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty key");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const bit = MODS[p.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier: ${p}`);
    modifiers |= bit;
  }
  const named = KEYS[keyName.toLowerCase()];
  if (named) {
    const [key, code, vk, text] = named;
    return { key, code, windowsVirtualKeyCode: vk, modifiers, ...(text && !(modifiers & ~8) ? { text } : {}) };
  }
  if ([...keyName].length === 1) {
    const ch = keyName;
    const up = ch.toUpperCase();
    const isLetter = /[a-z]/i.test(ch);
    const isDigit = /[0-9]/.test(ch);
    return {
      key: ch,
      code: isLetter ? `Key${up}` : isDigit ? `Digit${ch}` : "",
      windowsVirtualKeyCode: isLetter || isDigit ? up.charCodeAt(0) : 0,
      modifiers,
      // with cmd/ctrl/alt held the key is a shortcut, not text
      ...(modifiers & ~8 ? { commands: shortcutCommands(ch, modifiers) } : { text: ch }),
    };
  }
  throw new Error(`unknown key: ${keyName}`);
}

/** macOS needs editing commands for cmd shortcuts to do anything in CDP (cmd+a alone does not select all). */
function shortcutCommands(ch, modifiers) {
  if (!(modifiers & 4)) return [];
  const c = ch.toLowerCase();
  return { a: ["selectAll"], c: ["copy"], x: ["cut"], v: ["paste"], z: modifiers & 8 ? ["redo"] : ["undo"] }[c] || [];
}

/** Words on buttons that publish something. Kiki checks these before a click; kept here so both sides agree. */
export const PUBLISH_WORDS = ["发布", "发送", "发表", "发帖", "评论", "回复", "转发", "提交", "post", "tweet", "reply", "send", "publish", "share", "submit", "repost"];
export const looksLikePublish = (name) => {
  const s = String(name || "").trim().toLowerCase();
  if (!s || s.length > 20) return false;
  return PUBLISH_WORDS.some((w) => s === w || s.startsWith(w) || s.endsWith(w));
};
