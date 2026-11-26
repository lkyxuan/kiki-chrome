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
  // visible text of a shadow root: skip <style>/<script>/<template>, whose text isn't rendered
  const shadowText = (el) => {
    if (!el.shadowRoot) return "";
    const w = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_TEXT);
    // join inline pieces as-is ("发"+"布"), put a space only between block-level pieces
    const inl = (e) => !e || getComputedStyle(e).display.startsWith("inline");
    let out = "", prev;
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const p = t.parentElement;
      if (p?.closest("style, script, template")) continue;
      if (p?.checkVisibility && !p.checkVisibility({ visibilityProperty: true })) continue; // hidden loading text, alternate labels
      if (prev !== undefined && prev !== p && !(inl(p) && inl(prev))) out += " ";
      out += t.data;
      prev = p;
    }
    return out;
  };
  const nameOf = (el) =>
    clean(el.getAttribute("aria-label")) ||
    clean(el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.innerText) ||
    clean(el.labels && el.labels[0]?.innerText) ||
    clean(el.innerText) ||
    clean(el.getAttribute("placeholder") || el.getAttribute("data-placeholder")) ||
    clean(el.getAttribute("title")) ||
    clean(el.querySelector?.("img[alt]")?.alt) ||
    clean(el.getAttribute("name")) ||
    clean(shadowText(el)); // a custom element's label often lives in its shadow DOM
  // things that act as buttons without saying so: custom elements (<xhs-publish-btn>) and plain <div>/<span>
  // with a click handler. Take the outermost element with a pointer cursor (the cursor is inherited, so its
  // children have it too) that has nothing clickable of its own inside and isn't a whole page section.
  const up = (el) => el.parentElement || el.getRootNode()?.host || null;
  const area = innerWidth * innerHeight;
  const memo = new Map();
  const clickable = (el) => {
    if (!memo.has(el)) memo.set(el, isClickable(el));
    return memo.get(el);
  };
  const isClickable = (el) => {
    if (!visible(el) || getComputedStyle(el).cursor !== "pointer") return false;
    const parent = up(el);
    // under a pointer parent: a plain element only inherited the cursor; a custom element is skipped only if
    // that parent gets listed itself (a pointer container with a native button inside doesn't, so keep it)
    if (parent && parent.nodeType === 1 && getComputedStyle(parent).cursor === "pointer" && (!el.tagName.includes("-") || clickable(parent))) return false;
    if (el.querySelector(SEL) || el.shadowRoot?.querySelector?.(SEL)) return false;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > area * 0.25) return false;
    return el.tagName.includes("-") || !!nameOf(el); // a plain div needs words on it to be worth listing
  };
  const elements = [];
  let n = 0;
  // one walk in document order, so refs keep the page's reading order; open shadow roots are walked too
  // (buttons that live inside a web component are invisible to document.querySelectorAll)
  const visit = (el) => {
    const hit = el.matches(SEL);
    if (!hit && !clickable(el)) return;
    // file inputs are often hidden behind a styled button; keep them so uploads work
    if (hit && !(el.type === "file" || visible(el))) return;
    n += 1;
    refs[n] = new WeakRef(el);
    const item = { ref: n, role: roleOf(el), name: nameOf(el) };
    if ("value" in el && el.type !== "file" && el.value) item.value = clean(el.value, 200);
    else if (el.isContentEditable && el.innerText.trim()) item.value = clean(el.innerText, 200);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (el.type === "checkbox" || el.type === "radio") item.checked = !!el.checked;
    if (el.type === "file") item.accept = el.accept || "*";
    elements.push(item);
  };
  const walk = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode; el && n < 400; el = walker.nextNode()) {
      if (el.nodeType !== 1) continue;
      visit(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document.body || document.documentElement);
  globalThis.__kikiRefs = refs;
  const text = clean(document.body?.innerText, maxText || 6000);
  return { title: document.title, url: location.href, elements, text };
}

/**
 * Find what the user sees by its words ("发布", "Post") when the list from snapshotPage doesn't have it:
 * searches the whole page including open shadow roots, prefers an exact match, then the shortest text that
 * contains it, and among those the one on top at its centre (not covered by a pop-up). The hit is added to the
 * refs, so describe / click work on it like on any other element.
 */
export function findText(words) {
  const want = String(words || "").replace(/\s+/g, " ").trim();
  if (!want) return { error: "find needs text" };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
  };
  // the words an element shows: its own text, or (a web component) the text in its shadow root
  const said = (el) => {
    const own = el.shadowRoot ? [...el.shadowRoot.querySelectorAll("*")].filter((x) => !x.closest("style, script, template") && x.children.length === 0).map((x) => x.textContent).join("") : "";
    return String(el.innerText || el.value || el.getAttribute("aria-label") || own || "").replace(/\s+/g, " ").trim();
  };
  const onTop = (el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return true; // off screen: can't tell, click will scroll it in
    let top = document.elementFromPoint(cx, cy);
    while (top?.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === top) break;
      top = inner;
    }
    for (let x = top; x; x = x.parentElement || x.getRootNode()?.host) if (x === el) return true;
    return false;
  };
  const exact = [], partial = [];
  const walk = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = w.currentNode; el; el = w.nextNode()) {
      if (el.nodeType !== 1) continue;
      if (el.shadowRoot) walk(el.shadowRoot);
      if (/^(SCRIPT|STYLE|TEMPLATE|HEAD|HTML|BODY)$/.test(el.tagName) || !visible(el)) continue;
      const t = said(el);
      if (!t || t.length > 200) continue;
      if (t === want) exact.push(el);
      else if (t.includes(want)) partial.push({ el, len: t.length });
    }
  };
  walk(document.body || document.documentElement);
  // smallest box first: the button itself, not the toolbar around it
  const size = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  let pool = exact.sort((a, b) => size(a) - size(b));
  if (!pool.length) {
    const best = Math.min(...partial.map((p) => p.len));
    pool = partial.filter((p) => p.len === best).map((p) => p.el).sort((a, b) => size(a) - size(b));
  }
  if (!pool.length) return { error: `nothing on the page says "${want}"` };
  // a text node inside the button: climb to the element that takes the click (a button, a link, or the outermost pointer)
  const SEL = "a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],input,label,summary";
  const target = (el) => {
    const hit = el.closest?.(SEL);
    if (hit) return hit;
    // a container that also holds other controls (a toolbar) isn't this button: stop below it
    const others = (x) => [...x.querySelectorAll(SEL), ...(x.shadowRoot ? x.shadowRoot.querySelectorAll(SEL) : [])].some((c) => !c.contains(el) && !el.contains(c));
    let best = el;
    for (let x = el, i = 0; x && x.nodeType === 1 && i < 6; x = x.parentElement || x.getRootNode()?.host, i++) {
      if (x !== el && others(x)) break;
      if (x.matches?.(SEL)) return x;
      if (getComputedStyle(x).cursor === "pointer") best = x;
      else if (best !== el) break;
    }
    return best;
  };
  const el = target(pool.find(onTop) || pool[0]);
  const refs = globalThis.__kikiRefs || (globalThis.__kikiRefs = []);
  const ref = Math.max(refs.length, 1);
  refs[ref] = new WeakRef(el);
  return { ref, name: said(el).slice(0, 80), tag: el.tagName.toLowerCase(), matches: exact.length || pool.length };
}

/** Scroll the element into view and return its box in viewport CSS pixels, plus what it says. */
export function locate(ref) {
  const shadowText = (el) => {
    if (!el.shadowRoot) return "";
    const w = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_TEXT);
    // join inline pieces as-is ("发"+"布"), put a space only between block-level pieces
    const inl = (e) => !e || getComputedStyle(e).display.startsWith("inline");
    let out = "", prev;
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const p = t.parentElement;
      if (p?.closest("style, script, template")) continue;
      if (p?.checkVisibility && !p.checkVisibility({ visibilityProperty: true })) continue; // hidden loading text, alternate labels
      if (prev !== undefined && prev !== p && !(inl(p) && inl(prev))) out += " ";
      out += t.data;
      prev = p;
    }
    return out;
  };
  const el = globalThis.__kikiRefs?.[Number(ref)]?.deref();
  if (!el || !el.isConnected) return { error: `no element ${ref}; take a new snapshot` };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || shadowText(el) || "")
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
  // the element may sit inside an open shadow root, which querySelectorAll doesn't reach
  const sweep = (root) => {
    for (const el of root.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) sweep(el.shadowRoot);
  };
  sweep(document);
}

/** Expression for the debugger to find the marked element, looking into open shadow roots too. */
export const deepQuery = (attr) =>
  `(function f(root){const hit=root.querySelector(${JSON.stringify(`[${attr}]`)});if(hit)return hit;for(const el of root.querySelectorAll("*")){if(el.shadowRoot){const x=f(el.shadowRoot);if(x)return x}}return null})(document)`;
