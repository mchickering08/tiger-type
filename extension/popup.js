const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}
  return { id: tab.id, host };
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
