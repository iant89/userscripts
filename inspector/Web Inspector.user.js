// ==UserScript==
// @name         Web Inspector
// @namespace    https://github.com/iant89/userscripts
// @version      0.1.0
// @description  A mobile-friendly, self-contained web inspector for the current page.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Web Inspector — dependency-free userscript.
 * The userscript context provides the UI; page operations are deliberately
 * limited to the DOM/storage APIs exposed to this script. JavaScript execution
 * is available only after an explicit Execute action in the Console.
 */
(() => {
  'use strict';

  const APP_ID = 'web-inspector-host-v1';
  const INSTANCE_KEY = '__webInspectorInstanceV1';
  const STORAGE_KEY = 'webInspector.preferences.v1';
  const MAX_TREE_NODES = 500;
  const MAX_CONSOLE_ENTRIES = 250;
  const SNAP_DISTANCE = 34;
  const SNAP_DELAY = 280;
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  let app = window[INSTANCE_KEY];
  if (app && app.host?.isConnected) return;
  if (app) { try { app.destroy(); } catch (_) {} }

  const defaultState = {
    x: 18, y: 70, width: 720, height: 520, dock: 'float', collapsed: false,
    activeTab: 'elements', theme: 'dark', lastResourceType: 'local', opacity: true,
  };
  let state = { ...defaultState };
  let saveTimer;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (stored && typeof stored === 'object') state = { ...state, ...stored };
  } catch (_) { /* Storage may be disabled; keep in-memory defaults. */ }

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
      button{font:inherit;color:inherit;border:1px solid transparent;background:transparent;border-radius:7px;min-width:36px;height:34px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px}button:hover{background:#ffffff12;border-color:#ffffff14}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.icon{font-size:16px;line-height:1}.title button{width:38px;height:38px;font-size:18px}.close:hover{background:#9f3942}.tabs{display:flex;gap:4px;padding:6px 8px;background:var(--panel);border-bottom:1px solid var(--line);overflow:auto;scrollbar-width:thin}.tab{white-space:nowrap;color:var(--muted);padding:5px 11px}.tab[aria-selected="true"]{color:var(--text);background:#2d4056;border-color:#47607c}.toolbar{display:flex;align-items:center;gap:4px;min-height:42px;padding:4px 8px;background:#141a23;border-bottom:1px solid var(--line);overflow:auto}.toolbar .spacer{flex:1}.toolbar button{min-width:36px}.content{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}.panel{display:none;flex:1;min-height:0;min-width:0}.panel.active{display:flex}.columns{display:flex;flex:1;min-width:0;min-height:0}.treepane{width:42%;min-width:115px;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}.detailpane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}.subhead{padding:6px 9px;color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:6px}.tree,.scroll{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1;padding:6px}.tree-row{height:auto;min-height:25px;display:flex;align-items:center;gap:4px;padding:2px 5px;border-radius:5px;white-space:nowrap;overflow:hidden;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.tree-row:hover{background:#ffffff0a}.tree-row.selected{background:#23507a;color:#fff}.tree-row .twisty{width:18px;min-width:18px;height:22px;padding:0;color:var(--muted)}.tree-row .tag{color:#7ec8ff}.tree-row .meta{color:#b3becb;overflow:hidden;text-overflow:ellipsis}.muted{color:var(--muted)}.empty{padding:18px;color:var(--muted);text-align:center}.field{width:100%;background:#0d1118;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 8px;font:inherit}.field.small{padding:5px 7px}.field,textarea,select{font-size:14px}.editor{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;min-height:60px;max-height:35%;tab-size:2}.label{font-size:11px;color:var(--muted);margin:9px 0 4px}.detail-actions{display:flex;gap:5px;flex-wrap:wrap;padding:7px;border-bottom:1px solid var(--line)}.htmlview,.sourceview{margin:0;white-space:pre;overflow:auto;flex:1;padding:10px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;color:#d7e2ef}.tok-tag{color:#76c7ff}.tok-attr{color:#c6a0f6}.tok-str{color:#a7dc8b}.tok-comment{color:#718096}.tok-text{color:#d7e2ef}.tok-key{color:#f0c674}.tok-num{color:#ef9f76}.tok-punc{color:#b9c5d3}.status{min-height:24px;padding:3px 9px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center}.status .right{margin-left:auto}.consolepanel{flex-direction:column}.consolelog{flex:1;min-height:0;overflow:auto;padding:5px}.entry{padding:5px 8px;border-bottom:1px solid #ffffff0b;white-space:pre-wrap;overflow-wrap:anywhere}.entry.warn{background:#7d5b1b22}.entry.error{background:#842d3828}.entry.debug{color:#b1a5cf}.entry .stamp{color:#8594a7;font-size:10px;margin-right:7px}.entry .kind{font-weight:700;margin-right:6px}.command-area{border-top:1px solid var(--line);padding:7px;display:flex;gap:7px;align-items:flex-end}.command-area textarea{flex:1;min-height:40px;max-height:125px;resize:vertical;font:13px/1.4 ui-monospace,monospace}.resourcepanel{flex-direction:column}.resource-type{display:flex;padding:6px 8px;gap:4px;border-bottom:1px solid var(--line)}.resource-type button[aria-pressed="true"]{background:#2d4056}.reslist{flex:1;min-height:0;overflow:auto}.resrow{display:grid;grid-template-columns:minmax(90px,1fr) minmax(80px,2fr);gap:8px;padding:7px 9px;border-bottom:1px solid #ffffff0a;cursor:pointer}.resrow:hover{background:#ffffff0a}.resrow.selected{background:#23507a}.reskey,.resvalue{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reskey{font:12px ui-monospace,monospace;color:#a9d5ff}.resvalue{color:var(--muted)}.filterbox{width:150px}.sourcepanel{flex-direction:column}.sourcebar{display:flex;align-items:center;gap:7px;padding:5px 8px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}.sourceview{flex:1}.notice{background:#573e14;color:#ffe1a3;padding:6px 9px;font-size:11px}.resize{position:absolute;z-index:5;touch-action:none}.resize.e,.resize.w{top:14px;bottom:14px;width:10px;cursor:ew-resize}.resize.e{right:-4px}.resize.w{left:-4px}.resize.n,.resize.s{height:10px;left:14px;right:14px;cursor:ns-resize}.resize.n{top:-4px}.resize.s{bottom:-4px}.resize.ne,.resize.nw,.resize.se,.resize.sw{width:18px;height:18px;z-index:6}.resize.ne{right:-4px;top:-4px;cursor:nesw-resize}.resize.nw{left:-4px;top:-4px;cursor:nwse-resize}.resize.se{right:-4px;bottom:-4px;cursor:nwse-resize}.resize.sw{left:-4px;bottom:-4px;cursor:nesw-resize}.ghost{position:fixed;z-index:2147483645;border:2px solid #70c5ff;background:#55aeef33;border-radius:10px;pointer-events:none;display:none;transition:all .18s}.wi.collapsed .tabs,.wi.collapsed .content,.wi.collapsed .status,.wi.collapsed .resize{display:none}.wi.collapsed{height:44px!important;min-height:44px!important;border-radius:10px}.wi.dock-left,.wi.dock-right{border-radius:0}.wi.dock-top,.wi.dock-bottom{border-radius:0}.wi.dock-top .title{order:2;border-top:1px solid var(--line);border-bottom:0}.wi.dock-top .tabs{order:0}.wi.dock-top .toolbar{order:1}.wi.dock-top .content{order:0}.wi.dock-bottom .title{order:0}.wi.dock-bottom .tabs{order:1}.wi.dock-bottom .toolbar{order:2}.wi.dock-bottom .content{order:3}.wi.dock-top.collapsed{transform:translateY(calc(-100% + 44px))}.wi.dock-bottom.collapsed{transform:translateY(calc(100% - 44px))}.wi.dock-left.collapsed{transform:translateX(calc(-100% + 54px))}.wi.dock-right.collapsed{transform:translateX(calc(100% - 54px))}.dialog{position:absolute;z-index:10;inset:0;background:#0009;display:grid;place-items:center;padding:16px}.dialogbox{width:min(440px,100%);max-height:90%;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;box-shadow:0 15px 55px #000b}.dialogbox h3{margin:0 0 10px}.dialogbox .actions{display:flex;justify-content:flex-end;gap:6px;margin-top:12px}.pickmask{position:fixed;inset:0;z-index:2147483644;cursor:crosshair;background:#2c84cf12;pointer-events:auto}.pickbox{position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #46b7ff;background:#43adff25}.footerhint{font-size:11px;color:var(--muted)}
      @media(max-width:600px){.wi{min-width:280px;border-radius:10px}.treepane{width:39%;min-width:100px}.context{display:none}.toolbar{min-height:40px}.toolbar button{min-width:38px}.tabs{gap:2px}.tab{padding:5px 8px}.resrow{grid-template-columns:minmax(75px,1fr) minmax(65px,1fr)}}
      @media(prefers-reduced-motion:reduce){.wi,.ghost{transition:none!important}}
    `;

    root.innerHTML = `<style>${css}</style>
      <div class="wi" role="application" aria-label="Web Inspector">
        <div class="title" part="titlebar">
          <div class="brand"><span class="logo" aria-hidden="true">⌕</span><span class="titletext">Web Inspector</span><span class="context">this page</span></div>
          <button data-action="collapse" title="Collapse or expand" aria-label="Collapse or expand">−</button>
          <button data-action="close" title="Hide inspector" aria-label="Hide inspector" class="close">×</button>
        </div>
        <nav class="tabs" role="tablist" aria-label="Inspector tools">
          <button class="tab" role="tab" data-tab="elements" aria-selected="true">⌘ Elements</button>
          <button class="tab" role="tab" data-tab="console" aria-selected="false">› Console</button>
          <button class="tab" role="tab" data-tab="source" aria-selected="false">▤ Source</button>
          <button class="tab" role="tab" data-tab="resources" aria-selected="false">▧ Resources</button>
        </nav>
        <div class="toolbar" id="toolbar"></div>
        <main class="content">
          <section class="panel active" data-panel="elements"><div class="columns">
            <div class="treepane"><div class="subhead">Document tree <span class="spacer"></span><button data-action="expand-all" title="Expand document tree" aria-label="Expand document tree">⊞</button></div><div class="tree" id="tree"></div></div>
            <div class="detailpane"><div class="subhead" id="selected-label">No element selected</div><div class="detail-actions"><button data-action="pick" title="Pick an element from the page" aria-label="Pick an element from the page">⌖</button><button data-action="visibility" title="Toggle selected element visibility" aria-label="Toggle selected element visibility">◉</button><button data-action="delete-element" title="Delete selected element (Undo available)" aria-label="Delete selected element">⌫</button><button data-action="add-element" title="Add an element" aria-label="Add an element">＋</button><button data-action="refresh-element" title="Refresh selected element" aria-label="Refresh selected element">↻</button></div>
              <div class="scroll" id="details"><div class="empty">Select an element in the tree or use Pick Target.</div></div>
            </div>
          </div></section>
          <section class="panel consolepanel" data-panel="console"><div class="notice">Page-context console capture is best-effort. Commands run in the page context only after you press Execute.</div><div class="consolelog" id="consolelog" aria-live="polite"></div><div class="command-area"><textarea class="field" id="command" placeholder="JavaScript command — Enter executes, Shift+Enter adds a line" aria-label="JavaScript command"></textarea><button data-action="execute" title="Execute command" aria-label="Execute command">▶</button></div></section>
          <section class="panel sourcepanel" data-panel="source"><div class="sourcebar"><span id="source-label">Reconstructed live DOM</span><span class="spacer"></span><button data-action="copy-source" title="Copy source" aria-label="Copy source">▢</button><button data-action="refresh-source" title="Refresh source" aria-label="Refresh source">↻</button></div><pre class="sourceview" id="sourceview" tabindex="0"></pre></section>
          <section class="panel resourcepanel" data-panel="resources"><div class="resource-type" role="tablist" aria-label="Storage type"><button data-resource="local" aria-pressed="true">Local</button><button data-resource="session" aria-pressed="false">Session</button><button data-resource="cookie" aria-pressed="false">Cookies</button></div><div class="toolbar" style="border-bottom:1px solid var(--line)"><input class="field small filterbox" id="resource-filter" placeholder="Filter resources" aria-label="Filter resources"><span class="spacer"></span><button data-action="resource-copy" title="Copy selected resource" aria-label="Copy selected resource">▢</button><button data-action="resource-view" title="View selected value in Source" aria-label="View selected value in Source">◫</button><button data-action="resource-delete" title="Delete selected resource" aria-label="Delete selected resource">⌫</button><button data-action="resource-clean" title="Clear this storage category" aria-label="Clear this storage category">✕</button><button data-action="resource-refresh" title="Refresh resources" aria-label="Refresh resources">↻</button></div><div class="reslist" id="reslist"></div><div class="status" id="resource-status">Accessible storage for this origin</div></section>
        </main>
        <div class="status"><span id="status-text">Ready</span><span class="right" id="status-right">No external requests</span></div>
        <div class="resize n" data-resize="n"></div><div class="resize s" data-resize="s"></div><div class="resize e" data-resize="e"></div><div class="resize w" data-resize="w"></div><div class="resize ne" data-resize="ne"></div><div class="resize nw" data-resize="nw"></div><div class="resize se" data-resize="se"></div><div class="resize sw" data-resize="sw"></div>
      </div><div class="ghost"></div>`;

    const win = root.querySelector('.wi');
    const ghost = root.querySelector('.ghost');
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
      removed: null, hidden: new WeakMap(), picking: false, pickOverlay: null, pickHighlight: null,
      drag: null, resize: null, snapTimer: 0, snapDock: null, raf: 0, listeners: [],
    };
    if (document.documentElement) stateLocal.expanded.add(document.documentElement);
    if (document.body) stateLocal.expanded.add(document.body);

    function safeSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, activeTab: state.activeTab, lastResourceType: stateLocal.resourceType })); } catch (_) {}
      }, 160);
    }
    function setStatus(text, right) {
      statusText.textContent = text;
      if (right) root.querySelector('#status-right').textContent = right;
    }
    function usableViewport() {
      const vv = window.visualViewport;
      return { w: Math.max(280, Math.floor(vv?.width || innerWidth)), h: Math.max(140, Math.floor(vv?.height || innerHeight)), left: Math.floor(vv?.offsetLeft || 0), top: Math.floor(vv?.offsetTop || 0) };
    }
    function persistGeom() { safeSave(); }
    function applyGeometry() {
      const v = usableViewport();
      win.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom');
      if (state.dock === 'left' || state.dock === 'right') {
        const width = clamp(Number(state.width) || Math.min(430, v.w * .46), 280, Math.max(280, v.w * .5));
        Object.assign(win.style, { left: state.dock === 'left' ? `${v.left}px` : `${v.left + v.w - width}px`, top: `${v.top}px`, width: `${width}px`, height: `${v.h}px`, maxWidth: 'none', maxHeight: 'none' });
        win.classList.add(`dock-${state.dock}`);
      } else if (state.dock === 'top' || state.dock === 'bottom') {
        const height = clamp(Number(state.height) || v.h * .48, 140, v.h * .72);
        Object.assign(win.style, { left: `${v.left}px`, top: state.dock === 'top' ? `${v.top}px` : `${v.top + v.h - height}px`, width: `${v.w}px`, height: `${height}px`, maxWidth: 'none', maxHeight: 'none' });
        win.classList.add(`dock-${state.dock}`);
      } else {
        state.width = clamp(Number(state.width) || Math.min(720, v.w - 12), 280, v.w - 12);
        state.height = clamp(Number(state.height) || Math.min(520, v.h - 12), 140, v.h - 12);
        state.x = clamp(Number(state.x) || 0, v.left + 2, v.left + v.w - state.width - 2);
        state.y = clamp(Number(state.y) || 0, v.top + 2, v.top + v.h - (state.collapsed ? 44 : 44) - 2);
        Object.assign(win.style, { left: `${state.x}px`, top: `${state.y}px`, width: `${state.width}px`, height: `${state.height}px`, maxWidth: `${v.w - 4}px`, maxHeight: `${v.h - 4}px` });
      }
      win.classList.toggle('collapsed', !!state.collapsed);
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
      if (save) safeSave();
    }
    function buildToolbar() {
      const tab = state.activeTab;
      if (tab === 'elements') toolbar.innerHTML = `<input class="field small" id="element-filter" style="width:min(230px,55vw)" placeholder="Search elements…" aria-label="Search elements"><button data-action="search-elements" title="Search elements" aria-label="Search elements">⌕</button><button data-action="search-next" title="Next search result" aria-label="Next result">↓</button><button data-action="search-prev" title="Previous search result" aria-label="Previous result">↑</button><span class="spacer"></span>${stateLocal.removed ? '<button data-action="undo-delete" title="Undo most recent deletion" aria-label="Undo deletion">Undo</button>' : ''}<button data-action="pick" title="Pick target on page" aria-label="Pick target on page">⌖ Pick</button>`;
      else if (tab === 'console') toolbar.innerHTML = `<span class="muted">Execution target: current page</span><span class="spacer"></span><button data-action="clear-console" title="Clear console output" aria-label="Clear console output">Clear</button><button data-action="clear-history" title="Clear command history" aria-label="Clear command history">History</button>`;
      else if (tab === 'source') toolbar.innerHTML = `<span class="muted">Read-only representation</span><span class="spacer"></span><input class="field small" id="source-search" style="width:min(180px,45vw)" placeholder="Find in source" aria-label="Find in source"><button data-action="source-find" title="Find in source" aria-label="Find in source">⌕</button><button data-action="copy-source" title="Copy source" aria-label="Copy source">▢ Copy</button>`;
      else toolbar.innerHTML = `<span class="muted">Accessible page storage</span><span class="spacer"></span>`;
    }
    function excluded(el) { return el === host || el?.closest?.(`#${APP_ID}`) || el?.hasAttribute?.('data-web-inspector-host'); }
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
      const toggle = document.createElement('button'); toggle.className = 'twisty'; toggle.textContent = children.length ? (stateLocal.expanded.has(el) ? '▾' : '▸') : '·';
      toggle.setAttribute('aria-label', children.length ? (stateLocal.expanded.has(el) ? 'Collapse element' : 'Expand element') : 'No children');
      toggle.disabled = !children.length;
      toggle.addEventListener('click', (ev) => { ev.stopPropagation(); stateLocal.expanded.has(el) ? stateLocal.expanded.delete(el) : stateLocal.expanded.add(el); renderTree(); });
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `${stateLocal.hidden.has(el) ? '◌ ' : ''}<${el.localName || el.nodeName.toLowerCase()}>`;
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
      renderTree(); renderDetails();
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
      if (!el || !el.isConnected) { stateLocal.selected = null; label.textContent = 'No element selected'; details.innerHTML = '<div class="empty">Select an element in the tree or use Pick Target.</div>'; return; }
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
      renderTree(); renderDetails();
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

    function getPickTarget(x, y) {
      let el = document.elementFromPoint(x, y);
      while (el && (excluded(el) || el === stateLocal.pickOverlay || el === stateLocal.pickHighlight)) el = el.parentElement;
      // descend open shadow roots when hit testing reports their host
      let changed = true;
      while (el?.shadowRoot && changed) {
        changed = false;
        const inner = el.shadowRoot.elementFromPoint?.(x, y);
        if (inner && inner !== el) { el = inner; changed = true; }
      }
      return el;
    }
    function startPicker() {
      if (stateLocal.picking) return;
      stateLocal.picking = true;
      const overlay = document.createElement('div'); overlay.className = 'pickmask'; overlay.setAttribute('aria-label', 'Tap an element to select it; press Escape to cancel');
      const highlight = document.createElement('div'); highlight.className = 'pickbox';
      document.documentElement.append(overlay, highlight); stateLocal.pickOverlay = overlay; stateLocal.pickHighlight = highlight;
      // Let hit-testing pass through to the page while observing pointer events at capture phase.
      overlay.style.pointerEvents = 'none'; highlight.style.pointerEvents = 'none';
      win.style.opacity = '0.22'; win.style.pointerEvents = 'none';
      const move = e => { const t = getPickTarget(e.clientX, e.clientY); if (!t) return; const r=t.getBoundingClientRect(); Object.assign(highlight.style,{left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`}); };
      const choose = e => {
        const t = getPickTarget(e.clientX, e.clientY); if (!t) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); stopPicker();
        updateTab('elements'); selectElement(t); setStatus(`Selected ${elementDescription(t)}`);
      };
      const key = e => { if(e.key==='Escape') stopPicker(); };
      document.addEventListener('pointermove', move, true); document.addEventListener('pointerdown', choose, true); document.addEventListener('keydown',key,true);
      stateLocal.pickHandlers = { move, choose, key };
      setStatus('Pick mode: tap a page element; Escape cancels');
    }
    function stopPicker() {
      if (!stateLocal.picking) return;
      const { move, choose, key } = stateLocal.pickHandlers || {};
      document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerdown', choose, true); document.removeEventListener('keydown',key,true);
      stateLocal.pickOverlay?.remove(); stateLocal.pickHighlight?.remove(); stateLocal.pickOverlay=null;stateLocal.pickHighlight=null;stateLocal.picking=false;
      win.style.opacity=''; win.style.pointerEvents='';
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
          const original=console[method]; if(typeof original!=='function') continue; originalConsole[method]=original;
          console[method]=function(...args) {
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
      addConsoleEntry('debug',[`Executing in page context: ${code}`]);
      input.value='';
      try {
        // Explicit user-triggered page-context execution. This is intentionally not used by inspector internals.
        const result = (0, eval)(code);
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

    function action(name) {
      switch(name){
        case 'collapse': state.collapsed=!state.collapsed;win.classList.toggle('collapsed',state.collapsed);safeSave();break;
        case 'close': win.classList.add('closed');safeSave();setStatus('Inspector hidden. Use the page button to reopen.');break;
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
        state.dock='float';state.x=clamp(e.clientX-relX,0,innerWidth-state.width);state.y=clamp(e.clientY-relY,0,innerHeight-44);applyGeometry();
      }
      const rect=win.getBoundingClientRect();stateLocal.drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,x:rect.left,y:rect.top,offsetX:e.clientX-rect.left,offsetY:e.clientY-rect.top};
      win.classList.add('dragging');try{e.currentTarget.setPointerCapture(e.pointerId)}catch(_){}
      e.preventDefault();
    }
    function moveDrag(e) {
      const d=stateLocal.drag;if(!d||d.id!==e.pointerId)return;
      const v=usableViewport();const x=clamp(e.clientX-d.offsetX,v.left,v.left+v.w-win.offsetWidth);const y=clamp(e.clientY-d.offsetY,v.top,v.top+v.h-44);
      state.x=x;state.y=y;
      if(!stateLocal.raf)stateLocal.raf=requestAnimationFrame(()=>{stateLocal.raf=0;win.style.left=`${x}px`;win.style.top=`${y}px`;});
      const dock=getDockAt(e.clientX,e.clientY);
      if(dock!==stateLocal.snapDock){clearTimeout(stateLocal.snapTimer);stateLocal.snapDock=dock;ghost.style.display='none';if(dock)stateLocal.snapTimer=setTimeout(()=>{if(stateLocal.drag&&stateLocal.snapDock===dock)positionGhost(dock);},SNAP_DELAY);}
    }
    function endDrag(e) {
      if(!stateLocal.drag)return;clearTimeout(stateLocal.snapTimer);const dock=ghost.style.display==='block'?stateLocal.snapDock:null;ghost.style.display='none';stateLocal.drag=null;win.classList.remove('dragging');
      if(dock){state.dock=dock;const r=dockRect(dock);if(dock==='left'||dock==='right')state.width=r.w;else state.height=r.h;}
      applyGeometry();persistGeom();
    }
    function startResize(e) {
      if(state.dock!=='float')return;
      const edge=e.currentTarget.dataset.resize,rect=win.getBoundingClientRect();stateLocal.resize={id:e.pointerId,edge,startX:e.clientX,startY:e.clientY,x:rect.left,y:rect.top,w:rect.width,h:rect.height};win.classList.add('resizing');try{e.currentTarget.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();e.stopPropagation();
    }
    function moveResize(e) {
      const r=stateLocal.resize;if(!r||r.id!==e.pointerId)return;const dx=e.clientX-r.startX,dy=e.clientY-r.startY,v=usableViewport();let {x,y,w,h}=r;
      if(r.edge.includes('e'))w+=dx;if(r.edge.includes('s'))h+=dy;if(r.edge.includes('w')){x+=dx;w-=dx;}if(r.edge.includes('n')){y+=dy;h-=dy;}
      w=clamp(w,280,v.w-8);h=clamp(h,140,v.h-8);x=clamp(x,v.left,v.left+v.w-w);y=clamp(y,v.top,v.top+v.h-h);state.x=x;state.y=y;state.width=w;state.height=h;
      if(!stateLocal.raf)stateLocal.raf=requestAnimationFrame(()=>{stateLocal.raf=0;Object.assign(win.style,{left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`});});
    }
    function endResize(){if(!stateLocal.resize)return;stateLocal.resize=null;win.classList.remove('resizing');persistGeom();}

    function setUpEvents() {
      const listen=(target,type,fn,opts)=>{const node=typeof target==='string'?root.querySelector(target):target;if(!node)return;node.addEventListener(type,fn,opts);stateLocal.listeners.push(()=>node.removeEventListener(type,fn,opts));};
      listen(root,'click',e=>{const b=e.target.closest('[data-action]');if(b){action(b.dataset.action);return;}const tab=e.target.closest('[data-tab]');if(tab){updateTab(tab.dataset.tab);return;}const resource=e.target.closest('[data-resource]');if(resource){changeResourceType(resource.dataset.resource);return;}});
      listen('.title','pointerdown',startDrag);
      listen('.title','pointermove',moveDrag);listen('.title','pointerup',endDrag);listen('.title','pointercancel',endDrag);listen('.title','lostpointercapture',endDrag);
      root.querySelectorAll('[data-resize]').forEach(h=>{h.addEventListener('pointerdown',startResize);h.addEventListener('pointermove',moveResize);h.addEventListener('pointerup',endResize);h.addEventListener('pointercancel',endResize);});
      listen('#resource-filter','input',refreshResources);
      listen('#command','keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();executeCommand();}else if(e.key==='ArrowUp'&&e.target.selectionStart===0){e.preventDefault();stateLocal.historyIndex=Math.max(0,stateLocal.historyIndex-1);e.target.value=stateLocal.commandHistory[stateLocal.historyIndex]||'';}else if(e.key==='ArrowDown'&&e.target.selectionStart===e.target.value.length){e.preventDefault();stateLocal.historyIndex=Math.min(stateLocal.commandHistory.length,stateLocal.historyIndex+1);e.target.value=stateLocal.commandHistory[stateLocal.historyIndex]||'';}});
      listen('#element-filter','keydown',e=>{if(e.key==='Enter'){searchElements();e.preventDefault();}});
      listen('#source-search','keydown',e=>{if(e.key==='Enter')findSource();});
      listen(win,'pointerenter',()=>win.classList.remove('idle'));listen(win,'pointerleave',()=>{if(state.dock==='float'&&!stateLocal.drag&&!stateLocal.resize&&matchMedia('(hover: hover)').matches)win.classList.add('idle');});
      const resize=()=>{if(state.dock==='float')applyGeometry();else applyGeometry();};listen(window,'resize',resize);if(window.visualViewport){listen(window.visualViewport,'resize',resize);listen(window.visualViewport,'scroll',resize);}
      listen(window,'keydown',e=>{if(e.key==='Escape'&&stateLocal.picking)stopPicker();if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='i'){e.preventDefault();win.classList.toggle('closed');}});
      listen(window,'storage',e=>{if(e.key===STORAGE_KEY)return; if(state.activeTab==='resources')refreshResources();});
    }

    function addReopenButton() {
      const button=document.createElement('button');button.type='button';button.dataset.webInspectorReopen='true';button.textContent='⌕';button.title='Open Web Inspector';button.setAttribute('aria-label','Open Web Inspector');
      button.style.cssText='position:fixed!important;right:12px!important;bottom:calc(12px + env(safe-area-inset-bottom,0px))!important;z-index:2147483645!important;width:44px!important;height:44px!important;border-radius:50%!important;border:1px solid #78bdf5!important;background:#172b40!important;color:white!important;font:700 20px/1 -apple-system,BlinkMacSystemFont,sans-serif!important;box-shadow:0 4px 14px #0008!important;cursor:pointer!important;';
      button.addEventListener('click',()=>{win.classList.remove('closed');applyGeometry();setStatus('Inspector reopened');});
      document.documentElement.appendChild(button);return button;
    }

    if (!document.body) document.addEventListener('DOMContentLoaded', () => { if (document.body) stateLocal.expanded.add(document.body); renderTree(); }, { once: true });
    setupConsoleCapture();
    setUpEvents();
    applyGeometry();
    buildToolbar();
    addReopenButton();
    updateTab(state.activeTab,false);
    renderTree();renderDetails();renderConsole();
    window.addEventListener('pageshow',e=>{if(e.persisted){if(!host.isConnected)(document.documentElement||document.body).append(host);setStatus('Restored from back-forward cache');}} ,{once:true});
    window.addEventListener('pagehide',()=>{safeSave();stopPicker();},{once:true});

    const api = {
      host, state, open:()=>{win.classList.remove('closed');applyGeometry();},
      destroy:()=>{stopPicker();clearTimeout(saveTimer);stateLocal.listeners.forEach(fn=>fn());for(const [name,fn] of Object.entries(originalConsole)){try{console[name]=fn}catch(_){}}try{host.remove();}catch(_){}},
    };
    window[INSTANCE_KEY]=api;
    setStatus('Ready · page data stays on this device');
  });
})();
