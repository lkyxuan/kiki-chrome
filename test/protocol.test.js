import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, backoff, keyEvent, looksLikePublish, parseCall, validName } from "../src/protocol.js";

test("browser names: letters in any script, digits, - and _", () => {
  assert.ok(validName("推特-品牌号"));
  assert.ok(validName("x_brand-2"));
  assert.ok(!validName(""));
  assert.ok(!validName("has space"));
  assert.ok(!validName("a/b"));
  assert.ok(!validName("x".repeat(41)));
});

test("parseCall accepts a good call", () => {
  const c = parseCall(JSON.stringify({ type: "call", id: 7, action: "click", params: { tabId: 3, ref: 12 } }));
  assert.deepEqual(c, { id: 7, action: "click", params: { tabId: 3, ref: 12 } });
});

test("parseCall rejects what would be unsafe or ambiguous", () => {
  assert.throws(() => parseCall("{"), /bad JSON/);
  assert.throws(() => parseCall({ type: "call", id: 1, action: "rm" }), /unknown action/);
  assert.throws(() => parseCall({ type: "call", id: 1, action: "click", params: { ref: 1 } }), /needs tabId/);
  assert.throws(() => parseCall({ type: "call", id: 1, action: "open", params: {} }), /needs url/);
  assert.throws(() => parseCall({ type: "call", id: 1, action: "open", params: { url: "file:///etc/passwd" } }), /http/);
  assert.throws(() => parseCall({ type: "call", id: 1, action: "open", params: { url: "javascript:alert(1)" } }), /http/);
  assert.throws(() => parseCall({ type: "call", id: 1, action: "upload", params: { tabId: 1, ref: 2, files: ["rel.png"] } }), /absolute/);
  assert.throws(() => parseCall({ type: "call", action: "tabs" }), /missing id/);
});

test("every action that needs a tab says so", () => {
  for (const [name, spec] of Object.entries(ACTIONS)) {
    if (name === "tabs" || name === "open") assert.equal(spec.tab, false);
    else assert.equal(spec.tab, true, name);
  }
});

test("backoff doubles up to 30s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(backoff), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("keyEvent: named keys, letters, shortcuts", () => {
  assert.deepEqual(keyEvent("Enter"), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
  assert.equal(keyEvent("shift+Tab").modifiers, 8);
  const sa = keyEvent("cmd+a");
  assert.equal(sa.modifiers, 4);
  assert.deepEqual(sa.commands, ["selectAll"]);
  assert.equal(sa.text, undefined);
  assert.equal(keyEvent("b").text, "b");
  assert.equal(keyEvent("7").code, "Digit7");
  assert.throws(() => keyEvent("hyper+a"), /modifier/);
  assert.throws(() => keyEvent("F99"), /unknown key/);
});

test("publish buttons are recognised, long text is not", () => {
  for (const w of ["发布", "发送", "Post", "Reply", "发布笔记", "立即发布"]) assert.ok(looksLikePublish(w), w);
  for (const w of ["", "首页", "Posts you liked and everything else that goes on", "Following"]) assert.ok(!looksLikePublish(w), w);
});
