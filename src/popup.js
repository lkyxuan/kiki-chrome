import { DEFAULT_SERVER, validName } from "./protocol.js";

const $ = (id) => document.getElementById(id);
const LABEL = { connected: "已连上 Kiki", connecting: "正在连接…", waiting: "等你在 Kiki 里点同意", error: "没连上", off: "没连接" };
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
    state === "connected" ? (st?.detail ? `，这个浏览器叫「${st.detail}」` : "")
    : state === "waiting" ? `：到 Kiki → 设置 → 浏览器，同意「${st?.detail || "新浏览器"}」`
    : st?.detail ? `：${st.detail}` : "";
  $("status").textContent = LABEL[state] + detail;
  $("status").className = state === "error" ? "err" : "";

  if (!clickedAt) {
    button(state === "connected" ? "重新连接" : state === "waiting" ? "重新申请" : "连接");
    return;
  }
  // waiting for the answer to this click
  if ((st?.at || 0) < clickedAt) return;
  if (state === "waiting") {
    clearTimeout(waitTimer); // Kiki answered; now it is up to you, no time limit
    button("等你同意…", true);
  } else if (state === "connected") {
    clearTimeout(waitTimer);
    button("连上了 ✓", true);
    setTimeout(() => window.close(), 1200);
  } else if (state === "error" || state === "off") {
    clearTimeout(waitTimer);
    clickedAt = 0;
    button("重新连接");
  }
}

$("save").onclick = async () => {
  const name = $("name").value.trim();
  const token = $("token").value.trim();
  if (name && !validName(name)) return say("名字只用文字、数字、- 和 _，最多 40 个字");
  clickedAt = Date.now();
  button("连接中…", true);
  clearTimeout(waitTimer);
  waitTimer = setTimeout(() => {
    clickedAt = 0;
    button("重新连接");
    say("10 秒还没连上：确认这台电脑上 Kiki 开着、已经更新到最新版");
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
