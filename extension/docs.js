// Runs on Google Docs pages.
//  1. Downloads the open doc as plain text when the Tiger Type side panel asks.
//  2. Relays checks from the Tiger Type Docs add-on (its sidebar can't reach the
//     Tiger Type server on its own, but the extension can).

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "getDocText") return;
  fetch(msg.url, { credentials: "include" })
    .then(async (r) => {
      if (!r.ok || !/text\/plain/.test(r.headers.get("content-type") || "")) throw new Error(r.status);
      sendResponse({ ok: true, text: await r.text() });
    })
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

function fromAddon(origin) {
  // Apps Script sidebars are served from *.googleusercontent.com (or a sandboxed "null" origin).
  if (origin === "null") return true;
  try {
    return new URL(origin).hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

window.addEventListener("message", async (e) => {
  const d = e.data;
  if (!d || typeof d !== "object" || !d.tigertype || !e.source || !fromAddon(e.origin)) return;
  const reply = (data) => e.source.postMessage({ ...data, id: d.id }, e.origin === "null" ? "*" : e.origin);

  if (d.tigertype === "ping") return reply({ tigertype: "pong", version: chrome.runtime.getManifest().version });
  if (d.tigertype !== "check" || typeof d.text !== "string") return;

  try {
    const st = await chrome.runtime.sendMessage({ type: "status", host: "docs.google.com" });
    if (!st.online) return reply({ tigertype: "result", ok: false, error: "offline" });
    if (!st.active) return reply({ tigertype: "result", ok: false, error: st.reason || "Tiger Type is off." });
    const res = await chrome.runtime.sendMessage({ type: "check", text: d.text.slice(0, 20000) });
    if (!res || !res.ok) return reply({ tigertype: "result", ok: false, error: "Can't reach the Tiger Type server." });
    reply({ tigertype: "result", ok: true, enabled: res.enabled, matches: res.matches });
  } catch (err) {
    reply({ tigertype: "result", ok: false, error: String(err && err.message || err) });
  }
});
