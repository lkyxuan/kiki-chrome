// Service worker: keeps one WebSocket to Kiki on this Mac and runs the actions Kiki sends,
// only inside tabs this extension opened (the "Kiki" tab group).
import { ACTIONS, DEBUGGER_IDLE_MS, DEFAULT_SERVER, GROUP_TITLE, HEARTBEAT_MS, backoff, charKeyEvent, clickPoint, fail, hello, keyEvent, mousePath, ok, newInstallId, parseCall, typingPlan, validName } from "./protocol.js";
import { deepQuery, findText, locate, markRef, pointInfo, putFiles, snapshotPage, unmarkRef } from "./page.js";

const VERSION = chrome.runtime.getManifest().version;
let ws = null;
let attempt = 0;
let retryTimer = null;
let beat = null;

// ---------- settings & status ----------

async function settings() {
  const s = await chrome.storage.local.get(["name", "token", "server", "key", "install", "refused"]);
  if (!s.install) {
    s.install = newInstallId();
    await chrome.storage.local.set({ install: s.install });
  }
  return { name: s.name || "", token: s.token || "", server: s.server || DEFAULT_SERVER, key: s.key || "", install: s.install, refused: s.refused || 0 };
}

async function setStatus(state, detail = "") {
  await chrome.storage.session.set({ status: { state, detail, at: Date.now() } });
  const badge = { connected: "", connecting: "…", waiting: "…", error: "!", off: "" }[state] ?? "";
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: state === "error" ? "#d93025" : "#fd890c" });
}

// ---------- connection ----------

// Texts follow Chrome's language (English by default, Chinese when Chrome is in Chinese): _locales/*/messages.json
const t = (key) => chrome.i18n.getMessage(key);
const CLOSE_REASONS = Object.fromEntries([4001, 4002, 4003, 4004, 4005, 4006, 4007].map((c) => [c, t(`close${c}`)]));
// No pairing code and Kiki still said 4001: that Kiki predates approve-in-Kiki
const OLD_KIKI = t("oldKiki");

// Only one connection attempt at a time: settings are read asynchronously, so two callers
// (popup save fires both the storage listener and the reconnect message) could otherwise both open a socket.
let connecting = null;
function connect() {
  connecting ??= doConnect().finally(() => (connecting = null));
  return connecting;
}

async function doConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  const s = await settings();
  if (s.name && !validName(s.name)) {
    await setStatus("off", t("close4002"));
    return;
  }
  // Refused (4005) or removed (4003) in Kiki: don't ask again on every Chrome start or keepalive alarm;
  // clicking 连接 in the popup clears this
  if (s.refused && !s.token && !s.key) {
    await setStatus("off", CLOSE_REASONS[s.refused] || CLOSE_REASONS[4005]);
    return;
  }
  await setStatus("connecting");
  let sock;
  try {
    sock = new WebSocket(s.server);
  } catch {
    await setStatus("error", t("badServer"));
    return scheduleRetry();
  }
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify(hello({ token: s.token, name: s.name, version: VERSION, key: s.key, install: s.install })));
    clearInterval(beat);
    beat = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), HEARTBEAT_MS);
  };
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onclose = (ev) => {
    clearInterval(beat);
    if (ws === sock) ws = null;
    // Codes Kiki sends when retrying will not help until the user changes something.
    // 4004 must not retry either: two Profiles with the same name would keep kicking each other off.
    if (ev.code === 4005) chrome.storage.local.set({ refused: 4005 });
    if (ev.code === 4003) chrome.storage.local.set({ refused: 4003, key: "" });
    if (ev.code === 4001 && !s.token) return setStatus("error", OLD_KIKI);
    const fatal = CLOSE_REASONS[ev.code];
    if (fatal) return setStatus("error", fatal);
    setStatus("error", t("cantReach"));
    scheduleRetry();
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => connect(), backoff(attempt++));
}

// Reconnects run one after another, each waiting for any attempt in flight, so the newest settings win
// and no superseded socket is left alive.
let chain = Promise.resolve();
function reconnect() {
  chain = chain.then(async () => {
    await connecting;
    attempt = 0;
    clearTimeout(retryTimer);
    clearInterval(beat);
    if (ws) {
      const old = ws;
      ws = null;
      old.onclose = null;
      old.onmessage = null;
      old.close();
    }
    await connect();
  });
  return chain;
}

async function onMessage(sock, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.type === "welcome") {
    attempt = 0;
    // Approved in Kiki: keep the key and the name Kiki settled on, so the next start connects straight away
    // (the storage listener ignores name/key, so this does not trigger a reconnect)
    if (msg.key) await chrome.storage.local.set({ key: msg.key, name: msg.name || "", refused: 0 });
    return setStatus("connected", msg.name || "");
  }
  if (msg.type === "pending") {
    attempt = 0;
    return setStatus("waiting", msg.name || "");
  }
  if (msg.type === "pong") return;
  if (msg.type !== "call") return;
  let call;
  try {
    call = parseCall(msg);
  } catch (e) {
    return sock.send(JSON.stringify(fail(msg.id ?? null, e)));
  }
  try {
    const result = await run(call.action, call.params);
    sock.send(JSON.stringify(ok(call.id, result)));
  } catch (e) {
    sock.send(JSON.stringify(fail(call.id, e)));
  }
}

// ---------- tab group: we only touch tabs we opened ----------

async function groupId() {
  const { group } = await chrome.storage.local.get("group");
  if (group !== undefined) {
    try {
      await chrome.tabGroups.get(group);
      return group;
    } catch {
      /* closed, or Chrome restarted and restored the group under a new id */
    }
  }
  // after a browser restart Chrome restores our group with a new id: adopt it by title
  const [found] = await chrome.tabGroups.query({ title: GROUP_TITLE });
  if (found) {
    await chrome.storage.local.set({ group: found.id });
    return found.id;
  }
  return undefined;
}

async function ownTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const g = await groupId();
  if (!tab || g === undefined || tab.groupId !== g) throw new Error(`tab ${tabId} is not a Kiki tab; open one with open`);
  return tab;
}

async function addToGroup(tabId) {
  const g = await groupId();
  if (g !== undefined) return chrome.tabs.group({ groupId: g, tabIds: [tabId] });
  const id = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(id, { title: GROUP_TITLE, color: "orange" });
  await chrome.storage.local.set({ group: id });
  return id;
}

function waitLoaded(tabId, ms = 30_000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(t);
      resolve();
    };
    const onUpd = (id, info) => id === tabId && info.status === "complete" && done();
    const t = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((tab) => tab.status === "complete" && done(), done);
  });
}

// ---------- debugger (real clicks, typing, uploads, screenshots) ----------

const attached = new Map(); // tabId -> idle timer

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.set(tabId, null);
  }
  clearTimeout(attached.get(tabId));
  attached.set(tabId, setTimeout(() => detach(tabId), DEBUGGER_IDLE_MS));
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function detach(tabId) {
  clearTimeout(attached.get(tabId));
  attached.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onDetach.addListener((src) => {
  clearTimeout(attached.get(src.tabId));
  attached.delete(src.tabId);
});

async function inPage(tabId, func, ...args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function point(tabId, ref) {
  const p = await inPage(tabId, locate, ref);
  if (!p || p.error) throw new Error(p?.error || `no element ${ref}`);
  return p;
}

/** A spot on the screenshot (viewport CSS pixels, see screenshot) and what is there. */
async function spot(tabId, x, y) {
  const p = await inPage(tabId, pointInfo, Number(x), Number(y));
  if (!p || p.error) throw new Error(p?.error || `nothing at ${x},${y}`);
  if (x > p.vw || y > p.vh) throw new Error(`${x},${y} is outside the window (${p.vw}×${p.vh}); take a new screenshot`);
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (lo, hi) => lo + Math.round(Math.random() * (hi - lo));

// Where the mouse was left in each tab, so the next move starts from there instead of jumping.
const mouseAt = new Map(); // tabId -> { x, y }

/** Glide the mouse to `to` along a curved path, like a hand would. */
async function moveMouse(tabId, to, view) {
  const from = mouseAt.get(tabId) || { x: between(0, view?.vw || 800), y: between(0, view?.vh || 600) };
  for (const pt of mousePath(from, to)) {
    if (pt.wait) await sleep(pt.wait);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
  }
  mouseAt.set(tabId, { x: to.x, y: to.y });
}

/** Move to a slightly random spot inside the element, pause, press, hold briefly, release. */
async function mouseClick(tabId, box) {
  const { x, y } = clickPoint(box);
  await moveMouse(tabId, { x, y }, box);
  await sleep(between(40, 120));
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(between(50, 130));
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

/** Type key by key with human pauses (see typingPlan); non-ASCII is committed in small runs like an IME. */
async function typeText(tabId, text) {
  for (const step of typingPlan(text)) {
    if (step.wait) await sleep(step.wait);
    if (step.kind === "insert") {
      await cdp(tabId, "Input.insertText", { text: step.text });
      continue;
    }
    const ev = charKeyEvent(step.ch);
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await sleep(between(15, 45)); // key held down briefly (counted in typingPlan's budget)
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...ev, text: undefined, unmodifiedText: undefined });
  }
}

// ---------- actions ----------

async function run(action, p) {
  if (ACTIONS[action].tab) await ownTab(p.tabId);
  switch (action) {
    case "tabs": {
      const g = await groupId();
      if (g === undefined) return { tabs: [] };
      const tabs = await chrome.tabs.query({ groupId: g });
      return { tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active })) };
    }
    case "open": {
      const tab = await chrome.tabs.create({ url: p.url, active: true });
      await addToGroup(tab.id);
      await waitLoaded(tab.id);
      const t = await chrome.tabs.get(tab.id);
      return { tabId: t.id, url: t.url, title: t.title };
    }
    case "navigate": {
      await chrome.tabs.update(p.tabId, { url: p.url });
      await sleep(300);
      await waitLoaded(p.tabId);
      const t = await chrome.tabs.get(p.tabId);
      return { url: t.url, title: t.title };
    }
    case "close":
      mouseAt.delete(p.tabId);
      detach(p.tabId);
      await chrome.tabs.remove(p.tabId);
      return { closed: p.tabId };
    case "snapshot":
      return inPage(p.tabId, snapshotPage, Number(p.maxText) || 6000);
    case "find": {
      // a button the list missed (drawn with a plain <div>, deep in a web component): find it by the words on it
      const r = await inPage(p.tabId, findText, String(p.text));
      if (!r || r.error) throw new Error(r?.error || `nothing on the page says "${p.text}"`);
      return r;
    }
    case "describe": {
      if (p.ref === undefined) {
        const { name, tag, type } = await spot(p.tabId, p.x, p.y);
        return { x: p.x, y: p.y, name, tag, type };
      }
      const { name, tag, type } = await point(p.tabId, p.ref);
      return { ref: p.ref, name, tag, type };
    }
    case "click": {
      if (p.ref === undefined) {
        // a button seen on the screenshot but missing from the list (canvas, closed web component): press right there
        const at = await spot(p.tabId, p.x, p.y);
        await mouseClick(p.tabId, { x: Number(p.x), y: Number(p.y), w: 4, h: 4, vw: at.vw, vh: at.vh });
        return { clicked: [p.x, p.y], name: at.name };
      }
      const box = await point(p.tabId, p.ref);
      await mouseClick(p.tabId, box);
      return { clicked: p.ref, name: box.name };
    }
    case "type": {
      if (p.ref !== undefined) {
        await mouseClick(p.tabId, await point(p.tabId, p.ref));
        await sleep(between(150, 400));
      }
      if (p.clear) {
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...keyEvent("cmd+a") });
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent("cmd+a") });
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...keyEvent("Backspace") });
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent("Backspace") });
      }
      await typeText(p.tabId, String(p.text));
      return { typed: String(p.text).length };
    }
    case "key": {
      const ev = keyEvent(p.key);
      await cdp(p.tabId, "Input.dispatchKeyEvent", { type: ev.text ? "keyDown" : "rawKeyDown", ...ev });
      await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...ev, text: undefined, commands: undefined });
      return { pressed: p.key };
    }
    case "scroll": {
      let to = mouseAt.get(p.tabId) || { x: between(300, 500), y: between(250, 350) };
      if (p.ref !== undefined) to = clickPoint(await point(p.tabId, p.ref));
      await moveMouse(p.tabId, to);
      const { x, y } = to;
      const dy = Number(p.deltaY ?? (p.direction === "up" ? -600 : 600));
      await cdp(p.tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
      return { scrolled: dy };
    }
    case "upload": {
      // Chrome only lets the debugger hand over local files when "Allow access to file URLs" is on for this
      // extension (off by default for store installs). Without it, use the bytes Kiki sent along.
      const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!fileAccess) {
        if (!Array.isArray(p.blobs) || p.blobs.length !== p.files.length) throw new Error("NO_FILE_ACCESS: this Kiki is too old to send files without the extension's \"Allow access to file URLs\" switch; update Kiki, or turn that switch on in chrome://extensions → Kiki → Details");
        const r = await inPage(p.tabId, putFiles, p.ref, p.blobs);
        if (!r || r.error) throw new Error(r?.error || "upload failed");
        return { uploaded: r.count };
      }
      // the element gets a random one-off attribute only for the moment the debugger needs to find it
      const attr = `data-k${crypto.randomUUID().slice(0, 8)}`;
      const marked = await inPage(p.tabId, markRef, p.ref, attr);
      if (!marked || marked.error) throw new Error(marked?.error || `no element ${p.ref}; take a new snapshot`);
      try {
        const { result } = await cdp(p.tabId, "Runtime.evaluate", { expression: deepQuery(attr) });
        if (!result?.objectId) throw new Error(`no element ${p.ref}; take a new snapshot`);
        await cdp(p.tabId, "DOM.setFileInputFiles", { objectId: result.objectId, files: p.files });
      } finally {
        await inPage(p.tabId, unmarkRef, attr).catch(() => {});
      }
      return { uploaded: p.files.length };
    }
    case "screenshot": {
      const tab = await chrome.tabs.get(p.tabId);
      if (!tab.active) await chrome.tabs.update(p.tabId, { active: true });
      // in CSS pixels (not the screen's 2x), so a spot on this picture is the x/y click and describe take
      const { cssVisualViewport: v } = await cdp(p.tabId, "Page.getLayoutMetrics");
      const dpr = (await inPage(p.tabId, () => window.devicePixelRatio)) || 1;
      const width = Math.round(v.clientWidth), height = Math.round(v.clientHeight);
      const { data } = await cdp(p.tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x: v.pageX, y: v.pageY, width, height, scale: 1 / dpr } });
      return { mime: "image/jpeg", data, width, height };
    }
    case "eval": {
      const r = await cdp(p.tabId, "Runtime.evaluate", { expression: String(p.expression), returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return { value: r.result?.value };
    }
  }
  throw new Error(`unknown action: ${action}`);
}

// ---------- lifecycle ----------

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.storage.onChanged.addListener((changes, area) => {
  // name changes come from the popup (which also sends "reconnect") or from Kiki's welcome: neither needs this
  if (area === "local" && (changes.token || changes.server)) reconnect();
});
// backstop: if the worker was stopped, the alarm wakes it and we reconnect
chrome.alarms.create("kiki-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "kiki-keepalive" && connect());
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m?.type === "reconnect") {
    reconnect();
    reply({ ok: true });
  }
});
connect();
