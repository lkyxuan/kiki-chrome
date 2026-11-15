import { DEFAULT_SERVER, validName } from "./protocol.js";

const $ = (id) => document.getElementById(id);
const LABEL = { connected: "已连上 Kiki", connecting: "正在连接…", error: "没连上", off: "还没设置" };
const WAIT_MS = 10_000; // this long without "connected" after a click: say so instead of spinning forever

let clickedAt = 0; // set when the user clicks 连接; only status written after it counts as the answer
let waitTimer;

async function load() {
  const s = await chrome.storage.local.get(["name", "token", "server"]);
  $("name").value = s.name || "";
  $("token").value = s.token || "";
  $("server").value = s.server || "";
  $("server").placeholder = DEFAULT_SERVER;
  show((await chrome.storage.session.get("status")).status);
}

function button(text, disabled = false) {
  $("save").textContent = text;
  $("save").disabled = disabled;
}

function show(st) {
  const state = st?.state || "off";
  $("dot").className = `dot ${state}`;
  const detail = state === "connected" ? (st?.detail ? `，这个浏览器叫「${st.detail}」` : "") : st?.detail ? `：${st.detail}` : "";
  $("status").textContent = LABEL[state] + detail;
  $("status").className = state === "error" ? "err" : "";

  if (!clickedAt) {
    button(state === "connected" ? "重新连接" : "连接");
    return;
  }
  // waiting for the answer to this click
  if ((st?.at || 0) < clickedAt) return;
  if (state === "connected") {
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
  if (!validName(name)) return say("名字只用文字、数字、- 和 _，最多 40 个字");
  if (!token) return say("填上配对码（在 Kiki 设置 → 浏览器 里复制）");
  clickedAt = Date.now();
  button("连接中…", true);
  clearTimeout(waitTimer);
  waitTimer = setTimeout(() => {
    clickedAt = 0;
    button("重新连接");
    say("10 秒还没连上：确认这台电脑上 Kiki 开着、已经更新到最新版");
  }, WAIT_MS);
  await chrome.storage.local.set({ name, token, server: $("server").value.trim() || DEFAULT_SERVER });
  chrome.runtime.sendMessage({ type: "reconnect" });
};

function say(text) {
  $("dot").className = "dot error";
  $("status").textContent = text;
  $("status").className = "err";
}

chrome.storage.onChanged.addListener((c, area) => area === "session" && c.status && show(c.status.newValue));
load();
