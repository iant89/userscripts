// ==UserScript==
// @name         Web Inspector
// @namespace    https://github.com/iant89/userscripts
// @version      0.10.0
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
      if (!['elements', 'console', 'source', 'resources', 'settings'].includes(value.activeTab) || !['local', 'session', 'cookie'].includes(value.lastResourceType)) return null;
      if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > Date.now() + 86400000) return null;
      return {
        x: value.x, y: value.y, width: value.width, height: value.height, dock: value.dock,
        collapsed: value.collapsed, closed: value.closed, activeTab: value.activeTab,
        theme: 'dark', lastResourceType: value.lastResourceType,
        opacity: typeof value.opacity === 'boolean' ? value.opacity : true,
        rewriteUrls: typeof value.rewriteUrls === 'boolean' ? value.rewriteUrls : false,
        rewriteScripts: typeof value.rewriteScripts === 'boolean' ? value.rewriteScripts : false,
        stripQuery: typeof value.stripQuery === 'boolean' ? value.stripQuery : false, updatedAt: value.updatedAt,
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
  const MAX_TREE_NODES = 500; // rows drawn at once
  const TREE_PAGE = 250; // rows added by "Show earlier/more"
  const MAX_TREE_SCAN = 20000; // visible nodes walked to build the row list
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
    "beautify": [576,512,"M263.4-27L278.2 9.8 315 24.6c3 1.2 5 4.2 5 7.4s-2 6.2-5 7.4L278.2 54.2 263.4 91c-1.2 3-4.2 5-7.4 5s-6.2-2-7.4-5L233.8 54.2 197 39.4c-3-1.2-5-4.2-5-7.4s2-6.2 5-7.4L233.8 9.8 248.6-27c1.2-3 4.2-5 7.4-5s6.2 2 7.4 5zM110.7 41.7l21.5 50.1 50.1 21.5c5.9 2.5 9.7 8.3 9.7 14.7s-3.8 12.2-9.7 14.7l-50.1 21.5-21.5 50.1c-2.5 5.9-8.3 9.7-14.7 9.7s-12.2-3.8-14.7-9.7L59.8 164.2 9.7 142.7C3.8 140.2 0 134.4 0 128s3.8-12.2 9.7-14.7L59.8 91.8 81.3 41.7C83.8 35.8 89.6 32 96 32s12.2 3.8 14.7 9.7zM464 304c6.4 0 12.2 3.8 14.7 9.7l21.5 50.1 50.1 21.5c5.9 2.5 9.7 8.3 9.7 14.7s-3.8 12.2-9.7 14.7l-50.1 21.5-21.5 50.1c-2.5 5.9-8.3 9.7-14.7 9.7s-12.2-3.8-14.7-9.7l-21.5-50.1-50.1-21.5c-5.9-2.5-9.7-8.3-9.7-14.7s3.8-12.2 9.7-14.7l50.1-21.5 21.5-50.1c2.5-5.9 8.3-9.7 14.7-9.7zM460 0c11 0 21.6 4.4 29.5 12.2l42.3 42.3C539.6 62.4 544 73 544 84s-4.4 21.6-12.2 29.5l-88.2 88.2-101.3-101.3 88.2-88.2C438.4 4.4 449 0 460 0zM44.2 398.5L308.4 134.3 409.7 235.6 145.5 499.8C137.6 507.6 127 512 116 512s-21.6-4.4-29.5-12.2L44.2 457.5C36.4 449.6 32 439 32 428s4.4-21.6 12.2-29.5z"],
    "download": [448,512,"M256 32c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 210.7-41.4-41.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l96 96c12.5 12.5 32.8 12.5 45.3 0l96-96c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 242.7 256 32zM64 320c-35.3 0-64 28.7-64 64l0 32c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-32c0-35.3-28.7-64-64-64l-46.9 0-56.6 56.6c-31.2 31.2-81.9 31.2-113.1 0L110.9 320 64 320zm304 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"],
    "gear": [512,512,"M195.1 9.5C198.1-5.3 211.2-16 226.4-16l59.8 0c15.2 0 28.3 10.7 31.3 25.5L332 79.5c14.1 6 27.3 13.7 39.3 22.8l67.8-22.5c14.4-4.8 30.2 1.2 37.8 14.4l29.9 51.8c7.6 13.2 4.9 29.8-6.5 39.9L447 233.3c.9 7.4 1.3 15 1.3 22.7s-.5 15.3-1.3 22.7l53.4 47.5c11.4 10.1 14 26.8 6.5 39.9l-29.9 51.8c-7.6 13.1-23.4 19.2-37.8 14.4l-67.8-22.5c-12.1 9.1-25.3 16.7-39.3 22.8l-14.4 69.9c-3.1 14.9-16.2 25.5-31.3 25.5l-59.8 0c-15.2 0-28.3-10.7-31.3-25.5l-14.4-69.9c-14.1-6-27.2-13.7-39.3-22.8L73.5 432.3c-14.4 4.8-30.2-1.2-37.8-14.4L5.8 366.1c-7.6-13.2-4.9-29.8 6.5-39.9l53.4-47.5c-.9-7.4-1.3-15-1.3-22.7s.5-15.3 1.3-22.7L12.3 185.8c-11.4-10.1-14-26.8-6.5-39.9L35.7 94.1c7.6-13.2 23.4-19.2 37.8-14.4l67.8 22.5c12.1-9.1 25.3-16.7 39.3-22.8L195.1 9.5zM256.3 336a80 80 0 1 0 -.6-160 80 80 0 1 0 .6 160z"],
    "locate": [384,512,"M0 188.6C0 84.4 86 0 192 0S384 84.4 384 188.6c0 119.3-120.2 262.3-170.4 316.8-11.8 12.8-31.5 12.8-43.3 0-50.2-54.5-170.4-197.5-170.4-316.8zM192 256a64 64 0 1 0 0-128 64 64 0 1 0 0 128z"],
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
    rewriteUrls: false, rewriteScripts: false, stripQuery: false,
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
    for (const key of ['collapsed', 'closed', 'opacity', 'rewriteUrls', 'rewriteScripts', 'stripQuery']) if (typeof value[key] === 'boolean') result[key] = value[key];
    if (['elements', 'console', 'source', 'resources', 'settings'].includes(value.activeTab)) result.activeTab = value.activeTab;
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
      button{font:inherit;color:inherit;border:1px solid transparent;background:transparent;border-radius:7px;min-width:36px;height:34px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px}button:hover{background:#ffffff12;border-color:#ffffff14}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.icon{font-size:16px;line-height:1}.title button{width:38px;height:38px;font-size:18px}.close:hover{background:#9f3942}.tabs{display:flex;gap:4px;padding:6px 8px;background:var(--panel);border-bottom:1px solid var(--line);overflow:auto;scrollbar-width:thin}.tab{white-space:nowrap;color:var(--muted);padding:5px 11px}.tab[aria-selected="true"]{color:var(--text);background:#2d4056;border-color:#47607c}.toolbar{display:flex;align-items:center;gap:4px;min-height:42px;padding:4px 8px;background:#141a23;border-bottom:1px solid var(--line);overflow:auto}.toolbar .spacer{flex:1}.toolbar button{min-width:36px}.content{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}.panel{display:none;flex:1;min-height:0;min-width:0}.panel.active{display:flex}.columns{display:flex;flex:1;min-width:0;min-height:0}.treepane{width:42%;min-width:115px;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}.detailpane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}.subhead{padding:6px 9px;color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:6px}.tree,.scroll{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1;padding:6px}.tree{display:grid;grid-template-columns:minmax(max-content,1fr);align-content:start}.tree-row{box-sizing:border-box;height:auto;min-height:25px;display:flex;align-items:center;gap:4px;padding:2px 5px;border-radius:5px;white-space:nowrap;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.tree-row:hover{background:#ffffff0a}.tree-row.selected{background:#23507a;color:#fff}.tree-row .twisty{width:18px;min-width:18px;height:22px;padding:0;color:var(--muted)}.tree-row .twisty,.tree-row .tag{flex-shrink:0}.tree-more{justify-self:start;height:28px;margin:4px 2px;color:var(--accent);font-size:12px;border-color:var(--line)}.tree-row .tag{color:#7ec8ff}.tree-row .meta{color:#b3becb}.muted{color:var(--muted)}.empty{padding:18px;color:var(--muted);text-align:center}.field{width:100%;background:#0d1118;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 8px;font:inherit}.field.small{padding:5px 7px}.field,textarea,select{font-size:14px}.editor{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;min-height:60px;max-height:35%;tab-size:2}.label{font-size:11px;color:var(--muted);margin:9px 0 4px}.detail-actions{display:flex;gap:5px;flex-wrap:wrap;padding:7px;border-bottom:1px solid var(--line)}.htmlview,.sourceview{margin:0;white-space:pre;overflow:auto;flex:1;padding:10px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;color:#d7e2ef}.tok-tag{color:#76c7ff}.tok-attr{color:#c6a0f6}.tok-str{color:#a7dc8b}.tok-comment{color:#718096}.tok-text{color:#d7e2ef}.tok-key{color:#f0c674}.tok-num{color:#ef9f76}.tok-punc{color:#b9c5d3}.status{min-height:24px;padding:3px 9px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center}.status .right{margin-left:auto}.consolepanel{flex-direction:column}.consolelog{flex:1;min-height:0;overflow:auto;padding:5px}.entry{padding:5px 8px;border-bottom:1px solid #ffffff0b;white-space:pre-wrap;overflow-wrap:anywhere}.entry.warn{background:#7d5b1b22}.entry.error{background:#842d3828}.entry.debug{color:#b1a5cf}.entry .stamp{color:#8594a7;font-size:10px;margin-right:7px}.entry .kind{font-weight:700;margin-right:6px}.command-area{border-top:1px solid var(--line);padding:7px;display:flex;gap:7px;align-items:flex-end}.command-area textarea{flex:1;min-height:40px;max-height:125px;resize:vertical;font:13px/1.4 ui-monospace,monospace}.resourcepanel{flex-direction:column}.resource-type{display:flex;padding:6px 8px;gap:4px;border-bottom:1px solid var(--line)}.resource-type button[aria-pressed="true"]{background:#2d4056}.reslist{flex:1;min-height:0;overflow:auto}.resrow{display:grid;grid-template-columns:minmax(90px,1fr) minmax(80px,2fr);gap:8px;padding:7px 9px;border-bottom:1px solid #ffffff0a;cursor:pointer}.resrow:hover{background:#ffffff0a}.resrow.selected{background:#23507a}.reskey,.resvalue{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reskey{font:12px ui-monospace,monospace;color:#a9d5ff}.resvalue{color:var(--muted)}.filterbox{width:150px}.sourcepanel{flex-direction:column}.sourcebar{display:flex;align-items:center;gap:7px;padding:5px 8px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}.sourceview{flex:1}.sourcebar button[aria-pressed="true"]{background:#2d4056;border-color:#47607c}.menu{position:absolute;z-index:9;width:250px;max-width:calc(100% - 16px);display:flex;flex-direction:column;gap:2px;padding:4px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 30px #000a}.menu button{height:auto;flex-direction:column;align-items:flex-start;gap:1px;padding:7px 10px;text-align:left}.menu .hint{font-size:11px;color:var(--muted)}.dialogbox.wide{width:min(640px,100%)}.dialogbox.wide .actions{position:sticky;bottom:-14px;margin:12px -14px -14px;padding:10px 14px;background:var(--panel);border-top:1px solid var(--line)}.urlgroup{margin-top:10px}.urlgroup-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px}.urllist{max-height:180px;overflow:auto;margin-top:4px;padding:3px;border:1px solid var(--line);border-radius:6px;background:#0d1118}.urlrow{display:flex;gap:6px;align-items:flex-start;padding:2px 4px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.urlrow input,.urlgroup-head input{margin:2px 0 0;flex:none}.urlinfo{color:var(--muted);font-size:10.5px}.urlnotes summary{cursor:pointer;font-weight:600;font-size:12px}.urlnotes .urlrow{color:var(--muted)}.exportprogress{margin-top:10px;font-size:12px;color:var(--muted);min-height:1.4em}.settingspanel{flex-direction:column}.settings{display:flex;flex-direction:column;gap:8px;padding:12px}.settings-head{margin:0 0 2px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}.setting{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);cursor:pointer}.setting:hover{border-color:#47607c}.setting input{margin:3px 0 0;flex:none;width:16px;height:16px;accent-color:var(--accent)}.setting .hint{display:block;margin-top:3px;font-size:12px;color:var(--muted)}.notice{background:#573e14;color:#ffe1a3;padding:6px 9px;font-size:11px}.resize{position:absolute;z-index:5;touch-action:none}.resize.e,.resize.w{top:14px;bottom:14px;width:10px;cursor:ew-resize}.resize.e{right:-4px}.resize.w{left:-4px}.resize.n,.resize.s{height:10px;left:14px;right:14px;cursor:ns-resize}.resize.n{top:-4px}.resize.s{bottom:-4px}.resize.ne,.resize.nw,.resize.se,.resize.sw{width:18px;height:18px;z-index:6}.resize.ne{right:-4px;top:-4px;cursor:nesw-resize}.resize.nw{left:-4px;top:-4px;cursor:nwse-resize}.resize.se{right:-4px;bottom:-4px;cursor:nwse-resize}.resize.sw{left:-4px;bottom:-4px;cursor:nesw-resize}.ghost{position:fixed;z-index:2147483645;border:2px solid #70c5ff;background:#55aeef33;border-radius:10px;pointer-events:none;display:none;transition:all .18s}.wi.collapsed .tabs,.wi.collapsed .toolbar,.wi.collapsed .content,.wi.collapsed .status,.wi.collapsed .resize{display:none}.wi.collapsed{height:44px!important;min-height:44px!important;border-radius:10px}.wi.dock-left,.wi.dock-right{border-radius:0}.wi.dock-top,.wi.dock-bottom{border-radius:0}.wi.dock-top .title{order:2;border-top:1px solid var(--line);border-bottom:0}.wi.dock-top .tabs{order:0}.wi.dock-top .toolbar{order:1}.wi.dock-top .content{order:0}.wi.dock-bottom .title{order:0}.wi.dock-bottom .tabs{order:1}.wi.dock-bottom .toolbar{order:2}.wi.dock-bottom .content{order:3}/* Geometry already anchors vertical docks; translating during the height animation hides the title. */.wi.dock-top.collapsed,.wi.dock-bottom.collapsed{transform:none}.wi.dock-left.collapsed{transform:translateX(calc(-100% + 54px))}.wi.dock-right.collapsed{transform:translateX(calc(100% - 54px))}.wi.dock-left.collapsed .title [data-action="collapse"]{order:1}.wi.dock-right.collapsed .title [data-action="collapse"]{order:-1}.dialog{position:absolute;z-index:10;inset:0;background:#0009;display:grid;place-items:center;padding:16px}.dialogbox{width:min(440px,100%);max-height:90%;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;box-shadow:0 15px 55px #000b}.dialogbox h3{margin:0 0 10px}.dialogbox .actions{display:flex;justify-content:flex-end;gap:6px;margin-top:12px}.footerhint{font-size:11px;color:var(--muted)}
      .fa-icon{display:inline-block;width:1em;height:1em;flex:none;fill:currentColor;pointer-events:none}
      .logo .fa-icon{width:14px;height:14px}.tree-row .twisty .fa-icon{width:10px;height:10px}.tree-row .twisty.leaf .fa-icon{width:4px;height:4px}
      .tree-row .hidden-indicator{color:var(--muted);margin-right:4px}
      [data-action="pick"]{touch-action:none}
      .pickmask{position:fixed;inset:0;z-index:2147483644;cursor:crosshair;touch-action:none;pointer-events:auto}
      .pickbox,.selectionbox,.locatebox{position:fixed;display:none;pointer-events:none;box-sizing:border-box}
      .locatebox{z-index:2147483647;border:3px solid #ffcd70;border-radius:6px;background:#ffcd7026;box-shadow:0 0 0 4px #ffcd7040,0 0 26px 8px #ffcd7080;animation:wi-locate .55s ease-in-out infinite alternate}
      @keyframes wi-locate{from{opacity:1}to{opacity:.4}}
      .wi.see-through{opacity:.5!important;transition:opacity .2s}
      .pickbox{z-index:2147483645;background:rgba(134,239,172,.38);outline:1px solid rgba(34,197,94,.65)}
      .selectionbox{z-index:2147483646;border:2px solid #31b954;border-radius:5px;animation:wi-selection-pulse 1.6s ease-in-out infinite}
      @keyframes wi-selection-pulse{0%,100%{border-color:#31b954;box-shadow:0 0 0 0 rgba(49,185,84,.45)}50%{border-color:#72e991;box-shadow:0 0 0 5px rgba(49,185,84,.16)}}
      @media(max-width:600px){.wi{min-width:280px;border-radius:10px}.treepane{width:39%;min-width:100px}.context{display:none}.toolbar{min-height:40px}.toolbar button{min-width:38px}.tabs{gap:2px}.tab{padding:5px 8px}.resrow{grid-template-columns:minmax(75px,1fr) minmax(65px,1fr)}}
      @media(prefers-reduced-motion:reduce){.wi,.ghost{transition:none!important}.selectionbox{animation:none;box-shadow:0 0 0 2px rgba(49,185,84,.2)}.locatebox{animation:none}}
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
          <button class="tab" role="tab" data-tab="settings" aria-selected="false">${faIcon('gear')} Settings</button>
        </nav>
        <div class="toolbar" id="toolbar"></div>
        <main class="content">
          <section class="panel active" data-panel="elements"><div class="columns">
            <div class="treepane"><div class="subhead">Document tree <span class="spacer"></span><button data-action="expand-all" title="Expand document tree" aria-label="Expand document tree">${faIcon('expand-tree')}</button></div><div class="tree" id="tree"></div></div>
            <div class="detailpane"><div class="subhead" id="selected-label">No element selected</div><div class="detail-actions"><button data-action="pick" title="Click or drag to pick an element from the page" aria-label="Pick an element from the page">${faIcon('pick')}</button><button data-action="locate-element" title="Locate: scroll to the selected element and highlight it" aria-label="Locate selected element on the page">${faIcon('locate')}</button><button data-action="visibility" title="Toggle selected element visibility" aria-label="Toggle selected element visibility">${faIcon('eye')}</button><button data-action="delete-element" title="Delete selected element (Undo available)" aria-label="Delete selected element">${faIcon('trash')}</button><button data-action="add-element" title="Add an element" aria-label="Add an element">${faIcon('plus')}</button><button data-action="refresh-element" title="Refresh selected element" aria-label="Refresh selected element">${faIcon('refresh')}</button></div>
              <div class="scroll" id="details"><div class="empty">Select an element in the tree or use Pick Target.</div></div>
            </div>
          </div></section>
          <section class="panel consolepanel" data-panel="console"><div class="notice">Page-context console capture is best-effort. Commands run in the page context only after you press Execute.</div><div class="consolelog" id="consolelog" aria-live="polite"></div><div class="command-area"><textarea class="field" id="command" placeholder="JavaScript command — Enter executes, Shift+Enter adds a line" aria-label="JavaScript command"></textarea><button data-action="execute" title="Execute command" aria-label="Execute command">${faIcon('play')}</button></div></section>
          <section class="panel sourcepanel" data-panel="source"><div class="sourcebar"><span id="source-label">Reconstructed live DOM</span><span class="spacer"></span><button data-action="beautify-source" title="Beautify: indent the HTML one element per line" aria-label="Beautify source" aria-pressed="false">${faIcon('beautify')}</button><button data-action="export-source" title="Export the source, or the source with every file it references" aria-label="Export source" aria-haspopup="menu" aria-expanded="false">${faIcon('download')}</button><button data-action="copy-source" title="Copy source" aria-label="Copy source">${faIcon('copy')}</button><button data-action="refresh-source" title="Refresh source" aria-label="Refresh source">${faIcon('refresh')}</button></div><pre class="sourceview" id="sourceview" tabindex="0"></pre></section>
          <section class="panel resourcepanel" data-panel="resources"><div class="resource-type" role="tablist" aria-label="Storage type"><button data-resource="local" aria-pressed="true">Local</button><button data-resource="session" aria-pressed="false">Session</button><button data-resource="cookie" aria-pressed="false">Cookies</button></div><div class="toolbar" style="border-bottom:1px solid var(--line)"><input class="field small filterbox" id="resource-filter" placeholder="Filter resources" aria-label="Filter resources"><span class="spacer"></span><button data-action="resource-copy" title="Copy selected resource" aria-label="Copy selected resource">${faIcon('copy')}</button><button data-action="resource-view" title="View selected value in Source" aria-label="View selected value in Source">${faIcon('file-lines')}</button><button data-action="resource-delete" title="Delete selected resource" aria-label="Delete selected resource">${faIcon('trash')}</button><button data-action="resource-clean" title="Clear this storage category" aria-label="Clear this storage category">${faIcon('broom')}</button><button data-action="resource-refresh" title="Refresh resources" aria-label="Refresh resources">${faIcon('refresh')}</button></div><div class="reslist" id="reslist"></div><div class="status" id="resource-status">Accessible storage for this origin</div></section>
          <section class="panel settingspanel" data-panel="settings"><div class="scroll settings">
            <h4 class="settings-head">All files export</h4>
            <label class="setting"><input type="checkbox" data-setting="rewriteUrls"><span><strong>Rewrite URLs to the saved copies</strong><span class="hint">In the ZIP, links in the saved page and its stylesheets point to the downloaded files, so the page opens offline. Links to files that weren't saved are made absolute so they still work online.</span></span></label>
            <label class="setting"><input type="checkbox" data-setting="rewriteScripts"><span><strong>Rewrite URLs in scripts</strong><span class="hint">Also point URLs inside the page's inline scripts and saved .js files at the downloaded files, including URLs built in code whose value was resolved. Only URLs of saved files are changed; other strings are left alone. Paths are relative to the saved page, where scripts resolve them.</span></span></label>
            <label class="setting"><input type="checkbox" data-setting="stripQuery"><span><strong>Remove variables from saved URLs</strong><span class="hint">Save files without the query part of their URL: data.json?v=2&amp;token=abc is saved as data.json, and rewritten links use that name. Files are still downloaded from the full URL.</span></span></label>
            <div class="footerhint">Settings are saved with the inspector's window preferences.</div>
          </div></section>
        </main>
        <div class="status"><span id="status-text" aria-live="polite">Ready</span><span class="right" id="status-right">No external requests</span></div>
        <div class="resize n" data-resize="n"></div><div class="resize s" data-resize="s"></div><div class="resize e" data-resize="e"></div><div class="resize w" data-resize="w"></div><div class="resize ne" data-resize="ne"></div><div class="resize nw" data-resize="nw"></div><div class="resize se" data-resize="se"></div><div class="resize sw" data-resize="sw"></div>
      </div><div class="ghost"></div><div class="pickbox" aria-hidden="true"></div><div class="selectionbox" aria-hidden="true"></div><div class="locatebox" aria-hidden="true"></div>`;

    const win = root.querySelector('.wi');
    const collapseButton = root.querySelector('[data-action="collapse"]');
    const ghost = root.querySelector('.ghost');
    const pickHighlight = root.querySelector('.pickbox');
    const selectionHighlight = root.querySelector('.selectionbox');
    const locateHighlight = root.querySelector('.locatebox');
    const toolbar = root.querySelector('#toolbar');
    const tree = root.querySelector('#tree');
    const details = root.querySelector('#details');
    const sourceView = root.querySelector('#sourceview');
    const consoleLog = root.querySelector('#consolelog');
    const resourceList = root.querySelector('#reslist');
    const statusText = root.querySelector('#status-text');
    const originalConsole = {};
    const stateLocal = {
      selected: null, selectedNodeRow: null, treeStart: 0, expanded: new WeakSet(), elementSearch: '', sourceSearch: '', sourceFindFrom: 0,
      filteredNodes: null, sourceText: '', sourceOverride: null, sourceBeautify: false, consoleEntries: [], commandHistory: [], historyIndex: 0,
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
        rewriteUrls: !!state.rewriteUrls, rewriteScripts: !!state.rewriteScripts, stripQuery: !!state.stripQuery,
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
      if (!['elements', 'console', 'source', 'resources', 'settings'].includes(tab)) return;
      if (state.activeTab === 'source' && tab !== 'source') stateLocal.sourceOverride = null;
      closeExportMenu();
      state.activeTab = tab;
      root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      root.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
      buildToolbar();
      if (tab === 'source') renderSource();
      if (tab === 'resources') refreshResources();
      if (tab === 'elements') renderTree();
      if (tab === 'console') renderConsole();
      if (tab === 'settings') renderSettings();
      if (save) safeSave();
    }
    function renderSettings() { root.querySelectorAll('[data-setting]').forEach(box => { box.checked = !!state[box.dataset.setting]; }); }
    function buildToolbar() {
      const tab = state.activeTab;
      if (tab === 'elements') toolbar.innerHTML = `<input class="field small" id="element-filter" style="width:min(230px,55vw)" placeholder="Search elements…" aria-label="Search elements"><button data-action="search-elements" title="Search elements" aria-label="Search elements">${faIcon('search')}</button><button data-action="search-next" title="Next search result" aria-label="Next result">${faIcon('down')}</button><button data-action="search-prev" title="Previous search result" aria-label="Previous result">${faIcon('up')}</button><span class="spacer"></span>${stateLocal.removed ? `<button data-action="undo-delete" title="Undo most recent deletion" aria-label="Undo deletion">${faIcon('undo')} Undo</button>` : ''}<button data-action="pick" title="Click or drag to pick a target on the page" aria-label="Pick target on page">${faIcon('pick')} Pick</button>`;
      else if (tab === 'console') toolbar.innerHTML = `<span class="muted">Execution target: ${executionTarget === 'page' ? 'current page' : 'userscript context (page globals unavailable)'}</span><span class="spacer"></span><button data-action="clear-console" title="Clear console output" aria-label="Clear console output">Clear</button><button data-action="clear-history" title="Clear command history" aria-label="Clear command history">History</button>`;
      else if (tab === 'source') toolbar.innerHTML = `<span class="muted">Read-only representation</span><span class="spacer"></span><input class="field small" id="source-search" style="width:min(180px,45vw)" placeholder="Find in source" aria-label="Find in source"><button data-action="source-find" title="Find in source" aria-label="Find in source">${faIcon('search')}</button><button data-action="copy-source" title="Copy source" aria-label="Copy source">${faIcon('copy')} Copy</button>`;
      else if (tab === 'settings') toolbar.innerHTML = `<span class="muted">Inspector settings</span><span class="spacer"></span>`;
      else toolbar.innerHTML = `<span class="muted">Accessible page storage</span><span class="spacer"></span>`;
      // Rebuilding the toolbar must not discard a query the user has typed.
      const elementFilter = toolbar.querySelector('#element-filter'); if (elementFilter) elementFilter.value = stateLocal.elementSearch;
      const sourceSearch = toolbar.querySelector('#source-search'); if (sourceSearch) sourceSearch.value = stateLocal.sourceSearch;
    }
    function excluded(el) { return el === host || el?.getRootNode?.() === root || el?.closest?.(`#${APP_ID}, [data-web-inspector-reopen]`) || el?.hasAttribute?.('data-web-inspector-host'); }
    function elementDescription(el) {
      let s = el.localName || el.nodeName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      if (el.classList?.length) s += '.' + [...el.classList].slice(0, 3).join('.');
      return s;
    }
    function childElements(el) { return [...(el?.children || [])].filter(c => !excluded(c)); }
    function makeRow(el, depth, parent, children = childElements(el)) {
      const row = document.createElement('div');
      row.className = 'tree-row'; row.dataset.element = 'true'; row.style.paddingLeft = `${5 + depth * 12}px`;
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1));
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
      return row;
    }
    // Walking the expanded tree is cheap; creating rows is not. So the whole
    // visible tree is listed, and only a window of MAX_TREE_NODES rows is drawn.
    function visibleTreeNodes(rootEl) {
      const items = [], stack = [{ el: rootEl, depth: 0 }];
      while (stack.length) {
        if (items.length >= MAX_TREE_SCAN) return { items, truncated: true };
        const { el, depth } = stack.pop();
        if (!el || excluded(el)) continue;
        const children = childElements(el);
        items.push({ el, depth, children });
        if (stateLocal.expanded.has(el)) for (let i = children.length - 1; i >= 0; i--) stack.push({ el: children[i], depth: depth + 1 });
      }
      return { items, truncated: false };
    }
    function treeButton(action, text) {
      const button = document.createElement('button'); button.className = 'tree-more'; button.dataset.action = action; button.textContent = text;
      tree.appendChild(button);
    }
    // reveal: move the window so the selected element is drawn.
    // anchor: an element whose row should stay put on screen across the redraw.
    function renderTree({ reveal = false, anchor = null } = {}) {
      if (state.activeTab !== 'elements' || !tree) return;
      const anchorRow = anchor && stateLocal.treeRows?.get(anchor);
      const anchorOffset = anchorRow ? anchorRow.getBoundingClientRect().top - tree.getBoundingClientRect().top : 0;
      tree.replaceChildren(); stateLocal.treeRows = new Map();
      const rootEl = document.documentElement;
      if (!rootEl) { tree.innerHTML = '<div class="empty">Document is not available.</div>'; return; }
      const { items, truncated } = visibleTreeNodes(rootEl);
      const selectedIndex = stateLocal.selected ? items.findIndex(item => item.el === stateLocal.selected) : -1;
      let start = stateLocal.treeStart;
      if (reveal && selectedIndex >= 0 && (selectedIndex < start || selectedIndex >= start + MAX_TREE_NODES)) start = selectedIndex - TREE_PAGE;
      start = stateLocal.treeStart = clamp(start, 0, Math.max(0, items.length - MAX_TREE_NODES));
      const end = Math.min(items.length, start + MAX_TREE_NODES);
      if (start > 0) treeButton('tree-earlier', `Show ${Math.min(TREE_PAGE, start)} earlier (${start} above)`);
      for (let i = start; i < end; i++) stateLocal.treeRows.set(items[i].el, makeRow(items[i].el, items[i].depth, tree, items[i].children));
      if (end < items.length) treeButton('tree-later', `Show ${Math.min(TREE_PAGE, items.length - end)} more (${items.length - end} below)`);
      if (truncated) { const note = document.createElement('div'); note.className = 'empty'; note.textContent = `Only the first ${MAX_TREE_SCAN} expanded nodes are listed. Collapse branches to see the rest.`; tree.appendChild(note); }
      const newAnchorRow = anchor && stateLocal.treeRows.get(anchor);
      if (newAnchorRow) tree.scrollTop += newAnchorRow.getBoundingClientRect().top - tree.getBoundingClientRect().top - anchorOffset;
      if (stateLocal.selected && !stateLocal.selected.isConnected) { stateLocal.selected = null; renderDetails(); }
    }
    function shiftTreeWindow(direction) {
      // Keep the row next to the clicked button where it was, so reading continues smoothly.
      const rows = [...stateLocal.treeRows.keys()];
      const anchor = direction < 0 ? rows[0] : rows[rows.length - 1];
      stateLocal.treeStart += direction * TREE_PAGE;
      renderTree({ anchor });
    }
    function selectElement(el) {
      if (!el || excluded(el)) return;
      if (el !== stateLocal.selected) stopLocate();
      stateLocal.selected = el;
      let p = el.parentElement;
      while (p && !excluded(p)) { stateLocal.expanded.add(p); p = p.parentElement; }
      renderTree({ reveal: true }); revealSelectedRow(); renderDetails(); updateSelectionHighlight(); ensureHighlightLoop();
    }
    function revealSelectedRow() {
      const row = tree.querySelector('.tree-row.selected');
      if (!row || !tree.clientHeight) return;
      const view = tree.getBoundingClientRect(), rect = row.getBoundingClientRect();
      if (rect.top < view.top || rect.bottom > view.bottom) tree.scrollTop += rect.top - view.top - (tree.clientHeight - rect.height) / 2;
      const tag = row.querySelector('.tag')?.getBoundingClientRect();
      if (tag && (tag.left < view.left || tag.right > view.right)) tree.scrollLeft += tag.left - view.left - 30;
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
      // One editor per direct text node keeps each piece of text in its place
      // between child elements. Whitespace-only formatting nodes are left alone.
      const segments = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
      const editors = (segments.length ? segments : [null]).map((node, index) => {
        if (segments.length > 1) {
          const neighbour = node.previousElementSibling ? `after <${node.previousElementSibling.localName}>` : node.nextElementSibling ? `before <${node.nextElementSibling.localName}>` : '';
          const sub = document.createElement('div'); sub.className = 'label'; sub.textContent = `Text ${index + 1} of ${segments.length}${neighbour ? ` (${neighbour})` : ''}`; attrs.appendChild(sub);
        }
        const text = document.createElement('textarea'); text.className = 'field editor'; text.value = node ? node.nodeValue : '';
        text.setAttribute('aria-label', segments.length > 1 ? `Direct text content ${index + 1}` : 'Direct text content'); attrs.appendChild(text);
        return { node, text };
      });
      const applyText = document.createElement('button'); applyText.textContent = 'Apply text content'; applyText.addEventListener('click', () => {
        if (!el.isConnected) return setStatus('Selected element was removed');
        let changed = false;
        for (const { node, text } of editors) {
          if (node) { if (!node.isConnected || node.parentNode !== el) return setStatus('Text changed on the page; refresh and try again'); if (node.nodeValue !== text.value) { node.nodeValue = text.value; changed = true; } }
          else if (text.value) { el.insertBefore(document.createTextNode(text.value), el.firstChild); changed = true; }
        }
        if (!changed) return setStatus('Text unchanged');
        renderTree(); renderDetails(); setStatus('Text updated');
      }); attrs.appendChild(applyText);
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
      if (el.contains(host) || el.contains(reopenButton)) return setStatus('Cannot remove an element that contains the inspector');
      if (['HTML', 'BODY'].includes(el.tagName) && !confirm(`Remove the document ${el.tagName.toLowerCase()} element? This may disrupt the page.`)) return;
      if (!confirm(`Remove <${el.localName}> from the page? You can Undo immediately.`)) return;
      const parent = el.parentNode; const next = el.nextSibling;
      if (!parent) return setStatus('This element cannot be removed');
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
        if ((where === 'before' || where === 'after') && el.parentNode?.nodeType !== Node.ELEMENT_NODE) return alert(`An element cannot be inserted ${where} the <${el.localName}> element. Choose a child position instead.`);
        try {
          if (where === 'first') el.insertBefore(node, el.firstChild);
          else if (where === 'before') el.parentNode.insertBefore(node, el);
          else if (where === 'after') el.parentNode.insertBefore(node, el.nextSibling);
          else el.appendChild(node);
        } catch (e) { return alert(`Could not insert element: ${e.message}`); }
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
    // Locate: bring the selected element into view and flash a highlight on it.
    // While it overlaps the inspector, the inspector is faded so it shows through.
    const LOCATE_DURATION = 2500, LOCATE_OUTSET = 4;
    let locateRun = 0, locateFrame = 0, locateTimer = 0;
    function stopLocate() {
      locateRun++; cancelAnimationFrame(locateFrame); clearTimeout(locateTimer); locateFrame = 0;
      locateHighlight.style.display = 'none'; win.classList.remove('see-through');
    }
    function rectsOverlap(a, b) { return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; }
    function visibleViewport() {
      const vv = window.visualViewport, left = vv?.offsetLeft || 0, top = vv?.offsetTop || 0;
      return { left, top, right: left + (vv?.width || innerWidth), bottom: top + (vv?.height || innerHeight) };
    }
    // Resolves once the element has stopped moving (smooth scrolling has ended).
    function settled(el, run) {
      return new Promise(resolve => {
        let last = '', still = 0;
        const began = performance.now();
        const tick = () => {
          if (run !== locateRun) return resolve(false);
          const r = el.getBoundingClientRect(), key = `${r.left},${r.top}`;
          still = key === last ? still + 1 : 0; last = key;
          if (still >= 3 || performance.now() - began > 1500) resolve(true); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }
    async function locateElement() {
      const el = stateLocal.selected;
      if (!el?.isConnected) return setStatus('Select an element first');
      stopLocate();
      const run = locateRun, name = elementDescription(el);
      if (!el.getClientRects().length) return setStatus(`${name} is not rendered (for example display: none), so it has no position on the page`);
      const rect = el.getBoundingClientRect(), view = visibleViewport();
      const fits = rect.width <= view.right - view.left && rect.height <= view.bottom - view.top;
      const inside = rect.left >= view.left && rect.right <= view.right && rect.top >= view.top && rect.bottom <= view.bottom;
      let scrolled = false;
      if (!rectsOverlap(rect, view) || (fits && !inside)) {
        const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
        setStatus(`Scrolling to ${name}…`);
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: smooth ? 'smooth' : 'auto' });
        if (!(await settled(el, run))) return;
        scrolled = true;
      }
      let faded = false;
      const ends = performance.now() + LOCATE_DURATION;
      const frame = () => {
        if (run !== locateRun) return;
        if (!el.isConnected || performance.now() >= ends) return stopLocate();
        const r = el.getBoundingClientRect();
        Object.assign(locateHighlight.style, {
          display: 'block', left: `${r.left - LOCATE_OUTSET}px`, top: `${r.top - LOCATE_OUTSET}px`,
          width: `${r.width + LOCATE_OUTSET * 2}px`, height: `${r.height + LOCATE_OUTSET * 2}px`,
        });
        const behind = !state.closed && rectsOverlap(r, win.getBoundingClientRect());
        win.classList.toggle('see-through', behind);
        faded ||= behind;
        locateFrame = requestAnimationFrame(frame);
      };
      frame();
      setStatus(`Located ${name}${scrolled ? ' (scrolled into view)' : ''}${faded ? ' · inspector faded while it is highlighted' : ''}`);
    }
    function updateSelectionHighlight() {
      // The locate flash replaces the selection outline while it runs.
      if (win.classList.contains('closed') || locateHighlight.style.display === 'block') selectionHighlight.style.display = 'none';
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
      stopLocate();
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

    const SOURCE_HEADER = '<!-- Reconstructed from the current live DOM; not the original network response. -->\n';
    function sourceClone() {
      const clone = document.documentElement?.cloneNode(true);
      clone?.querySelector(`#${APP_ID}`)?.remove();
      clone?.querySelector('[data-web-inspector-reopen]')?.remove();
      return clone;
    }
    function sourceHTML() { return SOURCE_HEADER + (sourceClone()?.outerHTML || ''); }

    // Pretty-printer for the reconstructed DOM. It works on the node tree, so it
    // never re-parses page markup. Text and inline elements stay on one line;
    // whitespace-sensitive elements (pre, textarea) are kept verbatim.
    const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
    const INLINE_TAGS = new Set('a abbr b bdi bdo br cite code data del dfn em i img input ins kbd label mark q s samp small span strong sub sup time u var wbr'.split(' '));
    const VERBATIM_TAGS = new Set(['pre', 'textarea', 'listing', 'xmp', 'plaintext']);
    const SCRIPT_TAGS = new Set(['script', 'style']);
    const ONE_LINE_LIMIT = 120;
    function tagName(el) { return el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? el.localName : el.nodeName; }
    function escapeText(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;'); }
    function openTag(el) {
      const attrs = [...el.attributes].map(a => a.value === '' ? ` ${a.name}` : ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;')}"`).join('');
      return `<${tagName(el)}${attrs}>`;
    }
    function childNodesOf(el) { return [...(el.localName === 'template' && el.content ? el.content.childNodes : el.childNodes)]; }
    // Single-line markup for a node, or null when it needs its own block.
    function inlineMarkup(node) {
      if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue.replace(/\s+/g, ' '));
      if (node.nodeType !== Node.ELEMENT_NODE || !INLINE_TAGS.has(node.localName)) return null;
      if (VOID_TAGS.has(node.localName)) return openTag(node);
      const inner = childrenMarkup(node);
      return inner === null ? null : `${openTag(node)}${inner}</${tagName(node)}>`;
    }
    function childrenMarkup(el) {
      let out = '';
      for (const child of childNodesOf(el)) {
        if (child.nodeType === Node.COMMENT_NODE) continue;
        const markup = inlineMarkup(child);
        if (markup === null) return null;
        out += markup;
      }
      return out.replace(/ {2,}/g, ' ');
    }
    function reindent(text, indent) {
      const lines = text.replace(/\t/g, '  ').split('\n');
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const common = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
      return lines.map(l => l.trim() ? indent + l.slice(common) : '');
    }
    function formatNode(node, depth, out) {
      const indent = '  '.repeat(depth);
      if (node.nodeType === Node.TEXT_NODE) { const text = node.nodeValue.replace(/\s+/g, ' ').trim(); if (text) out.push(indent + escapeText(text)); return; }
      if (node.nodeType === Node.COMMENT_NODE) { out.push(`${indent}<!--${node.data}-->`); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const open = openTag(node), close = `</${tagName(node)}>`;
      if (VOID_TAGS.has(node.localName)) { out.push(indent + open); return; }
      if (VERBATIM_TAGS.has(node.localName)) { out.push(indent + node.outerHTML); return; }
      if (SCRIPT_TAGS.has(node.localName)) {
        const body = node.textContent;
        if (!body.trim()) out.push(indent + open + close);
        else out.push(indent + open, ...reindent(body, indent + '  '), indent + close);
        return;
      }
      const inner = childrenMarkup(node);
      if (inner !== null && indent.length + open.length + inner.trim().length + close.length <= ONE_LINE_LIMIT) {
        out.push(indent + open + inner.trim() + close); return;
      }
      out.push(indent + open);
      let run = '';
      const flush = () => { const text = run.replace(/ {2,}/g, ' ').trim(); if (text) out.push('  '.repeat(depth + 1) + text); run = ''; };
      for (const child of childNodesOf(node)) {
        const markup = child.nodeType === Node.COMMENT_NODE ? null : inlineMarkup(child);
        if (markup !== null) { run += markup; continue; }
        flush(); formatNode(child, depth + 1, out);
      }
      flush();
      out.push(indent + close);
    }
    function beautifiedSourceHTML() {
      const clone = sourceClone();
      if (!clone) return SOURCE_HEADER;
      const out = [];
      if (document.doctype) out.push(`<!DOCTYPE ${document.doctype.name}>`);
      formatNode(clone, 0, out);
      return SOURCE_HEADER + out.join('\n') + '\n';
    }
    // What the Source panel currently shows, for Copy and Export.
    function currentSource() {
      const override = stateLocal.sourceOverride;
      if (override) return { text: override.value, name: override.name, extension: override.language === 'json' ? 'json' : 'txt', type: override.language === 'json' ? 'application/json' : 'text/plain' };
      const host = (location.hostname || 'page').replace(/[^\w.-]+/g, '_');
      return { text: stateLocal.sourceText || sourceHTML(), name: `${host}${stateLocal.sourceBeautify ? '-formatted' : ''}`, extension: 'html', type: 'text/html' };
    }
    function safeFilename(name, fallback = 'source') { return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 100) || fallback; }
    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      // The link lives in the inspector's shadow root, so page click handlers
      // (such as client-side routers) never see it.
      const link = document.createElement('a'); link.href = url; link.download = filename; link.hidden = true;
      link.addEventListener('click', e => e.stopPropagation());
      root.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    function exportSource() {
      const { text, name, extension, type } = currentSource();
      const filename = `${safeFilename(name)}.${extension}`;
      try { downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename); setStatus(`Exported ${filename}`); }
      catch (e) { setStatus(`Export failed: ${e.message}`); }
    }

    // Export menu: "Source" or "All files…".
    let exportMenu = null;
    function exportButton() { return root.querySelector('[data-action="export-source"]'); }
    function closeExportMenu(focusButton = false) {
      if (!exportMenu) return;
      exportMenu.remove(); exportMenu = null;
      const button = exportButton(); button.setAttribute('aria-expanded', 'false');
      if (focusButton) button.focus();
    }
    function toggleExportMenu() {
      if (exportMenu) return closeExportMenu();
      const button = exportButton();
      const menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Export');
      for (const [actionName, label, hint] of [
        ['export-source-file', 'Source', 'Save the source shown as one file'],
        ['export-all-files', 'All files…', 'Find every URL in the source and save the files with it as a ZIP'],
      ]) {
        const item = document.createElement('button'); item.setAttribute('role', 'menuitem'); item.dataset.action = actionName;
        const title = document.createElement('span'); title.textContent = label;
        const sub = document.createElement('span'); sub.className = 'hint'; sub.textContent = hint;
        item.append(title, sub); menu.appendChild(item);
      }
      menu.addEventListener('keydown', e => {
        const items = [...menu.querySelectorAll('[role="menuitem"]')], index = items.indexOf(root.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExportMenu(true); }
        else if (e.key === 'Tab') closeExportMenu();
      });
      win.appendChild(menu); exportMenu = menu;
      const b = button.getBoundingClientRect(), w = win.getBoundingClientRect();
      menu.style.top = `${b.bottom - w.top + 4}px`;
      menu.style.left = `${clamp(b.left - w.left, 8, Math.max(8, w.width - menu.offsetWidth - 8))}px`;
      button.setAttribute('aria-expanded', 'true');
      menu.querySelector('[role="menuitem"]').focus();
    }

    // "All files": find URLs in the source text, fetch the chosen ones with the
    // page's own fetch (so normal cross-origin rules apply), and save a ZIP.
    // URL groups in the "All files" dialog: [kind, label, hint, checked by default].
    const URL_KINDS = [
      ['resource', 'Page resources', 'Scripts, styles, images, fonts and media the page loads', true],
      ['link', 'Linked pages', 'Pages reached by links and GET forms', false],
      ['other', 'Other files in code', 'File URLs (a file name with an extension) found in scripts, text and other attributes', false],
      ['dynamic', 'Built in code', 'URLs assembled by script expressions, with the value they were resolved to', false],
    ];
    const KIND_RANK = { resource: 0, link: 1, dynamic: 2, other: 3 };
    const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);
    const MAX_EXPORT_URLS = 1000, MAX_EXPORT_BYTES = 250 * 1024 * 1024, EXPORT_CONCURRENCY = 4, EXPORT_TIMEOUT = 20000;
    const MAX_SCAN_FILES = 40, MAX_SCAN_CHARS = 5 * 1024 * 1024;
    const JS_STRING = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`])*)`/g;
    function decodeEntities(text) { return text.replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (m, e) => ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>', nbsp: '\u00a0' }[e])); }
    function unescapeJs(text) {
      return text.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, (m, e) => {
        if (/^u\{/i.test(e)) { try { return String.fromCodePoint(parseInt(e.slice(2, -1), 16)); } catch (_) { return e; } }
        if (/^[ux][0-9a-f]/i.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
        return { n: '\n', t: '\t', r: '\r', '\n': '' }[e] ?? e;
      });
    }
    function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function shortCode(text) { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat; }
    function fileLabel(href) { try { const url = new URL(href); return url.pathname.split('/').filter(Boolean).pop() || url.host; } catch (_) { return href; } }
    // A file URL names a file: its last path segment has an extension.
    function isFileUrl(href) { try { return /^[^/]*[^/.][^/]*\.[a-z0-9]{1,8}$/i.test(new URL(href).pathname.split('/').pop()); } catch (_) { return false; } }
    // Index of the bracket closing the one at `open`, skipping quoted strings.
    function closingBracket(text, open) {
      const pairs = { '(': ')', '[': ']', '{': '}' }, stack = [];
      for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
        if (pairs[c]) stack.push(pairs[c]);
        else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
      }
      return -1;
    }
    function enclosingObject(text, index) {
      let depth = 0;
      for (let i = index - 1; i >= Math.max(0, index - 2000); i--) {
        if (text[i] === '}') depth++;
        else if (text[i] === '{') { if (!depth) { const close = closingBracket(text, i); return close < 0 ? null : text.slice(i, close + 1); } depth--; }
      }
      return null;
    }

    function newScan() { return { found: new Map(), notes: [], noteKeys: new Set(), blocked: new Set(), scripts: [], scannable: new Map() }; }
    function addUrl(scan, raw, kind, base, from, info) {
      const value = String(raw ?? '').trim();
      if (!value || value.startsWith('#') || /^(data|blob|javascript|mailto|tel|about|sms):/i.test(value)) return null;
      let url; try { url = new URL(value, base); } catch (_) { return null; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      if (kind === 'other' && !isFileUrl(url.href)) return null;
      const previous = scan.found.get(url.href);
      if (!previous || KIND_RANK[kind] < KIND_RANK[previous.kind]) scan.found.set(url.href, { url: url.href, kind, from, info });
      return url.href;
    }
    function addNote(scan, text) { if (!scan.noteKeys.has(text)) { scan.noteKeys.add(text); scan.notes.push(text); } }
    function blockUrl(scan, raw, base, method, from) {
      let href = raw; try { href = new URL(raw, base).href.replace(/#.*$/, ''); } catch (_) {}
      scan.blocked.add(href);
      addNote(scan, `${method} ${href} (in ${from}): not downloaded, only GET requests are fetched`);
    }
    function scanCss(scan, css, base, from) {
      for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) addUrl(scan, m[1] ?? m[2] ?? m[3], 'resource', base, from);
      for (const m of css.matchAll(/@import\s+["']([^"']+)["']/gi)) addUrl(scan, m[1], 'resource', base, from);
    }
    // Page HTML: tag attributes, inline styles, and inline scripts (kept for the JS pass).
    function scanHtml(scan, html, base, from) {
      let text = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) => { if (body.trim()) scan.scripts.push({ text: body, base, from }); return open + close; });
      text = text.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, body, close) => { scanCss(scan, body, base, from); return open + close; });
      for (const tagMatch of text.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
        const tag = tagMatch[1].toLowerCase(), attrs = {};
        for (const m of tagMatch[2].matchAll(/([^\s="'\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4]);
        for (const [name, value] of Object.entries(attrs)) {
          if (name === 'srcset' || name === 'imagesrcset') value.split(',').forEach(part => addUrl(scan, part.trim().split(/\s+/)[0], 'resource', base, from));
          else if (name === 'src' || name === 'poster' || (name === 'data' && tag === 'object')) {
            const href = addUrl(scan, value, 'resource', base, from);
            if (href && tag === 'script') scan.scannable.set(href, 'js');
          } else if (name === 'href') {
            const href = addUrl(scan, value, tag === 'link' ? 'resource' : 'link', base, from);
            if (href && tag === 'link' && /(^|\s)stylesheet(\s|$)/i.test(attrs.rel || '')) scan.scannable.set(href, 'css');
          } else if (name === 'action' || name === 'formaction') {
            const method = (attrs[name === 'formaction' ? 'formmethod' : 'method'] || 'GET').toUpperCase();
            if (method === 'GET') addUrl(scan, value, 'link', base, from); else blockUrl(scan, value, base, method, from);
          } else if (name === 'style') scanCss(scan, value, base, from);
        }
      }
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>`()\\{}|^]+/gi)) addUrl(scan, decodeEntities(m[0].replace(/[.,;:!?]+$/, '')), 'other', base, from);
    }

    // One operand of a "+" chain: a string, a number, or a name/member/call chain.
    function readOperand(js, pos) {
      const rest = js.slice(pos, pos + 600);
      let m;
      if ((m = /^(["'])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(rest))) return { part: { lit: unescapeJs(m[2]) }, end: pos + m[0].length };
      if ((m = /^`((?:\\.|[^\\`])*)`/.exec(rest))) return { part: m[1].includes('${') ? { expr: m[0] } : { lit: unescapeJs(m[1]) }, end: pos + m[0].length };
      if ((m = /^\d+(?:\.\d+)?\b/.exec(rest))) return { part: { lit: m[0] }, end: pos + m[0].length };
      const name = /^[A-Za-z_$][\w$]*/;
      let i;
      if (rest[0] === '(') { const close = closingBracket(rest, 0); if (close < 0) return null; i = close + 1; }
      else { m = name.exec(rest); if (!m) return null; i = m[0].length; }
      for (;;) {
        if (rest[i] === '.' && (m = name.exec(rest.slice(i + 1)))) i += 1 + m[0].length;
        else if (rest[i] === '(' || rest[i] === '[') { const close = closingBracket(rest, i); if (close < 0) return null; i = close + 1; }
        else break;
      }
      return { part: { expr: rest.slice(0, i) }, end: pos + i };
    }
    // The HTTP method a URL expression is used with, when its call site says so.
    function requestMethod(js, start, end) {
      const before = js.slice(Math.max(0, start - 160), start), after = js.slice(end, end + 1500);
      let m, method = null;
      if ((m = /\.open\(\s*(["'`])([A-Za-z]+)\1\s*,\s*$/.exec(before))) method = m[2];
      else if ((m = /\.(post|put|patch|delete)\(\s*$/i.exec(before))) method = m[1];
      else if (/\bsendBeacon\(\s*$/.test(before)) method = 'POST';
      else if (/(?:\bfetch|\bnew\s+Request)\(\s*$/.test(before)) {
        const options = /^\s*,\s*\{/.exec(after), close = options ? closingBracket(after, options[0].length - 1) : -1;
        m = close > 0 && /\bmethod\s*:\s*(["'`])([A-Za-z]+)\1/.exec(after.slice(0, close + 1));
        method = m ? m[2] : 'GET';
      } else if (/\burl\s*:\s*$/.test(before)) {
        m = /\b(?:method|type)\s*:\s*(["'`])([A-Za-z]+)\1/.exec(enclosingObject(js, start) || '');
        if (m) method = m[2];
      }
      method = method?.toUpperCase();
      return HTTP_METHODS.has(method) ? method : null;
    }
    // Live value of a plain global (data properties only: no getters or code run).
    function readLive(path) {
      if (path[0] === 'window' || path[0] === 'self' || path[0] === 'globalThis') path = path.slice(1);
      if (path[0] === 'document' && path[1] === 'location') path = path.slice(1);
      if (path[0] === 'location' && path.length === 2 && ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'].includes(path[1])) return location[path[1]];
      let value = executionWindow;
      for (const segment of path) {
        if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return null;
        let descriptor = null;
        try { for (let o = value; o && !descriptor; o = Object.getPrototypeOf(o)) descriptor = Object.getOwnPropertyDescriptor(o, segment); } catch (_) { return null; }
        if (!descriptor || !('value' in descriptor)) return null;
        value = descriptor.value;
      }
      return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
    }
    // A string the code assigns to this name, when it assigns exactly one.
    function readAssigned(name, corpus) {
      const id = escapeRegExp(name), values = new Set();
      // name = "value"  (not followed by "+", so the whole value is known)
      const assigned = new RegExp(`(?:^|[^\\w$.])${id}\\s*=\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1\\s*(?=[;,\\n)}]|$)`, 'g');
      // { name: "value" }
      const property = new RegExp(`[{,]\\s*(["']?)${id}\\1\\s*:\\s*(["'\`])((?:\\\\.|(?!\\2)[^\\\\\\n])*)\\2\\s*(?=[,}\\n])`, 'g');
      for (const m of corpus.matchAll(assigned)) values.add(unescapeJs(m[2]));
      for (const m of corpus.matchAll(property)) values.add(unescapeJs(m[3]));
      return values.size === 1 ? [...values][0] : null;
    }
    function resolveOperand(expr, corpus) {
      expr = expr.trim();
      let m;
      if ((m = /^(["'])((?:\\.|(?!\1)[^\\\n])*)\1$/.exec(expr))) return unescapeJs(m[2]);
      if (/^\d+(?:\.\d+)?$/.test(expr)) return expr;
      if ((m = /^(String|encodeURIComponent|encodeURI)\(([\s\S]*)\)$/.exec(expr))) {
        const inner = resolveOperand(m[2], corpus);
        if (inner == null) return null;
        try { return { String, encodeURIComponent, encodeURI }[m[1]](inner); } catch (_) { return null; }
      }
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\s*(["'])[^"'\]]*\1\s*\])*$/.test(expr)) return null;
      const path = [...expr.matchAll(/[A-Za-z_$][\w$]*|\[\s*["']([^"']*)["']\s*\]/g)].map(p => p[1] ?? p[0]);
      return readLive(path) ?? readAssigned(path[path.length - 1], corpus);
    }
    function loadedUrls() {
      const urls = new Set();
      try { for (const entry of executionWindow.performance.getEntriesByType('resource')) urls.add(entry.name); } catch (_) {}
      for (const el of document.querySelectorAll('iframe[src],frame[src],embed[src],script[src],img[src],source[src],video[src],audio[src],link[href],a[href],object[data]')) {
        if (excluded(el)) continue;
        const value = el.currentSrc || el.src || el.href || el.data;
        if (typeof value === 'string') urls.add(value);
      }
      return [...urls].filter(u => /^https?:/i.test(u));
    }
    function resolveParts(parts, base, corpus) {
      const values = parts.map(p => p.lit ?? resolveOperand(p.expr, corpus));
      if (values.every(v => v != null)) return { urls: [values.join('')], how: 'resolved from values in the page' };
      // Otherwise match the pattern against URLs the page has actually loaded.
      let head = values[0] ?? '';
      if (head.startsWith('//')) head = location.protocol + head;
      else if (head && !/^https?:/i.test(head)) { try { head = new URL(head, base).href; } catch (_) { return { urls: [] }; } }
      if (!/^https?:\/\/[^/]+\//i.test(head)) return { urls: [] };
      const pattern = new RegExp(`^${[head, ...values.slice(1)].map(v => v == null ? '.*?' : escapeRegExp(v)).join('')}$`);
      const urls = loadedUrls().filter(u => pattern.test(u) || pattern.test(u.replace(/#.*$/, '')));
      return urls.length && urls.length <= 10 ? { urls, how: 'matched a URL the page loaded' } : { urls: [] };
    }
    // URL expressions in script text: a URL string, optionally continued by
    // "+" operands, or a template literal. Shared by scanning and rewriting.
    function* jsUrlExpressions(js) {
      const literals = new RegExp(JS_STRING.source, 'g');
      let m;
      while ((m = literals.exec(js))) {
        const start = m.index;
        let parts;
        if (m[3] !== undefined) {
          parts = []; let last = 0;
          for (const t of m[3].matchAll(/\$\{([^}]*)\}/g)) { if (t.index > last) parts.push({ lit: unescapeJs(m[3].slice(last, t.index)) }); parts.push({ expr: t[1] }); last = t.index + t[0].length; }
          if (last < m[3].length) parts.push({ lit: unescapeJs(m[3].slice(last)) });
        } else parts = [{ lit: unescapeJs(m[2]) }];
        const head = parts[0]?.lit;
        if (head == null) continue;
        const absolute = /^(?:https?:)?\/\/[^\s/]/i.test(head), path = !absolute && /^\.{0,2}\/[^\s/*]/.test(head);
        if (!absolute && !path) continue;
        if (path && /\+\s*$/.test(js.slice(Math.max(0, start - 20), start))) continue; // the tail of a longer expression
        let end = start + m[0].length;
        for (;;) {
          const plus = /^\s*\+\s*/.exec(js.slice(end, end + 50));
          if (!plus) break;
          const operand = readOperand(js, end + plus[0].length);
          if (!operand) break;
          parts.push(operand.part); end = operand.end;
        }
        literals.lastIndex = end;
        yield { start, end, parts, quote: m[3] !== undefined ? '`' : m[1], dynamic: parts.some(p => p.lit === undefined) };
      }
    }
    function scanJs(scan, js, base, from, corpus) {
      for (const { start, end, parts, dynamic } of jsUrlExpressions(js)) {
        const code = shortCode(js.slice(start, end));
        const method = requestMethod(js, start, end);
        if (method && method !== 'GET') {
          if (dynamic) addNote(scan, `${method} ${code} (in ${from}): not downloaded, only GET requests are fetched`);
          else blockUrl(scan, parts.map(p => p.lit).join(''), base, method, from);
          continue;
        }
        if (!dynamic) { addUrl(scan, parts.map(p => p.lit).join(''), 'other', base, from); continue; }
        const { urls, how } = resolveParts(parts, base, corpus);
        for (const url of urls) addUrl(scan, url, 'dynamic', base, from, `${code} · ${how}`);
        if (!urls.length) addNote(scan, `Built in code, value unknown: ${code} (in ${from})`);
      }
    }
    // Plain text (a resource value): JS-style strings plus bare URLs.
    function scanText(scan, text, base, from) {
      scanJs(scan, text, base, from, text);
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>`()\\{}|^]+/gi)) addUrl(scan, m[0].replace(/[.,;:!?]+$/, ''), 'other', base, from);
    }
    const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    // Minimal ZIP writer: stored (uncompressed) entries with UTF-8 names.
    function buildZip(entries) {
      const encoder = new TextEncoder(), parts = [], central = [];
      const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      let offset = 0;
      for (const entry of entries) {
        const name = encoder.encode(entry.path), data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data, crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
          .forEach(([at, value, size]) => size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true));
        parts.push(local.buffer, name, data);
        const record = new DataView(new ArrayBuffer(46));
        [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [42, offset, 4]]
          .forEach(([at, value, size]) => size === 4 ? record.setUint32(at, value, true) : record.setUint16(at, value, true));
        central.push(record.buffer, name);
        offset += 30 + name.length + data.length;
      }
      const centralSize = central.reduce((n, part) => n + part.byteLength, 0), end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
      end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
      return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }
    function shortHash(text) { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; return h.toString(16); }
    function zipPathFor(href, used, stripQuery = false) {
      const url = new URL(href);
      const segments = url.pathname.split('/').filter(Boolean).map(seg => {
        try { seg = decodeURIComponent(seg); } catch (_) {}
        return seg.replace(/[\\:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+$/, '_').slice(0, 120);
      });
      if (!segments.length || url.pathname.endsWith('/')) segments.push('index.html');
      let file = segments.pop();
      if (url.search && !stripQuery) { const dot = file.lastIndexOf('.'), tag = `_${shortHash(url.search)}`; file = dot > 0 ? file.slice(0, dot) + tag + file.slice(dot) : file + tag; }
      const base = ['files', url.host.replace(/:/g, '_'), ...segments, file].join('/');
      let path = base;
      for (let n = 2; used.has(path.toLowerCase()); n++) {
        const dot = base.lastIndexOf('.'), slash = base.lastIndexOf('/');
        path = dot > slash ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
      }
      used.add(path.toLowerCase());
      return path;
    }
    // Rewriting saved copies: URLs that were saved point at their file in the
    // ZIP (relative to the file being rewritten); other http(s) URLs are made
    // absolute so they still work when the copy is opened from disk.
    function relativePath(from, to) {
      const a = from.split('/').slice(0, -1), b = to.split('/');
      let i = 0;
      while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
      return [...a.slice(i).map(() => '..'), ...b.slice(i).map(encodeURIComponent)].join('/');
    }
    function rewriteReference(raw, base, saved, fromPath) {
      const value = raw.trim();
      if (!value || value.startsWith('#') || /^(data|blob|javascript|mailto|tel|about|sms):/i.test(value)) return raw;
      let url; try { url = new URL(value, base); } catch (_) { return raw; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
      const hash = url.hash; url.hash = '';
      const path = saved.get(url.href);
      return (path ? relativePath(fromPath, path) : url.href) + hash;
    }
    function rewriteCssText(css, base, saved, fromPath) {
      return css
        .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi, (m, dq, sq, bare) => {
          const value = dq ?? sq ?? bare, next = rewriteReference(value, base, saved, fromPath);
          return next === value ? m : `url("${next.replace(/"/g, '%22')}")`;
        })
        .replace(/(@import\s+)(["'])([^"']+)\2/gi, (m, at, quote, value) => `${at}${quote}${rewriteReference(value, base, saved, fromPath)}${quote}`);
    }
    // Script URLs resolve against the page, so `fromPath` is the saved page.
    // Only expressions whose value is a saved file are replaced; other strings
    // are left alone so non-URL text (routes, patterns) is never altered.
    function rewriteJsText(js, base, saved, fromPath, corpus) {
      let out = '', last = 0;
      for (const { start, end, parts, quote, dynamic } of jsUrlExpressions(js)) {
        let value;
        if (!dynamic) value = parts.map(p => p.lit).join('');
        else { const { urls } = resolveParts(parts, base, corpus); if (urls.length !== 1) continue; value = urls[0]; }
        let url; try { url = new URL(value, base); } catch (_) { continue; }
        const hash = url.hash; url.hash = '';
        const path = saved.get(url.href);
        if (!path) continue;
        const relative = relativePath(fromPath, path) + hash;
        out += js.slice(last, start) + quote + relative.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`) + quote;
        last = end;
      }
      return out + js.slice(last);
    }
    function rewriteHtmlText(html, base, saved, fromPath, scripts = null) {
      const attributes = (tag, text) => text.replace(/([^\s="'\/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g, (m, name, eq, dq, sq, bare) => {
        const lower = name.toLowerCase(), value = decodeEntities(dq ?? sq ?? bare);
        let next;
        if (tag === 'base' && lower === 'href') return ''; // the saved copy resolves links from its own location
        if (lower === 'srcset' || lower === 'imagesrcset') next = value.split(',').filter(part => part.trim()).map(part => { const [url, ...rest] = part.trim().split(/\s+/); return [rewriteReference(url, base, saved, fromPath), ...rest].join(' '); }).join(', ');
        else if (['src', 'href', 'poster', 'action', 'formaction'].includes(lower) || (lower === 'data' && tag === 'object')) next = rewriteReference(value, base, saved, fromPath);
        else if (lower === 'style') next = rewriteCssText(value, base, saved, fromPath);
        else return m;
        return next === value ? m : `${name}${eq}"${next.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
      });
      return html.replace(/(<script\b)([^>]*>)([\s\S]*?<\/script>)|(<style\b)([^>]*>)([\s\S]*?)(<\/style>)|<([a-zA-Z][\w:-]*)\b([^>]*)>/gi,
        (m, sOpen, sAttrs, sRest, stOpen, stAttrs, stBody, stClose, tag, tagAttrs) => {
          if (sOpen) {
            const body = sRest.slice(0, -'</script>'.length);
            return sOpen + attributes('script', sAttrs) + (scripts ? rewriteJsText(body, base, saved, fromPath, scripts.corpus) : body) + sRest.slice(-'</script>'.length);
          }
          if (stOpen) return stOpen + attributes('style', stAttrs) + rewriteCssText(stBody, base, saved, fromPath) + stClose;
          const lower = tag.toLowerCase(), rewritten = attributes(lower, tagAttrs);
          return `<${tag}${lower === 'base' ? rewritten.replace(/\s+$/, '') : rewritten}>`;
        });
    }
    async function fetchBytes(href, signal) {
      const controller = new AbortController(), abort = () => controller.abort();
      const timer = setTimeout(abort, EXPORT_TIMEOUT); signal.addEventListener('abort', abort);
      try {
        let response;
        try { response = await fetch(href, { signal: controller.signal, credentials: 'same-origin' }); }
        catch (e) { throw new Error(signal.aborted ? 'cancelled' : controller.signal.aborted ? 'timed out' : 'blocked (cross-origin or network error)'); }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    async function runPool(items, worker, signal) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(EXPORT_CONCURRENCY, items.length) }, async () => {
        while (next < items.length && !signal.aborted) await worker(items[next++]);
      }));
    }
    // Find every URL: the page source first, then the page's own scripts and
    // stylesheets (fetched once; the bytes are reused in the ZIP).
    async function scanForExport(source, fetchCached, signal, progress) {
      const scan = newScan(), base = document.baseURI, from = 'page source';
      if (source.extension === 'html') scanHtml(scan, source.text, base, from);
      else scanText(scan, source.text, base, source.name);
      const files = [...scan.scannable].slice(0, MAX_SCAN_FILES);
      let done = 0;
      progress(`Scanning scripts and stylesheets: 0 of ${files.length}`);
      await runPool(files, async ([href, type]) => {
        try {
          const bytes = await fetchCached(href);
          if (bytes.length <= MAX_SCAN_CHARS) {
            const text = new TextDecoder().decode(bytes);
            if (type === 'css') scanCss(scan, text, href, fileLabel(href));
            else scan.scripts.push({ text, base, from: fileLabel(href) });
          }
        } catch (_) { /* Reported if the file is chosen for download. */ }
        progress(`Scanning scripts and stylesheets: ${++done} of ${files.length}`);
      }, signal);
      const corpus = scan.scripts.map(s => s.text).join('\n;\n');
      for (const script of scan.scripts) scanJs(scan, script.text, script.base, script.from, corpus);
      for (const href of scan.blocked) scan.found.delete(href);
      const ofType = kind => new Set([...scan.scannable].filter(([, type]) => type === kind).map(([href]) => href));
      return { urls: [...scan.found.values()], notes: scan.notes, scannedFiles: files.length, stylesheets: ofType('css'), scriptFiles: ofType('js'), corpus };
    }
    function openExportAllDialog() {
      const source = currentSource();
      const modal = document.createElement('div'); modal.className = 'dialog';
      const box = document.createElement('div'); box.className = 'dialogbox wide'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Export all files');
      const heading = document.createElement('h3'); heading.textContent = 'Export all files';
      const intro = document.createElement('div'); intro.className = 'footerhint';
      const body = document.createElement('div');
      const progress = document.createElement('div'); progress.className = 'exportprogress'; progress.setAttribute('aria-live', 'polite');
      const actions = document.createElement('div'); actions.className = 'actions';
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
      const start = document.createElement('button'); start.dataset.exportStart = 'true'; start.textContent = 'Download ZIP'; start.disabled = true;
      actions.append(cancel, start); box.append(heading, intro, body, progress, actions);
      modal.appendChild(box); root.querySelector('.content').appendChild(modal);
      const controller = new AbortController();
      let downloading = false;
      const close = () => { controller.abort(); modal.remove(); setStatus(statusText.textContent, 'No external requests'); };
      cancel.addEventListener('click', close);
      modal.addEventListener('click', e => { if (e.target === modal && !downloading) close(); });
      modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
      cancel.focus();
      const cache = new Map();
      const fetchCached = href => { if (!cache.has(href)) cache.set(href, fetchBytes(href, controller.signal)); return cache.get(href); };
      const show = text => { progress.textContent = text; setStatus(text, 'Fetching files on request'); };
      scanForExport(source, fetchCached, controller.signal, show).then(({ urls, notes, scannedFiles, stylesheets, scriptFiles, corpus }) => {
        if (controller.signal.aborted) return;
        progress.textContent = '';
        setStatus('Choose the files to export', 'Fetching files on request');
        const shown = urls.slice(0, MAX_EXPORT_URLS);
        intro.textContent = `Found ${urls.length} URL${urls.length === 1 ? '' : 's'} in the source${scannedFiles ? ` and ${scannedFiles} script/stylesheet file${scannedFiles === 1 ? '' : 's'}` : ''}${urls.length > shown.length ? ` (showing the first ${shown.length})` : ''}. Checked files are fetched by this page and saved with the source in a ZIP. Files on other sites download only if they allow cross-origin access; anything that fails is listed in download-report.txt.`;
        const options = document.createElement('div'); options.className = 'footerhint exportsettings';
        options.textContent = `Links in the saved copy: ${state.rewriteUrls ? 'rewritten to the downloaded files' : 'kept as they are'} · Script URLs: ${state.rewriteScripts ? 'rewritten' : 'kept as they are'} · Saved names: ${state.stripQuery ? 'without URL variables' : 'with URL variables'} (change in Settings)`;
        intro.after(options);
        const boxes = [];
        const updateCount = () => { const n = boxes.filter(c => c.checked).length; start.textContent = n ? `Download ZIP (${n} file${n === 1 ? '' : 's'})` : 'Download ZIP (source only)'; };
        for (const [kind, label, hint, checked] of URL_KINDS) {
          const items = shown.filter(u => u.kind === kind);
          if (!items.length) continue;
          const group = document.createElement('div'); group.className = 'urlgroup'; group.dataset.kind = kind;
          const head = document.createElement('label'); head.className = 'urlgroup-head'; head.title = hint;
          const all = document.createElement('input'); all.type = 'checkbox'; all.checked = checked; all.setAttribute('aria-label', `Select all ${label.toLowerCase()}`);
          head.append(all, document.createTextNode(`${label} (${items.length})`));
          const list = document.createElement('div'); list.className = 'urllist';
          const groupBoxes = items.map(item => {
            const row = document.createElement('label'); row.className = 'urlrow'; row.title = `Found in ${item.from}`;
            const check = document.createElement('input'); check.type = 'checkbox'; check.checked = checked; check.value = item.url;
            const text = document.createElement('span'); text.className = 'urltext'; text.textContent = item.url;
            if (item.info) { const info = document.createElement('span'); info.className = 'urlinfo'; info.textContent = `from ${item.info}`; text.append(document.createElement('br'), info); }
            row.append(check, text); list.appendChild(row); boxes.push(check); return check;
          });
          all.addEventListener('change', () => { groupBoxes.forEach(c => { c.checked = all.checked; }); updateCount(); });
          list.addEventListener('change', () => { const on = groupBoxes.filter(c => c.checked).length; all.checked = on === groupBoxes.length; all.indeterminate = on > 0 && on < groupBoxes.length; updateCount(); });
          group.append(head, list); body.appendChild(group);
        }
        if (!shown.length) { const none = document.createElement('div'); none.className = 'empty'; none.textContent = 'No downloadable URLs found. The ZIP will contain the source only.'; body.appendChild(none); }
        if (notes.length) {
          const details = document.createElement('details'); details.className = 'urlgroup urlnotes';
          const summary = document.createElement('summary'); summary.textContent = `Not included (${notes.length})`;
          const list = document.createElement('div'); list.className = 'urllist';
          for (const note of notes) { const row = document.createElement('div'); row.className = 'urlrow'; row.textContent = note; list.appendChild(row); }
          details.append(summary, list); body.appendChild(details);
        }
        updateCount(); start.disabled = false; start.focus();
        start.addEventListener('click', async () => {
          downloading = true;
          const chosen = boxes.filter(c => c.checked).map(c => c.value);
          box.querySelectorAll('input').forEach(c => { c.disabled = true; }); start.disabled = true;
          const used = new Set(), entries = [], report = [], saved = new Map();
          const rewrite = !!state.rewriteUrls, rewriteScripts = !!state.rewriteScripts, stripQuery = !!state.stripQuery;
          const sourceFile = `${safeFilename(source.name)}.${source.extension}`; used.add(sourceFile.toLowerCase());
          let done = 0, failed = 0, bytes = 0;
          const tick = () => show(`Fetched ${done} of ${chosen.length}${failed ? ` · ${failed} failed` : ''}`);
          tick();
          await runPool(chosen, async href => {
            try {
              if (bytes >= MAX_EXPORT_BYTES) throw new Error(`skipped: ZIP size limit (${MAX_EXPORT_BYTES / 1048576} MB) reached`);
              const data = await fetchCached(href);
              bytes += data.length;
              const path = zipPathFor(href, used, stripQuery); saved.set(href, path); entries.push({ href, path, data }); report.push(`OK      ${href}\n        -> ${path}`);
            } catch (e) { failed++; report.push(`FAILED  ${href}\n        ${e.message}`); }
            done++; tick();
          }, controller.signal);
          if (controller.signal.aborted) return;
          let sourceText = source.text;
          const scripts = rewriteScripts ? { corpus } : null;
          if (source.extension === 'html' && (rewrite || rewriteScripts)) {
            // With only script rewriting on, markup outside scripts keeps its URLs.
            sourceText = rewrite ? rewriteHtmlText(sourceText, document.baseURI, saved, sourceFile, scripts)
              : sourceText.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) => open + rewriteJsText(body, document.baseURI, saved, sourceFile, corpus) + close);
          } else if (rewriteScripts && source.extension !== 'html') sourceText = rewriteJsText(sourceText, document.baseURI, saved, sourceFile, corpus);
          for (const entry of entries) {
            let pathname = ''; try { pathname = new URL(entry.href).pathname; } catch (_) {}
            if (rewrite && (stylesheets.has(entry.href) || /\.css$/i.test(pathname))) entry.data = rewriteCssText(new TextDecoder().decode(entry.data), entry.href, saved, entry.path);
            else if (rewriteScripts && (scriptFiles.has(entry.href) || /\.m?js$/i.test(pathname))) entry.data = rewriteJsText(new TextDecoder().decode(entry.data), document.baseURI, saved, sourceFile, corpus);
          }
          entries.unshift({ path: sourceFile, data: sourceText });
          const notesText = notes.length ? `\n\nNot included:\n${notes.map(n => `  ${n}`).join('\n')}` : '';
          const settingsText = `Links: ${rewrite ? 'rewritten to the saved copies (page source and stylesheets)' : 'unchanged'}\nScript URLs: ${rewriteScripts ? 'rewritten to the saved copies (inline and saved scripts)' : 'unchanged'}\nSaved names: ${stripQuery ? 'URL variables (query strings) removed' : 'URL variables kept as a short hash'}`;
          entries.push({ path: 'download-report.txt', data: `Exported from ${location.href}\n${new Date().toISOString()}\nSource: ${sourceFile}\nFiles: ${chosen.length - failed} saved, ${failed} failed\n${settingsText}\n\n${report.join('\n')}${notesText}\n` });
          const zipName = `${safeFilename(source.name)}-files.zip`;
          try { downloadBlob(buildZip(entries), zipName); setStatus(`Exported ${zipName}: ${chosen.length - failed} file${chosen.length - failed === 1 ? '' : 's'} saved${failed ? `, ${failed} failed (see download-report.txt)` : ''}`, `Fetched ${chosen.length} file${chosen.length === 1 ? '' : 's'} on request`); }
          catch (e) { setStatus(`Export failed: ${e.message}`); }
          modal.remove();
        });
      });
    }
    function updateSourceButtons() {
      const beautify = root.querySelector('[data-action="beautify-source"]');
      const html = !stateLocal.sourceOverride;
      beautify.disabled = !html;
      beautify.title = html ? 'Beautify: indent the HTML one element per line' : 'Beautify applies to the page HTML';
      beautify.setAttribute('aria-pressed', String(html && stateLocal.sourceBeautify));
    }
    function renderSource() {
      if (state.activeTab !== 'source') return;
      updateSourceButtons();
      if (stateLocal.sourceOverride) {
        root.querySelector('#source-label').textContent = `Resource view: ${stateLocal.sourceOverride.name} (temporary)`;
        sourceView.innerHTML = highlightCode(stateLocal.sourceOverride.value, stateLocal.sourceOverride.language); stateLocal.sourceFindFrom = 0;
        return;
      }
      root.querySelector('#source-label').textContent = `Reconstructed live DOM${stateLocal.sourceBeautify ? ' · beautified' : ''} · not original response`;
      stateLocal.sourceText = stateLocal.sourceBeautify ? beautifiedSourceHTML() : sourceHTML(); stateLocal.sourceFindFrom = 0;
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
        const kind=document.createElement('span'); kind.className='kind'; kind.textContent=entry.level==='command'?'>':entry.level.toUpperCase();
        const msg=document.createElement('span'); msg.textContent=entry.value;
        row.append(stamp,kind,msg); consoleLog.appendChild(row);
      }
      consoleLog.scrollTop=consoleLog.scrollHeight;
    }
    async function executeCommand() {
      const input=root.querySelector('#command'); const code=input.value.trim(); if(!code) return;
      stateLocal.commandHistory.push(code); stateLocal.historyIndex=stateLocal.commandHistory.length;
      addConsoleEntry('command',[code]);
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
      if (state.closed) stopLocate();
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
      renderSettings();
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
        case 'locate-element': locateElement();break;
        case 'delete-element': deleteElement();break;
        case 'add-element': addElementDialog();break;
        case 'refresh-element': renderDetails();renderTree();break;
        case 'expand-all': { const stack=[document.documentElement];let n=0;while(stack.length&&n++<2000){const el=stack.pop();if(!el||excluded(el))continue;stateLocal.expanded.add(el);childElements(el).forEach(c=>stack.push(c));}renderTree();setStatus('Expanded accessible document branches');break; }
        case 'undo-delete': undoDelete();break;
        case 'tree-earlier': shiftTreeWindow(-1);break;
        case 'tree-later': shiftTreeWindow(1);break;
        case 'search-elements': searchElements();break;
        case 'search-next': stepSearch(1);break;
        case 'search-prev': stepSearch(-1);break;
        case 'execute': executeCommand();break;
        case 'clear-console':stateLocal.consoleEntries=[];renderConsole();break;
        case 'clear-history':stateLocal.commandHistory=[];stateLocal.historyIndex=0;safeSave();setStatus('Command history cleared');break;
        case 'beautify-source':if(stateLocal.sourceOverride)break;stateLocal.sourceBeautify=!stateLocal.sourceBeautify;renderSource();setStatus(stateLocal.sourceBeautify?'Source beautified':'Showing source as serialized');break;
        case 'export-source':toggleExportMenu();break;
        case 'export-source-file':closeExportMenu();exportSource();break;
        case 'export-all-files':closeExportMenu();openExportAllDialog();break;
        case 'copy-source':copyText(currentSource().text).then(()=>setStatus('Source copied'),()=>setStatus('Clipboard access unavailable'));break;
        case 'refresh-source':stateLocal.sourceOverride=null;renderSource();setStatus('Reconstructed source refreshed');break;
        case 'source-find':findSource();break;
        default: if(name.startsWith('resource-'))resourceAction(name);
      }
    }
    let searchResults=[], searchIndex=-1;
    function searchElements() {
      const q=(root.querySelector('#element-filter')?.value||'').trim().toLowerCase();
      searchResults=[];searchIndex=-1;if(!q){setStatus('Enter a search query');return;}
      const rootEl=document.documentElement;if(!rootEl)return setStatus('Document is not available');
      const walker=document.createTreeWalker(rootEl,NodeFilter.SHOW_ELEMENT,{acceptNode:n=>excluded(n)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});let n=rootEl,count=0;
      // Match each element's own text only; otherwise every ancestor of a hit matches too.
      const ownText=el=>[...el.childNodes].filter(c=>c.nodeType===Node.TEXT_NODE).map(c=>c.nodeValue).join('').slice(0,300);
      do{const hay=`${n.localName} ${n.id} ${n.getAttribute('class')||''} ${[...n.attributes].map(a=>`${a.name}=${a.value}`).join(' ')} ${ownText(n)}`.toLowerCase();if(hay.includes(q))searchResults.push(n);count++;}while((n=walker.nextNode())&&count<10000);
      if(searchResults.length)stepSearch(1);else setStatus(`No matches for “${q}”`);
    }
    function stepSearch(dir){if(!searchResults.length)return;searchIndex=(searchIndex+dir+searchResults.length)%searchResults.length;const el=searchResults[searchIndex];selectElement(el);setStatus(`Search result ${searchIndex+1} of ${searchResults.length}`);}
    function findSource(){
      const q=stateLocal.sourceSearch;if(!q)return;
      const text=sourceView.textContent.toLowerCase(),needle=q.toLowerCase();
      let i=text.indexOf(needle,stateLocal.sourceFindFrom);if(i<0&&stateLocal.sourceFindFrom>0)i=text.indexOf(needle);
      if(i<0){stateLocal.sourceFindFrom=0;return setStatus('Text not found');}
      stateLocal.sourceFindFrom=i+1;
      let total=0,index=0;for(let at=text.indexOf(needle);at>=0;at=text.indexOf(needle,at+1)){total++;if(at<=i)index=total;}
      const locate=(pos,isEnd)=>{const walker=document.createTreeWalker(sourceView,NodeFilter.SHOW_TEXT);let node,offset=pos;while((node=walker.nextNode())){if(isEnd?offset<=node.length:offset<node.length)return[node,offset];offset-=node.length;}return null;};
      const start=locate(i,false),end=locate(i+needle.length,true);if(!start||!end)return;
      const range=document.createRange();range.setStart(...start);range.setEnd(...end);
      const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
      const rect=range.getBoundingClientRect(),view=sourceView.getBoundingClientRect();
      sourceView.scrollTop+=rect.top-view.top-sourceView.clientHeight/2;sourceView.scrollLeft+=rect.left-view.left-30;
      setStatus(`Match ${index} of ${total}`);
    }

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
      listen(window,'pointerdown',e=>{if(!exportMenu)return;const path=e.composedPath();if(path.includes(exportMenu)||path.includes(exportButton()))return;closeExportMenu();},true);
      listen(document,'pointerleave',()=>{if(stateLocal.picking && stateLocal.pickPointerId===null){stateLocal.pickPoint=null;updatePickHighlight();}});
      listen(window,'blur',()=>{if(stateLocal.picking && stateLocal.pickPointerId!==null)cancelPicker();else if(stateLocal.picking){stateLocal.pickPoint=null;updatePickHighlight();}else stateLocal.pickGesture=null;});
      listen('.title','pointerdown',startDrag);
      listen('.title','pointermove',moveDrag);listen('.title','pointerup',endDrag);listen('.title','pointercancel',endDrag);listen('.title','lostpointercapture',endDrag);
      root.querySelectorAll('[data-resize]').forEach(h=>{h.addEventListener('pointerdown',startResize);h.addEventListener('pointermove',moveResize);h.addEventListener('pointerup',endResize);h.addEventListener('pointercancel',endResize);});
      listen('#resource-filter','input',refreshResources);
      listen(root,'change',e=>{const key=e.target?.dataset?.setting;if(!key)return;state[key]=e.target.checked;safeSave();setStatus(`${e.target.closest('.setting').querySelector('strong').textContent}: ${e.target.checked?'on':'off'}`);});
      listen('#command','keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();executeCommand();}else if(e.key==='ArrowUp'&&e.target.selectionStart===0){e.preventDefault();stateLocal.historyIndex=Math.max(0,stateLocal.historyIndex-1);e.target.value=stateLocal.commandHistory[stateLocal.historyIndex]||'';}else if(e.key==='ArrowDown'&&e.target.selectionStart===e.target.value.length){e.preventDefault();stateLocal.historyIndex=Math.min(stateLocal.commandHistory.length,stateLocal.historyIndex+1);e.target.value=stateLocal.commandHistory[stateLocal.historyIndex]||'';}});
      // The toolbar is rebuilt on every tab switch, so its inputs are handled by delegation.
      listen(root,'keydown',e=>{if(e.key!=='Enter')return;const id=e.target?.id;if(id==='element-filter'){e.preventDefault();searchElements();}else if(id==='source-search'){e.preventDefault();findSource();}});
      listen(root,'input',e=>{const id=e.target?.id;if(id==='element-filter')stateLocal.elementSearch=e.target.value;else if(id==='source-search'){stateLocal.sourceSearch=e.target.value;stateLocal.sourceFindFrom=0;}});
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
      destroy:()=>{safeSave();stopPicker();stopLocate();clearTimeout(stateLocal.pickClickTimer);clearTimeout(stateLocal.historyTimer);cancelAnimationFrame(stateLocal.highlightRaf);stateLocal.listeners.forEach(fn=>fn());for(const [name,fn] of Object.entries(originalConsole)){try{executionWindow.console[name]=fn}catch(_){}}if(options.saveEvent)document.dispatchEvent(new CustomEvent(options.saveEvent,{detail:'destroy'}));try{reopenButton.remove();host.remove();}catch(_){}},
    };
    window[INSTANCE_KEY]=api;
    if(promoteLocal)safeSave(true);
    setStatus('Ready · page data stays on this device');
  });
})();
