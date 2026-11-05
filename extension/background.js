// Tiger Type background worker.
// Merges three layers of settings, strongest first:
//   1. chrome.storage.managed  - pushed by school IT through the Google Admin console
//   2. /policy on the server   - what the admin sets on the Tiger Type admin page
//   3. chrome.storage.local    - the student's own per-site toggles (ignored if locked)
// All network calls go through here so pages can't see or block them.

const DEFAULT_SERVER = "http://localhost:8000";
const POLICY_TTL_MS = 60 * 1000;

let policyCache = { at: 0, server: "", data: null };

async function getManaged() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    return {};
  }
}

async function getConfig() {
  const managed = await getManaged();
  const local = await chrome.storage.local.get(["serverUrl", "disabledSites"]);
  return {
    server: (managed.serverUrl || local.serverUrl || DEFAULT_SERVER).replace(/\/+$/, ""),
    managedServer: Boolean(managed.serverUrl),
    locked: Boolean(managed.lockSettings),
    managedBlocked: managed.blockedSites || [],
    disabledSites: local.disabledSites || [],
  };
}

async function getPolicy(server) {
  const now = Date.now();
  if (policyCache.data && policyCache.server === server && now - policyCache.at < POLICY_TTL_MS) {
    return policyCache.data;
  }
  try {
    const r = await fetch(`${server}/policy`);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    policyCache = { at: now, server, data: { ...data, online: true } };
  } catch {
    policyCache = { at: now, server, data: { enabled: true, blocked_sites: [], online: false } };
  }
  return policyCache.data;
}

function hostMatches(host, list) {
  host = (host || "").toLowerCase();
  return list.some((d) => {
    d = String(d).toLowerCase().replace(/^\*\./, "").trim();
    return d && (host === d || host.endsWith("." + d));
  });
}

async function getStatus(host) {
  const cfg = await getConfig();
  const policy = await getPolicy(cfg.server);
  let active = true;
  let reason = "";
  if (!policy.enabled) {
    active = false;
    reason = "Turned off by your school right now.";
  } else if (hostMatches(host, cfg.managedBlocked) || hostMatches(host, policy.blocked_sites || [])) {
    active = false;
    reason = "Your school turned Tiger Type off on this site.";
  } else if (!cfg.locked && hostMatches(host, cfg.disabledSites)) {
    active = false;
    reason = "You turned Tiger Type off on this site.";
  }
  return {
    active,
    reason,
    online: policy.online,
    locked: cfg.locked,
    server: cfg.server,
    managedServer: cfg.managedServer,
    siteDisabledByUser: hostMatches(host, cfg.disabledSites),
  };
}

async function check(text) {
  const cfg = await getConfig();
  const r = await fetch(`${cfg.server}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json();
}

// Issue counts per tab, so the popup can show them. Each frame reports its own.
async function setCounts(tabId, frameId, counts) {
  const key = "counts_" + tabId;
  const cur = (await chrome.storage.session.get(key))[key] || {};
  cur[frameId] = counts;
  await chrome.storage.session.set({ [key]: cur });
}

async function getCounts(tabId) {
  const key = "counts_" + tabId;
  const per = (await chrome.storage.session.get(key))[key] || {};
  const total = { spelling: 0, grammar: 0, style: 0 };
  for (const c of Object.values(per)) for (const k in total) total[k] += c[k] || 0;
  return total;
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove("counts_" + tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") chrome.storage.session.remove("counts_" + tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "status") sendResponse(await getStatus(msg.host));
      else if (msg.type === "counts") {
        if (sender.tab) await setCounts(sender.tab.id, sender.frameId || 0, msg.counts);
        sendResponse({ ok: true });
      } else if (msg.type === "getCounts") sendResponse(await getCounts(msg.tabId));
      else if (msg.type === "check") sendResponse({ ok: true, ...(await check(msg.text)) });
      else if (msg.type === "refresh") {
        policyCache.at = 0;
        sendResponse({ ok: true });
      } else sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // keep the channel open for the async reply
});

// If IT changes the managed policy, drop the cache.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "managed" || area === "local") policyCache.at = 0;
});
