// Runs on Google Docs pages. Only job: download the open doc as plain text when the
// Tiger Type side panel asks, using the page's own sign-in.
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
