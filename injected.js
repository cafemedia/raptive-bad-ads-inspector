(function () {
  'use strict';
  if (window.__raptiveRefreshGuardInstalled) return;
  window.__raptiveRefreshGuardInstalled = true;

  const state = {
    paused: false,
    original: {
      setInterval: window.setInterval,
      setTimeout: window.setTimeout
    },
    blockedIntervals: new Set(),
    blockedTimeouts: new Set()
  };

  function safeLog(...args) {
    try { console.log(...args); } catch {}
  }

  function isAdLikeCallback(cb) {
    let text = '';
    try {
      if (typeof cb === 'function') text = Function.prototype.toString.call(cb);
      else if (typeof cb === 'string') text = cb;
    } catch {
      return false;
    }
    text = text.toLowerCase();
    return ['googletag', 'pubads', 'refresh(', 'gpt', 'prebid', 'pbjs', 'requestbids', 'adthrive', 'raptive', 'slot', 'gampad'].some((n) => text.includes(n));
  }

  function wrapWhenPresent(getter, name, methodName) {
    try {
      const target = getter();
      if (!target || typeof target[methodName] !== 'function') return;
      if (target[methodName].__raptiveWrapped) return;
      const orig = target[methodName].bind(target);
      target[methodName] = function (...args) {
        if (state.paused) {
          safeLog(`[Raptive Bad Ads Inspector] Blocked ${name}.${methodName}()`, args);
          return;
        }
        return orig(...args);
      };
      target[methodName].__raptiveWrapped = true;
    } catch {}
  }

  function patchTimers() {
    try {
      if (window.setInterval.__raptiveWrapped) return;
      window.setInterval = function (cb, delay, ...rest) {
        if (state.paused && isAdLikeCallback(cb)) {
          const fakeId = Math.floor(Math.random() * 1e9);
          state.blockedIntervals.add(fakeId);
          safeLog('[Raptive Bad Ads Inspector] Blocked setInterval (ad-like)', { delay });
          return fakeId;
        }
        return state.original.setInterval(cb, delay, ...rest);
      };
      window.setInterval.__raptiveWrapped = true;

      window.setTimeout = function (cb, delay, ...rest) {
        if (state.paused && isAdLikeCallback(cb)) {
          const fakeId = Math.floor(Math.random() * 1e9);
          state.blockedTimeouts.add(fakeId);
          safeLog('[Raptive Bad Ads Inspector] Blocked setTimeout (ad-like)', { delay });
          return fakeId;
        }
        return state.original.setTimeout(cb, delay, ...rest);
      };
      window.setTimeout.__raptiveWrapped = true;
    } catch {}
  }

  function applyGuards() {
    wrapWhenPresent(() => window.googletag?.pubads?.(), 'googletag.pubads()', 'refresh');
    wrapWhenPresent(() => window.pbjs, 'pbjs', 'requestBids');
    wrapWhenPresent(() => window.pbjs, 'pbjs', 'setTargetingForGPTAsync');
    wrapWhenPresent(() => window.apstag, 'apstag', 'fetchBids');
    wrapWhenPresent(() => window.adthrive, 'adthrive', 'refreshAds');
    wrapWhenPresent(() => window.adthrive, 'adthrive', 'refreshAllSlots');
    wrapWhenPresent(() => window.adthrive, 'adthrive', 'refreshSlot');
    wrapWhenPresent(() => window.adthrive, 'adthrive', 'refresh');
    wrapWhenPresent(() => window.raptive, 'raptive', 'refreshAds');
    wrapWhenPresent(() => window.raptive, 'raptive', 'refreshAllSlots');
    wrapWhenPresent(() => window.raptive, 'raptive', 'refreshSlot');
    wrapWhenPresent(() => window.raptive, 'raptive', 'refresh');
    patchTimers();
  }

  function resume() {
    state.paused = false;
    safeLog('[Raptive Bad Ads Inspector] Resuming ad refresh');
  }

  function stop() {
    state.paused = true;
    applyGuards();
    let tries = 0;
    const tick = () => {
      tries += 1;
      applyGuards();
      if (tries < 20) state.original.setTimeout(tick, 250);
    };
    tick();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.type) return;
    if (event.data.type === 'RAPTURE_STOP_REFRESH') stop();
    if (event.data.type === 'RAPTURE_RESUME_REFRESH') resume();
  });
})();
