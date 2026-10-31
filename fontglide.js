/*!
 * FontGlide 1.0 — crossfade from fallback fonts to web fonts.
 *
 * Browsers swap a web font in the instant it finishes loading, so text visibly
 * jumps. FontGlide loads the font with the CSS Font Loading API (so the browser
 * never swaps by itself), then crossfades the text from the fallback font to
 * the new one: an invisible-until-needed overlay copy of the content is laid out
 * in the new font, the live text fades out while the overlay text fades in, and
 * the overlay is removed in the same frame the live text switches fonts.
 *
 * Usage (ES module, works from any CDN):
 *
 *   import { glide } from "https://cdn.example.com/fontglide.js";
 *
 *   glide({
 *     fonts: ["https://fonts.googleapis.com/css2?family=Lobster&display=swap"],
 *   });
 *
 * IMPORTANT: don't also load those fonts with a normal <link> or @font-face
 * rule, or the browser will swap them in itself and there is nothing to fade.
 *
 * Options
 *   fonts        Required. Array of:
 *                  - a stylesheet URL string (e.g. a Google Fonts CSS URL), or
 *                  - { css: "https://…" }, or
 *                  - { family, src, weight?, style?, stretch?, unicodeRange? }
 *                    where src is a font file URL.
 *                Only the files whose unicode-range covers the text on the
 *                page are downloaded.
 *   root         Element, selector string, or list of elements to transition.
 *                Default: document.body. Scope it to your main content if the
 *                page contains custom elements, iframes or other widgets.
 *   duration     Crossfade length in ms. Default 300.
 *   easing       CSS easing for the fade. Default "ease-in-out".
 *   fade         false = apply the font instantly, no crossfade. Default true.
 *   delay        ms to wait before requesting the font. Default 0.
 *   bypassCache  true = cache-bust the CSS and font-file requests. Default false.
 *   nonce        CSP nonce for the small <style> element FontGlide injects.
 *   onPhase      (phase, info) => void. Phases: "waiting", "loading",
 *                "loaded", "fading", "done", "error".
 *
 * glide() returns { finished, revert }
 *   finished     Promise (never rejects) resolving to
 *                { status: "done" | "error" | "reverted", families?, error? }.
 *   revert()     Stop whatever is in progress and restore the page to exactly
 *                how it was before glide() ran (fonts unregistered, inline
 *                styles restored).
 *
 * How it applies fonts: for every element that directly contains text, the new
 * family is prepended to that element's existing font stack as an inline
 * `font-family … !important`, so each element keeps its own fallbacks.
 *
 * Known limits: light DOM only (not inside shadow roots); content rendered by
 * the overlay is a clone, so avoid roots containing custom elements with
 * side effects; fixed/sticky elements inside `root` won't crossfade while the
 * page is scrolled.
 */

const STYLE_ID = "fontglide-styles";
const TEXT_ATTR = "data-fontglide-text"; // "old" = live text, "new" = overlay text
const GO_ATTR = "data-fontglide-go"; // set on root + overlay to start the fade
const CLONE_CLASS = "fontglide-clone";
const REVERTED = { status: "reverted" };

// Text inside these is never touched, and never counted when choosing font files.
const SKIP = [
  "script", "style", "noscript", "template", "textarea", "input", "select",
  "option", "svg", "canvas", "iframe", "[contenteditable]", `.${CLONE_CLASS}`,
].join(", ");

const C = `.${CLONE_CLASS}`;
const CSS = `
${C}{position:absolute!important;top:0!important;left:0!important;right:auto!important;bottom:auto!important;margin:0!important;box-sizing:border-box!important;pointer-events:none!important}
${C},${C} *,${C}::before,${C}::after,${C} *::before,${C} *::after{background:none!important;border-color:transparent!important;border-image:none!important;box-shadow:none!important;outline-color:transparent!important;backdrop-filter:none!important}
${C} *:not([${TEXT_ATTR}]){animation:none!important;transition:none!important}
${C} ::marker{color:transparent!important}
${C} img,${C} picture,${C} svg,${C} canvas,${C} video,${C} iframe,${C} object,${C} embed,${C} input,${C} textarea,${C} select{visibility:hidden!important}
[${TEXT_ATTR}]{transition:opacity var(--fontglide-duration,300ms) var(--fontglide-easing,ease-in-out)}
[${TEXT_ATTR}="new"]{opacity:0}
[${GO_ATTR}] [${TEXT_ATTR}="old"]{opacity:0}
[${GO_ATTR}] [${TEXT_ATTR}="new"]{opacity:1}
`;

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const domReady = () =>
  document.readyState !== "loading"
    ? Promise.resolve()
    : new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));

const unquote = (value) => value.replace(/^["']|["']$/g, "");
const quoteFamily = (name) => `"${name.replace(/["\\]/g, "\\$&")}"`;

// A stack of undo functions, run newest-first. Never throws.
function undoStack() {
  const fns = [];
  return {
    add: (fn) => fns.push(fn),
    run() {
      while (fns.length) {
        try { fns.pop()(); } catch { /* keep undoing */ }
      }
    },
  };
}

function ensureStyles(nonce) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  if (nonce) style.nonce = nonce;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function resolveRoots(root) {
  let list;
  if (!root) list = [document.body];
  else if (typeof root === "string") list = [...document.querySelectorAll(root)];
  else if (root instanceof Element) list = [root];
  else list = [...root];
  list = [...new Set(list.filter((el) => el instanceof Element))];
  // Drop roots nested inside another root.
  return list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
}

function textNodesOf(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue.trim() && node.parentElement && !node.parentElement.closest(SKIP)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

// Set an inline !important font-family and register how to put it back.
function setFont(el, value, undo) {
  const prevValue = el.style.getPropertyValue("font-family");
  const prevPriority = el.style.getPropertyPriority("font-family");
  el.style.setProperty("font-family", value, "important");
  undo.add(() => {
    if (prevValue) el.style.setProperty("font-family", prevValue, prevPriority);
    else el.style.removeProperty("font-family");
  });
}

/* ----------------------------------------------------- font file definitions */

function mapUrls(src, fn) {
  return src.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (_, q, url) => `url(${q}${fn(url)}${q})`);
}

function parseRanges(value) {
  if (!value) return null;
  const ranges = value
    .split(",")
    .map((token) => {
      const m = token.trim().match(/^U\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i);
      if (!m) return null;
      if (m[1].includes("?")) {
        return [parseInt(m[1].replace(/\?/g, "0"), 16), parseInt(m[1].replace(/\?/g, "f"), 16)];
      }
      const lo = parseInt(m[1], 16);
      return [lo, m[2] ? parseInt(m[2], 16) : lo];
    })
    .filter(Boolean);
  return ranges.length ? ranges : null;
}

// Does a face with these ranges cover at least one of the code points? (No ranges = covers all.)
const covers = (ranges, codePoints) =>
  !ranges || ranges.some(([lo, hi]) => { for (const cp of codePoints) if (cp >= lo && cp <= hi) return true; return false; });

function makeRule(family, src, descriptors, base, stamp) {
  const resolved = mapUrls(src, (url) => {
    if (/^data:/i.test(url)) return url;
    const u = new URL(url, base);
    if (stamp) u.searchParams.set("fontglide_bust", stamp);
    return u.href;
  });
  return { family, src: resolved, descriptors, ranges: parseRanges(descriptors.unicodeRange) };
}

function parseFontFaceRules(cssText, base, stamp) {
  const rules = [];
  const declRe = /([\w-]+)\s*:\s*((?:url\([^)]*\)|[^;])*)/g;
  for (const [, body] of cssText.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const d = {};
    for (const [, prop, value] of body.matchAll(declRe)) d[prop.toLowerCase()] = value.trim();
    if (!d["font-family"] || !d.src) continue;
    const descriptors = {};
    if (d["font-style"]) descriptors.style = d["font-style"];
    if (d["font-weight"]) descriptors.weight = d["font-weight"];
    if (d["font-stretch"]) descriptors.stretch = d["font-stretch"];
    if (d["unicode-range"]) descriptors.unicodeRange = d["unicode-range"];
    rules.push(makeRule(unquote(d["font-family"]), d.src, descriptors, base, stamp));
  }
  return rules;
}

async function fontRules(def, stamp) {
  if (typeof def === "string") def = { css: def };
  if (def && def.css) {
    const cssUrl = new URL(def.css, document.baseURI).href;
    const res = await fetch(cssUrl, { cache: stamp ? "no-store" : "default" });
    if (!res.ok) throw new Error(`Font stylesheet request failed (${res.status})`);
    const rules = parseFontFaceRules(await res.text(), cssUrl, stamp);
    if (!rules.length) throw new Error("No @font-face rules found in the font stylesheet.");
    return rules;
  }
  if (def && def.family && def.src) {
    const descriptors = {};
    for (const key of ["weight", "style", "stretch", "unicodeRange"]) {
      if (def[key] != null) descriptors[key] = String(def[key]);
    }
    const src = /url\(/i.test(def.src) ? def.src : `url("${def.src}")`;
    return [makeRule(def.family, src, descriptors, document.baseURI, stamp)];
  }
  throw new Error("Each font needs either `css` or `family` + `src`.");
}

/* --------------------------------------------------------------------- glide */

export function glide(options = {}) {
  const opts = {
    fonts: [],
    root: null,
    delay: 0,
    duration: 300,
    easing: "ease-in-out",
    fade: true,
    bypassCache: false,
    nonce: "",
    onPhase: null,
    ...options,
  };
  const undo = undoStack();
  let dead = false;

  const emit = (phase, detail = {}) => {
    if (dead || typeof opts.onPhase !== "function") return;
    try { opts.onPhase(phase, detail); } catch (err) { console.error(err); }
  };

  const revert = () => {
    dead = true;
    undo.run();
  };

  // Everything the page needs to know about one root, gathered before anything is mutated.
  function plan(root, prefix) {
    const nodes = textNodesOf(root);
    if (!nodes.length) return null;
    const parents = nodes.map((node) => node.parentElement);
    const stacks = new Map(); // element -> new font-family value
    for (const el of parents) {
      if (!stacks.has(el)) stacks.set(el, `${prefix}, ${getComputedStyle(el).fontFamily}`);
    }
    return { root, nodes, parents, stacks };
  }

  const applyNow = (stacks) => {
    for (const [el, stack] of stacks) setFont(el, stack, undo);
  };

  async function fadeRoot({ root, nodes, parents, stacks }) {
    const tmp = undoStack(); // everything temporary: spans, overlay, min-height, attributes
    undo.add(tmp.run);

    // 1. Wrap each text node so opacity can target text only (not backgrounds/borders/images).
    const spans = nodes.map((node) => {
      const span = document.createElement("span");
      span.setAttribute(TEXT_ATTR, "old");
      node.replaceWith(span);
      span.appendChild(node);
      tmp.add(() => span.replaceWith(node));
      return span;
    });

    // 2. Overlay: a copy of the root whose text elements use the new font.
    const clone = root.cloneNode(true);
    clone.classList.add(CLONE_CLASS);
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    clone.querySelectorAll("script, style, noscript, template").forEach((el) => el.remove());
    clone.querySelectorAll("iframe").forEach((el) => { el.removeAttribute("src"); el.removeAttribute("srcdoc"); });
    clone.querySelectorAll("video, audio").forEach((el) => { el.removeAttribute("autoplay"); el.setAttribute("preload", "none"); });
    clone.querySelectorAll("input, textarea, select, button").forEach((el) => {
      el.removeAttribute("name"); // avoid joining the live form / radio groups
      el.removeAttribute("form");
      el.removeAttribute("autofocus");
    });

    const cloneSpans = [...clone.querySelectorAll(`[${TEXT_ATTR}]`)];
    if (cloneSpans.length !== spans.length || !root.parentNode) {
      tmp.run(); // can't build a faithful overlay: just switch fonts
      applyNow(stacks);
      return;
    }
    cloneSpans.forEach((span, i) => {
      span.setAttribute(TEXT_ATTR, "new");
      span.parentElement.style.setProperty("font-family", stacks.get(parents[i]), "important");
    });

    // 3. Lay the overlay exactly over the root.
    const before = root.getBoundingClientRect();
    clone.style.width = `${before.width}px`;
    root.parentNode.appendChild(clone);
    tmp.add(() => clone.remove());
    const after = clone.getBoundingClientRect();
    clone.style.transform = `translate(${before.left - after.left}px, ${before.top - after.top}px)`;

    // 4. If the new layout is taller, reserve the room so the overlay never covers what follows.
    if (after.height - before.height > 1) {
      const cs = getComputedStyle(root);
      const extra = cs.boxSizing === "border-box"
        ? 0
        : ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
            .reduce((sum, key) => sum + (parseFloat(cs[key]) || 0), 0);
      const prev = root.style.minHeight;
      root.style.minHeight = `${after.height - extra}px`;
      tmp.add(() => { root.style.minHeight = prev; });
    }

    // 5. Start the crossfade: live text fades out while overlay text fades in.
    for (const el of [root, clone]) {
      el.style.setProperty("--fontglide-duration", `${opts.duration}ms`);
      el.style.setProperty("--fontglide-easing", opts.easing);
    }
    tmp.add(() => {
      root.style.removeProperty("--fontglide-duration");
      root.style.removeProperty("--fontglide-easing");
      root.removeAttribute(GO_ATTR);
    });
    void clone.offsetWidth; // flush styles so both layers start from their initial opacity
    root.setAttribute(GO_ATTR, "");
    clone.setAttribute(GO_ATTR, "");

    // 6. Wait for the fade (with a timeout in case no transition ever fires).
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        root.removeEventListener("transitionend", onEnd);
        resolve();
      };
      const onEnd = (e) => {
        if (e.propertyName === "opacity" && e.target.hasAttribute(TEXT_ATTR)) finish();
      };
      const timer = setTimeout(finish, opts.duration + 150);
      root.addEventListener("transitionend", onEnd);
    });
    if (dead) return;

    // 7. Switch the live text to the new font and drop the overlay in one synchronous step,
    //    so the browser paints a single, visually identical frame.
    applyNow(stacks);
    tmp.run();
  }

  async function run() {
    if (!opts.fonts || !opts.fonts.length) throw new Error("FontGlide: the `fonts` option is required.");
    if (typeof FontFace === "undefined" || !document.fonts) {
      throw new Error("This browser doesn't support the CSS Font Loading API.");
    }

    if (opts.delay > 0) {
      emit("waiting", { delay: opts.delay });
      await sleep(opts.delay);
      if (dead) return REVERTED;
    }

    emit("loading", { bypassCache: !!opts.bypassCache });
    const stamp = opts.bypassCache ? `${Date.now()}_${Math.random().toString(36).slice(2)}` : "";
    const [ruleLists] = await Promise.all([
      Promise.all(opts.fonts.map((def) => fontRules(def, stamp))),
      domReady(),
    ]);
    if (dead) return REVERTED;

    // Only download the font files whose unicode-range covers the text that is on the page.
    const codePoints = new Set();
    for (const root of resolveRoots(opts.root)) {
      for (const node of textNodesOf(root)) for (const ch of node.nodeValue) codePoints.add(ch.codePointAt(0));
    }
    const wanted = ruleLists.flat().filter((rule) => covers(rule.ranges, codePoints));
    if (!wanted.length) {
      emit("done", { families: [], skipped: true });
      return { status: "done", families: [] };
    }

    const faces = wanted.map((rule) => ({
      family: rule.family,
      face: new FontFace(rule.family, rule.src, rule.descriptors),
    }));
    const results = await Promise.allSettled(faces.map(({ face }) => face.load()));
    if (dead) return REVERTED;
    const ready = faces.filter((_, i) => results[i].status === "fulfilled");
    if (!ready.length) throw new Error(results[0].reason?.message || "The font file failed to load.");

    for (const { face } of ready) {
      document.fonts.add(face);
      undo.add(() => document.fonts.delete(face));
    }
    const families = [...new Set(ready.map((f) => f.family))];
    emit("loaded", { families });

    const prefix = families.map(quoteFamily).join(", ");
    const plans = resolveRoots(opts.root).map((root) => plan(root, prefix)).filter(Boolean);

    if (!opts.fade || !(opts.duration > 0)) {
      plans.forEach((p) => applyNow(p.stacks));
      emit("done", { families, instant: true });
      return { status: "done", families };
    }

    ensureStyles(opts.nonce);
    emit("fading", { duration: opts.duration });
    await Promise.all(plans.map(fadeRoot));
    if (dead) return REVERTED;
    emit("done", { families, instant: false });
    return { status: "done", families };
  }

  const finished = (async () => {
    try {
      return await run();
    } catch (error) {
      undo.run(); // roll back partial work: the fallback font simply stays
      emit("error", { error });
      return { status: "error", error };
    }
  })();

  return { finished, revert };
}

export default glide;