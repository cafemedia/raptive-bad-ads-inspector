const btn = document.getElementById("toggle");
const viewBtn = document.getElementById("viewSlots");
const resumeBtn = document.getElementById("resumeNow");
const slotsEl = document.getElementById("slots");
const statusEl = document.getElementById("status");
const slotSearchEl = document.getElementById("slotSearch");
const searchWrapEl = document.getElementById("searchWrap");

const STORAGE_KEY = "raptiveInspectorStateByTab";

let cachedSlots = [];
let currentTargetTab = null;
let currentState = { enabled: false, pausedReady: false };

function normalizeState(state) {
  return {
    enabled: !!state?.enabled,
    pausedReady: !!state?.pausedReady
  };
}

async function getFocusedActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function getTabState(tabId) {
  if (tabId == null || tabId < 0) return { enabled: false, pausedReady: false };
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    const byTab = stored?.[STORAGE_KEY] || {};
    return normalizeState(byTab[String(tabId)]);
  } catch {
    return { enabled: false, pausedReady: false };
  }
}

async function setTabState(tabId, partial) {
  if (tabId == null || tabId < 0) return { enabled: false, pausedReady: false };

  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const byTab = { ...(stored?.[STORAGE_KEY] || {}) };
  const next = { ...normalizeState(byTab[String(tabId)]), ...normalizeState(partial) };
  byTab[String(tabId)] = next;
  await chrome.storage.local.set({ [STORAGE_KEY]: byTab });

  try {
    await chrome.runtime.sendMessage({
      type: "SET_TAB_STATE",
      tabId,
      state: next,
      tab: currentTargetTab ? {
        title: currentTargetTab.title || "",
        url: currentTargetTab.url || ""
      } : null
    });
  } catch {}

  return next;
}

async function clearTabState(tabId) {
  if (tabId == null || tabId < 0) return;

  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const byTab = { ...(stored?.[STORAGE_KEY] || {}) };
  delete byTab[String(tabId)];
  await chrome.storage.local.set({ [STORAGE_KEY]: byTab });

  try {
    await chrome.runtime.sendMessage({ type: "RESET_TAB_STATE", tabId });
  } catch {}
}

async function resolveTargetTab() {
  const focusedTab = await getFocusedActiveTab();
  currentTargetTab = focusedTab || null;
  currentState = await getTabState(currentTargetTab?.id);
  return currentTargetTab;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderStatus(state, tab) {
  const pieces = [];
  const title = tab?.title ? escapeHtml(tab.title) : "Unknown tab";
  pieces.push(`Current tab: <strong>${title}</strong>`);
  pieces.push(`Ads paused: <strong>${state.pausedReady ? "yes" : "no"}</strong>`);
  pieces.push(`Inspector active: <strong>${state.enabled ? "yes" : "no"}</strong>`);
  if (state.enabled || state.pausedReady) {
    pieces.push(`<span style="color:#374151">This state is only for this tab/page. Other tabs start from the initial flow.</span>`);
  } else {
    pieces.push(`<span style="color:#374151">This tab is not currently inspecting ads.</span>`);
  }
  statusEl.innerHTML = pieces.join("<br>");
}

async function sendTabMessage(tabId, message) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

function renderSlots(slots) {
  const q = (slotSearchEl.value || "").trim().toLowerCase();
  const filtered = slots.filter((slotId) => !q || slotId.toLowerCase().includes(q));

  slotsEl.innerHTML = "";
  slotsEl.style.display = "block";
  searchWrapEl.style.display = slots.length ? "block" : "none";

  if (!slots.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No ad slots found on this page yet. Scroll to load ads and try again.";
    slotsEl.appendChild(div);
    return;
  }

  if (!filtered.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No slots match that filter.";
    slotsEl.appendChild(div);
    return;
  }

  for (const slotId of filtered) {
    const item = document.createElement("div");
    item.className = "slotItem";
    item.textContent = slotId;

    const sub = document.createElement("div");
    sub.className = "subtle";
    sub.textContent = "Open slot history panel in the page";
    item.appendChild(sub);

    item.addEventListener("click", async () => {
      const tabId = currentTargetTab?.id;
      if (!tabId) return;
      await sendTabMessage(tabId, { type: "OPEN_SLOT_HISTORY", slotId });
      window.close();
    });

    slotsEl.appendChild(item);
  }
}

async function loadState() {
  await resolveTargetTab();
  const state = currentState;

  btn.style.display = "block";
  btn.textContent = state.enabled ? "Hide ad info" : "Show ad info";
  viewBtn.style.display = state.enabled ? "block" : "none";
  resumeBtn.style.display = state.pausedReady ? "block" : "none";
  renderStatus(state, currentTargetTab);

  if (!state.enabled) {
    searchWrapEl.style.display = "none";
    slotsEl.style.display = "none";
    slotsEl.innerHTML = "";
    slotSearchEl.value = "";
    cachedSlots = [];
  }
}

resumeBtn.addEventListener("click", async () => {
  const tabId = currentTargetTab?.id;
  if (!tabId) return;

  await sendTabMessage(tabId, { type: "RESUME_REFRESH" });
  await clearTabState(tabId);
  currentState = { enabled: false, pausedReady: false };
  await loadState();
});

btn.addEventListener("click", async () => {
  await resolveTargetTab();
  const tabId = currentTargetTab?.id;
  if (!tabId) return;

  const nextEnabled = !currentState.enabled;
  if (nextEnabled) {
    await sendTabMessage(tabId, { type: "PAUSE_REFRESH" });
    await sendTabMessage(tabId, { type: "TOGGLE_INSPECTOR", enabled: true });
    currentState = await setTabState(tabId, { enabled: true, pausedReady: true });
  } else {
    await sendTabMessage(tabId, { type: "TOGGLE_INSPECTOR", enabled: false });
    currentState = await setTabState(tabId, { enabled: false, pausedReady: true });
  }
  await loadState();
});

viewBtn.addEventListener("click", async () => {
  const tabId = currentTargetTab?.id;
  if (!tabId) return;

  const resp = await sendTabMessage(tabId, { type: "GET_PAGE_SLOTS" });
  cachedSlots = (resp?.slots || []).slice().sort((a, b) => a.localeCompare(b));
  renderSlots(cachedSlots);
});

slotSearchEl.addEventListener("input", () => renderSlots(cachedSlots));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEY]) loadState();
});

loadState();
