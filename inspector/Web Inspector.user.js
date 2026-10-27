// ==UserScript==
// @name         Web Inspector
// @namespace    https://github.com/iant89/userscripts
// @version      0.4.1
// @description  A mobile-friendly, self-contained web inspector for the current page.
// @match        *://*/*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

/*
 * Web Inspector — dependency-free userscript.
 * Manager storage is used only for window preferences. Where possible, the
 * inspector runs in the page context; JavaScript execution is available only
 * after an explicit Execute action in the Console.
 */
(function webInspector(options) {
  'use strict';

  if (!options) {
    // Manager storage is shared between websites, unlike page localStorage.
    // A small bridge keeps the inspector itself in the page context when the
    // site's CSP permits inline scripts. No privileged API is exposed there.
    const modern = typeof GM === 'object' && GM ? GM : null;
    const manager = typeof GM_getValue === 'function' && typeof GM_setValue === 'function'
      ? { get: (key) => GM_getValue(key, null), set: (key, value) => GM_setValue(key, value) }
      : modern && typeof modern.getValue === 'function' && typeof modern.setValue === 'function'
        ? { get: (key) => modern.getValue(key, null), set: (key, value) => modern.setValue(key, value) }
        : null;
    if (!manager) { webInspector({}); return; }
    manager.list = typeof GM_listValues === 'function' ? () => GM_listValues()
      : typeof modern?.listValues === 'function' ? () => modern.listValues() : null;
    manager.remove = typeof GM_deleteValue === 'function' ? (key) => GM_deleteValue(key)
      : typeof modern?.deleteValue === 'function' ? (key) => modern.deleteValue(key) : null;

    const key = 'webInspector.preferences.v1';
    const journalPrefix = `${key}.journal.`;
    const useJournal = !!manager.list && !!manager.remove;
    let cameFromAnotherOrigin = false;
    try { cameFromAnotherOrigin = !!document.referrer && new URL(document.referrer).origin !== location.origin; } catch (_) {}
    const channel = `web-inspector-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const syncChannel = `${channel}-sync`;
    let mounted = false, scheduled = false, detached = false, ready = false;
    let initial = null, initialKnown = false, latestWrite = null, writeRevision = 0;
    let timeout = 0, retries = [], cleanupTimer = 0, cleanupBefore = 0;

    // Only a small, validated preference record can cross from the page into
    // manager storage. In particular, page data and console commands cannot.
    function sharedRecord(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      if (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(value[k]) && Math.abs(value[k]) <= 1000000)) return null;
      if (value.width <= 0 || value.height <= 0 || !['float', 'left', 'right', 'top', 'bottom'].includes(value.dock)) return null;
      if (typeof value.closed !== 'boolean' || typeof value.collapsed !== 'boolean') return null;
      if (!['elements', 'console', 'source', 'resources'].includes(value.activeTab) || !['local', 'session', 'cookie'].includes(value.lastResourceType)) return null;
      if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > Date.now() + 86400000) return null;
      return {
        x: value.x, y: value.y, width: value.width, height: value.height, dock: value.dock,
        collapsed: value.collapsed, closed: value.closed, activeTab: value.activeTab,
        theme: 'dark', lastResourceType: value.lastResourceType,
        opacity: typeof value.opacity === 'boolean' ? value.opacity : true, updatedAt: value.updatedAt,
      };
    }
    function journalTime(name) {
      if (typeof name !== 'string' || !name.startsWith(journalPrefix)) return 0;
      const match = /^(\d+)-/.exec(name.slice(journalPrefix.length));
      return match ? Number(match[1]) : 0;
    }
    function readShared() {
      const base = manager.get(key);
      if (!useJournal) return base;
      let listing;
      try { listing = manager.list(); } catch (_) { return base; }
      return Promise.all([Promise.resolve(base), Promise.resolve(listing).catch(() => [])]).then(([value, names]) => {
        const candidates = (Array.isArray(names) ? names : []).filter(name => journalTime(name))
          .sort((a, b) => journalTime(b) - journalTime(a)).slice(0, 16);
        return Promise.all(candidates.map(name => {
          try { return Promise.resolve(manager.get(name)).catch(() => null); } catch (_) { return null; }
        })).then(records => {
          let newest = sharedRecord(value);
          for (const item of records) {
            const record = sharedRecord(item);
            if (record && (!newest || record.updatedAt > newest.updatedAt)) newest = record;
          }
          return newest;
        });
      });
    }
    function scheduleCompaction(timestamp) {
      if (!useJournal || detached) return;
      cleanupBefore = Math.max(cleanupBefore, timestamp);
      if (cleanupTimer) return;
      cleanupTimer = setTimeout(() => {
        cleanupTimer = 0;
        const threshold = cleanupBefore; cleanupBefore = 0;
        let listing;
        try { listing = manager.list(); } catch (_) { return; }
        Promise.resolve(listing).then(names => {
          if (detached || !Array.isArray(names) || !names.some(name => journalTime(name) >= threshold)) return;
          // A durable equal/newer journal entry exists, so older entries are safe to remove.
          for (const name of names) {
            const time = journalTime(name);
            if (!time || time >= threshold) continue;
            try { Promise.resolve(manager.remove(name)).catch(() => {}); } catch (_) {}
          }
        }, () => {});
      }, 500);
    }
    function writeShared(record, revision) {
      let result;
      try { result = manager.set(key, record); } catch (_) { return; }
      Promise.resolve(result).then(() => {
        // Repair the compatibility key when a manager finishes writes out of order.
        if (!detached && revision < writeRevision) writeShared(latestWrite, writeRevision);
      }, () => {});
    }
    function appendJournal(record, revision) {
      if (!useJournal) return;
      // A unique key keeps a late older write from overwriting the latest choice,
      // even when the source page disappears before its promises resolve.
      const name = `${journalPrefix}${record.updatedAt}-${channel}-${revision}`;
      try { Promise.resolve(manager.set(name, record)).then(() => scheduleCompaction(record.updatedAt), () => {}); } catch (_) {}
    }
    function onBridge(event) {
      if (event.detail === 'ready') { ready = true; return; }
      if (event.detail === 'destroy') {
        detached = true; clearTimeout(timeout); retries.forEach(clearTimeout); clearTimeout(cleanupTimer);
        document.removeEventListener(channel, onBridge);
        window.removeEventListener('pageshow', onPageShow);
        return;
      }
      if (typeof event.detail !== 'string' || event.detail.length > 4096) return;
      try {
        const record = sharedRecord(JSON.parse(event.detail));
        if (!record) return;
        latestWrite = record; writeRevision += 1;
        appendJournal(record, writeRevision); writeShared(record, writeRevision);
      } catch (_) { /* Ignore malformed or unavailable storage. */ }
    }
    function notifyShared(value) {
      if (detached || !mounted) return;
      try {
        const record = sharedRecord(value);
        if (record) scheduleCompaction(record.updatedAt);
        const serialized = JSON.stringify(record);
        if (serialized && serialized.length <= 4096) document.dispatchEvent(new CustomEvent(syncChannel, { detail: serialized }));
      } catch (_) { /* Ignore malformed preferences. */ }
    }
    function refreshShared() {
      let result;
      try { result = readShared(); } catch (_) { Promise.resolve().then(() => notifyShared(null)); return; }
      Promise.resolve(result).then(notifyShared, () => notifyShared(null));
    }
    function scheduleRefreshes() {
      retries.forEach(clearTimeout);
      retries = [250, 1000, 3000].map(delay => setTimeout(refreshShared, delay));
    }
    function onPageShow(event) {
      if (!event.persisted) return;
      refreshShared(); scheduleRefreshes();
    }
    document.addEventListener(channel, onBridge);
    window.addEventListener('pageshow', onPageShow);

    function mount() {
      if (detached || mounted) return;
      if (!document.documentElement) { document.addEventListener('DOMContentLoaded', mount, { once: true }); return; }
      if (document.querySelector('[data-web-inspector-host]')) {
        onBridge({ detail: 'destroy' }); return;
      }
      mounted = true;
      const saved = sharedRecord(initial);
      if (saved) scheduleCompaction(saved.updatedAt);
      const settings = { sharedState: saved, sharedKnown: initialKnown, allowMigration: !cameFromAnotherOrigin, saveEvent: channel, syncEvent: syncChannel };
      const tag = document.createElement('script');
      const serialized = JSON.stringify(settings).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      try {
        tag.textContent = `;(${webInspector.toString()})(${serialized});document.dispatchEvent(new CustomEvent(${JSON.stringify(channel)}, {detail:'ready'}));`;
        document.documentElement.appendChild(tag);
      } catch (_) { /* A page may prohibit injection or require Trusted Types. */ }
      tag.remove();
      if (!ready) {
        // Strict CSP can block the page-world bridge. Keep the UI available in
        // the userscript context and use unsafeWindow when the manager has it.
        let pageWindow = null;
        try { if (typeof unsafeWindow !== 'undefined') pageWindow = unsafeWindow; } catch (_) {}
        webInspector({ ...settings, isolated: !pageWindow, pageWindow });
      }
      // Writes from the preceding page may still be finishing as navigation
      // starts; short-lived retries reconcile them without blocking startup.
      scheduleRefreshes();
    }
    function start(value, known) {
      if (detached) return;
      initial = value; initialKnown = known;
      if (!scheduled) { scheduled = true; mount(); }
    }
    function startAfterRead(value) {
      if (mounted) { notifyShared(value); return; }
      if (!cameFromAnotherOrigin) { start(value, true); return; }
      // Give the previous origin's asynchronous manager write a moment to
      // settle before rendering; otherwise a stale "open" value can flash.
      initial = value; initialKnown = true;
      timeout = setTimeout(() => {
        let secondRead;
        try { secondRead = readShared(); } catch (_) { start(initial, true); return; }
        timeout = setTimeout(() => start(initial, true), 500);
        Promise.resolve(secondRead).then(next => {
          clearTimeout(timeout);
          if (!mounted) start(next, true); else notifyShared(next);
        }, () => { clearTimeout(timeout); if (!mounted) start(initial, true); });
      }, 200);
    }
    let read;
    try { read = readShared(); } catch (_) { start(null, false); return; }
    timeout = setTimeout(() => start(null, false), 800);
    Promise.resolve(read).then(value => { clearTimeout(timeout); startAfterRead(value); },
      () => { clearTimeout(timeout); if (!mounted) start(null, false); });
    return;
  }

  const APP_ID = 'web-inspector-host-v1';
  const INSTANCE_KEY = '__webInspectorInstanceV1';
  const STORAGE_KEY = 'webInspector.preferences.v1';
  const MAX_TREE_NODES = 500;
  const MAX_CONSOLE_ENTRIES = 250;
  const SNAP_DISTANCE = 34;
  const SNAP_DELAY = 280;
  const PICK_DRAG_THRESHOLD = 6;
  const SELECTION_OUTSET = 6;
  // BEGIN GENERATED FONT AWESOME DATA
  /*
   * Font Awesome Free 7.3.1 by Fonticons, Inc. (https://fontawesome.com).
   * Icons are licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
   * The paths are unmodified and embedded as inline SVG for this userscript.
   */
  const FA_ICONS = {
    "search": [512,512,"M416 208c0 45.9-14.9 88.3-40 122.7L502.6 457.4c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0L330.7 376C296.3 401.1 253.9 416 208 416 93.1 416 0 322.9 0 208S93.1 0 208 0 416 93.1 416 208zM208 352a144 144 0 1 0 0-288 144 144 0 1 0 0 288z"],
    "minus": [448,512,"M0 256c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32z"],
    "close": [384,512,"M55.1 73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L147.2 256 9.9 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192.5 301.3 329.9 438.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.8 256 375.1 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192.5 210.7 55.1 73.4z"],
    "code": [576,512,"M360.8 1.2c-17-4.9-34.7 5-39.6 22l-128 448c-4.9 17 5 34.7 22 39.6s34.7-5 39.6-22l128-448c4.9-17-5-34.7-22-39.6zm64.6 136.1c-12.5 12.5-12.5 32.8 0 45.3l73.4 73.4-73.4 73.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l96-96c12.5-12.5 12.5-32.8 0-45.3l-96-96c-12.5-12.5-32.8-12.5-45.3 0zm-274.7 0c-12.5-12.5-32.8-12.5-45.3 0l-96 96c-12.5 12.5-12.5 32.8 0 45.3l96 96c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256 150.6 182.6c12.5-12.5 12.5-32.8 0-45.3z"],
    "terminal": [512,512,"M9.4 118.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l160 160c12.5 12.5 12.5 32.8 0 45.3l-160 160c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L146.7 256 9.4 118.6zM224 384l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32z"],
    "file-code": [384,512,"M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM154.2 295.6c8.6-10.1 7.5-25.2-2.6-33.8s-25.2-7.5-33.8 2.6l-48 56c-7.7 9-7.7 22.2 0 31.2l48 56c8.6 10.1 23.8 11.2 33.8 2.6s11.2-23.8 2.6-33.8l-34.6-40.4 34.6-40.4zm112-31.2c-8.6-10.1-23.8-11.2-33.8-2.6s-11.2 23.8-2.6 33.8l34.6 40.4-34.6 40.4c-8.6 10.1-7.5 25.2 2.6 33.8s25.2 7.5 33.8-2.6l48-56c7.7-9 7.7-22.2 0-31.2l-48-56z"],
    "database": [448,512,"M448 205.8c-14.8 9.8-31.8 17.7-49.5 24-47 16.8-108.7 26.2-174.5 26.2S96.4 246.5 49.5 229.8c-17.6-6.3-34.7-14.2-49.5-24L0 288c0 44.2 100.3 80 224 80s224-35.8 224-80l0-82.2zm0-77.8l0-48C448 35.8 347.7 0 224 0S0 35.8 0 80l0 48c0 44.2 100.3 80 224 80s224-35.8 224-80zM398.5 389.8C351.6 406.5 289.9 416 224 416S96.4 406.5 49.5 389.8c-17.6-6.3-34.7-14.2-49.5-24L0 432c0 44.2 100.3 80 224 80s224-35.8 224-80l0-66.2c-14.8 9.8-31.8 17.7-49.5 24z"],
    "expand-tree": [384,512,"M214.6 470.6c-12.5 12.5-32.8 12.5-45.3 0l-160-160c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L192 402.7 329.4 265.4c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3l-160 160zm160-352l-160 160c-12.5 12.5-32.8 12.5-45.3 0l-160-160c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L192 210.7 329.4 73.4c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3z"],
    "pick": [576,512,"M288-16c17.7 0 32 14.3 32 32l0 18.3c98.1 14 175.7 91.6 189.7 189.7l18.3 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-18.3 0c-14 98.1-91.6 175.7-189.7 189.7l0 18.3c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-18.3C157.9 463.7 80.3 386.1 66.3 288L48 288c-17.7 0-32-14.3-32-32s14.3-32 32-32l18.3 0C80.3 125.9 157.9 48.3 256 34.3L256 16c0-17.7 14.3-32 32-32zM131.2 288c12.7 62.7 62.1 112.1 124.8 124.8l0-12.8c0-17.7 14.3-32 32-32s32 14.3 32 32l0 12.8c62.7-12.7 112.1-62.1 124.8-124.8L432 288c-17.7 0-32-14.3-32-32s14.3-32 32-32l12.8 0C432.1 161.3 382.7 111.9 320 99.2l0 12.8c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-12.8C193.3 111.9 143.9 161.3 131.2 224l12.8 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-12.8 0zM288 208a48 48 0 1 1 0 96 48 48 0 1 1 0-96z"],
    "eye": [576,512,"M288 32c-80.8 0-145.5 36.8-192.6 80.6-46.8 43.5-78.1 95.4-93 131.1-3.3 7.9-3.3 16.7 0 24.6 14.9 35.7 46.2 87.7 93 131.1 47.1 43.7 111.8 80.6 192.6 80.6s145.5-36.8 192.6-80.6c46.8-43.5 78.1-95.4 93-131.1 3.3-7.9 3.3-16.7 0-24.6-14.9-35.7-46.2-87.7-93-131.1-47.1-43.7-111.8-80.6-192.6-80.6zM144 256a144 144 0 1 1 288 0 144 144 0 1 1 -288 0zm144-64c0 35.3-28.7 64-64 64-11.5 0-22.3-3-31.7-8.4-1 10.9-.1 22.1 2.9 33.2 13.7 51.2 66.4 81.6 117.6 67.9s81.6-66.4 67.9-117.6c-12.2-45.7-55.5-74.8-101.1-70.8 5.3 9.3 8.4 20.1 8.4 31.7z"],
    "eye-slash": [576,512,"M41-24.9c-9.4-9.4-24.6-9.4-33.9 0S-2.3-.3 7 9.1l528 528c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-96.4-96.4c2.7-2.4 5.4-4.8 8-7.2 46.8-43.5 78.1-95.4 93-131.1 3.3-7.9 3.3-16.7 0-24.6-14.9-35.7-46.2-87.7-93-131.1-47.1-43.7-111.8-80.6-192.6-80.6-56.8 0-105.6 18.2-146 44.2L41-24.9zM204.5 138.7c23.5-16.8 52.4-26.7 83.5-26.7 79.5 0 144 64.5 144 144 0 31.1-9.9 59.9-26.7 83.5l-34.7-34.7c12.7-21.4 17-47.7 10.1-73.7-13.7-51.2-66.4-81.6-117.6-67.9-8.6 2.3-16.7 5.7-24 10l-34.7-34.7zM325.3 395.1c-11.9 3.2-24.4 4.9-37.3 4.9-79.5 0-144-64.5-144-144 0-12.9 1.7-25.4 4.9-37.3L69.4 139.2c-32.6 36.8-55 75.8-66.9 104.5-3.3 7.9-3.3 16.7 0 24.6 14.9 35.7 46.2 87.7 93 131.1 47.1 43.7 111.8 80.6 192.6 80.6 37.3 0 71.2-7.9 101.5-20.6l-64.2-64.2z"],
    "trash": [448,512,"M136.7 5.9C141.1-7.2 153.3-16 167.1-16l113.9 0c13.8 0 26 8.8 30.4 21.9L320 32 416 32c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 96C14.3 96 0 81.7 0 64S14.3 32 32 32l96 0 8.7-26.1zM32 144l384 0 0 304c0 35.3-28.7 64-64 64L96 512c-35.3 0-64-28.7-64-64l0-304zm88 64c-13.3 0-24 10.7-24 24l0 192c0 13.3 10.7 24 24 24s24-10.7 24-24l0-192c0-13.3-10.7-24-24-24zm104 0c-13.3 0-24 10.7-24 24l0 192c0 13.3 10.7 24 24 24s24-10.7 24-24l0-192c0-13.3-10.7-24-24-24zm104 0c-13.3 0-24 10.7-24 24l0 192c0 13.3 10.7 24 24 24s24-10.7 24-24l0-192c0-13.3-10.7-24-24-24z"],
    "plus": [448,512,"M256 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 160-160 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l160 0 0 160c0 17.7 14.3 32 32 32s32-14.3 32-32l0-160 160 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-160 0 0-160z"],
    "refresh": [512,512,"M488 192l-144 0c-9.7 0-18.5-5.8-22.2-14.8s-1.7-19.3 5.2-26.2l46.7-46.7c-75.3-58.6-184.3-53.3-253.5 15.9-75 75-75 196.5 0 271.5s196.5 75 271.5 0c8.2-8.2 15.5-16.9 21.9-26.1 10.1-14.5 30.1-18 44.6-7.9s18 30.1 7.9 44.6c-8.5 12.2-18.2 23.8-29.1 34.7-100 100-262.1 100-362 0S-25 175 75 75c94.3-94.3 243.7-99.6 344.3-16.2L471 7c6.9-6.9 17.2-8.9 26.2-5.2S512 14.3 512 24l0 144c0 13.3-10.7 24-24 24z"],
    "play": [448,512,"M91.2 36.9c-12.4-6.8-27.4-6.5-39.6 .7S32 57.9 32 72l0 368c0 14.1 7.5 27.2 19.6 34.4s27.2 7.5 39.6 .7l336-184c12.8-7 20.8-20.5 20.8-35.1s-8-28.1-20.8-35.1l-336-184z"],
    "copy": [448,512,"M192 0c-35.3 0-64 28.7-64 64l0 256c0 35.3 28.7 64 64 64l192 0c35.3 0 64-28.7 64-64l0-200.6c0-17.4-7.1-34.1-19.7-46.2L370.6 17.8C358.7 6.4 342.8 0 326.3 0L192 0zM64 128c-35.3 0-64 28.7-64 64L0 448c0 35.3 28.7 64 64 64l192 0c35.3 0 64-28.7 64-64l0-16-64 0 0 16-192 0 0-256 16 0 0-64-16 0z"],
    "file-lines": [384,512,"M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM120 256c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0zm0 96c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0z"],
    "broom": [576,512,"M566.6 54.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-192 192-34.7-34.7c-4.2-4.2-10-6.6-16-6.6-12.5 0-22.6 10.1-22.6 22.6l0 29.1 108.3 108.3 29.1 0c12.5 0 22.6-10.1 22.6-22.6 0-6-2.4-11.8-6.6-16l-34.7-34.7 192-192zM341.1 353.4L222.6 234.9c-42.7-3.7-85.2 11.7-115.8 42.3l-8 8c-22.3 22.3-34.8 52.5-34.8 84 0 6.8 7.1 11.2 13.2 8.2l51.1-25.5c5-2.5 9.5 4.1 5.4 7.9L7.3 473.4C2.7 477.6 0 483.6 0 489.9 0 502.1 9.9 512 22.1 512l173.3 0c38.8 0 75.9-15.4 103.4-42.8 30.6-30.6 45.9-73.1 42.3-115.8z"],
    "down": [384,512,"M169.4 502.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 402.7 224 32c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 370.7-105.4-105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z"],
    "up": [384,512,"M214.6 9.4c-12.5-12.5-32.8-12.5-45.3 0l-160 160c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L160 109.3 160 480c0 17.7 14.3 32 32 32s32-14.3 32-32l0-370.7 105.4 105.4c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3l-160-160z"],
    "chevron-down": [448,512,"M201.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 338.7 54.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"],
    "chevron-right": [320,512,"M311.1 233.4c12.5 12.5 12.5 32.8 0 45.3l-192 192c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L243.2 256 73.9 86.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l192 192z"],
    "circle": [512,512,"M0 256a256 256 0 1 1 512 0 256 256 0 1 1 -512 0z"],
    "undo": [512,512,"M24 192l144 0c9.7 0 18.5-5.8 22.2-14.8s1.7-19.3-5.2-26.2l-46.7-46.7c75.3-58.6 184.3-53.3 253.5 15.9 75 75 75 196.5 0 271.5s-196.5 75-271.5 0c-10.2-10.2-19-21.3-26.4-33-9.5-14.9-29.3-19.3-44.2-9.8s-19.3 29.3-9.8 44.2C49.7 408.7 61.4 423.5 75 437 175 537 337 537 437 437S537 175 437 75C342.8-19.3 193.3-24.7 92.7 58.8L41 7C34.1 .2 23.8-1.9 14.8 1.8S0 14.3 0 24L0 168c0 13.3 10.7 24 24 24z"],
  };
  // END GENERATED FONT AWESOME DATA
  function faIcon(name) {
    const [width, height, svgPath] = FA_ICONS[name];
    return `<svg class="fa-icon" data-icon="${name}" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${svgPath}"></path></svg>`;
  }
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  let app = window[INSTANCE_KEY];
  if (app && app.host?.isConnected) return;
  if (app) { try { app.destroy(); } catch (_) {} }

  const defaultState = {
    x: 18, y: 70, width: 720, height: 520, dock: 'float', collapsed: false, closed: false,
    activeTab: 'elements', theme: 'dark', lastResourceType: 'local', opacity: true,
  };
  const executionWindow = options.pageWindow || window;
  const executionTarget = options.isolated ? 'userscript' : 'page';

  // Accept old per-site preferences as well as the newer shared record, while
  // ignoring unexpected values from page storage or a manager bridge.
  function readPreferences(value) {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return null; } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Number.isFinite(value[key]) && Math.abs(value[key]) <= 1000000 && (!['width', 'height'].includes(key) || value[key] > 0)) result[key] = value[key];
    }
    if (['float', 'left', 'right', 'top', 'bottom'].includes(value.dock)) result.dock = value.dock;
    for (const key of ['collapsed', 'closed', 'opacity']) if (typeof value[key] === 'boolean') result[key] = value[key];
    if (['elements', 'console', 'source', 'resources'].includes(value.activeTab)) result.activeTab = value.activeTab;
    if (['local', 'session', 'cookie'].includes(value.lastResourceType)) result.lastResourceType = value.lastResourceType;
    if (value.theme === 'dark') result.theme = value.theme;
    if (Number.isFinite(value.updatedAt) && value.updatedAt >= 0 && value.updatedAt <= Date.now() + 86400000) result.updatedAt = value.updatedAt;
    return Object.keys(result).length ? result : null;
  }
  function readLocalPreferences() {
    try { return readPreferences(localStorage.getItem(STORAGE_KEY)); } catch (_) { return null; }
  }
  const localPreferences = readLocalPreferences();
  const sharedPreferences = readPreferences(options.sharedState);
  const stored = sharedPreferences && (!localPreferences || (sharedPreferences.updatedAt || 0) >= (localPreferences.updatedAt || 0))
    ? sharedPreferences : localPreferences;
  const state = { ...defaultState, ...stored };
  let savedAt = state.updatedAt || 0;
  delete state.updatedAt;
  const promoteLocal = options.sharedKnown && options.allowMigration && localPreferences && !sharedPreferences;

  const waitForRoot = (callback) => {
    if (document.documentElement) callback();
    else document.addEventListener('DOMContentLoaded', callback, { once: true });
  };

  waitForRoot(() => {
    if (window[INSTANCE_KEY]?.host?.isConnected) return;
    const host = document.createElement('div');
    host.id = APP_ID;
    host.setAttribute('data-web-inspector-host', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483646!important;inset:0 auto auto 0!important;width:0!important;height:0!important;overflow:visible!important;pointer-events:none!important;';
    (document.documentElement || document.body).appendChild(host);
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    const css = `
      :host{all:initial;color-scheme:dark} *{box-sizing:border-box}
      .wi{--bg:#11151d;--panel:#171d27;--panel2:#202836;--line:#303b4b;--text:#e6edf5;--muted:#9aa9bb;--accent:#62b5ff;--green:#a2d98a;--yellow:#ffcd70;--red:#ff8585;--purple:#d4a5ff;
        position:fixed;left:0;top:0;width:720px;height:520px;max-width:calc(100vw - 12px);max-height:calc(100vh - 12px);min-width:300px;min-height:140px;
        display:flex;flex-direction:column;background:var(--bg);color:var(--text);border:1px solid #526175;border-radius:12px;box-shadow:0 16px 56px #0009;
        font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;pointer-events:auto;opacity:1;transition:opacity .2s, transform .22s,width .2s,height .2s;isolation:isolate;}
      .wi.idle{opacity:.76}.wi.dragging,.wi.resizing{transition:none;opacity:1}.wi.closed{display:none}
      .title{height:44px;min-height:44px;display:flex;align-items:center;gap:8px;padding:0 8px 0 12px;background:linear-gradient(110deg,#26364b,#1c2634);border-bottom:1px solid var(--line);touch-action:none;user-select:none;cursor:grab}
      .title:active{cursor:grabbing}.brand{display:flex;align-items:center;gap:8px;min-width:0;flex:1}.logo{width:24px;height:24px;border-radius:7px;background:#388bd0;display:grid;place-items:center;font-weight:800;color:white}.titletext{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.context{color:var(--muted);font-size:11px;margin-left:3px}
      button{font:inherit;color:inherit;border:1px solid transparent;background:transparent;border-radius:7px;min-width:36px;height:34px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px}button:hover{background:#ffffff12;border-color:#ffffff14}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.icon{font-size:16px;line-height:1}.title button{width:38px;height:38px;font-size:18px}.close:hover{background:#9f3942}.tabs{display:flex;gap:4px;padding:6px 8px;background:var(--panel);border-bottom:1px solid var(--line);overflow:auto;scrollbar-width:thin}.tab{white-space:nowrap;color:var(--muted);padding:5px 11px}.tab[aria-selected="true"]{color:var(--text);background:#2d4056;border-color:#47607c}.toolbar{display:flex;align-items:center;gap:4px;min-height:42px;padding:4px 8px;background:#141a23;border-bottom:1px solid var(--line);overflow:auto}.toolbar .spacer{flex:1}.toolbar button{min-width:36px}.content{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}.panel{display:none;flex:1;min-height:0;min-width:0}.panel.active{display:flex}.columns{display:flex;flex:1;min-width:0;min-height:0}.treepane{width:42%;min-width:115px;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}.detailpane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}.subhead{padding:6px 9px;color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:6px}.tree,.scroll{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1;padding:6px}.tree-row{height:auto;min-height:25px;display:flex;align-items:center;gap:4px;padding:2px 5px;border-radius:5px;white-space:nowrap;overflow:hidden;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.tree-row:hover{background:#ffffff0a}.tree-row.selected{background:#23507a;color:#fff}.tree-row .twisty{width:18px;min-width:18px;height:22px;padding:0;color:var(--muted)}.tree-row .tag{color:#7ec8ff}.tree-row .meta{color:#b3becb;overflow:hidden;text-overflow:ellipsis}.muted{color:var(--muted)}.empty{padding:18px;color:var(--muted);text-align:center}.field{width:100%;background:#0d1118;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 8px;font:inherit}.field.small{padding:5px 7px}.field,textarea,select{font-size:14px}.editor{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;min-height:60px;max-height:35%;tab-size:2}.label{font-size:11px;color:var(--muted);margin:9px 0 4px}.detail-actions{display:flex;gap:5px;flex-wrap:wrap;padding:7px;border-bottom:1px solid var(--line)}.htmlview,.sourceview{margin:0;white-space:pre;overflow:auto;flex:1;padding:10px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;color:#d7e2ef}.tok-tag{color:#76c7ff}.tok-attr{color:#c6a0f6}.tok-str{color:#a7dc8b}.tok-comment{color:#718096}.tok-text{color:#d7e2ef}.tok-key{color:#f0c674}.tok-num{color:#ef9f76}.tok-punc{color:#b9c5d3}.status{min-height:24px;padding:3px 9px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center}.status .right{margin-left:auto}.consolepanel{flex-direction:column}.consolelog{flex:1;min-height:0;overflow:auto;padding:5px}.entry{padding:5px 8px;border-bottom:1px solid #ffffff0b;white-space:pre-wrap;overflow-wrap:anywhere}.entry.warn{background:#7d5b1b22}.entry.error{background:#842d3828}.entry.debug{color:#b1a5cf}.entry .stamp{color:#8594a7;font-size:10px;margin-right:7px}.entry .kind{font-weight:700;margin-right:6px}.command-area{border-top:1px solid var(--line);padding:7px;display:flex;gap:7px;align-items:flex-end}.command-area textarea{flex:1;min-height:40px;max-height:125px;resize:vertical;font:13px/1.4 ui-monospace,monospace}.resourcepanel{flex-direction:column}.resource-type{display:flex;padding:6px 8px;gap:4px;border-bottom:1px solid var(--line)}.resource-type button[aria-pressed="true"]{background:#2d4056}.reslist{flex:1;min-height:0;overflow:auto}.resrow{display:grid;grid-template-columns:minmax(90px,1fr) minmax(80px,2fr);gap:8px;padding:7px 9px;border-bottom:1px solid #ffffff0a;cursor:pointer}.resrow:hover{background:#ffffff0a}.resrow.selected{background:#23507a}.reskey,.resvalue{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reskey{font:12px ui-monospace,monospace;color:#a9d5ff}.resvalue{color:var(--muted)}.filterbox{width:150px}.sourcepanel{flex-direction:column}.sourcebar{display:flex;align-items:center;gap:7px;padding:5px 8px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}.sourceview{flex:1}.notice{background:#573e14;color:#ffe1a3;padding:6px 9px;font-size:11px}.resize{position:absolute;z-index:5;touch-action:none}.resize.e,.resize.w{top:14px;bottom:14px;width:10px;cursor:ew-resize}.resize.e{right:-4px}.resize.w{left:-4px}.resize.n,.resize.s{height:10px;left:14px;right:14px;cursor:ns-resize}.resize.n{top:-4px}.resize.s{bottom:-4px}.resize.ne,.resize.nw,.resize.se,.resize.sw{width:18px;height:18px;z-index:6}.resize.ne{right:-4px;top:-4px;cursor:nesw-resize}.resize.nw{left:-4px;top:-4px;cursor:nwse-resize}.resize.se{right:-4px;bottom:-4px;cursor:nwse-resize}.resize.sw{left:-4px;bottom:-4px;cursor:nesw-resize}.ghost{position:fixed;z-index:2147483645;border:2px solid #70c5ff;background:#55aeef33;border-radius:10px;pointer-events:none;display:none;transition:all .18s}.wi.collapsed .tabs,.wi.collapsed .toolbar,.wi.collapsed .content,.wi.collapsed .status,.wi.collapsed .resize{display:none}.wi.collapsed{height:44px!important;min-height:44px!important;border-radius:10px}.wi.dock-left,.wi.dock-right{border-radius:0}.wi.dock-top,.wi.dock-bottom{border-radius:0}.wi.dock-top .title{order:2;border-top:1px solid var(--line);border-bottom:0}.wi.dock-top .tabs{order:0}.wi.dock-top .toolbar{order:1}.wi.dock-top .content{order:0}.wi.dock-bottom .title{order:0}.wi.dock-bottom .tabs{order:1}.wi.dock-bottom .toolbar{order:2}.wi.dock-bottom .content{order:3}/* Geometry already anchors vertical docks; translating during the height animation hides the title. */.wi.dock-top.collapsed,.wi.dock-bottom.collapsed{transform:none}.wi.dock-left.collapsed{transform:translateX(calc(-100% + 54px))}.wi.dock-right.collapsed{transform:translateX(calc(100% - 54px))}.wi.dock-left.collapsed .title [data-action="collapse"]{order:1}.wi.dock-right.collapsed .title [data-action="collapse"]{order:-1}.dialog{position:absolute;z-index:10;inset:0;background:#0009;display:grid;place-items:center;padding:16px}.dialogbox{width:min(440px,100%);max-height:90%;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;box-shadow:0 15px 55px #000b}.dialogbox h3{margin:0 0 10px}.dialogbox .actions{display:flex;justify-content:flex-end;gap:6px;margin-top:12px}.footerhint{font-size:11px;color:var(--muted)}
      .fa-icon{display:inline-block;width:1em;height:1em;flex:none;fill:currentColor;pointer-events:none}
      .logo .fa-icon{width:14px;height:14px}.tree-row .twisty .fa-icon{width:10px;height:10px}.tree-row .twisty.leaf .fa-icon{width:4px;height:4px}
      .tree-row .hidden-indicator{color:var(--muted);margin-right:4px}
      [data-action="pick"]{touch-action:none}
      .pickmask{position:fixed;inset:0;z-index:2147483644;cursor:crosshair;touch-action:none;pointer-events:auto}
      .pickbox,.selectionbox{position:fixed;display:none;pointer-events:none;box-sizing:border-box}
      .pickbox{z-index:2147483645;background:rgba(134,239,172,.38);outline:1px solid rgba(34,197,94,.65)}
      .selectionbox{z-index:2147483646;border:2px solid #31b954;border-radius:5px;animation:wi-selection-pulse 1.6s ease-in-out infinite}
      @keyframes wi-selection-pulse{0%,100%{border-color:#31b954;box-shadow:0 0 0 0 rgba(49,185,84,.45)}50%{border-color:#72e991;box-shadow:0 0 0 5px rgba(49,185,84,.16)}}
      @media(max-width:600px){.wi{min-width:280px;border-radius:10px}.treepane{width:39%;min-width:100px}.context{display:none}.toolbar{min-height:40px}.toolbar button{min-width:38px}.tabs{gap:2px}.tab{padding:5px 8px}.resrow{grid-template-columns:minmax(75px,1fr) minmax(65px,1fr)}}
      @media(prefers-reduced-motion:reduce){.wi,.ghost{transition:none!important}.selectionbox{animation:none;box-shadow:0 0 0 2px rgba(49,185,84,.2)}}
    `;

    root.innerHTML = `<style>${css}</style>
      <div class="wi" role="application" aria-label="Web Inspector">
        <div class="title" part="titlebar">
          <div class="brand"><span class="logo" aria-hidden="true">${faIcon('search')}</span><span class="titletext">Web Inspector</span><span class="context">this page</span></div>
          <button data-action="collapse" title="Collapse inspector" aria-label="Collapse inspector" aria-expanded="true">${faIcon('minus')}</button>
          <button data-action="close" title="Hide inspector" aria-label="Hide inspector" class="close">${faIcon('close')}</button>
        </div>
        <nav class="tabs" role="tablist" aria-label="Inspector tools">
          <button class="tab" role="tab" data-tab="elements" aria-selected="true">${faIcon('code')} Elements</button>
          <button class="tab" role="tab" data-tab="console" aria-selected="false">${faIcon('terminal')} Console</button>
          <button class="tab" role="tab" data-tab="source" aria-selected="false">${faIcon('file-code')} Source</button>
          <button class="tab" role="tab" data-tab="resources" aria-selected="false">${faIcon('database')} Resources</button>
        </nav>
        <div class="toolbar" id="toolbar"></div>
        <main class="content">
          <section class="panel active" data-panel="elements"><div class="columns">
            <div class="treepane"><div class="subhead">Document tree <span class="spacer"></span><button data-action="expand-all" title="Expand document tree" aria-label="Expand document tree">${faIcon('expand-tree')}</button></div><div class="tree" id="tree"></div></div>
            <div class="detailpane"><div class="subhead" id="selected-label">No element selected</div><div class="detail-actions"><button data-action="pick" title="Click or drag to pick an element from the page" aria-label="Pick an element from the page">${faIcon('pick')}</button><button data-action="visibility" title="Toggle selected element visibility" aria-label="Toggle selected element visibility">${faIcon('eye')}</button><button data-action="delete-element" title="Delete selected element (Undo available)" aria-label="Delete selected element">${faIcon('trash')}</button><button data-action="add-element" title="Add an element" aria-label="Add an element">${faIcon('plus')}</button><button data-action="refresh-element" title="Refresh selected element" aria-label="Refresh selected element">${faIcon('refresh')}</button></div>
              <div class="scroll" id="details"><div class="empty">Select an element in the tree or use Pick Target.</div></div>
            </div>
          </div></section>
          <section class="panel consolepanel" data-panel="console"><div class="notice">Page-context console capture is best-effort. Commands run in the page context only after you press Execute.</div><div class="consolelog" id="consolelog" aria-live="polite"></div><div class="command-area"><textarea class="field" id="command" placeholder="JavaScript command — Enter executes, Shift+Enter adds a line" aria-label="JavaScript command"></textarea><button data-action="execute" title="Execute command" aria-label="Execute command">${faIcon('play')}</button></div></section>
          <section class="panel sourcepanel" data-panel="source"><div class="sourcebar"><span id="source-label">Reconstructed live DOM</span><span class="spacer"></span><button data-action="copy-source" title="Copy source" aria-label="Copy source">${faIcon('copy')}</button><button data-action="refresh-source" title="Refresh source" aria-label="Refresh source">${faIcon('refresh')}</button></div><pre class="sourceview" id="sourceview" tabindex="0"></pre></section>
          <section class="panel resourcepanel" data-panel="resources"><div class="resource-type" role="tablist" aria-label="Storage type"><button data-resource="local" aria-pressed="true">Local</button><button data-resource="session" aria-pressed="false">Session</button><button data-resource="cookie" aria-pressed="false">Cookies</button></div><div class="toolbar" style="border-bottom:1px solid var(--line)"><input class="field small filterbox" id="resource-filter" placeholder="Filter resources" aria-label="Filter resources"><span class="spacer"></span><button data-action="resource-copy" title="Copy selected resource" aria-label="Copy selected resource">${faIcon('copy')}</button><button data-action="resource-view" title="View selected value in Source" aria-label="View selected value in Source">${faIcon('file-lines')}</button><button data-action="resource-delete" title="Delete selected resource" aria-label="Delete selected resource">${faIcon('trash')}</button><button data-action="resource-clean" title="Clear this storage category" aria-label="Clear this storage category">${faIcon('broom')}</button><button data-action="resource-refresh" title="Refresh resources" aria-label="Refresh resources">${faIcon('refresh')}</button></div><div class="reslist" id="reslist"></div><div class="status" id="resource-status">Accessible storage for this origin</div></section>
        </main>
        <div class="status"><span id="status-text" aria-live="polite">Ready</span><span class="right" id="status-right">No external requests</span></div>
        <div class="resize n" data-resize="n"></div><div class="resize s" data-resize="s"></div><div class="resize e" data-resize="e"></div><div class="resize w" data-resize="w"></div><div class="resize ne" data-resize="ne"></div><div class="resize nw" data-resize="nw"></div><div class="resize se" data-resize="se"></div><div class="resize sw" data-resize="sw"></div>
      </div><div class="ghost"></div><div class="pickbox" aria-hidden="true"></div><div class="selectionbox" aria-hidden="true"></div>`;

    const win = root.querySelector('.wi');
    const collapseButton = root.querySelector('[data-action="collapse"]');
    const ghost = root.querySelector('.ghost');
    const pickHighlight = root.querySelector('.pickbox');
    const selectionHighlight = root.querySelector('.selectionbox');
    const toolbar = root.querySelector('#toolbar');
    const tree = root.querySelector('#tree');
    const details = root.querySelector('#details');
    const sourceView = root.querySelector('#sourceview');
    const consoleLog = root.querySelector('#consolelog');
    const resourceList = root.querySelector('#reslist');
    const statusText = root.querySelector('#status-text');
    const originalConsole = {};
    const stateLocal = {
      selected: null, selectedNodeRow: null, expanded: new WeakSet(), elementSearch: '',
      filteredNodes: null, sourceText: '', sourceOverride: null, consoleEntries: [], commandHistory: [], historyIndex: 0,
      resourceType: state.lastResourceType || 'local', resourceEntries: [], resourceSelected: null,
      removed: null, hidden: new WeakMap(), picking: false, pickOverlay: null, pickPoint: null,
      pickPointerId: null, pickGesture: null, cancelledPickPointer: null, pickClickGuard: null, pickClickTimer: 0, highlightRaf: 0,
      drag: null, resize: null, snapTimer: 0, snapDock: null, raf: 0, historyTimer: 0, listeners: [],
    };
    if (document.documentElement) stateLocal.expanded.add(document.documentElement);
    if (document.body) stateLocal.expanded.add(document.body);

    function preferenceValues() {
      return {
        x: state.x, y: state.y, width: state.width, height: state.height, dock: state.dock,
        collapsed: !!state.collapsed, closed: !!state.closed, activeTab: state.activeTab,
        theme: state.theme, lastResourceType: stateLocal.resourceType, opacity: !!state.opacity,
      };
    }
    let lastSavedValues = JSON.stringify(preferenceValues());
    function cachePreferences(record) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch (_) { /* Storage may be disabled. */ }
    }
    function safeSave(force = false) {
      const values = preferenceValues(), serializedValues = JSON.stringify(values);
      if (!force && serializedValues === lastSavedValues) return;
      // Save synchronously before navigation; also start the manager write now,
      // rather than relying on a debounce or an unload-time asynchronous task.
      savedAt = Math.max(Date.now(), savedAt + 1);
      const record = { ...values, updatedAt: savedAt };
      lastSavedValues = serializedValues;
      cachePreferences(record);
      if (options.saveEvent) document.dispatchEvent(new CustomEvent(options.saveEvent, { detail: JSON.stringify(record) }));
    }
    if (stored && stored === sharedPreferences) cachePreferences({ ...preferenceValues(), updatedAt: savedAt });

    function setStatus(text, right) {
      statusText.textContent = text;
      if (right) root.querySelector('#status-right').textContent = right;
    }
    function usableViewport() {
      const vv = window.visualViewport;
      return { w: Math.max(280, Math.floor(vv?.width || innerWidth)), h: Math.max(140, Math.floor(vv?.height || innerHeight)), left: Math.floor(vv?.offsetLeft || 0), top: Math.floor(vv?.offsetTop || 0) };
    }
    function persistGeom() { safeSave(); }
    function updateCollapseState() {
      const collapsed = !!state.collapsed;
      const label = collapsed ? 'Expand inspector' : 'Collapse inspector';
      const icon = collapsed ? 'plus' : 'minus';
      win.classList.toggle('collapsed', collapsed);
      collapseButton.title = label;
      collapseButton.setAttribute('aria-label', label);
      collapseButton.setAttribute('aria-expanded', String(!collapsed));
      if (collapseButton.firstElementChild?.dataset.icon !== icon) collapseButton.innerHTML = faIcon(icon);
    }
    function applyGeometry() {
      const v = usableViewport();
      win.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom');
      if (state.dock === 'left' || state.dock === 'right') {
        const width = clamp(Number(state.width) || Math.min(430, v.w * .46), 280, Math.max(280, v.w * .5));
        Object.assign(win.style, { left: state.dock === 'left' ? `${v.left}px` : `${v.left + v.w - width}px`, top: `${v.top}px`, width: `${width}px`, height: `${v.h}px`, maxWidth: 'none', maxHeight: 'none' });
        win.classList.add(`dock-${state.dock}`);
      } else if (state.dock === 'top' || state.dock === 'bottom') {
        const height = clamp(Number(state.height) || v.h * .48, 140, v.h * .72);
        Object.assign(win.style, { left: `${v.left}px`, top: state.dock === 'top' ? `${v.top}px` : `${v.top + v.h - (state.collapsed ? 44 : height)}px`, width: `${v.w}px`, height: `${height}px`, maxWidth: 'none', maxHeight: 'none' });
        win.classList.add(`dock-${state.dock}`);
      } else {
        // Viewport changes (including a mobile keyboard) constrain only the rendered
        // rectangle; keep the user's preferred geometry for when the viewport returns.
        const width = clamp(Number(state.width) || Math.min(720, v.w - 12), 280, v.w - 12);
        const height = clamp(Number(state.height) || Math.min(520, v.h - 12), 140, v.h - 12);
        const x = clamp(Number(state.x) || 0, v.left + 2, v.left + v.w - width - 2);
        const y = clamp(Number(state.y) || 0, v.top + 2, v.top + v.h - 44 - 2);
        Object.assign(win.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, maxWidth: `${v.w - 4}px`, maxHeight: `${v.h - 4}px` });
      }
      updateCollapseState();
    }
    function updateTab(tab, save = true) {
      if (!['elements', 'console', 'source', 'resources'].includes(tab)) return;
      if (state.activeTab === 'source' && tab !== 'source') stateLocal.sourceOverride = null;
      state.activeTab = tab;
      root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      root.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
      buildToolbar();
      if (tab === 'source') renderSource();
      if (tab === 'resources') refreshResources();
      if (tab === 'elements') renderTree();
      if (tab === 'console') renderConsole();
      if (save) safeSave();
    }
    function buildToolbar() {
      const tab = state.activeTab;
      if (tab === 'elements') toolbar.innerHTML = `<input class="field small" id="element-filter" style="width:min(230px,55vw)" placeholder="Search elements…" aria-label="Search elements"><button data-action="search-elements" title="Search elements" aria-label="Search elements">${faIcon('search')}</button><button data-action="search-next" title="Next search result" aria-label="Next result">${faIcon('down')}</button><button data-action="search-prev" title="Previous search result" aria-label="Previous result">${faIcon('up')}</button><span class="spacer"></span>${stateLocal.removed ? `<button data-action="undo-delete" title="Undo most recent deletion" aria-label="Undo deletion">${faIcon('undo')} Undo</button>` : ''}<button data-action="pick" title="Click or drag to pick a target on the page" aria-label="Pick target on page">${faIcon('pick')} Pick</button>`;
      else if (tab === 'console') toolbar.innerHTML = `<span class="muted">Execution target: ${executionTarget === 'page' ? 'current page' : 'userscript context (page globals unavailable)'}</span><span class="spacer"></span><button data-action="clear-console" title="Clear console output" aria-label="Clear console output">Clear</button><button data-action="clear-history" title="Clear command history" aria-label="Clear command history">History</button>`;
      else if (tab === 'source') toolbar.innerHTML = `<span class="muted">Read-only representation</span><span class="spacer"></span><input class="field small" id="source-search" style="width:min(180px,45vw)" placeholder="Find in source" aria-label="Find in source"><button data-action="source-find" title="Find in source" aria-label="Find in source">${faIcon('search')}</button><button data-action="copy-source" title="Copy source" aria-label="Copy source">${faIcon('copy')} Copy</button>`;
      else toolbar.innerHTML = `<span class="muted">Accessible page storage</span><span class="spacer"></span>`;
    }
    function excluded(el) { return el === host || el?.getRootNode?.() === root || el?.closest?.(`#${APP_ID}, [data-web-inspector-reopen]`) || el?.hasAttribute?.('data-web-inspector-host'); }
    function elementDescription(el) {
      let s = el.localName || el.nodeName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      if (el.classList?.length) s += '.' + [...el.classList].slice(0, 3).join('.');
      return s;
    }
    function childElements(el) { return [...(el?.children || [])].filter(c => !excluded(c)); }
    function makeRow(el, depth, parent) {
      const row = document.createElement('div');
      row.className = 'tree-row'; row.dataset.element = 'true'; row.style.paddingLeft = `${5 + depth * 12}px`;
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1));
      const children = childElements(el);
      const toggle = document.createElement('button'); toggle.className = children.length ? 'twisty' : 'twisty leaf'; toggle.innerHTML = faIcon(children.length ? (stateLocal.expanded.has(el) ? 'chevron-down' : 'chevron-right') : 'circle');
      toggle.setAttribute('aria-label', children.length ? (stateLocal.expanded.has(el) ? 'Collapse element' : 'Expand element') : 'No children');
      toggle.disabled = !children.length;
      toggle.addEventListener('click', (ev) => { ev.stopPropagation(); stateLocal.expanded.has(el) ? stateLocal.expanded.delete(el) : stateLocal.expanded.add(el); renderTree(); });
      const tag = document.createElement('span'); tag.className = 'tag';
      if (stateLocal.hidden.has(el)) {
        const hiddenIndicator = document.createElement('span'); hiddenIndicator.className = 'hidden-indicator';
        hiddenIndicator.setAttribute('role', 'img'); hiddenIndicator.setAttribute('aria-label', 'Hidden'); hiddenIndicator.title = 'Hidden';
        hiddenIndicator.innerHTML = faIcon('eye-slash'); tag.appendChild(hiddenIndicator);
      }
      tag.appendChild(document.createTextNode(`<${el.localName || el.nodeName.toLowerCase()}>`));
      const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = (el.id ? `#${el.id}` : '') + (el.classList?.length ? ` .${[...el.classList].slice(0, 2).join('.')}` : '');
      row.append(toggle, tag, meta);
      if (el === stateLocal.selected) row.classList.add('selected');
      row.addEventListener('click', () => selectElement(el));
      parent.appendChild(row);
      return children;
    }
    function renderTree() {
      if (state.activeTab !== 'elements' || !tree) return;
      tree.replaceChildren();
      const rootEl = document.documentElement;
      if (!rootEl) { tree.innerHTML = '<div class="empty">Document is not available.</div>'; return; }
      let count = 0;
      const stack = [{ el: rootEl, depth: 0 }];
      while (stack.length && count < MAX_TREE_NODES) {
        const { el, depth } = stack.pop();
        if (!el || excluded(el)) continue;
        const children = makeRow(el, depth, tree); count++;
        if (stateLocal.expanded.has(el)) for (let i = children.length - 1; i >= 0; i--) stack.push({ el: children[i], depth: depth + 1 });
      }
      if (stack.length) { const more = document.createElement('div'); more.className = 'empty'; more.textContent = `Tree limited to ${MAX_TREE_NODES} visible nodes. Expand specific branches to inspect more.`; tree.appendChild(more); }
      if (stateLocal.selected && !stateLocal.selected.isConnected) { stateLocal.selected = null; renderDetails(); }
    }
    function selectElement(el) {
      if (!el || excluded(el)) return;
      stateLocal.selected = el;
      let p = el.parentElement;
      while (p && !excluded(p)) { stateLocal.expanded.add(p); p = p.parentElement; }
      renderTree(); renderDetails(); updateSelectionHighlight(); ensureHighlightLoop();
    }
    function htmlEscape(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    function highlightHTML(text) {
      const esc = htmlEscape(text);
      return esc.replace(/(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?[\w:-]+)|([\w:-]+)(=)(&quot;.*?&quot;|&#39;.*?&#39;)|(&gt;)|(&lt;)|(&amp;#?[\w]+;)/g, (m, comment, tag, attr, eq, value, close, open, entity) => {
        if (comment) return `<span class="tok-comment">${comment}</span>`;
        if (tag) return `<span class="tok-tag">${tag}</span>`;
        if (attr) return `<span class="tok-attr">${attr}</span>${eq}<span class="tok-str">${value}</span>`;
        if (close || open) return `<span class="tok-punc">${m}</span>`;
        if (entity) return `<span class="tok-str">${entity}</span>`;
        return m;
      });
    }
    function renderDetails() {
      const el = stateLocal.selected;
      const label = root.querySelector('#selected-label');
      details.replaceChildren();
      if (!el || !el.isConnected) { stateLocal.selected = null; selectionHighlight.style.display = 'none'; label.textContent = 'No element selected'; details.innerHTML = '<div class="empty">Select an element in the tree or use Pick Target.</div>'; return; }
      label.textContent = elementDescription(el);
      const attrs = document.createElement('div'); attrs.className = 'scroll';
      const title = document.createElement('div'); title.className = 'label'; title.textContent = 'Attributes (edit value, then Apply)'; attrs.appendChild(title);
      for (const attr of [...el.attributes]) {
        const row = document.createElement('div'); row.style.cssText = 'display:grid;grid-template-columns:minmax(70px,1fr) minmax(80px,2fr) auto;gap:5px;margin:4px 0';
        const name = document.createElement('input'); name.className = 'field small'; name.value = attr.name; name.setAttribute('aria-label', `Attribute name ${attr.name}`);
        const value = document.createElement('input'); value.className = 'field small'; value.value = attr.value; value.setAttribute('aria-label', `Attribute value ${attr.name}`);
        const apply = document.createElement('button'); apply.textContent = 'Apply'; apply.title = `Apply ${attr.name}`;
        apply.addEventListener('click', () => {
          if (!stateLocal.selected?.isConnected) return setStatus('Selected element was removed');
          const key = name.value.trim();
          if (!/^[a-zA-Z_:][\w:.-]*$/.test(key)) return setStatus('Invalid attribute name');
          try { if (key !== attr.name) el.removeAttribute(attr.name); el.setAttribute(key, value.value); setStatus(`Updated ${key}`); renderDetails(); } catch (e) { setStatus(`Could not update attribute: ${e.message}`); }
        });
        row.append(name, value, apply); attrs.appendChild(row);
      }
      const addAttr = document.createElement('button'); addAttr.textContent = '+ Add attribute'; addAttr.addEventListener('click', () => {
        const key = prompt('Attribute name'); if (!key) return;
        if (!/^[a-zA-Z_:][\w:.-]*$/.test(key)) return setStatus('Invalid attribute name');
        const value = prompt(`Value for ${key}`, '') ?? ''; el.setAttribute(key, value); renderDetails();
      }); attrs.appendChild(addAttr);
      const textLabel = document.createElement('div'); textLabel.className = 'label'; textLabel.textContent = 'Text content (explicitly apply)'; attrs.appendChild(textLabel);
      const text = document.createElement('textarea'); text.className = 'field editor'; text.value = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.nodeValue).join(''); text.setAttribute('aria-label', 'Direct text content'); attrs.appendChild(text);
      const applyText = document.createElement('button'); applyText.textContent = 'Apply text content'; applyText.addEventListener('click', () => { if (!el.isConnected) return setStatus('Selected element was removed'); const existing = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE); if (existing.length) { existing[0].nodeValue = text.value; existing.slice(1).forEach(n => n.remove()); } else el.insertBefore(document.createTextNode(text.value), el.firstChild); renderTree(); renderDetails(); setStatus('Text updated'); }); attrs.appendChild(applyText);
      const htmlLabel = document.createElement('div'); htmlLabel.className = 'label'; htmlLabel.textContent = 'Current HTML (read-only preview)'; attrs.appendChild(htmlLabel);
      const pre = document.createElement('pre'); pre.className = 'htmlview'; pre.style.cssText = 'max-height:180px;flex:none'; pre.innerHTML = highlightHTML(el.outerHTML.slice(0, 12000) + (el.outerHTML.length > 12000 ? '\n… truncated' : '')); attrs.appendChild(pre);
      const copy = document.createElement('button'); copy.textContent = 'Copy HTML'; copy.addEventListener('click', () => copyText(el.outerHTML).then(() => setStatus('Element HTML copied'), () => setStatus('Clipboard access unavailable'))); attrs.appendChild(copy);
      details.appendChild(attrs);
    }
    function toggleVisibility() {
      const el = stateLocal.selected;
      if (!el?.isConnected) return setStatus('Select an attached element first');
      if (excluded(el)) return setStatus('Inspector host cannot be changed');
      const rec = stateLocal.hidden.get(el);
      if (rec) {
        if (el.style.getPropertyValue('display') === 'none' && el.style.getPropertyPriority('display') === 'important') {
          if (rec.display) el.style.setProperty('display', rec.display, rec.displayPriority); else el.style.removeProperty('display');
        }
        stateLocal.hidden.delete(el); setStatus('Restored saved display state');
      } else {
        stateLocal.hidden.set(el, { display: el.style.getPropertyValue('display'), displayPriority: el.style.getPropertyPriority('display') });
        el.style.setProperty('display', 'none', 'important'); setStatus('Element hidden (temporary for this page)');
      }
      renderTree(); renderDetails(); updateSelectionHighlight();
    }
    function deleteElement() {
      const el = stateLocal.selected;
      if (!el?.isConnected || excluded(el)) return setStatus('This element cannot be removed');
      if (['HTML', 'BODY'].includes(el.tagName) && !confirm(`Remove the document ${el.tagName.toLowerCase()} element? This may disrupt the page.`)) return;
      if (!confirm(`Remove <${el.localName}> from the page? You can Undo immediately.`)) return;
      const parent = el.parentNode; const next = el.nextSibling;
      if (!parent || parent === host || parent.contains(host)) return setStatus('Cannot remove an inspector ancestor');
      stateLocal.removed = { el, parent, next }; el.remove(); stateLocal.selected = null; renderTree(); renderDetails(); setStatus('Element removed. Use Undo in the toolbar to restore it.');
      buildToolbar();
    }
    function undoDelete() {
      const r = stateLocal.removed;
      if (!r || !r.parent?.isConnected) return setStatus('Undo is no longer available');
      r.parent.insertBefore(r.el, r.next?.parentNode === r.parent ? r.next : null); stateLocal.removed = null; selectElement(r.el); setStatus('Element restored');
    }
    function addElementDialog() {
      const el = stateLocal.selected;
      if (!el?.isConnected) return setStatus('Select a parent element first');
      const modal = document.createElement('div'); modal.className = 'dialog';
      modal.innerHTML = `<div class="dialogbox" role="dialog" aria-modal="true" aria-label="Add element"><h3>Add element</h3><div class="label">Tag name</div><input class="field" data-f="tag" value="div"><div class="label">ID (optional)</div><input class="field" data-f="id"><div class="label">Classes (space separated)</div><input class="field" data-f="class"><div class="label">Text content</div><textarea class="field editor" data-f="text"></textarea><div class="label">Insertion point</div><select class="field" data-f="where"><option value="last">Last child of selected</option><option value="first">First child of selected</option><option value="before">Before selected</option><option value="after">After selected</option></select><div class="actions"><button data-cancel>Cancel</button><button data-create>Insert element</button></div></div>`;
      root.querySelector('.content').appendChild(modal);
      modal.querySelector('[data-cancel]').onclick = () => modal.remove();
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
      modal.querySelector('[data-create]').onclick = () => {
        const tag = modal.querySelector('[data-f="tag"]').value.trim();
        if (!/^[a-z][a-z0-9-]*$/i.test(tag)) return alert('Enter a valid HTML tag name.');
        const node = document.createElement(tag); const id = modal.querySelector('[data-f="id"]').value.trim();
        if (id) node.id = id;
        const classes = modal.querySelector('[data-f="class"]').value.trim().split(/\s+/).filter(Boolean);
        classes.forEach(c => { if (/^[\w-]+$/.test(c)) node.classList.add(c); });
        node.textContent = modal.querySelector('[data-f="text"]').value;
        const where = modal.querySelector('[data-f="where"]').value;
        if (where === 'first') el.insertBefore(node, el.firstChild);
        else if (where === 'before' && el.parentNode) el.parentNode.insertBefore(node, el);
        else if (where === 'after' && el.parentNode) el.parentNode.insertBefore(node, el.nextSibling);
        else el.appendChild(node);
        modal.remove(); selectElement(node); setStatus('Element inserted as text-safe content');
      };
      modal.querySelector('[data-f="tag"]').focus();
    }

    // The highlights live in the inspector's shadow root, so they neither alter
    // the page's styles/layout nor appear in the inspected HTML.
    function positionHighlight(box, el, outset = 0) {
      if (!el?.isConnected) { box.style.display = 'none'; return; }
      const rect = el.getBoundingClientRect();
      const computed = getComputedStyle(el);
      if (!rect.width || !rect.height || computed.visibility === 'hidden' || computed.visibility === 'collapse') {
        box.style.display = 'none'; return;
      }
      const geometry = {
        left: `${rect.left - outset}px`, top: `${rect.top - outset}px`,
        width: `${rect.width + outset * 2}px`, height: `${rect.height + outset * 2}px`,
      };
      for (const [property, value] of Object.entries(geometry)) {
        if (box.style[property] !== value) box.style[property] = value;
      }
      if (box === pickHighlight && box.style.borderRadius !== computed.borderRadius) box.style.borderRadius = computed.borderRadius;
      if (box.style.display !== 'block') box.style.display = 'block';
    }
    function updateSelectionHighlight() {
      if (win.classList.contains('closed')) selectionHighlight.style.display = 'none';
      else positionHighlight(selectionHighlight, stateLocal.selected, SELECTION_OUTSET);
    }
    function updatePickHighlight() {
      const point = stateLocal.pickPoint;
      positionHighlight(pickHighlight, stateLocal.picking && point ? getPickTarget(point.x, point.y) : null);
    }
    function refreshHighlights() {
      stateLocal.highlightRaf = 0;
      if (stateLocal.picking) updatePickHighlight();
      if (stateLocal.selected && !stateLocal.selected.isConnected) {
        stateLocal.selected = null; renderTree(); renderDetails();
      }
      updateSelectionHighlight();
      if (stateLocal.picking || (stateLocal.selected && !win.classList.contains('closed'))) ensureHighlightLoop();
    }
    function ensureHighlightLoop() {
      if (!stateLocal.highlightRaf && (stateLocal.picking || (stateLocal.selected && !win.classList.contains('closed')))) {
        stateLocal.highlightRaf = requestAnimationFrame(refreshHighlights);
      }
    }
    function getPickTarget(x, y) {
      // The mask captures touch/drag events; temporarily bypass it for hit testing,
      // including inside open shadow roots. It is restored before events resume.
      const overlay = stateLocal.pickOverlay;
      if (overlay) overlay.style.pointerEvents = 'none';
      try {
        const hits = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
        let el = hits.find(candidate => candidate && !excluded(candidate)) || null;
        while (el?.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint?.(x, y);
          if (!inner || inner === el || excluded(inner)) break;
          el = inner;
        }
        return el;
      } finally {
        if (overlay) overlay.style.pointerEvents = '';
      }
    }
    function preventPickScroll(e) { if (e.cancelable) e.preventDefault(); }
    function startPicker(pointerId = null) {
      if (stateLocal.picking) return;
      stateLocal.picking = true; stateLocal.pickPointerId = pointerId; stateLocal.pickPoint = null;
      const overlay = document.createElement('div'); overlay.className = 'pickmask'; overlay.setAttribute('aria-hidden', 'true');
      root.appendChild(overlay); stateLocal.pickOverlay = overlay;
      // Prevent a touch drag from becoming a page scroll or suppressing the next tap.
      window.addEventListener('touchmove', preventPickScroll, { capture: true, passive: false });
      win.style.opacity = '0.22'; win.style.pointerEvents = 'none';
      setStatus('Pick mode: move over an element and click or tap; Escape cancels');
      ensureHighlightLoop();
    }
    function stopPicker() {
      if (!stateLocal.picking) return;
      window.removeEventListener('touchmove', preventPickScroll, true);
      stateLocal.pickOverlay?.remove(); stateLocal.pickOverlay = null;
      stateLocal.picking = false; stateLocal.pickPointerId = null; stateLocal.pickPoint = null; stateLocal.pickGesture = null;
      pickHighlight.style.display = 'none';
      win.style.opacity = ''; win.style.pointerEvents = '';
      if (!stateLocal.selected && stateLocal.highlightRaf) {
        cancelAnimationFrame(stateLocal.highlightRaf); stateLocal.highlightRaf = 0;
      }
    }
    function cancelPicker() {
      if (!stateLocal.picking) return;
      // A release after Escape must not click the page or re-arm the Pick button.
      if (stateLocal.pickPointerId !== null) stateLocal.cancelledPickPointer = stateLocal.pickPointerId;
      stopPicker(); setStatus('Pick canceled');
    }
    function beginPickGesture(e) {
      const button = e.target.closest?.('[data-action="pick"]');
      if (!button || stateLocal.picking || e.isPrimary === false || e.button !== 0) return;
      stateLocal.pickGesture = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { button.setPointerCapture(e.pointerId); } catch (_) { /* Pointer capture is optional. */ }
    }
    function pickPointerDown(e) {
      // A fresh press is a new interaction, not the synthesized click from a pick.
      if (stateLocal.pickClickGuard && e.isPrimary !== false) {
        clearTimeout(stateLocal.pickClickTimer); stateLocal.pickClickGuard = null;
      }
      // A pointer ID can be reused after a canceled gesture whose release was lost.
      if (stateLocal.cancelledPickPointer === e.pointerId) stateLocal.cancelledPickPointer = null;
      if (!stateLocal.picking || stateLocal.pickPointerId !== null || e.isPrimary === false || e.button !== 0) return;
      stateLocal.pickPointerId = e.pointerId; stateLocal.pickPoint = { x: e.clientX, y: e.clientY };
      try { stateLocal.pickOverlay?.setPointerCapture(e.pointerId); } catch (_) { /* Window listeners still track the pointer. */ }
      updatePickHighlight(); e.preventDefault(); e.stopImmediatePropagation();
    }
    function pickPointerMove(e) {
      const gesture = stateLocal.pickGesture;
      if (!stateLocal.picking && gesture?.id === e.pointerId && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) >= PICK_DRAG_THRESHOLD) {
        startPicker(e.pointerId);
      }
      if (!stateLocal.picking || (stateLocal.pickPointerId !== null && stateLocal.pickPointerId !== e.pointerId)) return;
      stateLocal.pickPoint = { x: e.clientX, y: e.clientY }; updatePickHighlight();
      e.preventDefault(); e.stopImmediatePropagation();
    }
    function guardPickClick(e) {
      clearTimeout(stateLocal.pickClickTimer);
      stateLocal.pickClickGuard = { id: e.pointerId, x: e.clientX, y: e.clientY };
      stateLocal.pickClickTimer = setTimeout(() => { stateLocal.pickClickGuard = null; }, 700);
    }
    function suppressPickClick(e) {
      const guard = stateLocal.pickClickGuard;
      if (!guard || e.detail === 0 || Math.abs(e.clientX - guard.x) > 2 || Math.abs(e.clientY - guard.y) > 2) return;
      if (typeof e.pointerId === 'number' && e.pointerId >= 0 && e.pointerId !== guard.id) return;
      clearTimeout(stateLocal.pickClickTimer); stateLocal.pickClickGuard = null;
      e.preventDefault(); e.stopImmediatePropagation();
    }
    function pickPointerUp(e) {
      if (stateLocal.cancelledPickPointer === e.pointerId) {
        stateLocal.cancelledPickPointer = null; guardPickClick(e); e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if (!stateLocal.picking) {
        if (stateLocal.pickGesture?.id === e.pointerId) stateLocal.pickGesture = null;
        return;
      }
      if (stateLocal.pickPointerId !== e.pointerId) return;
      const target = getPickTarget(e.clientX, e.clientY);
      guardPickClick(e); e.preventDefault(); e.stopImmediatePropagation();
      stateLocal.pickGesture = null;
      if (!target) {
        stateLocal.pickPointerId = null; stateLocal.pickPoint = null; updatePickHighlight();
        setStatus('Pick mode: move over an element and click or tap; Escape cancels'); return;
      }
      stopPicker(); updateTab('elements'); selectElement(target); setStatus(`Selected ${elementDescription(target)}`);
    }
    function pickPointerCancel(e) {
      if (stateLocal.cancelledPickPointer === e.pointerId) stateLocal.cancelledPickPointer = null;
      if (stateLocal.pickGesture?.id === e.pointerId) stateLocal.pickGesture = null;
      if (stateLocal.picking && stateLocal.pickPointerId === e.pointerId) {
        stateLocal.cancelledPickPointer = e.pointerId;
        stopPicker(); setStatus('Pick canceled');
      }
    }
    function lostPickCapture(e) {
      if (stateLocal.pickGesture?.id !== e.pointerId) return;
      stateLocal.pickGesture = null;
      if (stateLocal.picking && stateLocal.pickPointerId === e.pointerId) cancelPicker();
    }

    function sourceHTML() {
      const clone = document.documentElement?.cloneNode(true);
      clone?.querySelector(`#${APP_ID}`)?.remove();
      clone?.querySelector('[data-web-inspector-reopen]')?.remove();
      return '<!-- Reconstructed from the current live DOM; not the original network response. -->\n' + (clone?.outerHTML || '');
    }
    function renderSource() {
      if (state.activeTab !== 'source') return;
      if (stateLocal.sourceOverride) {
        root.querySelector('#source-label').textContent = `Resource view: ${stateLocal.sourceOverride.name} (temporary)`;
        sourceView.innerHTML = highlightCode(stateLocal.sourceOverride.value, stateLocal.sourceOverride.language);
        return;
      }
      root.querySelector('#source-label').textContent = 'Reconstructed live DOM · not original response';
      stateLocal.sourceText = sourceHTML();
      sourceView.innerHTML = highlightHTML(stateLocal.sourceText);
    }
    function highlightCode(text, lang='text') {
      // Escape first; simple lexical coloring only, never treats page data as markup.
      const escaped = htmlEscape(text);
      if (lang === 'html') return highlightHTML(text);
      if (!['json','js','css','text'].includes(lang)) return escaped;
      if (lang === 'text') return escaped;
      return escaped.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:true|false|null|undefined|function|return|const|let|var|new|class|if|else|await|async)\b|\b\d+(?:\.\d+)?\b)/g, (m) => {
        let cls='tok-key'; if (/^(?:"|')/.test(m)) cls=lang==='json' && /^".*"$/.test(m) ? 'tok-str' : 'tok-str'; else if (/^\d/.test(m)) cls='tok-num'; else if (/^(\/\/|\/\*)/.test(m)) cls='tok-comment';
        return `<span class="${cls}">${m}</span>`;
      });
    }
    async function copyText(text) {
      if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(String(text));
      const area = document.createElement('textarea'); area.value=String(text); area.style.cssText='position:fixed;left:-9999px;top:0'; document.documentElement.appendChild(area); area.select();
      const ok=document.execCommand?.('copy'); area.remove(); if(!ok) throw new Error('copy unavailable');
    }

    function addConsoleEntry(level, args, time = Date.now(), commandId = null) {
      const value = args.map(formatValue).join(' ');
      stateLocal.consoleEntries.push({ level, value, time, commandId });
      if(stateLocal.consoleEntries.length>MAX_CONSOLE_ENTRIES) stateLocal.consoleEntries.splice(0,stateLocal.consoleEntries.length-MAX_CONSOLE_ENTRIES);
      if(state.activeTab==='console') renderConsole();
    }
    function formatValue(v) {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
      try { return JSON.stringify(v, (k,val)=> typeof val==='bigint' ? `${val}n` : val, 2) ?? String(v); } catch (_) { try{return String(v)}catch(_){return '[unavailable]'} }
    }
    function setupConsoleCapture() {
      const methods=['log','info','warn','error','debug','group','groupCollapsed','groupEnd','table','assert','count','time','timeEnd','trace','clear'];
      for(const method of methods) {
        try {
          const targetConsole=executionWindow.console;
          const original=targetConsole[method]; if(typeof original!=='function') continue; originalConsole[method]=original;
          targetConsole[method]=function(...args) {
            try { if(method==='clear') { addConsoleEntry('info',['Console clear requested']); } else if(method==='assert' && args[0]) {} else if(method==='assert') addConsoleEntry('error',['Assertion failed',...args.slice(1)]); else if(method==='group'||method==='groupCollapsed'||method==='groupEnd') addConsoleEntry('info',[`[${method}]`,...args]); else addConsoleEntry(method==='table'?'info':method,args); } catch (_) {}
            return original.apply(this,args);
          };
        } catch (_) { /* Console may be non-writable. */ }
      }
    }
    function renderConsole() {
      consoleLog.replaceChildren();
      for (const entry of stateLocal.consoleEntries) {
        const row=document.createElement('div'); row.className=`entry ${entry.level==='warn'?'warn':entry.level==='error'?'error':entry.level==='debug'?'debug':''}`;
        const stamp=document.createElement('span'); stamp.className='stamp'; stamp.textContent=new Date(entry.time).toLocaleTimeString();
        const kind=document.createElement('span'); kind.className='kind'; kind.textContent=entry.level.toUpperCase();
        const msg=document.createElement('span'); msg.textContent=entry.value;
        row.append(stamp,kind,msg); consoleLog.appendChild(row);
      }
      consoleLog.scrollTop=consoleLog.scrollHeight;
    }
    async function executeCommand() {
      const input=root.querySelector('#command'); const code=input.value.trim(); if(!code) return;
      stateLocal.commandHistory.push(code); stateLocal.historyIndex=stateLocal.commandHistory.length;
      const group=document.createElement('div'); group.className='entry'; group.innerHTML=`<span class="kind">&gt;</span><span></span>`; group.querySelector('span:last-child').textContent=code; consoleLog.appendChild(group);
      addConsoleEntry('debug',[`Executing in ${executionTarget} context: ${code}`]);
      input.value='';
      try {
        // Explicit user-triggered execution; inspector internals never run commands.
        const result = (0, executionWindow.eval)(code);
        const resolved = result && typeof result.then==='function' ? await result : result;
        if(resolved!==undefined) addConsoleEntry('info',[resolved]);
      } catch(error) { addConsoleEntry('error',[error]); }
      renderConsole(); safeSave();
    }

    function readStorage(type) {
      try {
        if(type==='local'||type==='session') {
          const storage=type==='local'?window.localStorage:window.sessionStorage;
          const list=[]; for(let i=0;i<storage.length;i++){const key=storage.key(i); if(key!==null) list.push({name:key,value:storage.getItem(key)??''});}
          return {list,error:null};
        }
        const raw=document.cookie; const list=[];
        raw.split(/;\s*/).filter(Boolean).forEach(pair=>{const i=pair.indexOf('=');list.push({name:decodeCookie(i<0?pair:pair.slice(0,i)),value:decodeCookie(i<0?'':pair.slice(i+1))});});
        return {list,error:null};
      } catch(e) { return {list:[],error:e.message||'Storage access denied'}; }
    }
    function decodeCookie(s){try{return decodeURIComponent(s)}catch(_){return s}}
    function refreshResources() {
      const {list,error}=readStorage(stateLocal.resourceType); stateLocal.resourceEntries=list;
      const filter=(root.querySelector('#resource-filter')?.value||'').toLowerCase();
      resourceList.replaceChildren();
      const filtered=list.filter(x=>!filter||x.name.toLowerCase().includes(filter)||x.value.toLowerCase().includes(filter));
      for(const item of filtered){const row=document.createElement('div');row.className='resrow'+(stateLocal.resourceSelected?.name===item.name?' selected':'');row.setAttribute('role','option');
        const k=document.createElement('div');k.className='reskey';k.textContent=item.name;
        const v=document.createElement('div');v.className='resvalue';v.textContent=item.value;
        row.append(k,v);row.addEventListener('click',()=>{stateLocal.resourceSelected=item;refreshResources();});
        row.addEventListener('dblclick',()=>viewResource(item));resourceList.appendChild(row);
      }
      const status=root.querySelector('#resource-status');
      status.textContent=error?`Storage unavailable: ${error}`:`${filtered.length} of ${list.length} accessible ${stateLocal.resourceType==='cookie'?'cookies':stateLocal.resourceType+'Storage'} entries${stateLocal.resourceType==='cookie'?' · HttpOnly cookies are not visible':''}`;
      if(!filtered.length){const empty=document.createElement('div');empty.className='empty';empty.textContent=error?'Could not read this storage.':'No matching entries.';resourceList.appendChild(empty);}
    }
    function changeResourceType(type) { stateLocal.resourceType=type;stateLocal.resourceSelected=null;state.lastResourceType=type;root.querySelectorAll('[data-resource]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.resource===type)));safeSave();refreshResources(); }
    function viewResource(item) {
      let value=item.value, language='text';
      try { value=JSON.stringify(JSON.parse(item.value),null,2);language='json'; } catch (_) {}
      stateLocal.sourceOverride={name:item.name,value,language}; updateTab('source'); renderSource();
      setStatus(`Viewing ${item.name}; Source returns to live DOM when revisited`);
    }
    async function resourceAction(action) {
      const type=stateLocal.resourceType, selected=stateLocal.resourceSelected;
      if(action==='resource-refresh') return refreshResources();
      if(action==='resource-copy') {
        if(!selected) return setStatus('Select a resource first');
        try { await copyText(`${selected.name}\t${selected.value}`);setStatus('Resource copied'); } catch(_){setStatus('Clipboard access unavailable');} return;
      }
      if(action==='resource-view') { if(!selected)return setStatus('Select a resource first');viewResource(selected);return; }
      if(action==='resource-delete') {
        if(!selected)return setStatus('Select a resource first');
        if(!confirm(`Delete “${selected.name}” from ${type==='cookie'?'document cookies':type+'Storage'}?`))return;
        try { if(type==='local')localStorage.removeItem(selected.name);else if(type==='session')sessionStorage.removeItem(selected.name);else document.cookie=`${encodeURIComponent(selected.name)}=; Max-Age=0; path=/`; stateLocal.resourceSelected=null;refreshResources();setStatus('Delete attempted; cookie scope may limit removal'); }catch(e){setStatus(`Delete failed: ${e.message}`);} return;
      }
      if(action==='resource-clean') {
        const count=stateLocal.resourceEntries.length;
        if(!confirm(`Clear ${count} accessible entries from ${type==='local'?'localStorage':type==='session'?'sessionStorage':'document cookies'}?${type==='cookie'?' Cookies are removed only where the available path/domain scope permits.':''}`))return;
        try { if(type==='local')localStorage.clear();else if(type==='session')sessionStorage.clear();else stateLocal.resourceEntries.forEach(c=>{document.cookie=`${encodeURIComponent(c.name)}=; Max-Age=0; path=/`});stateLocal.resourceSelected=null;refreshResources();setStatus('Clear attempted; cookie removal is scope-limited');}catch(e){setStatus(`Clear failed: ${e.message}`);}return;
      }
    }

    function positionReopenButton() {
      // Use the visible viewport rather than the potentially wider layout viewport.
      // The 56px offset is the 44px button plus a 12px edge margin.
      const v = window.visualViewport;
      const x = (v?.offsetLeft || 0) + (v?.width || innerWidth) - 56;
      const y = (v?.offsetTop || 0) + (v?.height || innerHeight) - 56;
      reopenButton.style.setProperty('left', `calc(${x}px - env(safe-area-inset-right, 0px))`, 'important');
      reopenButton.style.setProperty('top', `calc(${y}px - env(safe-area-inset-bottom, 0px))`, 'important');
    }
    function setInspectorClosed(closed, save = true) {
      state.closed = !!closed;
      if (state.closed && stateLocal.picking) cancelPicker();
      win.classList.toggle('closed', state.closed);
      if (state.closed) positionReopenButton();
      reopenButton.hidden = !state.closed;
      reopenButton.style.setProperty('display', state.closed ? 'flex' : 'none', 'important');
      if (!state.closed) applyGeometry();
      updateSelectionHighlight();
      ensureHighlightLoop();
      if (save) safeSave();
    }
    function restorePreferences(value) {
      const restored = readPreferences(value);
      if (!restored || !restored.updatedAt || restored.updatedAt <= savedAt || stateLocal.drag || stateLocal.resize) return;
      Object.assign(state, defaultState, restored);
      savedAt = restored.updatedAt;
      delete state.updatedAt;
      stateLocal.resourceType = state.lastResourceType;
      stateLocal.resourceSelected = null;
      root.querySelectorAll('[data-resource]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.resource === stateLocal.resourceType)));
      lastSavedValues = JSON.stringify(preferenceValues());
      cachePreferences({ ...preferenceValues(), updatedAt: savedAt });
      updateTab(state.activeTab, false);
      applyGeometry();
      setInspectorClosed(state.closed, false);
    }
    function suspendForHistory(suspended) {
      if (suspended) {
        host.style.setProperty('visibility', 'hidden', 'important');
        reopenButton.style.setProperty('visibility', 'hidden', 'important');
      } else {
        clearTimeout(stateLocal.historyTimer); stateLocal.historyTimer = 0;
        host.style.removeProperty('visibility');
        reopenButton.style.removeProperty('visibility');
      }
    }
    function action(name) {
      switch(name){
        case 'collapse': state.collapsed=!state.collapsed;applyGeometry();safeSave();break;
        case 'close': setInspectorClosed(true);setStatus('Inspector hidden. Use the page button to reopen.');break;
        case 'pick': startPicker();break;
        case 'visibility': toggleVisibility();break;
        case 'delete-element': deleteElement();break;
        case 'add-element': addElementDialog();break;
        case 'refresh-element': renderDetails();renderTree();break;
        case 'expand-all': { const stack=[document.documentElement];let n=0;while(stack.length&&n++<2000){const el=stack.pop();if(!el||excluded(el))continue;stateLocal.expanded.add(el);childElements(el).forEach(c=>stack.push(c));}renderTree();setStatus('Expanded accessible document branches');break; }
        case 'undo-delete': undoDelete();break;
        case 'search-elements': searchElements();break;
        case 'search-next': stepSearch(1);break;
        case 'search-prev': stepSearch(-1);break;
        case 'execute': executeCommand();break;
        case 'clear-console':stateLocal.consoleEntries=[];renderConsole();break;
        case 'clear-history':stateLocal.commandHistory=[];stateLocal.historyIndex=0;safeSave();setStatus('Command history cleared');break;
        case 'copy-source':copyText(stateLocal.sourceOverride?.value||stateLocal.sourceText||sourceHTML()).then(()=>setStatus('Source copied'),()=>setStatus('Clipboard access unavailable'));break;
        case 'refresh-source':stateLocal.sourceOverride=null;renderSource();setStatus('Reconstructed source refreshed');break;
        case 'source-find':findSource();break;
        default: if(name.startsWith('resource-'))resourceAction(name);
      }
    }
    let searchResults=[], searchIndex=-1;
    function searchElements() {
      const q=(root.querySelector('#element-filter')?.value||'').trim().toLowerCase();
      searchResults=[];searchIndex=-1;if(!q){setStatus('Enter a search query');return;}
      const walker=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_ELEMENT,{acceptNode:n=>excluded(n)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});let n,count=0;
      while((n=walker.nextNode())&&count<10000){const hay=`${n.tagName} ${n.id} ${n.className} ${[...n.attributes].map(a=>`${a.name}=${a.value}`).join(' ')} ${n.textContent?.slice(0,300)}`.toLowerCase();if(hay.includes(q))searchResults.push(n);count++;}
      if(searchResults.length)stepSearch(1);else setStatus(`No matches for “${q}”`);
    }
    function stepSearch(dir){if(!searchResults.length)return;searchIndex=(searchIndex+dir+searchResults.length)%searchResults.length;const el=searchResults[searchIndex];selectElement(el);setStatus(`Search result ${searchIndex+1} of ${searchResults.length}`);}
    function findSource(){const q=root.querySelector('#source-search')?.value;if(!q)return;const i=sourceView.textContent.toLowerCase().indexOf(q.toLowerCase());if(i<0)return setStatus('Text not found');const range=document.createRange();const walker=document.createTreeWalker(sourceView,NodeFilter.SHOW_TEXT);let node,offset=i,found=false;while((node=walker.nextNode())){if(offset<=node.length){range.setStart(node,offset);range.setEnd(node,Math.min(node.length,offset+q.length));found=true;break;}offset-=node.length;}if(found){const sel=getSelection();sel.removeAllRanges();sel.addRange(range);range.startContainer.parentElement?.scrollIntoView({block:'center'});}}

    function getDockAt(x,y) { const v=usableViewport();if(x-v.left<SNAP_DISTANCE)return 'left';if(v.left+v.w-x<SNAP_DISTANCE)return 'right';if(y-v.top<SNAP_DISTANCE)return 'top';if(v.top+v.h-y<SNAP_DISTANCE)return 'bottom';return null; }
    function dockRect(dock) {const v=usableViewport();if(dock==='left')return{x:v.left,y:v.top,w:Math.min(state.width,v.w*.5),h:v.h};if(dock==='right'){const w=Math.min(state.width,v.w*.5);return{x:v.left+v.w-w,y:v.top,w,h:v.h};}if(dock==='top')return{x:v.left,y:v.top,w:v.w,h:clamp(state.height,140,v.h*.72)};return{x:v.left,y:v.top+v.h-clamp(state.height,140,v.h*.72),w:v.w,h:clamp(state.height,140,v.h*.72)}; }
    function positionGhost(dock) {const r=dockRect(dock);Object.assign(ghost.style,{display:'block',left:`${r.x}px`,top:`${r.y}px`,width:`${r.w}px`,height:`${r.h}px`});}
    function startDrag(e) {
      if(e.button!==undefined&&e.button!==0)return;
      if(e.target.closest('button'))return;
      if(state.dock!=='float') {
        const rect=win.getBoundingClientRect();const relX=e.clientX-rect.left,relY=e.clientY-rect.top;
        state.dock='float';state.x=e.clientX-relX;state.y=e.clientY-relY;applyGeometry();
      }
      const rect=win.getBoundingClientRect();stateLocal.drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,x:rect.left,y:rect.top,preferredX:state.x,preferredY:state.y,offsetX:e.clientX-rect.left,offsetY:e.clientY-rect.top};
      win.classList.add('dragging');try{e.currentTarget.setPointerCapture(e.pointerId)}catch(_){}
      e.preventDefault();
    }
    function moveDrag(e) {
      const d=stateLocal.drag;if(!d||d.id!==e.pointerId)return;
      const v=usableViewport();const x=clamp(e.clientX-d.offsetX,v.left,v.left+v.w-win.offsetWidth);const y=clamp(e.clientY-d.offsetY,v.top,v.top+v.h-44);
      state.x=e.clientX===d.startX?d.preferredX:x;
      state.y=e.clientY===d.startY?d.preferredY:y;
      if(!stateLocal.raf)stateLocal.raf=requestAnimationFrame(()=>{stateLocal.raf=0;win.style.left=`${x}px`;win.style.top=`${y}px`;});
      const dock=getDockAt(e.clientX,e.clientY);
      if(dock!==stateLocal.snapDock){clearTimeout(stateLocal.snapTimer);stateLocal.snapDock=dock;ghost.style.display='none';if(dock)stateLocal.snapTimer=setTimeout(()=>{if(stateLocal.drag&&stateLocal.snapDock===dock)positionGhost(dock);},SNAP_DELAY);}
    }
    function endDrag(e) {
      if(!stateLocal.drag)return;clearTimeout(stateLocal.snapTimer);const dock=ghost.style.display==='block'?stateLocal.snapDock:null;ghost.style.display='none';stateLocal.drag=null;win.classList.remove('dragging');
      if(dock){state.dock=dock;const r=dockRect(dock);if(dock==='left'||dock==='right')state.width=r.w;else state.height=r.h;}
      if(stateLocal.raf){cancelAnimationFrame(stateLocal.raf);stateLocal.raf=0;}
      applyGeometry();persistGeom();
    }
    function startResize(e) {
      if(state.dock!=='float')return;
      const edge=e.currentTarget.dataset.resize,rect=win.getBoundingClientRect();stateLocal.resize={id:e.pointerId,edge,startX:e.clientX,startY:e.clientY,x:rect.left,y:rect.top,w:rect.width,h:rect.height,preferredX:state.x,preferredY:state.y,preferredWidth:state.width,preferredHeight:state.height};win.classList.add('resizing');try{e.currentTarget.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();e.stopPropagation();
    }
    function moveResize(e) {
      const r=stateLocal.resize;if(!r||r.id!==e.pointerId)return;const dx=e.clientX-r.startX,dy=e.clientY-r.startY,v=usableViewport();let {x,y,w,h}=r;
      if(r.edge.includes('e'))w+=dx;if(r.edge.includes('s'))h+=dy;if(r.edge.includes('w')){x+=dx;w-=dx;}if(r.edge.includes('n')){y+=dy;h-=dy;}
      // A resize only commits the axes the user changes, not dimensions temporarily
      // constrained by the keyboard on the other axis.
      if(r.edge.includes('e')||r.edge.includes('w')){
        if(dx===0){state.width=r.preferredWidth;state.x=r.preferredX;}
        else {w=clamp(w,280,v.w-12);x=clamp(x,v.left,v.left+v.w-w);state.width=w;state.x=x;}
      }
      if(r.edge.includes('n')||r.edge.includes('s')){
        if(dy===0){state.height=r.preferredHeight;state.y=r.preferredY;}
        else {h=clamp(h,140,v.h-12);y=clamp(y,v.top,v.top+v.h-h);state.height=h;state.y=y;}
      }
      if(!stateLocal.raf)stateLocal.raf=requestAnimationFrame(()=>{stateLocal.raf=0;Object.assign(win.style,{left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`});});
    }
    function endResize(){if(!stateLocal.resize)return;stateLocal.resize=null;win.classList.remove('resizing');if(stateLocal.raf){cancelAnimationFrame(stateLocal.raf);stateLocal.raf=0;}applyGeometry();persistGeom();}

    function setUpEvents() {
      const listen=(target,type,fn,opts)=>{const node=typeof target==='string'?root.querySelector(target):target;if(!node)return;node.addEventListener(type,fn,opts);stateLocal.listeners.push(()=>node.removeEventListener(type,fn,opts));};
      listen(root,'click',e=>{const b=e.target.closest('[data-action]');if(b){action(b.dataset.action);return;}const tab=e.target.closest('[data-tab]');if(tab){updateTab(tab.dataset.tab);return;}const resource=e.target.closest('[data-resource]');if(resource){changeResourceType(resource.dataset.resource);return;}});
      listen(root,'pointerdown',beginPickGesture); listen(root,'lostpointercapture',lostPickCapture);
      listen(window,'pointerdown',pickPointerDown,true); listen(window,'pointermove',pickPointerMove,true);
      listen(window,'pointerup',pickPointerUp,true); listen(window,'pointercancel',pickPointerCancel,true);
      listen(window,'click',suppressPickClick,true);
      listen(document,'pointerleave',()=>{if(stateLocal.picking && stateLocal.pickPointerId===null){stateLocal.pickPoint=null;updatePickHighlight();}});
      listen(window,'blur',()=>{if(stateLocal.picking && stateLocal.pickPointerId!==null)cancelPicker();else if(stateLocal.picking){stateLocal.pickPoint=null;updatePickHighlight();}else stateLocal.pickGesture=null;});
      listen('.title','pointerdown',startDrag);
      listen('.title','pointermove',moveDrag);listen('.title','pointerup',endDrag);listen('.title','pointercancel',endDrag);listen('.title','lostpointercapture',endDrag);
      root.querySelectorAll('[data-resize]').forEach(h=>{h.addEventListener('pointerdown',startResize);h.addEventListener('pointermove',moveResize);h.addEventListener('pointerup',endResize);h.addEventListener('pointercancel',endResize);});
      listen('#resource-filter','input',refreshResources);
      listen('#command','keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();executeCommand();}else if(e.key==='ArrowUp'&&e.target.selectionStart===0){e.preventDefault();stateLocal.historyIndex=Math.max(0,stateLocal.historyIndex-1);e.target.value=stateLocal.commandHistory[stateLocal.historyIndex]||'';}else if(e.key==='ArrowDown'&&e.target.selectionStart===e.target.value.length){e.preventDefault();stateLocal.historyIndex=Math.min(stateLocal.commandHistory.length,stateLocal.historyIndex+1);e.target.value=stateLocal.commandHistory[stateLocal.historyIndex]||'';}});
      listen('#element-filter','keydown',e=>{if(e.key==='Enter'){searchElements();e.preventDefault();}});
      listen('#source-search','keydown',e=>{if(e.key==='Enter')findSource();});
      listen(win,'pointerenter',()=>win.classList.remove('idle'));listen(win,'pointerleave',()=>{if(state.dock==='float'&&!stateLocal.drag&&!stateLocal.resize&&matchMedia('(hover: hover)').matches)win.classList.add('idle');});
      const resize=()=>{applyGeometry();if(!reopenButton.hidden)positionReopenButton();};listen(window,'resize',resize);if(window.visualViewport){listen(window.visualViewport,'resize',resize);listen(window.visualViewport,'scroll',resize);}
      listen(window,'keydown',e=>{if(e.key==='Escape'&&stateLocal.picking){e.preventDefault();e.stopImmediatePropagation();cancelPicker();return;}if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='i'){e.preventDefault();if(stateLocal.picking)cancelPicker();setInspectorClosed(!state.closed);}},true);
      listen(window,'storage',e=>{if(e.key===STORAGE_KEY)return; if(state.activeTab==='resources')refreshResources();});
      if(options.syncEvent)listen(document,options.syncEvent,e=>{restorePreferences(e.detail);if(stateLocal.historyTimer)suspendForHistory(false);});
      listen(window,'pagehide',e=>{
        if(stateLocal.drag)endDrag();if(stateLocal.resize)endResize();
        safeSave();stopPicker();
        if(e.persisted&&options.syncEvent)suspendForHistory(true);
      });
      listen(window,'pageshow',e=>{
        if(!e.persisted)return;
        if(!host.isConnected)(document.documentElement||document.body).append(host);
        if(!reopenButton.isConnected)(document.documentElement||document.body).append(reopenButton);
        restorePreferences(readLocalPreferences());
        if(options.syncEvent){suspendForHistory(true);clearTimeout(stateLocal.historyTimer);stateLocal.historyTimer=setTimeout(()=>suspendForHistory(false),800);}
        else suspendForHistory(false);
        setStatus('Restored from back-forward cache');
      });
    }

    function addReopenButton() {
      const button=document.createElement('button');button.type='button';button.dataset.webInspectorReopen='true';button.hidden=true;button.innerHTML=faIcon('search');button.title='Open Web Inspector';button.setAttribute('aria-label','Open Web Inspector');
      const glyph=button.querySelector('svg');glyph.style.cssText='display:block!important;width:1em!important;height:1em!important;fill:currentColor!important;pointer-events:none!important;';glyph.querySelector('path').style.cssText='fill:currentColor!important;pointer-events:none!important;';
      button.style.cssText='position:fixed!important;left:0!important;top:0!important;right:auto!important;bottom:auto!important;z-index:2147483645!important;width:44px!important;height:44px!important;box-sizing:border-box!important;padding:0!important;margin:0!important;border-radius:50%!important;border:1px solid #78bdf5!important;background:#172b40!important;color:white!important;font:700 20px/1 -apple-system,BlinkMacSystemFont,sans-serif!important;display:none!important;align-items:center!important;justify-content:center!important;box-shadow:0 4px 14px #0008!important;cursor:pointer!important;';
      button.addEventListener('click',()=>{setInspectorClosed(false);setStatus('Inspector reopened');});
      document.documentElement.appendChild(button);return button;
    }

    if (!document.body) document.addEventListener('DOMContentLoaded', () => { if (document.body) stateLocal.expanded.add(document.body); renderTree(); }, { once: true });
    const reopenButton = addReopenButton();
    positionReopenButton();
    setupConsoleCapture();
    setUpEvents();
    applyGeometry();
    setInspectorClosed(state.closed, false);
    root.querySelectorAll('[data-resource]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.resource===stateLocal.resourceType)));
    buildToolbar();
    updateTab(state.activeTab,false);
    renderTree();renderDetails();renderConsole();

    const api = {
      host, state, open:()=>setInspectorClosed(false),
      destroy:()=>{safeSave();stopPicker();clearTimeout(stateLocal.pickClickTimer);clearTimeout(stateLocal.historyTimer);cancelAnimationFrame(stateLocal.highlightRaf);stateLocal.listeners.forEach(fn=>fn());for(const [name,fn] of Object.entries(originalConsole)){try{executionWindow.console[name]=fn}catch(_){}}if(options.saveEvent)document.dispatchEvent(new CustomEvent(options.saveEvent,{detail:'destroy'}));try{reopenButton.remove();host.remove();}catch(_){}},
    };
    window[INSTANCE_KEY]=api;
    if(promoteLocal)safeSave(true);
    setStatus('Ready · page data stays on this device');
  });
})();
