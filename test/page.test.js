// The injected functions must not reference anything outside their own body:
// Chrome serialises them with Function.prototype.toString.
import test from "node:test";
import assert from "node:assert/strict";
import * as page from "../src/page.js";

test("injected functions are self-contained", () => {
  for (const [name, fn] of Object.entries(page)) {
    const rebuilt = new Function(`return (${fn.toString()})`)();
    assert.equal(typeof rebuilt, "function", name);
  }
});

test("snapshot lists custom-element buttons (shadow-DOM label, style ignored, inline pieces joined) in page order, skips containers and plain ones", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return t.skip("playwright not installed");
  }
  const browser = await chromium.launch().catch(() => undefined);
  if (!browser) return t.skip("no chromium");
  try {
    const p = await browser.newPage();
    await p.setContent(`<input placeholder="标题">
      <x-tab style="cursor:pointer;display:inline-block">上传图文</x-tab>
      <xhs-publish-btn style="cursor:pointer;display:inline-block;width:80px;height:30px"></xhs-publish-btn>
      <x-wrap style="cursor:pointer;display:block"><button>inner</button></x-wrap>
      <x-plain style="display:block">not clickable</x-plain>
      <x-card style="cursor:pointer;display:inline-block"></x-card>`);
    await p.evaluate(() => (document.querySelector("xhs-publish-btn").attachShadow({ mode: "open" }).innerHTML = "<style>:host{display:inline-block;padding:4px 12px;border-radius:8px;background:#ff2442;color:#fff}</style><span>发</span><span>布</span>"));
    await p.evaluate(() => (document.querySelector("x-card").attachShadow({ mode: "open" }).innerHTML = "<div>Save</div><div>Draft</div>"));
    const r = await p.evaluate(`(${page.snapshotPage.toString()})(500)`);
    assert.deepEqual(r.elements.map((e) => [e.role, e.name]), [["textbox", "标题"], ["button", "上传图文"], ["button", "发布"], ["button", "inner"], ["button", "Save Draft"]]);
    const loc = await p.evaluate(`(${page.locate.toString()})(3)`);
    assert.equal(loc.name, "发布", "describe sees the shadow label, so Kiki's publish check fires");
  } finally {
    await browser.close();
  }
});
