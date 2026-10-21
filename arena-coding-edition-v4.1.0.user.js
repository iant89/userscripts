/* ══════════════════════════════════════════════════════════════════
 * Arena.ai | Coding Edition
 * Version: 4.1.0 — Claude Code-style agent workflow inside Arena's native UI
 * ══════════════════════════════════════════════════════════════════
 *
 * A presentation and workflow-coordination layer on top of Arena.ai
 * Agent Mode. Arena remains the only AI engine: every prompt is
 * submitted through Arena's own composer, and the Arena message log
 * is the authoritative conversation.
 *
 * This script has NO terminal, filesystem, or GitHub API access.
 * Create PR / Merge PR only place instructions in Arena's composer
 * or open GitHub pages. Model output is parsed as data (JSON.parse
 * and text), never evaluated, and is rendered via textContent only.
 *
 * No external dependencies. No framework. No build step.
 * ══════════════════════════════════════════════════════════════════ */

// ==UserScript==
// @name         Arena.ai | Coding Edition
// @namespace    https://arena.ai/
// @version      4.1.0
// @description  Claude Code-style task workflow (plan, patch review, validation, handoff) inside Arena.ai's own interface.
// @match        *://*.arena.ai/*
// @match        *://*.canaryarena.ai/*
// @match        *://chat.lmsys.org/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    'use strict';

    if (window.__ccCodingEdition410) return;
    window.__ccCodingEdition410 = true;
    const VERSION = '4.1.0';
    console.info('[CC] Arena.ai Coding Edition v' + VERSION + ' starting...');

    // ══════════════════════════════════════════════════════════════════
    // CONFIG
    // ══════════════════════════════════════════════════════════════════

    const STORAGE_KEY = 'ccCodingEdition';
    const SESSION_KEY = 'ccCodingEditionSessions';

    const DEFAULTS = Object.freeze({
        keepMessages: 8,
        virtualize: true,
        flattenCode: true,

        thinkingMode: 'collapse',

        autoScroll: true,
        smoothScroll: true,
        scrollThreshold: 150,

        compactMode: false,
        fontSize: 0,
        contextWindow: 200000,

        composerSelector: '',
        hideComposer: false,

        showExport: true,
        eyeToggle: false,

        autoClickPageUpdated: true,
        autoClickContinue: true,

        textMode: false,

        // v4 additions
        themeMode: 'inverse',        // 'inverse' (spec default) | 'match' | 'dark' | 'light'
        agentMode: false,            // Agent toggle: wrap normal sends as ccce-agent/1 steps
        autonomous: false,
        maxAutoSteps: 6,
        maxRetries: 2,
        submitVerifyMs: 6000
    });

    // GM storage may hold an object (v4, Tampermonkey native) or a JSON
    // string (v3.4.3 saved JSON.stringify(cfg)). Accept both.
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function readStore(key, fallback) {
        if (!hasGM) {
            try {
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : fallback;
            } catch (_) { return fallback; }
        }
        try {
            let value = GM_getValue(key, fallback);
            if (typeof value === 'string') {
                try { value = JSON.parse(value); } catch (_) { return fallback; }
            }
            return value && typeof value === 'object' ? value : fallback;
        } catch (error) {
            console.warn('[CC] Could not read ' + key + ':', error);
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            if (hasGM) GM_setValue(key, value);
            else localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn('[CC] Could not persist ' + key + ':', error);
        }
    }

    function sanitizeConfig(raw) {
        const out = {};
        for (const key of Object.keys(DEFAULTS)) {
            if (!(key in raw)) continue;
            const def = DEFAULTS[key];
            const v = raw[key];
            if (typeof def === typeof v) out[key] = v;
        }
        if (!['collapse', 'expand', 'hide'].includes(out.thinkingMode)) delete out.thinkingMode;
        if (!['inverse', 'match', 'dark', 'light'].includes(out.themeMode)) delete out.themeMode;
        return out;
    }

    let cfg = Object.assign({}, DEFAULTS, sanitizeConfig(readStore(STORAGE_KEY, {})));
    const loadConfig = () => readStore(STORAGE_KEY, {});
    const saveConfig = () => writeStore(STORAGE_KEY, Object.assign({}, cfg));

    // Pull-request state tracking: 'none' | 'open' | 'merged'
    let prState = 'none';

    let mainObserver = null;          // single document observer (v3 had two)
    let activeLogObserver = null;
    let currentLog = null;
    let scrollCleanup = null;
    let scheduleTimer = null;
    let maintenanceTimer = null;
    let statsTimer = null;
    let watchdogTimer = null;
    let rafPending = false;
    let toastTimer = null;
    let snippetCounter = 0;

    let lastVirtualSignature = '';
    let warnedStructure = false;
    let lastMessageCount = -1;
    let lastCollapseCount = -1;
    let lastExpandCount = -1;

    let hiddenCount = 0;
    let composerCache = null;
    let composerHideWrapper = null;
    let jumpButton = null;
    let navExportButton = null;
    let lastClickedBanner = null;
    let lastContinueClick = 0;
    let initialized = false;
    let keyListenerBound = false;

    const q = (selector, root = document) => root.querySelector(selector);
    const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    // ══════════════════════════════════════════════════════════════════
    // THEME
    // ══════════════════════════════════════════════════════════════════

    // Spec §3 palettes. "Success/warning/error: muted" values are ours.
    const PALETTES = Object.freeze({
        dark: {
            '--ce-app': '#181818', '--ce-sidebar': '#141414', '--ce-surface': '#1B1B1B',
            '--ce-composer': '#242424', '--ce-hover': '#2A2A2A', '--ce-text': '#E8E8E8',
            '--ce-text-2': '#A0A0A0', '--ce-muted': '#777777', '--ce-border': '#333333',
            '--ce-accent': '#D97757', '--ce-success': '#7FA77F', '--ce-warning': '#C9A15A',
            '--ce-error': '#C96B6B', '--ce-code': '#141414',
            '--ce-add-bg': 'rgba(127,167,127,.14)', '--ce-del-bg': 'rgba(201,107,107,.14)'
        },
        light: {
            '--ce-app': '#F7F7F5', '--ce-sidebar': '#F0F0ED', '--ce-surface': '#FFFFFF',
            '--ce-composer': '#FFFFFF', '--ce-hover': '#EAEAE6', '--ce-text': '#262626',
            '--ce-text-2': '#666666', '--ce-muted': '#888888', '--ce-border': '#DEDEDA',
            '--ce-accent': '#C76545', '--ce-success': '#4F7F4F', '--ce-warning': '#9A7230',
            '--ce-error': '#A84B4B', '--ce-code': '#F4F4F1',
            '--ce-add-bg': 'rgba(79,127,79,.12)', '--ce-del-bg': 'rgba(168,75,75,.12)'
        }
    });

    // Existing theme detection (v3.4.3: html.dark / data-theme="dark"),
    // extended with a color-scheme fallback.
    function arenaIsDark() {
        const root = document.documentElement;
        if (!root) return false;
        if (root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark') return true;
        if (root.classList.contains('light') || root.getAttribute('data-theme') === 'light') return false;
        try { return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
        catch (_) { return false; }
    }

    // Spec §3 THEME HANDLING: Arena light -> userscript dark, Arena dark -> userscript light.
    function resolvedTheme() {
        if (cfg.themeMode === 'dark' || cfg.themeMode === 'light') return cfg.themeMode;
        const dark = arenaIsDark();
        if (cfg.themeMode === 'match') return dark ? 'dark' : 'light';
        return dark ? 'light' : 'dark';
    }

    function paletteCSS(name) {
        return Object.entries(PALETTES[name]).map(([k, v]) => k + ':' + v + ';').join('');
    }

    // Light-DOM styles: only for elements the script injects into Arena's
    // page (code buttons, jump, nav export) plus perf/thinking/compact rules.
    const PAGE_CSS = `
        :root[data-ccce-theme="dark"] { ${paletteCSS('dark')} }
        :root[data-ccce-theme="light"] { ${paletteCSS('light')} }
        [data-cc-wrap="1"] { position:relative !important; }
        [data-cc-wrap="1"] > .cc-code-buttons {
            position:absolute; top:6px; right:6px; display:flex; gap:4px; z-index:5;
        }
        [data-cc-wrap="1"] > .cc-code-buttons > button {
            min-width:28px; height:26px; padding:0 6px; border:1px solid var(--ce-border);
            border-radius:4px; background:var(--ce-surface); color:var(--ce-text-2);
            font:12px/1 system-ui,-apple-system,sans-serif; cursor:pointer; opacity:.55;
        }
        [data-cc-wrap="1"]:hover > .cc-code-buttons > button,
        [data-cc-wrap="1"] > .cc-code-buttons > button:focus-visible { opacity:1; }
        [data-cc-wrap="1"] > .cc-code-buttons > button:hover { background:var(--ce-hover); color:var(--ce-text); }
        #cc-jump, #cc-nav-export {
            box-sizing:border-box; border:1px solid var(--ce-border); background:var(--ce-composer);
            color:var(--ce-text); font:13px/1 system-ui,-apple-system,sans-serif; cursor:pointer;
            border-radius:6px;
        }
        #cc-jump {
            position:fixed; z-index:2147483640; right:max(16px, env(safe-area-inset-right));
            bottom:calc(150px + env(safe-area-inset-bottom)); width:36px; height:36px;
        }
        #cc-nav-export { height:30px; min-width:30px; padding:0 8px; margin:0 4px; }
        [data-cc-textmode="1"] [role="log"] pre { position:relative; overflow:hidden !important; }
        [data-cc-textmode="1"] [role="log"] pre::after {
            content:attr(data-cc-textdesc); position:absolute; inset:0; display:flex; align-items:center;
            padding:0 12px; font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--ce-text-2);
        }
    `;

    // ══════════════════════════════════════════════════════════════════
    // PERF CSS
    // ══════════════════════════════════════════════════════════════════

    const PERF_CSS = `
        [data-cc-hidden="1"] { display:none !important; }
        [data-cc-flat="1"] { contain:content; }
    `;

    function injectStyle(id, css) {
        let style = document.getElementById(id);
        if (!style) {
            style = document.createElement('style');
            style.id = id;
            (document.head || document.documentElement).appendChild(style);
        }
        if (style.textContent !== css) style.textContent = css;
        return style;
    }

    // Compact Mode (spec §10): ONLY Arena's composer. v3.4.3 also changed
    // [role="log"] padding; that leak is removed. The composer region is
    // marked with data-ccce-compact by markCompactComposer().
    function updateDynamicCSS() {
        const root = document.documentElement;
        if (!root) return;
        root.dataset.ccCompact = cfg.compactMode ? '1' : '';
        root.dataset.ccEye = cfg.eyeToggle ? '1' : '';
        root.dataset.ccTextmode = cfg.textMode ? '1' : '';
        root.dataset.ccceTheme = resolvedTheme();

        const css = `
            ${cfg.thinkingMode === 'hide' ? '[data-cc-thinking="1"]{display:none!important;}' : ''}
            ${cfg.compactMode ? `
                [data-ccce-compact="1"] { gap:4px !important; padding-top:4px !important; padding-bottom:4px !important; }
                [data-ccce-compact="1"] textarea,
                [data-ccce-compact="1"] [contenteditable="true"],
                [data-ccce-compact="1"] [role="textbox"] {
                    font-size:13px !important; line-height:1.35 !important;
                    padding-top:4px !important; padding-bottom:4px !important; min-height:0 !important;
                }
                [data-ccce-compact="1"] button:not(.ccce-ctl) { padding-top:2px !important; padding-bottom:2px !important; }
            ` : ''}
            ${Number(cfg.fontSize) > 0 ? `
                [role="log"], [role="log"] * {
                    font-size:${Math.min(24, Math.max(10, Number(cfg.fontSize)))}px !important;
                }
            ` : ''}
        `;
        injectStyle('cc-dynamic', css);
    }

    function markCompactComposer() {
        const marked = qa('[data-ccce-compact="1"]');
        if (!cfg.compactMode) {
            marked.forEach(el => delete el.dataset.ccceCompact);
            return;
        }
        const wrapper = composerWrapper(findComposer());
        if (!wrapper) return;
        marked.forEach(el => { if (el !== wrapper) delete el.dataset.ccceCompact; });
        wrapper.dataset.ccceCompact = '1';
    }

    // ══════════════════════════════════════════════════════════════════
    // APPLICATION SHELL (v4.1: no overlay — v3-style drawer + inline cards)
    // ══════════════════════════════════════════════════════════════════

    // Light-DOM styles, all colors from the inverse-theme palette vars.
    // Every rule is scoped to #cc-drawer, #cc-toggle, #cc-toast, .ccce-*.
    const UI_CSS = `
        #cc-drawer, #cc-drawer *, #cc-toggle, #cc-toast, .ccce-card, .ccce-card *, .ccce-ctl, .ccce-ctl * { box-sizing:border-box; }
        #cc-drawer {
            position:fixed; z-index:2147483645; inset:0 auto 0 0; width:340px; max-width:calc(100vw - 44px);
            height:100vh; height:100dvh; display:flex; flex-direction:column; color:var(--ce-text);
            background:var(--ce-sidebar); border-right:1px solid var(--ce-border);
            transform:translateX(-100%); transition:transform .2s ease; visibility:hidden;
            font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
            padding-top:env(safe-area-inset-top); padding-bottom:env(safe-area-inset-bottom); padding-left:env(safe-area-inset-left);
        }
        #cc-drawer.cc-open { transform:none; visibility:visible; box-shadow:0 8px 28px rgba(0,0,0,.28); }
        #cc-toggle {
            position:fixed; z-index:2147483646; top:48%; left:0; width:24px; height:44px; padding:0;
            border:1px solid var(--ce-border); border-left:0; border-radius:0 6px 6px 0;
            background:var(--ce-composer); color:var(--ce-text-2); font:16px/1 system-ui,sans-serif; cursor:pointer;
            transition:left .2s ease;
        }
        #cc-toggle.cc-open { left:min(340px, calc(100vw - 44px)); }
        #cc-drawer button, #cc-drawer input, #cc-drawer select, #cc-drawer textarea { font:inherit; color:inherit; }
        #cc-drawer :focus-visible, #cc-toggle:focus-visible, .ccce-card :focus-visible, .ccce-ctl:focus-visible { outline:2px solid var(--ce-accent); outline-offset:1px; }
        .cc-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--ce-border); }
        .cc-brand { font-weight:600; flex:1; } .cc-brand small { display:block; font-weight:400; color:var(--ce-muted); font-size:11px; }
        .cc-x { width:30px; height:30px; border:0; border-radius:6px; background:transparent; cursor:pointer; color:var(--ce-text-2); }
        .cc-x:hover, .cc-x[aria-pressed="true"] { background:var(--ce-hover); color:var(--ce-text); }
        .cc-tabs { display:flex; gap:2px; padding:0 8px; border-bottom:1px solid var(--ce-border); }
        .cc-tab { flex:1; height:32px; border:0; border-bottom:2px solid transparent; background:transparent; cursor:pointer;
                  color:var(--ce-text-2); font-size:12px; }
        .cc-tab[aria-selected="true"] { color:var(--ce-text); border-bottom-color:var(--ce-accent); }
        .cc-content { flex:1; overflow:auto; padding:8px 12px 16px; }
        .cc-h { margin:14px 0 6px; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--ce-muted); }
        .cc-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin:6px 0; }
        .cc-kv { display:flex; gap:8px; padding:3px 0; font-size:12px; color:var(--ce-text-2); }
        .cc-kv b { font-weight:400; color:var(--ce-muted); min-width:70px; } .cc-kv span { overflow-wrap:anywhere; }
        .cc-missing { color:var(--ce-muted); font-style:italic; font-size:12px; }
        .cc-set { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid var(--ce-border); }
        .cc-set small { display:block; color:var(--ce-muted); font-size:11px; }
        .cc-set input[type="number"], .cc-set input[type="text"], .cc-set select { width:130px; }
        #cc-drawer input[type="text"], #cc-drawer input[type="number"], #cc-drawer select, #cc-drawer textarea {
            height:28px; padding:0 8px; border:1px solid var(--ce-border); border-radius:5px; background:var(--ce-surface); }
        #cc-drawer textarea { height:auto; min-height:56px; padding:6px 8px; resize:vertical; font:12px/1.4 ui-monospace,Menlo,monospace; }
        .cc-field { display:flex; flex-direction:column; gap:4px; margin:4px 0; }
        .cc-field input, .cc-field select, .cc-field textarea { width:100%; }
        .cc-switch { width:34px; height:20px; border-radius:10px; border:1px solid var(--ce-border); background:var(--ce-hover);
                     position:relative; padding:0; flex:none; cursor:pointer; }
        .cc-switch::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:var(--ce-text-2); transition:left .15s; }
        .cc-switch[aria-checked="true"] { background:var(--ce-accent); border-color:var(--ce-accent); }
        .cc-switch[aria-checked="true"]::after { left:16px; background:#fff; }
        .cc-item { display:flex; align-items:center; gap:6px; width:100%; padding:5px 6px; border:0; border-radius:5px;
                   background:transparent; text-align:left; cursor:pointer; color:var(--ce-text-2); font-size:12px; }
        .cc-item:hover, .cc-item.active { background:var(--ce-hover); color:var(--ce-text); }
        .cc-item .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cc-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--ce-border); border:1px solid var(--ce-border); border-radius:6px; overflow:hidden; }
        .cc-grid > div { background:var(--ce-surface); padding:6px 8px; } .cc-grid b { display:block; font-size:15px; } .cc-grid span { font-size:11px; color:var(--ce-muted); }
        .cc-bar { height:4px; background:var(--ce-hover); border-radius:2px; overflow:hidden; margin:6px 0; } .cc-bar > i { display:block; height:100%; }
        #cc-toast { position:fixed; z-index:2147483647; left:50%; bottom:calc(96px + env(safe-area-inset-bottom)); transform:translateX(-50%);
                    max-width:min(520px,90vw); padding:8px 12px; border-radius:6px; border:1px solid var(--ce-border);
                    background:var(--ce-composer); color:var(--ce-text); font:12px/1.4 system-ui,-apple-system,sans-serif;
                    opacity:0; pointer-events:none; transition:opacity .15s; }
        #cc-toast.cc-visible { opacity:1; } #cc-toast.cc-error { border-color:var(--ce-error); }

        /* Agent toggle + state pill beside Arena's send button */
        .ccce-ctl { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 8px; margin:0 4px;
                    border:1px solid var(--ce-border); border-radius:6px; background:var(--ce-composer); color:var(--ce-text-2);
                    font:12px/1 system-ui,-apple-system,sans-serif; cursor:pointer; white-space:nowrap; vertical-align:middle; }
        .ccce-ctl[aria-pressed="true"] { color:var(--ce-text); border-color:var(--ce-accent); }
        .ccce-ctl.ccce-floating { position:fixed; z-index:2147483640; right:max(12px,env(safe-area-inset-right)); bottom:calc(12px + env(safe-area-inset-bottom)); }
        .ccce-dot { width:7px; height:7px; border-radius:50%; background:var(--ce-muted); flex:none; }
        .ccce-dot.on { background:var(--ce-accent); } .ccce-dot.ok { background:var(--ce-success); }
        .ccce-dot.warn { background:var(--ce-warning); } .ccce-dot.err { background:var(--ce-error); }

        /* Inline cards inside Arena messages */
        .ccce-card { margin:10px 0; border:1px solid var(--ce-border); border-radius:6px; background:var(--ce-surface); color:var(--ce-text);
                     font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; overflow:hidden; }
        .ccce-card-h { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 10px; border-bottom:1px solid var(--ce-border);
                       background:var(--ce-app); font-size:12px; color:var(--ce-text-2); }
        .ccce-card-h b { color:var(--ce-text); font-weight:600; }
        .ccce-card-b { padding:8px 10px; }
        .ccce-card ul, .ccce-card ol { margin:4px 0; padding-left:20px; }
        .ccce-card label { display:flex; gap:6px; align-items:flex-start; padding:2px 0; }
        .ccce-tag { font-size:11px; padding:0 6px; border:1px solid var(--ce-border); border-radius:4px; color:var(--ce-text-2); }
        .ccce-tag.warn { color:var(--ce-warning); border-color:var(--ce-warning); } .ccce-tag.err { color:var(--ce-error); border-color:var(--ce-error); }
        .ccce-tag.ok { color:var(--ce-success); border-color:var(--ce-success); }
        .ccce-btn, #cc-drawer .ccce-btn { height:28px; padding:0 10px; border:1px solid var(--ce-border); border-radius:6px; background:var(--ce-surface);
                     color:var(--ce-text); font:12px/1 system-ui,-apple-system,sans-serif; cursor:pointer; }
        .ccce-btn:hover { background:var(--ce-hover); } .ccce-btn.primary { background:var(--ce-accent); border-color:var(--ce-accent); color:#fff; }
        .ccce-btn:disabled { opacity:.45; cursor:default; }
        .ccce-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:8px 0 2px; }
        .ccce-sub { font-size:12px; color:var(--ce-text-2); } .ccce-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
        .ccce-add { color:var(--ce-success); } .ccce-del { color:var(--ce-error); }
        .ccce-patch { margin:8px 0; border:1px solid var(--ce-border); border-radius:5px; }
        .ccce-patch-h { display:flex; gap:6px; flex-wrap:wrap; align-items:center; padding:5px 8px; border-bottom:1px solid var(--ce-border); font-size:12px; }
        .ccce-diff { margin:0; max-height:420px; overflow:auto; background:var(--ce-code); font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-overflow-scrolling:touch; }
        .ccce-diff div { padding:0 8px; white-space:pre; min-height:1.45em; }
        .ccce-diff .a { background:var(--ce-add-bg); } .ccce-diff .d { background:var(--ce-del-bg); } .ccce-diff .h { color:var(--ce-muted); }
        .ccce-note { margin:6px 0; padding:6px 8px; border-left:2px solid var(--ce-border); font-size:12px; color:var(--ce-text-2); }
        .ccce-note.warn { border-color:var(--ce-warning); } .ccce-note.err { border-color:var(--ce-error); }
        [data-ccce-raw="1"] > pre, [data-ccce-raw="1"] > .cc-code-buttons, pre[data-ccce-raw="1"] { display:none !important; }
        .ccce-rawtoggle { font-size:11px; color:var(--ce-muted); background:none; border:0; padding:2px 0; cursor:pointer; text-decoration:underline; }
        .ccce-reqline { font:12px/1.4 ui-monospace,Menlo,monospace; color:var(--ce-text-2); padding:4px 0; }
        @media (max-width:760px) {
            #cc-drawer { width:min(340px,88vw); }
            #cc-toggle.cc-open { left:min(340px,88vw); }
            #cc-drawer input[type="text"], #cc-drawer input[type="number"], #cc-drawer select, #cc-drawer textarea { font-size:16px; min-height:36px; }
            .ccce-btn, .cc-tab, .cc-item, .ccce-ctl { min-height:36px; }
        }
    `;

    // UI handles (light DOM).
    const ui = { drawer: null, toggle: null, toast: null, open: false, tab: 'agent', agentBtn: null };

    // ══════════════════════════════════════════════════════════════════
    // TOAST
    // ══════════════════════════════════════════════════════════════════

    function toast(message, error = false, duration = 3000) {
        let el = ui.toast && ui.toast.isConnected ? ui.toast : document.getElementById('cc-toast');
        if (!el && document.documentElement) {
            el = document.createElement('div');
            el.id = 'cc-toast';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            (document.body || document.documentElement).appendChild(el);
        }
        ui.toast = el;
        if (!el) return;
        el.textContent = String(message);
        el.classList.toggle('cc-error', !!error);
        el.classList.add('cc-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('cc-visible'), duration);
    }

    // ══════════════════════════════════════════════════════════════════
    // DOM HELPERS
    // ══════════════════════════════════════════════════════════════════

    // Safe element builder: text is ALWAYS assigned via text nodes.
    function h(tag, attrs, ...children) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const [key, value] of Object.entries(attrs)) {
                if (value === null || value === undefined || value === false) continue;
                if (key === 'class') node.className = value;
                else if (key === 'text') node.textContent = String(value);
                else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
                else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
                else if (key === 'href') { const safe = safeUrl(value); if (safe) node.setAttribute('href', safe); }
                else node.setAttribute(key, value === true ? '' : String(value));
            }
        }
        appendChildren(node, children);
        return node;
    }

    function appendChildren(node, children) {
        for (const child of children.flat(Infinity)) {
            if (child === null || child === undefined || child === false) continue;
            node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
        }
    }

    // Only http(s) links; everything else (javascript:, data:) is dropped.
    function safeUrl(value) {
        try {
            const url = new URL(String(value), location.href);
            return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
        } catch (_) { return ''; }
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        logo: 'M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4',
        plus: 'M12 5v14M5 12h14',
        side: 'M4 5h16v14H4zM9 5v14',
        menu: 'M5 12h.01M12 12h.01M19 12h.01',
        send: 'M5 12h14M13 6l6 6-6 6',
        close: 'M6 6l12 12M18 6 6 18',
        branch: 'M6 4v12M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8c0 6-12 4-12 8',
        repo: 'M5 4h11l3 3v13H5zM9 4v6l2-1 2 1V4',
        file: 'M6 3h8l4 4v14H6zM14 3v4h4',
        task: 'M4 6h16M4 12h10M4 18h7',
        down: 'M12 5v14M6 13l6 6 6-6',
        pause: 'M8 5v14M16 5v14',
        play: 'M7 5l12 7-12 7z',
        stop: 'M6 6h12v12H6z',
        retry: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
        eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
        bug: 'M8 8h8v9a4 4 0 0 1-8 0zM12 8V5M4 13h4M16 13h4M5 7l3 2M19 7l-3 2'
    };

    function icon(name) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[name] || ICONS.task);
        svg.appendChild(path);
        return svg;
    }

    function findLog() {
        const logs = qa('[role="log"]');
        if (!logs.length) return null;
        return logs.reduce((best, el) => el.children.length > best.children.length ? el : best);
    }

    function isVisible(el) {
        if (!(el instanceof Element) || !el.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            (style.opacity !== '' && Number(style.opacity) === 0)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function validMessage(el) {
        if (!(el instanceof Element)) return false;
        const text = (el.textContent || '').trim();
        return text.length > 40 ||
            !!el.querySelector('pre,.prose,[class*="prose"],[class*="markdown"],button[data-state]');
    }

    function findMessageList(log) {
        if (!log) return { parent: null, messages: [] };
        let node = log;
        for (let depth = 0; depth <= 6; depth++) {
            const children = Array.from(node.children);
            const valid = children.filter(validMessage);
            if (valid.length >= 2) return { parent: node, messages: valid };
            if (children.length !== 1) {
                if (valid.length === 1) return { parent: node, messages: valid };
                break;
            }
            node = children[0];
        }
        const children = Array.from(node.children);
        const valid = children.filter(validMessage);
        if (valid.length) return { parent: node, messages: valid };
        return { parent: log, messages: Array.from(log.children).filter(validMessage) };
    }

    function getMessages(log = currentLog) { return findMessageList(log).messages; }

    function isReversed(messageParent) {
        if (!messageParent) return false;
        return getComputedStyle(messageParent).flexDirection === 'column-reverse';
    }

    function orderedMessages(log = currentLog) {
        const found = findMessageList(log);
        const messages = found.messages.slice();
        const reversed = isReversed(found.parent);
        return {
            parent: found.parent,
            messages,
            reversed,
            newestFirst: reversed ? messages : messages.slice().reverse(),
            chronological: reversed ? messages.slice().reverse() : messages
        };
    }

    function scrollElement(log = currentLog) {
        if (!log) return null;
        let node = log;
        for (let depth = 0; depth < 5 && node; depth++) {
            if (node.scrollHeight > node.clientHeight + 5) return node;
            node = node.parentElement;
        }
        return log;
    }

    function isNearBottom(container, threshold = cfg.scrollThreshold) {
        if (!container) return true;
        const remaining = container.scrollHeight - container.clientHeight - container.scrollTop;
        return remaining <= Math.max(0, Number(threshold) || 150);
    }

    function scrollToBottom(container = scrollElement()) {
        if (!container) return;
        if (cfg.smoothScroll && typeof container.scrollTo === 'function') {
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        } else {
            container.scrollTop = container.scrollHeight;
        }
    }

    function textContent(el) { return (el?.textContent || '').trim(); }
    function formatNumber(n) { return Number(n || 0).toLocaleString(); }

    function safePageTitle() {
        return (document.title || 'arena-chat').replace(/\s*[|–—-]\s*Arena\.ai.*$/i, '').trim() || 'arena-chat';
    }

    function sanitizeFilename(name) {
        return String(name)
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^\.+|\.+$/g, '')
            .slice(0, 100) || 'arena-chat';
    }

    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function hashText(text) {
        let h1 = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) { h1 ^= text.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
        return (h1 >>> 0).toString(36);
    }

    function uid(prefix) {
        return prefix + '-' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
    }

    function isOwnUI(el) {
        return !!(el && el.closest && el.closest('#cc-drawer,#cc-toggle,#cc-toast,#cc-jump,#cc-nav-export,.cc-code-buttons,.ccce-card,.ccce-ctl,.ccce-reqline,.ccce-rawtoggle'));
    }

    // Message role heuristic (Arena DOM is not documented): explicit
    // attributes first, then our request marker, then alternation.
    function messageRole(el, index) {
        const attr = (el.getAttribute('data-role') || el.getAttribute('data-message-author-role') ||
            q('[data-role],[data-message-author-role]', el)?.getAttribute('data-role') ||
            q('[data-message-author-role]', el)?.getAttribute('data-message-author-role') || '').toLowerCase();
        if (/user|human/.test(attr)) return 'user';
        if (/assistant|model|bot/.test(attr)) return 'assistant';
        const cls = String(el.className || '');
        if (/\buser\b|human/i.test(cls)) return 'user';
        if (/assistant|\bbot\b|model/i.test(cls)) return 'assistant';
        if (REQUEST_MARKER.test(el.textContent || '')) return 'user';
        return index % 2 === 0 ? 'user' : 'assistant';
    }

    // ══════════════════════════════════════════════════════════════════
    // COMPOSER FINDER
    // ══════════════════════════════════════════════════════════════════

    // Single composer discovery implementation (spec §12). Returns scored
    // candidates so the adapter can detect ambiguity.
    function scoreComposers() {
        if (cfg.composerSelector) {
            try {
                const selected = q(cfg.composerSelector);
                if (selected && isVisible(selected) && !isOwnUI(selected)) return [{ el: selected, score: 1000 }];
            } catch (_) { /* invalid custom selector: automatic detection */ }
        }
        const candidates = qa(
            'textarea,input[type="text"],[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]'
        );
        const out = [];
        const vh = window.innerHeight || 800;
        for (const el of candidates) {
            if (!isVisible(el) || isOwnUI(el)) continue;
            if (el.matches('input[type="hidden"],input[aria-hidden="true"],[readonly],[disabled]')) continue;
            if (el.getAttribute('role') === 'log') continue;
            // Nested editables: score only the outermost editable.
            if (el.parentElement && el.parentElement.closest('[contenteditable="true"]')) continue;
            const r = el.getBoundingClientRect();
            let score = 0;
            if (r.bottom >= vh * 0.65) score += 25; else if (r.bottom >= vh * 0.4) score += 12;
            if (r.width > 200) score += 12;
            if (r.width > 400) score += 6;
            if (el.tagName === 'TEXTAREA') score += 10;
            if (el.isContentEditable) score += 8;
            if (el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox') score += 8;
            if (!el.closest('header,nav,aside,[role="navigation"]')) score += 12;
            const cls = String(el.getAttribute('class') || '');
            if (/composer|prompt|chat|message|input/i.test(cls)) score += 10;
            const label = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '');
            if (/message|prompt|ask|send|chat/i.test(label)) score += 8;
            if (/search/i.test(label)) score -= 20;
            if (r.bottom > vh * 0.8) score += 15;
            out.push({ el, score });
        }
        return out.sort((a, b) => b.score - a.score);
    }

    function findComposer() {
        const best = scoreComposers()[0];
        composerCache = best ? best.el : null;
        return composerCache;
    }

    function composerWrapper(composer) {
        if (!composer) return null;
        let wrapper = composer;
        for (let depth = 0; depth < 8 && wrapper.parentElement; depth++) {
            const parent = wrapper.parentElement;
            if (parent === document.body || parent === document.documentElement) break;
            const r = parent.getBoundingClientRect();
            if (r.height > (window.innerHeight || 800) * 0.5 || r.width < 200) break;
            wrapper = parent;
        }
        return wrapper === document.body || wrapper === document.documentElement ? null : wrapper;
    }

    // ══════════════════════════════════════════════════════════════════
    // REPOSITORY CONTEXT
    // ══════════════════════════════════════════════════════════════════

    const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
    const BRANCH_RE = /^(?!\/|.*\.\.|.*\/\/|.*@\{|.*\.lock$|.*[\\~^:?*\[\s])[\x21-\x7e]{1,200}$/;

    function parseRepo(input) {
        const raw = String(input || '').trim();
        if (!raw) return null;
        let path = raw;
        const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
        if (m) path = m[1];
        const parts = path.replace(/\.git$/i, '').split(/[/?#]/).filter(Boolean);
        if (parts.length < 2 || !REPO_PART.test(parts[0]) || !REPO_PART.test(parts[1])) return null;
        let branch = '';
        if (m && parts[2] === 'tree' && parts[3]) branch = decodeURIComponent(parts.slice(3).join('/'));
        return { owner: parts[0], repo: parts[1].replace(/\.git$/i, ''), full: parts[0] + '/' + parts[1], branch };
    }

    function validBranch(name) { return !name || BRANCH_RE.test(String(name)); }

    const CONTEXT_SOURCES = Object.freeze({
        user: 'User-provided text',
        paste: 'Pasted file contents',
        arena: 'Arena conversation',
        page: 'Authorized page context',
        validation: 'User-confirmed external validation'
    });

    function addContext(task, source, label, text) {
        if (!task || !CONTEXT_SOURCES[source]) return null;
        const body = String(text || '').slice(0, 60000);
        if (!body.trim()) return null;
        const item = { id: uid('C'), source, label: String(label || CONTEXT_SOURCES[source]).slice(0, 120), text: body, at: Date.now() };
        task.context.push(item);
        if (task.context.length > 40) task.context.shift();
        logEvent(task, 'context', 'Added context: ' + item.label + ' (' + CONTEXT_SOURCES[source] + ')');
        saveSessions();
        return item;
    }

    // ══════════════════════════════════════════════════════════════════
    // TASK MANAGER
    // ══════════════════════════════════════════════════════════════════

    function newTask(description) {
        const prev = activeTask();
        const task = {
            id: uid('T'),
            title: String(description || 'Untitled task').split('\n')[0].slice(0, 80) || 'Untitled task',
            description: String(description || '').slice(0, 8000),
            repo: prev ? prev.repo : '',
            branch: prev ? prev.branch : '',
            state: 'IDLE',
            resumeState: null,
            errorFrom: null,
            step: null,              // current step id
            stepCount: 0,
            autoSteps: 0,
            retries: 0,
            context: [],
            files: [],               // { path, action, reason, status, stepId }
            patches: [],
            tests: [],
            validation: [],          // evidence: { check, result, evidence, source }
            handoff: null,
            responses: [],           // raw assistant responses (preserved)
            events: [],
            created: Date.now(),
            updated: Date.now()
        };
        session.tasks.unshift(task);
        if (session.tasks.length > 40) session.tasks.length = 40;
        session.activeId = task.id;
        logEvent(task, 'state', 'Task created (IDLE).');
        saveSessions();
        return task;
    }

    function activeTask() {
        return session.tasks.find(t => t.id === session.activeId) || null;
    }

    function selectTask(id) {
        if (!session.tasks.some(t => t.id === id)) return;
        session.activeId = id;
        saveSessions();
        renderUI();
    }

    function logEvent(task, kind, text) {
        if (!task) return;
        task.events.push({ at: Date.now(), kind, text: String(text).slice(0, 500), step: task.step });
        if (task.events.length > 300) task.events.splice(0, task.events.length - 300);
        task.updated = Date.now();
    }

    // ══════════════════════════════════════════════════════════════════
    // WORKFLOW ENGINE
    // ══════════════════════════════════════════════════════════════════

    const STATES = Object.freeze([
        'IDLE', 'PREPARING', 'PLANNING', 'PLAN_REVIEW', 'CHANGE_PROPOSAL', 'PATCH_REVIEW',
        'VALIDATION_REVIEW', 'HANDOFF', 'COMPLETED', 'PAUSED', 'CANCELLED', 'ERROR'
    ]);

    const ACTIVE = ['PREPARING', 'PLANNING', 'PLAN_REVIEW', 'CHANGE_PROPOSAL', 'PATCH_REVIEW', 'VALIDATION_REVIEW', 'HANDOFF'];

    // Explicit legal transitions. PAUSED may only resume to the state it
    // paused from; ERROR may only retry the state it failed in.
    const TRANSITIONS = Object.freeze({
        IDLE: ['PREPARING', 'PLANNING', 'CHANGE_PROPOSAL', 'CANCELLED'],
        PREPARING: ['PLANNING', 'PLAN_REVIEW', 'CHANGE_PROPOSAL', 'PATCH_REVIEW', 'VALIDATION_REVIEW', 'HANDOFF', 'PAUSED', 'CANCELLED', 'ERROR'],
        PLANNING: ['PLAN_REVIEW', 'PREPARING', 'PAUSED', 'CANCELLED', 'ERROR'],
        PLAN_REVIEW: ['PLANNING', 'PREPARING', 'CHANGE_PROPOSAL', 'PAUSED', 'CANCELLED', 'ERROR'],
        CHANGE_PROPOSAL: ['PATCH_REVIEW', 'PREPARING', 'PAUSED', 'CANCELLED', 'ERROR'],
        PATCH_REVIEW: ['CHANGE_PROPOSAL', 'VALIDATION_REVIEW', 'HANDOFF', 'PREPARING', 'PAUSED', 'CANCELLED', 'ERROR'],
        VALIDATION_REVIEW: ['CHANGE_PROPOSAL', 'PATCH_REVIEW', 'HANDOFF', 'PREPARING', 'PAUSED', 'CANCELLED', 'ERROR'],
        HANDOFF: ['COMPLETED', 'CHANGE_PROPOSAL', 'VALIDATION_REVIEW', 'PREPARING', 'PAUSED', 'CANCELLED', 'ERROR'],
        PAUSED: ['CANCELLED'],
        ERROR: ['PAUSED', 'CANCELLED'],
        COMPLETED: [],
        CANCELLED: []
    });

    // Operation -> state while the request is in flight, state after a
    // valid response. Completion is never inferred (only HANDOFF -> COMPLETED by the user).
    const OP_STATES = Object.freeze({
        analyze_context: ['PREPARING', 'PREPARING'],
        request_file_context: ['PREPARING', 'PREPARING'],
        create_plan: ['PLANNING', 'PLAN_REVIEW'],
        propose_patch: ['CHANGE_PROPOSAL', 'PATCH_REVIEW'],
        review_patch: ['PATCH_REVIEW', 'PATCH_REVIEW'],
        suggest_tests: ['VALIDATION_REVIEW', 'VALIDATION_REVIEW'],
        report_validation: ['VALIDATION_REVIEW', 'VALIDATION_REVIEW'],
        prepare_handoff: ['HANDOFF', 'HANDOFF']
    });

    const ACTIVITY_LABEL = Object.freeze({
        PREPARING: 'Preparing context',
        PLANNING: 'Planning changes',
        PLAN_REVIEW: 'Reviewing plan',
        CHANGE_PROPOSAL: 'Analyzing request / proposing changes',
        PATCH_REVIEW: 'Reviewing proposed changes',
        VALIDATION_REVIEW: 'Preparing validation checklist',
        HANDOFF: 'Preparing GitHub handoff'
    });

    function canTransition(from, to) {
        if (from === to) return ACTIVE.includes(from);
        if (from === 'PAUSED') return to === 'CANCELLED';
        return (TRANSITIONS[from] || []).includes(to);
    }

    function transition(task, to, reason) {
        if (!task || !STATES.includes(to)) return false;
        const from = task.state;
        if (!canTransition(from, to)) {
            logEvent(task, 'error', 'Rejected illegal transition ' + from + ' → ' + to + (reason ? ' (' + reason + ')' : ''));
            console.warn('[CC] Illegal transition', from, '→', to);
            return false;
        }
        if (to === 'PAUSED') task.resumeState = from;
        if (to === 'ERROR') task.errorFrom = from;
        task.state = to;
        logEvent(task, 'state', from + ' → ' + to + (reason ? ': ' + reason : ''));
        saveSessions();
        return true;
    }

    // Move to a working state, routing through PREPARING when the direct
    // edge is not legal (e.g. IDLE -> VALIDATION_REVIEW).
    function enterWorkingState(task, target) {
        if (task.state === target || canTransition(task.state, target)) {
            return task.state === target || transition(task, target, 'request sent');
        }
        if (canTransition(task.state, 'PREPARING') && canTransition('PREPARING', target)) {
            return transition(task, 'PREPARING', 'routing') && transition(task, target, 'request sent');
        }
        logEvent(task, 'error', 'Cannot start ' + target + ' from ' + task.state + '.');
        return false;
    }

    function pauseTask(task) {
        if (!task || !(ACTIVE.includes(task.state) || task.state === 'ERROR')) return false;
        pending = pending && pending.taskId === task.id ? null : pending;
        const ok = transition(task, 'PAUSED', 'by user');
        renderUI();
        return ok;
    }

    function resumeTask(task) {
        if (!task || task.state !== 'PAUSED' || !task.resumeState) return false;
        const to = task.resumeState === 'ERROR' ? (task.errorFrom || 'PREPARING') : task.resumeState;
        task.state = to;
        task.resumeState = null;
        logEvent(task, 'state', 'PAUSED → ' + to + ': resumed by user');
        saveSessions();
        renderUI();
        return true;
    }

    function cancelTask(task) {
        if (!task || task.state === 'COMPLETED' || task.state === 'CANCELLED') return false;
        if (pending && pending.taskId === task.id) pending = null;
        transition(task, 'CANCELLED', 'by user');
        renderUI();
        return true;
    }

    function retryTask(task) {
        if (!task || task.state !== 'ERROR' || !task.lastRequest) return false;
        if (task.retries >= Math.max(0, cfg.maxRetries)) {
            toast('Retry limit reached (' + cfg.maxRetries + '). Edit the prompt and send manually.', true);
            return false;
        }
        task.retries++;
        task.state = task.errorFrom || 'PREPARING';
        logEvent(task, 'state', 'ERROR → ' + task.state + ': retry ' + task.retries + '/' + cfg.maxRetries);
        sendStep(task, task.lastRequest.op, task.lastRequest.userText, { retry: true });
        return true;
    }

    function completeTask(task) {
        if (!task || task.state !== 'HANDOFF') {
            toast('A task can only be completed from HANDOFF.', true);
            return false;
        }
        const ok = transition(task, 'COMPLETED', 'confirmed by user');
        renderUI();
        return ok;
    }

    // ══════════════════════════════════════════════════════════════════
    // PROMPT BUILDER
    // ══════════════════════════════════════════════════════════════════

    const PROTOCOL = 'ccce-agent/1';
    const OPERATIONS = Object.freeze(Object.keys(OP_STATES));
    const REQUEST_MARKER = /\[ccce-agent\/1 request task=([A-Za-z0-9-]+) step=([A-Za-z0-9-]+)\]/;

    const OP_LABEL = Object.freeze({
        analyze_context: 'Analyze', request_file_context: 'Request files', create_plan: 'Plan',
        propose_patch: 'Patch', review_patch: 'Review', suggest_tests: 'Tests',
        report_validation: 'Validation', prepare_handoff: 'Handoff'
    });

    const SAFETY = [
        'You are being coordinated by a UI-only userscript. It has NO terminal, filesystem, or GitHub API access.',
        'Do not claim that commands were run, files were read, tests passed, or commits/PRs/merges happened unless that evidence is in this conversation.',
        'Paths must be repository-relative (no absolute paths, no "..").',
        'Patches are proposals for human review; nothing is applied automatically.'
    ];

    function buildPrompt(task, op, stepId, userText) {
        const repo = parseRepo(task.repo);
        const lines = [];
        lines.push('[' + PROTOCOL + ' request task=' + task.id + ' step=' + stepId + ']');
        lines.push('');
        if (userText) { lines.push(userText.trim()); lines.push(''); }
        const request = {
            protocol: PROTOCOL,
            task_id: task.id,
            step_id: stepId,
            operation: op,
            task: task.description.slice(0, 2000),
            repository: {
                name: repo ? repo.full : null,
                branch: task.branch || null,
                url: repo ? 'https://github.com/' + repo.full : null,
                contents_fetched_by_userscript: false
            },
            context: task.context.slice(-12).map(c => ({
                source: c.source, label: c.label, text: c.text.slice(0, 12000)
            })),
            allowed_capabilities: ['analyze provided text', 'propose unified diffs', 'propose full-file replacements',
                'suggest tests and commands for the human to run', 'draft commit/PR text'],
            expected_output: 'Reply with normal Markdown, then ONE fenced code block with language "' + PROTOCOL +
                '" containing a single JSON object with keys: protocol, task_id, step_id, operation, status ' +
                '("ok"|"needs_input"|"blocked"|"error"), summary, referenced_files [{path,action,reason}], ' +
                'proposed_patches [{path,action("modify"|"create"|"delete"|"replace"),diff?,content?,reason}], ' +
                'suggested_tests [{name,command?,reason}], risks [string], plan? [string], ' +
                'validation? [{check,result("pass"|"fail"|"unknown"),evidence}], ' +
                'handoff? {branch,commit_message,pr_title,pr_body}, ' +
                'next_action {operation (one of: ' + OPERATIONS.join(', ') + ' or "none"),reason}.',
            safety_constraints: SAFETY
        };
        lines.push('```' + PROTOCOL);
        lines.push(JSON.stringify(request, null, 2));
        lines.push('```');
        return lines.join('\n');
    }

    // ══════════════════════════════════════════════════════════════════
    // ARENA ADAPTER
    // ══════════════════════════════════════════════════════════════════

    let pending = null;      // in-flight request { taskId, stepId, op, hash, sentAt, baseline }
    let submitting = false;
    const recentSubmits = []; // { hash, at } duplicate guard

    function setNativeValue(el, value) {
        if (el.isContentEditable) {
            el.focus();
            el.replaceChildren(document.createTextNode(value));
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
            return;
        }
        const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function composerValue(el) {
        if (!el) return '';
        return el.isContentEditable ? (el.textContent || '') : (el.value || '');
    }

    function findSendButton(composer) {
        let scope = composer.parentElement;
        for (let depth = 0; depth < 7 && scope; depth++, scope = scope.parentElement) {
            const buttons = qa('button,[role="button"]', scope).filter(b => !isOwnUI(b) && isVisible(b));
            const match = buttons.filter(b => {
                const label = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'),
                    textContent(b)].join(' ');
                return b.getAttribute('type') === 'submit' || /\bsend\b|submit/i.test(label);
            }).filter(b => !/stop|cancel/i.test(b.getAttribute('aria-label') || ''));
            if (match.length) return match[match.length - 1];
            if (scope === document.body) break;
        }
        return null;
    }

    function isGenerating() {
        return qa('button,[role="button"]').some(b => !isOwnUI(b) && isVisible(b) &&
            /stop (generating|response)|^stop$/i.test((b.getAttribute('aria-label') || textContent(b) || '').trim()));
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Steps 1-7 of spec §2 BOTTOM COMPOSER. Resolves { ok, reason }.
    async function submitToArena(text, opts = {}) {
        const value = String(text || '');
        if (!value.trim()) return { ok: false, reason: 'Prompt is empty.' };
        if (value.length > 100000) return { ok: false, reason: 'Prompt exceeds 100,000 characters.' };
        if (submitting) return { ok: false, reason: 'A submission is already in progress.' };

        const hash = hashText(value);
        const now = Date.now();
        while (recentSubmits.length && now - recentSubmits[0].at > 30000) recentSubmits.shift();
        if (recentSubmits.some(r => r.hash === hash)) return { ok: false, reason: 'Duplicate prompt submitted within 30 s; blocked.' };

        const scored = scoreComposers();
        if (!scored.length) return { ok: false, reason: 'Arena composer not found.' };
        if (scored.length > 1 && scored[0].score < 1000 && scored[0].score - scored[1].score < 3) {
            return { ok: false, ambiguous: true, reason: 'Arena composer is ambiguous (' + scored.length + ' candidates). Set a composer selector in Settings.' };
        }
        const composer = scored[0].el;
        if (composer.closest('[data-cc-composer-hide="1"]') || composer.dataset.ccEyeHidden === '1') {
            // Hidden composers still accept programmatic input; note it for diagnostics.
            console.info('[CC] Submitting through a hidden Arena composer.');
        }
        if (isGenerating()) return { ok: false, reason: 'Arena is still generating a response.' };
        // Never overwrite a draft the user typed, unless it is the draft being wrapped.
        const draft = composerValue(composer).trim();
        if (draft && !opts.replaceDraft) return { ok: false, composer, reason: 'Arena composer has unsent text. Send or clear it first.' };

        submitting = true;
        try {
            const log = currentLog || findLog();
            const before = getMessages(log).length;
            setNativeValue(composer, value);
            await sleep(60);
            if (composerValue(composer).trim() !== value.trim()) {
                return { ok: false, reason: 'Arena composer did not accept the text.' };
            }

            let button = null;
            for (let i = 0; i < 10 && !button; i++) {
                const b = findSendButton(composer);
                if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') button = b;
                else await sleep(100);
            }
            if (button) button.click();
            else {
                composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }
            recentSubmits.push({ hash, at: Date.now() });

            const deadline = Date.now() + Math.max(1000, Number(cfg.submitVerifyMs) || 6000);
            while (Date.now() < deadline) {
                await sleep(150);
                const current = findComposer() || composer;
                const cleared = !composerValue(current).trim();
                const grew = getMessages(currentLog || findLog()).length > before;
                if (cleared || grew) return { ok: true, method: button ? 'send button' : 'Enter key', before };
            }
            return { ok: false, composer, reason: 'Submission could not be verified (composer not cleared, no new message).' };
        } catch (error) {
            return { ok: false, reason: 'Submission error: ' + (error && error.message || error) };
        } finally {
            submitting = false;
        }
    }

    async function sendStep(task, op, userText, opts = {}) {
        if (!task) task = newTask(userText || 'Untitled task');
        if (!POLICY.allowedOperation(op)) { toast('Operation not allowed: ' + op, true); return false; }
        if (pending) { toast('Waiting for the previous response. Pause or cancel the task to resend.', true); return false; }
        if (['COMPLETED', 'CANCELLED', 'PAUSED'].includes(task.state)) {
            toast('Task is ' + task.state + '. ' + (task.state === 'PAUSED' ? 'Resume it first.' : 'Start a new task.'), true);
            return false;
        }
        if (task.stepCount >= POLICY.maxSteps) { toast('Task step limit (' + POLICY.maxSteps + ') reached.', true); return false; }
        if (!enterWorkingState(task, OP_STATES[op][0])) { renderUI(); toast('Illegal workflow transition from ' + task.state, true); return false; }

        const stepId = 'S' + (task.stepCount + 1);
        const prompt = buildPrompt(task, op, stepId, userText);
        const policyIssue = POLICY.checkPrompt(prompt);
        if (policyIssue) { toast(policyIssue, true); return false; }

        task.lastRequest = { op, userText: userText || '', stepId };
        task.step = stepId;
        logEvent(task, 'submit', 'Submitting ' + op + ' (' + stepId + ') through Arena composer…');
        renderUI();

        const result = await submitToArena(prompt, { replaceDraft: !!opts.replaceDraft });
        if (!result.ok) {
            logEvent(task, 'error', 'Submission failed: ' + result.reason);
            if (result.ambiguous) transition(task, 'PAUSED', 'composer ambiguous');
            else transition(task, 'ERROR', result.reason);
            if (opts.restoreText && result.composer) setNativeValue(result.composer, opts.restoreText);
            toast(result.reason + (opts.restoreText ? ' Your text was put back in the composer.' : ''), true, 5000);
            renderUI();
            return false;
        }
        task.stepCount++;
        task.retries = opts.retry ? task.retries : 0;
        pending = { taskId: task.id, stepId, op, sentAt: Date.now(), baseline: result.before, lastText: '', stableSince: 0 };
        logEvent(task, 'submit', 'Arena accepted ' + stepId + ' via ' + result.method + '. Awaiting response.');
        saveSessions();
        renderUI();
        return true;
    }

    // Called from the scheduler. Finds the assistant message after our
    // request marker and waits until it stops changing.
    function pollResponse() {
        if (!pending) return;
        const task = session.tasks.find(t => t.id === pending.taskId);
        if (!task || task.state === 'PAUSED' || task.state === 'CANCELLED') { pending = null; return; }
        const log = currentLog || findLog();
        if (!log) return;
        const chron = orderedMessages(log).chronological;
        let reqIndex = -1;
        for (let i = chron.length - 1; i >= 0; i--) {
            const m = (chron[i].textContent || '').match(REQUEST_MARKER);
            if (m && m[1] === pending.taskId && m[2] === pending.stepId) { reqIndex = i; break; }
        }
        if (reqIndex < 0) {
            if (Date.now() - pending.sentAt > 120000) {
                logEvent(task, 'error', 'Request marker for ' + pending.stepId + ' never appeared in the Arena log.');
                pending = null;
                transition(task, 'ERROR', 'request not found in log');
                renderUI();
            }
            return;
        }
        const reply = chron.slice(reqIndex + 1).find(el => !REQUEST_MARKER.test(el.textContent || ''));
        if (!reply) return;
        const text = messageText(reply);
        if (text !== pending.lastText) { pending.lastText = text; pending.stableSince = Date.now(); return; }
        if (Date.now() - pending.stableSince < 1800 || isGenerating()) return;
        const done = pending;
        pending = null;
        handleResponse(task, done, text);
    }

    function messageText(el) {
        if (!el) return '';
        // innerText respects hidden thinking blocks; textContent fallback for jsdom.
        return String((typeof el.innerText === 'string' && el.innerText) || el.textContent || '').trim();
    }

    // ══════════════════════════════════════════════════════════════════
    // RESPONSE PARSER
    // ══════════════════════════════════════════════════════════════════

    // Extract JSON objects that declare protocol ccce-agent/1. Parsed with
    // JSON.parse only — model output is never evaluated.
    function extractProtocolObjects(text) {
        const out = [];
        const src = String(text || '');
        let idx = src.indexOf('"protocol"');
        while (idx !== -1 && out.length < 5) {
            let start = src.lastIndexOf('{', idx);
            let parsed = null;
            while (start !== -1 && !parsed) {
                const end = matchBrace(src, start);
                if (end > idx) {
                    try {
                        const obj = JSON.parse(src.slice(start, end + 1));
                        if (obj && obj.protocol === PROTOCOL) parsed = { obj, end };
                    } catch (_) { /* not JSON */ }
                }
                if (!parsed) start = start > 0 ? src.lastIndexOf('{', start - 1) : -1;
                if (start !== -1 && idx - start > 200000) break;
            }
            if (parsed) { out.push(parsed.obj); idx = src.indexOf('"protocol"', parsed.end); }
            else idx = src.indexOf('"protocol"', idx + 10);
        }
        return out;
    }

    function matchBrace(src, start) {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < src.length && i - start < 400000; i++) {
            const c = src[i];
            if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
            if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) return i; }
        }
        return -1;
    }

    const str = (v, max = 4000) => typeof v === 'string' ? v.slice(0, max) : '';
    const arr = (v, max = 50) => Array.isArray(v) ? v.slice(0, max) : [];

    function validateResponse(obj, expect) {
        const errors = [];
        if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Not an object.'] };
        if (obj.protocol !== PROTOCOL) errors.push('Wrong protocol.');
        if (obj.task_id !== expect.taskId) errors.push('Stale or foreign task_id "' + str(obj.task_id, 40) + '".');
        if (obj.step_id !== expect.stepId) errors.push('Stale step_id "' + str(obj.step_id, 40) + '" (expected ' + expect.stepId + ').');
        if (!OPERATIONS.includes(obj.operation)) errors.push('Unknown operation "' + str(obj.operation, 40) + '".');
        if (!['ok', 'needs_input', 'blocked', 'error'].includes(obj.status)) errors.push('Invalid status.');
        const clean = {
            protocol: PROTOCOL, task_id: str(obj.task_id, 60), step_id: str(obj.step_id, 30),
            operation: obj.operation, status: obj.status, summary: str(obj.summary, 6000),
            referenced_files: arr(obj.referenced_files, 100).map(f => ({ path: str(f && f.path, 300), action: str(f && f.action, 30), reason: str(f && f.reason, 300) })).filter(f => f.path),
            proposed_patches: arr(obj.proposed_patches, 40).map(p => ({
                path: str(p && p.path, 300), action: str(p && p.action, 20) || 'modify',
                diff: str(p && p.diff, 300000), content: str(p && p.content, 300000), reason: str(p && p.reason, 500)
            })).filter(p => p.path),
            suggested_tests: arr(obj.suggested_tests, 50).map(t => ({ name: str(t && t.name, 200), command: str(t && t.command, 500), reason: str(t && t.reason, 400) })).filter(t => t.name),
            risks: arr(obj.risks, 30).map(r => str(r, 500)).filter(Boolean),
            plan: arr(obj.plan, 50).map(p => typeof p === 'string' ? p.slice(0, 600) : str(p && (p.step || p.title), 600)).filter(Boolean),
            validation: arr(obj.validation, 50).map(v => ({ check: str(v && v.check, 300), result: ['pass', 'fail', 'unknown'].includes(v && v.result) ? v.result : 'unknown', evidence: str(v && v.evidence, 2000) })).filter(v => v.check),
            handoff: obj.handoff && typeof obj.handoff === 'object' ? {
                branch: str(obj.handoff.branch, 120), commit_message: str(obj.handoff.commit_message, 2000),
                pr_title: str(obj.handoff.pr_title, 200), pr_body: str(obj.handoff.pr_body, 20000)
            } : null,
            next_action: obj.next_action && typeof obj.next_action === 'object'
                ? { operation: str(obj.next_action.operation, 40), reason: str(obj.next_action.reason, 500) }
                : { operation: 'none', reason: '' }
        };
        if (clean.next_action.operation !== 'none' && !OPERATIONS.includes(clean.next_action.operation)) {
            errors.push('next_action.operation not allowed: ' + clean.next_action.operation);
            clean.next_action = { operation: 'none', reason: 'rejected by policy' };
        }
        return { ok: errors.length === 0, errors, value: clean };
    }

    function handleResponse(task, req, rawText) {
        const record = { stepId: req.stepId, op: req.op, at: Date.now(), raw: rawText.slice(0, 200000), parsed: null, errors: [] };
        task.responses.push(record);
        if (task.responses.length > 25) task.responses.shift();

        const objects = extractProtocolObjects(rawText);
        if (!objects.length) {
            record.errors.push('No ' + PROTOCOL + ' block found; shown as a normal response. Workflow state not advanced.');
            logEvent(task, 'response', 'Unstructured response for ' + req.stepId + ' (state unchanged).');
            saveSessions(); renderUI();
            return;
        }
        const result = validateResponse(objects[objects.length - 1], req);
        record.errors = result.errors;
        if (!result.ok) {
            logEvent(task, 'error', 'Response rejected: ' + result.errors.join(' '));
            saveSessions(); renderUI();
            return;
        }
        const r = result.value;
        record.parsed = r;
        logEvent(task, 'response', r.operation + ' / ' + r.status + ': ' + (r.summary || '(no summary)').slice(0, 200));

        for (const f of r.referenced_files) {
            const check = POLICY.checkPath(f.path);
            const existing = task.files.find(x => x.path === f.path);
            const entry = { path: f.path, action: f.action || 'reference', reason: f.reason, status: check ? 'rejected: ' + check : 'suggested', stepId: r.step_id };
            if (existing) Object.assign(existing, entry); else task.files.push(entry);
        }
        for (const p of r.proposed_patches) addPatch(task, p, r.step_id);
        for (const t of r.suggested_tests) task.tests.push(Object.assign({ stepId: r.step_id }, t));
        for (const v of r.validation) task.validation.push(Object.assign({ source: 'model-reported (unverified)', stepId: r.step_id }, v));
        if (r.handoff) task.handoff = Object.assign({}, r.handoff, { stepId: r.step_id });
        if (r.plan.length) task.plan = r.plan;
        task.files = task.files.slice(-200); task.tests = task.tests.slice(-100); task.validation = task.validation.slice(-100);

        if (r.status === 'error' || r.status === 'blocked') {
            transition(task, 'ERROR', 'model reported ' + r.status);
        } else {
            const target = OP_STATES[r.operation][1];
            if (task.state !== target) transition(task, target, 'response ' + r.step_id);
        }
        saveSessions();
        renderUI();
        maybeAutoAdvance(task, r);
    }

    // Bounded autonomy: only follow-up prompts; never commits/pushes/PRs/merges.
    function maybeAutoAdvance(task, r) {
        if (!cfg.autonomous || r.status !== 'ok') return;
        const next = r.next_action.operation;
        if (!next || next === 'none' || !POLICY.autoAllowed(next)) return;
        if (task.autoSteps >= Math.min(POLICY.maxAutoSteps, Number(cfg.maxAutoSteps) || 0)) {
            logEvent(task, 'policy', 'Autonomous step limit reached; waiting for the user.');
            renderUI();
            return;
        }
        task.autoSteps++;
        logEvent(task, 'auto', 'Autonomous follow-up ' + task.autoSteps + ': ' + next);
        setTimeout(() => {
            if (activeTask() !== task && !session.tasks.includes(task)) return;
            if (!ACTIVE.includes(task.state)) return;
            sendStep(task, next, 'Continue: ' + (r.next_action.reason || next), { auto: true });
        }, 1500);
    }

    // ══════════════════════════════════════════════════════════════════
    // PATCH REVIEW
    // ══════════════════════════════════════════════════════════════════

    function diffStats(diff) {
        let added = 0, removed = 0;
        for (const line of String(diff || '').split('\n')) {
            if (line.startsWith('+++') || line.startsWith('---')) continue;
            if (line.startsWith('+')) added++;
            else if (line.startsWith('-')) removed++;
        }
        return { added, removed };
    }

    function addPatch(task, p, stepId) {
        const issues = [];
        const pathIssue = POLICY.checkPath(p.path);
        if (pathIssue) issues.push(pathIssue);
        if (!['modify', 'create', 'delete', 'replace'].includes(p.action)) issues.push('Unknown action "' + p.action + '".');
        if ((p.action === 'modify') && !p.diff) issues.push('Modify without a diff.');
        if ((p.action === 'create' || p.action === 'replace') && !p.content && !p.diff) issues.push('No content supplied.');
        const stats = p.diff ? diffStats(p.diff) : { added: (p.content || '').split('\n').length * (p.content ? 1 : 0), removed: 0 };
        const prior = task.patches.filter(x => x.path === p.path);
        prior.forEach(x => { if (x.status === 'proposed') x.status = 'superseded'; });
        const patch = {
            id: uid('P'), stepId, path: p.path, action: p.action, diff: p.diff, content: p.content, reason: p.reason,
            revision: prior.length + 1, status: issues.length ? 'invalid' : 'proposed',
            issues, risks: POLICY.riskFor(p, stats), added: stats.added, removed: stats.removed, at: Date.now()
        };
        task.patches.push(patch);
        if (task.patches.length > 120) task.patches.shift();
        const f = task.files.find(x => x.path === p.path);
        if (f) { f.action = p.action; f.status = 'proposed (rev ' + patch.revision + ')'; }
        else task.files.push({ path: p.path, action: p.action, reason: p.reason, status: 'proposed (rev ' + patch.revision + ')', stepId });
        return patch;
    }

    function patchToText(patch) {
        if (patch.diff) return patch.diff.endsWith('\n') ? patch.diff : patch.diff + '\n';
        if (patch.action === 'delete') return '# Proposed deletion: ' + patch.path + '\n';
        return '# Proposed full-file ' + patch.action + ': ' + patch.path + '\n' + (patch.content || '');
    }

    function exportPatches(task) {
        const list = task.patches.filter(p => p.status === 'proposed' || p.status === 'accepted');
        if (!list.length) { toast('No current proposed patches.', true); return; }
        const text = list.filter(p => p.diff).map(patchToText).join('\n');
        const replacements = list.filter(p => !p.diff);
        if (text) downloadBlob(text, sanitizeFilename(task.id + '-proposed') + '.patch', 'text/x-diff;charset=utf-8');
        for (const p of replacements) {
            if (p.action !== 'delete') downloadBlob(p.content || '', sanitizeFilename(p.path.split('/').pop() || 'file'), 'text/plain;charset=utf-8');
        }
        toast('Exported ' + list.length + ' proposal(s). Nothing was applied to any repository.');
    }

    function setPatchStatus(task, patch, status) {
        patch.status = status;
        logEvent(task, 'review', 'Patch ' + patch.path + ' rev ' + patch.revision + ' marked ' + status + ' (user review only).');
        saveSessions();
        renderUI();
    }

    // ══════════════════════════════════════════════════════════════════
    // GITHUB WORKSPACE UI (links + text only — no API calls)
    // ══════════════════════════════════════════════════════════════════

    function enc(path) { return String(path).split('/').map(encodeURIComponent).join('/'); }

    function githubLinks(task) {
        const repo = parseRepo(task && task.repo);
        if (!repo) return null;
        const base = 'https://github.com/' + repo.owner + '/' + repo.repo;
        const branch = validBranch(task.branch) && task.branch ? task.branch : '';
        const suggested = suggestedBranch(task);
        return {
            repo: base,
            branch: branch ? base + '/tree/' + enc(branch) : null,
            branches: base + '/branches',
            commits: base + '/commits' + (branch ? '/' + enc(branch) : ''),
            pulls: base + '/pulls',
            compare: base + '/compare/' + (branch ? enc(branch) : enc(suggested)) + '?expand=1',
            file: path => (POLICY.checkPath(path) ? null : base + '/blob/' + enc(branch || 'HEAD') + '/' + enc(path)),
            commit: sha => (/^[0-9a-f]{7,40}$/i.test(sha) ? base + '/commit/' + sha : null)
        };
    }

    function slug(text) {
        return String(text || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
    }

    function suggestedBranch(task) {
        const fromModel = task.handoff && task.handoff.branch;
        if (fromModel && validBranch(fromModel)) return fromModel;
        return 'ccce/' + slug(task.title) + '-' + task.id.slice(-4).toLowerCase();
    }

    function suggestedCommit(task) {
        if (task.handoff && task.handoff.commit_message) return task.handoff.commit_message;
        const files = task.patches.filter(p => p.status !== 'superseded' && p.status !== 'rejected').map(p => p.path);
        return slug(task.title).replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()) +
            (files.length ? '\n\nFiles: ' + Array.from(new Set(files)).join(', ') : '');
    }

    function validationChecklist(task) {
        const lines = [];
        for (const t of task.tests) lines.push('- [ ] ' + t.name + (t.command ? ' — `' + t.command + '`' : '') + ' (suggested, not run)');
        for (const v of task.validation) {
            lines.push('- [' + (v.result === 'pass' && v.source.startsWith('User') ? 'x' : ' ') + '] ' + v.check + ' — ' + v.result.toUpperCase() + ' (' + v.source + ')' + (v.evidence ? ': ' + v.evidence.replace(/\n/g, ' ') : ''));
        }
        if (!lines.length) lines.push('- [ ] No validation evidence recorded.');
        return lines.join('\n');
    }

    function handoffMarkdown(task) {
        const links = githubLinks(task);
        const pr = task.handoff || {};
        const out = [];
        out.push('# Handoff: ' + task.title, '');
        out.push('- Task ID: `' + task.id + '`', '- State: ' + task.state, '- Repository: ' + (task.repo || '_not set_'),
            '- Branch: ' + (task.branch || '_not set_') + ' (suggested: `' + suggestedBranch(task) + '`)', '');
        out.push('> Generated by Arena.ai Coding Edition (UI only). Nothing below was committed, pushed, or merged by this tool.', '');
        out.push('## PR title', '', pr.pr_title || task.title, '');
        out.push('## PR description', '', pr.pr_body || task.description || '_none_', '');
        out.push('## Suggested commit message', '', '```', suggestedCommit(task), '```', '');
        out.push('## Proposed changes', '');
        const live = task.patches.filter(p => p.status !== 'superseded');
        if (!live.length) out.push('_No proposed patches._');
        for (const p of live) out.push('- `' + p.path + '` — ' + p.action + ', rev ' + p.revision + ', +' + p.added + '/−' + p.removed + ', ' + p.status + (p.risks.length ? ' ⚠ ' + p.risks.join('; ') : ''));
        out.push('', '## Validation checklist', '', validationChecklist(task), '');
        if (links) out.push('## Links', '', '- Repository: ' + links.repo, links.branch ? '- Branch: ' + links.branch : '', '- Compare / open PR: ' + links.compare, '- Pull requests: ' + links.pulls, '');
        return out.filter(l => l !== null).join('\n');
    }

    // ══════════════════════════════════════════════════════════════════
    // POLICY ENGINE
    // ══════════════════════════════════════════════════════════════════

    const POLICY = Object.freeze({
        maxSteps: 40,
        maxAutoSteps: 12,
        maxPromptChars: 100000,
        // Autonomous mode may only request analysis, plans, patches, reviews, tests, summaries.
        autoOps: Object.freeze(['analyze_context', 'create_plan', 'propose_patch', 'review_patch', 'suggest_tests', 'prepare_handoff']),
        allowedOperation(op) { return OPERATIONS.includes(op); },
        autoAllowed(op) { return this.autoOps.includes(op); },
        checkPrompt(text) {
            if (text.length > this.maxPromptChars) return 'Prompt too long for policy (' + text.length + ' chars).';
            return '';
        },
        checkPath(path) {
            const p = String(path || '');
            if (!p) return 'empty path';
            if (p.length > 300) return 'path too long';
            if (/[\x00-\x1f]/.test(p)) return 'control characters in path';
            if (/^([a-z]:|[\\/]|~)/i.test(p)) return 'absolute or home path';
            if (p.split(/[\\/]/).some(s => s === '..')) return 'path traversal (..)';
            if (/(^|\/)\.git(\/|$)/.test(p)) return '.git internals';
            return '';
        },
        riskFor(p, stats) {
            const risks = [];
            const path = p.path || '';
            if (/(^|\/)\.github\/workflows\//.test(path)) risks.push('CI workflow change');
            if (/(^|\/)(\.env|.*secret.*|.*credential.*|id_rsa.*)$/i.test(path)) risks.push('possible secrets file');
            if (/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$/.test(path)) risks.push('lockfile change');
            if (/(^|\/)(package\.json|Dockerfile|Makefile)$/.test(path)) risks.push('build/dependency config');
            if (p.action === 'delete') risks.push('file deletion');
            if (stats.removed > 200 || stats.added > 500) risks.push('large change');
            if (/(^|\n)\+.*\b(eval|new Function|child_process|exec\(|rm -rf)\b/.test(p.diff || p.content || '')) risks.push('adds dynamic execution / shell call');
            return risks;
        }
    });

    // ══════════════════════════════════════════════════════════════════
    // SESSION STORE
    // ══════════════════════════════════════════════════════════════════

    const session = (() => {
        const raw = readStore(SESSION_KEY, null);
        const s = { version: 1, tasks: [], activeId: null };
        if (raw && Array.isArray(raw.tasks)) {
            s.tasks = raw.tasks.filter(t => t && typeof t.id === 'string' && STATES.includes(t.state)).slice(0, 40);
            s.activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
            for (const t of s.tasks) {
                for (const k of ['context', 'files', 'patches', 'tests', 'validation', 'responses', 'events']) if (!Array.isArray(t[k])) t[k] = [];
            }
        }
        return s;
    })();

    let saveSessionTimer = null;
    function saveSessions() {
        clearTimeout(saveSessionTimer);
        saveSessionTimer = setTimeout(() => writeStore(SESSION_KEY, { version: 1, tasks: session.tasks, activeId: session.activeId }), 300);
    }

    // ══════════════════════════════════════════════════════════════════
    // VIRTUALIZE
    // ══════════════════════════════════════════════════════════════════

    function flattenShiki(message) {
        if (!cfg.flattenCode || !message) return;
        for (const pre of qa('pre.shiki,pre[class*="shiki"]', message)) {
            if (pre.dataset.ccFlat === '1') continue;
            const code = q('code', pre);
            if (!code) continue;
            const lines = qa('.line', code);
            const plain = lines.length ? lines.map(line => line.textContent || '').join('\n') : (code.innerText || code.textContent || '');
            code.replaceChildren(document.createTextNode(plain));
            pre.dataset.ccFlat = '1';
        }
    }

    function virtualize() {
        const log = currentLog;
        if (!log) return null;
        const found = orderedMessages(log);
        const { messages, reversed, newestFirst } = found;
        const total = messages.length;
        const keep = Math.max(1, Math.floor(Number(cfg.keepMessages) || 8));

        if (cfg.virtualize && total > keep) {
            const newestSet = new Set(newestFirst.slice(0, keep));
            // Never hide the message that carries the in-flight request.
            for (const message of messages) if (!newestSet.has(message)) flattenShiki(message);
            for (const message of messages) {
                if (newestSet.has(message)) delete message.dataset.ccHidden;
                else message.dataset.ccHidden = '1';
            }
        } else {
            for (const message of messages) delete message.dataset.ccHidden;
        }

        hiddenCount = messages.filter(m => m.dataset.ccHidden === '1').length;
        const mode = cfg.virtualize ? 'virtualized' : 'disabled';
        const signature = JSON.stringify({ mode, total, hidden: hiddenCount, reversed, keep });
        if (signature !== lastVirtualSignature) {
            console.info('[CC] Virtualize', { mode, total, hidden: hiddenCount, reversed, keep });
            lastVirtualSignature = signature;
        }
        if (cfg.virtualize && total > keep && hiddenCount === 0 && !warnedStructure) {
            warnedStructure = true;
            console.warn('[CC] Virtualization found messages but could not hide any. Check the message DOM structure.');
        }
        if (total <= keep || !cfg.virtualize) warnedStructure = false;
        updateJumpButton();
        return found;
    }

    // ══════════════════════════════════════════════════════════════════
    // THINKING
    // ══════════════════════════════════════════════════════════════════

    const THINKING_TEXT = /think|thought|reason|chain[-\s]of[-\s]thought/i;

    function getThinkingButtons(root = currentLog) {
        if (!root) return [];
        return qa('button[data-state="closed"],button[data-state="open"]', root)
            .filter(button => THINKING_TEXT.test(textContent(button)) && !!button.closest('div.not-prose[data-state]'));
    }

    function thinkingWrapper(button) { return button.closest('div.not-prose[data-state]'); }

    function setThinkingMode(mode) {
        if (!['collapse', 'expand', 'hide'].includes(mode)) return;
        cfg.thinkingMode = mode;
        lastCollapseCount = -1;
        lastExpandCount = -1;
        updateDynamicCSS();
        saveConfig();
        if (mode !== 'hide') qa('[data-cc-thinking="1"]').forEach(el => delete el.dataset.ccThinking);
        dispatchThinkingMode(true);
        renderUI();
    }

    function dispatchThinkingMode(force = false) {
        const log = currentLog;
        if (!log) return;
        const { messages, newestFirst } = orderedMessages(log);
        const count = messages.length;
        const mode = cfg.thinkingMode;

        if (mode === 'hide') {
            for (const button of getThinkingButtons(log)) {
                const wrapper = thinkingWrapper(button);
                if (wrapper) wrapper.dataset.ccThinking = '1';
            }
            return;
        }
        qa('[data-cc-thinking="1"]', log).forEach(el => delete el.dataset.ccThinking);

        if (mode === 'expand') {
            if (!force && count <= lastExpandCount) return;
            lastExpandCount = count;
            for (const button of getThinkingButtons(log)) if (button.dataset.state === 'closed') button.click();
            return;
        }
        if (mode === 'collapse') {
            if (!force && count <= lastCollapseCount) return;
            lastCollapseCount = count;
            const newest = new Set(newestFirst.slice(0, 1));
            for (const message of messages) {
                if (newest.has(message)) continue;
                for (const button of getThinkingButtons(message)) if (button.dataset.state === 'open') button.click();
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // AUTO-SCROLL
    // ══════════════════════════════════════════════════════════════════

    function removeJumpButton() { jumpButton?.remove(); jumpButton = null; }

    function updateJumpButton() {
        const container = scrollElement();
        const shouldShow = !!container && !isNearBottom(container) ;
        if (!shouldShow) { removeJumpButton(); return; }
        if (!jumpButton || !jumpButton.isConnected) {
            jumpButton = document.createElement('button');
            jumpButton.id = 'cc-jump';
            jumpButton.type = 'button';
            jumpButton.textContent = '↓';
            jumpButton.title = 'Jump to latest message';
            jumpButton.setAttribute('aria-label', 'Jump to latest message');
            jumpButton.addEventListener('click', () => { scrollToBottom(scrollElement()); removeJumpButton(); });
            document.documentElement.appendChild(jumpButton);
        }
    }

    function teardownAutoScroll() {
        if (activeLogObserver) { activeLogObserver.disconnect(); activeLogObserver = null; }
        if (scrollCleanup) { scrollCleanup(); scrollCleanup = null; }
        removeJumpButton();
    }

    function rebuildAutoScroll(log) {
        teardownAutoScroll();
        if (!log) return;
        currentLog = log;
        const scroller = scrollElement(log);
        let stickToBottom = isNearBottom(scroller);
        const onScroll = () => { stickToBottom = isNearBottom(scroller); updateJumpButton(); };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        scrollCleanup = () => scroller.removeEventListener('scroll', onScroll);

        // Log-scoped observer: drives auto-scroll only. Scheduling is done
        // by the single document observer (no duplicate schedule triggers).
        activeLogObserver = new MutationObserver(() => {
            if (cfg.autoScroll && stickToBottom) {
                if (!rafPending) {
                    rafPending = true;
                    requestAnimationFrame(() => {
                        rafPending = false;
                        if (currentLog !== log || !log.isConnected) return;
                        scrollToBottom(scrollElement(log));
                    });
                }
            } else {
                updateJumpButton();
            }
        });
        activeLogObserver.observe(log, { childList: true, subtree: true, characterData: true });
    }

    // ══════════════════════════════════════════════════════════════════
    // MARKDOWN
    // ══════════════════════════════════════════════════════════════════

    // DOM -> Markdown for chronological export. Reads Arena's DOM; never
    // writes HTML from it.
    function nodeToMarkdown(node, ctx = { list: [] }) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const el = node;
        if (isOwnUI(el) || el.matches('script,style,button,svg,.cc-code-buttons')) return '';
        if (el.dataset.ccThinking === '1') return '';
        const tag = el.tagName.toLowerCase();
        const kids = () => Array.from(el.childNodes).map(n => nodeToMarkdown(n, ctx)).join('');
        switch (tag) {
            case 'pre': {
                const code = q('code', el) || el;
                const lang = detectCodeLanguage(el);
                const body = pre_text(el, code);
                const fence = body.includes('```') ? '````' : '```';
                return '\n\n' + fence + lang + '\n' + body.replace(/\n$/, '') + '\n' + fence + '\n\n';
            }
            case 'code': return '`' + (el.textContent || '') + '`';
            case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
                return '\n\n' + '#'.repeat(Number(tag[1]) + 1 > 6 ? 6 : Number(tag[1]) + 1) + ' ' + kids().trim() + '\n\n';
            case 'p': return '\n\n' + kids().trim() + '\n\n';
            case 'br': return '  \n';
            case 'strong': case 'b': return '**' + kids() + '**';
            case 'em': case 'i': return '*' + kids() + '*';
            case 'a': {
                const href = safeUrl(el.getAttribute('href') || '');
                const text = kids().trim();
                return href ? '[' + text + '](' + href + ')' : text;
            }
            case 'ul': case 'ol': {
                ctx.list.push({ ordered: tag === 'ol', n: 0 });
                const out = '\n' + kids() + '\n';
                ctx.list.pop();
                return out;
            }
            case 'li': {
                const l = ctx.list[ctx.list.length - 1] || { ordered: false, n: 0 };
                l.n++;
                const indent = '  '.repeat(Math.max(0, ctx.list.length - 1));
                return '\n' + indent + (l.ordered ? l.n + '. ' : '- ') + kids().trim();
            }
            case 'blockquote': return '\n\n' + kids().trim().split('\n').map(x => '> ' + x).join('\n') + '\n\n';
            case 'hr': return '\n\n---\n\n';
            case 'table': {
                const rows = qa('tr', el).map(tr => '| ' + qa('th,td', tr).map(c => textContent(c).replace(/\|/g, '\\|')).join(' | ') + ' |');
                if (rows.length) rows.splice(1, 0, rows[0].replace(/[^|]+/g, ' --- '));
                return '\n\n' + rows.join('\n') + '\n\n';
            }
            default: return kids();
        }
    }

    function pre_text(pre, code) {
        return pre.dataset.ccOriginalCode || code.textContent || '';
    }

    function messageToMarkdown(el) {
        return nodeToMarkdown(el).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function exportChatMarkdown() {
        const log = currentLog || findLog();
        if (!log) { toast('No chat container found.', true); return; }
        const chron = orderedMessages(log).chronological; // includes virtualized messages
        const title = safePageTitle();
        const parts = ['# ' + title, '', '- Exported: ' + new Date().toLocaleString(), '- Page: ' + location.href,
            '- Messages: ' + chron.length, ''];
        chron.forEach((m, i) => {
            parts.push('---', '', '## ' + (i + 1) + '. ' + (messageRole(m, i) === 'user' ? 'User' : 'Assistant'), '', messageToMarkdown(m), '');
        });
        const filename = sanitizeFilename(title) + '-' + new Date().toISOString().slice(0, 10) + '.md';
        downloadBlob(parts.join('\n'), filename, 'text/markdown;charset=utf-8');
        toast('Conversation exported as Markdown (' + chron.length + ' messages).');
    }

    // v3.4.3 HTML export, kept. Title/URL are now escaped; scripts and
    // inline event handlers are stripped from the snapshot.
    function collectInlineStyles(doc) {
        const styles = [];
        for (const style of qa('style', doc)) {
            if (style.id && style.id.startsWith('cc-')) continue;
            styles.push((style.textContent || '').replace(/<\/style/gi, '<\\/style'));
        }
        return styles.join('\n');
    }

    function cloneConversation(log) {
        if (!log) return null;
        const clone = log.cloneNode(true);
        for (const hidden of qa('[data-cc-hidden="1"]', clone)) hidden.removeAttribute('data-cc-hidden');
        for (const el of qa('#cc-drawer,#cc-toggle,#cc-toast,#cc-jump,#cc-nav-export,.cc-code-buttons,.ccce-card,.ccce-ctls,.ccce-reqline,script,iframe,object,embed', clone)) el.remove();
        for (const el of qa('*', clone)) {
            for (const attr of Array.from(el.attributes)) {
                if (/^on/i.test(attr.name) || (/^(href|src|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
            }
        }
        return clone;
    }

    function exportChatHTML() {
        const log = currentLog || findLog();
        if (!log) { toast('No chat container found.', true); return; }
        const count = orderedMessages(log).messages.length;
        const title = escapeHTML(safePageTitle());
        const filename = sanitizeFilename(safePageTitle()) + '-' + new Date().toISOString().slice(0, 10) + '.html';
        const themeAttr = escapeHTML(document.documentElement.getAttribute('class') || '');
        const dataTheme = escapeHTML(document.documentElement.getAttribute('data-theme') || '');
        const cloned = cloneConversation(log);
        const html = `<!DOCTYPE html>
<html lang="en" class="${themeAttr}" data-theme="${dataTheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Conversation Export</title>
<style>
:root { --x-bg:#ffffff; --x-surface:#fafafa; --x-text:#18181b; --x-muted:#71717a; --x-border:#e4e4e7; }
html.dark, html[data-theme="dark"] { --x-bg:#09090b; --x-surface:#18181b; --x-text:#fafafa; --x-muted:#a1a1aa; --x-border:#3f3f46; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin:0; padding:24px; color:var(--x-text); background:var(--x-bg); }
.conversation-export { max-width:900px; margin:0 auto; }
.meta { color:var(--x-muted); font-size:12px; margin-bottom:16px; border-bottom:1px solid var(--x-border); padding-bottom:12px; }
pre { overflow:auto; }
${collectInlineStyles(document)}
</style>
</head>
<body>
<div class="conversation-export">
  <h1>${title}</h1>
  <div class="meta">Exported: ${escapeHTML(new Date().toLocaleString())}<br>Page: ${escapeHTML(location.href)}<br>Messages: ${count}</div>
  <div class="messages">${cloned ? cloned.outerHTML : ''}</div>
</div>
</body>
</html>`;
        downloadBlob(html, filename, 'text/html;charset=utf-8');
        toast('Conversation exported as HTML.');
    }

    function downloadBlob(content, filename, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        (document.body || document.documentElement).appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    // ══════════════════════════════════════════════════════════════════
    // AGENT ACTIONS
    // ══════════════════════════════════════════════════════════════════

    async function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
        } catch (_) { /* legacy fallback */ }
        try {
            const input = document.createElement('textarea');
            input.value = text;
            input.style.position = 'fixed';
            input.style.opacity = '0';
            document.body.appendChild(input);
            input.select();
            const result = document.execCommand('copy');
            input.remove();
            return result;
        } catch (_) { return false; }
    }

    // PR state is inferred from the Arena conversation text only.
    function detectPRState() {
        const log = currentLog || findLog();
        const text = log ? (log.textContent || '') : '';
        if (/(pull.?request|PR)[^.\n]{0,80}?(merged|closed|deployed)/i.test(text)) return 'merged';
        if (/(pull.?request|PR)[^.\n]{0,80}?(open|created|#\d+|https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)/i.test(text)) return 'open';
        return prState || 'none';
    }

    // Create PR / Merge PR: instruction-generation only. They place text in
    // Arena's composer for the user to review and submit; nothing is sent
    // to GitHub by this script.
    async function fillComposer(message, okText) {
        const composer = findComposer();
        if (!composer) {
            const copied = await copyText(message);
            toast('Composer not found.' + (copied ? ' Request copied to clipboard.' : ''), true, 4500);
            return false;
        }
        try {
            setNativeValue(composer, message);
            composer.focus();
            toast(okText);
            return true;
        } catch (_) {
            await copyText(message);
            toast('Could not populate composer. Request copied if clipboard is available.', true);
            return false;
        }
    }

    function createPR() {
        const task = activeTask();
        let message = 'Create a pull request for the current changes and give me the PR URL.';
        if (task && task.patches.length) {
            message += '\n\nSuggested branch: ' + suggestedBranch(task) + '\nSuggested title: ' + ((task.handoff && task.handoff.pr_title) || task.title);
        }
        if (task) logEvent(task, 'github', 'Create PR instruction placed in Arena composer (not submitted).');
        return fillComposer(message, 'Request entered in the Arena composer. Review it and submit when ready.');
    }

    function mergePR() {
        const task = activeTask();
        if (task) logEvent(task, 'github', 'Merge PR instruction placed in Arena composer (not submitted).');
        return fillComposer('The pull request has been created. Please merge it and let me know the result.',
            'Merge request entered in the Arena composer. Review it and submit when ready.');
    }

    function clickContinueButton() {
        if (prState !== 'merged' || !cfg.autoClickContinue) return false;
        const now = Date.now();
        if (now - lastContinueClick < 3000) return false;
        const composer = findComposer();
        if (!composer) return false;
        const panel = composerWrapper(composer) || composer.parentElement;
        if (!panel) return false;
        const candidates = qa('button,a,[role="button"]', panel).filter(el => {
            if (!isVisible(el) || isOwnUI(el)) return false;
            const label = [textContent(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ').trim();
            return /^continue\b/i.test(label);
        });
        for (const btn of candidates) {
            try { btn.click(); lastContinueClick = now; toast('Continue button clicked.'); return true; } catch (_) { /* next */ }
        }
        return false;
    }

    function clickPageUpdatedBanner() {
        const candidates = qa('button,a,[role="button"],div[class*="toast"],div[class*="banner"],div[class*="notification"]');
        for (const el of candidates) {
            if (!isVisible(el) || isOwnUI(el) || el.closest('[role="log"]')) continue;
            const label = [textContent(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ').trim();
            if (!label || label.length > 160) continue;
            if (!/page\s+(has\s+been\s+)?updated|new version (is )?available/i.test(label)) continue;
            if (el === lastClickedBanner) continue;
            lastClickedBanner = el;
            setTimeout(() => { lastClickedBanner = null; }, 5000);
            try { el.click(); } catch (_) { /* ignore */ }
            toast('Page-update banner clicked.');
            return true;
        }
        return false;
    }

    function watchPageUpdatedBanner() { if (cfg.autoClickPageUpdated) clickPageUpdatedBanner(); }

    async function clearChat() {
        const before = getMessages(findLog()).length;
        const patterns = [/\bnew chat\b/i, /\bnew conversation\b/i, /\bstart new chat\b/i, /\bnew thread\b/i,
            /\bnew session\b/i, /\bclear chat\b/i, /\bclear conversation\b/i, /\breset chat\b/i, /\bcreate chat\b/i];
        const candidates = qa('button,a,[role="button"]').filter(el => {
            if (!isVisible(el) || isOwnUI(el) || el.closest('[role="log"]')) return false;
            const label = [textContent(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ').trim();
            return !!label && patterns.some(p => p.test(label));
        }).map(el => {
            const r = el.getBoundingClientRect();
            let score = textContent(el) ? 5 : 0;
            if (el.closest('aside,nav,[role="navigation"]')) score += 5;
            if (r.top < window.innerHeight * 0.35) score += 3;
            if (el.tagName === 'A') score += 1;
            return { el, score };
        }).sort((a, b) => b.score - a.score);
        if (candidates.length) {
            candidates[0].el.click();
            await sleep(900);
            const after = getMessages(findLog()).length;
            if (after < before || after === 0) { toast('Chat cleared successfully.'); schedule(); return; }
        }
        toast('Could not verify that the chat was cleared.', true, 3500);
        await sleep(400);
        if (confirm('Arena did not confirm that the chat was cleared. Navigate to / instead?')) location.assign('/');
    }

    async function runDiagnostics() {
        const log = findLog();
        const scored = scoreComposers();
        const task = activeTask();
        const report = {
            version: VERSION,
            timestamp: new Date().toISOString(),
            url: location.href,
            title: document.title,
            prState,
            theme: { arenaDark: arenaIsDark(), mode: cfg.themeMode, resolved: resolvedTheme() },
            observers: { document: !!mainObserver, log: !!activeLogObserver },
            log: log ? {
                tag: log.tagName, className: String(log.className || ''), childCount: log.children.length,
                messageCount: getMessages(log).length, hidden: hiddenCount,
                direction: orderedMessages(log).reversed ? 'reversed' : 'normal'
            } : null,
            composerCandidates: scored.slice(0, 5).map(c => ({
                tag: c.el.tagName, score: c.score, role: c.el.getAttribute('role'),
                placeholder: c.el.getAttribute('placeholder'), ariaLabel: c.el.getAttribute('aria-label')
            })),
            sendButton: scored[0] ? !!findSendButton(scored[0].el) : false,
            task: task ? { id: task.id, state: task.state, step: task.step, steps: task.stepCount, pending: !!pending } : null,
            buttons: qa('button').filter(b => isVisible(b) && !isOwnUI(b)).slice(0, 100).map(b => ({
                text: textContent(b).slice(0, 100), ariaLabel: b.getAttribute('aria-label'), dataState: b.getAttribute('data-state')
            })),
            settings: { ...cfg }
        };
        const json = JSON.stringify(report, null, 2);
        console.log('[CC] Diagnostics\n' + json);
        const copied = await copyText(json);
        toast(copied ? 'Diagnostics logged and copied.' : 'Diagnostics logged. Clipboard unavailable.', !copied);
        return report;
    }

    // Eye toggle (v3.4.3): hides Arena's composer so only userscript UI remains.
    function applyEyeToggle() {
        if (!cfg.eyeToggle) { restoreEyeToggle(); return; }
        document.documentElement.dataset.ccEye = '1';
        const composer = findComposer();
        if (composer && !isOwnUI(composer) && composer.dataset.ccEyeHidden !== '1') {
            composer.style.setProperty('display', 'none', 'important');
            composer.dataset.ccEyeHidden = '1';
        }
    }

    function restoreEyeToggle() {
        document.documentElement.dataset.ccEye = '';
        for (const el of qa('[data-cc-eye-hidden="1"]')) { el.style.removeProperty('display'); delete el.dataset.ccEyeHidden; }
    }

    function toggleEye() {
        cfg.eyeToggle = !cfg.eyeToggle;
        saveConfig();
        updateDynamicCSS();
        if (cfg.eyeToggle) applyEyeToggle(); else restoreEyeToggle();
        toast(cfg.eyeToggle ? 'Arena composer hidden (eye toggle)' : 'All UI restored');
        renderUI();
    }

    // ══════════════════════════════════════════════════════════════════
    // COMPOSER VISIBILITY
    // ══════════════════════════════════════════════════════════════════

    function restoreComposer() {
        for (const wrapper of qa('[data-cc-composer-hide="1"]')) {
            wrapper.style.removeProperty('display');
            delete wrapper.dataset.ccComposerHide;
        }
        composerHideWrapper = null;
    }

    function applyComposerHide() {
        if (!cfg.hideComposer) {
            if (composerHideWrapper || q('[data-cc-composer-hide="1"]')) restoreComposer();
            return true;
        }
        const existing = q('[data-cc-composer-hide="1"]');
        if (existing) { composerHideWrapper = existing; return true; }
        const wrapper = composerWrapper(findComposer());
        if (!wrapper) return false;
        wrapper.dataset.ccComposerHide = '1';
        wrapper.style.setProperty('display', 'none', 'important');
        composerHideWrapper = wrapper;
        return true;
    }

    function toggleComposerVisibility(enabled) {
        cfg.hideComposer = enabled;
        if (enabled && !applyComposerHide()) {
            cfg.hideComposer = false;
            restoreComposer();
            saveConfig();
            renderUI();
            toast('Could not identify a safe composer wrapper. Hide Composer was rolled back.', true, 4500);
            return false;
        }
        if (!enabled) restoreComposer();
        saveConfig();
        renderUI();
        return true;
    }

    // ══════════════════════════════════════════════════════════════════
    // CODE BLOCK EXPORT
    // ══════════════════════════════════════════════════════════════════

    const EXTENSIONS = {
        js: 'js', mjs: 'mjs', cjs: 'cjs', ts: 'ts', jsx: 'jsx', tsx: 'tsx',
        py: 'py', python: 'py', rb: 'rb', ruby: 'rb', go: 'go', rs: 'rs', rust: 'rs',
        java: 'java', kt: 'kt', kotlin: 'kt', swift: 'swift', scala: 'scala',
        c: 'c', h: 'h', cpp: 'cpp', cxx: 'cpp', hpp: 'hpp', cs: 'cs', php: 'php', r: 'r', pl: 'pl', lua: 'lua',
        sh: 'sh', bash: 'sh', shell: 'sh', ps1: 'ps1', powershell: 'ps1', sql: 'sql', html: 'html', xml: 'xml',
        css: 'css', scss: 'scss', sass: 'sass', less: 'less', json: 'json', jsonc: 'jsonc', yaml: 'yml', yml: 'yml',
        toml: 'toml', md: 'md', markdown: 'md', diff: 'diff', patch: 'patch', dockerfile: 'Dockerfile',
        makefile: 'Makefile', ini: 'ini', env: 'env', graphql: 'graphql', gql: 'graphql',
        vue: 'vue', svelte: 'svelte', astro: 'astro', prisma: 'prisma', txt: 'txt',
        jsxdev: 'jsx', typescript: 'ts', javascript: 'js', wgsl: 'wgsl', glsl: 'glsl'
    };

    function detectCodeLanguage(pre) {
        const code = q('code', pre);
        const raw = [pre.dataset.language, code?.dataset.language, ...Array.from(pre.classList), ...Array.from(code?.classList || [])].join(' ');
        const match = raw.match(/(?:language-|lang-)([a-zA-Z0-9_+#.-]+)/i);
        return match ? match[1] : (pre.dataset.language || code?.dataset.language || '');
    }

    function extensionFor(language) { return EXTENSIONS[String(language || '').toLowerCase()] || 'txt'; }

    // v3.4.3 built this RegExp with over-escaped backslashes, so it never
    // matched a filename; fixed here.
    function extractCodeFilename(pre, nextIndex) {
        const ext = extensionFor(detectCodeLanguage(pre));
        const fileRe = new RegExp('([\\w./-]+\\.(?:' + Object.keys(EXTENSIONS).join('|') + '))\\b', 'i');
        const previous = pre.previousElementSibling || pre.parentElement?.previousElementSibling;
        if (previous) {
            const candidate = textContent(previous);
            if (candidate.length < 200) {
                const match = candidate.match(fileRe);
                if (match) return sanitizeFilename(match[1].split('/').pop());
            }
        }
        const labelled = [pre.getAttribute('aria-label'), pre.getAttribute('title'),
            q('code', pre)?.getAttribute('aria-label'), q('code', pre)?.getAttribute('title')].filter(Boolean).join(' ');
        const labelMatch = labelled.match(fileRe);
        if (labelMatch) return sanitizeFilename(labelMatch[1].split('/').pop());
        if (pre.dataset.filename) return sanitizeFilename(pre.dataset.filename);
        return nextIndex === 0 ? '' : 'snippet-' + (++snippetCounter) + '.' + ext;
    }

    function cleanupCodeWrappers() {
        for (const wrapper of qa('[data-cc-wrap="1"]')) {
            const pre = q('pre', wrapper);
            if (!pre || !pre.isConnected) wrapper.remove();
        }
    }

    function decorateCodeBlocks() {
        const log = currentLog;
        if (!log) return;
        cleanupCodeWrappers();
        for (const message of getMessages(log).filter(m => m.dataset.ccHidden !== '1')) {
            for (const pre of qa('pre', message)) {
                if (pre.closest('[data-cc-hidden="1"]')) continue;
                const cls = (pre.className || '') + ' ' + (q('code', pre)?.className || '');
                const isDownloadable = !/(bash|\bsh\b|shell|zsh|powershell|ps1|console|stdout|stderr|terminal|output)/i.test(cls);
                let wrapper = pre.parentElement;
                if (pre.dataset.ccDecorated === '1' && wrapper?.dataset.ccWrap === '1') {
                    const buttons = q('.cc-code-buttons', wrapper);
                    if (buttons) {
                        if (!q('.cc-code-copy', buttons)) addCodeCopyButton(buttons, pre);
                        const dl = q('.cc-code-download', buttons);
                        if (isDownloadable && !dl) addCodeDownloadButton(buttons, pre);
                        if (!isDownloadable && dl) dl.remove();
                        continue;
                    }
                }
                if (wrapper?.dataset.ccWrap !== '1') {
                    wrapper = document.createElement('div');
                    wrapper.dataset.ccWrap = '1';
                    wrapper.style.position = 'relative';
                    pre.parentNode.insertBefore(wrapper, pre);
                    wrapper.appendChild(pre);
                }
                let buttons = q('.cc-code-buttons', wrapper);
                if (!buttons) {
                    buttons = document.createElement('div');
                    buttons.className = 'cc-code-buttons';
                    wrapper.appendChild(buttons);
                }
                if (!q('.cc-code-copy', buttons)) addCodeCopyButton(buttons, pre);
                if (isDownloadable && !q('.cc-code-download', buttons)) addCodeDownloadButton(buttons, pre);
                pre.dataset.ccDecorated = '1';
            }
        }
    }

    function codeOf(pre) {
        const code = q('code', pre) || pre;
        return pre.dataset.ccOriginalCode || code.innerText || code.textContent || '';
    }

    function addCodeCopyButton(container, pre) {
        const button = h('button', { type: 'button', class: 'cc-code-copy', title: 'Copy code', 'aria-label': 'Copy code block', text: 'Copy' });
        button.addEventListener('click', async event => {
            event.preventDefault(); event.stopPropagation();
            const ok = await copyText(codeOf(pre));
            toast(ok ? 'Copied to clipboard' : 'Copy failed', !ok);
        });
        container.appendChild(button);
    }

    function addCodeDownloadButton(container, pre) {
        const button = h('button', { type: 'button', class: 'cc-code-download', title: 'Download code', 'aria-label': 'Download code block', text: '↓' });
        button.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            const filename = extractCodeFilename(pre, 1);
            downloadBlob(codeOf(pre), filename, 'text/plain;charset=utf-8');
            toast('Downloaded ' + filename);
        });
        container.appendChild(button);
    }

    // Text mode (v3.4.3): replace code blocks with a one-line description.
    function applyTextMode() {
        if (!currentLog) return;
        for (const message of getMessages(currentLog).filter(m => m.dataset.ccHidden !== '1')) {
            for (const pre of qa('pre', message)) {
                const code = q('code', pre) || pre;
                if (!pre.dataset.ccOriginalCode) pre.dataset.ccOriginalCode = code.innerText || code.textContent || '';
                const inner = q('code', pre);
                if (cfg.textMode) {
                    const original = pre.dataset.ccOriginalCode;
                    const filename = extractCodeFilename(pre, 0);
                    const desc = filename ? 'Examined file: ' + filename
                        : '[Code block: ' + (detectCodeLanguage(pre) || 'text') + ', ' + original.split('\n').length + ' lines]';
                    pre.setAttribute('data-cc-textdesc', desc);
                    pre.style.setProperty('max-height', '48px', 'important');
                    if (inner) inner.style.setProperty('visibility', 'hidden', 'important');
                } else if (pre.hasAttribute('data-cc-textdesc')) {
                    pre.removeAttribute('data-cc-textdesc');
                    pre.style.removeProperty('max-height');
                    if (inner) inner.style.removeProperty('visibility');
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // STATISTICS
    // ══════════════════════════════════════════════════════════════════

    function countStats() {
        const log = currentLog || findLog();
        const messages = getMessages(log);
        const totalText = messages.map(m => m.textContent || '').join('\n');
        const visibleMessages = messages.filter(m => m.dataset.ccHidden !== '1');
        const visibleText = visibleMessages.map(m => m.textContent || '').join('\n');
        const codeBlocks = messages.reduce((sum, m) => sum + qa('pre', m).length, 0);
        const thinkingBlocks = log ? getThinkingButtons(log).length : 0;
        const totalTokens = Math.ceil(totalText.length / 4);
        const visibleTokens = Math.ceil(visibleText.length / 4);
        const context = Math.max(1, Number(cfg.contextWindow) || 200000);
        return {
            total: messages.length, visible: visibleMessages.length, hidden: messages.length - visibleMessages.length,
            totalChars: totalText.length, visibleChars: visibleText.length, codeBlocks, thinkingBlocks,
            totalTokens, visibleTokens, hiddenTokens: Math.max(0, totalTokens - visibleTokens),
            context, percentage: Math.min(100, totalTokens / context * 100)
        };
    }

    function formatCompact(n) {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }
    // ══════════════════════════════════════════════════════════════════
    // TASK TRIGGER (Arena's own composer: Agent toggle and /commands)
    // ══════════════════════════════════════════════════════════════════

    const TRIGGER_OPS = Object.freeze({
        '/task': 'create_plan', '/plan': 'create_plan', '/patch': 'propose_patch', '/review': 'review_patch',
        '/tests': 'suggest_tests', '/validate': 'report_validation', '/handoff': 'prepare_handoff', '/analyze': 'analyze_context'
    });

    function parseTrigger(text) {
        const value = String(text || '');
        if (REQUEST_MARKER.test(value)) return null; // already a protocol prompt
        const m = value.match(/^\s*(\/(?:task|plan|patch|review|tests|validate|handoff|analyze))(?=\s|$)\s*([\s\S]*)$/i);
        if (m) return { cmd: m[1].toLowerCase(), body: m[2].trim() };
        if (cfg.agentMode && value.trim()) return { cmd: 'agent', body: value.trim() };
        return null;
    }

    // Follow-up operation implied by the current state when Agent mode wraps a plain message.
    function opForState(state) {
        return ({ IDLE: 'create_plan', PREPARING: 'create_plan', PLANNING: 'create_plan', PLAN_REVIEW: 'create_plan',
            CHANGE_PROPOSAL: 'propose_patch', PATCH_REVIEW: 'propose_patch', VALIDATION_REVIEW: 'report_validation',
            HANDOFF: 'prepare_handoff' })[state] || 'create_plan';
    }

    function liveTask() {
        const t = activeTask();
        return t && !['COMPLETED', 'CANCELLED'].includes(t.state) ? t : null;
    }

    function routeTrigger(trig) {
        if (trig.cmd === '/task') return { task: newTask(trig.body), op: 'create_plan' };
        const current = liveTask();
        if (trig.cmd === 'agent') return current ? { task: current, op: opForState(current.state) } : { task: newTask(trig.body), op: 'create_plan' };
        return { task: current || newTask(trig.body), op: TRIGGER_OPS[trig.cmd] };
    }

    // Capture-phase listener on window: runs before Arena's React handlers.
    // Plain sends (no /command, Agent off) are never touched.
    function interceptSend(event) {
        if (submitting) return;
        const composer = findComposer();
        if (!composer) return;
        if (event.type === 'keydown') {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || isMobile()) return;
            if (!(event.target === composer || composer.contains(event.target))) return;
        } else {
            const send = findSendButton(composer);
            if (!send || !(event.target === send || send.contains(event.target))) return;
        }
        const original = composerValue(composer);
        const trig = parseTrigger(original);
        if (!trig) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!trig.body) { toast('Add a task description after ' + trig.cmd + '.', true); return; }
        if (pending) { toast('Waiting for the previous agent step. Pause the task in the drawer to send normally.', true, 4500); return; }
        const { task, op } = routeTrigger(trig);
        sendStep(task, op, trig.body, { replaceDraft: true, restoreText: original });
    }

    // ══════════════════════════════════════════════════════════════════
    // INLINE CARDS (enhance ccce-agent/1 blocks inside Arena messages)
    // ══════════════════════════════════════════════════════════════════

    function protocolPre(msg) {
        return qa('pre', msg).reverse().find(pre => /"protocol"\s*:\s*"ccce-agent\/1"/.test(pre.textContent || ''));
    }

    function rawAnchor(pre) {
        return pre.parentElement && pre.parentElement.dataset.ccWrap === '1' ? pre.parentElement : pre;
    }

    function rawToggle(anchor) {
        return h('button', { type: 'button', class: 'ccce-rawtoggle', onclick: e => {
            e.preventDefault();
            const hidden = anchor.dataset.ccceRaw === '1';
            if (hidden) delete anchor.dataset.ccceRaw; else anchor.dataset.ccceRaw = '1';
            e.currentTarget.textContent = hidden ? 'Hide protocol JSON' : 'Show protocol JSON';
        } }, 'Show protocol JSON');
    }

    function collapseRequest(msg, marker) {
        const pre = protocolPre(msg);
        if (!pre) return;
        const anchor = rawAnchor(pre);
        if (anchor.previousElementSibling && anchor.previousElementSibling.classList.contains('ccce-reqline')) return;
        let op = '';
        try { op = (extractRequestOp(pre.textContent || '')) || ''; } catch (_) { /* display only */ }
        anchor.dataset.ccceRaw = '1';
        anchor.parentNode.insertBefore(h('div', { class: 'ccce-reqline' },
            'Agent request · ' + marker[1] + ' / ' + marker[2] + (op ? ' · ' + op : '') + ' ', rawToggle(anchor)), anchor);
    }

    function extractRequestOp(text) {
        const m = String(text).match(/"operation"\s*:\s*"([a-z_]+)"/);
        return m && OPERATIONS.includes(m[1]) ? m[1] : '';
    }

    function cardVersion(task) {
        return task ? [task.state, task.updated, pending ? pending.stepId : '', task.patches.length].join('|') : 'untracked';
    }

    function enhanceMessages() {
        if (!currentLog) return;
        for (const msg of getMessages(currentLog)) {
            if (msg.dataset.ccHidden === '1') continue;
            const text = msg.textContent || '';
            if (!text.includes('ccce-agent/1')) continue;
            const marker = text.match(REQUEST_MARKER);
            if (marker) { collapseRequest(msg, marker); continue; }
            enhanceResponse(msg);
        }
    }

    function enhanceResponse(msg) {
        const pre = protocolPre(msg);
        const source = pre ? (pre.dataset.ccOriginalCode || pre.textContent || '') : (msg.textContent || '');
        const objs = extractProtocolObjects(source);
        if (!objs.length) return;
        const obj = objs[objs.length - 1];
        const task = session.tasks.find(t => t.id === obj.task_id) || null;
        if (task && pending && pending.taskId === task.id && pending.stepId === obj.step_id) return; // still streaming

        let rec = task ? task.responses.find(r => r.stepId === obj.step_id && r.parsed) : null;
        // Recovery after reload: the current step's reply arrived while no request was pending.
        if (task && !rec && task.step === obj.step_id && !task.responses.some(r => r.stepId === obj.step_id)) {
            handleResponse(task, { taskId: task.id, stepId: obj.step_id, op: obj.operation }, messageText(msg));
            rec = task.responses.find(r => r.stepId === obj.step_id && r.parsed);
        }
        const check = validateResponse(obj, { taskId: obj.task_id, stepId: obj.step_id });
        const parsed = rec ? rec.parsed : check.value;
        const key = obj.task_id + '/' + obj.step_id;
        const version = cardVersion(task);
        const existing = qa('.ccce-card', msg).find(c => c.dataset.key === key);
        if (existing && existing.dataset.ver === version) return;

        const anchor = pre ? rawAnchor(pre) : null;
        const card = buildCard(task, parsed, rec ? rec.errors : check.errors, anchor);
        card.dataset.key = key;
        card.dataset.ver = version;
        if (existing) existing.replaceWith(card);
        else if (anchor && anchor.parentNode) { anchor.dataset.ccceRaw = '1'; anchor.parentNode.insertBefore(card, anchor.nextSibling); }
        else msg.appendChild(card);
    }

    function cbtn(label, onclick, primary = false, disabled = false) {
        return h('button', { type: 'button', class: 'ccce-btn' + (primary ? ' primary' : ''), disabled: disabled ? true : null,
            onclick: e => { e.preventDefault(); e.stopPropagation(); onclick(e); } }, label);
    }

    function renderDiff(text) {
        const box = h('div', { class: 'ccce-diff', role: 'region', 'aria-label': 'Unified diff', tabindex: '0' });
        const lines = String(text || '').split('\n');
        for (const line of lines.slice(0, 3000)) {
            let cls = null;
            if (/^(\+\+\+|---|@@|diff )/.test(line)) cls = 'h';
            else if (line.startsWith('+')) cls = 'a';
            else if (line.startsWith('-')) cls = 'd';
            box.appendChild(h('div', { class: cls }, line || ' '));
        }
        if (lines.length > 3000) box.appendChild(h('div', { class: 'h' }, '… ' + (lines.length - 3000) + ' more lines (download to view all)'));
        return box;
    }

    function patchBlock(task, p, interactive) {
        const block = h('div', { class: 'ccce-patch' });
        const bad = p.status === 'invalid' || p.status === 'rejected';
        block.appendChild(h('div', { class: 'ccce-patch-h' },
            h('span', { class: 'ccce-mono', style: { flex: '1', overflowWrap: 'anywhere' } }, p.path),
            h('span', { class: 'ccce-tag' }, p.action), p.revision ? h('span', { class: 'ccce-tag' }, 'rev ' + p.revision) : null,
            h('span', { class: 'ccce-add' }, '+' + (p.added || 0)), h('span', { class: 'ccce-del' }, '−' + (p.removed || 0)),
            p.status ? h('span', { class: 'ccce-tag' + (bad ? ' err' : p.status === 'accepted' ? ' ok' : '') }, p.status) : null));
        const body = h('div', { class: 'ccce-card-b' });
        if (p.reason) body.appendChild(h('div', { class: 'ccce-sub' }, p.reason));
        for (const r of p.risks || []) body.appendChild(h('span', { class: 'ccce-tag warn', style: { marginRight: '4px' } }, '⚠ ' + r));
        for (const i of p.issues || []) body.appendChild(h('div', { class: 'ccce-note err' }, 'Rejected by policy: ' + i));
        if (p.diff) body.appendChild(renderDiff(p.diff));
        else if (p.action === 'delete') body.appendChild(h('div', { class: 'ccce-note warn' }, 'Proposed deletion.'));
        else body.appendChild(h('pre', { class: 'ccce-diff' }, h('div', null, (p.content || '').slice(0, 200000))));
        const row = h('div', { class: 'ccce-row' },
            cbtn('Copy', async () => toast((await copyText(patchToText(p))) ? 'Copied' : 'Copy failed')),
            cbtn('Download', () => downloadBlob(patchToText(p), sanitizeFilename((p.path.split('/').pop() || 'change') + (p.diff ? '.patch' : '')), 'text/plain;charset=utf-8')));
        if (task && p.id && p.status === 'proposed') {
            row.appendChild(cbtn('Accept', () => setPatchStatus(task, p, 'accepted')));
            row.appendChild(cbtn('Reject', () => setPatchStatus(task, p, 'rejected')));
            if (interactive) row.appendChild(cbtn('Revise', () => {
                const why = prompt('What should change in ' + p.path + '?');
                if (why) sendStep(task, 'propose_patch', 'Revise the patch for ' + p.path + ': ' + why);
            }));
        }
        body.appendChild(row);
        block.appendChild(body);
        return block;
    }

    const OP_TITLE = Object.freeze({
        analyze_context: 'Context analysis', request_file_context: 'Files requested', create_plan: 'Plan',
        propose_patch: 'Proposed changes', review_patch: 'Patch review', suggest_tests: 'Suggested tests',
        report_validation: 'Validation report', prepare_handoff: 'GitHub handoff'
    });

    function buildCard(task, r, errors, anchor) {
        const latest = !!task && task.step === r.step_id;
        const interactive = latest && !pending && ACTIVE.includes(task.state);
        const card = h('div', { class: 'ccce-card', role: 'group', 'aria-label': 'Agent step ' + r.step_id });
        card.appendChild(h('div', { class: 'ccce-card-h' },
            h('b', null, OP_TITLE[r.operation] || 'Agent step'),
            h('span', { class: 'ccce-tag' + (r.status === 'ok' ? ' ok' : ' warn') }, r.status || '?'),
            h('span', null, (r.task_id || '?') + ' / ' + (r.step_id || '?')),
            task ? h('span', { class: 'ccce-tag' }, task.state.replace('_', ' ')) : h('span', { class: 'ccce-tag warn' }, 'not tracked in this browser')));
        const b = h('div', { class: 'ccce-card-b' });
        if (errors && errors.length) b.appendChild(h('div', { class: 'ccce-note warn' }, errors.join(' ')));
        if (r.summary) b.appendChild(h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, r.summary));

        if (r.plan && r.plan.length) {
            b.appendChild(h('div', { class: 'ccce-sub', style: { marginTop: '6px' } }, 'Plan (checkboxes are for your own tracking):'));
            b.appendChild(h('div', null, r.plan.map(step => h('label', null, h('input', { type: 'checkbox' }), h('span', null, step)))));
        }
        if (r.referenced_files && r.referenced_files.length) {
            b.appendChild(h('div', { class: 'ccce-sub', style: { marginTop: '6px' } }, 'Referenced files (suggested, not read by this script):'));
            b.appendChild(h('ul', null, r.referenced_files.map(f => h('li', { class: 'ccce-mono' }, f.path + (f.action ? ' — ' + f.action : '') + (f.reason ? ': ' + f.reason : '')))));
        }
        const patches = task ? task.patches.filter(p => p.stepId === r.step_id) : (r.proposed_patches || []).map(p => Object.assign({}, p, diffStats(p.diff)));
        for (const p of patches) b.appendChild(patchBlock(task, p, interactive));
        if (r.suggested_tests && r.suggested_tests.length) {
            b.appendChild(h('div', { class: 'ccce-sub', style: { marginTop: '6px' } }, 'Suggested tests (not run):'));
            b.appendChild(h('ul', null, r.suggested_tests.map(t => h('li', null, t.name, t.command ? h('span', { class: 'ccce-mono' }, ' — ' + t.command) : null))));
        }
        if (r.validation && r.validation.length) {
            b.appendChild(h('div', { class: 'ccce-sub', style: { marginTop: '6px' } }, 'Validation (model-reported, unverified):'));
            b.appendChild(h('ul', null, r.validation.map(v => h('li', null, h('span', { class: 'ccce-tag' + (v.result === 'pass' ? ' ok' : v.result === 'fail' ? ' err' : ' warn') }, v.result), ' ' + v.check))));
        }
        if (r.operation === 'prepare_handoff' && task) {
            const hd = task.handoff || {};
            b.appendChild(h('div', { class: 'ccce-sub', style: { marginTop: '6px' } }, 'Branch: ', h('span', { class: 'ccce-mono' }, suggestedBranch(task))));
            if (hd.pr_title) b.appendChild(h('div', { class: 'ccce-sub' }, 'PR title: ' + hd.pr_title));
            b.appendChild(h('pre', { class: 'ccce-diff' }, h('div', null, suggestedCommit(task))));
            const links = githubLinks(task);
            if (links) b.appendChild(h('div', { class: 'ccce-row' },
                h('a', { href: links.compare, target: '_blank', rel: 'noopener noreferrer' }, 'Compare / open PR on GitHub'), ' · ',
                h('a', { href: links.repo, target: '_blank', rel: 'noopener noreferrer' }, 'Repository')));
        }
        if (r.risks && r.risks.length) b.appendChild(h('div', { class: 'ccce-note warn' }, 'Risks: ' + r.risks.join('; ')));

        const row = h('div', { class: 'ccce-row' });
        if (task && interactive) {
            if (task.state === 'PLAN_REVIEW') {
                row.appendChild(cbtn('Approve plan', () => sendStep(task, 'propose_patch', 'The plan is approved. Propose the patch.'), true));
                row.appendChild(cbtn('Revise plan', () => { const why = prompt('What should change in the plan?'); if (why) sendStep(task, 'create_plan', 'Revise the plan: ' + why); }));
            }
            if (task.state === 'PATCH_REVIEW') {
                row.appendChild(cbtn('Request review', () => sendStep(task, 'review_patch', 'Review the proposed patches for correctness, edge cases, and risks.')));
                row.appendChild(cbtn('Continue to validation', () => sendStep(task, 'suggest_tests', 'Suggest tests that would validate the proposed changes.'), true));
            }
            if (task.state === 'VALIDATION_REVIEW') {
                row.appendChild(cbtn('Record evidence', () => openDrawer('agent')));
                row.appendChild(cbtn('Prepare handoff', () => sendStep(task, 'prepare_handoff', 'Prepare the GitHub handoff: branch, commit message, PR title and description.'), true));
            }
            if (task.state === 'HANDOFF') {
                const md = () => handoffMarkdown(task);
                row.appendChild(cbtn('Copy report', async () => toast((await copyText(md())) ? 'Handoff report copied' : 'Copy failed')));
                row.appendChild(cbtn('Download report', () => downloadBlob(md(), sanitizeFilename(task.id + '-handoff') + '.md', 'text/markdown;charset=utf-8')));
                row.appendChild(cbtn('Create PR (fill composer)', createPR));
                row.appendChild(cbtn('Mark completed', () => completeTask(task), true));
            }
            const next = r.next_action && r.next_action.operation;
            if (next && next !== 'none' && OPERATIONS.includes(next) && !cfg.autonomous) {
                row.appendChild(cbtn('Next: ' + OP_LABEL[next], () => sendStep(task, next, 'Continue: ' + (r.next_action.reason || next))));
            }
        } else if (task && latest && pending) {
            row.appendChild(h('span', { class: 'ccce-sub' }, 'Waiting for Arena…'));
        }
        if (anchor) row.appendChild(rawToggle(anchor));
        b.appendChild(row);
        card.appendChild(b);
        return card;
    }

    // ══════════════════════════════════════════════════════════════════
    // DRAWER STATE
    // ══════════════════════════════════════════════════════════════════

    const isMobile = () => (window.innerWidth || 1024) <= 760;

    function openDrawer(tab) {
        if (tab) ui.tab = tab;
        ui.open = true;
        createDrawer();
        ui.drawer.classList.add('cc-open');
        ui.toggle.classList.add('cc-open');
        ui.toggle.textContent = '‹';
        ui.toggle.setAttribute('aria-expanded', 'true');
        renderUI(true);
    }

    function closeDrawer() {
        ui.open = false;
        if (ui.drawer) ui.drawer.classList.remove('cc-open');
        if (ui.toggle) { ui.toggle.classList.remove('cc-open'); ui.toggle.textContent = '›'; ui.toggle.setAttribute('aria-expanded', 'false'); }
    }

    function toggleDrawer() { if (ui.open) closeDrawer(); else openDrawer(); }

    function selectTask(id) {
        if (!session.tasks.some(t => t.id === id)) return;
        session.activeId = id;
        saveSessions();
        renderUI(true);
    }

    function onKeyDown(event) {
        if ((event.ctrlKey || event.metaKey) && event.key === '.') { event.preventDefault(); toggleDrawer(); return; }
        if (event.key === 'Escape' && ui.open) closeDrawer();
    }

    // ══════════════════════════════════════════════════════════════════
    // UI HELPERS
    // ══════════════════════════════════════════════════════════════════

    const btn = (label, onclick, primary = false, extra = {}) =>
        h('button', Object.assign({ type: 'button', class: 'ccce-btn' + (primary ? ' primary' : ''), onclick }, extra), label);

    const section = (parent, title) => { parent.appendChild(h('div', { class: 'cc-h' }, title)); return parent; };

    function switchRow(label, hint, value, onChange) {
        const sw = h('button', { type: 'button', class: 'cc-switch', role: 'switch', 'aria-checked': String(!!value), 'aria-label': label });
        sw.addEventListener('click', () => {
            const next = sw.getAttribute('aria-checked') !== 'true';
            const result = onChange(next);
            sw.setAttribute('aria-checked', String(result === false ? !next : next));
        });
        return h('div', { class: 'cc-set' }, h('div', null, label, hint ? h('small', null, hint) : null), sw);
    }

    function inputRow(label, hint, value, type, onCommit, attrs = {}) {
        const input = h('input', Object.assign({ type, value: String(value ?? ''), 'aria-label': label }, attrs));
        input.addEventListener('change', () => {
            if (onCommit(input.value) === false) { input.value = String(value ?? ''); toast('Invalid value for ' + label, true); }
        });
        return h('div', { class: 'cc-set' }, h('div', null, label, hint ? h('small', null, hint) : null), input);
    }

    function selectRow(label, hint, value, options, onChange) {
        const sel = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, selected: v === value ? true : null }, t)));
        sel.addEventListener('change', () => onChange(sel.value));
        return h('div', { class: 'cc-set' }, h('div', null, label, hint ? h('small', null, hint) : null), sel);
    }

    const kv = (k, v) => h('div', { class: 'cc-kv' }, h('b', null, k), h('span', null, v));

    function stateDotClass(task) {
        if (!task) return 'ccce-dot';
        if (task.state === 'ERROR') return 'ccce-dot err';
        if (task.state === 'PAUSED') return 'ccce-dot warn';
        if (task.state === 'COMPLETED') return 'ccce-dot ok';
        if (ACTIVE.includes(task.state)) return 'ccce-dot on';
        return 'ccce-dot';
    }

    // Agent toggle + state pill, placed beside Arena's send button.
    function ensureAgentControl() {
        if (!ui.agentBtn) {
            ui.agentBtn = h('span', { class: 'ccce-ctls', id: 'cc-agent-controls', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } });
            ui.agentToggle = h('button', { type: 'button', class: 'ccce-ctl', id: 'cc-agent-toggle', title: 'Agent mode: wrap sends as planned tasks (or start a message with /task)' });
            ui.agentToggle.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                cfg.agentMode = !cfg.agentMode; saveConfig(); renderAgentControl();
                toast(cfg.agentMode ? 'Agent mode on: your next send becomes a planned task step.' : 'Agent mode off: sends are normal Arena messages.');
            });
            ui.pill = h('button', { type: 'button', class: 'ccce-ctl', id: 'cc-agent-pill', title: 'Task status — open the Agent tab' });
            ui.pill.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openDrawer('agent'); });
            ui.agentBtn.append(ui.pill, ui.agentToggle);
        }
        const composer = findComposer();
        const send = composer && findSendButton(composer);
        if (send && send.parentElement) {
            ui.agentBtn.classList.remove('ccce-floating');
            ui.agentBtn.style.position = '';
            if (ui.agentBtn.nextSibling !== send || ui.agentBtn.parentElement !== send.parentElement) send.parentElement.insertBefore(ui.agentBtn, send);
        } else if (!ui.agentBtn.isConnected || ui.agentBtn.parentElement !== document.body) {
            ui.agentBtn.classList.add('ccce-floating');
            Object.assign(ui.agentBtn.style, { position: 'fixed', zIndex: '2147483640', right: '12px', bottom: '12px' });
            (document.body || document.documentElement).appendChild(ui.agentBtn);
        }
        renderAgentControl();
    }

    function renderAgentControl() {
        if (!ui.agentToggle) return;
        ui.agentToggle.setAttribute('aria-pressed', String(!!cfg.agentMode));
        ui.agentToggle.replaceChildren(h('span', { class: 'ccce-dot' + (cfg.agentMode ? ' on' : '') }), cfg.agentMode ? 'Agent on' : 'Agent');
        const task = activeTask();
        const label = task ? task.state.replace('_', ' ') + (pending && pending.taskId === task.id ? ' …' : '') : 'No task';
        ui.pill.replaceChildren(h('span', { class: stateDotClass(task) }), label);
        ui.pill.setAttribute('aria-label', 'Task status: ' + label + '. Open Agent tab.');
    }

    // ══════════════════════════════════════════════════════════════════
    // RENDER TABS
    // ══════════════════════════════════════════════════════════════════

    function renderAgentTab(c) {
        const task = activeTask();
        c.appendChild(switchRow('Agent mode', 'Wrap sends from Arena\'s composer as task steps. Or start a message with /task, /plan, /patch, /review, /tests, /validate, /handoff.', cfg.agentMode, v => { cfg.agentMode = v; saveConfig(); renderAgentControl(); }));
        section(c, 'Task');
        if (!task) c.appendChild(h('div', { class: 'cc-missing' }, 'No active task. Type "/task <description>" in Arena\'s composer, or turn on Agent mode and send.'));
        else {
            c.appendChild(h('div', { style: { fontWeight: '600' } }, task.title));
            c.appendChild(kv('ID', task.id));
            c.appendChild(h('div', { class: 'cc-kv' }, h('b', null, 'State'), h('span', { class: stateDotClass(task), style: { marginTop: '5px' } }), h('span', null, task.state + (pending && pending.taskId === task.id ? ' — waiting for Arena (' + pending.stepId + ')' : ''))));
            c.appendChild(kv('Step', (task.step || '—') + ' · ' + task.stepCount + '/' + POLICY.maxSteps + (cfg.autonomous ? ' · auto ' + task.autoSteps + '/' + cfg.maxAutoSteps : '')));
            const lastErr = [...task.events].reverse().find(e => e.kind === 'error');
            if (task.state === 'ERROR' && lastErr) c.appendChild(h('div', { class: 'ccce-note err' }, lastErr.text));
            const row = h('div', { class: 'cc-row' });
            if (task.state === 'PAUSED') row.appendChild(btn('Resume', () => resumeTask(task)));
            else if (ACTIVE.includes(task.state) || task.state === 'ERROR') row.appendChild(btn('Pause', () => pauseTask(task)));
            if (task.state === 'ERROR') row.appendChild(btn('Retry', () => retryTask(task), false, { disabled: !task.lastRequest || task.retries >= cfg.maxRetries ? true : null }));
            if (!['COMPLETED', 'CANCELLED'].includes(task.state)) row.appendChild(btn('Cancel', () => { if (confirm('Cancel this task?')) cancelTask(task); }));
            if (task.state === 'HANDOFF') row.appendChild(btn('Mark completed', () => completeTask(task), true));
            c.appendChild(row);
        }
        c.appendChild(h('div', { class: 'cc-row' }, btn('New task', () => { session.activeId = null; saveSessions(); renderUI(true); toast('Type "/task <description>" in Arena\'s composer.'); })));

        if (session.tasks.length) {
            section(c, 'Recent tasks');
            session.tasks.slice(0, 10).forEach(t => c.appendChild(h('button', { type: 'button', class: 'cc-item' + (task && t.id === task.id ? ' active' : ''), onclick: () => selectTask(t.id) },
                h('span', { class: stateDotClass(t) }), h('span', { class: 't' }, t.title), h('span', { class: 'ccce-sub' }, t.state.toLowerCase().replace('_', ' ')))));
        }
        if (!task) return;

        section(c, 'Repository');
        const repoIn = h('input', { type: 'text', value: task.repo || '', placeholder: 'owner/repo or GitHub URL', 'aria-label': 'Repository', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
        const brIn = h('input', { type: 'text', value: task.branch || '', placeholder: 'branch (optional)', 'aria-label': 'Branch', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
        repoIn.addEventListener('change', () => {
            const v = repoIn.value.trim(); const parsed = parseRepo(v);
            if (v && !parsed) { toast('Not a valid owner/repo or GitHub URL.', true); repoIn.value = task.repo; return; }
            task.repo = parsed ? parsed.full : '';
            if (parsed && parsed.branch && !task.branch) task.branch = parsed.branch;
            logEvent(task, 'repo', 'Repository set to ' + (task.repo || '(none)')); saveSessions(); renderUI(true);
        });
        brIn.addEventListener('change', () => {
            const v = brIn.value.trim();
            if (!validBranch(v)) { toast('Invalid branch name.', true); brIn.value = task.branch; return; }
            task.branch = v; logEvent(task, 'repo', 'Branch set to ' + (v || '(none)')); saveSessions(); renderUI(true);
        });
        c.appendChild(h('label', { class: 'cc-field' }, 'Repository', repoIn));
        c.appendChild(h('label', { class: 'cc-field' }, 'Branch', brIn));
        const links = githubLinks(task);
        if (links) c.appendChild(h('div', { class: 'cc-row' }, h('a', { href: links.repo, target: '_blank', rel: 'noopener noreferrer' }, 'Repository'), h('a', { href: links.pulls, target: '_blank', rel: 'noopener noreferrer' }, 'Pull requests'), h('a', { href: links.compare, target: '_blank', rel: 'noopener noreferrer' }, 'Compare')));
        c.appendChild(h('div', { class: 'cc-missing' }, 'Repository contents are never fetched by this script.'));

        section(c, 'Context sources');
        if (!task.context.length) c.appendChild(h('div', { class: 'cc-missing' }, 'No context provided — Arena only sees what is in the conversation.'));
        task.context.forEach(ci => c.appendChild(h('div', { class: 'cc-item', title: ci.text.slice(0, 400) },
            h('span', { class: 't' }, ci.label), h('span', { class: 'ccce-tag' }, CONTEXT_SOURCES[ci.source]),
            h('button', { type: 'button', class: 'cc-x', 'aria-label': 'Remove ' + ci.label, onclick: () => { task.context = task.context.filter(x => x !== ci); logEvent(task, 'context', 'Removed context ' + ci.label); saveSessions(); renderUI(true); } }, '×'))));
        const src = h('select', { 'aria-label': 'Context source' }, ['user', 'paste', 'page'].map(k => h('option', { value: k }, CONTEXT_SOURCES[k])));
        const label = h('input', { type: 'text', placeholder: 'Label or file path', 'aria-label': 'Context label' });
        const text = h('textarea', { placeholder: 'Paste text or file contents (sent with the next agent step)', 'aria-label': 'Context text' });
        c.appendChild(h('details', null, h('summary', { class: 'ccce-sub' }, 'Add context…'), h('div', { class: 'cc-field' }, src, label, text, btn('Add context', () => {
            let body = text.value;
            if (src.value === 'page') body = (body ? body + '\n' : '') + 'Page: ' + location.href + '\nTitle: ' + document.title;
            const p = label.value.trim();
            if (src.value === 'paste' && p && POLICY.checkPath(p)) { toast('Path rejected: ' + POLICY.checkPath(p), true); return; }
            if (addContext(task, src.value, p || CONTEXT_SOURCES[src.value], body)) renderUI(true); else toast('Nothing to add.', true);
        }))));

        section(c, 'Files & changes');
        if (!task.files.length) c.appendChild(h('div', { class: 'cc-missing' }, 'No files referenced or proposed.'));
        task.files.slice(-25).forEach(f => c.appendChild(h('div', { class: 'cc-kv', title: f.reason || '' }, h('b', { class: 'ccce-mono' }, f.action || 'ref'), h('span', { class: 'ccce-mono' }, f.path + ' — ' + f.status))));
        if (task.patches.length) c.appendChild(h('div', { class: 'cc-row' }, btn('Export proposals', () => exportPatches(task))));

        section(c, 'Validation evidence');
        if (!task.validation.length) c.appendChild(h('div', { class: 'cc-missing' }, 'No validation evidence. Suggested tests: ' + task.tests.length + ' (not run).'));
        task.validation.slice(-15).forEach(v => c.appendChild(h('div', { class: 'cc-kv' }, h('b', null, v.result), h('span', null, v.check + ' — ' + v.source))));
        const check = h('input', { type: 'text', placeholder: 'What you checked (e.g. npm test)', 'aria-label': 'Check' });
        const result = h('select', { 'aria-label': 'Result' }, ['pass', 'fail', 'unknown'].map(x => h('option', { value: x }, x)));
        const evidence = h('textarea', { placeholder: 'Output you observed', 'aria-label': 'Evidence' });
        c.appendChild(h('details', null, h('summary', { class: 'ccce-sub' }, 'Record evidence you observed…'), h('div', { class: 'cc-field' }, check, result, evidence, btn('Add user-confirmed evidence', () => {
            if (!check.value.trim()) { toast('Enter what was checked.', true); return; }
            task.validation.push({ check: check.value.trim().slice(0, 300), result: result.value, evidence: evidence.value.slice(0, 20000), source: 'User-confirmed external validation', stepId: task.step });
            addContext(task, 'validation', check.value.trim(), result.value.toUpperCase() + '\n' + evidence.value);
            renderUI(true);
        }))));

        section(c, 'Handoff');
        c.appendChild(h('div', { class: 'cc-row' },
            btn('Copy report', async () => toast((await copyText(handoffMarkdown(task))) ? 'Handoff report copied' : 'Copy failed')),
            btn('Download report', () => downloadBlob(handoffMarkdown(task), sanitizeFilename(task.id + '-handoff') + '.md', 'text/markdown;charset=utf-8'))));

        section(c, 'History');
        [...task.events].reverse().slice(0, 40).forEach(e => c.appendChild(h('div', { class: 'cc-kv' }, h('b', null, new Date(e.at).toLocaleTimeString()), h('span', null, '[' + e.kind + '] ' + (e.step ? e.step + ' · ' : '') + e.text))));
    }

    function renderActionsTab(c) {
        prState = detectPRState();
        section(c, 'GitHub (instructions only)');
        c.appendChild(h('div', { class: 'cc-row' },
            btn('Create PR', createPR, false, { id: 'cc-btn-create-pr', disabled: prState === 'open' || prState === 'merged' ? true : null }),
            btn('Merge PR', mergePR, false, { id: 'cc-btn-merge-pr', disabled: prState !== 'open' ? true : null })));
        c.appendChild(h('div', { class: 'cc-missing' }, 'These fill Arena\'s composer for you to review and send. PR state from conversation: ' + prState + '.'));
        section(c, 'Session');
        c.appendChild(h('div', { class: 'cc-row' }, btn('Clear chat', clearChat)));
        c.appendChild(switchRow('Hide Composer', null, cfg.hideComposer, v => toggleComposerVisibility(v)));
        section(c, 'Export');
        c.appendChild(h('div', { class: 'cc-row' }, btn('Markdown', exportChatMarkdown), btn('HTML', exportChatHTML)));
        section(c, 'Debug');
        c.appendChild(h('div', { class: 'cc-row' }, btn('Run diagnostics', runDiagnostics)));
    }

    function renderStatsTab(c) {
        const s = countStats();
        section(c, 'Context usage');
        c.appendChild(h('div', { id: 'cc-context-main' }, formatCompact(s.totalTokens) + ' / ' + formatCompact(s.context) + ' (' + s.percentage.toFixed(1) + '%)'));
        c.appendChild(h('div', { class: 'cc-bar' }, h('i', { style: { width: s.percentage + '%', background: s.percentage > 90 ? 'var(--ce-error)' : s.percentage >= 70 ? 'var(--ce-warning)' : 'var(--ce-success)' } })));
        const grid = (title, entries) => { section(c, title); c.appendChild(h('div', { class: 'cc-grid' }, entries.map(([l, v]) => h('div', null, h('b', null, v), h('span', null, l))))); };
        grid('Messages', [['Total', formatNumber(s.total)], ['Visible', formatNumber(s.visible)], ['Hidden', formatNumber(s.hidden)]]);
        grid('Tokens (est.)', [['Total', formatCompact(s.totalTokens)], ['Visible', formatCompact(s.visibleTokens)], ['Hidden', formatCompact(s.hiddenTokens)]]);
        grid('Content', [['Chars', formatNumber(s.totalChars)], ['Code', formatNumber(s.codeBlocks)], ['Thinking', formatNumber(s.thinkingBlocks)]]);
        c.appendChild(h('div', { class: 'cc-missing', style: { marginTop: '8px' } }, 'Token counts are estimates (~4 chars/token).'));
    }

    function renderSettingsTab(c) {
        const set = (key, value) => { cfg[key] = value; saveConfig(); updateDynamicCSS(); schedule(); };
        const numberRow = (label, hint, key, min, max) => inputRow(label, hint, cfg[key], 'number', v => {
            const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) return false; set(key, n); return true; }, { min, max });
        section(c, 'Appearance');
        c.appendChild(selectRow('Theme', 'Inverse: Arena light → dark drawer/cards, Arena dark → light', cfg.themeMode,
            [['inverse', 'Inverse of Arena (default)'], ['match', 'Match Arena'], ['dark', 'Always dark'], ['light', 'Always light']], v => { set('themeMode', v); renderUI(true); }));
        c.appendChild(switchRow('Compact Mode', 'Arena composer only', cfg.compactMode, v => { set('compactMode', v); markCompactComposer(); }));
        c.appendChild(numberRow('Font size', '0 = Arena default (10–24)', 'fontSize', 0, 24));
        c.appendChild(switchRow('Text mode', 'Code blocks as one-line descriptions', cfg.textMode, v => { set('textMode', v); applyTextMode(); }));
        c.appendChild(switchRow('Eye toggle', 'Hide Arena composer', cfg.eyeToggle, () => { toggleEye(); return cfg.eyeToggle; }));
        section(c, 'Virtualization');
        c.appendChild(numberRow('Visible messages', '1–500', 'keepMessages', 1, 500));
        c.appendChild(switchRow('Virtualize messages', null, cfg.virtualize, v => set('virtualize', v)));
        c.appendChild(switchRow('Flatten Shiki code', null, cfg.flattenCode, v => set('flattenCode', v)));
        section(c, 'Thinking');
        c.appendChild(selectRow('Thinking blocks', null, cfg.thinkingMode, [['collapse', 'Collapse older'], ['expand', 'Keep expanded'], ['hide', 'Hide']], setThinkingMode));
        section(c, 'Scrolling');
        c.appendChild(switchRow('Auto-scroll', null, cfg.autoScroll, v => set('autoScroll', v)));
        c.appendChild(switchRow('Smooth scroll', null, cfg.smoothScroll, v => set('smoothScroll', v)));
        c.appendChild(numberRow('Scroll threshold (px)', null, 'scrollThreshold', 0, 2000));
        section(c, 'Agent');
        c.appendChild(switchRow('Autonomous follow-ups', 'Bounded; prompts only — never commits, pushes, PRs, or merges', cfg.autonomous, v => set('autonomous', v)));
        c.appendChild(numberRow('Max autonomous steps', '1–' + POLICY.maxAutoSteps, 'maxAutoSteps', 1, POLICY.maxAutoSteps));
        c.appendChild(numberRow('Max retries', '0–5', 'maxRetries', 0, 5));
        c.appendChild(numberRow('Submit verification (ms)', null, 'submitVerifyMs', 1000, 30000));
        section(c, 'Arena');
        c.appendChild(inputRow('Composer selector', 'Optional CSS override', cfg.composerSelector, 'text', v => {
            if (v) { try { document.querySelector(v); } catch (_) { return false; } }
            set('composerSelector', v.trim()); return true;
        }));
        c.appendChild(switchRow('Auto-click "page updated"', null, cfg.autoClickPageUpdated, v => set('autoClickPageUpdated', v)));
        c.appendChild(switchRow('Auto-click Continue after merge', null, cfg.autoClickContinue, v => set('autoClickContinue', v)));
        c.appendChild(switchRow('Nav export button', null, cfg.showExport, v => { set('showExport', v); refreshNavExportButton(); }));
        c.appendChild(numberRow('Context window (tokens)', null, 'contextWindow', 1000, 10000000));
        section(c, 'Status');
        const found = orderedMessages(currentLog);
        c.appendChild(kv('Messages', found.messages.length + ' · ' + hiddenCount + ' hidden · ' + (found.reversed ? 'reversed' : 'normal')));
        c.appendChild(kv('Composer', findComposer() ? 'Found' : 'Not found'));
        c.appendChild(kv('Version', VERSION));
        c.appendChild(h('div', { class: 'cc-row' }, btn('Reset all settings', () => {
            if (!confirm('Reset all Coding Edition settings to defaults?')) return;
            cfg = Object.assign({}, DEFAULTS); prState = 'none'; saveConfig(); restoreComposer(); restoreEyeToggle(); updateDynamicCSS(); renderUI(true); toast('Settings reset to defaults.');
        })));
    }

    const TABS = [['agent', 'Agent'], ['actions', 'Actions'], ['statistics', 'Statistics'], ['settings', 'Settings']];
    let lastDrawerSig = '';

    function renderUI(force = false) {
        ensureAgentControl();
        if (!ui.drawer || !ui.drawer.isConnected || !ui.open) return;
        const task = activeTask();
        const sig = [ui.tab, task ? task.id + task.updated + task.state : '-', pending ? pending.stepId : '', session.tasks.length, cfg.thinkingMode, prState].join('|');
        if (!force && sig === lastDrawerSig) return;
        // Don't wipe a field the user is typing in.
        if (!force && ui.drawer.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
        lastDrawerSig = sig;
        qa('.cc-tab', ui.drawer).forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === ui.tab)));
        const c = q('.cc-content', ui.drawer);
        const scroll = c.scrollTop;
        c.replaceChildren();
        ({ agent: renderAgentTab, actions: renderActionsTab, statistics: renderStatsTab, settings: renderSettingsTab }[ui.tab] || renderAgentTab)(c);
        c.scrollTop = scroll;
        if (ui.eye) ui.eye.setAttribute('aria-pressed', String(!!cfg.eyeToggle));
    }

    // ══════════════════════════════════════════════════════════════════
    // CREATE APPLICATION SHELL (drawer + toggle; nothing covers Arena)
    // ══════════════════════════════════════════════════════════════════

    function createDrawer() {
        if (!document.documentElement) return;
        if (!ui.drawer || !ui.drawer.isConnected) {
            ui.eye = h('button', { type: 'button', class: 'cc-x', id: 'cc-eye-toggle', 'aria-label': 'Eye toggle: hide Arena composer', title: 'Eye toggle', 'aria-pressed': String(!!cfg.eyeToggle), onclick: toggleEye }, '👁');
            ui.drawer = h('aside', { id: 'cc-drawer', 'aria-label': 'Arena.ai Coding Edition' },
                h('div', { class: 'cc-head' }, h('div', { class: 'cc-brand' }, 'Coding Edition', h('small', null, 'v' + VERSION + ' · Arena.ai Agent Mode')), ui.eye,
                    h('button', { type: 'button', class: 'cc-x', 'aria-label': 'Close panel', onclick: closeDrawer }, '×')),
                h('div', { class: 'cc-tabs', role: 'tablist' }, TABS.map(([k, label]) => h('button', { type: 'button', class: 'cc-tab', role: 'tab', 'data-tab': k, 'aria-selected': String(ui.tab === k),
                    onclick: () => { ui.tab = k; renderUI(true); } }, label))),
                h('div', { class: 'cc-content', role: 'tabpanel' }));
            document.documentElement.appendChild(ui.drawer);
            if (ui.open) ui.drawer.classList.add('cc-open');
        }
        if (!ui.toggle || !ui.toggle.isConnected) {
            ui.toggle = h('button', { type: 'button', id: 'cc-toggle', title: 'Arena.ai Coding Edition (Ctrl/⌘+.)', 'aria-label': 'Open Coding Edition panel', 'aria-expanded': String(ui.open), onclick: toggleDrawer }, ui.open ? '‹' : '›');
            if (ui.open) ui.toggle.classList.add('cc-open');
            document.documentElement.appendChild(ui.toggle);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // NAV BAR EXPORT BUTTON (v3.4.3; now exports Markdown, Shift-click HTML)
    // ══════════════════════════════════════════════════════════════════

    function diffViewerControl() {
        return q('[aria-label*="diff" i]:not(#cc-nav-export), [title*="diff" i]:not(#cc-nav-export), button[class*="diff" i], [data-testid*="diff" i]');
    }

    function refreshNavExportButton() {
        if (!cfg.showExport) { navExportButton?.remove(); navExportButton = null; return; }
        const diffViewer = diffViewerControl();
        if (!navExportButton) {
            navExportButton = h('button', { type: 'button', id: 'cc-nav-export', title: 'Export conversation (Markdown; Shift-click for HTML)', 'aria-label': 'Export conversation' }, 'Export');
            navExportButton.addEventListener('click', e => (e.shiftKey ? exportChatHTML() : exportChatMarkdown()));
        }
        // Only placed inline next to Arena's diff control; without one the
        // export lives in the workspace menu (no floating fallback clutter).
        if (diffViewer && diffViewer.parentElement) {
            if (navExportButton.nextSibling !== diffViewer) diffViewer.parentElement.insertBefore(navExportButton, diffViewer);
        } else if (navExportButton.isConnected) navExportButton.remove();
    }

    // ══════════════════════════════════════════════════════════════════
    // SCHEDULE + INIT
    // ══════════════════════════════════════════════════════════════════

    function schedule() {
        clearTimeout(scheduleTimer);
        scheduleTimer = setTimeout(runSchedule, 200);
    }

    function runSchedule() {
        if (!document.documentElement) return;
        try {
            createDrawer();
            refreshNavExportButton();
            updateDynamicCSS();

            const log = findLog();
            if (log !== currentLog) {
                if (currentLog) teardownAutoScroll();
                currentLog = log;
                if (log) {
                    rebuildAutoScroll(log);
                    lastMessageCount = -1; lastCollapseCount = -1; lastExpandCount = -1; lastVirtualSignature = '';
                }
            }
            if (currentLog) {
                const count = getMessages(currentLog).length;
                const increased = count > lastMessageCount;
                lastMessageCount = count;
                virtualize();
                decorateCodeBlocks();
                applyTextMode();
                dispatchThinkingMode(false);
                if (cfg.autoScroll && increased) {
                    const scroller = scrollElement(currentLog);
                    if (scroller && isNearBottom(scroller)) scrollToBottom(scroller);
                }
            }
            if (cfg.hideComposer && !q('[data-cc-composer-hide="1"]')) applyComposerHide();
            if (cfg.eyeToggle) applyEyeToggle();
            markCompactComposer();
            updateJumpButton();
            watchPageUpdatedBanner();
            prState = detectPRState();
            clickContinueButton();
            pollResponse();
            enhanceMessages();
            renderUI();
            if (ui.open && ui.tab === 'statistics') renderUI(true);
            // Keep polling while a response is streaming/stabilizing.
            if (pending) { clearTimeout(scheduleTimer); scheduleTimer = setTimeout(runSchedule, 700); }
        } catch (error) {
            console.error('[CC] Scheduler error:', error);
        }
    }

    // One document-level observer (v3.4.3 attached two: body + documentElement).
    function startObservers() {
        if (mainObserver) mainObserver.disconnect();
        mainObserver = new MutationObserver(mutations => {
            for (const m of mutations) {
                const t = m.target;
                if (t.closest && t.closest('#cc-drawer,.cc-code-buttons,.ccce-card,.ccce-ctls,#cc-toast')) continue;
                schedule();
                return;
            }
        });
        mainObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function watchdog() {
        if (!ui.drawer || !ui.drawer.isConnected || !ui.toggle || !ui.toggle.isConnected) createDrawer();
        if (!mainObserver) startObservers();
        if (currentLog && !currentLog.isConnected) schedule();
        if (document.documentElement.dataset.ccceTheme !== resolvedTheme()) updateDynamicCSS();
        if (cfg.showExport && !q('#cc-nav-export')) refreshNavExportButton();
        if (cfg.hideComposer && !q('[data-cc-composer-hide="1"]')) applyComposerHide();
        if (!ui.agentBtn || !ui.agentBtn.isConnected) ensureAgentControl();
    }

    function initialize() {
        if (initialized) return;
        if (!document.documentElement || !document.body) { setTimeout(initialize, 50); return; }
        initialized = true;
        injectStyle('cc-page', PAGE_CSS);
        injectStyle('cc-ui', UI_CSS);
        injectStyle('cc-perf', PERF_CSS);
        updateDynamicCSS();
        createDrawer();
        startObservers();
        if (!keyListenerBound) {
            document.addEventListener('keydown', onKeyDown, true);
            window.addEventListener('keydown', interceptSend, true);
            window.addEventListener('click', interceptSend, true);
            keyListenerBound = true;
        }
        runSchedule();
        clearInterval(watchdogTimer);
        watchdogTimer = setInterval(watchdog, 3000);
        clearInterval(statsTimer);
        statsTimer = setInterval(() => { if (ui.open && ui.tab === 'statistics') renderUI(true); }, 1000);
        console.info('[CC] Arena.ai Coding Edition v' + VERSION + ' initialized.');
    }

    // Delayed initialization (v3.4.3): wait for Arena's log, max 6 s.
    function waitForLog() {
        if (findLog()) { initialize(); return; }
        const observer = new MutationObserver(() => { if (findLog()) { observer.disconnect(); initialize(); } });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); initialize(); }, 6000);
    }

    // Test/diagnostic hook (read-only surface; no eval of page content).
    window.__ccCodingEditionAPI = Object.freeze({
        version: VERSION, runSchedule, runDiagnostics, submitToArena, sendStep, newTask, activeTask, parseTrigger,
        canTransition, transition, extractProtocolObjects, validateResponse, parseRepo, POLICY, STATES, TRANSITIONS,
        exportChatMarkdown, messageToMarkdown, resolvedTheme, openDrawer, closeDrawer, ui, session,
        get pending() { return pending; }, get observers() { return { main: !!mainObserver, log: !!activeLogObserver }; }
    });

    try {
        waitForLog();
    } catch (error) {
        console.error('[CC] Fatal initialization error:', error);
        try {
            const b = document.createElement('button');
            b.id = 'cc-toggle';
            b.type = 'button';
            b.textContent = 'CC';
            b.title = 'Arena.ai Coding Edition failed to start — see console';
            b.style.cssText = 'position:fixed;top:50%;left:0;z-index:2147483647;background:#D97757;color:#fff;border:0;border-radius:0 6px 6px 0;padding:8px 10px;font:13px system-ui,sans-serif';
            document.documentElement.appendChild(b);
        } catch (_) { /* nothing else to do */ }
    }

})();
