// Service worker: keeps one WebSocket to Kiki on this Mac and runs the actions Kiki sends,
// only inside tabs this extension opened (the "Kiki" tab group).
import { ACTIONS, DEBUGGER_IDLE_MS, DEFAULT_SERVER, GROUP_TITLE, HEARTBEAT_MS, backoff, fail, hello, keyEvent, ok, parseCall, validName } from "./protocol.js";
import { locate, snapshotPage } from "./page.js";

const VERSION = chrome.runtime.getManifest().version;
let ws = null;
let attempt = 0;
let retryTimer = null;
let beat = null;

// ---------- settings & status ----------

async function settings() {
  const s = await chrome.storage.local.get(["name", "token", "server"]);
  return { name: s.name || "", token: s.token || "", server: s.server || DEFAULT_SERVER };
}

async function setStatus(state, detail = "") {
  await chrome.storage.session.set({ status: { state, detail, at: Date.now() } });
  const badge = { connected: "", connecting: "…", error: "!", off: "" }[state] ?? "";
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: state === "error" ? "#d93025" : "#fd890c" });
}

// ---------- connection ----------

const CLOSE_REASONS = {
  4001: "配对码不对，到 Kiki 设置 → 浏览器 里重新复制",
  4002: "名字不行：只用文字、数字、- 和 _",
  4003: "在 Kiki 里被删掉了，点连接重新加上",
  4004: "另一个 Profile 也叫这个名字，换一个名字",
};

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
  if (!validName(s.name) || !s.token) {
    await setStatus("off", "填上名字和配对码");
    return;
  }
  await setStatus("connecting");
  let sock;
  try {
    sock = new WebSocket(s.server);
  } catch {
    await setStatus("error", "Kiki 地址不对，应该像 ws://127.0.0.1:4567/ext");
    return scheduleRetry();
  }
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify(hello({ token: s.token, name: s.name, version: VERSION })));
    clearInterval(beat);
    beat = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), HEARTBEAT_MS);
  };
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onclose = (ev) => {
    clearInterval(beat);
    if (ws === sock) ws = null;
    // Codes Kiki sends when retrying will not help until the user changes something.
    // 4004 must not retry either: two Profiles with the same name would keep kicking each other off.
    const fatal = CLOSE_REASONS[ev.code];
    if (fatal) return setStatus("error", fatal);
    setStatus("error", "连不上 Kiki：确认 Kiki 开着，地址没填错");
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
    return setStatus("connected", msg.name || "");
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

async function mouseClick(tabId, x, y) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      detach(p.tabId);
      await chrome.tabs.remove(p.tabId);
      return { closed: p.tabId };
    case "snapshot":
      return inPage(p.tabId, snapshotPage, Number(p.maxText) || 6000);
    case "describe": {
      const { name, tag, type } = await point(p.tabId, p.ref);
      return { ref: p.ref, name, tag, type };
    }
    case "click": {
      const { x, y, name } = await point(p.tabId, p.ref);
      await mouseClick(p.tabId, x, y);
      return { clicked: p.ref, name };
    }
    case "type": {
      if (p.ref !== undefined) {
        const { x, y } = await point(p.tabId, p.ref);
        await mouseClick(p.tabId, x, y);
      }
      if (p.clear) {
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...keyEvent("cmd+a") });
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent("cmd+a") });
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...keyEvent("Backspace") });
        await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent("Backspace") });
      }
      await cdp(p.tabId, "Input.insertText", { text: String(p.text) });
      return { typed: String(p.text).length };
    }
    case "key": {
      const ev = keyEvent(p.key);
      await cdp(p.tabId, "Input.dispatchKeyEvent", { type: ev.text ? "keyDown" : "rawKeyDown", ...ev });
      await cdp(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...ev, text: undefined, commands: undefined });
      return { pressed: p.key };
    }
    case "scroll": {
      let x = 400;
      let y = 300;
      if (p.ref !== undefined) ({ x, y } = await point(p.tabId, p.ref));
      const dy = Number(p.deltaY ?? (p.direction === "up" ? -600 : 600));
      await cdp(p.tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
      return { scrolled: dy };
    }
    case "upload": {
      const sel = `[data-kiki-ref="${String(p.ref).replace(/"/g, "")}"]`;
      const { result } = await cdp(p.tabId, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})` });
      if (!result?.objectId) throw new Error(`no element ${p.ref}; take a new snapshot`);
      await cdp(p.tabId, "DOM.setFileInputFiles", { objectId: result.objectId, files: p.files });
      return { uploaded: p.files.length };
    }
    case "screenshot": {
      const tab = await chrome.tabs.get(p.tabId);
      if (!tab.active) await chrome.tabs.update(p.tabId, { active: true });
      const { data } = await cdp(p.tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
      return { mime: "image/jpeg", data };
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
  if (area === "local" && (changes.name || changes.token || changes.server)) reconnect();
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
