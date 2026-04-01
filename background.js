const MAX_PER_TAB = 200;
const MAX_PER_SLOT = 50;
const STORAGE_KEY = 'raptiveInspectorStateByTab';
const ACTIVE_TAB_KEY = 'raptiveInspectorActiveTabId';
const SESSION_KEY = 'raptiveInspectorSession';
const PAGEVIEW_CACHE_KEY = 'raptiveInspectorPageviewCacheV1';

const requestsByTab = new Map();
const requestsByTabSlot = new Map();
const requestsByTabQuery = new Map();
const pageSlotsByTab = new Map();
const pageSlotsByTabQuery = new Map();
const inspectorStateByTab = new Map();
let activeInspectorTabId = null;
let inspectorSession = null;

let pageviewCacheLoaded = false;
let pageviewCacheLoadPromise = null;

function getSessionStorageArea() {
  return chrome.storage.session || chrome.storage.local;
}

function serializePageviewCache() {
  const reqByTab = {};
  for (const [tabId, list] of requestsByTab.entries()) reqByTab[String(tabId)] = Array.isArray(list) ? list : [];

  const reqByTabSlot = {};
  for (const [tabId, slotMap] of requestsByTabSlot.entries()) {
    reqByTabSlot[String(tabId)] = Object.fromEntries(Array.from(slotMap.entries()).map(([slotId, list]) => [slotId, Array.isArray(list) ? list : []]));
  }

  const reqByTabQuery = {};
  for (const [tabId, queryMap] of requestsByTabQuery.entries()) {
    reqByTabQuery[String(tabId)] = Object.fromEntries(Array.from(queryMap.entries()).map(([queryId, list]) => [queryId, Array.isArray(list) ? list : []]));
  }

  const pageSlots = {};
  for (const [tabId, slotMap] of pageSlotsByTab.entries()) {
    pageSlots[String(tabId)] = Array.from(slotMap.values()).map((slot) => ({
      slotId: String(slot?.slotId || ''),
      queryId: String(slot?.queryId || '')
    })).filter((slot) => slot.slotId);
  }

  return {
    requestsByTab: reqByTab,
    requestsByTabSlot: reqByTabSlot,
    requestsByTabQuery: reqByTabQuery,
    pageSlotsByTab: pageSlots
  };
}

function restorePageviewCache(payload) {
  requestsByTab.clear();
  requestsByTabSlot.clear();
  requestsByTabQuery.clear();
  pageSlotsByTab.clear();
  pageSlotsByTabQuery.clear();

  const reqByTab = payload?.requestsByTab || {};
  for (const [tabIdRaw, list] of Object.entries(reqByTab)) {
    const tabId = Number(tabIdRaw);
    if (!Number.isFinite(tabId) || tabId < 0 || !Array.isArray(list)) continue;
    requestsByTab.set(tabId, list.slice(0, MAX_PER_TAB));
  }

  const reqByTabSlot = payload?.requestsByTabSlot || {};
  for (const [tabIdRaw, slotObj] of Object.entries(reqByTabSlot)) {
    const tabId = Number(tabIdRaw);
    if (!Number.isFinite(tabId) || tabId < 0 || !slotObj || typeof slotObj !== 'object') continue;
    const slotMap = new Map();
    for (const [slotId, list] of Object.entries(slotObj)) {
      if (!slotId || !Array.isArray(list)) continue;
      slotMap.set(slotId, list.slice(0, MAX_PER_SLOT));
    }
    if (slotMap.size) requestsByTabSlot.set(tabId, slotMap);
  }

  const reqByTabQuery = payload?.requestsByTabQuery || {};
  for (const [tabIdRaw, queryObj] of Object.entries(reqByTabQuery)) {
    const tabId = Number(tabIdRaw);
    if (!Number.isFinite(tabId) || tabId < 0 || !queryObj || typeof queryObj !== 'object') continue;
    const queryMap = new Map();
    for (const [queryId, list] of Object.entries(queryObj)) {
      if (!queryId || !Array.isArray(list)) continue;
      queryMap.set(queryId, list.slice(0, MAX_PER_SLOT));
    }
    if (queryMap.size) requestsByTabQuery.set(tabId, queryMap);
  }

  const pageSlots = payload?.pageSlotsByTab || {};
  for (const [tabIdRaw, slots] of Object.entries(pageSlots)) {
    const tabId = Number(tabIdRaw);
    if (!Number.isFinite(tabId) || tabId < 0 || !Array.isArray(slots)) continue;
    syncPageSlots(tabId, slots);
  }
}

async function loadPageviewCache() {
  if (pageviewCacheLoaded) return;
  if (pageviewCacheLoadPromise) return pageviewCacheLoadPromise;
  pageviewCacheLoadPromise = (async () => {
    try {
      const stored = await getSessionStorageArea().get([PAGEVIEW_CACHE_KEY]);
      restorePageviewCache(stored?.[PAGEVIEW_CACHE_KEY] || null);
    } catch {
      restorePageviewCache(null);
    }
    pageviewCacheLoaded = true;
  })();
  try {
    await pageviewCacheLoadPromise;
  } finally {
    pageviewCacheLoadPromise = null;
  }
}

async function persistPageviewCache() {
  try {
    await getSessionStorageArea().set({ [PAGEVIEW_CACHE_KEY]: serializePageviewCache() });
  } catch {}
}


function normalizeSession(session) {
  if (!session || session.tabId == null) return null;
  const tabId = Number(session.tabId);
  if (!Number.isFinite(tabId) || tabId < 0) return null;
  const state = normalizeState(session);
  if (!state.enabled && !state.pausedReady) return null;
  return {
    tabId,
    enabled: state.enabled,
    pausedReady: state.pausedReady,
    title: String(session.title || ''),
    url: String(session.url || ''),
    updatedAt: Number(session.updatedAt) || Date.now()
  };
}

async function loadStateCache() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, ACTIVE_TAB_KEY, SESSION_KEY]);
    const obj = stored?.[STORAGE_KEY] || {};
    inspectorStateByTab.clear();
    for (const [tabId, state] of Object.entries(obj)) {
      const id = Number(tabId);
      if (Number.isFinite(id)) inspectorStateByTab.set(id, normalizeState(state));
    }

    inspectorSession = normalizeSession(stored?.[SESSION_KEY]);
    const storedActiveTabId = Number(stored?.[ACTIVE_TAB_KEY]);
    activeInspectorTabId = inspectorSession?.tabId ?? (Number.isFinite(storedActiveTabId) && storedActiveTabId >= 0 ? storedActiveTabId : null);
    maybePromoteActiveInspectorTab();
  } catch {}
}

function normalizeState(state) {
  return {
    enabled: !!state?.enabled,
    pausedReady: !!state?.pausedReady
  };
}

async function persistStateCache() {
  try {
    const obj = {};
    for (const [tabId, state] of inspectorStateByTab.entries()) obj[String(tabId)] = normalizeState(state);
    const payload = { [STORAGE_KEY]: obj };
    payload[ACTIVE_TAB_KEY] = activeInspectorTabId == null ? null : activeInspectorTabId;
    payload[SESSION_KEY] = inspectorSession ? { ...inspectorSession } : null;
    await chrome.storage.local.set(payload);
  } catch {}
}

function getTabState(tabId) {
  return inspectorStateByTab.get(tabId) || { enabled: false, pausedReady: false };
}

async function syncInspectorSession(tabId, state, tabInfo) {
  const normalizedState = normalizeState(state);
  if (tabId == null || tabId < 0 || (!normalizedState.enabled && !normalizedState.pausedReady)) {
    inspectorSession = null;
    await persistStateCache();
    return;
  }

  let title = '';
  let url = '';
  if (tabInfo) {
    title = String(tabInfo.title || '');
    url = String(tabInfo.url || '');
  } else {
    try {
      const tab = await chrome.tabs.get(tabId);
      title = String(tab?.title || '');
      url = String(tab?.url || '');
    } catch {}
  }

  inspectorSession = {
    tabId,
    enabled: normalizedState.enabled,
    pausedReady: normalizedState.pausedReady,
    title,
    url,
    updatedAt: Date.now()
  };
  await persistStateCache();
}

async function setActiveInspectorTabId(tabId) {
  activeInspectorTabId = tabId == null || tabId < 0 ? null : tabId;
  if (activeInspectorTabId == null || activeInspectorTabId < 0) {
    inspectorSession = null;
    await persistStateCache();
    return;
  }

  const state = getTabState(activeInspectorTabId);
  if (state.enabled || state.pausedReady) {
    await syncInspectorSession(activeInspectorTabId, state);
  } else {
    await persistStateCache();
  }
}

function maybePromoteActiveInspectorTab() {
  if (inspectorSession?.tabId != null) {
    const state = getTabState(inspectorSession.tabId);
    if (state.enabled || state.pausedReady) {
      activeInspectorTabId = inspectorSession.tabId;
      return;
    }
  }

  if (activeInspectorTabId != null) {
    const state = getTabState(activeInspectorTabId);
    if (state.enabled || state.pausedReady) return;
  }

  activeInspectorTabId = null;
  for (const [tabId, state] of inspectorStateByTab.entries()) {
    if (state.enabled || state.pausedReady) {
      activeInspectorTabId = tabId;
      break;
    }
  }

  const promotedState = activeInspectorTabId != null ? getTabState(activeInspectorTabId) : null;
  if (activeInspectorTabId == null || !promotedState || (!promotedState.enabled && !promotedState.pausedReady)) {
    inspectorSession = null;
  } else if (!inspectorSession || inspectorSession.tabId !== activeInspectorTabId) {
    inspectorSession = {
      tabId: activeInspectorTabId,
      enabled: promotedState.enabled,
      pausedReady: promotedState.pausedReady,
      title: inspectorSession?.title || '',
      url: inspectorSession?.url || '',
      updatedAt: Date.now()
    };
  }
}

async function setTabState(tabId, partial, tabInfo) {
  if (tabId == null || tabId < 0) return getTabState(tabId);
  const next = { ...getTabState(tabId), ...normalizeState(partial) };
  inspectorStateByTab.set(tabId, next);

  if (next.enabled || next.pausedReady) {
    activeInspectorTabId = tabId;
    await syncInspectorSession(tabId, next, tabInfo);
  } else {
    if (activeInspectorTabId === tabId) maybePromoteActiveInspectorTab();
    if (inspectorSession?.tabId === tabId) {
      inspectorSession = null;
    }
    await persistStateCache();
  }

  return next;
}

function safeDecode(v) {
  if (!v) return '';
  try { return decodeURIComponent(v); } catch { return String(v); }
}

function parsePrevScp(raw) {
  const decoded = safeDecode(raw);
  const out = {};
  for (const part of decoded.split('&')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    out[k] = safeDecode(v);
  }
  return out;
}

function findHbValue(raw, key) {
  if (!raw) return null;
  const dec = safeDecode(raw);
  const patterns = [
    new RegExp(`(?:^|[&?,\\s])${key}=([^&?#\\s,]+)`, 'i'),
    new RegExp(`(?:^|[,&\\s])${key}:([^&?#\\s,]+)`, 'i'),
    new RegExp(`(?:^|[&?,\\s])${key}%3D([^&?#\\s,]+)`, 'i'),
    new RegExp(`(?:^|[,&\\s])${key}%3A([^&?#\\s,]+)`, 'i')
  ];

  for (const p of patterns) {
    let m = raw.match(p);
    if (m?.[1]) return safeDecode(m[1]);
    m = dec.match(p);
    if (m?.[1]) return safeDecode(m[1]);
  }
  return null;
}

function pickDomain(prevObj, prevRaw, custRaw) {
  const hbDomain = prevObj.hb_domain || findHbValue(prevRaw, 'hb_domain') || findHbValue(custRaw, 'hb_domain');
  if (hbDomain) return hbDomain;

  const hbAdomain = prevObj.hb_adomain || findHbValue(prevRaw, 'hb_adomain') || findHbValue(custRaw, 'hb_adomain');
  if (hbAdomain) return hbAdomain;

  const bidder = prevObj.hb_bidder || findHbValue(prevRaw, 'hb_bidder') || findHbValue(custRaw, 'hb_bidder');
  if (bidder) {
    const k = `hb_adomain_${bidder}`;
    const spec = prevObj[k] || findHbValue(prevRaw, k) || findHbValue(custRaw, k);
    if (spec) return spec;
  }
  return null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseGamUrl(urlStr) {
  const url = new URL(urlStr);
  const params = Object.fromEntries(url.searchParams.entries());

  const prevRaw = params.prev_scp ?? '';
  const custRaw = params.cust_params ?? '';
  const prevObj = parsePrevScp(prevRaw);

  const hbBidderPrev = prevObj.hb_bidder || findHbValue(prevRaw, 'hb_bidder');
  const hbCridPrev = prevObj.hb_crid || findHbValue(prevRaw, 'hb_crid');
  const hbBidderCust = findHbValue(custRaw, 'hb_bidder');
  const hbCridCust = findHbValue(custRaw, 'hb_crid');

  const hbBidder = hbBidderPrev || hbBidderCust || null;
  const hbCrid = hbCridPrev || hbCridCust || null;
  const adDomain = pickDomain(prevObj, prevRaw, custRaw);

  const iuParts = String(params.iu_parts || '').split(',');
  const adUnit = firstDefined(params.iu, iuParts[1]);
  const gamId = firstDefined(params.gqid, params.correlator, params.scp, (iuParts[0] || '').split(':')[0]);
  const slotId = firstDefined(
    prevObj.id,
    params.slotname,
    params.prev_iu_szs,
    findHbValue(prevRaw, 'id'),
    findHbValue(custRaw, 'id')
  );

  return {
    url: urlStr,
    ts: Date.now(),
    iu_parts: params.iu_parts || null,
    adUnit,
    gamId,
    prev_scp: safeDecode(prevRaw),
    slotId,
    hb_bidder: hbBidder,
    hb_crid: hbCrid,
    ad_domain: adDomain
  };
}

function pushRequest(tabId, req) {
  if (tabId == null || tabId < 0) return;

  const arr = requestsByTab.get(tabId) ?? [];
  arr.unshift(req);
  if (arr.length > MAX_PER_TAB) arr.length = MAX_PER_TAB;
  requestsByTab.set(tabId, arr);

  if (req.slotId) {
    const slotMap = requestsByTabSlot.get(tabId) ?? new Map();
    const slotArr = slotMap.get(req.slotId) ?? [];
    slotArr.unshift(req);
    if (slotArr.length > MAX_PER_SLOT) slotArr.length = MAX_PER_SLOT;
    slotMap.set(req.slotId, slotArr);
    requestsByTabSlot.set(tabId, slotMap);
  }

  if (req.gamId) {
    const queryMap = requestsByTabQuery.get(tabId) ?? new Map();
    const queryArr = queryMap.get(req.gamId) ?? [];
    queryArr.unshift(req);
    if (queryArr.length > MAX_PER_SLOT) queryArr.length = MAX_PER_SLOT;
    queryMap.set(req.gamId, queryArr);
    requestsByTabQuery.set(tabId, queryMap);
  }
}

async function clearTabState(tabId) {
  await loadPageviewCache();
  requestsByTab.delete(tabId);
  requestsByTabSlot.delete(tabId);
  requestsByTabQuery.delete(tabId);
  pageSlotsByTab.delete(tabId);
  pageSlotsByTabQuery.delete(tabId);
  inspectorStateByTab.delete(tabId);
  if (inspectorSession?.tabId === tabId) inspectorSession = null;
  if (activeInspectorTabId === tabId) maybePromoteActiveInspectorTab();
  await persistStateCache();
  await persistPageviewCache();
}

function normalizeSlotLookupId(value) {
  return String(value || '')
    .replace(/^google_ads_iframe_/, '')
    .replace(/__(container__|iframe)__?$/, '')
    .replace(/^\/+/, '')
    .trim()
    .toLowerCase();
}

function slotIdsLikelyMatch(a, b) {
  const na = normalizeSlotLookupId(a);
  const nb = normalizeSlotLookupId(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.endsWith(nb) || nb.endsWith(na)) return true;
  return false;
}

function syncPageSlots(tabId, slots) {
  if (tabId == null || tabId < 0) return;

  const bySlot = new Map();
  const byQuery = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    const slotId = String(slot?.slotId || '').trim();
    if (!slotId) continue;
    const queryId = String(slot?.queryId || '').trim();
    bySlot.set(slotId, { slotId, queryId });
    if (queryId) {
      const list = byQuery.get(queryId) ?? [];
      list.push(slotId);
      byQuery.set(queryId, list);
    }
  }
  pageSlotsByTab.set(tabId, bySlot);
  pageSlotsByTabQuery.set(tabId, byQuery);
}

function uniqRequests(requests) {
  const seen = new Set();
  const out = [];
  for (const req of requests) {
    if (!req) continue;
    const key = [req.ts || '', req.gamId || '', req.slotId || '', req.url || ''].join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(req);
  }
  out.sort((a, b) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0));
  return out;
}

function getTrackedQueryIdsForSlot(tabId, slotId, explicitQueryId) {
  const ids = new Set();
  if (explicitQueryId) ids.add(String(explicitQueryId));

  const pageSlots = pageSlotsByTab.get(tabId) ?? new Map();
  const direct = pageSlots.get(slotId);
  if (direct?.queryId) ids.add(direct.queryId);

  for (const info of pageSlots.values()) {
    if (slotIdsLikelyMatch(info.slotId, slotId) && info.queryId) ids.add(info.queryId);
  }

  return Array.from(ids);
}

function getSlotHistoryForTab(tabId, slotId, explicitQueryId) {
  const slotMap = requestsByTabSlot.get(tabId) ?? new Map();
  const queryMap = requestsByTabQuery.get(tabId) ?? new Map();
  const all = requestsByTab.get(tabId) ?? [];
  const requests = [];

  if (slotId) {
    const exact = slotMap.get(slotId) ?? [];
    requests.push(...exact);

    for (const req of all) {
      if (slotIdsLikelyMatch(req.slotId, slotId)) requests.push(req);
    }
  }

  for (const queryId of getTrackedQueryIdsForSlot(tabId, slotId, explicitQueryId)) {
    requests.push(...(queryMap.get(queryId) ?? []));
  }

  return uniqRequests(requests);
}

function bestMatchForTab(tabId, slotId, queryId) {
  const slotMap = requestsByTabSlot.get(tabId) ?? new Map();
  const queryMap = requestsByTabQuery.get(tabId) ?? new Map();
  const all = requestsByTab.get(tabId) ?? [];

  if (queryId) {
    const queryReqs = queryMap.get(queryId) ?? [];
    const exactWithSlot = queryReqs.find((r) => !slotId || slotIdsLikelyMatch(r.slotId, slotId));
    if (exactWithSlot) return exactWithSlot;
  }

  if (slotId) {
    const exactSlotReqs = slotMap.get(slotId) ?? [];
    if (exactSlotReqs.length) return exactSlotReqs[0];

    const normalizedSlotMatch = all.find((r) => slotIdsLikelyMatch(r.slotId, slotId));
    if (normalizedSlotMatch) return normalizedSlotMatch;
  }

  if (queryId) {
    const queryReqs = queryMap.get(queryId) ?? [];
    if (queryReqs.length) return queryReqs[0];
  }

  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    loadPageviewCache().then(async () => {
      try {
      const u = new URL(details.url);
      if (u.hostname === 'securepubads.g.doubleclick.net' && u.pathname.includes('/gampad/ads')) {
        const parsed = parseGamUrl(details.url);
        pushRequest(details.tabId, parsed);

        if (details.tabId >= 0 && parsed.slotId) {
          chrome.tabs.sendMessage(details.tabId, {
            type: 'GAM_SLOT_UPDATE',
            slotId: parsed.slotId,
            bidder: parsed.hb_bidder,
            creativeId: parsed.hb_crid,
            adDomain: parsed.ad_domain,
            gamId: parsed.gamId,
            adUnit: parsed.adUnit,
            ts: parsed.ts
          }).catch(() => {});
        }
        await persistPageviewCache();
      }
    } catch {}
    }).catch(() => {});
  },
  { urls: ['*://securepubads.g.doubleclick.net/gampad/ads*'] }
);

chrome.tabs.onRemoved.addListener((tabId) => { clearTabState(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearTabState(tabId);
  }
});

chrome.runtime.onStartup.addListener(() => { loadStateCache(); loadPageviewCache(); });
chrome.runtime.onInstalled.addListener(() => { loadStateCache(); loadPageviewCache(); });
loadStateCache();
loadPageviewCache();


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? msg?.tabId;

  (async () => {
    if (msg?.type === 'GET_GAM_FOR_SLOT') {
      await loadPageviewCache();
      const slotId = msg.slotId || null;
      const queryId = msg.queryId || null;
      const req = bestMatchForTab(tabId, slotId, queryId);
      sendResponse({ ok: true, request: req });
      return;
    }

    if (msg?.type === 'SYNC_PAGE_SLOTS' && tabId >= 0) {
      await loadPageviewCache();
      syncPageSlots(tabId, msg.slots || []);
      await persistPageviewCache();
      sendResponse({ ok: true, count: Array.isArray(msg.slots) ? msg.slots.length : 0 });
      return;
    }

    if (msg?.type === 'GET_SLOT_HISTORY') {
      await loadPageviewCache();
      const slotId = msg.slotId || null;
      const queryId = msg.queryId || null;
      const slotArr = slotId ? getSlotHistoryForTab(tabId, slotId, queryId) : [];
      sendResponse({ ok: true, slotId, queryId, requests: slotArr });
      return;
    }

    if (msg?.type === 'SET_ACTIVE_INSPECTOR_TAB') {
      await setActiveInspectorTabId(msg.tabId);
      sendResponse({ ok: true, tabId: activeInspectorTabId });
      return;
    }

    if (msg?.type === 'GET_ACTIVE_INSPECTOR_TAB') {
      maybePromoteActiveInspectorTab();
      sendResponse({ ok: true, tabId: activeInspectorTabId, state: activeInspectorTabId != null ? getTabState(activeInspectorTabId) : null, session: inspectorSession });
      return;
    }

    if (msg?.type === 'GET_INSPECTOR_SESSION') {
      maybePromoteActiveInspectorTab();
      sendResponse({ ok: true, session: inspectorSession, tabId: activeInspectorTabId, state: activeInspectorTabId != null ? getTabState(activeInspectorTabId) : null });
      return;
    }

    if (msg?.type === 'SET_TAB_STATE' && tabId >= 0) {
      const state = await setTabState(tabId, msg.state, msg.tab || null);
      sendResponse({ ok: true, state, activeTabId: activeInspectorTabId, session: inspectorSession });
      return;
    }

    if (msg?.type === 'GET_TAB_STATE' && tabId >= 0) {
      sendResponse({ ok: true, state: getTabState(tabId), activeTabId: activeInspectorTabId, session: inspectorSession });
      return;
    }

    if (msg?.type === 'RESET_TAB_STATE' && tabId >= 0) {
      await clearTabState(tabId);
      sendResponse({ ok: true, state: { enabled: false, pausedReady: false }, activeTabId: activeInspectorTabId });
      return;
    }

    sendResponse({ ok: false });
  })().catch((err) => {
    try {
      sendResponse({ ok: false, error: String(err && err.message || err || 'unknown error') });
    } catch {}
  });

  return true;
});

