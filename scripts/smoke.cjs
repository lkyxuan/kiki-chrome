// Real-browser check: loads the extension into Playwright Chromium, plays Kiki over a local WebSocket
// and runs every action against a test page. Run: npm run smoke
const { chromium } = require("playwright");
const { WebSocketServer } = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const EXT = path.resolve(__dirname, "..");

const PAGE = `<!doctype html><title>Test page</title>
<input id=t placeholder="写点什么"><button onclick="document.getElementById('out').textContent='got:'+document.getElementById('t').value">发布</button>
<div contenteditable=true aria-label="正文"></div>
<input type=file id=f style="display:none" onchange="document.getElementById('out2').textContent='file:'+this.files[0].name">
<p id=out></p><p id=out2></p>`;

(async () => {
  const web = http.createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(PAGE); }).listen(8711);
  const wss = new WebSocketServer({ port: 8712, path: "/ext" });
  let sock, nextId = 1; const pending = new Map(); let helloMsg;
  const connected = new Promise((res) => wss.on("connection", (s) => {
    s.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.type === "hello") { helloMsg = m; sock = s; s.send(JSON.stringify({ type: "welcome", name: "test" })); res(); }
      if (m.type === "result") { pending.get(m.id)(m); pending.delete(m.id); }
    });
  }));
  const call = (action, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); sock.send(JSON.stringify({ type: "call", id, action, params })); });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-"));
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, channel: "chromium", args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
  await sw.evaluate(() => chrome.storage.local.set({ name: "浏览器1", token: "abc", server: "ws://127.0.0.1:8712/ext" }));
  await Promise.race([connected, new Promise((_, j) => setTimeout(() => j(new Error("no connect")), 10000))]);
  console.log("hello:", JSON.stringify(helloMsg));
  const status = await sw.evaluate(() => chrome.storage.session.get("status"));
  console.log("status:", JSON.stringify(status));

  const opened = await call("open", { url: "http://127.0.0.1:8711/" }); console.log("open:", JSON.stringify(opened));
  const tabId = opened.result.tabId;
  const snap = await call("snapshot", { tabId }); console.log("snapshot:", JSON.stringify(snap.result.elements));
  const box = snap.result.elements.find((e) => e.name === "写点什么").ref;
  const btn = snap.result.elements.find((e) => e.name === "发布").ref;
  const file = snap.result.elements.find((e) => e.role === "file").ref;
  const ce = snap.result.elements.find((e) => e.name === "正文").ref;
  console.log("describe:", JSON.stringify(await call("describe", { tabId, ref: btn })));
  console.log("type:", JSON.stringify(await call("type", { tabId, ref: box, text: "你好 Kiki" })));
  console.log("type ce:", JSON.stringify(await call("type", { tabId, ref: ce, text: "正文内容" })));
  console.log("click:", JSON.stringify(await call("click", { tabId, ref: btn })));
  const img = path.join(dir, "pic.png"); fs.writeFileSync(img, "x");
  console.log("upload:", JSON.stringify(await call("upload", { tabId, ref: file, files: [img] })));
  console.log("key:", JSON.stringify(await call("key", { tabId, key: "cmd+a" })));
  console.log("eval:", JSON.stringify(await call("eval", { tabId, expression: "document.getElementById('out').textContent + ' | ' + document.getElementById('out2').textContent + ' | ' + document.querySelector('[contenteditable]').innerText" })));
  const shot = await call("screenshot", { tabId }); console.log("screenshot bytes:", shot.ok && shot.result.data.length);
  console.log("tabs:", JSON.stringify(await call("tabs")));
  // a tab we did not open must be refused
  const other = await ctx.newPage(); await other.goto("http://127.0.0.1:8711/");
  const otherId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://127.0.0.1:8711/*" })).find((t) => t.groupId === -1).id);
  console.log("foreign tab:", JSON.stringify(await call("click", { tabId: otherId, ref: 1 })));
  console.log("bad action:", JSON.stringify(await call("rm", {})));
  console.log("close:", JSON.stringify(await call("close", { tabId })));
  // saving in the popup fires the storage listener and a reconnect message together: must end with one live socket
  await sw.evaluate(async () => { await chrome.storage.local.set({ name: "浏览器2" }); chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {}); });
  await new Promise((r) => setTimeout(r, 2500));
  const live = [...wss.clients].filter((c) => c.readyState === 1).length;
  console.log("live sockets after save:", live, live === 1 ? "OK" : "FAIL");
  if (live !== 1) process.exitCode = 1;
  await ctx.close(); wss.close(); web.close(); process.exit(process.exitCode || 0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
