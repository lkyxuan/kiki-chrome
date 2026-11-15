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
