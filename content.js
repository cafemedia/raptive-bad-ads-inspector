const STATE = {
  enabled: false,
  overlays: new Map(),
  rafId: null,
  mo: null,
  restoreTried: false,
  panelHost: null,
  panelShadow: null,
  panelEl: null,
  selectedSlotId: null,
  histHost: null,
  histShadow: null,
  histEl: null,
  histSelectedSlotId: null,
  latestBySlot: new Map(),
  selectedOverlayToken: 0,
  lastSlotSyncKey: '',
  drag: { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0, target: null },
  injectedReadyPromise: null
};

const UI = {
  font: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
  purple: '#6C63FF',
  purpleHover: '#5B53F0',
  text: '#111827',
  subtext: '#374151',
  border: 'rgba(17,24,39,.14)',
  shadow: '0 10px 30px rgba(0,0,0,.18)'
};

const SLOT_SELECTOR = [
  'div.adthrive-ad[id]',
  '[data-google-query-id][id]',
  '[id^="google_ads_iframe"]',
  '[data-adthrive-slot][id]',
  '[data-slot-name][id]'
].join(',');

function stopRefresh() {
  const post = () => window.postMessage({ type: 'RAPTURE_STOP_REFRESH' }, '*');
  post();
  setTimeout(post, 50);
  setTimeout(post, 200);
}

function resumeRefresh() {
  const post = () => window.postMessage({ type: 'RAPTURE_RESUME_REFRESH' }, '*');
  post();
  setTimeout(post, 50);
}

function ensureInjectedRefreshScript() {
  try {
    if (document.documentElement.dataset.raptiveRefreshInjected === '1') return Promise.resolve(true);
    if (STATE.injectedReadyPromise) return STATE.injectedReadyPromise;

    STATE.injectedReadyPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected.js');
      s.async = false;
      s.onload = () => {
        document.documentElement.dataset.raptiveRefreshInjected = '1';
        STATE.injectedReadyPromise = Promise.resolve(true);
        s.remove();
        resolve(true);
      };
      s.onerror = () => {
        STATE.injectedReadyPromise = null;
        resolve(false);
      };
      (document.head || document.documentElement).appendChild(s);
    });

    return STATE.injectedReadyPromise;
  } catch {
    return Promise.resolve(false);
  }
}

function injectPageCode(js) {
  const s = document.createElement('script');
  s.textContent = js;
  (document.documentElement || document.head).appendChild(s);
  s.remove();
}

function pauseRefreshMr() {
  injectPageCode(`
    (function(){
      let tries = 0;
      const tick = () => {
        tries++;
        try {
          if (window.adthrive && typeof window.adthrive.mr === 'function') {
            window.adthrive.mr();
            return;
          }
        } catch (e) {}
        if (tries < 40) setTimeout(tick, 250);
      };
      tick();
    })();
  `);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function safeText(v) {
  return String(v || '');
}

function startDrag(panel, e) {
  e.preventDefault();
  const rect = panel.getBoundingClientRect();
  STATE.drag.active = true;
  STATE.drag.startX = e.clientX;
  STATE.drag.startY = e.clientY;
  STATE.drag.startLeft = rect.left;
  STATE.drag.startTop = rect.top;
  STATE.drag.target = panel;

  panel.style.left = rect.left + 'px';
  panel.style.top = rect.top + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';

  const onMove = (ev) => {
    if (!STATE.drag.active || STATE.drag.target !== panel) return;
    const dx = ev.clientX - STATE.drag.startX;
    const dy = ev.clientY - STATE.drag.startY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = panel.getBoundingClientRect().width;
    const h = panel.getBoundingClientRect().height;
    panel.style.left = clamp(STATE.drag.startLeft + dx, 8, vw - w - 8) + 'px';
    panel.style.top = clamp(STATE.drag.startTop + dy, 8, vh - h - 8) + 'px';
  };

  const onUp = () => {
    STATE.drag.active = false;
    STATE.drag.target = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
  };

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
}

function buildCopyText(data) {
  return [
    `Ad Unit: ${safeText(data.adUnit)}`,
    `Query ID: ${safeText(data.queryId)}`,
    `Bidder: ${safeText(data.bidder)}`,
    `Creative ID: ${safeText(data.creativeId)}`,
    `Ad Domain: ${safeText(data.adDomain)}`
  ].join('\n');
}

function setInspectorPanel(data) {
  ensureInspectorPanel();
  const p = STATE.panelEl;
  p.querySelector('#adUnit').textContent = safeText(data.adUnit);
  p.querySelector('#queryId').textContent = safeText(data.queryId);
  p.querySelector('#bidder').textContent = safeText(data.bidder);
  p.querySelector('#creativeId').textContent = safeText(data.creativeId);
  p.querySelector('#adDomain').textContent = safeText(data.adDomain);
  p.classList.remove('hidden');
}

function refreshInspectorIfSelected(slotId) {
  if (!STATE.selectedSlotId || slotId !== STATE.selectedSlotId) return;
  const live = STATE.latestBySlot.get(slotId) || {};
  setInspectorPanel({
    adUnit: live.adUnit || '',
    queryId: live.queryId || '',
    bidder: live.bidder || '',
    creativeId: live.creativeId || '',
    adDomain: live.adDomain || ''
  });
}

function ensureInspectorPanel() {
  if (STATE.panelEl) return;
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.top = '0';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .panel { position: fixed; right: 16px; bottom: 16px; width: 440px; max-width: calc(100vw - 32px); background: #fff; color: ${UI.text}; border: 1px solid ${UI.border}; border-radius: 14px; box-shadow: ${UI.shadow}; padding: 14px; font-family: ${UI.font}; pointer-events: auto; }
    .hidden { display: none !important; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: move; user-select: none; }
    .title { font-size: 16px; font-weight: 800; margin: 0; }
    .kv { margin-top: 10px; display: grid; grid-template-columns: 110px 1fr; gap: 8px 10px; }
    .k { font-size: 12px; color: ${UI.subtext}; font-weight: 800; }
    .v { font-size: 12px; color: ${UI.text}; font-weight: 700; word-break: break-word; }
    .actions { margin-top: 12px; display: flex; gap: 10px; justify-content: flex-end; }
    .btn, .ghost { all: unset; font-family: ${UI.font}; border-radius: 10px; padding: 10px 12px; font-size: 13px; font-weight: 800; cursor: pointer; }
    .btn { background: ${UI.purple}; color: #fff; box-shadow: 0 6px 18px rgba(17,24,39,.14); }
    .btn:hover { background: ${UI.purpleHover}; }
    .ghost { background: #fff; color: ${UI.text}; border: 1px solid ${UI.border}; }
    .ghost:hover { background: rgba(17,24,39,.04); }
  `;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel hidden';
  panel.innerHTML = `
    <div class="row" id="dragbar">
      <div class="title">Ad Info</div>
      <button id="close" class="ghost">Close</button>
    </div>
    <div class="kv">
      <div class="k">Ad Unit</div><div class="v" id="adUnit"></div>
      <div class="k">Query ID</div><div class="v" id="queryId"></div>
      <div class="k">Bidder</div><div class="v" id="bidder"></div>
      <div class="k">Creative ID</div><div class="v" id="creativeId"></div>
      <div class="k">Ad Domain</div><div class="v" id="adDomain"></div>
    </div>
    <div class="actions"><button id="copy" class="btn">Copy</button></div>
  `;
  shadow.appendChild(panel);

  panel.querySelector('#close').addEventListener('click', () => panel.classList.add('hidden'));
  panel.querySelector('#copy').addEventListener('click', async () => {
    const text = buildCopyText({
      adUnit: panel.querySelector('#adUnit').textContent,
      queryId: panel.querySelector('#queryId').textContent,
      bidder: panel.querySelector('#bidder').textContent,
      creativeId: panel.querySelector('#creativeId').textContent,
      adDomain: panel.querySelector('#adDomain').textContent
    });
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  });
  panel.querySelector('#dragbar').addEventListener('mousedown', (e) => {
    if (e.target && e.target.id === 'close') return;
    startDrag(panel, e);
  });

  STATE.panelHost = host;
  STATE.panelShadow = shadow;
  STATE.panelEl = panel;
}

function ensureHistoryPanel() {
  if (STATE.histEl) return;
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.top = '0';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .panel { position: fixed; left: 16px; bottom: 16px; width: min(980px, calc(100vw - 32px)); max-height: min(70vh, 720px); overflow: hidden; background: #fff; color: ${UI.text}; border: 1px solid ${UI.border}; border-radius: 14px; box-shadow: ${UI.shadow}; padding: 14px; font-family: ${UI.font}; pointer-events: auto; }
    .hidden { display: none !important; }
    .head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; user-select:none; cursor:move; }
    .title { font-size: 16px; font-weight: 800; }
    .sub { font-size: 12px; color:${UI.subtext}; margin-top:4px; }
    .tableWrap { overflow:auto; max-height: calc(70vh - 120px); margin-top:12px; border:1px solid ${UI.border}; border-radius:12px; }
    table { width:100%; border-collapse: collapse; font-size:12px; }
    th, td { padding:10px; border-bottom:1px solid rgba(17,24,39,.08); text-align:left; vertical-align:top; }
    thead th { position: sticky; top: 0; background:#fff; z-index:1; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .btn, .ghost, .copyBtn { all: unset; font-family:${UI.font}; border-radius:10px; padding:8px 10px; font-size:12px; font-weight:800; cursor:pointer; }
    .btn { background:${UI.purple}; color:#fff; }
    .btn:hover { background:${UI.purpleHover}; }
    .ghost, .copyBtn { background:#fff; color:${UI.text}; border:1px solid ${UI.border}; }
    .ghost:hover, .copyBtn:hover { background:rgba(17,24,39,.04); }
    .empty { padding:16px; color:${UI.subtext}; }
  `;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel hidden';
  panel.innerHTML = `
    <div class="head" id="dragbar">
      <div>
        <div class="title">Slot Request History</div>
        <div class="sub" id="slotTitle"></div>
      </div>
      <div class="actions">
        <button id="exportJson" class="ghost">Export JSON</button>
        <button id="exportTsv" class="ghost">Export TSV</button>
        <button id="close" class="ghost">Close</button>
      </div>
    </div>
    <div class="tableWrap">
      <table>
        <thead>
          <tr>
            <th style="width:120px;">Time</th>
            <th style="width:170px;">Ad Unit</th>
            <th style="width:120px;">Query ID</th>
            <th style="width:120px;">Bidder</th>
            <th style="width:140px;">Creative ID</th>
            <th>Ad Domain</th>
            <th style="width:90px;"></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="empty" class="empty hidden">No requests captured yet for this slot.</div>
    </div>
  `;
  shadow.appendChild(panel);

  panel.querySelector('#close').addEventListener('click', () => panel.classList.add('hidden'));
  panel.querySelector('#dragbar').addEventListener('mousedown', (e) => {
    if (e.target && e.target.id === 'close') return;
    startDrag(panel, e);
  });

  panel.querySelector('#exportJson').addEventListener('click', () => downloadHistory('json'));
  panel.querySelector('#exportTsv').addEventListener('click', () => downloadHistory('tsv'));

  STATE.histHost = host;
  STATE.histShadow = shadow;
  STATE.histEl = panel;
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function getQueryIdForElement(el) {
  if (!el?.getAttribute) return '';
  const direct = el.getAttribute('data-google-query-id') || el.getAttribute('google-query-id') || '';
  if (direct) return direct;
  const nested = el.querySelector?.('[data-google-query-id], [google-query-id]');
  if (nested?.getAttribute) {
    return nested.getAttribute('data-google-query-id') || nested.getAttribute('google-query-id') || '';
  }
  return '';
}

function getQueryIdForSlot(slotId) {
  const overlay = STATE.overlays.get(slotId);
  if (overlay?.slotEl) {
    const fromOverlay = getQueryIdForElement(overlay.slotEl);
    if (fromOverlay) return fromOverlay;
  }
  const el = document.getElementById(slotId);
  return getQueryIdForElement(el);
}

function normalizeSlotId(el) {
  if (!el) return '';
  return el.id || el.getAttribute('data-slot-name') || el.getAttribute('data-adthrive-slot') || '';
}

function slotScore(el, slotId) {
  let score = 0;
  if (el.matches('div.adthrive-ad[id]')) score += 10;
  if (el.hasAttribute('data-google-query-id')) score += 8;
  if (el.matches('[id^="google_ads_iframe"]')) score += 6;
  if (el.hasAttribute('data-adthrive-slot')) score += 4;
  if (el.hasAttribute('data-slot-name')) score += 3;
  const rect = el.getBoundingClientRect();
  score += Math.min(5, Math.round((rect.width * rect.height) / 50000));
  score -= Math.min(4, Math.round((slotId || '').length / 40));
  return score;
}

function findSlots() {
  const bestBySlot = new Map();
  for (const el of document.querySelectorAll(SLOT_SELECTOR)) {
    const slotId = normalizeSlotId(el);
    if (!slotId) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) continue;
    const existing = bestBySlot.get(slotId);
    const candidate = { el, score: slotScore(el, slotId), rect };
    if (!existing || candidate.score > existing.score) bestBySlot.set(slotId, candidate);
  }

  const candidates = Array.from(bestBySlot.values())
    .sort((a, b) => b.score - a.score || (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

  const chosen = [];
  for (const candidate of candidates) {
    const rect = candidate.rect;
    const overlapping = chosen.find((item) => {
      const r = item.getBoundingClientRect();
      const intersectionW = Math.max(0, Math.min(rect.right, r.right) - Math.max(rect.left, r.left));
      const intersectionH = Math.max(0, Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top));
      const intersectionArea = intersectionW * intersectionH;
      const smallerArea = Math.max(1, Math.min(rect.width * rect.height, r.width * r.height));
      return intersectionArea / smallerArea > 0.72;
    });
    if (!overlapping) chosen.push(candidate.el);
  }

  return chosen;
}

function buildSlotSyncPayload() {
  return findSlots()
    .map((el) => ({
      slotId: normalizeSlotId(el),
      queryId: getQueryIdForElement(el)
    }))
    .filter((slot) => slot.slotId);
}

function syncPageSlotsToBackground() {
  const slots = buildSlotSyncPayload();
  const key = JSON.stringify(slots);
  if (key === STATE.lastSlotSyncKey) return;
  STATE.lastSlotSyncKey = key;
  chrome.runtime.sendMessage({ type: 'SYNC_PAGE_SLOTS', slots }).catch(() => {});
}

function buildHistoryPayload(slotId) {
  const reqs = [];
  const tbody = STATE.histEl?.querySelector('#rows');
  if (!tbody) return reqs;
  for (const row of tbody.querySelectorAll('tr')) {
    const tds = row.querySelectorAll('td');
    if (tds.length < 6) continue;
    reqs.push({
      slotId,
      time: tds[0].textContent,
      adUnit: tds[1].textContent,
      queryId: tds[2].textContent,
      bidder: tds[3].textContent,
      creativeId: tds[4].textContent,
      adDomain: tds[5].textContent
    });
  }
  return reqs;
}

function downloadText(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadHistory(kind) {
  const slotId = STATE.histSelectedSlotId || 'slot-history';
  const rows = buildHistoryPayload(slotId);
  if (!rows.length) return;

  if (kind === 'json') {
    downloadText(`${slotId}-history.json`, JSON.stringify(rows, null, 2), 'application/json');
    return;
  }

  const header = ['slotId', 'time', 'adUnit', 'queryId', 'bidder', 'creativeId', 'adDomain'];
  const lines = [header.join('\t')];
  for (const row of rows) {
    lines.push(header.map((k) => String(row[k] || '').replaceAll('\t', ' ')).join('\t'));
  }
  downloadText(`${slotId}-history.tsv`, lines.join('\n'), 'text/tab-separated-values');
}

async function openHistory(slotId) {
  ensureHistoryPanel();
  STATE.histSelectedSlotId = slotId;
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'GET_SLOT_HISTORY', slotId, queryId: getQueryIdForSlot(slotId) });
  } catch {}

  const reqs = resp?.requests || [];
  const p = STATE.histEl;
  p.querySelector('#slotTitle').textContent = slotId;
  const tbody = p.querySelector('#rows');
  const empty = p.querySelector('#empty');
  tbody.innerHTML = '';

  for (const r of reqs) {
    const tr = document.createElement('tr');
    const cells = [
      fmtTime(r.ts),
      r.adUnit || '',
      r.gamId || getQueryIdForSlot(slotId),
      r.hb_bidder || '',
      r.hb_crid || '',
      r.ad_domain || ''
    ];

    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }

    const tdCopy = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'copyBtn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = [
        `Time: ${fmtTime(r.ts)}`,
        `Ad Unit: ${r.adUnit || ''}`,
        `Query ID: ${r.gamId || getQueryIdForSlot(slotId) || ''}`,
        `Bidder: ${r.hb_bidder || ''}`,
        `Creative ID: ${r.hb_crid || ''}`,
        `Ad Domain: ${r.ad_domain || ''}`
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    });
    tdCopy.appendChild(btn);
    tr.appendChild(tdCopy);
    tbody.appendChild(tr);
  }

  empty.classList.toggle('hidden', reqs.length > 0);
  p.classList.remove('hidden');
}

function panelRect(panel) {
  if (!panel || panel.classList.contains('hidden')) return null;
  return panel.getBoundingClientRect();
}

function rectsOverlap(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

function createOverlay(slotEl) {
  const slotId = normalizeSlotId(slotEl);
  if (!slotId || STATE.overlays.has(slotId)) return;

  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.top = '0';
  host.style.zIndex = '2147483646';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .btn { all: unset; font-family:${UI.font}; background:${UI.purple}; color:#fff; border-radius:10px; padding:8px 10px; font-size:13px; font-weight:800; cursor:pointer; box-shadow:0 6px 18px rgba(17,24,39,.14); pointer-events:auto; position:absolute; top:8px; right:8px; max-width:calc(100% - 16px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .btn:hover { background:${UI.purpleHover}; }
    .active { outline:2px solid rgba(108,99,255,.28); outline-offset:2px; }
  `;
  shadow.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'Ad info';
  shadow.appendChild(btn);

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const clickToken = ++STATE.selectedOverlayToken;
    STATE.selectedSlotId = slotId;
    for (const [id, overlay] of STATE.overlays.entries()) {
      overlay.btn.classList.toggle('active', id === slotId);
    }

    const live = STATE.latestBySlot.get(slotId) || {};
    const queryId = getQueryIdForElement(slotEl) || live.queryId || '';
    setInspectorPanel({
      adUnit: live.adUnit || '',
      queryId,
      bidder: live.bidder || '',
      creativeId: live.creativeId || '',
      adDomain: live.adDomain || ''
    });

    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_GAM_FOR_SLOT', slotId, queryId });
      const req = res?.request;
      if (clickToken !== STATE.selectedOverlayToken || STATE.selectedSlotId !== slotId) return;
      if (req) {
        setInspectorPanel({
          adUnit: req.adUnit || live.adUnit || '',
          queryId: req.gamId || queryId || live.queryId || '',
          bidder: req.hb_bidder || live.bidder || '',
          creativeId: req.hb_crid || live.creativeId || '',
          adDomain: req.ad_domain || live.adDomain || ''
        });
      }
    } catch {}
  });

  STATE.overlays.set(slotId, { host, shadow, btn, slotEl });
}

function updatePositions() {
  if (!STATE.enabled) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const inspRect = panelRect(STATE.panelEl);
  const histRect = panelRect(STATE.histEl);

  for (const [slotId, o] of STATE.overlays.entries()) {
    const el = o.slotEl;
    if (!el || !el.isConnected) {
      try { o.host.remove(); } catch {}
      STATE.overlays.delete(slotId);
      continue;
    }

    const r = el.getBoundingClientRect();
    const offscreen = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width < 10 || r.height < 10;
    if (offscreen) {
      o.host.style.display = 'none';
      continue;
    }

    o.host.style.display = 'block';
    o.host.style.left = `${r.left}px`;
    o.host.style.top = `${r.top}px`;
    o.host.style.width = `${r.width}px`;
    o.host.style.height = `${r.height}px`;

    const overlapInspector = inspRect && rectsOverlap(r, inspRect);
    const overlapHistory = histRect && rectsOverlap(r, histRect);
    if (overlapInspector || overlapHistory) {
      o.btn.style.left = '8px';
      o.btn.style.right = 'auto';
    } else {
      o.btn.style.left = 'auto';
      o.btn.style.right = '8px';
    }
  }

  STATE.rafId = requestAnimationFrame(updatePositions);
}

function scanSlots() {
  const slots = findSlots();
  for (const slot of slots) {
    const slotId = normalizeSlotId(slot);
    createOverlay(slot);
    const existing = STATE.latestBySlot.get(slotId) || {};
    const qid = getQueryIdForSlot(slotId);
    if (qid && existing.queryId !== qid) STATE.latestBySlot.set(slotId, { ...existing, queryId: qid });
    const cached = STATE.latestBySlot.get(slotId);
    const overlay = STATE.overlays.get(slotId);
    if (overlay && cached?.bidder) {
      overlay.btn.textContent = cached.bidder ? `Ad info (${cached.bidder})` : 'Ad info';
      overlay.btn.title = cached.creativeId ? `Creative ID: ${cached.creativeId}` : '';
    }
  }
  syncPageSlotsToBackground();
}

function start() {
  if (STATE.enabled) return;
  STATE.enabled = true;
  ensureInjectedRefreshScript();
  stopRefresh();
  pauseRefreshMr();
  ensureInspectorPanel();
  ensureHistoryPanel();
  scanSlots();
  STATE.mo = new MutationObserver(() => scanSlots());
  STATE.mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-google-query-id'] });
  if (!STATE.rafId) STATE.rafId = requestAnimationFrame(updatePositions);
}

function stop() {
  STATE.enabled = false;
  if (STATE.mo) {
    try { STATE.mo.disconnect(); } catch {}
    STATE.mo = null;
  }
  if (STATE.rafId) {
    cancelAnimationFrame(STATE.rafId);
    STATE.rafId = null;
  }
  for (const o of STATE.overlays.values()) {
    try { o.host.remove(); } catch {}
  }
  STATE.overlays.clear();
  if (STATE.panelEl) STATE.panelEl.classList.add('hidden');
  if (STATE.histEl) STATE.histEl.classList.add('hidden');
  STATE.selectedSlotId = null;
  STATE.histSelectedSlotId = null;
}

async function restoreSessionState() {
  if (STATE.restoreTried) return;
  STATE.restoreTried = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' });
    const state = resp?.state || {};
    if (state.pausedReady) {
      await ensureInjectedRefreshScript();
      stopRefresh();
      pauseRefreshMr();
    }
    if (state.enabled) start();
  } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PAUSE_REFRESH') {
    (async () => {
      await ensureInjectedRefreshScript();
      stopRefresh();
      pauseRefreshMr();
      sendResponse?.({ ok: true });
    })();
    return true;
  }

  if (msg?.type === 'RESUME_REFRESH') {
    (async () => {
      await ensureInjectedRefreshScript();
      resumeRefresh();
      sendResponse?.({ ok: true });
    })();
    return true;
  }

  if (msg?.type === 'TOGGLE_INSPECTOR') {
    if (msg.enabled) start();
    else stop();
    sendResponse?.({ ok: true, enabled: STATE.enabled });
    return true;
  }

  if (msg?.type === 'GAM_SLOT_UPDATE') {
    const { slotId, bidder, creativeId, adDomain, adUnit, gamId, ts } = msg;
    if (!slotId) return;
    STATE.latestBySlot.set(slotId, {
      bidder,
      creativeId,
      adDomain,
      queryId: gamId || getQueryIdForSlot(slotId),
      adUnit,
      ts
    });
    const overlay = STATE.overlays.get(slotId);
    if (overlay && bidder) {
      overlay.btn.textContent = bidder ? `Ad info (${bidder})` : 'Ad info';
      overlay.btn.title = creativeId ? `Creative ID: ${creativeId}` : '';
    }
    refreshInspectorIfSelected(slotId);
  }

  if (msg?.type === 'GET_PAGE_SLOTS') {
    const slots = findSlots().map((s) => normalizeSlotId(s)).filter(Boolean);
    syncPageSlotsToBackground();
    sendResponse({ ok: true, slots: Array.from(new Set(slots)) });
    return true;
  }

  if (msg?.type === 'OPEN_SLOT_HISTORY') {
    if (msg.slotId) openHistory(msg.slotId);
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg?.type === 'RESTORE_SESSION_STATE') {
    (async () => {
      const state = msg.state || {};
      if (state.pausedReady) {
        await ensureInjectedRefreshScript();
        stopRefresh();
        pauseRefreshMr();
      }
      if (state.enabled) start();
      sendResponse?.({ ok: true });
    })();
    return true;
  }
});

restoreSessionState();
