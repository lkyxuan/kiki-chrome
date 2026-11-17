// Pure helpers shared by the service worker and the tests. No chrome.* here.

export const PROTOCOL_VERSION = 2;
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
export const validName = (s) => typeof s === "string" && /^[\p{L}\p{N}_-]{1,40}$/u.test(s) && !(s in Object.prototype); // same as Kiki: no "constructor", "__proto__"…

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

/**
 * First message on every connection. Kiki accepts one of:
 * - `key` + `name`: the per-browser key Kiki gave when you approved it; connects straight away.
 * - `token` + `name`: the pairing code from Kiki → Settings → Browsers (same Mac only).
 * - neither: Kiki answers `pending` and lists this browser under "新浏览器想连上" until you approve it,
 *   then sends `welcome` with a `key`. `install` tells repeat requests from the same install apart.
 */
export const hello = ({ token, name, version, key, install }) => ({ type: "hello", protocol: PROTOCOL_VERSION, token: token || undefined, name: name || undefined, version, key: key || undefined, install });

/** Random id for this install, sent while waiting for approval. */
export const newInstallId = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
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

// ---------- human-like input ----------
// Pure planners; background.js turns their output into CDP Input events. `rand` is injectable for tests.

/**
 * Pick a point inside the middle 40% of the element's visible part instead of its exact centre.
 * Elements taller or wider than the window are clipped to the viewport (`vw`/`vh`) first, so the point is on screen.
 */
export function clickPoint({ x, y, w = 0, h = 0, vw = Infinity, vh = Infinity }, rand = Math.random) {
  const left = Math.max(x - w / 2, 0);
  const right = Math.min(x + w / 2, vw);
  const top = Math.max(y - h / 2, 0);
  const bottom = Math.min(y + h / 2, vh);
  const cx = right > left ? (left + right) / 2 : x;
  const cy = bottom > top ? (top + bottom) / 2 : y;
  const vw2 = Math.max(0, right - left);
  const vh2 = Math.max(0, bottom - top);
  return { x: cx + (rand() - 0.5) * vw2 * 0.4, y: cy + (rand() - 0.5) * vh2 * 0.4 };
}

/**
 * Points a mouse passes through from `from` to `to`: a gently curved path (quadratic Bézier with a random
 * bend), eased so it speeds up and slows down, ending exactly on `to`. Each point carries the pause before it.
 */
export function mousePath(from, to, rand = Math.random) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return [{ x: to.x, y: to.y, wait: 0 }];
  const steps = Math.max(6, Math.min(25, Math.round(dist / 40)));
  const bend = (rand() - 0.5) * 0.5 * dist; // sideways offset of the control point
  const cx = (from.x + to.x) / 2 - (dy / dist) * bend;
  const cy = (from.y + to.y) / 2 + (dx / dist) * bend;
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    const t = s < 0.5 ? 2 * s * s : 1 - (-2 * s + 2) ** 2 / 2; // ease in-out
    const u = 1 - t;
    let x = u * u * from.x + 2 * u * t * cx + t * t * to.x;
    let y = u * u * from.y + 2 * u * t * cy + t * t * to.y;
    if (i < steps) {
      x += (rand() - 0.5) * 2;
      y += (rand() - 0.5) * 2;
    } else {
      x = to.x;
      y = to.y;
    }
    pts.push({ x, y, wait: 8 + Math.round(rand() * 10) });
  }
  return pts;
}

/** Typing has to finish inside Kiki's 60 s per-call timeout; keep well under it. */
export const TYPING_BUDGET_MS = 40_000;

const ASCII_TYPABLE = /^[\x20-\x7e]$/;

/**
 * Split text into keystrokes with pauses. Printable ASCII is typed key by key; other text (Chinese, emoji…)
 * is committed a few characters at a time like an input method does; newlines are inserted as text rather
 * than pressed as Enter, because Enter can submit a form (and posting must go through Kiki's approval).
 * Long text gets bigger chunks and shorter pauses so the whole thing fits the budget.
 * Returns [{ kind: "key", ch, wait } | { kind: "insert", text, wait }], `wait` = pause before that step.
 */
export function typingPlan(text, rand = Math.random) {
  const chars = [...String(text)];
  // ~90 ms average pause (incl. the odd longer one) + ~30 ms key hold + CDP round trips ≈ 120 ms a step;
  // if that would blow the budget, group characters so the step count fits
  const maxSteps = Math.floor(TYPING_BUDGET_MS / 120);
  const group = Math.max(1, Math.ceil(chars.length / maxSteps));
  const steps = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const wait = 30 + Math.round(rand() * 90) + (rand() < 0.04 ? 200 + Math.round(rand() * 300) : 0);
    if (group === 1 && ASCII_TYPABLE.test(ch)) {
      steps.push({ kind: "key", ch, wait });
      i += 1;
      continue;
    }
    // a run of non-key characters (or anything, once text is long): 1-3 characters, times the group size
    const n = group * (1 + Math.floor(rand() * 3));
    let j = i;
    let chunk = "";
    while (j < chars.length && j - i < n && (group > 1 || !ASCII_TYPABLE.test(chars[j]))) chunk += chars[j++];
    steps.push({ kind: "insert", text: chunk, wait: group > 1 ? Math.min(wait, 60) : wait });
    i = j;
  }
  return steps;
}

/** CDP key params for typing one printable ASCII character (no combo parsing: "+" is a character here). */
export function charKeyEvent(ch) {
  const up = ch.toUpperCase();
  const isLetter = /[a-z]/i.test(ch);
  const isDigit = /[0-9]/.test(ch);
  return {
    key: ch,
    code: ch === " " ? "Space" : isLetter ? `Key${up}` : isDigit ? `Digit${ch}` : "",
    windowsVirtualKeyCode: ch === " " ? 32 : isLetter || isDigit ? up.charCodeAt(0) : 0,
    modifiers: /[A-Z]/.test(ch) ? 8 : 0,
    text: ch,
    unmodifiedText: ch,
  };
}
