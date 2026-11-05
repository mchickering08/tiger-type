// Tiger Type content script: finds the text box you're typing in, sends its text
// to the backend, and draws underlines + suggestion cards over the page.
//
// How the underlines line up:
//  - <textarea>/<input>: we can't measure text inside them directly, so we build
//    an invisible "mirror" div with the exact same font/padding/width, put the
//    same text in it, and measure that instead.
//  - contenteditable (Gmail, most rich editors): we walk the real text nodes and
//    measure them with Range.getClientRects().
// Everything we draw lives in a shadow root so the page's CSS can't mess with it.

(() => {
  if (window.__tigerTypeLoaded) return;
  window.__tigerTypeLoaded = true;

  const DEBOUNCE_MS = 700;
  const MAX_CHARS = 20000;
  const COLORS = { spelling: "#F26B1D", grammar: "#2F6FEB", style: "#6B6B6B" };
  const LABELS = { spelling: "Spelling", grammar: "Grammar", style: "Style" };

  let siteActive = null; // null = unknown yet
  const checkers = new WeakMap();
  const allCheckers = new Set();

  // Tell the background worker how many issues this frame has, for the popup.
  let countsTimer = 0;
  function reportCounts() {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(() => {
      const counts = { spelling: 0, grammar: 0, style: 0 };
      for (const c of allCheckers) {
        if (!c.el.isConnected) { allCheckers.delete(c); continue; }
        for (const m of c.matches) counts[m.kind] = (counts[m.kind] || 0) + 1;
      }
      try { chrome.runtime.sendMessage({ type: "counts", counts }); } catch {}
    }, 300);
  }
  let current = null; // the Checker for the focused field
  const ignored = new Set(); // "rule|text" pairs the student dismissed this session

  // ---------- overlay root ----------

  const host = document.createElement("tigertype-root");
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  // Built with createElement, not innerHTML: Gmail and other Google sites block innerHTML
  // ("Trusted Types"), which would stop the overlay from ever appearing.
  const styleEl = document.createElement("style");
  styleEl.textContent = `
      .u { position:fixed; height:2px; border-radius:1px; pointer-events:none; }
      .mirror { position:fixed; visibility:hidden; pointer-events:none; overflow:hidden; margin:0; }
      .u.dotted { height:0; background:none !important; border-top:2px dotted #6B6B6B; }
      .badge {
        position:fixed; min-width:22px; height:22px; padding:0 6px; box-sizing:border-box; border-radius:11px; pointer-events:auto;
        display:flex; align-items:center; justify-content:center; cursor:default;
        font:800 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#111;
        box-shadow:0 1px 3px rgba(0,0,0,.25); transition:opacity .15s; user-select:none;
      }
      .card {
        position:fixed; width:320px; box-sizing:border-box; pointer-events:auto; background:#fff; color:#111;
        border:1px solid #E7E5E2; border-radius:14px; box-shadow:0 10px 30px rgba(17,17,17,.12);
        font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:16px 18px;
        display:flex; flex-direction:column; gap:12px; text-align:left;
      }
      .kind { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; color:#5C5C5C; text-transform:uppercase; letter-spacing:.06em; }
      .dot { width:8px; height:8px; border-radius:50%; }
      .reps { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
      .rep {
        border:0; background:#111; color:#fff; border-radius:9px; padding:8px 14px; min-height:36px;
        font-weight:700; font-size:15px; line-height:1.2; font-family:inherit; cursor:pointer;
      }
      .rep:hover { background:#333; }
      .orig { text-decoration:line-through; color:#6B6B6B; }
      .arrow { display:block; }
      .line { height:1px; background:#EFEDEA; }
      .foot { display:flex; justify-content:space-between; align-items:center; }
      .note { font-size:12px; color:#5C5C5C; }
      .ignore { border:0; background:none; color:#5C5C5C; font-size:14px; font-weight:600; font-family:inherit; cursor:pointer; padding:6px 4px; }
      .ignore:hover { color:#111; }
    `;
  shadow.appendChild(styleEl);
  for (const [id, cls] of [["lines", ""], ["badge", "badge"], ["card", "card"]]) {
    const d = document.createElement("div");
    d.id = id;
    if (cls) d.className = cls;
    if (id !== "lines") d.style.display = "none";
    shadow.appendChild(d);
  }
  const linesEl = shadow.getElementById("lines");
  const badgeEl = shadow.getElementById("badge");
  const cardEl = shadow.getElementById("card");

  function mountRoot() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // ---------- which elements we check ----------

  function editableRoot(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.closest('[data-gramm="false"],[data-tigertype="off"]')) return null;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return el.readOnly || el.disabled ? null : el;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return (t === "text" || t === "search") && !el.readOnly && !el.disabled ? el : null;
    }
    if (el.isContentEditable) {
      let root = el;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    return null;
  }

  const CODE_EDITORS = '.CodeMirror,.cm-editor,.monaco-editor,.ace_editor,[data-enable-grammarly="false"]';

  function wantsChecking(el) {
    // Skip code editors. Don't trust spellcheck="false" on rich editors: Gmail sets it
    // on the compose box because it runs its own spellcheck.
    if (el.closest(CODE_EDITORS)) return false;
    if (el.tagName === "INPUT" && el.getAttribute("spellcheck") === "false") return false;
    return true;
  }

  // ---------- text extraction ----------

  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TR|TABLE|SECTION|ARTICLE)$/;

  // For contenteditable: returns { text, segs } where segs map string offsets back to text nodes.
  function readEditable(root) {
    let text = "";
    const segs = [];
    const walk = (node) => {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          segs.push({ node: n, start: text.length, end: text.length + n.data.length });
          text += n.data;
        } else if (n.nodeType === 1) {
          if (n.tagName === "BR") { text += "\n"; continue; }
          if (n.getAttribute("contenteditable") === "false") continue;
          const block = BLOCK.test(n.tagName);
          if (block && text && !text.endsWith("\n")) text += "\n";
          walk(n);
          if (block && text && !text.endsWith("\n")) text += "\n";
        }
      }
    };
    walk(root);
    return { text, segs };
  }

  function pointAt(segs, offset, preferEnd) {
    for (const s of segs) {
      if (offset > s.start && offset < s.end) return [s.node, offset - s.start];
      if (offset === s.start && !preferEnd) return [s.node, 0];
      if (offset === s.end && preferEnd) return [s.node, s.node.data.length];
    }
    for (const s of segs) if (offset >= s.start && offset <= s.end) return [s.node, offset - s.start];
    return null;
  }

  function rangeFor(segs, start, end) {
    const a = pointAt(segs, start, false);
    const b = pointAt(segs, end, true);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
    } catch {
      return null;
    }
    return r;
  }

  // ---------- mirror for textarea/input ----------

  const MIRROR_PROPS = [
    "boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch",
    "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textTransform", "tabSize",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle", "direction",
  ];

  function mirrorRects(el, matches) {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const m = document.createElement("div");
    m.className = "mirror";
    for (const p of MIRROR_PROPS) m.style[p] = cs[p];
    const isInput = el.tagName === "INPUT";
    m.style.whiteSpace = isInput ? "pre" : "pre-wrap";
    m.style.overflowWrap = isInput ? "normal" : "break-word";
    m.style.borderColor = "transparent";
    m.style.top = box.top + "px";
    m.style.left = box.left + "px";
    // Leave out the scrollbar so lines wrap at the same spot as the real textarea.
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const scrollbar = isInput ? 0 : Math.max(0, el.offsetWidth - el.clientWidth - bl - br);
    m.style.width = (box.width - scrollbar) + "px";
    m.style.height = "auto";
    if (isInput) {
      // Inputs vertically center their single line.
      m.style.height = box.height + "px";
      m.style.lineHeight = cs.lineHeight === "normal" ? (el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) + "px" : cs.lineHeight;
    }
    const node = document.createTextNode(el.value + "​");
    m.appendChild(node);
    shadow.appendChild(m);

    const out = matches.map((mt) => {
      const r = document.createRange();
      try {
        r.setStart(node, mt.offset);
        r.setEnd(node, Math.min(mt.offset + mt.length, el.value.length));
      } catch {
        return [];
      }
      return Array.from(r.getClientRects()).map((rc) => ({
        left: rc.left - el.scrollLeft,
        right: rc.right - el.scrollLeft,
        top: rc.top - el.scrollTop,
        bottom: rc.bottom - el.scrollTop,
      }));
    });
    m.remove();
    return out;
  }

  // ---------- Checker: one per text field ----------

  class Checker {
    constructor(el) {
      this.el = el;
      this.plain = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
      this.matches = [];
      this.hits = [];
      this.timer = 0;
      this.state = "idle"; // idle | checking | done | error | toolong
      this.lastText = null;
      this.onInput = () => this.schedule();
      el.addEventListener("input", this.onInput);
      el.spellcheck = false; // avoid double squiggles with Chrome's own
    }

    getText() {
      return this.plain ? this.el.value : readEditable(this.el).text;
    }

    schedule() {
      clearTimeout(this.timer);
      this.matches = [];
      this.render();
      this.timer = setTimeout(() => this.run(), DEBOUNCE_MS);
    }

    async run() {
      const text = this.getText();
      if (text === this.lastText && this.state === "done") return this.render();
      if (!text.trim()) {
        this.lastText = text;
        this.matches = [];
        this.state = "done";
        return this.render();
      }
      if (text.length > MAX_CHARS) {
        this.state = "toolong";
        return this.render();
      }
      this.state = "checking";
      this.render();
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: "check", text });
      } catch {
        res = { ok: false };
      }
      if (this.getText() !== text) return; // they kept typing; a newer check is coming
      this.lastText = text;
      if (!res || !res.ok) {
        this.state = "error";
        this.matches = [];
      } else if (res.enabled === false) {
        this.state = "idle";
        this.matches = [];
        siteActive = false;
      } else {
        this.state = "done";
        this.matches = res.matches.filter((m) => !ignored.has(m.rule + "|" + m.text));
      }
      this.render();
    }

    rectsFor() {
      if (this.plain) return mirrorRects(this.el, this.matches);
      const { segs } = readEditable(this.el);
      return this.matches.map((m) => {
        const r = rangeFor(segs, m.offset, m.offset + m.length);
        return r ? Array.from(r.getClientRects()) : [];
      });
    }

    render() {
      reportCounts();
      if (current !== this) return;
      linesEl.textContent = "";
      this.hits = [];
      if (!this.el.isConnected) return hideAll();

      const box = this.el.getBoundingClientRect();
      const cs = getComputedStyle(this.el);
      const clip = {
        left: box.left + (parseFloat(cs.borderLeftWidth) || 0),
        right: box.right - (parseFloat(cs.borderRightWidth) || 0),
        top: box.top + (parseFloat(cs.borderTopWidth) || 0),
        bottom: box.bottom - (parseFloat(cs.borderBottomWidth) || 0),
      };

      if (this.matches.length) {
        const all = this.rectsFor();
        const frag = document.createDocumentFragment();
        this.matches.forEach((m, i) => {
          for (const rc of all[i] || []) {
            if (rc.width === 0 && rc.right - rc.left === 0) continue;
            const y = rc.bottom - 1;
            if (y < clip.top || y > clip.bottom) continue;
            const left = Math.max(rc.left, clip.left);
            const right = Math.min(rc.right, clip.right);
            if (right <= left) continue;
            const u = document.createElement("div");
            u.className = m.kind === "style" ? "u dotted" : "u";
            u.style.cssText = `left:${left}px;top:${y}px;width:${right - left}px;background:${COLORS[m.kind] || COLORS.grammar}`;
            frag.appendChild(u);
            this.hits.push({ left, right, top: rc.top, bottom: rc.bottom + 3, index: i });
          }
        });
        linesEl.appendChild(frag);
      }
      this.renderBadge(box);
    }

    renderBadge(box) {
      if (box.width < 120 || box.height < 24 || box.bottom < 0 || box.top > innerHeight) {
        badgeEl.style.display = "none";
        return;
      }
      const n = this.matches.length;
      let bg = "#111", fg = "#F26B1D", label = "✓", title = "Looks good";
      if (this.state === "checking") { bg = "#D6D3CF"; fg = "#111"; label = "…"; title = "Checking"; }
      else if (this.state === "error") { bg = "#D6D3CF"; fg = "#111"; label = "!"; title = "Can't reach the Tiger Type server"; }
      else if (this.state === "toolong") { bg = "#D6D3CF"; fg = "#111"; label = "–"; title = "Too long to check in one go"; }
      else if (n) { bg = "#F26B1D"; fg = "#111"; label = n > 99 ? "99+" : String(n); title = `${n} issue${n === 1 ? "" : "s"}`; }
      badgeEl.style.display = "flex";
      badgeEl.style.background = bg;
      badgeEl.style.color = fg;
      badgeEl.textContent = label;
      badgeEl.title = title;
      const inset = box.height > 48 ? 8 : (box.height - 22) / 2;
      badgeEl.style.left = (box.right - badgeEl.offsetWidth - 8) + "px";
      badgeEl.style.top = (box.bottom - 22 - inset) + "px";
    }

    apply(index, replacement) {
      const m = this.matches[index];
      if (!m) return;
      const el = this.el;
      el.focus();
      if (this.plain) {
        el.setSelectionRange(m.offset, m.offset + m.length);
        // execCommand keeps Ctrl+Z working and lets frameworks like React notice the change.
        if (!document.execCommand("insertText", false, replacement)) {
          el.setRangeText(replacement, m.offset, m.offset + m.length, "end");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else {
        const { segs } = readEditable(el);
        const r = rangeFor(segs, m.offset, m.offset + m.length);
        if (!r) return;
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.execCommand("insertText", false, replacement);
      }
      // Shift the remaining underlines so they stay put until the recheck lands.
      const delta = replacement.length - m.length;
      this.matches = this.matches
        .filter((_, i) => i !== index)
        .map((x) => (x.offset > m.offset ? { ...x, offset: x.offset + delta } : x));
      this.render();
    }

    ignore(index) {
      const m = this.matches[index];
      if (!m) return;
      ignored.add(m.rule + "|" + m.text);
      this.matches = this.matches.filter((x) => !(x.rule === m.rule && x.text === m.text));
      this.render();
    }

    detach() {
      clearTimeout(this.timer);
      this.el.removeEventListener("input", this.onInput);
    }
  }

  // ---------- suggestion card ----------

  let cardFor = null; // { checker, index }
  let hideTimer = 0;

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function arrowIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ class: "arrow", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
      stroke: "#6B6B6B", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
    for (const d of ["M5 12h14", "M13 6l6 6-6 6"]) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.append(p);
    }
    return svg;
  }

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function showCard(checker, index, hit) {
    cancelHide();
    if (cardFor && cardFor.checker === checker && cardFor.index === index) return;
    const m = checker.matches[index];
    cardFor = { checker, index };
    const reps = m.replacements.slice(0, 4);
    cardEl.replaceChildren();
    const kind = mk("div", "kind");
    const dot = mk("span", "dot");
    dot.style.background = COLORS[m.kind] || COLORS.grammar;
    kind.append(dot, LABELS[m.kind] || "Grammar");
    cardEl.append(kind, mk("div", "", m.message));
    if (reps.length) {
      const row = mk("div", "reps");
      row.append(mk("span", "orig", m.text), arrowIcon());
      reps.forEach((r) => {
        const b = mk("button", "rep", r || "(remove)");
        b.addEventListener("click", () => {
          checker.apply(index, r);
          hideCard();
        });
        row.append(b);
      });
      cardEl.append(row);
    }
    cardEl.append(mk("div", "line"));
    const foot = mk("div", "foot");
    const ign = mk("button", "ignore", "Ignore");
    ign.addEventListener("click", () => {
      checker.ignore(index);
      hideCard();
    });
    foot.append(mk("span", "note", "Rule-based check, no AI"), ign);
    cardEl.append(foot);
    cardEl.style.display = "flex";
    const h = cardEl.offsetHeight;
    let top = hit.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, hit.top - h - 6);
    const left = Math.min(Math.max(8, hit.left), innerWidth - 320 - 8);
    cardEl.style.top = top + "px";
    cardEl.style.left = left + "px";
  }

  function hideCard() {
    cancelHide();
    cardFor = null;
    cardEl.style.display = "none";
  }

  // Keep focus in the text field when clicking inside the card.
  cardEl.addEventListener("mousedown", (e) => e.preventDefault());
  cardEl.addEventListener("mouseenter", cancelHide);
  cardEl.addEventListener("mouseleave", () => { hideTimer = setTimeout(() => { hideTimer = 0; hideCard(); }, 250); });

  function hitAt(x, y) {
    if (!current) return null;
    return current.hits.find((h) => x >= h.left && x <= h.right && y >= h.top && y <= h.bottom) || null;
  }

  document.addEventListener("mousemove", (e) => {
    if (!current || !current.hits.length) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) {
      showCard(current, hit.index, hit);
    } else if (cardFor && !hideTimer) {
      hideTimer = setTimeout(() => { hideTimer = 0; hideCard(); }, 300);
    }
  }, { passive: true });

  // ---------- focus tracking ----------

  function hideAll() {
    linesEl.textContent = "";
    badgeEl.style.display = "none";
    hideCard();
  }

  async function ensureSiteStatus() {
    if (siteActive !== null) return siteActive;
    try {
      const st = await chrome.runtime.sendMessage({ type: "status", host: location.hostname });
      siteActive = Boolean(st && st.active);
    } catch {
      siteActive = false;
    }
    return siteActive;
  }

  document.addEventListener("focusin", async (e) => {
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    const el = editableRoot(target);
    if (!el || !wantsChecking(el)) return;
    if (!(await ensureSiteStatus())) return;
    mountRoot();
    let c = checkers.get(el);
    if (!c) {
      c = new Checker(el);
      checkers.set(el, c);
      allCheckers.add(c);
    }
    if (current && current !== c) hideCard();
    current = c;
    if (c.lastText !== c.getText()) c.run();
    else c.render();
  }, true);

  document.addEventListener("focusout", (e) => {
    if (!current || e.target !== current.el && !current.el.contains(e.target)) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (current && active !== current.el && !current.el.contains(active)) {
        current = null;
        hideAll();
      }
    }, 0);
  }, true);

  // Re-measure when anything scrolls or resizes.
  let raf = 0;
  const rerender = () => {
    if (raf || !current) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (current) current.render();
    });
  };
  addEventListener("scroll", rerender, { capture: true, passive: true });
  addEventListener("resize", rerender, { passive: true });
  new ResizeObserver(rerender).observe(document.documentElement);

  // Popup toggles or admin changes: recheck whether we should be running here.
  chrome.storage.onChanged.addListener(() => {
    siteActive = null;
    ensureSiteStatus().then((on) => {
      if (!on) {
        current = null;
        hideAll();
      }
    });
  });

  // Small hook for automated tests.
  window.addEventListener("tigertype-test-state", () => {
    document.documentElement.dataset.tigertypeState = JSON.stringify({
      state: current && current.state,
      matches: current ? current.matches.map((m) => m.text) : [],
      underlines: linesEl.childElementCount,
    });
  });
})();
