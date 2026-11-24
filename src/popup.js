import { DEFAULT_SERVER, validName } from "./protocol.js";

const $ = (id) => document.getElementById(id);
// Texts follow Chrome's language (English by default): _locales/*/messages.json
const t = (key, sub) => chrome.i18n.getMessage(key, sub);
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
document.documentElement.lang = chrome.i18n.getUILanguage();
const LABEL = { connected: t("stConnected"), connecting: t("stConnecting"), waiting: t("stWaiting"), error: t("stError"), off: t("stOff") };
const WAIT_MS = 10_000; // this long without "connected" after a click: say so instead of spinning forever

let nameEdited = false; // the user typed in the name box: don't overwrite it with the name Kiki settled on
$("name").addEventListener("input", () => (nameEdited = true));
let clickedAt = 0; // set when the user clicks 连接; only status written after it counts as the answer
let waitTimer;

async function load() {
  const s = await chrome.storage.local.get(["name", "token", "server"]);
  $("name").value = s.name || "";
  $("token").value = s.token || "";
  $("server").value = s.server || "";
  $("server").placeholder = DEFAULT_SERVER;
  if (s.token || (s.server && s.server !== DEFAULT_SERVER)) $("adv").open = true;
  show((await chrome.storage.session.get("status")).status);
}

function button(text, disabled = false) {
  $("save").textContent = text;
  $("save").disabled = disabled;
}

function show(st) {
  const state = st?.state || "off";
  $("dot").className = `dot ${state}`;
  const detail =
    state === "connected" ? (st?.detail ? t("stNamed", st.detail) : "")
    : state === "waiting" ? t("stWaitingDetail", st?.detail || t("newBrowser"))
    : st?.detail ? t("detailSep") + st.detail : "";
  $("status").textContent = LABEL[state] + detail;
  $("status").className = state === "error" ? "err" : "";

  if (!clickedAt) {
    button(state === "connected" ? t("btnReconnect") : state === "waiting" ? t("btnReapply") : t("btnConnect"));
    return;
  }
  // waiting for the answer to this click
  if ((st?.at || 0) < clickedAt) return;
  if (state === "waiting") {
    clearTimeout(waitTimer); // Kiki answered; now it is up to you, no time limit
    button(t("btnWaiting"), true);
  } else if (state === "connected") {
    clearTimeout(waitTimer);
    button(t("btnConnected"), true);
    setTimeout(() => window.close(), 1200);
  } else if (state === "error" || state === "off") {
    clearTimeout(waitTimer);
    clickedAt = 0;
    button(t("btnReconnect"));
  }
}

$("save").onclick = async () => {
  const name = $("name").value.trim();
  const token = $("token").value.trim();
  if (name && !validName(name)) return say(t("badName"));
  clickedAt = Date.now();
  button(t("btnConnecting"), true);
  clearTimeout(waitTimer);
  waitTimer = setTimeout(() => {
    clickedAt = 0;
    button(t("btnReconnect"));
    say(t("slow"));
  }, WAIT_MS);
  // clicking 连接 also takes back an earlier 拒绝 / 删除 in Kiki, so the browser asks again
  await chrome.storage.local.set({ name, token, server: $("server").value.trim() || DEFAULT_SERVER, refused: 0 });
  chrome.runtime.sendMessage({ type: "reconnect" });
};

function say(text) {
  $("dot").className = "dot error";
  $("status").textContent = text;
  $("status").className = "err";
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "session" && c.status) show(c.status.newValue);
  // approved in Kiki while this popup is open: show the name Kiki settled on, so saving keeps it
  if (area === "local" && c.name && !nameEdited) $("name").value = c.name.newValue || "";
});
load();
