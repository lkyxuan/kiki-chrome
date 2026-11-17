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

test("snapshot lists custom-element buttons (shadow-DOM label) in page order, skips containers and plain ones", async (t) => {
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
      <x-plain style="display:block">not clickable</x-plain>`);
    await p.evaluate(() => (document.querySelector("xhs-publish-btn").attachShadow({ mode: "open" }).innerHTML = "<span>发布</span>"));
    const r = await p.evaluate(`(${page.snapshotPage.toString()})(500)`);
    assert.deepEqual(r.elements.map((e) => [e.role, e.name]), [["textbox", "标题"], ["button", "上传图文"], ["button", "发布"], ["button", "inner"]]);
    const loc = await p.evaluate(`(${page.locate.toString()})(3)`);
    assert.equal(loc.name, "发布", "describe sees the shadow label, so Kiki's publish check fires");
  } finally {
    await browser.close();
  }
});
