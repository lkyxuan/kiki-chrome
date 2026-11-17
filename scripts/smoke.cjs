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
<p id=out></p><p id=out2></p>
<script>window.seen={keys:0,moves:0,trusted:true};
addEventListener("keydown",e=>{seen.keys++;seen.trusted&&=e.isTrusted},true);
addEventListener("mousemove",e=>{seen.moves++;seen.trusted&&=e.isTrusted},true);
addEventListener("click",e=>{seen.trusted&&=e.isTrusted},true);</script>`;

(async () => {
  const web = http.createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(PAGE); }).listen(8711);
  const wss = new WebSocketServer({ port: 8712, path: "/ext" });
  let sock, nextId = 1; const pending = new Map(); let helloMsg;
  const connected = new Promise((res) => wss.on("connection", (s) => {
    s.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.type === "hello" && m.token === "bad") return s.close(4001, "pairing code refused");
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
  // human-like input: real key presses and a gliding mouse, all trusted, and nothing written into the page
  const human = await call("eval", { tabId, expression: "JSON.stringify({...seen, marked: [...document.querySelectorAll('*')].filter(e => [...e.attributes].some(a => a.name.startsWith('data-k'))).length})" });
  const h = JSON.parse(human.result.value);
  const humanOk = h.trusted && h.keys >= 4 && h.moves >= 6 && h.marked === 0;
  console.log("human input:", JSON.stringify(h), humanOk ? "OK" : "FAIL");
  if (!humanOk) process.exitCode = 1;
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
  // popup: clicking 连接 shows progress, then 连上了 and closes; a wrong code says so and offers 重新连接
  const extId = sw.url().split("/")[2];
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.fill("#name", "浏览器3"); await pop.fill("#token", "abc");
  const closed = pop.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
  await pop.click("#save");
  const sawOk = await pop.waitForFunction(() => document.getElementById("save").textContent.includes("连上了"), null, { timeout: 5000 }).then(() => true, () => false);
  console.log("popup connected:", sawOk ? "OK" : "FAIL", "| closed itself:", (await closed) ? "OK" : "no (tab not opened by script)");
  if (!sawOk) process.exitCode = 1;
  const pop2 = await ctx.newPage();
  await pop2.goto(`chrome-extension://${extId}/popup.html`);
  await pop2.fill("#token", "bad"); await pop2.click("#save");
  const sawErr = await pop2.waitForFunction(() => document.getElementById("status").textContent.includes("配对码不对") && document.getElementById("save").textContent === "重新连接", null, { timeout: 5000 }).then(() => true, () => false);
  console.log("popup bad code:", sawErr ? "OK" : "FAIL", "|", await pop2.textContent("#status"));
  if (!sawErr) process.exitCode = 1;
  await ctx.close();

  // approve in Kiki: a fresh install with no name and no code asks, waits, then keeps the key Kiki gives it
  const wss2 = new WebSocketServer({ port: 8713, path: "/ext" });
  const hellos = [];
  let last;
  wss2.on("connection", (s) => s.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.type !== "hello") return;
    hellos.push(m); last = s;
    if (m.key === "K1") s.send(JSON.stringify({ type: "welcome", name: m.name }));
    else s.send(JSON.stringify({ type: "pending", name: "浏览器7" }));
  }));
  const until = async (f, ms = 8000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 100)); } return true; };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "kc-"));
  const ctx2 = await chromium.launchPersistentContext(dir2, { headless: true, channel: "chromium", args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw2] = ctx2.serviceWorkers(); if (!sw2) sw2 = await ctx2.waitForEvent("serviceworker");
  await sw2.evaluate(() => chrome.storage.local.set({ server: "ws://127.0.0.1:8713/ext" }));
  const asked = await until(() => hellos.length >= 1);
  const h1 = hellos[0] || {};
  const askOk = asked && !h1.token && !h1.key && /^[A-Za-z0-9_-]{8,64}$/.test(h1.install || "");
  console.log("asks without code:", JSON.stringify(h1), askOk ? "OK" : "FAIL");
  const waiting = await until(async () => (await sw2.evaluate(() => chrome.storage.session.get("status"))).status?.state === "waiting");
  const pop3 = await ctx2.newPage();
  await pop3.goto(`chrome-extension://${sw2.url().split("/")[2]}/popup.html`);
  const popWait = await until(async () => (await pop3.textContent("#status")).includes("同意「浏览器7」"));
  console.log("waiting for approval:", waiting && popWait ? "OK" : "FAIL", "|", await pop3.textContent("#status"));
  last.send(JSON.stringify({ type: "welcome", name: "浏览器7", key: "K1" }));
  const kept = await until(async () => (await sw2.evaluate(() => chrome.storage.local.get(["key", "name"]))).key === "K1");
  const popOk = await until(async () => (await pop3.textContent("#status")).includes("这个浏览器叫「浏览器7」"));
  last.close(1001, "Kiki restarting"); // Kiki restarts: the extension comes back on its own, with the key
  const rekeyed = await until(() => hellos.some((m) => m.key === "K1" && m.name === "浏览器7" && m.install === h1.install));
  const popName = await pop3.inputValue("#name"); // popup open while approved: shows Kiki's name, so saving keeps it
  const approveOk = kept && popOk && rekeyed && popName === "浏览器7";
  console.log("approved, key kept, reconnects with key:", approveOk ? "OK" : "FAIL", JSON.stringify({ kept, popOk, rekeyed, popName, hellos: hellos.length }));
  // refused in Kiki: stops asking until 连接 is clicked
  await sw2.evaluate(() => chrome.storage.local.remove("key"));
  last.close(1001, "Kiki restarting");
  await until(() => hellos.length >= 3 && !hellos.at(-1).key);
  last.close(4005, "refused in Kiki");
  const refused = await until(async () => (await sw2.evaluate(() => chrome.storage.local.get("refused"))).refused === 4005);
  const n = hellos.length;
  await sw2.evaluate(() => chrome.storage.local.set({ server: "ws://127.0.0.1:8713/ext?again" })); // forces a reconnect attempt
  await new Promise((r) => setTimeout(r, 1500));
  const quiet = hellos.length === n;
  console.log("refused stays quiet:", refused && quiet ? "OK" : "FAIL");
  // removed in Kiki (4003): drops the key and stays quiet too, until 连接 is clicked
  await sw2.evaluate(() => chrome.storage.local.set({ refused: 0, key: "K1", name: "浏览器7" }));
  await sw2.evaluate(() => chrome.storage.local.set({ server: "ws://127.0.0.1:8713/ext" }));
  await until(() => hellos.at(-1)?.key === "K1");
  last.close(4003, "removed in Kiki");
  const removed = await until(async () => { const v = await sw2.evaluate(() => chrome.storage.local.get(["refused", "key"])); return v.refused === 4003 && !v.key; });
  const n2 = hellos.length;
  await new Promise((r) => setTimeout(r, 1500));
  await sw2.evaluate(() => chrome.storage.local.set({ server: "ws://127.0.0.1:8713/ext?again2" }));
  await new Promise((r) => setTimeout(r, 1500));
  const quiet2 = hellos.length === n2;
  console.log("removed stays quiet:", removed && quiet2 ? "OK" : "FAIL");
  if (!askOk || !waiting || !popWait || !approveOk || !refused || !quiet || !removed || !quiet2) process.exitCode = 1;
  await ctx2.close(); wss2.close();
  wss.close(); web.close(); process.exit(process.exitCode || 0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
