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

test("snapshot lists custom-element buttons (shadow-DOM label, style ignored, inline pieces joined, hidden text skipped) in page order, skips containers and plain ones", async (t) => {
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
    await p.evaluate(() => (document.querySelector("xhs-publish-btn").attachShadow({ mode: "open" }).innerHTML = "<style>:host{display:inline-block;padding:4px 12px;border-radius:8px;background:#ff2442;color:#fff}</style><span>发</span><span>布</span><span hidden>Publishing, please wait</span><span style=\"visibility:hidden\">loading</span>"));
    await p.evaluate(() => (document.querySelector("x-card").attachShadow({ mode: "open" }).innerHTML = "<div>Save</div><div>Draft</div>"));
    const r = await p.evaluate(`(${page.snapshotPage.toString()})(500)`);
    assert.deepEqual(r.elements.map((e) => [e.role, e.name]), [["textbox", "标题"], ["button", "上传图文"], ["button", "发布"], ["button", "inner"], ["button", "Save Draft"]]);
    const loc = await p.evaluate(`(${page.locate.toString()})(3)`);
    assert.equal(loc.name, "发布", "describe sees the shadow label, so Kiki's publish check fires");
  } finally {
    await browser.close();
  }
});

async function withPage(t, html, fn) {
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
    await p.setContent(html);
    await fn(p);
  } finally {
    await browser.close();
  }
}

test("snapshot lists plain-div buttons (outermost pointer only) and buttons inside open shadow roots; skips huge pointer sections", async (t) => {
  await withPage(
    t,
    `<div class="bar"><div class="submit" style="cursor:pointer;display:inline-block;padding:6px"><span>发布</span></div>
      <div style="cursor:pointer;display:inline-block"></div></div>
     <x-host style="display:block"></x-host>
     <div style="cursor:pointer;position:fixed;inset:0;z-index:-1">whole page</div>`,
    async (p) => {
      await p.evaluate(() => (document.querySelector("x-host").attachShadow({ mode: "open" }).innerHTML = "<div><button>暂存离开</button></div>"));
      const r = await p.evaluate(`(${page.snapshotPage.toString()})(500)`);
      assert.deepEqual(r.elements.map((e) => [e.role, e.name]), [["button", "发布"], ["button", "暂存离开"]]);
      const loc = await p.evaluate(`(${page.locate.toString()})(2)`);
      assert.equal(loc.name, "暂存离开", "refs reach into the shadow root");
    },
  );
});

test("findText finds a button by its words: exact over partial, the clickable ancestor, the one not covered, shadow DOM included", async (t) => {
  await withPage(
    t,
    `<a href="#n">发布笔记</a>
     <div id="hidden-under" style="position:fixed;left:0;top:200px;width:100px;height:40px;cursor:pointer">发布</div>
     <div style="position:fixed;left:0;top:200px;width:300px;height:100px;background:#fff;z-index:2">pop-up</div>
     <div id="real" style="cursor:pointer;display:inline-block;margin-top:400px;padding:8px 20px"><span>发布</span></div>
     <xhs-btn style="display:inline-block;cursor:pointer"></xhs-btn>`,
    async (p) => {
      await p.evaluate(() => (document.querySelector("xhs-btn").attachShadow({ mode: "open" }).innerHTML = "<span>确认</span>"));
      const snap = await p.evaluate(`(${page.snapshotPage.toString()})(500)`);
      const r = await p.evaluate(`(${page.findText.toString()})("发布")`);
      assert.equal(r.ref, snap.elements.length + 1, "new ref goes after the snapshot's");
      assert.equal(r.name, "发布");
      const loc = await p.evaluate(`(${page.locate.toString()})(${r.ref})`);
      assert.equal(loc.tag, "div");
      assert.equal(await p.evaluate((ref) => globalThis.__kikiRefs[ref].deref().id, r.ref), "real", "the covered one and the span inside lose to the clickable div on top");
      const s = await p.evaluate(`(${page.findText.toString()})("确认")`);
      assert.equal(s.tag, "xhs-btn", "a word in a web component's shadow root points at the component");
      const part = await p.evaluate(`(${page.findText.toString()})("笔记")`);
      assert.equal(part.tag, "a");
      const none = await p.evaluate(`(${page.findText.toString()})("没有这个")`);
      assert.match(none.error, /nothing on the page/);
    },
  );
});

test("a custom-element button stays listed inside a pointer container that has a native button (the container isn't listed)", async (t) => {
  await withPage(t, `<div style="cursor:pointer"><button>Other</button><x-tab style="display:inline-block">Publish</x-tab></div>`, async (p) => {
    const r = await p.evaluate(`(${page.snapshotPage.toString()})(500)`);
    assert.deepEqual(r.elements.map((e) => e.name), ["Other", "Publish"]);
  });
});

test("upload marking reaches a file input inside an open shadow root, and unmark clears it", async (t) => {
  await withPage(t, `<x-up style="display:block"></x-up>`, async (p) => {
    await p.evaluate(() => (document.querySelector("x-up").attachShadow({ mode: "open" }).innerHTML = `<input type="file" accept="image/*">`));
    const r = await p.evaluate(`(${page.snapshotPage.toString()})(500)`);
    const ref = r.elements.find((e) => e.role === "file").ref;
    await p.evaluate(`(${page.markRef.toString()})(${ref}, "data-ktest")`);
    assert.equal(await p.evaluate(`${page.deepQuery("data-ktest")}?.type`), "file");
    await p.evaluate(`(${page.unmarkRef.toString()})("data-ktest")`);
    assert.equal(await p.evaluate(page.deepQuery("data-ktest")), null);
  });
});

test("findText doesn't climb to a pointer toolbar that also holds other controls", async (t) => {
  await withPage(t, `<div id="bar" style="cursor:pointer"><div id="pub" style="display:inline-block;padding:4px">Publish</div><button>Other</button></div>`, async (p) => {
    const r = await p.evaluate(`(${page.findText.toString()})("Publish")`);
    assert.equal(await p.evaluate((ref) => globalThis.__kikiRefs[ref].deref().id, r.ref), "pub");
  });
});

test("pointInfo says what sits at a screenshot spot: through open shadow roots up to the clickable thing; a closed web component reads as itself", async (t) => {
  await withPage(
    t,
    `<style>body{margin:0}</style>
     <div style="height:40px"><button id="b" style="width:100px;height:40px"><span>发布</span></button></div>
     <x-open style="display:block;height:40px"></x-open>
     <div><button>Save draft</button><x-closed style="display:block;width:80px;height:40px;cursor:pointer"></x-closed></div>`,
    async (p) => {
      await p.evaluate(() => (document.querySelector("x-open").attachShadow({ mode: "open" }).innerHTML = "<div role=button style=\"height:40px\">暂存离开</div>"));
      await p.evaluate(() => (document.querySelector("x-closed").attachShadow({ mode: "closed" }).innerHTML = "<div style=\"height:40px\">发布</div>"));
      const at = (x, y) => p.evaluate(`(${page.pointInfo.toString()})(${x}, ${y})`);
      const b = await at(30, 20);
      assert.deepEqual([b.tag, b.name], ["button", "发布"], "the span inside climbs to its button");
      const o = await at(30, 60);
      assert.deepEqual([o.tag, o.name], ["div", "暂存离开"], "looks inside an open shadow root");
      const c = await p.evaluate(`(${page.pointInfo.toString()})(...(() => { const r = document.querySelector("x-closed").getBoundingClientRect(); return [r.left + 10, r.top + 10]; })())`);
      assert.equal(c.tag, "x-closed", "a closed one is only its host; Kiki asks before clicking an unnamed spot");
      assert.equal(c.name, "", "never borrows the neighbouring button's words");
      assert.ok(c.vw > 0 && c.vh > 0);
    },
  );
});

test("putFiles puts sent bytes on a file input as real files and fires change", async (t) => {
  await withPage(t, `<input type="file" multiple><div id="out"></div>`, async (p) => {
    await p.evaluate(() => {
      const i = document.querySelector("input");
      globalThis.__kikiRefs = [, new WeakRef(i), new WeakRef(document.getElementById("out"))];
      i.addEventListener("change", async () => (document.getElementById("out").textContent = [...i.files].map((f) => `${f.name}:${f.type}:${f.size}`).join(",")));
    });
    const r = await p.evaluate(`(${page.putFiles.toString()})(1, [{ name: "a.png", type: "image/png", data: "iVBORw0K" }, { name: "b.txt", data: "aGk=" }])`);
    assert.deepEqual(r, { ok: true, count: 2 });
    assert.equal(await p.textContent("#out"), "a.png:image/png:6,b.txt:application/octet-stream:2");
    const bad = await p.evaluate(`(${page.putFiles.toString()})(2, [])`);
    assert.match(bad.error, /not a file input/);
  });
});
