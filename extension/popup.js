const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}
  return { id: tab.id, host, url: tab.url || "", title: tab.title || "" };
}

async function render() {
  const tab = await activeTab();
  await chrome.runtime.sendMessage({ type: "refresh" });
  const st = await chrome.runtime.sendMessage({ type: "status", host: tab.host });
  const counts = await chrome.runtime.sendMessage({ type: "getCounts", tabId: tab.id });

  $("site").textContent = tab.host || "This page";
  const pill = $("pill");
  if (!st.online) {
    pill.className = "pill err";
    pill.textContent = "OFFLINE";
    $("reason").textContent = "Can't reach the Tiger Type server.";
  } else {
    pill.className = "pill " + (st.active ? "on" : "off");
    pill.textContent = st.active ? "ON" : "OFF";
    $("reason").textContent = st.reason;
  }

  for (const k of ["spelling", "grammar", "style"]) $("c-" + k).textContent = st.active ? counts[k] || 0 : "–";

  // Google Docs: no underlines possible, so offer the whole-doc check instead.
  const isDoc = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\//.test(tab.url);
  $("docsBox").hidden = !isDoc;
  $("siteRow").hidden = isDoc;
  $("stats").hidden = isDoc;
  if (isDoc) {
    $("checkDoc").disabled = !st.active || !st.online;
    $("checkDoc").onclick = () => {
      // sidePanel.open has to run right away inside the click, so don't await anything first.
      chrome.storage.session.set({ docTarget: { tabId: tab.id, url: tab.url, title: tab.title, at: Date.now() } });
      chrome.sidePanel.open({ tabId: tab.id }).then(() => window.close());
    };
  }

  const toggle = $("siteToggle");
  toggle.checked = !st.siteDisabledByUser;
  toggle.disabled = !tab.host || st.locked;
  if (st.locked) toggle.title = "Managed by your school";

  toggle.onchange = async () => {
    const { disabledSites = [] } = await chrome.storage.local.get("disabledSites");
    const next = new Set(disabledSites);
    if (toggle.checked) next.delete(tab.host);
    else next.add(tab.host);
    await chrome.storage.local.set({ disabledSites: [...next] });
    render();
  };
}

render();
