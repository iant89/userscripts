══════════════════════════════════════════════════════════════════
 * Arena.ai | Coding Edition
 * Version: 3.4.0
 * ══════════════════════════════════════════════════════════════════
 *
 * Performance, thinking-block management, scrolling, code export,
 * HTML conversation export, statistics, and a themed control drawer.
 *
 * No external dependencies. Designed for React/Next.js SPA pages.
 *
 * ══════════════════════════════════════════════════════════════════ */

// ==UserScript==
// @name         Arena.ai | Coding Edition
// @namespace    https://arena.ai/
// @version      3.4.0
// @description  Performance and productivity enhancements for Arena.ai coding chats.
// @match        *://*.arena.ai/*
// @match        *://*.canaryarena.ai/*
// @match        *://chat.lmsys.org/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    'use strict';

    if (window.__ccCodingEdition340) return;
    window.__ccCodingEdition340 = true;

    // ══════════════════════════════════════════════════════════════════
    // CONFIG
    // ══════════════════════════════════════════════════════════════════

    const STORAGE_KEY = 'ccCodingEdition';

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

        textMode: false
    });

    let cfg = Object.assign(
        {},
        DEFAULTS,
        (() => {
            try {
                const value = GM_getValue(STORAGE_KEY, {});
                return value && typeof value === 'object' ? value : {};
            } catch (error) {
                console.warn('[CC] Could not read configuration:', error);
                return {};
            }
        })()
    );

    // Pull-request state tracking: 'none' | 'open' | 'merged'
    let prState = 'none';

    const saveConfig = () => {
        try {
            GM_setValue(STORAGE_KEY, JSON.stringify(cfg));
        } catch (error) {
            console.warn('[CC] Could not persist configuration:', error);
        }
    };

    let drawerOpen = false;
    let activeTab = 'settings';
    let mainObserver = null;
    let bodyObserver = null;
    let activeLogObserver = null;
    let currentLog = null;
    let scrollCleanup = null;
    let scheduleTimer = null;
    let maintenanceTimer = null;
    let statsTimer = null;
    let watchdogTimer = null;
    let rafPending = false;

    let lastVirtualSignature = '';
    let warnedStructure = false;
    let lastMessageCount = -1;
    let lastCollapseCount = -1;
    let lastExpandCount = -1;

    let messagesCache = [];
    let hiddenCount = 0;
    let reversedOrder = false;
    let composerCache = null;
    let composerHideWrapper = null;
    let jumpButton = null;
    let drawer = null;
    let exportButton = null;
    let toggleButton = null;
    let outsideListenerTimer = null;
    let outsideListener = null;
    let toastTimer = null;
    let snippetCounter = 0;
    let statisticsLastRefresh = 0;

    // Settings modal
    let settingsModal = null;
    let activeSettingsTab = 'general';

    // Nav bar export button
    let navExportButton = null;

    // Eye toggle button (side menu / drawer bar)
    let eyeButton = null;

    // Page-updated banner click guard
    let lastClickedBanner = null;

// Auto-click Continue button guard (timestamp of last click)
let lastContinueClick = 0;

    const q = (selector, root = document) => root.querySelector(selector);
    const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    // ══════════════════════════════════════════════════════════════════
    // THEME
    // ══════════════════════════════════════════════════════════════════

    const THEME_CSS = `
        :root, html {
            --cc-bg: #ffffff;
            --cc-surface: #fafafa;
            --cc-surface-2: #f4f4f5;
            --cc-text: #18181b;
            --cc-text-muted: #71717a;
            --cc-text-subtle: #a1a1aa;
            --cc-border: #e4e4e7;
            --cc-border-faint: #f0f0f1;
            --cc-hover: #f4f4f5;
            --cc-accent: #f97316;
            --cc-accent-hover: #ea580c;
            --cc-accent-bg: #fff7ed;
            --cc-accent-border: #fed7aa;
            --cc-success: #16a34a;
            --cc-danger: #dc2626;
            --cc-shadow: 0 1px 3px rgba(0,0,0,.12);
            --cc-shadow-lg: 0 12px 36px rgba(0,0,0,.18);
        }

        html.dark, html[data-theme="dark"] {
            --cc-bg: #09090b;
            --cc-surface: #18181b;
            --cc-surface-2: #27272a;
            --cc-text: #fafafa;
            --cc-text-muted: #a1a1aa;
            --cc-text-subtle: #71717a;
            --cc-border: #3f3f46;
            --cc-border-faint: #27272a;
            --cc-hover: #27272a;
            --cc-accent: #fb923c;
            --cc-accent-hover: #fdba74;
            --cc-accent-bg: #2b1c12;
            --cc-accent-border: #7c2d12;
            --cc-success: #4ade80;
            --cc-danger: #f87171;
            --cc-shadow: 0 1px 3px rgba(0,0,0,.35);
            --cc-shadow-lg: 0 12px 36px rgba(0,0,0,.5);
        }

        #cc-drawer, #cc-drawer *, #cc-toggle,
        #cc-export, #cc-jump, #cc-toast,
        #cc-settings-modal, #cc-settings-modal *,
        #cc-eye-toggle, #cc-nav-export {
            box-sizing: border-box;
        }

        /* ═══ Drawer ═══ */

        #cc-drawer {
            position: fixed;
            z-index: 2147483645;
            inset: 0 auto 0 0;
            width: 320px;
            max-width: calc(100vw - 44px);
            height: 100dvh;
            display: flex;
            flex-direction: column;
            color: var(--cc-text);
            background: var(--cc-bg);
            border-right: 1px solid var(--cc-border);
            box-shadow: var(--cc-shadow-lg);
            transform: translateX(-100%);
            transition: transform .24s cubic-bezier(.4,0,.2,1);
            font: 13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
            overflow: hidden;
            isolation: isolate;
        }

        #cc-drawer.cc-open { transform: translateX(0); }

        #cc-toggle {
            position: fixed;
            z-index: 2147483646;
            top: 48%;
            left: 0;
            width: 28px;
            height: 48px;
            border: 1px solid var(--cc-border);
            border-left: 0;
            border-radius: 0 9px 9px 0;
            background: var(--cc-surface);
            color: var(--cc-text);
            font: 23px/1 system-ui,sans-serif;
            cursor: pointer;
            box-shadow: var(--cc-shadow);
            transition: left .24s cubic-bezier(.4,0,.2,1), background .15s;
        }

        #cc-toggle.cc-open { left: min(320px, calc(100vw - 44px)); }
        #cc-toggle:hover { background: var(--cc-hover); }

        #cc-drawer button, #cc-export, #cc-jump,
        #cc-nav-export, #cc-eye-toggle {
            font-family: inherit;
        }

        #cc-drawer button:focus-visible, #cc-toggle:focus-visible,
        #cc-export:focus-visible, #cc-jump:focus-visible,
        #cc-nav-export:focus-visible, #cc-eye-toggle:focus-visible {
            outline: 2px solid var(--cc-accent);
            outline-offset: 2px;
        }

        .cc-header {
            display:flex;
            align-items:center;
            justify-content:space-between;
            padding:16px 14px 12px;
            border-bottom:1px solid var(--cc-border);
            flex-shrink:0;
        }

        .cc-brand { font-size:14px; font-weight:750; letter-spacing:-.3px; }
        .cc-version { color:var(--cc-text-muted); font-size:10px; margin-top:2px; }

        .cc-icon-button {
            border:1px solid var(--cc-border);
            background:var(--cc-surface);
            color:var(--cc-text);
            border-radius:6px;
            width:30px;
            height:30px;
            cursor:pointer;
        }

        /* ═══ Icon-only drawer tabs ═══ */

        .cc-tabs {
            display:flex;
            gap:0;
            border-bottom:1px solid var(--cc-border);
            padding:0 10px;
            flex-shrink:0;
        }

        .cc-tab {
            flex:1;
            border:0;
            border-bottom:2px solid transparent;
            padding:11px 2px 9px;
            color:var(--cc-text-muted);
            background:transparent;
            cursor:pointer;
            font-size:12px;
            font-weight:600;
            display:flex;
            align-items:center;
            justify-content:center;
            flex-direction:column;
            gap:2px;
        }

        .cc-tab.cc-active {
            color:var(--cc-text);
            border-bottom-color:var(--cc-accent);
        }

        .cc-tab .cc-tab-icon {
            font-size:16px;
            line-height:1;
        }

        .cc-tab .cc-tab-label {
            font-size:10px;
            line-height:1;
            letter-spacing:.2px;
        }

        /* Gear icon button (far right) opens Settings modal */

        .cc-tab-gear {
            flex:0 0 auto;
            border:0;
            border-bottom:2px solid transparent;
            padding:11px 6px 9px;
            color:var(--cc-text-muted);
            background:transparent;
            cursor:pointer;
            font-size:16px;
            line-height:1;
        }

        .cc-tab-gear.cc-active {
            color:var(--cc-text);
            border-bottom-color:var(--cc-accent);
        }

        .cc-tab-gear:hover { color:var(--cc-text); background:var(--cc-hover); }

        /* Eye toggle button */

        #cc-eye-toggle {
            position:relative;
            width:34px;
            height:34px;
            border:1px solid var(--cc-border);
            border-radius:6px;
            background:var(--cc-surface);
            color:var(--cc-text);
            cursor:pointer;
            display:flex;
            align-items:center;
            justify-content:center;
            font-size:16px;
            margin:0 6px;
            flex-shrink:0;
        }

        #cc-eye-toggle:hover { background:var(--cc-hover); }

        .cc-content {
            flex:1;
            overflow-y:auto;
            overscroll-behavior:contain;
            padding:14px 12px 22px;
            scrollbar-width:thin;
            scrollbar-color:var(--cc-border) transparent;
        }

        .cc-section { margin-bottom:18px; }

        .cc-section-label {
            color:var(--cc-text-muted);
            font-size:11px;
            font-weight:600;
            letter-spacing:.06em;
            text-transform:uppercase;
            margin:0 0 8px 2px;
        }

        .cc-card {
            border:1px solid var(--cc-border);
            border-radius:8px;
            background:var(--cc-surface);
            overflow:hidden;
        }

        .cc-row {
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:10px;
            min-height:42px;
            padding:9px 12px;
            position:relative;
        }

        .cc-row + .cc-row::before {
            content:"";
            position:absolute;
            top:0;
            left:12px;
            right:12px;
            height:1px;
            background:var(--cc-border-faint);
        }

        .cc-row.cc-clickable { cursor:pointer; }
        .cc-row.cc-clickable:hover { background:var(--cc-hover); }

        .cc-label { color:var(--cc-text); font-size:12px; }
        .cc-value {
            color:var(--cc-text);
            font-weight:700;
            text-align:right;
            overflow-wrap:anywhere;
            max-width:55%;
            font-size:12px;
        }

        .cc-muted-value { color:var(--cc-text-muted); font-size:11px; text-align:right; }
        .cc-toggle {
            width:34px;
            height:20px;
            border-radius:99px;
            border:0;
            padding:2px;
            flex-shrink:0;
            background:var(--cc-text-subtle);
            cursor:pointer;
            transition:background .15s;
        }

        .cc-toggle.cc-on { background:var(--cc-accent); }
        .cc-knob {
            display:block;
            width:16px;
            height:16px;
            border-radius:50%;
            background:#fff;
            box-shadow:0 1px 2px rgba(0,0,0,.2);
            transform:translateX(0);
            transition:transform .15s;
        }
        .cc-toggle.cc-on .cc-knob { transform:translateX(14px); }

        .cc-action {
            width:100%;
            display:flex;
            align-items:center;
            gap:10px;
            padding:11px 12px;
            border:0;
            color:var(--cc-text);
            background:transparent;
            cursor:pointer;
            text-align:left;
            font-size:12px;
        }

        .cc-action:hover { background:var(--cc-hover); }
        .cc-action:disabled { opacity:.45; cursor:not-allowed; }
        .cc-action[aria-disabled="true"] { opacity:.45; cursor:not-allowed; pointer-events:none; }
        .cc-action-icon {
            width:16px;
            text-align:center;
            color:var(--cc-text-muted);
            flex-shrink:0;
        }

        .cc-reset {
            width:100%;
            padding:10px;
            border:1px solid var(--cc-danger);
            border-radius:7px;
            background:transparent;
            color:var(--cc-danger);
            font-size:12px;
            font-weight:600;
            cursor:pointer;
        }
        .cc-reset:hover { background:var(--cc-hover); }

        .cc-hero {
            padding:15px;
            border:1px solid var(--cc-accent-border);
            border-radius:9px;
            background:linear-gradient(130deg,var(--cc-surface),var(--cc-accent-bg));
            margin-bottom:16px;
        }

        .cc-hero-title { color:var(--cc-text-muted); font-size:11px; }
        .cc-hero-numbers { display:flex; align-items:center; justify-content:space-between; margin:7px 0 11px; }
        .cc-hero-main { font-size:18px; font-weight:650; letter-spacing:-.4px; }
        .cc-hero-percent { font-size:12px; font-weight:700; }
        .cc-progress { height:6px; background:var(--cc-border); border-radius:99px; overflow:hidden; }
        .cc-progress-fill { height:100%; border-radius:99px; transition:width .2s; }

        .cc-grid3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; margin-bottom:16px; }
        .cc-stat {
            min-width:0;
            border:1px solid var(--cc-border);
            border-radius:8px;
            background:var(--cc-surface);
            padding:10px 7px;
            text-align:center;
        }
        .cc-stat-title { color:var(--cc-text-muted); font-size:10px; margin-bottom:6px; }
        .cc-stat-value { font-size:17px; font-weight:700; overflow-wrap:anywhere; }
        .cc-stat-sub { color:var(--cc-text-subtle); font-size:10px; margin-top:3px; }

        .cc-footer-note { color:var(--cc-text-muted); font-size:10px; line-height:1.5; padding:5px 2px; }

        /* ═══ Nav bar export button (top nav, left of diff viewer) ═══ */

        #cc-nav-export {
            position:fixed;
            top:14px;
            left:calc(50% - 460px + 10px);
            z-index:2147483641;
            display:flex;
            align-items:center;
            justify-content:center;
            gap:6px;
            padding:8px 11px;
            border:1px solid var(--cc-border);
            border-radius:8px;
            color:var(--cc-text);
            background:var(--cc-surface);
            box-shadow:var(--cc-shadow);
            cursor:pointer;
            font-size:12px;
            font-weight:600;
        }

        #cc-nav-export:hover { background:var(--cc-hover); }
        #cc-nav-export[hidden] { display:none !important; }

        /* ═══ Bottom-right jump button (repositioned up ~1.5x height) ═══ */

        #cc-jump {
            position:fixed;
            right:18px;
            bottom:calc(16px + 1.5 * 36px);
            width:36px;
            height:36px;
            display:flex;
            align-items:center;
            justify-content:center;
            border:1px solid var(--cc-accent-border);
            border-radius:50%;
            background:var(--cc-accent);
            color:#fff;
            box-shadow:var(--cc-shadow-lg);
            cursor:pointer;
            font-size:22px;
        }

        /* ═══ Settings modal ═══ */

        #cc-settings-modal {
            position:fixed;
            inset:auto;
            top:50%;
            left:50%;
            transform:translate(-50%,-50%) scale(0.96);
            z-index:2147483648;
            width:min(640px,92vw);
            min-height:350px;
            max-height:min(760px,92vh);
            background:var(--cc-bg);
            border:1px solid var(--cc-border);
            border-radius:12px;
            box-shadow:var(--cc-shadow-lg);
            color:var(--cc-text);
            display:flex;
            flex-direction:column;
            opacity:0;
            pointer-events:none;
            transition:opacity .2s,transform .2s;
            font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }

        #cc-settings-modal.cc-visible {
            display:block;
            opacity:1;
            pointer-events:auto;
            transform:translate(-50%,-50%) scale(1);
        }

        #cc-settings-modal.cc-hidden { display:none !important; }

        #cc-settings-modal .cc-modal-backdrop {
            position:fixed;
            inset:0;
            z-index:2147483647;
            background:rgba(0,0,0,.35);
            backdrop-filter:blur(2px);
        }

        #cc-settings-modal .cc-modal-header {
            display:flex;
            align-items:center;
            justify-content:space-between;
            padding:14px 18px;
            border-bottom:1px solid var(--cc-border);
            flex-shrink:0;
        }

        #cc-settings-modal .cc-modal-title {
            font-size:15px;
            font-weight:700;
        }

        #cc-settings-modal .cc-modal-close {
            border:0;
            background:transparent;
            color:var(--cc-text-muted);
            font-size:22px;
            line-height:1;
            cursor:pointer;
            width:32px;
            height:32px;
            display:flex;
            align-items:center;
            justify-content:center;
            border-radius:6px;
        }

        #cc-settings-modal .cc-modal-close:hover {
            background:var(--cc-hover);
            color:var(--cc-text);
        }

        #cc-settings-modal .cc-modal-tabs {
            display:flex;
            border-bottom:1px solid var(--cc-border);
            flex-shrink:0;
        }

        #cc-settings-modal .cc-modal-tab {
            flex:1;
            border:0;
            border-bottom:2px solid transparent;
            padding:12px 8px;
            color:var(--cc-text-muted);
            background:transparent;
            cursor:pointer;
            font-size:12px;
            font-weight:600;
        }

        #cc-settings-modal .cc-modal-tab.cc-active {
            color:var(--cc-text);
            border-bottom-color:var(--cc-accent);
        }

        #cc-settings-modal .cc-modal-tab:hover { color:var(--cc-text); }

        #cc-settings-modal .cc-modal-panel {
            flex:1;
            display:flex;
            flex-direction:column;
            gap:18px;
            min-height:300px;
        }

        #cc-settings-modal .cc-modal-body {
            flex:1;
            overflow-y:auto;
            padding:18px;
            display:flex;
            flex-direction:column;
            gap:18px;
        }

        #cc-settings-modal .cc-modal-panel { display:none; }
        #cc-settings-modal .cc-modal-panel.cc-active { display:flex; flex-direction:column; gap:18px; }

        /* ═══ Toast ═══ */

        #cc-toast {
            position:fixed;
            z-index:2147483647;
            left:50%;
            bottom:22px;
            transform:translate(-50%,12px);
            max-width:min(90vw,480px);
            padding:11px 15px;
            border:1px solid var(--cc-border);
            border-radius:8px;
            background:var(--cc-surface-2);
            color:var(--cc-text);
            box-shadow:var(--cc-shadow-lg);
            opacity:0;
            pointer-events:none;
            transition:opacity .18s,transform .18s;
            font:12px/1.5 system-ui,sans-serif;
        }
        #cc-toast.cc-visible { opacity:1; transform:translate(-50%,0); }
        #cc-toast.cc-error { border-color:var(--cc-danger); }

        /* ═══ Code block buttons (copy + download) ═══ */

        [data-cc-wrap="1"] { position:relative !important; }

        [data-cc-wrap="1"] > .cc-code-buttons {
            position:absolute;
            top:8px;
            right:8px;
            display:flex;
            gap:4px;
            z-index:4;
        }

        [data-cc-wrap="1"] > .cc-code-buttons > button {
            width:28px;
            height:28px;
            display:flex;
            align-items:center;
            justify-content:center;
            border:1px solid var(--cc-border);
            border-radius:6px;
            background:var(--cc-bg);
            color:var(--cc-text);
            box-shadow:var(--cc-shadow);
            cursor:pointer;
            opacity:.55;
            transition:opacity .15s,background .15s;
            font-size:14px;
            line-height:1;
            padding:0;
        }

        [data-cc-wrap="1"]:hover > .cc-code-buttons > button { opacity:1; }
        [data-cc-wrap="1"] > .cc-code-buttons > button:hover { background:var(--cc-hover); }

        /* Hide legacy standalone download button class */
        [data-cc-wrap="1"] > .cc-code-download { display:none !important; }

        /* ═══ Visibility helpers ═══ */

        [data-cc-hidden="1"] { display:none !important; }
        [data-cc-thinking="1"] { display:none !important; }

        /* ═══ Compact Mode — Conversation ═══ */

        [data-cc-compact="1"] [role="log"] > *,
        [data-cc-compact="1"] [role="log"] > * > * {
            padding-top:2px !important;
            padding-bottom:2px !important;
        }
        [data-cc-compact="1"] [role="log"] .prose,
        [data-cc-compact="1"] [role="log"] [class*="prose"] {
            margin-top:.25rem !important;
            margin-bottom:.25rem !important;
        }
        [data-cc-compact="1"] [role="log"] p { margin-block:.3em !important; }
        [data-cc-compact="1"] [role="log"] pre,
        [data-cc-compact="1"] [role="log"] .code-block-header,
        [data-cc-compact="1"] [role="log"] [class*="code-block"] {
            padding-top:4px !important;
            padding-bottom:4px !important;
            margin-top:4px !important;
            margin-bottom:4px !important;
        }

        /* ═══ Compact Mode — Composer (Arena only, never userscript UI) ═══ */

        [data-cc-compact="1"] [role="composer"],
        [data-cc-compact="1"] [class*="composer"],
        [data-cc-compact="1"] [class*="prompt-input"],
        [data-cc-compact="1"] textarea[placeholder*="message" i],
        [data-cc-compact="1"] [contenteditable][data-cc-composer="1"] {
            font-size:13px !important;
            padding-top:6px !important;
            padding-bottom:6px !important;
        }

        [data-cc-compact="1"] [role="composer"] button,
        [data-cc-compact="1"] [class*="composer"] button,
        [data-cc-compact="1"] [class*="prompt-input"] button {
            padding:4px 8px !important;
            font-size:12px !important;
        }

        [data-cc-compact="1"] #cc-drawer,
        [data-cc-compact="1"] #cc-toggle,
        [data-cc-compact="1"] #cc-nav-export,
        [data-cc-compact="1"] #cc-eye-toggle,
        [data-cc-compact="1"] #cc-settings-modal {
            font-size:inherit !important;
            padding:inherit !important;
        }

        /* ═══ Text Mode ═══ */

        [data-cc-textmode="1"] [role="log"] pre,
        [data-cc-textmode="1"] [role="log"] .code-block,
        [data-cc-textmode="1"] [role="log"] [class*="code-block"] {
            position:relative !important;
            overflow:hidden !important;
            max-height:48px !important;
        }

        [data-cc-textmode="1"] [role="log"] pre > code,
        [data-cc-textmode="1"] [role="log"] pre > * {
            display:none !important;
        }

        [data-cc-textmode="1"] [role="log"] pre::after {
            content:attr(data-cc-textdesc);
            display:block !important;
            padding:8px 12px !important;
            font-size:12px !important;
            font-family:ui-monospace, SFMono-Regular, Menlo, monospace !important;
            color:var(--cc-text-muted) !important;
            background:var(--cc-surface-2) !important;
            border:1px dashed var(--cc-border) !important;
            border-radius:6px !important;
            white-space:pre-wrap !important;
            word-break:break-all !important;
            line-height:1.5 !important;
        }

        @media(max-width:380px) {
            #cc-drawer { width:calc(100vw - 36px); }
            #cc-toggle.cc-open { left:calc(100vw - 36px); }
        }
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

    injectStyle('cc-theme', THEME_CSS);

    function updateDynamicCSS() {
        document.documentElement.dataset.ccCompact = cfg.compactMode ? '1' : '';
        document.documentElement.dataset.ccEye = cfg.eyeToggle ? '1' : '';
        document.documentElement.dataset.ccTextmode = cfg.textMode ? '1' : '';

        const css = `
            ${cfg.thinkingMode === 'hide' ? '[data-cc-thinking="1"]{display:none!important;}' : ''}
            ${cfg.compactMode ? `
                [role="log"] > *,
                [role="log"] > * > * {
                    padding-top:2px !important;
                    padding-bottom:2px !important;
                }
                [role="log"] .prose,
                [role="log"] [class*="prose"] {
                    margin-top:.25rem !important;
                    margin-bottom:.25rem !important;
                }
                [role="log"] p { margin-block:.3em !important; }
            ` : ''}
            ${Number(cfg.fontSize) > 0 ? `
                [role="log"], [role="log"] * {
                    font-size:${Math.min(24,Math.max(10,Number(cfg.fontSize)))}px !important;
                }
            ` : ''}
        `;
        injectStyle('cc-dynamic', css);
    }

    // ══════════════════════════════════════════════════════════════════
    // PERF CSS
    // ══════════════════════════════════════════════════════════════════

    injectStyle('cc-perf', `
        [data-cc-hidden="1"] { display:none !important; }
        [data-cc-flat="1"] { contain:content; }
    `);

    // ══════════════════════════════════════════════════════════════════
    // TOAST
    // ══════════════════════════════════════════════════════════════════

    function toast(message, error = false, duration = 3000) {
        let el = q('#cc-toast');
        if (!el && document.documentElement) {
            el = document.createElement('div');
            el.id = 'cc-toast';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            (document.body || document.documentElement).appendChild(el);
        }
        if (!el) return;

        el.textContent = String(message);
        el.classList.toggle('cc-error', error);
        el.classList.add('cc-visible');

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('cc-visible'), duration);
    }

    // ══════════════════════════════════════════════════════════════════
    // EYE TOGGLE — Side menu visibility control
    // ══════════════════════════════════════════════════════════════════

    function createEyeButton() {
        if (eyeButton && eyeButton.isConnected) return eyeButton;

        eyeButton = document.createElement('button');
        eyeButton.id = 'cc-eye-toggle';
        eyeButton.type = 'button';
        eyeButton.setAttribute('aria-pressed', 'false');
        eyeButton.setAttribute('aria-label', 'Hide non-userscript UI (eye open)');
        eyeButton.textContent = cfg.eyeToggle ? '👁️' : '🙈';
        eyeButton.title = 'Toggle viewport visibility';

        eyeButton.addEventListener('click', () => {
            cfg.eyeToggle = !cfg.eyeToggle;
            saveConfig();
            updateDynamicCSS();
            eyeButton.textContent = cfg.eyeToggle ? '👁️' : '🙈';
            eyeButton.setAttribute('aria-pressed', String(cfg.eyeToggle));
            eyeButton.setAttribute('aria-label',
                cfg.eyeToggle
                    ? 'Hide non-userscript UI (eye open)'
                    : 'Show all UI (eye closed)'
            );
            toast(cfg.eyeToggle ? 'Non-userscript UI hidden' : 'All UI restored');
            renderDrawer();
        });

        return eyeButton;
    }

    function applyEyeToggle() {
        if (!cfg.eyeToggle) {
            document.documentElement.dataset.ccEye = '';
            return;
        }

        document.documentElement.dataset.ccEye = '1';

        // Hide Arena composer and other non-userscript UI components.
        const composer = findComposer();
        if (composer && !composer.closest('#cc-drawer,#cc-toggle,#cc-nav-export,#cc-eye-toggle,#cc-settings-modal')) {
            composer.style.setProperty('display', 'none', 'important');
            composer.dataset.ccEyeHidden = '1';
        }
    }

    function restoreEyeToggle() {
        document.documentElement.dataset.ccEye = '';
        for (const el of qa('[data-cc-eye-hidden="1"]')) {
            el.style.removeProperty('display');
            delete el.dataset.ccEyeHidden;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // DOM HELPERS
    // ══════════════════════════════════════════════════════════════════

    function findLog() {
        const logs = qa('[role="log"]');
        if (!logs.length) return null;
        return logs.reduce((best, el) =>
            el.children.length > best.children.length ? el : best
        );
    }

    function isVisible(el) {
        if (!(el instanceof Element) || !el.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            Number(style.opacity) === 0) return false;
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

            if (valid.length >= 2) {
                return { parent: node, messages: valid };
            }

            if (children.length !== 1) {
                if (valid.length === 1) {
                    return { parent: node, messages: valid };
                }
                break;
            }

            node = children[0];
        }

        const children = Array.from(node.children);
        const valid = children.filter(validMessage);
        if (valid.length) return { parent: node, messages: valid };

        return { parent: log, messages: Array.from(log.children).filter(validMessage) };
    }

    function getMessages(log = currentLog) {
        return findMessageList(log).messages;
    }

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
            newestFirst: reversed ? messages : messages.slice().reverse()
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

        const behavior = cfg.smoothScroll ? 'smooth' : 'auto';

        if (cfg.smoothScroll && typeof container.scrollTo === 'function') {
            container.scrollTo({ top: container.scrollHeight, behavior });
        } else {
            container.scrollTop = container.scrollHeight;
        }
    }

    function textContent(el) {
        return (el?.textContent || '').trim();
    }

    function formatNumber(n) {
        return Number(n || 0).toLocaleString();
    }

    function safePageTitle() {
        return (document.title || 'arena-chat')
            .replace(/\s*[|–—-]\s*Arena\.ai.*$/i, '')
            .trim() || 'arena-chat';
    }

    function sanitizeFilename(name) {
        return String(name)
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^\.+|\.+$/g, '')
            .slice(0, 100) || 'arena-chat';
    }

    // ══════════════════════════════════════════════════════════════════
    // COMPOSER FINDER
    // ══════════════════════════════════════════════════════════════════

    function findComposer() {
        if (cfg.composerSelector) {
            try {
                const selected = q(cfg.composerSelector);
                if (selected && isVisible(selected)) {
                    composerCache = selected;
                    return selected;
                }
            } catch (error) {
                // Invalid custom selector: fall through to automatic detection.
            }
        }

        // Expanded selector list to catch Arena's various composer implementations.
        const candidates = qa(
            'textarea,input[type="text"],[contenteditable],[role="textbox"],[role="combobox"],' +
            '[class*="composer"],[class*="prompt"],[class*="chat-input"],[class*="message-input"]'
        );

        let best = null;
        let bestScore = -Infinity;

        for (const el of candidates) {
            if (!isVisible(el)) continue;
            if (el.closest('#cc-drawer,#cc-toggle,#cc-nav-export,#cc-toast,#cc-settings-modal,#cc-eye-toggle')) continue;
            if (el.matches('input[type="hidden"],input[aria-hidden="true"]')) continue;

            // Don't exclude [role="log"] outright — Arena may nest the composer inside it.
            // Only skip if the element IS the log container itself.
            if (el.getAttribute('role') === 'log') continue;

            const r = el.getBoundingClientRect();
            let score = 0;

            if (r.bottom >= window.innerHeight * 0.65) score += 25;
            else if (r.bottom >= window.innerHeight * 0.4) score += 12;

            if (r.width > 200) score += 12;
            if (r.width > 400) score += 6;

            if (el.tagName === 'TEXTAREA') score += 10;
            if (el.isContentEditable) score += 8;
            if (el.getAttribute('role') === 'textbox') score += 8;
            if (el.getAttribute('role') === 'combobox') score += 8;

            if (!el.closest('header,nav,aside,[role="navigation"]')) score += 12;

            const cls = (el.className || '') + ' ' + (el.getAttribute('class') || '');
            if (/composer|prompt|chat|message|input/i.test(cls)) score += 10;

            const placeholder = el.getAttribute('placeholder') || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            if (placeholder || ariaLabel) {
                score += /message|prompt|ask|send|chat/i.test(
                    placeholder + ' ' + ariaLabel
                ) ? 8 : 0;
            }

            // Prefer elements near the bottom of the viewport (typical composer placement).
            if (r.bottom > window.innerHeight * 0.8) score += 15;

            if (score > bestScore) {
                best = el;
                bestScore = score;
            }
        }

        composerCache = best;
        return best;
    }

    // ══════════════════════════════════════════════════════════════════
    // PR STATE DETECTION
    // ══════════════════════════════════════════════════════════════════

    function detectPRState() {
        // Look for PR indicators in the conversation: GitHub PR URLs,
        // Arena PR badges, assistant confirmation messages.
        const text = (document.body.textContent || '');

        const mergedPattern = /(pull.?request|PR)[^.\n]{0,80}?(merged|closed|deployed)/i;
        const openPattern = /(pull.?request|PR)[^.\n]{0,80}?(open|created|#\d+|https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+)/i;

        if (mergedPattern.test(text)) return 'merged';
        if (openPattern.test(text)) return 'open';

        // Check for explicit userscript session state (could be extended)
        return prState || 'none';
    }

    function setPRState(state) {
        prState = state;
        updatePRButtons();
    }

    function updatePRButtons() {
        if (!drawer || !drawer.isConnected) return;

        const createBtn = q('#cc-btn-create-pr', drawer);
        const mergeBtn = q('#cc-btn-merge-pr', drawer);

        if (!createBtn || !mergeBtn) return;

        const open = prState === 'open';
        const merged = prState === 'merged';

        createBtn.disabled = open || merged;
        createBtn.setAttribute('aria-disabled', String(createBtn.disabled));
        createBtn.classList.toggle('cc-action-disabled', createBtn.disabled);

        mergeBtn.disabled = !open;
        mergeBtn.setAttribute('aria-disabled', String(mergeBtn.disabled));
        mergeBtn.classList.toggle('cc-action-disabled', mergeBtn.disabled);
    }

    // ══════════════════════════════════════════════════════════════════
    // AUTO-CLICK CONTINUE BUTTON (after PR merged)
    // ══════════════════════════════════════════════════════════════════

    /**
     * When a PR has been merged, Arena often shows a "Continue" button
     * in the composer panel. Detect and click it automatically.
     * Runs only when prState === 'merged', with a cooldown guard.
     */
    function clickContinueButton() {
        if (prState !== 'merged') return;
        if (!cfg.autoClickContinue) return;

        const now = Date.now();
        if (now - lastContinueClick < 3000) return; // 3s cooldown

        const composer = findComposer();
        if (!composer) return;

        // Search within the composer's nearest panel/container for a Continue button.
        const panel = composer.closest(
            '[class*="composer"], [class*="prompt"], [role="combobox"], section, div'
        ) || composer.parentElement;

        if (!panel) return;

        const continueCandidates = qa('button,a,[role="button"]', panel).filter(el => {
            if (!isVisible(el)) return false;
            const label = [
                textContent(el),
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || ''
            ].join(' ').trim();
            return /^continue$/i.test(label) || /continue/i.test(label);
        });

        // Prefer candidates closest to the bottom of the panel (typical Continue placement).
        continueCandidates.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return rb.bottom - ra.bottom;
        });

        for (const btn of continueCandidates) {
            try {
                btn.click();
                lastContinueClick = now;
                toast('Continue button clicked.');
                return true;
            } catch (_) {
                // Try next candidate.
            }
        }

        return false;
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
            let plain;

            if (lines.length) {
                plain = lines.map(line => line.textContent || '').join('\n');
            } else {
                plain = code.innerText || code.textContent || '';
            }

            code.replaceChildren(document.createTextNode(plain));
            pre.dataset.ccFlat = '1';
        }
    }

    function virtualize() {
        const log = currentLog;
        if (!log) return;

        const found = orderedMessages(log);
        const { messages, reversed, newestFirst } = found;
        const total = messages.length;
        const keep = Math.max(1, Math.floor(Number(cfg.keepMessages) || 8));

        messagesCache = messages;
        reversedOrder = reversed;

        for (const message of messages) {
            if (!cfg.virtualize) {
                delete message.dataset.ccHidden;
            }
        }

        if (cfg.virtualize && total > keep) {
            const newestSet = new Set(newestFirst.slice(0, keep));

            for (const message of messages) {
                if (!newestSet.has(message)) flattenShiki(message);
            }

            for (const message of messages) {
                if (newestSet.has(message)) {
                    delete message.dataset.ccHidden;
                } else {
                    message.dataset.ccHidden = '1';
                }
            }
        } else {
            for (const message of messages) delete message.dataset.ccHidden;
        }

        hiddenCount = messages.filter(m => m.dataset.ccHidden === '1').length;

        const mode = cfg.virtualize ? 'virtualized' : 'disabled';
        const signature = JSON.stringify({
            mode, total, hidden: hiddenCount, reversed, keep
        });

        if (signature !== lastVirtualSignature) {
            console.info('[CC] Virtualize', {
                mode, total, hidden: hiddenCount, reversed, keep
            });
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
            .filter(button => {
                if (!THINKING_TEXT.test(textContent(button))) return false;

                const wrapper = button.closest('div.not-prose[data-state]');
                return !!wrapper;
            });
    }

    function thinkingWrapper(button) {
        return button.closest('div.not-prose[data-state]');
    }

    function setThinkingMode(mode) {
        if (!['collapse', 'expand', 'hide'].includes(mode)) return;

        cfg.thinkingMode = mode;
        lastCollapseCount = -1;
        lastExpandCount = -1;

        updateDynamicCSS();
        saveConfig();
        renderDrawer();

        if (mode === 'hide') {
            for (const button of getThinkingButtons()) {
                const wrapper = thinkingWrapper(button);
                if (wrapper) wrapper.dataset.ccThinking = '1';
            }
        } else {
            qa('[data-cc-thinking="1"]').forEach(el => delete el.dataset.ccThinking);
            dispatchThinkingMode(true);
        }
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

            for (const button of getThinkingButtons(log)) {
                if (button.dataset.state === 'closed') button.click();
            }
            return;
        }

        if (mode === 'collapse') {
            if (!force && count <= lastCollapseCount) return;
            lastCollapseCount = count;

            const newest = new Set(newestFirst.slice(0, 1));

            for (const message of messages) {
                if (newest.has(message)) continue;

                for (const button of getThinkingButtons(message)) {
                    if (button.dataset.state === 'open') button.click();
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // AUTO-SCROLL
    // ══════════════════════════════════════════════════════════════════

    function removeJumpButton() {
        jumpButton?.remove();
        jumpButton = null;
    }

    function updateJumpButton() {
        const container = scrollElement();
        const shouldShow = !!container && !isNearBottom(container);

        if (!shouldShow) {
            removeJumpButton();
            return;
        }

        if (!jumpButton || !jumpButton.isConnected) {
            jumpButton = document.createElement('button');
            jumpButton.id = 'cc-jump';
            jumpButton.type = 'button';
            jumpButton.textContent = '↓';
            jumpButton.title = 'Jump to latest message';
            jumpButton.setAttribute('aria-label', 'Jump to latest message');

            jumpButton.addEventListener('click', () => {
                scrollToBottom(scrollElement());
                removeJumpButton();
            });

            document.documentElement.appendChild(jumpButton);
        }
    }

    function teardownAutoScroll() {
        if (activeLogObserver) {
            activeLogObserver.disconnect();
            activeLogObserver = null;
        }

        if (scrollCleanup) {
            scrollCleanup();
            scrollCleanup = null;
        }

        removeJumpButton();
    }

    function rebuildAutoScroll(log) {
        teardownAutoScroll();
        if (!log) return;

        currentLog = log;

        const scroller = scrollElement(log);
        let stickToBottom = isNearBottom(scroller);

        const onScroll = () => {
            stickToBottom = isNearBottom(scroller);
            updateJumpButton();
        };

        scroller.addEventListener('scroll', onScroll, { passive: true });
        scrollCleanup = () => scroller.removeEventListener('scroll', onScroll);

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

            schedule();
        });

        activeLogObserver.observe(log, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // ══════════════════════════════════════════════════════════════════
    // HTML EXPORT (single self-contained .html file)
    // ══════════════════════════════════════════════════════════════════

    function collectInlineStyles(doc) {
        const styles = [];
        for (const link of qa('link[rel="stylesheet"]', doc)) {
            try {
                const href = link.getAttribute('href');
                if (!href) continue;
                const abs = new URL(href, location.href).href;
                styles.push(`/* External stylesheet: ${abs} */\n/* Not inlined — stylesheet could not be fetched synchronously */\n`);
            } catch (_) {
                // skip
            }
        }
        for (const style of qa('style', doc)) {
            if (style.id && (style.id.startsWith('cc-') || style.id === 'cc-theme')) continue;
            styles.push(style.textContent || '');
        }
        return styles.join('\n');
    }

    function cloneConversation(log) {
        if (!log) return null;

        const clone = log.cloneNode(true);

        // Unhide virtualized messages so the full conversation appears.
        for (const hidden of qa('[data-cc-hidden="1"]', clone)) {
            hidden.removeAttribute('data-cc-hidden');
        }

        // Remove userscript-injected UI and controls from the snapshot.
        for (const sel of [
            '#cc-drawer', '#cc-toggle', '#cc-nav-export', '#cc-eye-toggle',
            '#cc-settings-modal', '#cc-toast', '#cc-jump',
            '.cc-code-download', '.cc-code-copy', '.cc-code-buttons',
            '[data-cc-wrap="1"] > .cc-code-download',
            '[data-cc-wrap="1"] > .cc-code-copy',
            '[data-cc-wrap="1"] > .cc-code-buttons',
            'script'
        ]) {
            for (const el of qa(sel, clone)) {
                el.remove();
            }
        }

        return clone;
    }

    function exportChatHTML() {
        const log = currentLog || findLog();
        if (!log) {
            toast('No chat container found.', true);
            return;
        }

        const found = orderedMessages(log);
        const messages = found.reversed
            ? found.messages.slice().reverse()
            : found.messages.slice();

        // Build a minimal HTML document.
        const title = safePageTitle();
        const date = new Date().toISOString().slice(0, 10);
        const filename = sanitizeFilename(title) + '-' + date + '.html';

        const themeAttr = document.documentElement.getAttribute('class') || '';
        const themeDataTheme = document.documentElement.getAttribute('data-theme') || '';
        const rootStyles = Array.from(document.documentElement.style)
            .map(prop => `${prop}:${document.documentElement.style.getPropertyValue(prop)}`)
            .join(';');

        const cloned = cloneConversation(log);
        const conversationHTML = cloned ? cloned.outerHTML : '';

        const inlineStyles = collectInlineStyles(document);

        const html = `<!DOCTYPE html>
<html lang="en" class="${themeAttr}" data-theme="${themeDataTheme}" style="${rootStyles}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Conversation Export</title>
<style>
/* Captured Arena theme & layout styles */
:root, html {
  --cc-bg: #ffffff;
  --cc-surface: #fafafa;
  --cc-text: #18181b;
  --cc-text-muted: #71717a;
  --cc-border: #e4e4e7;
}
html.dark, html[data-theme="dark"] {
  --cc-bg: #09090b;
  --cc-surface: #18181b;
  --cc-text: #fafafa;
  --cc-text-muted: #a1a1aa;
  --cc-border: #3f3f46;
}
body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; padding:24px; color:var(--cc-text); background:var(--cc-bg); }
.conversation-export { max-width:900px; margin:0 auto; }
.conversation-export h1 { font-size:20px; margin:0 0 8px; }
.conversation-export .meta { color:var(--cc-text-muted); font-size:12px; margin-bottom:16px; border-bottom:1px solid var(--cc-border); padding-bottom:12px; }
.conversation-export .message { margin-bottom:24px; padding:12px 16px; border:1px solid var(--cc-border); border-radius:8px; background:var(--cc-surface); }
.conversation-export .message pre { background:#f4f4f5; border-radius:6px; padding:12px; overflow:auto; }
.conversation-export .message code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
html.dark .conversation-export .message pre, html[data-theme="dark"] .conversation-export .message pre { background:#27272a; }
${inlineStyles}
</style>
</head>
<body>
<div class="conversation-export">
  <h1>${title}</h1>
  <div class="meta">
    Exported: ${new Date().toLocaleString()}<br>
    Page: ${location.href}<br>
    Messages: ${messages.length}
  </div>
  <div class="messages">
    ${conversationHTML}
  </div>
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

        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    // ══════════════════════════════════════════════════════════════════
    // AUTO-CLICK "PAGE UPDATED" BANNER
    // ══════════════════════════════════════════════════════════════════

    function clickPageUpdatedBanner() {
        const candidates = qa('button,a,[role="button"],div[class*="toast"],div[class*="banner"],div[class*="notification"]');

        for (const el of candidates) {
            if (!isVisible(el)) continue;
            const label = [
                textContent(el),
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || ''
            ].join(' ').trim();

            if (!label) continue;

            const matches = /page\s+updated|click\s+here|open\s+in\s+a\s+new\s+tab|reload|refresh/i.test(label);
            if (!matches) continue;

            // Avoid clicking the same element twice.
            if (el === lastClickedBanner) continue;

            lastClickedBanner = el;
            setTimeout(() => { lastClickedBanner = null; }, 5000);

            try { el.click(); } catch (_) {}
            toast('Page-update banner clicked.');
            return true;
        }

        return false;
    }

    function watchPageUpdatedBanner() {
        // Debounced scan; triggered by schedule() and MutationObserver.
        if (!cfg.autoClickPageUpdated) return;
        clickPageUpdatedBanner();
    }

    // ══════════════════════════════════════════════════════════════════
    // AGENT ACTIONS
    // ══════════════════════════════════════════════════════════════════

    async function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) {
            // Fall through to the legacy clipboard method.
        }

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
        } catch (_) {
            return false;
        }
    }

    function setNativeValue(el, value) {
        if (el.isContentEditable) {
            el.focus();
            el.replaceChildren(document.createTextNode(value));
            el.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: value
            }));
            return;
        }

        const prototype = el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;

        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;

        el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: value
        }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function createPR() {
        const message =
            'Create a pull request for the current changes and give me the PR URL.';

        const composer = findComposer();

        if (!composer) {
            await copyText(message);
            toast('Composer not found. Request copied to clipboard if supported.', true, 4500);
            return;
        }

        try {
            setNativeValue(composer, message);
            composer.focus();
            toast('Request entered in the composer. Review it and submit when ready.');
        } catch (error) {
            await copyText(message);
            toast('Could not populate composer. Request copied if clipboard is available.', true);
        }
    }

    async function mergePR() {
        const message =
            'The pull request has been created. Please merge it and let me know the result.';

        const composer = findComposer();

        if (!composer) {
            await copyText(message);
            toast('Composer not found. Request copied to clipboard if supported.', true, 4500);
            return;
        }

        try {
            setNativeValue(composer, message);
            composer.focus();
            toast('Merge request entered in the composer. Review it and submit when ready.');
        } catch (error) {
            await copyText(message);
            toast('Could not populate composer. Request copied if clipboard is available.', true);
        }
    }

    async function clearChat() {
        const before = getMessages(findLog()).length;
        const patterns = [
            /\bnew chat\b/i,
            /\bnew conversation\b/i,
            /\bstart new chat\b/i,
            /\bnew thread\b/i,
            /\bnew session\b/i,
            /\bclear chat\b/i,
            /\bclear conversation\b/i,
            /\breset chat\b/i,
            /\bcreate chat\b/i
        ];

        const candidates = qa('button,a,[role="button"]')
            .filter(el => {
                if (!isVisible(el)) return false;
                if (el.closest('[role="log"]')) return false;
                const label = [
                    textContent(el),
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('title') || ''
                ].join(' ').trim();

                if (!label || !patterns.some(pattern => pattern.test(label))) return false;

                return true;
            })
            .map(el => {
                const r = el.getBoundingClientRect();
                let score = textContent(el) ? 5 : 0;
                if (el.closest('aside,nav,[role="navigation"]')) score += 5;
                if (r.top < window.innerHeight * 0.35) score += 3;
                if (el.tagName === 'A') score += 1;
                return { el, score };
            })
            .sort((a, b) => b.score - a.score);

        if (candidates.length) {
            candidates[0].el.click();
            await new Promise(resolve => setTimeout(resolve, 900));

            const after = getMessages(findLog()).length;
            if (after < before || after === 0) {
                toast('Chat cleared successfully.');
                schedule();
                return;
            }
        }

        toast('Could not verify that the chat was cleared.', true, 3500);
        await new Promise(resolve => setTimeout(resolve, 400));

        if (confirm('Arena did not confirm that the chat was cleared. Navigate to / instead?')) {
            location.assign('/');
        }
    }

    async function runDiagnostics() {
        const log = findLog();
        const composer = findComposer();

        const report = {
            timestamp: new Date().toISOString(),
            url: location.href,
            title: document.title,
            prState,
            log: log ? {
                tag: log.tagName,
                className: String(log.className || ''),
                childCount: log.children.length,
                messageCount: getMessages(log).length,
                direction: orderedMessages(log).reversed ? 'reversed' : 'normal',
                rect: (() => {
                    const r = log.getBoundingClientRect();
                    return { x: r.x, y: r.y, width: r.width, height: r.height };
                })()
            } : null,
            composer: composer ? {
                tag: composer.tagName,
                role: composer.getAttribute('role'),
                placeholder: composer.getAttribute('placeholder'),
                ariaLabel: composer.getAttribute('aria-label'),
                contentEditable: composer.isContentEditable
            } : null,
            buttons: qa('button').filter(isVisible).slice(0, 100).map(button => ({
                text: textContent(button).slice(0, 100),
                ariaLabel: button.getAttribute('aria-label'),
                title: button.getAttribute('title'),
                dataState: button.getAttribute('data-state')
            })),
            settings: { ...cfg }
        };

        const json = JSON.stringify(report, null, 2);
        console.log('[CC] Diagnostics\n' + json);

        const copied = await copyText(json);
        toast(copied ? 'Diagnostics logged and copied.' : 'Diagnostics logged. Clipboard unavailable.', !copied);
    }

    // ══════════════════════════════════════════════════════════════════
    // COMPOSER VISIBILITY
    // ══════════════════════════════════════════════════════════════════

    function restoreComposer() {
        const marked = qa('[data-cc-composer-hide="1"]');

        for (const wrapper of marked) {
            wrapper.style.removeProperty('display');
            delete wrapper.dataset.ccComposerHide;
        }

        composerHideWrapper = null;
    }

    function applyComposerHide() {
        if (!cfg.hideComposer) {
            if (composerHideWrapper || q('[data-cc-composer-hide="1"]')) {
                restoreComposer();
            }
            return true;
        }

        if (q('[data-cc-composer-hide="1"]')) {
            composerHideWrapper = q('[data-cc-composer-hide="1"]');
            return true;
        }

        const composer = findComposer();
        if (!composer) return false;

        let wrapper = composer;

        for (let depth = 0; depth < 8 && wrapper.parentElement; depth++) {
            const parent = wrapper.parentElement;
            if (parent === document.body || parent === document.documentElement) break;

            const r = parent.getBoundingClientRect();
            if (r.height > window.innerHeight * 0.5 || r.width < 200) break;

            wrapper = parent;
        }

        if (!wrapper || wrapper === document.body || wrapper === document.documentElement) {
            return false;
        }

        wrapper.dataset.ccComposerHide = '1';
        wrapper.style.setProperty('display', 'none', 'important');
        composerHideWrapper = wrapper;

        return wrapper.dataset.ccComposerHide === '1';
    }

    function toggleComposerVisibility(enabled) {
        cfg.hideComposer = enabled;

        if (enabled && !applyComposerHide()) {
            cfg.hideComposer = false;
            restoreComposer();
            saveConfig();
            renderDrawer();
            toast('Could not identify a safe composer wrapper. Hide Composer was rolled back.', true, 4500);
            return false;
        }

        if (!enabled) restoreComposer();

        saveConfig();
        renderDrawer();
        return true;
    }

    // ══════════════════════════════════════════════════════════════════
    // CODE BLOCK EXPORT
    // ══════════════════════════════════════════════════════════════════

    const EXTENSIONS = {
        js:'js', mjs:'mjs', cjs:'cjs',
        ts:'ts', jsx:'jsx', tsx:'tsx',
        py:'py', python:'py', rb:'rb', ruby:'rb',
        go:'go', rs:'rs', rust:'rs',
        java:'java', kt:'kt', kotlin:'kt',
        swift:'swift', scala:'scala',
        c:'c', h:'h', cpp:'cpp', cxx:'cpp', hpp:'hpp',
        cs:'cs', php:'php', r:'r', pl:'pl', lua:'lua',
        sh:'sh', bash:'sh', shell:'sh', ps1:'ps1', powershell:'ps1',
        sql:'sql', html:'html', xml:'xml',
        css:'css', scss:'scss', sass:'sass', less:'less',
        json:'json', jsonc:'jsonc', yaml:'yml', yml:'yml',
        toml:'toml', md:'md', markdown:'md',
        diff:'diff', patch:'patch', dockerfile:'Dockerfile',
        makefile:'Makefile', ini:'ini', env:'env',
        graphql:'graphql', gql:'graphql',
        vue:'vue', svelte:'svelte', astro:'astro',
        prisma:'prisma', txt:'txt',
        jsxdev:'jsx', typescript:'ts', javascript:'js'
    };

    function detectCodeLanguage(pre) {
        const code = q('code', pre);
        const raw = [
            pre.dataset.language,
            code?.dataset.language,
            ...Array.from(pre.classList),
            ...Array.from(code?.classList || [])
        ].join(' ');

        const match = raw.match(/(?:language-|lang-)([a-zA-Z0-9_+#.-]+)/i);
        return match ? match[1] : '';
    }

    function extensionFor(language) {
        const key = String(language || '').toLowerCase();
        return EXTENSIONS[key] || 'txt';
    }

    function extractCodeFilename(pre, index) {
        const language = detectCodeLanguage(pre);
        const ext = extensionFor(language);
        const validExtensions = Object.keys(EXTENSIONS).join('|');

        const previous = pre.previousElementSibling;
        if (previous) {
            const candidate = textContent(previous);
            if (candidate.length < 200) {
                const match = candidate.match(
                    new RegExp('([\\\\w./-]+\\\\.(?:' + validExtensions + '))', 'i')
                );
                if (match) return sanitizeFilename(match[1]);
            }
        }

        const labelled = [
            pre.getAttribute('aria-label'),
            pre.getAttribute('title'),
            q('code', pre)?.getAttribute('aria-label'),
            q('code', pre)?.getAttribute('title')
        ].filter(Boolean).join(' ');

        const labelMatch = labelled.match(
            new RegExp('([\\\\w./-]+\\\\.(?:' + validExtensions + '))', 'i')
        );
        if (labelMatch) return sanitizeFilename(labelMatch[1]);

        if (pre.dataset.filename) return sanitizeFilename(pre.dataset.filename);

        return 'snippet-' + (++snippetCounter) + '.' + ext;
    }

    function cleanupCodeWrappers() {
        for (const wrapper of qa('[data-cc-wrap="1"]')) {
            const pre = q('pre', wrapper);
            if (!pre || !pre.isConnected) {
                wrapper.remove();
            }
        }
    }

    function decorateCodeBlocks() {
        const log = currentLog;
        if (!log) return;

        cleanupCodeWrappers();

        const visibleMessages = getMessages(log).filter(
            message => message.dataset.ccHidden !== '1'
        );

        for (const message of visibleMessages) {
            for (const pre of qa('pre', message)) {
                if (pre.closest('[data-cc-hidden="1"]')) continue;

                // Determine if this block is eligible for download (not shell/output)
                const cls = (pre.className || '') + ' ' + (q('code', pre)?.className || '');
                const isShellOutput = /(bash|sh|shell|zsh|powershell|ps1|console|stdout|stderr|terminal|output)/i.test(cls);
                const isDownloadable = !isShellOutput;

                if (pre.dataset.ccDecorated === '1') {
                    const wrapper = pre.parentElement;
                    const buttons = q('.cc-code-buttons', wrapper);
                    if (buttons && wrapper.dataset.ccWrap === '1') {
                        // Ensure copy button exists on all blocks
                        if (!q('.cc-code-copy', buttons)) {
                            addCodeCopyButton(buttons, pre);
                        }
                        // Ensure download button exists only on eligible blocks
                        if (isDownloadable && !q('.cc-code-download', buttons)) {
                            addCodeDownloadButton(buttons, pre);
                        }
                        // Remove download button if no longer eligible
                        if (!isDownloadable) {
                            const dl = q('.cc-code-download', buttons);
                            if (dl) dl.remove();
                        }
                        continue;
                    }
                    delete pre.dataset.ccDecorated;
                }

                let wrapper = pre.parentElement;
                if (wrapper?.dataset.ccWrap !== '1') {
                    wrapper = document.createElement('div');
                    wrapper.dataset.ccWrap = '1';
                    wrapper.style.position = 'relative';
                    pre.parentNode.insertBefore(wrapper, pre);
                    wrapper.appendChild(pre);
                }

                // Create side-by-side buttons container
                let buttons = q('.cc-code-buttons', wrapper);
                if (!buttons) {
                    buttons = document.createElement('div');
                    buttons.className = 'cc-code-buttons';
                    wrapper.appendChild(buttons);
                }

                // Every block gets a copy button
                addCodeCopyButton(buttons, pre);

                // Only eligible blocks get a download button
                if (isDownloadable) {
                    addCodeDownloadButton(buttons, pre);
                }

                pre.dataset.ccDecorated = '1';
            }
        }
    }

    function addCodeCopyButton(container, pre) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cc-code-copy';
        button.textContent = '📋';
        button.title = 'Copy code';
        button.setAttribute('aria-label', 'Copy code block');

        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();

            const code = q('code', pre) || pre;
            const content = code.innerText || code.textContent || '';
            const success = await copyText(content);
            toast(success ? 'Copied to clipboard' : 'Copy failed', !success);
        });

        container.appendChild(button);
    }

    function addCodeDownloadButton(container, pre) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cc-code-download';
        button.textContent = '⬇';
        button.title = 'Download code';
        button.setAttribute('aria-label', 'Download code block');

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            const code = q('code', pre) || pre;
            const content = code.innerText || code.textContent || '';
            const filename = extractCodeFilename(pre, ++snippetCounter);

            downloadBlob(content, filename, 'text/plain;charset=utf-8');
            toast('Downloaded ' + filename);
        });

        container.appendChild(button);
    }

    // ══════════════════════════════════════════════════════════════════
    // TEXT MODE
    // ══════════════════════════════════════════════════════════════════

    function applyTextMode() {
        if (!currentLog) return;

        const visibleMessages = getMessages(currentLog).filter(
            message => message.dataset.ccHidden !== '1'
        );

        for (const message of visibleMessages) {
            for (const pre of qa('pre', message)) {
                const code = q('code', pre) || pre;
                const originalContent = code.innerText || code.textContent || '';

                // Store original content for restoration
                if (!pre.dataset.ccOriginalCode) {
                    pre.dataset.ccOriginalCode = originalContent;
                }

                if (cfg.textMode) {
                    const language = detectCodeLanguage(pre) || 'text';
                    const lineCount = originalContent.split('\n').length;

                    // Try to extract a filename from nearby labels
                    const filename = extractCodeFilename(pre, 0);
                    const isFilename = filename && filename !== 'snippet-0.txt' && !filename.startsWith('snippet-');

                    let description;
                    if (isFilename) {
                        description = 'Examined file: ' + filename;
                    } else {
                        description = '[Code block: ' + language + ', ' + lineCount + ' lines]';
                    }

                    pre.setAttribute('data-cc-textdesc', description);
                    pre.style.setProperty('max-height', '48px', 'important');

                    // Hide actual code content
                    const innerCode = q('code', pre);
                    if (innerCode) {
                        innerCode.style.setProperty('display', 'none', 'important');
                    }
                } else {
                    // Restore original code content
                    pre.removeAttribute('data-cc-textdesc');
                    pre.style.removeProperty('max-height');

                    const innerCode = q('code', pre);
                    if (innerCode) {
                        innerCode.style.removeProperty('display');
                    }
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

        const codeBlocks = messages.reduce((sum, message) =>
            sum + qa('pre', message).length, 0
        );

        const thinkingBlocks = log ? getThinkingButtons(log).length : 0;

        const totalTokens = Math.ceil(totalText.length / 4);
        const visibleTokens = Math.ceil(visibleText.length / 4);
        const context = Math.max(1, Number(cfg.contextWindow) || 200000);
        const percentage = Math.min(100, totalTokens / context * 100);

        return {
            total: messages.length,
            visible: visibleMessages.length,
            hidden: messages.length - visibleMessages.length,
            totalChars: totalText.length,
            visibleChars: visibleText.length,
            codeBlocks,
            thinkingBlocks,
            totalTokens,
            visibleTokens,
            hiddenTokens: Math.max(0, totalTokens - visibleTokens),
            context,
            percentage
        };
    }

    function refreshStatistics() {
        if (!drawerOpen || activeTab !== 'statistics') return;
        if (!drawer?.isConnected) return;

        const stats = countStats();
        const percentage = stats.percentage;
        const color = percentage > 90
            ? 'var(--cc-danger)'
            : percentage >= 70
                ? 'var(--cc-accent)'
                : 'var(--cc-success)';

        const put = (id, value) => {
            const el = q('#' + id, drawer);
            if (el) el.textContent = value;
        };

        put('cc-context-main', formatCompact(stats.totalTokens) + ' / ' + formatCompact(stats.context));
        put('cc-context-percent', percentage.toFixed(1) + '%');
        put('cc-stat-total-messages', formatNumber(stats.total));
        put('cc-stat-visible-messages', formatNumber(stats.visible));
        put('cc-stat-hidden-messages', formatNumber(stats.hidden));
        put('cc-stat-total-tokens', formatCompact(stats.totalTokens));
        put('cc-stat-visible-tokens', formatCompact(stats.visibleTokens));
        put('cc-stat-hidden-tokens', formatCompact(stats.hiddenTokens));
        put('cc-stat-chars', formatNumber(stats.totalChars));
        put('cc-stat-code', formatNumber(stats.codeBlocks));
        put('cc-stat-thinking', formatNumber(stats.thinkingBlocks));

        const fill = q('#cc-context-fill', drawer);
        if (fill) {
            fill.style.width = percentage + '%';
            fill.style.background = color;
        }

        statisticsLastRefresh = Date.now();
    }

    function formatCompact(n) {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }

    // ══════════════════════════════════════════════════════════════════
    // SETTINGS MODAL
    // ══════════════════════════════════════════════════════════════════

    function createSettingsModal() {
        if (settingsModal && settingsModal.isConnected) return settingsModal;

        settingsModal = document.createElement('div');
        settingsModal.id = 'cc-settings-modal';
        settingsModal.setAttribute('role', 'dialog');
        settingsModal.setAttribute('aria-modal', 'true');
        settingsModal.setAttribute('aria-label', 'Coding Edition Settings');
        settingsModal.className = 'cc-hidden';
        settingsModal.innerHTML = `
            <div class="cc-modal-backdrop" id="cc-modal-backdrop"></div>
            <div class="cc-modal-panel">
                <div class="cc-modal-header">
                    <div class="cc-modal-title">Coding Edition Settings</div>
                    <button class="cc-modal-close" type="button" aria-label="Close settings">×</button>
                </div>
                <div class="cc-modal-tabs">
                    <button class="cc-modal-tab cc-active" type="button" data-settings-tab="general">General</button>
                    <button class="cc-modal-tab" type="button" data-settings-tab="thinking">Thinking</button>
                    <button class="cc-modal-tab" type="button" data-settings-tab="scrolling">Scrolling</button>
                    <button class="cc-modal-tab" type="button" data-settings-tab="display">Display</button>
                    <button class="cc-modal-tab" type="button" data-settings-tab="diagnostics">Diagnostics</button>
                </div>
                <div class="cc-modal-body">
                    <div class="cc-modal-panel cc-active" data-settings-panel="general"></div>
                    <div class="cc-modal-panel" data-settings-panel="thinking"></div>
                    <div class="cc-modal-panel" data-settings-panel="scrolling"></div>
                    <div class="cc-modal-panel" data-settings-panel="display"></div>
                    <div class="cc-modal-panel" data-settings-panel="diagnostics"></div>
                </div>
            </div>
        `;

        const closeModal = () => {
            settingsModal.classList.remove('cc-visible');
            settingsModal.classList.add('cc-hidden');
        };

        settingsModal.querySelector('#cc-modal-backdrop').addEventListener('click', closeModal);
        settingsModal.querySelector('.cc-modal-close').addEventListener('click', closeModal);

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && settingsModal.classList.contains('cc-visible')) {
                closeModal();
            }
        }, true);

        qa('.cc-modal-tab', settingsModal).forEach(tab => {
            tab.addEventListener('click', () => {
                activeSettingsTab = tab.dataset.settingsTab;
                renderSettingsModal();
            });
        });

        document.documentElement.appendChild(settingsModal);
        return settingsModal;
    }

    function openSettingsModal() {
        const modal = createSettingsModal();
        activeSettingsTab = 'general';
        renderSettingsModal();
        modal.classList.remove('cc-hidden');
        // Allow one frame for display:block before fading in.
        requestAnimationFrame(() => modal.classList.add('cc-visible'));
    }

    function closeSettingsModal() {
        if (!settingsModal) return;
        settingsModal.classList.remove('cc-visible');
        settingsModal.classList.add('cc-hidden');
    }

    function renderSettingsModal() {
        if (!settingsModal || !settingsModal.isConnected) return;

        const body = q('.cc-modal-body', settingsModal);
        if (!body) return;

        // Update tab active states.
        qa('.cc-modal-tab', settingsModal).forEach(tab => {
            const active = tab.dataset.settingsTab === activeSettingsTab;
            tab.classList.toggle('cc-active', active);
            tab.setAttribute('aria-selected', String(active));
        });

        // Render the active panel.
        for (const panel of qa('.cc-modal-panel', body)) {
            panel.classList.toggle('cc-active', panel.dataset.settingsPanel === activeSettingsTab);
        }

        const panel = q('[data-settings-panel="' + activeSettingsTab + '"]', body);
        if (!panel) return;
        panel.replaceChildren();

        if (activeSettingsTab === 'general') renderSettingsGeneral(panel);
        else if (activeSettingsTab === 'thinking') renderSettingsThinking(panel);
        else if (activeSettingsTab === 'scrolling') renderSettingsScrolling(panel);
        else if (activeSettingsTab === 'display') renderSettingsDisplay(panel);
        else if (activeSettingsTab === 'diagnostics') renderSettingsDiagnostics(panel);
    }

    function toggleRowModal(parent, label, value, onChange) {
        const row = document.createElement('div');
        row.className = 'cc-row';
        row.appendChild(document.createElement('span'));
        row.firstElementChild.className = 'cc-label';
        row.firstElementChild.textContent = label;

        const button = document.createElement('button');
        button.className = 'cc-toggle' + (value ? ' cc-on' : '');
        button.type = 'button';
        button.setAttribute('role', 'switch');
        button.setAttribute('aria-checked', String(!!value));
        button.setAttribute('aria-label', label);

        const knob = document.createElement('span');
        knob.className = 'cc-knob';
        button.appendChild(knob);
        row.appendChild(button);
        parent.appendChild(row);

        button.addEventListener('click', () => {
            const next = !value;
            const accepted = onChange(next);
            if (accepted === false) return;

            value = next;
            button.classList.toggle('cc-on', value);
            button.setAttribute('aria-checked', String(value));
        });

        return row;
    }

    function valueRowModal(parent, label, value, promptText, validate, onSave) {
        const row = document.createElement('div');
        row.className = 'cc-row cc-clickable';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');

        const labelEl = document.createElement('span');
        labelEl.className = 'cc-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const valueEl = document.createElement('span');
        valueEl.className = 'cc-value';
        valueEl.textContent = String(value);
        row.appendChild(valueEl);
        parent.appendChild(row);

        const edit = () => {
            const input = prompt(promptText, String(value));
            if (input === null) return;

            const result = validate(input);
            if (result === null || result === undefined || result === false) {
                toast('Invalid value.', true);
                return;
            }

            onSave(result);
            renderSettingsModal();
        };

        row.addEventListener('click', edit);
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                edit();
            }
        });

        return row;
    }

    function infoRowModal(parent, label, value) {
        const row = document.createElement('div');
        row.className = 'cc-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'cc-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const valueEl = document.createElement('span');
        valueEl.className = 'cc-muted-value';
        valueEl.textContent = value;
        row.appendChild(valueEl);
        parent.appendChild(row);
        return row;
    }

    function renderSettingsGeneral(parent) {
        valueRowModal(parent, 'Visible messages', cfg.keepMessages,
            'Number of newest messages to keep visible (1–500):',
            value => {
                const n = Number(value);
                return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
            },
            value => { setting('keepMessages', value); rerunAfterSetting(); renderSettingsModal(); }
        );

        toggleRowModal(parent, 'Virtualize messages', cfg.virtualize, value => {
            setting('virtualize', value);
            rerunAfterSetting();
            renderSettingsModal();
        });

        toggleRowModal(parent, 'Flatten Shiki code', cfg.flattenCode, value => {
            setting('flattenCode', value);
            rerunAfterSetting();
            renderSettingsModal();
        });
    }

    function renderSettingsThinking(parent) {
        toggleRowModal(parent, 'Collapse old thinking', cfg.thinkingMode === 'collapse', value => {
            if (value) setThinkingMode('collapse');
            else {
                cfg.thinkingMode = 'collapse';
                setThinkingMode('expand');
            }
            renderSettingsModal();
        });

        toggleRowModal(parent, 'Keep thoughts expanded', cfg.thinkingMode === 'expand', value => {
            if (value) setThinkingMode('expand');
            else setThinkingMode('collapse');
            renderSettingsModal();
        });

        toggleRowModal(parent, 'Hide thinking entirely', cfg.thinkingMode === 'hide', value => {
            if (value) setThinkingMode('hide');
            else setThinkingMode('collapse');
            renderSettingsModal();
        });
    }

    function renderSettingsScrolling(parent) {
        toggleRowModal(parent, 'Auto-scroll', cfg.autoScroll, value => {
            setting('autoScroll', value);
            rerunAfterSetting();
            renderSettingsModal();
        });

        toggleRowModal(parent, 'Smooth scrolling', cfg.smoothScroll, value => {
            setting('smoothScroll', value);
            rerunAfterSetting();
            renderSettingsModal();
        });

        valueRowModal(parent, 'Scroll threshold', cfg.scrollThreshold + ' px',
            'Scroll threshold in pixels (20–500):',
            value => {
                const n = Number(value);
                return Number.isFinite(n) && n >= 20 && n <= 500 ? Math.round(n) : null;
            },
            value => { setting('scrollThreshold', value); rerunAfterSetting(); renderSettingsModal(); }
        );
    }

    function renderSettingsDisplay(parent) {
        toggleRowModal(parent, 'Compact mode', cfg.compactMode, value => {
            setting('compactMode', value);
            rerunAfterSetting();
            renderSettingsModal();
        });

        valueRowModal(parent, 'Font size', cfg.fontSize + ' px',
            'Font size in pixels (0 = inherit, 10–24):',
            value => {
                const n = Number(value);
                return Number.isInteger(n) && (n === 0 || (n >= 10 && n <= 24)) ? n : null;
            },
            value => { setting('fontSize', value); rerunAfterSetting(); renderSettingsModal(); }
        );

        toggleRowModal(parent, 'Hide Composer', cfg.hideComposer, value => {
            return toggleComposerVisibility(value);
        });

        toggleRowModal(parent, 'Eye toggle (hide non-userscript UI)', cfg.eyeToggle, value => {
            cfg.eyeToggle = value;
            saveConfig();
            updateDynamicCSS();
            if (cfg.eyeToggle) applyEyeToggle();
            else restoreEyeToggle();
            renderSettingsModal();
            toast(cfg.eyeToggle ? 'Non-userscript UI hidden' : 'All UI restored');
        });

        toggleRowModal(parent, 'Auto-click "page updated" banner', cfg.autoClickPageUpdated, value => {
            cfg.autoClickPageUpdated = value;
            saveConfig();
            renderSettingsModal();
        });

        toggleRowModal(parent, 'Auto-click Continue after PR merge', cfg.autoClickContinue, value => {
            cfg.autoClickContinue = value;
            saveConfig();
            renderSettingsModal();
        });

        toggleRowModal(parent, 'Text mode (hide code, show descriptions)', cfg.textMode, value => {
            cfg.textMode = value;
            saveConfig();
            updateDynamicCSS();
            applyTextMode();
            renderSettingsModal();
            toast(cfg.textMode ? 'Text mode enabled' : 'Text mode disabled');
        });
    }

    function renderSettingsDiagnostics(parent) {
        infoRowModal(parent, 'PR state', prState);
        infoRowModal(parent, 'Composer', findComposer() ? 'Found' : 'Not found');
        infoRowModal(parent, 'Virtualization', cfg.virtualize ? 'Enabled' : 'Disabled');
        infoRowModal(parent, 'Thinking mode', cfg.thinkingMode);
        infoRowModal(parent, 'Eye toggle', cfg.eyeToggle ? 'On' : 'Off');

        const reset = document.createElement('button');
        reset.className = 'cc-reset';
        reset.type = 'button';
        reset.textContent = 'Reset all settings';
        reset.addEventListener('click', () => {
            if (!confirm('Reset all Coding Edition settings to defaults?')) return;

            Object.assign(cfg, DEFAULTS);
            prState = 'none';
            saveConfig();
            restoreComposer();
            restoreEyeToggle();
            updateDynamicCSS();
            rerunAfterSetting();
            renderSettingsModal();
            toast('Settings reset to defaults.');
        });

        const resetSection = document.createElement('section');
        resetSection.className = 'cc-section';
        resetSection.appendChild(reset);
        parent.appendChild(resetSection);
    }

    // ══════════════════════════════════════════════════════════════════
    // DRAWER STATE
    // ══════════════════════════════════════════════════════════════════

    function openDrawer() {
        if (!drawer || !drawer.isConnected) createDrawer();

        drawerOpen = true;
        drawer.classList.add('cc-open');
        toggleButton?.classList.add('cc-open');
        if (toggleButton) {
            toggleButton.textContent = '‹';
            toggleButton.setAttribute('aria-expanded', 'true');
            toggleButton.setAttribute('aria-label', 'Close Coding Edition panel');
        }

        clearTimeout(outsideListenerTimer);
        outsideListenerTimer = setTimeout(() => {
            removeOutsideListener();

            outsideListener = event => {
                if (event.button !== 0) return;
                if (drawer?.contains(event.target)) return;
                if (toggleButton?.contains(event.target)) return;
                if (settingsModal?.contains(event.target)) return;
                closeDrawer();
            };

            document.addEventListener('mousedown', outsideListener, true);
        }, 0);

        renderDrawer();
    }

    function closeDrawer() {
        drawerOpen = false;
        drawer?.classList.remove('cc-open');
        toggleButton?.classList.remove('cc-open');

        if (toggleButton) {
            toggleButton.textContent = '›';
            toggleButton.setAttribute('aria-expanded', 'false');
            toggleButton.setAttribute('aria-label', 'Open Coding Edition panel');
        }

        clearTimeout(outsideListenerTimer);
        removeOutsideListener();
    }

    function removeOutsideListener() {
        if (outsideListener) {
            document.removeEventListener('mousedown', outsideListener, true);
            outsideListener = null;
        }
    }

    function toggleDrawer() {
        if (drawerOpen) closeDrawer();
        else openDrawer();
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && drawerOpen) closeDrawer();
    }

    document.addEventListener('keydown', onKeyDown, true);

    // ══════════════════════════════════════════════════════════════════
    // UI HELPERS
    // ══════════════════════════════════════════════════════════════════

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function section(parent, title) {
        const wrapper = el('section', 'cc-section');
        wrapper.appendChild(el('div', 'cc-section-label', title));
        const card = el('div', 'cc-card');
        wrapper.appendChild(card);
        parent.appendChild(wrapper);
        return card;
    }

    function toggleRow(parent, label, value, onChange) {
        const row = el('div', 'cc-row');
        row.appendChild(el('span', 'cc-label', label));

        const button = el('button', 'cc-toggle' + (value ? ' cc-on' : ''));
        button.type = 'button';
        button.setAttribute('role', 'switch');
        button.setAttribute('aria-checked', String(!!value));
        button.setAttribute('aria-label', label);

        const knob = el('span', 'cc-knob');
        button.appendChild(knob);
        row.appendChild(button);
        parent.appendChild(row);

        button.addEventListener('click', () => {
            const next = !value;
            const accepted = onChange(next);
            if (accepted === false) return;

            value = next;
            button.classList.toggle('cc-on', value);
            button.setAttribute('aria-checked', String(value));
        });

        return row;
    }

    function valueRow(parent, label, value, promptText, validate, onSave) {
        const row = el('div', 'cc-row cc-clickable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.appendChild(el('span', 'cc-label', label));

        const valueEl = el('span', 'cc-value', String(value));
        row.appendChild(valueEl);
        parent.appendChild(row);

        const edit = () => {
            const input = prompt(promptText, String(value));
            if (input === null) return;

            const result = validate(input);
            if (result === null || result === undefined || result === false) {
                toast('Invalid value.', true);
                return;
            }

            onSave(result);
            renderDrawer();
        };

        row.addEventListener('click', edit);
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                edit();
            }
        });

        return row;
    }

    function infoRow(parent, label, value) {
        const row = el('div', 'cc-row');
        row.appendChild(el('span', 'cc-label', label));
        row.appendChild(el('span', 'cc-muted-value', value));
        parent.appendChild(row);
        return row;
    }

    function actionItem(parent, icon, label, handler, disabled = false) {
        const button = el('button', 'cc-action' + (disabled ? ' cc-action-disabled' : ''));
        button.type = 'button';
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
        button.appendChild(el('span', 'cc-action-icon', icon));
        button.appendChild(el('span', '', label));
        button.addEventListener('click', handler);
        parent.appendChild(button);
        return button;
    }

    function setting(key, value) {
        cfg[key] = value;
        saveConfig();
    }

    function rerunAfterSetting() {
        updateDynamicCSS();
        renderDrawer();
        schedule();
    }

    // ══════════════════════════════════════════════════════════════════
    // RENDER TABS
    // ══════════════════════════════════════════════════════════════════

    function renderSettings(parent) {
        let card = section(parent, 'Virtualization');

        valueRow(card, 'Visible messages', cfg.keepMessages,
            'Number of newest messages to keep visible (1–500):',
            value => {
                const n = Number(value);
                return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
            },
            value => { setting('keepMessages', value); rerunAfterSetting(); }
        );

        toggleRow(card, 'Virtualize messages', cfg.virtualize, value => {
            setting('virtualize', value);
            rerunAfterSetting();
        });

        toggleRow(card, 'Flatten Shiki code', cfg.flattenCode, value => {
            setting('flattenCode', value);
            rerunAfterSetting();
        });

        card = section(parent, 'Status');

        const found = orderedMessages(currentLog);
        infoRow(card, 'Messages detected', formatNumber(found.messages.length) +
            ' · ' + formatNumber(found.messages.filter(m => m.dataset.ccHidden === '1').length) + ' hidden');
        infoRow(card, 'Direction', found.reversed ? 'Reversed' : 'Normal');
        infoRow(card, 'Composer', findComposer() ? 'Found' : 'Not found');
        infoRow(card, 'Virtualization', cfg.virtualize ? 'Enabled' : 'Disabled');
        infoRow(card, 'Thinking mode', cfg.thinkingMode);
        infoRow(card, 'Eye toggle', cfg.eyeToggle ? 'On' : 'Off');
        infoRow(card, 'PR state', prState);

        const reset = el('button', 'cc-reset', 'Reset all settings');
        reset.type = 'button';
        reset.addEventListener('click', () => {
            if (!confirm('Reset all Coding Edition settings to defaults?')) return;

            Object.assign(cfg, DEFAULTS);
            prState = 'none';
            saveConfig();
            restoreComposer();
            restoreEyeToggle();
            updateDynamicCSS();
            rerunAfterSetting();
            toast('Settings reset to defaults.');
        });

        const resetSection = el('section', 'cc-section');
        resetSection.appendChild(reset);
        parent.appendChild(resetSection);
    }

    function renderActions(parent) {
        const state = detectPRState();
        prState = state;

        const open = prState === 'open';
        const merged = prState === 'merged';

        let card = section(parent, 'GITHUB');

        const createBtn = actionItem(card, '📤', 'Create PR', createPR, open || merged);
        createBtn.id = 'cc-btn-create-pr';

        const mergeBtnEl = actionItem(card, '🔀', 'Merge PR', mergePR, !open);
        mergeBtnEl.id = 'cc-btn-merge-pr';

        // Sync disabled/aria state now that the buttons exist in the DOM.
        updatePRButtons();

        card = section(parent, 'Session');

        actionItem(card, '⌫', 'Clear chat', clearChat);

        toggleRow(card, 'Hide Composer', cfg.hideComposer, value => {
            return toggleComposerVisibility(value);
        });

        card = section(parent, 'Export');

        actionItem(card, '💾', 'Export conversation (HTML)', exportChatHTML);

        card = section(parent, 'Debug');

        actionItem(card, '⌕', 'Run diagnostics', runDiagnostics);
    }

    function renderStatistics(parent) {
        const stats = countStats();

        const hero = el('div', 'cc-hero');
        hero.appendChild(el('div', 'cc-hero-title', 'Context usage'));

        const numbers = el('div', 'cc-hero-numbers');
        numbers.appendChild(el('div', 'cc-hero-main', formatCompact(stats.totalTokens) +
            ' / ' + formatCompact(stats.context)));

        const percent = el('div', 'cc-hero-percent', stats.percentage.toFixed(1) + '%');
        numbers.appendChild(percent);
        hero.appendChild(numbers);

        const progress = el('div', 'cc-progress');
        const fill = el('div', 'cc-progress-fill');
        fill.id = 'cc-context-fill';
        fill.style.width = stats.percentage + '%';
        fill.style.background = stats.percentage > 90
            ? 'var(--cc-danger)'
            : stats.percentage >= 70
                ? 'var(--cc-accent)'
                : 'var(--cc-success)';
        progress.appendChild(fill);
        hero.appendChild(progress);

        const main = el('div', 'cc-hero-numbers');
        main.style.margin = '0 0 10px';
        main.appendChild(el('div', 'cc-hero-main', formatCompact(stats.totalTokens) +
            ' / ' + formatCompact(stats.context)));
        main.firstElementChild.id = 'cc-context-main';

        main.appendChild(el('div', 'cc-hero-percent', stats.percentage.toFixed(1) + '%'));
        main.lastElementChild.id = 'cc-context-percent';

        numbers.replaceChildren();
        numbers.appendChild(main.firstElementChild);
        numbers.appendChild(main.lastElementChild);

        parent.appendChild(hero);

        const addGrid = (title, entries) => {
            parent.appendChild(el('div', 'cc-section-label', title));
            const grid = el('div', 'cc-grid3');

            for (const [label, value, id] of entries) {
                const stat = el('div', 'cc-stat');
                stat.appendChild(el('div', 'cc-stat-title', label));
                const valueEl = el('div', 'cc-stat-value', formatNumber(value));
                valueEl.id = id;
                stat.appendChild(valueEl);
                grid.appendChild(stat);
            }

            parent.appendChild(grid);
        };

        addGrid('Messages', [
            ['Total', stats.total, 'cc-stat-total-messages'],
            ['Visible', stats.visible, 'cc-stat-visible-messages'],
            ['Hidden', stats.hidden, 'cc-stat-hidden-messages']
        ]);

        addGrid('Tokens', [
            ['Total', formatCompact(stats.totalTokens), 'cc-stat-total-tokens'],
            ['Visible', formatCompact(stats.visibleTokens), 'cc-stat-visible-tokens'],
            ['Hidden', formatCompact(stats.hiddenTokens), 'cc-stat-hidden-tokens']
        ]);

        const card = section(parent, 'Content');
        infoRow(card, 'Total characters', formatNumber(stats.totalChars));
        infoRow(card, 'Code blocks', formatNumber(stats.codeBlocks));
        infoRow(card, 'Thinking blocks', formatNumber(stats.thinkingBlocks));

        parent.appendChild(el('div', 'cc-footer-note',
            'Token counts are estimates (~4 chars/token). Context usage is estimated from all detected message text.'));
    }

    function renderDrawer() {
        if (!drawer || !drawer.isConnected) return;

        const content = q('.cc-content', drawer);
        if (!content) return;

        content.replaceChildren();

        if (activeTab === 'settings') renderSettings(content);
        else if (activeTab === 'actions') renderActions(content);
        else renderStatistics(content);

        qa('.cc-tab', drawer).forEach(tab => {
            const active = tab.dataset.tab === activeTab;
            tab.classList.toggle('cc-active', active);
            tab.setAttribute('aria-selected', String(active));
        });

        if (activeTab === 'statistics' && drawerOpen) refreshStatistics();
    }

    // ══════════════════════════════════════════════════════════════════
    // CREATE DRAWER
    // ══════════════════════════════════════════════════════════════════

    function createDrawer() {
        if (!document.documentElement) return;

        if (!drawer || !drawer.isConnected) {
            drawer = el('aside');
            drawer.id = 'cc-drawer';
            drawer.setAttribute('aria-label', 'Arena.ai Coding Edition');
            drawer.innerHTML = `
                <div class="cc-header">
                    <div>
                        <div class="cc-brand">Arena.ai | Coding Edition</div>
                        <div class="cc-version">Performance tools · v3.4.0</div>
                    </div>
                    <button class="cc-icon-button" type="button" data-cc-close aria-label="Close panel">×</button>
                </div>
                <div class="cc-tabs" role="tablist" aria-label="Coding Edition sections">
                    <button class="cc-tab cc-active" type="button" role="tab" data-tab="actions">
                        <span class="cc-tab-icon">📋</span>
                        <span class="cc-tab-label" aria-hidden="true">Actions</span>
                    </button>
                    <button class="cc-tab" type="button" role="tab" data-tab="statistics">
                        <span class="cc-tab-icon">📊</span>
                        <span class="cc-tab-label" aria-hidden="true">Statistics</span>
                    </button>
                    <button id="cc-eye-toggle" class="cc-tab-gear" type="button" role="switch" aria-pressed="false" aria-label="Hide non-userscript UI (eye open)">👁️</button>
                    <button class="cc-tab-gear" type="button" data-cc-settings aria-label="Open settings">⚙</button>
                </div>
                <div class="cc-content"></div>
            `;

            drawer.querySelector('[data-cc-close]').addEventListener('click', closeDrawer);

            drawer.querySelector('[data-cc-settings]').addEventListener('click', (event) => {
                event.stopPropagation();
                event.preventDefault();
                try {
                    openSettingsModal();
                } catch (error) {
                    console.error('[CC] Settings modal error:', error);
                    toast('Settings modal failed to open.', true);
                }
            });

            // Wire eye button inside drawer bar.
            const eyeInDrawer = q('#cc-eye-toggle', drawer);
            if (eyeInDrawer && eyeInDrawer !== eyeButton) {
                eyeButton = eyeInDrawer;
                eyeButton.textContent = cfg.eyeToggle ? '👁️' : '🙈';
                eyeButton.setAttribute('aria-pressed', String(cfg.eyeToggle));
                eyeButton.setAttribute('aria-label',
                    cfg.eyeToggle
                        ? 'Hide non-userscript UI (eye open)'
                        : 'Show all UI (eye closed)'
                );
                eyeButton.addEventListener('click', () => {
                    cfg.eyeToggle = !cfg.eyeToggle;
                    saveConfig();
                    updateDynamicCSS();
                    eyeButton.textContent = cfg.eyeToggle ? '👁️' : '🙈';
                    eyeButton.setAttribute('aria-pressed', String(cfg.eyeToggle));
                    eyeButton.setAttribute('aria-label',
                        cfg.eyeToggle
                            ? 'Hide non-userscript UI (eye open)'
                            : 'Show all UI (eye closed)'
                    );
                    if (cfg.eyeToggle) applyEyeToggle();
                    else restoreEyeToggle();
                    toast(cfg.eyeToggle ? 'Non-userscript UI hidden' : 'All UI restored');
                });
            }

            qa('.cc-tab', drawer).forEach(tab => {
                tab.addEventListener('click', () => {
                    activeTab = tab.dataset.tab;
                    renderDrawer();
                });
            });

            document.documentElement.appendChild(drawer);
        }

        if (!toggleButton || !toggleButton.isConnected) {
            toggleButton = el('button', '', '›');
            toggleButton.id = 'cc-toggle';
            toggleButton.type = 'button';
            toggleButton.title = 'Arena.ai Coding Edition';
            toggleButton.setAttribute('aria-label', 'Open Coding Edition panel');
            toggleButton.setAttribute('aria-expanded', 'false');
            toggleButton.addEventListener('click', toggleDrawer);
            document.documentElement.appendChild(toggleButton);
        }

        if (drawerOpen) {
            drawer.classList.add('cc-open');
            toggleButton.classList.add('cc-open');
            toggleButton.textContent = '‹';
        }

        renderDrawer();
    }

    // ══════════════════════════════════════════════════════════════════
    // NAV BAR EXPORT BUTTON (top nav, left of diff viewer)
    // ══════════════════════════════════════════════════════════════════

    function createNavExportButton() {
        if (!cfg.showExport) {
            navExportButton?.remove();
            navExportButton = null;
            return;
        }

        if (navExportButton && navExportButton.isConnected) return;

        navExportButton = document.createElement('button');
        navExportButton.id = 'cc-nav-export';
        navExportButton.type = 'button';
        navExportButton.title = 'Export conversation (HTML)';
        navExportButton.setAttribute('aria-label', 'Export conversation (HTML)');
        navExportButton.innerHTML = '<span style="font-size:16px;line-height:1;">💾</span>';
        navExportButton.addEventListener('click', exportChatHTML);

        // Try to insert immediately to the left of Arena's diff viewer control.
        const diffViewer = q('[aria-label*="diff" i], [title*="diff" i], button[class*="diff" i], [data-testid*="diff" i]');
        if (diffViewer && diffViewer.parentElement) {
            diffViewer.parentElement.insertBefore(navExportButton, diffViewer);
        } else {
            // Fallback: attach near the top of the document.
            document.documentElement.insertBefore(navExportButton, document.documentElement.firstChild);
        }
    }

    function refreshNavExportButton() {
        if (!cfg.showExport) {
            navExportButton?.remove();
            navExportButton = null;
            return;
        }

        if (!navExportButton || !navExportButton.isConnected) {
            createNavExportButton();
            return;
        }

        // If React re-rendered the nav and moved/removed our button, re-insert
        // beside the diff viewer control.
        const diffViewer = q('[aria-label*="diff" i], [title*="diff" i], button[class*="diff" i], [data-testid*="diff" i]');
        if (diffViewer && diffViewer.parentElement) {
            const currentParent = navExportButton.parentElement;
            if (currentParent !== diffViewer.parentElement) {
                diffViewer.parentElement.insertBefore(navExportButton, diffViewer);
            }
        }
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

        createDrawer();
        createNavExportButton();
        refreshNavExportButton();

        // Eye toggle state persistence across re-renders.
        updateDynamicCSS();
        if (cfg.eyeToggle) {
            document.documentElement.dataset.ccEye = '1';
            applyEyeToggle();
        }

        const log = findLog();

        if (log !== currentLog) {
            if (currentLog) {
                teardownAutoScroll();
            }

            currentLog = log;

            if (log) {
                rebuildAutoScroll(log);
                lastMessageCount = -1;
                lastCollapseCount = -1;
                lastExpandCount = -1;
                lastVirtualSignature = '';
            }
        }

        if (!currentLog) {
            updateJumpButton();
            return;
        }

        const count = getMessages(currentLog).length;
        const increased = count > lastMessageCount;
        lastMessageCount = count;

        virtualize();
        decorateCodeBlocks();
        applyTextMode();

        dispatchThinkingMode(false);

        if (cfg.hideComposer && !q('[data-cc-composer-hide="1"]')) {
            applyComposerHide();
        }

        if (cfg.autoScroll) {
            const scroller = scrollElement(currentLog);
            if (scroller && isNearBottom(scroller)) {
                if (increased) scrollToBottom(scroller);
            }
        }

        updateJumpButton();

        // Auto-click page-updated banner.
        watchPageUpdatedBanner();

        // Auto-click Continue button when PR is merged.
        clickContinueButton();

        if (drawerOpen && activeTab === 'statistics') refreshStatistics();
    }

    function startObservers() {
        if (!document.body) return;

        if (bodyObserver) bodyObserver.disconnect();

        bodyObserver = new MutationObserver(() => {
            schedule();
        });

        bodyObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        if (mainObserver) mainObserver.disconnect();

        mainObserver = new MutationObserver(() => {
            schedule();
        });

        mainObserver.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    function initialize() {
        if (!document.documentElement) {
            requestAnimationFrame(initialize);
            return;
        }

        injectStyle('cc-theme', THEME_CSS);
        injectStyle('cc-perf', `
            [data-cc-hidden="1"]{display:none!important;}
            [data-cc-flat="1"]{contain:content;}
        `);
        updateDynamicCSS();

        createDrawer();
        createNavExportButton();

        const log = findLog();
        if (log) {
            currentLog = log;
            rebuildAutoScroll(log);
            virtualize();
            decorateCodeBlocks();
            dispatchThinkingMode(true);
            applyTextMode();
            if (cfg.hideComposer) applyComposerHide();
            if (cfg.eyeToggle) applyEyeToggle();
            runSchedule();
        }

        if (document.body) startObservers();
        else {
            const waitForBody = new MutationObserver(() => {
                if (!document.body) return;
                waitForBody.disconnect();
                startObservers();
                schedule();
            });
            waitForBody.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }

        clearInterval(maintenanceTimer);
        maintenanceTimer = setInterval(() => {
            if (!drawer?.isConnected || !toggleButton?.isConnected) createDrawer();
            createNavExportButton();
            refreshNavExportButton();

            if (cfg.hideComposer && !q('[data-cc-composer-hide="1"]')) {
                applyComposerHide();
            }

            if (cfg.eyeToggle) {
                document.documentElement.dataset.ccEye = '1';
                applyEyeToggle();
            }

            if (cfg.textMode) {
                applyTextMode();
            }

            schedule();
        }, 5000);

        clearInterval(statsTimer);
        statsTimer = setInterval(() => {
            if (drawerOpen && activeTab === 'statistics') refreshStatistics();
        }, 1000);

        clearInterval(watchdogTimer);
        watchdogTimer = setInterval(() => {
            if (!q('#cc-drawer') || !q('#cc-toggle')) createDrawer();
            if (cfg.showExport && !q('#cc-nav-export')) createNavExportButton();
        }, 3000);

        console.info('[CC] Arena.ai Coding Edition v3.4.0 initialized.');
    }

    function waitForLog() {
        const attempt = () => {
            const log = findLog();
            if (log) {
                initialize();
                return true;
            }
            return false;
        };

        if (attempt()) return;

        const observer = new MutationObserver(() => {
            if (attempt()) observer.disconnect();
        });

        const startObserving = () => {
            if (document.body) {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            } else {
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true
                });
            }
        };

        startObserving();

        setTimeout(() => {
            if (!findLog()) {
                initialize();
            }
        }, 6000);
    }

    if (document.readyState === 'loading') {
        waitForLog();
    } else {
        waitForLog();
    }

})();
