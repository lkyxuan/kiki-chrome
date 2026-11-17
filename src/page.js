// Functions injected into pages with chrome.scripting.executeScript.
// Each one must be self-contained: Chrome serialises the function body, so no imports or outer variables.

/**
 * List what the model can act on. Remembers each element in the extension's isolated world
 * (invisible to the page's own scripts) so later actions can find it again; nothing is written into the page.
 */
export function snapshotPage(maxText) {
  const SEL = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary", "label[for]",
    "[role=button]", "[role=link]", "[role=textbox]", "[role=checkbox]", "[role=radio]", "[role=switch]",
    "[role=tab]", "[role=menuitem]", "[role=option]", "[role=combobox]", "[contenteditable=''], [contenteditable=true]",
  ].join(",");
  // pages snapshotted by v0.1.x still carry the old marker attribute
  for (const el of document.querySelectorAll("[data-kiki-ref]")) el.removeAttribute("data-kiki-ref");
  const refs = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
  };
  const clean = (s, n = 80) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "input") return el.type === "checkbox" || el.type === "radio" || el.type === "file" ? el.type : "textbox";
    if (t === "textarea" || el.isContentEditable) return "textbox";
    if (t === "select") return "select";
    return t === "summary" || t === "label" ? t : "button";
  };
  const nameOf = (el) =>
    clean(el.getAttribute("aria-label")) ||
    clean(el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.innerText) ||
    clean(el.labels && el.labels[0]?.innerText) ||
    clean(el.innerText) ||
    clean(el.getAttribute("placeholder") || el.getAttribute("data-placeholder")) ||
    clean(el.getAttribute("title")) ||
    clean(el.querySelector?.("img[alt]")?.alt) ||
    clean(el.getAttribute("name"));
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    // file inputs are often hidden behind a styled button; keep them so uploads work
    if (!(el.type === "file" || visible(el))) continue;
    n += 1;
    refs[n] = new WeakRef(el);
    const item = { ref: n, role: roleOf(el), name: nameOf(el) };
    if ("value" in el && el.type !== "file" && el.value) item.value = clean(el.value, 200);
    else if (el.isContentEditable && el.innerText.trim()) item.value = clean(el.innerText, 200);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (el.type === "checkbox" || el.type === "radio") item.checked = !!el.checked;
    if (el.type === "file") item.accept = el.accept || "*";
    elements.push(item);
    if (n >= 400) break;
  }
  globalThis.__kikiRefs = refs;
  const text = clean(document.body?.innerText, maxText || 6000);
  return { title: document.title, url: location.href, elements, text };
}

/** Scroll the element into view and return its box in viewport CSS pixels, plus what it says. */
export function locate(ref) {
  const el = globalThis.__kikiRefs?.[Number(ref)]?.deref();
  if (!el || !el.isConnected) return { error: `no element ${ref}; take a new snapshot` };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "")
    .replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
    vw: window.innerWidth, vh: window.innerHeight,
    name, tag: el.tagName.toLowerCase(), type: el.type || "",
  };
}

/**
 * Upload needs a handle the debugger can see, so the element gets a one-off random attribute
 * for the moment of the upload; unmarkRef takes it off again right after.
 */
export function markRef(ref, attr) {
  const el = globalThis.__kikiRefs?.[Number(ref)]?.deref();
  if (!el || !el.isConnected) return { error: `no element ${ref}; take a new snapshot` };
  el.setAttribute(attr, "");
  return { ok: true };
}

export function unmarkRef(attr) {
  for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
}
