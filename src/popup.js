import { DEFAULT_SERVER, validName } from "./protocol.js";

const $ = (id) => document.getElementById(id);
const LABEL = { connected: "已连上 Kiki", connecting: "正在连接…", error: "连不上", off: "未设置" };

async function load() {
  const s = await chrome.storage.local.get(["name", "token", "server"]);
  $("name").value = s.name || "";
  $("token").value = s.token || "";
  $("server").value = s.server || "";
  $("server").placeholder = DEFAULT_SERVER;
  show((await chrome.storage.session.get("status")).status);
}

function show(st) {
  const state = st?.state || "off";
  $("dot").className = `dot ${state}`;
  $("status").textContent = LABEL[state] + (st?.detail ? `：${st.detail}` : "");
}

$("save").onclick = async () => {
  const name = $("name").value.trim();
  if (!validName(name)) {
    $("status").textContent = "名字只用文字、数字、- 和 _，最多 40 个字";
    return;
  }
  await chrome.storage.local.set({ name, token: $("token").value.trim(), server: $("server").value.trim() || DEFAULT_SERVER });
  chrome.runtime.sendMessage({ type: "reconnect" });
};

chrome.storage.onChanged.addListener((c, area) => area === "session" && c.status && show(c.status.newValue));
load();
