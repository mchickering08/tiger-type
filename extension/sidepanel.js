// Tiger Type side panel for Google Docs: downloads the doc as text, checks it, lists issues.

const $ = (id) => document.getElementById(id);
const COLORS = { spelling: "#F26B1D", grammar: "#2F6FEB", style: "#6B6B6B" };
const LABELS = { spelling: "Spelling", grammar: "Grammar", style: "Style" };
const CHUNK = 18000; // server limit is 20,000 characters per check
const DOC_RE = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/[\w-]+/;

let issues = [];
const ignored = new Set();

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function setStatus(text, isError) {
  $("status").textContent = text;
  $("status").className = isError ? "error" : "";
}

async function findDocTab() {
  // Prefer the tab in this window that's showing a doc right now.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && DOC_RE.test(tab.url || "")) return tab;
  const { docTarget } = await chrome.storage.session.get("docTarget");
  if (docTarget) {
    try {
      const t = await chrome.tabs.get(docTarget.tabId);
      if (DOC_RE.test(t.url || "")) return t;
    } catch {}
  }
  return null;
}

// Split long docs on paragraph breaks so each piece fits the server's limit.
function chunks(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > start) end = nl + 1;
    }
    out.push({ start, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

function paragraphOf(text, offset) {
  let n = 0;
  for (const line of text.slice(0, offset).split("\n").slice(0, -1)) if (line.trim()) n++;
  return n + 1;
}

function context(text, offset, length) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = text.indexOf("\n", offset + length);
  if (lineEnd === -1) lineEnd = text.length;
  const a = Math.max(lineStart, offset - 45);
  const b = Math.min(lineEnd, offset + length + 45);
  return {
    before: (a > lineStart ? "…" : "") + text.slice(a, offset),
    hit: text.slice(offset, offset + length),
    after: text.slice(offset + length, b) + (b < lineEnd ? "…" : ""),
  };
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = mk("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}

function render() {
  const shown = issues.filter((m) => !ignored.has(m.key));
  const counts = { spelling: 0, grammar: 0, style: 0 };
  for (const m of shown) counts[m.kind] = (counts[m.kind] || 0) + 1;
  for (const k in counts) $("c-" + k).textContent = counts[k];
  $("stats").hidden = false;
  $("tip").hidden = !shown.length;
  setStatus(shown.length ? `${shown.length} thing${shown.length === 1 ? "" : "s"} to look at` : "No issues found. Nice.");

  const list = $("list");
  list.replaceChildren();
  list.style.cssText = "display:flex;flex-direction:column;gap:10px";
  for (const m of shown) {
    const item = mk("div", "item");

    const top = mk("div", "top");
    const dot = mk("span", "dot");
    dot.style.background = COLORS[m.kind] || COLORS.grammar;
    top.append(dot, LABELS[m.kind] || "Grammar", mk("span", "where", "Paragraph " + m.paragraph));

    const ctx = mk("div", "ctx");
    const mark = mk("mark", "", m.context.hit);
    mark.style.textDecorationColor = COLORS[m.kind] || COLORS.grammar;
    ctx.append(m.context.before, mark, m.context.after);

    item.append(top, ctx, mk("div", "", m.message));

    if (m.replacements.length) {
      const reps = mk("div", "reps");
      reps.append(mk("span", "orig", m.text));
      for (const r of m.replacements.slice(0, 4)) {
        const b = mk("button", "rep", r || "(remove)");
        b.title = "Copy";
        b.addEventListener("click", async () => {
          await copy(r);
          b.classList.add("copied");
          b.textContent = "Copied";
          setTimeout(() => {
            b.classList.remove("copied");
            b.textContent = r || "(remove)";
          }, 1200);
        });
        reps.append(b);
      }
      item.append(reps);
    }

    const foot = mk("div", "foot");
    const ign = mk("button", "ignore", "Ignore");
    ign.addEventListener("click", () => {
      ignored.add(m.key);
      render();
    });
    foot.append(ign);
    item.append(foot);
    list.append(item);
  }
}

async function run() {
  const go = $("go");
  go.disabled = true;
  $("list").replaceChildren();
  $("stats").hidden = true;
  $("tip").hidden = true;
  try {
    const tab = await findDocTab();
    if (!tab) {
      $("docName").textContent = "Google Docs check";
      setStatus("Open a Google Doc in this window, then click the button.");
      return;
    }
    $("docName").textContent = (tab.title || "").replace(/ - Google Docs$/, "") || "Untitled document";

    const st = await chrome.runtime.sendMessage({ type: "status", host: "docs.google.com" });
    if (!st.online) return setStatus("Can't reach the Tiger Type server. Is the Tiger Type Server window open?", true);
    if (!st.active) return setStatus(st.reason || "Tiger Type is turned off.", true);

    setStatus("Reading the doc…");
    const doc = await chrome.runtime.sendMessage({ type: "getDocText", tabId: tab.id, url: tab.url });
    if (!doc || !doc.ok) {
      return setStatus("Couldn't read this doc. Make sure you're signed in and the doc is allowed to be downloaded.", true);
    }
    const text = doc.text.replace(/\r\n?/g, "\n");
    if (!text.trim()) return setStatus("This doc is empty.");

    setStatus("Checking…");
    issues = [];
    for (const c of chunks(text)) {
      const res = await chrome.runtime.sendMessage({ type: "check", text: c.text });
      if (!res || !res.ok) return setStatus("The Tiger Type server had a problem checking this doc.", true);
      if (res.enabled === false) return setStatus("Tiger Type is turned off by your school right now.", true);
      for (const m of res.matches) {
        const offset = c.start + m.offset;
        issues.push({
          ...m,
          offset,
          paragraph: paragraphOf(text, offset),
          context: context(text, offset, m.length),
          key: m.rule + "|" + m.text,
        });
      }
    }
    issues.sort((a, b) => a.offset - b.offset);
    render();
    go.textContent = "Check again";
  } catch (e) {
    setStatus("Something went wrong: " + (e && e.message ? e.message : e), true);
  } finally {
    go.disabled = false;
  }
}

$("go").addEventListener("click", run);

// Opened from the popup's "Check this doc" button: start right away.
chrome.storage.session.get("docTarget").then(({ docTarget }) => {
  if (docTarget && Date.now() - docTarget.at < 10000) run();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.docTarget && changes.docTarget.newValue) run();
});
