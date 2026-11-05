const $ = (id) => document.getElementById(id);

(async () => {
  let managed = {};
  try { managed = (await chrome.storage.managed.get(null)) || {}; } catch {}
  const { serverUrl = "" } = await chrome.storage.local.get("serverUrl");
  $("serverUrl").value = managed.serverUrl || serverUrl || "http://localhost:8000";
  if (managed.serverUrl) {
    $("managed").textContent = "Your school set this. It can't be changed here.";
    $("serverUrl").disabled = true;
    $("save").hidden = true;
  }
})();

$("save").onclick = async () => {
  const v = $("serverUrl").value.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//.test(v)) {
    $("msg").textContent = "Needs to start with http:// or https://";
    return;
  }
  await chrome.storage.local.set({ serverUrl: v });
  $("msg").textContent = "Saved.";
};
