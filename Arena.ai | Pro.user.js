/*
 * Arena.ai | Pro
 * Version: 3.4.0
 * Author: Piknockyou (vibe-coded)
 * License: AGPL-3.0
 *
 * Performance and productivity tools for Arena.ai conversations, including
 * user-configurable Agent Modes. No external runtime dependencies.
 */

// ==UserScript==
// @name         Arena.ai | Pro
// @namespace    https://arena.ai/
// @version      3.4.0
// @description  Conversation performance tools, exports, and configurable agent modes for Arena.ai.
// @author       Piknockyou (vibe-coded)
// @license      AGPL-3.0
// @match        *://*.arena.ai/*
// @match        *://*.canaryarena.ai/*
// @match        *://chat.lmsys.org/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '3.4.0';
    const STORAGE_KEY = 'arenaProConfig';
    if (window.__arenaPro340Installed) return;
    window.__arenaPro340Installed = true;

    const DEFAULTS = Object.freeze({
        keepMessages: 8,
        virtualize: true,
        flattenCode: true,
        cssNoiseRemoval: true,
        thinkingMode: 'collapse',
        autoScroll: true,
        smoothScroll: true,
        scrollThreshold: 150,
        hideComposer: false,
        composerCompact: false,
        showExport: true,
        contextWindow: 200000,
        composerSelector: '',
        agentModes: [],
        activeAgentModeId: ''
    });

    const q = (selector, root = document) => root.querySelector(selector);
    const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const ownSelector = '[data-ap-ui="1"]';
    const flattenCache = new WeakMap();
    const hiddenControlStyles = new WeakMap();
    const compactPanelStyles = new WeakMap();
    const composerPanelStyles = new WeakMap();
    const codeControlMap = new Map();

    let cfg = Object.assign({}, DEFAULTS, sanitizeConfig(readStore()));
    let drawer = null;
    let drawerToggle = null;
    let drawerContent = null;
    let currentTab = 'settings';
    let editingModeId = '';
    let composerModeButton = null;
    let composerMoreButton = null;
    let modePopup = null;
    let composerMenu = null;
    let toastElement = null;
    let jumpButton = null;
    let revealButton = null;
    let navExportButton = null;
    let currentLog = null;
    let currentMessageParent = null;
    let activeScroller = null;
    let mainObserver = null;
    let logObserver = null;
    let themeObserver = null;
    let scheduleTimer = null;
    let toastTimer = null;
    let statsTimer = null;
    let codeCounter = 0;
    let revealedExtra = 0;
    let hiddenCount = 0;
    let autoStickToBottom = true;
    let lastScrollTop = 0;
    let lastRevealAt = 0;
    let programmaticScrollUntil = 0;
    let allowNextSubmission = false;
    let modeSubmissionPending = false;
    let initialized = false;
    let composerHideTarget = null;
    let compactPanel = null;
    let menuOutsideHandler = null;
    let popupOutsideHandler = null;
    let scrollListeners = null;

    function readStore() {
        try {
            if (typeof GM_getValue === 'function') {
                let value = GM_getValue(STORAGE_KEY, {});
                if (typeof value === 'string') {
                    try { value = JSON.parse(value); } catch (_) { value = {}; }
                }
                return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            }
        } catch (error) {
            console.warn('[Arena Pro] GM_getValue failed; trying localStorage.', error);
        }
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const value = raw ? JSON.parse(raw) : {};
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (_) { return {}; }
    }

    function sanitizeConfig(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const out = {};
        for (const key of Object.keys(DEFAULTS)) {
            if (!(key in raw)) continue;
            const value = raw[key];
            const fallback = DEFAULTS[key];
            if (key === 'agentModes') {
                if (!Array.isArray(value)) continue;
                const seen = new Set();
                out.agentModes = value.filter(mode => {
                    if (!mode || typeof mode !== 'object') return false;
                    const id = String(mode.id || '').trim().slice(0, 100);
                    const name = String(mode.name || '').trim().slice(0, 80);
                    const prompt = String(mode.prompt || '').trim().slice(0, 30000);
                    if (!id || !name || !prompt || seen.has(id)) return false;
                    seen.add(id);
                    mode.id = id;
                    mode.name = name;
                    mode.prompt = prompt;
                    return true;
                }).map(mode => ({ id: String(mode.id), name: String(mode.name), prompt: String(mode.prompt) }));
                continue;
            }
            if (typeof fallback === typeof value) out[key] = value;
        }
        out.keepMessages = Math.max(1, Math.min(200, Math.floor(Number(out.keepMessages ?? DEFAULTS.keepMessages) || DEFAULTS.keepMessages)));
        out.scrollThreshold = Math.max(20, Math.min(2000, Number(out.scrollThreshold ?? DEFAULTS.scrollThreshold) || DEFAULTS.scrollThreshold));
        out.contextWindow = Math.max(1000, Math.min(10000000, Number(out.contextWindow ?? DEFAULTS.contextWindow) || DEFAULTS.contextWindow));
        out.composerSelector = String(out.composerSelector ?? DEFAULTS.composerSelector).slice(0, 300);
        if (!['collapse', 'expand', 'hide'].includes(out.thinkingMode)) out.thinkingMode = DEFAULTS.thinkingMode;
        if (!Array.isArray(out.agentModes)) out.agentModes = [];
        if (!out.agentModes.some(mode => mode.id === raw.activeAgentModeId)) out.activeAgentModeId = '';
        else out.activeAgentModeId = String(raw.activeAgentModeId);
        return out;
    }

    function saveConfig() {
        const value = Object.assign({}, cfg, { agentModes: cfg.agentModes.map(mode => ({ ...mode })) });
        const serialized = JSON.stringify(value);
        if (typeof GM_setValue === 'function') {
            try { GM_setValue(STORAGE_KEY, value); return; }
            catch (objectError) {
                try { GM_setValue(STORAGE_KEY, serialized); return; }
                catch (stringError) { console.warn('[Arena Pro] GM storage failed; trying localStorage.', stringError || objectError); }
            }
        }
        try { localStorage.setItem(STORAGE_KEY, serialized); }
        catch (error) {
            console.warn('[Arena Pro] Could not persist settings.', error);
            toast('Could not save settings. Check userscript storage permissions.', true);
        }
    }

    function make(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (value == null || value === false) continue;
            if (key === 'className') node.className = String(value);
            else if (key === 'textContent') node.textContent = String(value);
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
            else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
            else if (key in node && key !== 'role' && key !== 'ariaLabel' && !key.startsWith('aria') && key !== 'title') {
                try { node[key] = value; } catch (_) { node.setAttribute(key, String(value)); }
            } else {
                const attrName = key === 'ariaLabel' ? 'aria-label' : (/^aria[A-Z]/.test(key) ? key.replace(/[A-Z]/g, char => '-' + char.toLowerCase()) : key);
                node.setAttribute(attrName, String(value));
            }
        }
        for (const child of children.flat(Infinity)) {
            if (child == null || child === false) continue;
            node.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
        }
        if (node.setAttribute) node.setAttribute('data-ap-ui', '1');
        return node;
    }

    function isOwn(el) { return !!(el && el.closest && el.closest(ownSelector)); }
    function textContent(el) { return String(el?.textContent || '').trim(); }
    function safeText(el) {
        if (!el) return '';
        const clone = el.cloneNode(true);
        qa(ownSelector, clone).forEach(node => node.remove());
        return String(clone.textContent || '').trim();
    }
    function getActiveMode() { return cfg.agentModes.find(mode => mode.id === cfg.activeAgentModeId) || null; }
    function newId() { return 'mode-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
    function isInputLike(el) { return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable); }

    const STYLE = `
:root { --ap-bg:#fff; --ap-surface:#fafafa; --ap-surface-2:#f2f3f5; --ap-text:#18181b; --ap-muted:#71717a; --ap-border:#dedee3; --ap-hover:#f0f1f3; --ap-accent:#da6b32; --ap-accent-soft:#fff3e9; --ap-shadow:0 16px 44px rgba(0,0,0,.2); color-scheme:light; }
html[data-ap-theme="dark"] { --ap-bg:#151518; --ap-surface:#1d1d21; --ap-surface-2:#28282e; --ap-text:#f5f5f6; --ap-muted:#a1a1aa; --ap-border:#38383f; --ap-hover:#303037; --ap-accent:#ff9b63; --ap-accent-soft:#362319; --ap-shadow:0 18px 50px rgba(0,0,0,.48); color-scheme:dark; }
#ap-drawer,#ap-toggle,#ap-toast,#ap-jump,#ap-reveal,#ap-mode-popup,#ap-composer-menu,#ap-nav-export,#ap-code-layer { box-sizing:border-box; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
#ap-drawer,#ap-drawer *,#ap-toggle,#ap-toast,#ap-jump,#ap-reveal,#ap-mode-popup,#ap-composer-menu,#ap-nav-export,#ap-code-layer * { box-sizing:border-box; }
#ap-drawer { position:fixed; z-index:2147483000; inset:0 auto 0 0; width:340px; max-width:calc(100vw - 42px); height:100dvh; display:flex; flex-direction:column; color:var(--ap-text); background:var(--ap-bg); border-right:1px solid var(--ap-border); box-shadow:var(--ap-shadow); transform:translateX(-105%); transition:transform .2s ease; overflow:hidden; isolation:isolate; font-size:13px; line-height:1.45; }
#ap-drawer.ap-open { transform:translateX(0); }
#ap-toggle { position:fixed!important; z-index:2147483001!important; left:0!important; top:48%!important; width:29px!important; height:48px!important; padding:0!important; border:1px solid var(--ap-border)!important; border-left:0!important; border-radius:0 8px 8px 0!important; background:var(--ap-surface)!important; color:var(--ap-text)!important; cursor:pointer!important; font:22px/1 system-ui,sans-serif!important; box-shadow:var(--ap-shadow)!important; }
#ap-toggle.ap-open { left:min(340px,calc(100vw - 42px))!important; }
.ap-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:15px 14px 12px; border-bottom:1px solid var(--ap-border); flex:none; }
.ap-brand { font-weight:750; font-size:14px; letter-spacing:-.2px; }
.ap-version { color:var(--ap-muted); font-size:10px; margin-top:2px; }
.ap-header-actions { display:flex; gap:6px; }
.ap-icon { width:30px; height:30px; border:1px solid var(--ap-border); border-radius:6px; background:var(--ap-surface); color:var(--ap-text); cursor:pointer; font-size:17px; }
.ap-tabs { display:flex; flex:none; padding:0 8px; border-bottom:1px solid var(--ap-border); }
.ap-tab { flex:1; padding:10px 5px 8px; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--ap-muted); font:600 12px system-ui,sans-serif; cursor:pointer; }
.ap-tab[aria-selected="true"] { color:var(--ap-accent); border-bottom-color:var(--ap-accent); }
.ap-content { flex:1; overflow:auto; padding:12px; overscroll-behavior:contain; }
.ap-section { margin:0 0 15px; }
.ap-section-title { margin:0 0 8px; color:var(--ap-text); font-size:12px; font-weight:750; letter-spacing:.02em; }
.ap-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:9px 0; border-bottom:1px solid color-mix(in srgb,var(--ap-border) 60%,transparent); }
.ap-row:last-child { border-bottom:0; }
.ap-row-copy { min-width:0; }
.ap-row-label { display:block; color:var(--ap-text); font-weight:600; }
.ap-row-help { display:block; margin-top:2px; color:var(--ap-muted); font-size:11px; line-height:1.4; }
.ap-row input[type=checkbox] { width:16px; height:16px; accent-color:var(--ap-accent); flex:none; margin:2px 2px 0 0; }
.ap-field { display:block; margin:8px 0; color:var(--ap-muted); font-size:11px; font-weight:600; }
.ap-field input,.ap-field textarea,.ap-field select,.ap-number { display:block; width:100%; margin-top:4px; padding:8px 9px; border:1px solid var(--ap-border); border-radius:6px; background:var(--ap-surface); color:var(--ap-text); font:12px/1.45 system-ui,sans-serif; }
.ap-field textarea { min-height:105px; resize:vertical; }
.ap-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:32px; padding:6px 10px; border:1px solid var(--ap-border); border-radius:6px; background:var(--ap-surface); color:var(--ap-text); font:600 12px system-ui,sans-serif; cursor:pointer; }
.ap-btn:hover,.ap-menu-item:hover,.ap-tab:hover { background:var(--ap-hover); }
.ap-btn-primary { border-color:var(--ap-accent); background:var(--ap-accent-soft); color:var(--ap-text); }
.ap-btn-danger { color:#b42318; }
.ap-card { margin:8px 0; padding:10px; border:1px solid var(--ap-border); border-radius:8px; background:var(--ap-surface); }
.ap-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ap-mode-name { color:var(--ap-text); font-weight:700; overflow-wrap:anywhere; }
.ap-badge { display:inline-block; margin-left:5px; padding:2px 6px; border-radius:99px; background:var(--ap-accent-soft); color:var(--ap-accent); font-size:10px; font-weight:700; }
.ap-mode-preview { margin:7px 0; color:var(--ap-muted); font:11px/1.5 ui-monospace,SFMono-Regular,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
.ap-actions { display:flex; flex-wrap:wrap; gap:6px; }
.ap-muted { color:var(--ap-muted); font-size:11px; }
.ap-stat { margin:8px 0; padding:10px; border:1px solid var(--ap-border); border-radius:8px; background:var(--ap-surface); }
.ap-stat-line { display:flex; justify-content:space-between; gap:8px; margin:4px 0; color:var(--ap-muted); }
.ap-stat-line strong { color:var(--ap-text); font-variant-numeric:tabular-nums; }
.ap-progress { height:8px; overflow:hidden; margin:8px 0 3px; border-radius:99px; background:var(--ap-surface-2); }
.ap-progress > span { display:block; height:100%; width:0; border-radius:inherit; background:#16a34a; transition:width .15s ease,background .15s ease; }
.ap-error { color:#b42318!important; }
#ap-toast { position:fixed; z-index:2147483100; left:50%; bottom:24px; max-width:min(520px,calc(100vw - 24px)); padding:10px 14px; border:1px solid var(--ap-border); border-radius:8px; background:var(--ap-bg); color:var(--ap-text); box-shadow:var(--ap-shadow); opacity:0; transform:translate(-50%,10px); pointer-events:none; transition:opacity .15s,transform .15s; font-size:12px; }
#ap-toast.ap-visible { opacity:1; transform:translate(-50%,0); }
#ap-toast.ap-error { border-color:#d92d20; }
#ap-mode-popup,#ap-composer-menu { position:fixed; z-index:2147483200; min-width:210px; max-width:min(320px,calc(100vw - 16px)); max-height:min(70vh,520px); overflow:auto; padding:5px; border:1px solid var(--ap-border); border-radius:9px; background:var(--ap-bg); color:var(--ap-text); box-shadow:var(--ap-shadow); font-size:12px; }
.ap-popup-title { padding:7px 9px 5px; color:var(--ap-muted); font-size:10px; font-weight:750; text-transform:uppercase; letter-spacing:.06em; }
.ap-menu-item { display:flex; align-items:center; gap:8px; width:100%; min-height:33px; padding:7px 9px; border:0; border-radius:5px; background:transparent; color:var(--ap-text); text-align:left; font:12px system-ui,sans-serif; cursor:pointer; }
.ap-menu-item[aria-checked="true"] { color:var(--ap-accent); font-weight:750; }
.ap-menu-divider { height:1px; margin:4px 2px; background:var(--ap-border); }
.ap-menu-icon { display:inline-flex; width:18px; justify-content:center; flex:none; }
.ap-composer-mode { display:inline-flex!important; align-items:center!important; gap:5px!important; white-space:nowrap!important; }
.ap-composer-more { min-width:30px!important; padding:0 8px!important; font-size:17px!important; line-height:1!important; }
#ap-composer-menu { z-index:2147483210; }
[data-ap-compact-panel="1"] { padding:5px!important; gap:4px!important; min-height:0!important; }
[data-ap-compact-hidden="1"] { display:none!important; }
#ap-jump { position:fixed; z-index:2147482000; right:18px; bottom:100px; width:38px; height:38px; border:1px solid var(--ap-border); border-radius:50%; background:var(--ap-bg); color:var(--ap-text); box-shadow:var(--ap-shadow); font:20px system-ui,sans-serif; cursor:pointer; }
#ap-reveal { position:fixed; z-index:2147482000; top:12px; left:50%; transform:translateX(-50%); padding:7px 12px; border:1px solid var(--ap-border); border-radius:99px; background:var(--ap-bg); color:var(--ap-text); box-shadow:var(--ap-shadow); font:12px system-ui,sans-serif; cursor:pointer; }
#ap-code-layer { position:fixed; inset:0; z-index:2147481000; pointer-events:none; }
.ap-code-actions { position:fixed; display:flex; gap:4px; pointer-events:auto; }
.ap-code-action { width:28px; height:26px; border:1px solid var(--ap-border); border-radius:5px; background:var(--ap-bg); color:var(--ap-text); box-shadow:0 1px 4px rgba(0,0,0,.16); font:13px system-ui,sans-serif; cursor:pointer; opacity:.64; }
.ap-code-action:hover,.ap-code-action:focus-visible { opacity:1; }
#ap-nav-export { display:inline-flex; position:relative; align-items:center; justify-content:center; min-height:30px; margin:0 4px; padding:0 9px; border:1px solid var(--ap-border); border-radius:6px; background:var(--ap-surface); color:var(--ap-text); font-size:12px; font-weight:650; cursor:pointer; }
#ap-nav-export.ap-floating { position:fixed; z-index:2147482500; right:14px; top:12px; }
html[data-ap-perf="1"] [role="log"] [data-ap-message="1"] { contain:layout style; }
html[data-ap-perf="1"] [role="log"] *:not([data-ap-ui="1"]):not([data-ap-ui="1"] *) { -webkit-backdrop-filter:none!important; backdrop-filter:none!important; -webkit-filter:none!important; filter:none!important; box-shadow:none!important; transition-duration:0s!important; animation-duration:0s!important; }
[data-ap-hidden="1"] { display:none!important; }
[data-ap-thinking="1"] { display:none!important; }
#ap-drawer button:focus-visible,#ap-drawer input:focus-visible,#ap-drawer textarea:focus-visible,#ap-toggle:focus-visible,#ap-mode-popup button:focus-visible,#ap-composer-menu button:focus-visible { outline:2px solid var(--ap-accent); outline-offset:2px; }
@media(max-width:400px) { #ap-drawer { width:calc(100vw - 34px); } #ap-toggle.ap-open { left:calc(100vw - 34px)!important; } }
`;

    function injectStyle() {
        if (!document.documentElement) return;
        let style = document.getElementById('ap-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'ap-style';
            style.setAttribute('data-ap-ui', '1');
            (document.head || document.documentElement).appendChild(style);
        }
        if (style.textContent !== STYLE) style.textContent = STYLE;
    }

    function colorLightness(color) {
        const value = String(color || '').trim().toLowerCase();
        if (!value || value === 'transparent' || value.includes('var(')) return null;
        const hex = value.match(/^#([0-9a-f]{3,8})$/i);
        if (hex) {
            let h = hex[1];
            if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(char => char + char).join('');
            if (h.length >= 6) {
                const channels = [0, 2, 4].map(index => parseInt(h.slice(index, index + 2), 16) / 255);
                return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
            }
        }
        if (/^rgba?\(/.test(value)) {
            const alpha = value.match(/(?:,|\/)\s*([\d.]+%?)\s*\)$/);
            if (alpha && parseFloat(alpha[1]) <= (alpha[1].endsWith('%') ? 0.05 : 0.02)) return null;
        }
        const rgb = value.match(/rgba?\(\s*([\d.]+%?)[ ,]+([\d.]+%?)[ ,]+([\d.]+%?)/);
        if (rgb) {
            const channels = rgb.slice(1, 4).map(channel => channel.endsWith('%') ? parseFloat(channel) / 100 : parseFloat(channel) / 255);
            return channels.reduce((sum, channel, index) => sum + Math.max(0, Math.min(1, channel)) * [0.2126, 0.7152, 0.0722][index], 0);
        }
        const hsl = value.match(/(?:hsla?\()?\s*([\d.]+)(?:deg)?[ ,]+([\d.]+)%[ ,]+([\d.]+)%/);
        if (hsl) return Math.max(0, Math.min(100, parseFloat(hsl[3]))) / 100;
        return null;
    }

    function arenaIsDark() {
        const root = document.documentElement;
        if (!root) return false;
        const dataTheme = String(root.getAttribute('data-theme') || '').toLowerCase();
        const colorScheme = String(root.style.colorScheme || '').toLowerCase();
        if (root.classList.contains('dark') || root.classList.contains('theme-dark') || dataTheme === 'dark' || colorScheme === 'dark') return true;
        if (root.classList.contains('light') || root.classList.contains('theme-light') || dataTheme === 'light' || colorScheme === 'light') return false;
        try {
            const computed = getComputedStyle(root);
            const backgroundNames = ['--background', '--color-background', '--background-color', '--app-background', '--bg-primary', '--color-bg', '--surface'];
            for (const name of backgroundNames) {
                const lightness = colorLightness(computed.getPropertyValue(name));
                if (lightness != null) return lightness < 0.48;
            }
            const background = colorLightness(computed.backgroundColor);
            if (background != null) return background < 0.48;
        } catch (_) { /* use system theme as the final fallback */ }
        try { return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) { return false; }
    }

    function applyTheme() {
        if (!document.documentElement) return;
        document.documentElement.dataset.apTheme = arenaIsDark() ? 'dark' : 'light';
    }

    function toast(message, error = false, duration = 3000) {
        if (!document.body && !document.documentElement) return;
        if (!toastElement || !toastElement.isConnected) {
            toastElement = make('div', { id: 'ap-toast', role: 'status', ariaLive: 'polite' });
            (document.body || document.documentElement).appendChild(toastElement);
        }
        toastElement.textContent = String(message);
        toastElement.classList.toggle('ap-error', !!error);
        toastElement.classList.add('ap-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastElement?.classList.remove('ap-visible'), duration);
    }

    function closeDrawer() {
        drawer?.classList.remove('ap-open');
        drawerToggle?.classList.remove('ap-open');
        drawerToggle?.setAttribute('aria-expanded', 'false');
    }

    function openDrawer(tab = currentTab) {
        currentTab = ['settings', 'actions', 'statistics'].includes(tab) ? tab : 'settings';
        ensureDrawer();
        drawer?.classList.add('ap-open');
        drawerToggle?.classList.add('ap-open');
        drawerToggle?.setAttribute('aria-expanded', 'true');
        renderUI(true);
    }

    function toggleDrawer() { drawer?.classList.contains('ap-open') ? closeDrawer() : openDrawer(); }

    function ensureDrawer() {
        if (!document.documentElement) return;
        if (!drawer || !drawer.isConnected) {
            drawer = make('aside', { id: 'ap-drawer', ariaLabel: 'Arena.ai Pro controls' });
            const head = make('div', { className: 'ap-header' },
                make('div', {}, make('div', { className: 'ap-brand' }, 'Arena.ai | Pro'), make('div', { className: 'ap-version' }, 'v' + VERSION + ' · Agent tools')),
                make('div', { className: 'ap-header-actions' }, make('button', { className: 'ap-icon', type: 'button', ariaLabel: 'Close panel', title: 'Close', onclick: closeDrawer }, '×'))
            );
            const tabs = make('div', { className: 'ap-tabs', role: 'tablist' });
            for (const [id, label] of [['settings', 'Settings'], ['actions', 'Actions'], ['statistics', 'Statistics']]) {
                tabs.appendChild(make('button', { type: 'button', className: 'ap-tab', role: 'tab', dataset: { tab: id }, ariaSelected: id === currentTab ? 'true' : 'false', onclick: () => { currentTab = id; renderUI(true); } }, label));
            }
            drawerContent = make('div', { className: 'ap-content', role: 'tabpanel' });
            drawer.append(head, tabs, drawerContent);
            (document.body || document.documentElement).appendChild(drawer);
        }
        if (!drawerToggle || !drawerToggle.isConnected) {
            drawerToggle = make('button', { id: 'ap-toggle', type: 'button', title: 'Arena.ai | Pro', ariaLabel: 'Open Arena.ai Pro controls', ariaExpanded: 'false', onclick: toggleDrawer }, '›');
            (document.body || document.documentElement).appendChild(drawerToggle);
        }
        if (!modePopup || !modePopup.isConnected) {
            modePopup = make('div', { id: 'ap-mode-popup', role: 'menu', ariaLabel: 'Select agent mode', style: { display: 'none' } });
            (document.body || document.documentElement).appendChild(modePopup);
        }
        if (!composerMenu || !composerMenu.isConnected) {
            composerMenu = make('div', { id: 'ap-composer-menu', role: 'menu', ariaLabel: 'Composer controls', style: { display: 'none' } });
            (document.body || document.documentElement).appendChild(composerMenu);
        }
        if (!q('#ap-code-layer')) (document.body || document.documentElement).appendChild(make('div', { id: 'ap-code-layer', 'aria-hidden': 'true' }));
    }

    function row(label, help, checked, onChange) {
        const input = make('input', { type: 'checkbox', checked: !!checked, onchange: event => onChange(event.currentTarget.checked) });
        return make('label', { className: 'ap-row' }, make('span', { className: 'ap-row-copy' }, make('span', { className: 'ap-row-label' }, label), make('span', { className: 'ap-row-help' }, help)), input);
    }

    function field(label, value, options = {}) {
        const control = options.multiline
            ? make('textarea', { rows: options.rows || 5, value: value || '', placeholder: options.placeholder || '', maxlength: options.maxlength || 30000 })
            : make('input', { type: options.type || 'text', value: value || '', placeholder: options.placeholder || '', maxlength: options.maxlength || 300 });
        const wrapper = make('label', { className: 'ap-field' }, label, control);
        return { wrapper, control };
    }

    function settingChanged(mutator) {
        mutator();
        cfg = sanitizeConfig(cfg);
        saveConfig();
        applyComposerSettings();
        applyTheme();
        schedule();
        renderUI(true);
    }

    function renderAgentModes(parent) {
        parent.appendChild(make('h3', { className: 'ap-section-title' }, 'Agent Modes'));
        parent.appendChild(make('p', { className: 'ap-muted' }, 'Create reusable instructions. The selected mode prompt is prepended to each message you send from Arena’s composer. Select “Off” in the composer menu to send normally.'));

        if (!cfg.agentModes.length) {
            parent.appendChild(make('div', { className: 'ap-card ap-muted' }, 'No agent modes yet. Add one below by entering a name and the prompt to prepend.'));
        }

        for (const mode of cfg.agentModes) {
            const card = make('div', { className: 'ap-card' });
            if (editingModeId === mode.id) {
                const nameField = field('Mode name', mode.name, { placeholder: 'e.g. Code reviewer', maxlength: 80 });
                const promptField = field('Prepended prompt', mode.prompt, { multiline: true, rows: 6, placeholder: 'Instructions that will be placed before every user message.' });
                const save = make('button', { className: 'ap-btn ap-btn-primary', type: 'button', onclick: () => {
                    const name = nameField.control.value.trim();
                    const prompt = promptField.control.value.trim();
                    if (!name || !prompt) { toast('Both the mode name and prompt are required.', true); return; }
                    cfg.agentModes = cfg.agentModes.map(item => item.id === mode.id ? { ...item, name, prompt } : item);
                    editingModeId = '';
                    saveConfig();
                    renderUI(true);
                    ensureAgentControls();
                    toast('Agent mode updated.');
                } }, 'Save changes');
                const cancel = make('button', { className: 'ap-btn', type: 'button', onclick: () => { editingModeId = ''; renderUI(true); } }, 'Cancel');
                card.append(nameField.wrapper, promptField.wrapper, make('div', { className: 'ap-actions' }, save, cancel));
            } else {
                const active = cfg.activeAgentModeId === mode.id;
                const title = make('div', { className: 'ap-mode-name' }, mode.name, active ? make('span', { className: 'ap-badge' }, 'Active') : null);
                const preview = make('div', { className: 'ap-mode-preview' }, mode.prompt.length > 260 ? mode.prompt.slice(0, 260) + '…' : mode.prompt);
                const edit = make('button', { className: 'ap-btn', type: 'button', onclick: () => { editingModeId = mode.id; renderUI(true); } }, 'Edit');
                const remove = make('button', { className: 'ap-btn ap-btn-danger', type: 'button', onclick: () => {
                    cfg.agentModes = cfg.agentModes.filter(item => item.id !== mode.id);
                    if (cfg.activeAgentModeId === mode.id) cfg.activeAgentModeId = '';
                    saveConfig();
                    renderUI(true);
                    ensureAgentControls();
                    toast('Agent mode deleted.');
                } }, 'Delete');
                card.append(make('div', { className: 'ap-card-head' }, title), preview, make('div', { className: 'ap-actions' }, edit, remove));
            }
            parent.appendChild(card);
        }

        const nameField = field('Mode name', '', { placeholder: 'e.g. Strict TDD', maxlength: 80 });
        nameField.control.id = 'ap-mode-name';
        const promptField = field('Prepended prompt', '', { multiline: true, rows: 5, placeholder: 'Write failing tests first. Explain assumptions. Keep changes focused.' });
        promptField.control.id = 'ap-mode-prompt';
        const add = make('button', { className: 'ap-btn ap-btn-primary', id: 'ap-mode-add', type: 'button', onclick: () => {
            const name = nameField.control.value.trim();
            const prompt = promptField.control.value.trim();
            if (!name || !prompt) { toast('Both the mode name and prompt are required.', true); return; }
            const mode = { id: newId(), name, prompt };
            cfg.agentModes = [...cfg.agentModes, mode];
            saveConfig();
            renderUI(true);
            ensureAgentControls();
            toast('Agent mode added. Select it from the composer mode button.');
        } }, 'Add agent mode');
        parent.appendChild(make('div', { className: 'ap-card' }, make('h4', { className: 'ap-section-title' }, 'Add a mode'), nameField.wrapper, promptField.wrapper, add));
    }

    function renderSettings(parent) {
        parent.appendChild(make('h3', { className: 'ap-section-title' }, 'Performance'));
        parent.appendChild(row('Virtualize messages', 'Keep recent messages visible and reveal older history as you scroll up.', cfg.virtualize, value => settingChanged(() => { cfg.virtualize = value; if (!value) revealedExtra = 0; })));
        const keep = make('input', { className: 'ap-number', type: 'number', min: '1', max: '200', value: String(cfg.keepMessages), onchange: event => settingChanged(() => { cfg.keepMessages = Number(event.currentTarget.value); }) });
        parent.appendChild(make('label', { className: 'ap-field' }, 'Visible message count', keep));
        parent.appendChild(row('Flatten hidden code blocks', 'Strip syntax-token spans from virtualized messages; originals are retained for export.', cfg.flattenCode, value => settingChanged(() => { cfg.flattenCode = value; })));
        parent.appendChild(row('Remove CSS noise', 'Disable backdrop blur and expensive effects in large conversations.', cfg.cssNoiseRemoval, value => settingChanged(() => { cfg.cssNoiseRemoval = value; })));

        parent.appendChild(make('h3', { className: 'ap-section-title' }, 'Conversation'));
        const thinking = make('select', { onchange: event => settingChanged(() => { cfg.thinkingMode = event.currentTarget.value; }) },
            ...[['collapse', 'Collapse older reasoning'], ['expand', 'Expand all reasoning'], ['hide', 'Hide reasoning']].map(([value, label]) => make('option', { value, selected: cfg.thinkingMode === value }, label)));
        parent.appendChild(make('label', { className: 'ap-field' }, 'Thinking block mode', thinking));
        parent.appendChild(row('Auto-scroll', 'Follow streaming responses; scrolling upward pauses until you return to the bottom.', cfg.autoScroll, value => settingChanged(() => { cfg.autoScroll = value; })));
        parent.appendChild(row('Smooth auto-scroll', 'Use smooth scrolling when following streaming output.', cfg.smoothScroll, value => settingChanged(() => { cfg.smoothScroll = value; })));
        const threshold = make('input', { className: 'ap-number', type: 'number', min: '20', max: '2000', value: String(cfg.scrollThreshold), onchange: event => settingChanged(() => { cfg.scrollThreshold = Number(event.currentTarget.value); }) });
        parent.appendChild(make('label', { className: 'ap-field' }, 'Bottom threshold (px)', threshold));
        parent.appendChild(row('Hide composer', 'Collapse Arena’s input panel for distraction-free reading.', cfg.hideComposer, value => settingChanged(() => { cfg.hideComposer = value; })));
        parent.appendChild(row('Compact composer', 'Keep the text field, … menu, and Send/Cancel button visible.', cfg.composerCompact, value => settingChanged(() => { cfg.composerCompact = value; })));
        parent.appendChild(row('Show navbar HTML export', 'Show an export button beside Arena’s diff browser control.', cfg.showExport, value => settingChanged(() => { cfg.showExport = value; })));
        const context = make('input', { className: 'ap-number', type: 'number', min: '1000', max: '10000000', value: String(cfg.contextWindow), onchange: event => settingChanged(() => { cfg.contextWindow = Number(event.currentTarget.value); }) });
        parent.appendChild(make('label', { className: 'ap-field' }, 'Estimated context window (tokens)', context));
        const selector = field('Custom composer selector (optional)', cfg.composerSelector, { placeholder: 'textarea[placeholder="Message"]', maxlength: 300 });
        selector.control.addEventListener('change', event => settingChanged(() => { cfg.composerSelector = event.currentTarget.value.trim(); }));
        parent.appendChild(selector.wrapper);

        parent.appendChild(make('h3', { className: 'ap-section-title' }, 'Agent Mode Manager'));
        renderAgentModes(parent);
        parent.appendChild(make('button', { className: 'ap-btn ap-btn-danger', type: 'button', onclick: () => {
            cfg = Object.assign({}, DEFAULTS, { agentModes: [] });
            editingModeId = '';
            revealedExtra = 0;
            saveConfig();
            restoreComposerState();
            renderUI(true);
            schedule();
            toast('Arena.ai | Pro settings reset.');
        } }, 'Reset defaults'));
    }

    function renderActions(parent) {
        parent.appendChild(make('h3', { className: 'ap-section-title' }, 'Agent workflow'));
        parent.appendChild(make('p', { className: 'ap-muted' }, 'These shortcuts use Arena’s composer. PR requests are submitted to the active agent; this script does not call GitHub.'));
        parent.appendChild(make('div', { className: 'ap-actions' },
            make('button', { className: 'ap-btn', type: 'button', onclick: () => submitThroughComposer('Create a pull request for the current changes and provide the PR URL.') }, 'Create PR'),
            make('button', { className: 'ap-btn', type: 'button', onclick: () => submitThroughComposer('The pull request has been created. Please merge it and report the result.') }, 'Merge PR'),
            make('button', { className: 'ap-btn ap-btn-danger', type: 'button', onclick: clearChat }, 'Clear chat')
        ));
        parent.appendChild(make('h3', { className: 'ap-section-title', style: { marginTop: '18px' } }, 'Export & diagnostics'));
        parent.appendChild(make('div', { className: 'ap-actions' },
            make('button', { className: 'ap-btn', type: 'button', onclick: () => { const markdown = exportChatMarkdown(); downloadText(markdown, exportStem() + '.md', 'text/markdown;charset=utf-8'); toast('Markdown conversation exported.'); } }, 'Export chat (Markdown)'),
            make('button', { className: 'ap-btn', type: 'button', onclick: runDiagnostics }, 'Run diagnostics'),
            make('button', { className: 'ap-btn', type: 'button', onclick: () => exportConversationHTML() }, 'Export standalone HTML')
        ));
    }

    function renderStatistics(parent) {
        const messages = getMessages(currentLog);
        const fullText = messages.map(message => safeText(message)).join('\n');
        const chars = fullText.length;
        const tokens = Math.ceil(chars / 4);
        const percent = cfg.contextWindow ? (tokens / cfg.contextWindow) * 100 : 0;
        const codes = messages.reduce((sum, message) => sum + qa('pre', message).length, 0);
        const thinkCount = countThinkingBlocks(currentLog);
        const visible = messages.filter(message => message.dataset.apHidden !== '1').length;
        const stat = make('div', { className: 'ap-stat' });
        stat.append(
            statLine('Messages', formatNumber(messages.length)),
            statLine('Visible / virtualized', `${formatNumber(visible)} / ${formatNumber(messages.length - visible)}`),
            statLine('Estimated tokens (~4 chars/token)', '~' + formatNumber(tokens)),
            statLine('Characters', formatNumber(chars)),
            statLine('Code blocks', formatNumber(codes)),
            statLine('Thinking blocks', formatNumber(thinkCount)),
            statLine('Estimated context window', Math.min(100, percent).toFixed(1) + '%')
        );
        const progress = make('div', { className: 'ap-progress', role: 'progressbar', ariaLabel: 'Estimated context window usage', ariaValueNow: String(Math.min(100, Math.round(percent))), ariaValueMin: '0', ariaValueMax: '100' });
        const fill = make('span', { style: { width: Math.min(100, percent).toFixed(1) + '%', background: percent >= 90 ? '#d92d20' : percent >= 70 ? '#d97706' : '#16a34a' } });
        progress.appendChild(fill);
        stat.appendChild(progress);
        stat.appendChild(make('div', { className: 'ap-muted' }, formatNumber(tokens) + ' estimated tokens of ' + formatNumber(cfg.contextWindow) + '. This is a DOM-based estimate, not Arena’s actual token count.'));
        parent.appendChild(stat);
    }

    function statLine(label, value) { return make('div', { className: 'ap-stat-line' }, make('span', {}, label), make('strong', {}, value)); }
    function formatNumber(value) { return Number(value || 0).toLocaleString(); }

    function renderUI(force = false) {
        if (!drawerContent || !drawer?.isConnected) return;
        const active = document.activeElement;
        if (!force && drawer.contains(active) && isInputLike(active)) return;
        const scroll = drawerContent.scrollTop;
        qa('.ap-tab', drawer).forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.tab === currentTab)));
        drawerContent.replaceChildren();
        if (currentTab === 'settings') renderSettings(drawerContent);
        else if (currentTab === 'actions') renderActions(drawerContent);
        else renderStatistics(drawerContent);
        drawerContent.scrollTop = scroll;
    }

    function openPopupAt(anchor) {
        ensureDrawer();
        if (!modePopup) return;
        modePopup.replaceChildren();
        modePopup.appendChild(make('div', { className: 'ap-popup-title' }, 'Choose an agent mode'));
        const current = cfg.activeAgentModeId;
        const options = [{ id: '', name: 'Off · Standard Arena prompt', prompt: '' }, ...cfg.agentModes];
        for (const mode of options) {
            const item = make('button', { className: 'ap-menu-item', type: 'button', role: 'menuitemradio', ariaChecked: current === mode.id ? 'true' : 'false', title: mode.prompt ? mode.prompt.slice(0, 500) : 'Send without a prepended prompt', onclick: () => selectAgentMode(mode.id) }, make('span', { className: 'ap-menu-icon' }, current === mode.id ? '●' : '○'), make('span', {}, mode.name));
            modePopup.appendChild(item);
        }
        modePopup.appendChild(make('div', { className: 'ap-menu-divider' }));
        modePopup.appendChild(make('button', { className: 'ap-menu-item', type: 'button', role: 'menuitem', onclick: () => { closeModePopup(); openDrawer('settings'); setTimeout(() => q('#ap-mode-name', drawer)?.focus(), 30); } }, make('span', { className: 'ap-menu-icon' }, '⚙'), 'Manage modes…'));
        positionPopup(modePopup, anchor);
        modePopup.style.display = 'block';
        addPopupDismissal();
    }

    function positionPopup(popup, anchor) {
        popup.style.display = 'block';
        const rect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        const width = popup.offsetWidth || 240;
        const estimatedHeight = popup.offsetHeight || Math.min(440, 54 + popup.children.length * 35);
        const x = rect ? rect.left : Math.max(8, window.innerWidth - width - 8);
        let y = rect ? rect.top - estimatedHeight - 6 : 80;
        if (y < 8 && rect) y = rect.bottom + 6;
        popup.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, x)) + 'px';
        popup.style.top = Math.max(8, Math.min(window.innerHeight - estimatedHeight - 8, y)) + 'px';
    }

    function addPopupDismissal() {
        removePopupDismissal();
        popupOutsideHandler = event => {
            if (modePopup?.contains(event.target) || composerModeButton?.contains(event.target)) return;
            closeModePopup();
        };
        window.addEventListener('pointerdown', popupOutsideHandler, true);
    }

    function removePopupDismissal() {
        if (popupOutsideHandler) window.removeEventListener('pointerdown', popupOutsideHandler, true);
        popupOutsideHandler = null;
    }

    function closeModePopup() {
        if (modePopup) modePopup.style.display = 'none';
        removePopupDismissal();
    }

    function selectAgentMode(id) {
        const selected = id ? cfg.agentModes.find(mode => mode.id === id) : null;
        cfg.activeAgentModeId = selected ? selected.id : '';
        saveConfig();
        closeModePopup();
        updateModeButton();
        renderUI(true);
        toast(selected ? `Agent mode: ${selected.name}` : 'Agent mode off. Messages will be sent unchanged.');
    }

    function updateModeButton() {
        if (!composerModeButton) return;
        const active = getActiveMode();
        composerModeButton.textContent = active ? '◈ ' + active.name : 'Mode: Off';
        composerModeButton.title = active ? active.prompt.slice(0, 1000) : 'Select an agent mode. Off sends your prompt unchanged.';
        composerModeButton.setAttribute('aria-label', active ? 'Agent mode: ' + active.name : 'Agent mode: Off');
        composerModeButton.setAttribute('aria-pressed', String(!!active));
    }

    function modeButtonClick(event) {
        event.preventDefault();
        event.stopPropagation();
        openPopupAt(composerModeButton);
    }

    function labelForControl(control, index) {
        const candidates = [control.getAttribute('aria-label'), control.getAttribute('title'), control.getAttribute('data-testid'), control.getAttribute('name'), safeText(control)].map(value => String(value || '').trim()).filter(Boolean);
        let label = candidates.find(value => value.length > 0 && value.length < 100);
        if (!label && control.matches('input[type="file"]')) label = 'Attach file';
        if (!label && control === composerModeButton) label = 'Agent mode selector';
        if (!label) label = 'Composer control ' + (index + 1);
        return label.replace(/\s+/g, ' ').slice(0, 70);
    }

    function openComposerMenu() {
        if (!composerMenu || !composerMoreButton) return;
        const controls = compactControls();
        composerMenu.replaceChildren(make('div', { className: 'ap-popup-title' }, 'Composer controls'));
        if (composerModeButton && composerModeButton.dataset.apCompactHidden === '1') {
            composerMenu.appendChild(make('button', { className: 'ap-menu-item', type: 'button', role: 'menuitem', onclick: event => {
                const item = event.currentTarget;
                openPopupAt(item);
                closeComposerMenu();
            } }, make('span', { className: 'ap-menu-icon' }, '◈'), 'Agent mode: ' + (getActiveMode()?.name || 'Off')));
        }
        controls.forEach((control, index) => {
            const item = make('button', { className: 'ap-menu-item', type: 'button', role: 'menuitem', title: labelForControl(control, index), onclick: event => invokeCompactControl(control, event.currentTarget) });
            const icon = q('svg,img', control);
            item.appendChild(make('span', { className: 'ap-menu-icon' }, icon ? icon.cloneNode(true) : '•'));
            item.appendChild(document.createTextNode(labelForControl(control, index)));
            composerMenu.appendChild(item);
        });
        if (!controls.length && !composerModeButton) composerMenu.appendChild(make('div', { className: 'ap-muted', style: { padding: '8px' } }, 'No hidden composer controls found.'));
        positionPopup(composerMenu, composerMoreButton);
        composerMenu.style.display = 'block';
        menuOutsideHandler = event => {
            if (composerMenu?.contains(event.target) || composerMoreButton?.contains(event.target)) return;
            closeComposerMenu();
        };
        window.addEventListener('pointerdown', menuOutsideHandler, true);
    }

    function closeComposerMenu() {
        if (composerMenu) composerMenu.style.display = 'none';
        if (menuOutsideHandler) window.removeEventListener('pointerdown', menuOutsideHandler, true);
        menuOutsideHandler = null;
    }

    function compactControls() {
        const composer = findComposer();
        const panel = composerPanel(composer);
        if (!panel) return [];
        return qa('button,[role="button"],input,select,[role="combobox"]', panel).filter(control => {
            if (control === composer || control === composerMoreButton || control === composerModeButton || control === findSendButton(composer) || control.matches('textarea,[contenteditable="true"],[role="textbox"]')) return false;
            return control.dataset.apCompactHidden === '1' || !!control.closest('[data-ap-compact-hidden="1"]');
        }).filter((control, index, all) => all.indexOf(control) === index);
    }

    function saveInlineDisplay(el, targetMap) {
        if (targetMap.has(el)) return;
        targetMap.set(el, { value: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') });
    }

    function hideCompactControl(el) {
        if (el.dataset.apCompactHidden === '1') return;
        saveInlineDisplay(el, hiddenControlStyles);
        el.dataset.apCompactHidden = '1';
        el.setAttribute('data-ap-compact-display', JSON.stringify(hiddenControlStyles.get(el) || { value: '', priority: '' }));
        el.style.setProperty('display', 'none', 'important');
    }

    function restoreCompactControl(el) {
        if (el.dataset.apCompactHidden !== '1') return;
        const original = hiddenControlStyles.get(el);
        if (original?.value) el.style.setProperty('display', original.value, original.priority || '');
        else el.style.removeProperty('display');
        delete el.dataset.apCompactHidden;
        el.removeAttribute('data-ap-compact-display');
        hiddenControlStyles.delete(el);
    }

    function restoreCompactMode() {
        qa('[data-ap-compact-hidden="1"]').forEach(restoreCompactControl);
        if (compactPanel?.isConnected) {
            delete compactPanel.dataset.apCompactPanel;
            const old = compactPanelStyles.get(compactPanel);
            if (old) {
                if (old.padding) compactPanel.style.setProperty('padding', old.padding, old.paddingPriority);
                else compactPanel.style.removeProperty('padding');
                if (old.gap) compactPanel.style.setProperty('gap', old.gap, old.gapPriority);
                else compactPanel.style.removeProperty('gap');
                compactPanelStyles.delete(compactPanel);
            }
        }
        compactPanel = null;
        closeComposerMenu();
    }

    function applyCompactMode() {
        const composer = findComposer();
        const panel = composerPanel(composer);
        if (!cfg.composerCompact || !composer || !panel) { restoreCompactMode(); return; }
        if (compactPanel && compactPanel !== panel) restoreCompactMode();
        compactPanel = panel;
        if (!compactPanelStyles.has(panel)) {
            compactPanelStyles.set(panel, {
                padding: panel.style.getPropertyValue('padding'), paddingPriority: panel.style.getPropertyPriority('padding'),
                gap: panel.style.getPropertyValue('gap'), gapPriority: panel.style.getPropertyPriority('gap')
            });
        }
        panel.dataset.apCompactPanel = '1';
        const send = findSendButton(composer);
        const controls = qa('button,[role="button"],input,select,[role="combobox"]', panel);
        controls.forEach(control => {
            if (control.dataset.apCompactAnchor === '1') return;
            const keep = control === composer || control === composerMoreButton || control === send || control.matches('textarea,[contenteditable="true"],[role="textbox"]');
            if (keep) restoreCompactControl(control);
            else hideCompactControl(control);
        });
        if (composerModeButton && panel.contains(composerModeButton) && composerModeButton !== send) hideCompactControl(composerModeButton);
    }

    function temporarilyRevealControl(control, anchor) {
        const chain = [];
        let node = control;
        while (node && node !== document.body && node !== document.documentElement) {
            if (node.dataset?.apCompactHidden === '1') {
                saveInlineDisplay(node, hiddenControlStyles);
                const original = hiddenControlStyles.get(node);
                node.style.removeProperty('display');
                delete node.dataset.apCompactHidden;
                chain.push({ node, original });
            }
            node = node.parentElement;
        }
        control.dataset.apCompactAnchor = '1';
        const rect = anchor.getBoundingClientRect();
        const style = {
            position: control.style.getPropertyValue('position'), positionPriority: control.style.getPropertyPriority('position'),
            left: control.style.getPropertyValue('left'), leftPriority: control.style.getPropertyPriority('left'),
            top: control.style.getPropertyValue('top'), topPriority: control.style.getPropertyPriority('top'),
            width: control.style.getPropertyValue('width'), widthPriority: control.style.getPropertyPriority('width'),
            height: control.style.getPropertyValue('height'), heightPriority: control.style.getPropertyPriority('height'),
            visibility: control.style.getPropertyValue('visibility'), visibilityPriority: control.style.getPropertyPriority('visibility'),
            opacity: control.style.getPropertyValue('opacity'), opacityPriority: control.style.getPropertyPriority('opacity'),
            pointerEvents: control.style.getPropertyValue('pointer-events'), pointerEventsPriority: control.style.getPropertyPriority('pointer-events')
        };
        control.style.setProperty('position', 'fixed', 'important');
        control.style.setProperty('left', Math.round(rect.left) + 'px', 'important');
        control.style.setProperty('top', Math.round(rect.top) + 'px', 'important');
        control.style.setProperty('width', Math.max(1, rect.width) + 'px', 'important');
        control.style.setProperty('height', Math.max(1, rect.height) + 'px', 'important');
        control.style.setProperty('visibility', 'hidden', 'important');
        control.style.setProperty('opacity', '0', 'important');
        control.style.setProperty('pointer-events', 'none', 'important');
        return () => {
            for (const key of ['position', 'left', 'top', 'width', 'height', 'visibility', 'opacity', 'pointerEvents']) {
                const css = key.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
                const value = style[key];
                const priority = style[key + 'Priority'];
                if (value) control.style.setProperty(css, value, priority || '');
                else control.style.removeProperty(css);
            }
            delete control.dataset.apCompactAnchor;
            for (const { node: hiddenNode, original } of chain) {
                if (original?.value) hiddenNode.style.setProperty('display', original.value, original.priority || '');
                else hiddenNode.style.removeProperty('display');
                hiddenNode.dataset.apCompactHidden = '1';
            }
        };
    }

    function invokeCompactControl(control, anchor) {
        if (!control || !control.isConnected) { toast('That composer control is no longer available.', true); closeComposerMenu(); return; }
        const restore = temporarilyRevealControl(control, anchor);
        try { control.click(); } catch (error) { console.warn('[Arena Pro] Could not invoke composer control.', error); }
        closeComposerMenu();
        const stateObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => {
            if (control.getAttribute('data-state') !== 'open' && control.getAttribute('aria-expanded') !== 'true') {
                stateObserver.disconnect(); restore();
            }
        }) : null;
        if (stateObserver) stateObserver.observe(control, { attributes: true, attributeFilter: ['data-state', 'aria-expanded'] });
        setTimeout(() => { stateObserver?.disconnect(); restore(); }, 20000);
    }

    function applyComposerHide() {
        const composer = findComposer();
        const panel = composerPanel(composer);
        if (!cfg.hideComposer || !panel) { restoreComposerHide(); return; }
        if (composerHideTarget && composerHideTarget !== panel) restoreComposerHide();
        composerHideTarget = panel;
        if (!composerPanelStyles.has(panel)) {
            composerPanelStyles.set(panel, {
                display: panel.style.getPropertyValue('display'), displayPriority: panel.style.getPropertyPriority('display')
            });
        }
        panel.dataset.apComposerHidden = '1';
        panel.setAttribute('data-ap-composer-display', JSON.stringify(composerPanelStyles.get(panel) || { display: '', displayPriority: '' }));
        panel.style.setProperty('display', 'none', 'important');
    }

    function restoreComposerHide() {
        if (!composerHideTarget) return;
        const panel = composerHideTarget;
        delete panel.dataset.apComposerHidden;
        panel.removeAttribute('data-ap-composer-display');
        const old = composerPanelStyles.get(panel);
        if (old?.display) panel.style.setProperty('display', old.display, old.displayPriority || '');
        else panel.style.removeProperty('display');
        composerPanelStyles.delete(panel);
        composerHideTarget = null;
    }

    function restoreComposerState() {
        restoreComposerHide();
        restoreCompactMode();
    }

    function applyComposerSettings() {
        if (cfg.hideComposer) applyComposerHide(); else restoreComposerHide();
        if (cfg.composerCompact) applyCompactMode(); else restoreCompactMode();
    }

    function composerCandidates() {
        const selectors = 'textarea,input[type="text"],[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]';
        let candidates = qa(selectors).filter(el => !isOwn(el) && !el.matches('[disabled],[readonly],input[type="hidden"]'));
        if (cfg.composerSelector) {
            try {
                const specified = q(cfg.composerSelector);
                if (specified && !isOwn(specified)) {
                    const editable = specified.matches(selectors) ? specified : q(selectors, specified);
                    if (editable) return [editable];
                }
            } catch (_) { /* Ignore an invalid custom selector and use heuristics. */ }
        }
        const height = window.innerHeight || 800;
        return candidates.map(el => {
            const rect = el.getBoundingClientRect();
            const label = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.className || ''}`;
            let score = 0;
            if (rect.bottom > height * .65) score += 25;
            if (rect.width > 200) score += 10;
            if (el.tagName === 'TEXTAREA') score += 10;
            if (el.isContentEditable) score += 8;
            if (/message|prompt|chat|composer/i.test(label)) score += 15;
            if (/search/i.test(label)) score -= 25;
            if (el.closest('header,nav,aside,[role="navigation"]')) score -= 40;
            return { el, score };
        }).sort((a, b) => b.score - a.score).map(item => item.el);
    }

    function findComposer() { return composerCandidates()[0] || null; }

    function controlLabel(button) {
        return [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.getAttribute('name'), safeText(button)].filter(Boolean).join(' ').trim();
    }

    function isStopControl(button) { return /\b(stop|cancel|abort|interrupt)\b/i.test(controlLabel(button)); }
    function isSendControl(button) { return /\b(send|submit|send message|send prompt)\b/i.test(controlLabel(button)); }

    function isDisabledControl(button) {
        return !!(button?.disabled || button?.getAttribute('aria-disabled') === 'true');
    }

    function findSendButton(composer) {
        if (!composer) return null;
        let fallback = null;
        let node = composer;
        for (let depth = 0; depth < 9 && node; depth++, node = node.parentElement) {
            const buttons = qa('button,[role="button"]', node).filter(button => !isOwn(button));
            const send = buttons.filter(button => !isStopControl(button) && (isSendControl(button) || button.type === 'submit' || /send/i.test(button.getAttribute('data-testid') || '')));
            if (send.length) return send[send.length - 1];
            const stop = buttons.find(isStopControl);
            if (stop) return stop;
            if (!fallback && buttons.length) fallback = buttons[buttons.length - 1];
            if (node.tagName === 'FORM' || node.getAttribute('role') === 'composer') break;
            if (node === document.body || node === document.documentElement) break;
        }
        return fallback;
    }

    function composerPanel(composer) {
        if (!composer) return null;
        let node = composer.parentElement;
        let firstWithButton = null;
        for (let depth = 0; depth < 9 && node; depth++, node = node.parentElement) {
            if (node === document.body || node === document.documentElement) break;
            const label = String(node.className || '') + ' ' + String(node.id || '') + ' ' + (node.getAttribute('role') || '');
            if (/composer|prompt-input|chat-input|message-input/i.test(label) || node.getAttribute('role') === 'composer') return node;
            if (!firstWithButton && q('button,[role="button"]', node)) firstWithButton = node;
        }
        return firstWithButton || composer.parentElement;
    }

    function ensureAgentControls() {
        const composer = findComposer();
        const panel = composerPanel(composer);
        const send = findSendButton(composer);
        if (!composer || !panel) { applyComposerSettings(); return; }
        if (!composerModeButton || !composerModeButton.isConnected) {
            composerModeButton = make('button', { id: 'ap-mode-btn', className: 'ap-btn ap-composer-mode', type: 'button', title: 'Select an agent mode', onclick: modeButtonClick });
        }
        if (!composerMoreButton || !composerMoreButton.isConnected) {
            composerMoreButton = make('button', { id: 'ap-composer-more', className: 'ap-btn ap-composer-more', type: 'button', ariaLabel: 'More composer controls', title: 'More composer controls', onclick: event => { event.preventDefault(); event.stopPropagation(); composerMenu?.style.display === 'block' ? closeComposerMenu() : openComposerMenu(); } }, '…');
        }
        const anchor = send?.parentElement || composer.parentElement || panel;
        if (anchor) {
            if (send && send.parentElement === anchor) {
                if (composerModeButton.parentElement !== anchor || composerModeButton.nextElementSibling !== composerMoreButton) anchor.insertBefore(composerModeButton, send);
                if (composerMoreButton.parentElement !== anchor || composerMoreButton.nextElementSibling !== send) anchor.insertBefore(composerMoreButton, send);
            } else {
                if (composerModeButton.parentElement !== anchor) anchor.appendChild(composerModeButton);
                if (composerMoreButton.parentElement !== anchor) anchor.appendChild(composerMoreButton);
            }
        }
        updateModeButton();
        applyComposerSettings();
    }

    function getComposerValue(composer) {
        if (!composer) return '';
        if ('value' in composer) return String(composer.value || '');
        return String(composer.innerText || composer.textContent || '');
    }

    function setNativeValue(composer, value) {
        if (!composer) return;
        const text = String(value);
        if ('value' in composer) {
            const proto = composer.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
            const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(composer, text);
            else composer.value = text;
        } else {
            composer.textContent = text;
        }
        try {
            const event = typeof InputEvent === 'function'
                ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
                : new Event('input', { bubbles: true });
            composer.dispatchEvent(event);
            composer.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) { /* The value is still set; some hosts have limited event constructors. */ }
    }

    function nextFrame(callback) {
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(callback);
        else setTimeout(callback, 16);
    }

    function interceptComposerSubmit(event) {
        if (allowNextSubmission || modeSubmissionPending) return;
        const composer = findComposer();
        const activeMode = getActiveMode();
        const prompt = activeMode?.prompt.trim() || '';
        if (!composer || !prompt) return;
        let isEnter = false;
        if (event.type === 'keydown') {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
            if (event.target !== composer && !composer.contains(event.target)) return;
            isEnter = true;
        } else if (event.type === 'click') {
            const send = findSendButton(composer);
            if (!send || (event.target !== send && !send.contains(event.target))) return;
            if (isStopControl(send)) return;
        } else return;

        const original = getComposerValue(composer);
        if (!original.trim() || original.trimStart().startsWith(prompt)) return;
        const finalPrompt = prompt + '\n\n' + original;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        modeSubmissionPending = true;
        setNativeValue(composer, finalPrompt);
        composer.focus?.();
        nextFrame(() => {
            const send = findSendButton(composer);
            if (!composer.isConnected) {
                modeSubmissionPending = false;
                toast('Could not submit: Arena’s composer changed. Your prompt was not sent.', true);
                return;
            }
            if (send && !isDisabledControl(send) && !isStopControl(send)) {
                allowNextSubmission = true;
                try { send.click(); } finally { allowNextSubmission = false; }
            } else if (isEnter) {
                allowNextSubmission = true;
                try { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }
                finally { allowNextSubmission = false; }
            } else {
                toast('The composer is busy or its Send button is unavailable. The prefixed prompt is ready to send.', true, 4500);
            }
            setTimeout(() => { modeSubmissionPending = false; }, 900);
        });
    }

    function submitThroughComposer(message) {
        const composer = findComposer();
        if (!composer) { toast('Composer not found; the request was not sent.', true, 4000); return false; }
        const send = findSendButton(composer);
        setNativeValue(composer, message);
        composer.focus?.();
        if (!send || isStopControl(send)) {
            toast('Arena’s composer is busy. The request is filled in the composer; send it when ready.', true, 4500);
            return false;
        }
        nextFrame(() => {
            if (!composer.isConnected) return;
            const currentSend = findSendButton(composer);
            if (!currentSend || isDisabledControl(currentSend) || isStopControl(currentSend)) {
                toast('Arena’s composer became busy. The request remains in the composer.', true, 4500);
                return;
            }
            allowNextSubmission = true;
            try { currentSend.click(); } finally { allowNextSubmission = false; }
            toast('Request submitted through Arena’s composer.');
        });
        return true;
    }

    function closeMenus() { closeModePopup(); closeComposerMenu(); }

    function getLogCandidates() { return qa('[role="log"]'); }
    function findLog() {
        const logs = getLogCandidates();
        if (logs.length) return logs.reduce((best, item) => item.children.length > best.children.length ? item : best);
        return q('[data-testid*="conversation" i],main [class*="conversation" i]') || null;
    }

    function messageRank(el) {
        if (!el || el.nodeType !== 1 || isOwn(el) || el.matches('.h-0,[aria-hidden="true"],[data-ap-ui="1"]')) return 0;
        const text = String(el.textContent || '').trim();
        if (!text) return 0;
        const role = `${el.getAttribute('data-role') || ''} ${el.getAttribute('data-message-author-role') || ''} ${el.getAttribute('data-testid') || ''}`;
        const classes = String(el.className || '');
        if (/user|assistant|human|message|conversation-turn/i.test(role)) return 12;
        if (/\b(message|chat-message|turn|group)\b/i.test(classes)) return 10;
        if (el.querySelector('[data-message-author-role],[data-role="user"],[data-role="assistant"]')) return 9;
        if (el.querySelector('pre,.prose,[class*="prose" i],[class*="markdown" i],details,button[data-state]')) return 7;
        if (/^(P|LI|PRE|CODE|SPAN|UL|OL|STRONG|EM|SUMMARY|BUTTON)$/.test(el.tagName)) return 0;
        return text.length >= 28 ? 1 : 0;
    }

    function looksLikeMessage(el) { return messageRank(el) > 0; }

    function findMessageList(log) {
        if (!log) return { parent: null, messages: [] };
        const direct = Array.from(log.children).filter(looksLikeMessage);
        let best = { parent: log, messages: direct };
        let bestScore = direct.reduce((sum, message) => sum + messageRank(message), 0);
        let layer = [log];
        for (let depth = 0; depth < 7; depth++) {
            const next = [];
            for (const node of layer) {
                const found = Array.from(node.children).filter(looksLikeMessage);
                const score = found.reduce((sum, message) => sum + messageRank(message), 0);
                if (found.length && score > bestScore) {
                    best = { parent: node, messages: found };
                    bestScore = score;
                }
                for (const child of Array.from(node.children)) if (child.children.length) next.push(child);
            }
            layer = next;
            if (!layer.length) break;
        }
        return best;
    }

    function getMessages(log = currentLog) { return findMessageList(log).messages; }

    function isReversed(parent) {
        if (!parent) return false;
        try { return getComputedStyle(parent).flexDirection === 'column-reverse'; } catch (_) { return false; }
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
        for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
            try {
                const style = getComputedStyle(node);
                if (/(auto|scroll)/.test(style.overflowY || style.overflow || '') && node.scrollHeight >= node.clientHeight) return node;
            } catch (_) { /* continue to parent */ }
        }
        return log;
    }

    function isNearBottom(scroller = activeScroller) {
        if (!scroller) return true;
        if (isReversed(currentMessageParent)) return Math.abs(scroller.scrollTop) <= cfg.scrollThreshold;
        return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= cfg.scrollThreshold;
    }

    function isNearTop(scroller = activeScroller) {
        if (!scroller) return true;
        if (isReversed(currentMessageParent)) return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 80;
        return scroller.scrollTop <= 80;
    }

    function scrollToBottom(scroller = activeScroller) {
        if (!scroller) return;
        programmaticScrollUntil = Date.now() + (cfg.smoothScroll ? 850 : 120);
        if (isReversed(currentMessageParent)) {
            if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: 0, behavior: cfg.smoothScroll ? 'smooth' : 'auto' });
            else scroller.scrollTop = 0;
        } else if (typeof scroller.scrollTo === 'function') {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: cfg.smoothScroll ? 'smooth' : 'auto' });
        } else scroller.scrollTop = scroller.scrollHeight;
    }

    function updateFloatingControls() {
        if (hiddenCount > 0) {
            if (!revealButton || !revealButton.isConnected) {
                revealButton = make('button', { id: 'ap-reveal', type: 'button', title: 'Reveal older conversation messages', onclick: revealOlder }, '↑ Reveal older messages');
                (document.body || document.documentElement).appendChild(revealButton);
            }
            revealButton.textContent = `↑ Reveal older messages (${hiddenCount})`;
        } else { revealButton?.remove(); revealButton = null; }

        if (activeScroller && !isNearBottom(activeScroller)) {
            if (!jumpButton || !jumpButton.isConnected) {
                jumpButton = make('button', { id: 'ap-jump', type: 'button', ariaLabel: 'Jump to latest message', title: 'Jump to latest message', onclick: () => { scrollToBottom(); autoStickToBottom = true; revealedExtra = 0; virtualize(); } }, '↓');
                (document.body || document.documentElement).appendChild(jumpButton);
            }
        } else { jumpButton?.remove(); jumpButton = null; }
    }

    function flattenCode(message) {
        if (!cfg.flattenCode || !message) return;
        for (const pre of qa('pre', message)) {
            const code = q('code', pre);
            if (!code) continue;
            if (!flattenCache.has(code)) {
                if (!code.querySelector('span') && !/shiki/i.test(pre.className + ' ' + code.className)) continue;
                flattenCache.set(code, code.innerHTML);
            }
            if (pre.dataset.apFlattened !== '1') {
                code.textContent = code.textContent || '';
                pre.dataset.apFlattened = '1';
            }
        }
    }

    function restoreFlattened(message) {
        if (!message) return;
        for (const pre of qa('pre', message)) {
            const code = q('code', pre);
            const html = code && flattenCache.get(code);
            if (html != null) {
                code.innerHTML = html;
                delete pre.dataset.apFlattened;
            }
        }
    }

    function virtualize() {
        const log = currentLog || findLog();
        if (!log) return { total: 0, hidden: 0 };
        const data = orderedMessages(log);
        currentLog = log;
        currentMessageParent = data.parent;
        const { messages, newestFirst, reversed } = data;
        const visibleCount = Math.max(1, Math.min(200, Math.floor(Number(cfg.keepMessages) || 8) + revealedExtra));
        const visible = new Set(cfg.virtualize ? newestFirst.slice(0, visibleCount) : messages);
        for (const message of messages) {
            message.dataset.apMessage = '1';
            if (visible.has(message)) {
                delete message.dataset.apHidden;
                restoreFlattened(message);
            } else {
                message.dataset.apHidden = '1';
                flattenCode(message);
            }
        }
        hiddenCount = messages.filter(message => message.dataset.apHidden === '1').length;
        const large = cfg.cssNoiseRemoval && messages.length >= 20;
        if (document.documentElement) document.documentElement.dataset.apPerf = large ? '1' : '';
        updateFloatingControls();
        updateCodeControls();
        return { total: messages.length, hidden: hiddenCount, reversed, parent: data.parent };
    }

    function revealOlder() {
        if (!currentLog || !hiddenCount || !cfg.virtualize) return false;
        const scroller = activeScroller || scrollElement(currentLog);
        const before = scroller?.scrollHeight || 0;
        const batch = Math.max(4, Math.min(50, Number(cfg.keepMessages) || 8));
        revealedExtra += batch;
        lastRevealAt = Date.now();
        const reversed = isReversed(currentMessageParent);
        virtualize();
        nextFrame(() => {
            if (!scroller) return;
            const delta = scroller.scrollHeight - before;
            scroller.scrollTop += reversed ? -delta : delta;
            programmaticScrollUntil = Date.now() + 250;
            lastScrollTop = scroller.scrollTop;
        });
        return true;
    }

    function onScroll() {
        if (!activeScroller) return;
        const current = activeScroller.scrollTop;
        const movedTowardTop = isReversed(currentMessageParent) ? current > lastScrollTop : current < lastScrollTop;
        if (Date.now() > programmaticScrollUntil && movedTowardTop) autoStickToBottom = false;
        if (isNearBottom(activeScroller)) {
            autoStickToBottom = true;
            if (revealedExtra) {
                revealedExtra = 0;
                virtualize();
            }
        } else if (Date.now() > programmaticScrollUntil && movedTowardTop && isNearTop(activeScroller) && hiddenCount && Date.now() - lastRevealAt > 450) {
            revealOlder();
        }
        lastScrollTop = activeScroller.scrollTop;
        updateFloatingControls();
        positionCodeControls();
    }

    function attachScroller(log) {
        const scroller = scrollElement(log);
        if (scroller === activeScroller && scrollListeners) return;
        if (scrollListeners) {
            activeScroller?.removeEventListener('scroll', scrollListeners.scroll);
            activeScroller?.removeEventListener('wheel', scrollListeners.wheel);
            activeScroller?.removeEventListener('touchstart', scrollListeners.touchstart);
            activeScroller?.removeEventListener('touchmove', scrollListeners.touchmove);
        }
        activeScroller = scroller;
        if (!activeScroller) return;
        lastScrollTop = activeScroller.scrollTop;
        autoStickToBottom = isNearBottom(activeScroller);
        const wheel = event => {
            const towardOlder = isReversed(currentMessageParent) ? event.deltaY > 0 : event.deltaY < 0;
            if (towardOlder) {
                autoStickToBottom = false;
                if (hiddenCount && isNearTop(activeScroller) && Date.now() - lastRevealAt > 450) revealOlder();
            } else if (isNearBottom(activeScroller)) autoStickToBottom = true;
        };
        let touchY = null;
        const touchstart = event => { touchY = event.touches?.[0]?.clientY ?? null; };
        const touchmove = event => {
            const y = event.touches?.[0]?.clientY;
            const towardOlder = touchY != null && y != null && (isReversed(currentMessageParent) ? y < touchY : y > touchY);
            if (towardOlder) {
                autoStickToBottom = false;
                if (hiddenCount && isNearTop(activeScroller) && Date.now() - lastRevealAt > 450) revealOlder();
            }
            touchY = y ?? touchY;
        };
        const scroll = () => onScroll();
        activeScroller.addEventListener('scroll', scroll, { passive: true });
        activeScroller.addEventListener('wheel', wheel, { passive: true });
        activeScroller.addEventListener('touchstart', touchstart, { passive: true });
        activeScroller.addEventListener('touchmove', touchmove, { passive: true });
        scrollListeners = { scroll, wheel, touchstart, touchmove };
    }

    const THINKING_RE = /\b(think|thinking|thought|reasoning|reason|chain of thought)\b/i;

    function thinkingEntries(root = currentLog) {
        if (!root) return [];
        const entries = [];
        const seen = new Set();
        for (const details of qa('details', root)) {
            if (!THINKING_RE.test(textContent(q('summary', details) || details))) continue;
            seen.add(details);
            entries.push({ wrapper: details, trigger: q('summary', details), details: true });
        }
        for (const button of qa('button[data-state],button[aria-expanded]', root)) {
            if (!THINKING_RE.test(textContent(button) + ' ' + (button.getAttribute('aria-label') || '') + ' ' + (button.title || ''))) continue;
            let wrapper = button.parentElement;
            while (wrapper && wrapper !== root && !wrapper.matches('[data-state],.not-prose,[data-thinking-block]')) wrapper = wrapper.parentElement;
            wrapper = wrapper && wrapper !== root ? wrapper : button.parentElement;
            if (!wrapper || seen.has(wrapper)) continue;
            seen.add(wrapper);
            entries.push({ wrapper, trigger: button, details: false });
        }
        return entries;
    }

    function countThinkingBlocks(root = currentLog) { return thinkingEntries(root).length; }

    function applyThinkingMode() {
        if (!currentLog) return;
        const entries = thinkingEntries(currentLog);
        const order = orderedMessages(currentLog);
        const messages = order.messages;
        const latest = order.newestFirst[0];
        for (const entry of entries) {
            const { wrapper, trigger, details } = entry;
            if (cfg.thinkingMode === 'hide') {
                wrapper.dataset.apThinking = '1';
                continue;
            }
            delete wrapper.dataset.apThinking;
            if (details) {
                if (cfg.thinkingMode === 'expand') wrapper.open = true;
                else if (cfg.thinkingMode === 'collapse' && !latest?.contains(wrapper)) wrapper.open = false;
                continue;
            }
            const state = trigger.getAttribute('data-state') || (trigger.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed');
            const shouldClose = cfg.thinkingMode === 'collapse' && !latest?.contains(wrapper);
            const shouldOpen = cfg.thinkingMode === 'expand';
            if ((shouldClose && state === 'open') || (shouldOpen && state === 'closed')) trigger.click();
        }
        if (cfg.thinkingMode !== 'hide') qa('[data-ap-thinking="1"]', currentLog).forEach(node => delete node.dataset.apThinking);
    }

    function setThinkingMode(mode) {
        if (!['collapse', 'expand', 'hide'].includes(mode)) return;
        cfg.thinkingMode = mode;
        saveConfig();
        applyThinkingMode();
        renderUI(true);
    }

    function languageFor(pre) {
        const code = q('code', pre);
        const text = [pre.getAttribute('data-language'), pre.getAttribute('data-lang'), code?.getAttribute('data-language'), code?.getAttribute('data-lang'), pre.className, code?.className].filter(Boolean).join(' ').toLowerCase();
        const match = text.match(/(?:language|lang)[-_: ]([a-z0-9+#.-]+)/i) || text.match(/\b(javascript|typescript|python|rust|ruby|golang|go|shell|bash|json|html|css|sql|java|csharp|cpp|c\+\+|swift|kotlin|yaml|toml|markdown|md)\b/i);
        return (match?.[1] || '').replace(/^language[-_: ]/, '').toLowerCase();
    }

    const EXTENSIONS = {
        js: 'js', javascript: 'js', jsx: 'jsx', mjs: 'mjs', cjs: 'cjs', ts: 'ts', typescript: 'ts', tsx: 'tsx',
        py: 'py', python: 'py', rs: 'rs', rust: 'rs', go: 'go', golang: 'go', rb: 'rb', ruby: 'rb',
        sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', json: 'json', html: 'html', xml: 'xml', css: 'css',
        scss: 'scss', sql: 'sql', java: 'java', kt: 'kt', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp',
        'c++': 'cpp', cs: 'cs', csharp: 'cs', yaml: 'yml', yml: 'yml', toml: 'toml', md: 'md', markdown: 'md',
        php: 'php', ruby: 'rb', rust: 'rs', dockerfile: 'Dockerfile', text: 'txt', plaintext: 'txt'
    };

    function detectFilename(pre, index = 1) {
        const candidates = [];
        for (let node = pre; node && !node.matches('[role="log"]'); node = node.parentElement) {
            for (const attr of ['data-filename', 'data-file-name', 'aria-label', 'title']) {
                const value = node.getAttribute?.(attr);
                if (value) candidates.push(value);
            }
            if (node !== pre && node.matches('[class*="header" i],[class*="filename" i],[data-filename]')) candidates.push(textContent(node));
            if (node === pre && pre.previousElementSibling) candidates.push(textContent(pre.previousElementSibling));
            if (node === pre.parentElement && node.previousElementSibling) candidates.push(textContent(node.previousElementSibling));
        }
        const filenamePattern = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|rb|sh|bash|json|html?|css|scss|sql|java|kt|swift|c|cpp|h|hpp|cs|php|md|ya?ml|toml|xml|txt)/i;
        for (const candidate of candidates) {
            const match = String(candidate).match(filenamePattern);
            if (match) return match[0].split('/').pop();
        }
        const lang = languageFor(pre);
        const extension = EXTENSIONS[lang] || 'txt';
        return `snippet-${index}.${extension}`;
    }

    function codeText(pre) { return String(q('code', pre)?.textContent ?? pre?.textContent ?? '').replace(/\u00a0/g, ' '); }

    function downloadBlob(blob, filename) {
        const link = document.createElement('a');
        link.download = filename;
        link.href = URL.createObjectURL(blob);
        link.style.display = 'none';
        (document.body || document.documentElement).appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    }

    function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
        const blob = new Blob([text], { type });
        downloadBlob(blob, filename);
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard?.writeText && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
        } catch (_) { /* try a textarea fallback */ }
        try {
            const input = document.createElement('textarea');
            input.value = text;
            input.setAttribute('data-ap-ui', '1');
            input.style.cssText = 'position:fixed;left:-9999px;opacity:0';
            (document.body || document.documentElement).appendChild(input);
            input.select();
            const copied = document.execCommand?.('copy') || false;
            input.remove();
            return copied;
        } catch (_) { return false; }
    }

    function ensureCodeControl(pre, index) {
        if (!pre.dataset.apCodeId) pre.dataset.apCodeId = String(++codeCounter);
        const id = pre.dataset.apCodeId;
        let controls = codeControlMap.get(id);
        if (!controls || !controls.isConnected) {
            controls = make('div', { className: 'ap-code-actions', dataset: { forCode: id } });
            const download = make('button', { className: 'ap-code-action', type: 'button', title: 'Download code', ariaLabel: 'Download code block', onclick: () => {
                const filename = detectFilename(pre, index);
                downloadText(codeText(pre), filename, 'text/plain;charset=utf-8');
                toast('Saved ' + filename);
            } }, '⬇');
            const copy = make('button', { className: 'ap-code-action', type: 'button', title: 'Copy code', ariaLabel: 'Copy code block', onclick: async () => toast(await copyText(codeText(pre)) ? 'Code copied.' : 'Could not copy code.', !navigator.clipboard) }, '⧉');
            controls.append(download, copy);
            q('#ap-code-layer')?.appendChild(controls);
            codeControlMap.set(id, controls);
        }
        return controls;
    }

    function updateCodeControls() {
        if (!currentLog) return;
        const pres = qa('pre', currentLog);
        const ids = new Set();
        pres.forEach((pre, index) => {
            const controls = ensureCodeControl(pre, index + 1);
            const id = pre.dataset.apCodeId;
            ids.add(id);
            controls.dataset.forCode = id;
        });
        for (const [id, controls] of codeControlMap) {
            if (!ids.has(id)) { controls.remove(); codeControlMap.delete(id); }
        }
        positionCodeControls();
    }

    function positionCodeControls() {
        for (const [id, controls] of codeControlMap) {
            const pre = qa('pre[data-ap-code-id]', currentLog || document).find(item => item.dataset.apCodeId === id);
            if (!pre || pre.dataset.apHidden === '1' || pre.closest('[data-ap-hidden="1"]')) { controls.style.display = 'none'; continue; }
            const rect = pre.getBoundingClientRect();
            if (!rect.width || !rect.height) { controls.style.display = 'none'; continue; }
            controls.style.display = 'flex';
            controls.style.left = Math.max(0, Math.min(window.innerWidth - 64, rect.right - 62)) + 'px';
            controls.style.top = Math.max(0, rect.top + 5) + 'px';
        }
    }

    function nodeToMarkdown(node, inPre = false) {
        if (!node) return '';
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1 || isOwn(node)) return '';
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'button' || tag === 'svg') return '';
        if (tag === 'pre') {
            const code = q('code', node);
            const language = languageFor(node);
            const text = String(code?.textContent ?? node.textContent ?? '').replace(/\n+$/, '');
            return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
        }
        if (tag === 'code') return inPre ? node.textContent || '' : '`' + (node.textContent || '').replace(/`/g, '\\`') + '`';
        if (tag === 'br') return '\n';
        const children = Array.from(node.childNodes).map(child => nodeToMarkdown(child, inPre || tag === 'pre')).join('');
        if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children.trim() + '\n\n';
        if (tag === 'strong' || tag === 'b') return '**' + children.trim() + '**';
        if (tag === 'em' || tag === 'i') return '*' + children.trim() + '*';
        if (tag === 'del' || tag === 's') return '~~' + children.trim() + '~~';
        if (tag === 'a') { const href = node.getAttribute('href'); return href ? `[${children.trim()}](${href})` : children; }
        if (tag === 'li') return '- ' + children.trim() + '\n';
        if (tag === 'ul' || tag === 'ol') return '\n' + children + '\n';
        if (tag === 'blockquote') return '\n' + children.split('\n').map(line => '> ' + line).join('\n') + '\n';
        if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') return children.trim() ? '\n' + children.trim() + '\n' : children;
        return children;
    }

    function messageRole(message, index) {
        const attr = `${message.getAttribute('data-role') || ''} ${message.getAttribute('data-message-author-role') || ''} ${message.getAttribute('data-testid') || ''} ${message.className || ''}`.toLowerCase();
        if (/user|human/.test(attr)) return 'User';
        if (/assistant|model|bot/.test(attr)) return 'Assistant';
        return index % 2 === 0 ? 'User' : 'Assistant';
    }

    function exportChatMarkdown() {
        const messages = orderedMessages(currentLog || findLog()).chronological;
        if (!messages.length) return '# Arena.ai conversation\n\n_No rendered messages found._\n';
        const chunks = messages.map((message, index) => `## ${messageRole(message, index)}\n\n${nodeToMarkdown(message).trim()}`);
        return '# Arena.ai conversation\n\n' + chunks.join('\n\n---\n\n') + '\n';
    }

    function exportStem() {
        const title = String(document.title || 'arena-conversation').replace(/\s*[|–—-]\s*Arena\.ai.*$/i, '').trim();
        return (title || 'arena-conversation').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 90) || 'arena-conversation';
    }

    function absoluteUrlsInCss(css, base) {
        return String(css).replace(/url\((\s*)(['"]?)([^'"\)]+)\2(\s*)\)/gi, (all, lead, quote, url, trail) => {
            const value = url.trim();
            if (/^(?:data:|blob:|#|about:)/i.test(value)) return all;
            try { return `url(${lead}${quote}${new URL(value, base).href}${quote}${trail})`; } catch (_) { return all; }
        });
    }

    async function collectStylesheets() {
        const styles = [];
        const sheets = Array.from(document.styleSheets || []);
        for (const sheet of sheets) {
            try {
                const rules = Array.from(sheet.cssRules || []).map(rule => rule.cssText).join('\n');
                styles.push(absoluteUrlsInCss(rules, sheet.href || location.href));
            } catch (error) {
                if (!sheet.href || typeof fetch !== 'function') continue;
                try {
                    const response = await fetch(sheet.href, { credentials: 'include' });
                    if (response.ok) styles.push(absoluteUrlsInCss(await response.text(), sheet.href));
                } catch (fetchError) {
                    console.warn('[Arena Pro] Could not capture stylesheet:', sheet.href, fetchError || error);
                }
            }
        }
        try {
            const computed = getComputedStyle(document.documentElement);
            const vars = [];
            for (let i = 0; i < computed.length; i++) {
                const name = computed[i];
                if (name.startsWith('--')) {
                    const value = computed.getPropertyValue(name).trim();
                    if (value) vars.push(`${name}:${value};`);
                }
            }
            if (vars.length) styles.push(':root{' + vars.join('') + '}');
        } catch (_) { /* CSSOM may be limited in a userscript test environment. */ }
        return styles.join('\n\n');
    }

    function base64FromBytes(bytes) {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
        }
        return window.btoa(binary);
    }

    async function fetchAssetData(url, budget) {
        if (!url || /^(?:data:|blob:|#|about:)/i.test(url) || !budget || budget.requests >= budget.maxRequests) return null;
        if (budget.cache.has(url)) return budget.cache.get(url);
        budget.requests++;
        const task = (async () => {
            try {
                const response = await window.fetch(url, { mode: 'cors', credentials: 'omit' });
                if (!response.ok) return null;
                const declared = Number(response.headers.get('content-length') || 0);
                if (declared > budget.maxAssetBytes || budget.bytes + declared > budget.maxBytes) return null;
                const blob = await response.blob();
                if (!blob.size || blob.size > budget.maxAssetBytes || budget.bytes + blob.size > budget.maxBytes) return null;
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const type = blob.type || response.headers.get('content-type') || 'application/octet-stream';
                budget.bytes += blob.size;
                return `data:${type.split(';')[0]};base64,${base64FromBytes(bytes)}`;
            } catch (_) { return null; }
        })();
        budget.cache.set(url, task);
        const result = await task;
        budget.cache.set(url, result);
        return result;
    }

    async function inlineCssAssets(css, budget) {
        const pattern = /url\((\s*)(['"]?)([^'")]+)\2(\s*)\)/gi;
        const urls = [];
        let match;
        while ((match = pattern.exec(css))) {
            const url = match[3].trim();
            if (!/^(?:data:|blob:|#|about:)/i.test(url) && !urls.includes(url)) urls.push(url);
        }
        const selected = urls.slice(0, Math.max(0, budget.maxRequests - budget.requests));
        const results = await Promise.all(selected.map(async url => [url, await fetchAssetData(url, budget)]));
        const replacements = new Map(results.filter(([, data]) => !!data));
        return String(css).replace(pattern, (all, lead, quote, url, trail) => {
            const data = replacements.get(url.trim());
            return data ? `url(${lead}"${data}"${trail})` : all;
        });
    }

    async function inlineMediaAssets(clone, budget) {
        const elements = qa('img[src],source[src],video[src],video[poster],audio[src]', clone);
        const urls = [...new Set(elements.flatMap(element => ['src', 'poster'].map(attr => element.getAttribute(attr)).filter(Boolean)))];
        const selected = urls.slice(0, Math.max(0, budget.maxRequests - budget.requests));
        await Promise.all(selected.map(url => fetchAssetData(url, budget)));
        for (const element of elements) {
            for (const attr of ['src', 'poster']) {
                const url = element.getAttribute(attr);
                if (url && budget.cache.get(url) && typeof budget.cache.get(url) === 'string') element.setAttribute(attr, budget.cache.get(url));
            }
        }
    }

    function restoreExportClone(clone) {
        const originalPres = qa('pre', document);
        const copiedPres = qa('pre', clone);
        originalPres.forEach((pre, index) => {
            const originalCode = q('code', pre);
            const copiedCode = q('code', copiedPres[index]);
            const saved = originalCode && flattenCache.get(originalCode);
            if (saved != null && copiedCode) copiedCode.innerHTML = saved;
        });
        qa('[data-ap-hidden="1"],[data-ap-thinking="1"]', clone).forEach(node => {
            delete node.dataset.apHidden;
            delete node.dataset.apThinking;
        });
        qa('[data-ap-compact-hidden="1"]', clone).forEach(node => {
            let old = null;
            try { old = JSON.parse(node.getAttribute('data-ap-compact-display') || 'null'); } catch (_) { /* ignore */ }
            if (old?.value) node.style.setProperty('display', old.value, old.priority || '');
            else node.style.removeProperty('display');
        });
        qa('[data-ap-composer-hidden="1"]', clone).forEach(node => {
            let old = null;
            try { old = JSON.parse(node.getAttribute('data-ap-composer-display') || 'null'); } catch (_) { /* ignore */ }
            if (old?.display) node.style.setProperty('display', old.display, old.displayPriority || '');
            else node.style.removeProperty('display');
        });
        qa('*', clone).forEach(node => {
            for (const attr of Array.from(node.attributes || [])) {
                if (attr.name.startsWith('data-ap-')) node.removeAttribute(attr.name);
            }
        });
        qa('[data-ap-ui="1"]', clone).forEach(node => node.remove());
        qa('script', clone).forEach(node => node.remove());
        qa('meta[http-equiv="Content-Security-Policy" i],meta[http-equiv="refresh" i]', clone).forEach(node => node.remove());
        qa('link[rel="stylesheet" i]', clone).forEach(node => node.remove());
        qa('*', clone).forEach(node => {
            for (const attr of Array.from(node.attributes || [])) {
                if (/^on/i.test(attr.name) || (/^(?:href|src|poster|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) node.removeAttribute(attr.name);
                else if (['src', 'href', 'poster'].includes(attr.name) && attr.value && !/^(?:data:|blob:|#|javascript:)/i.test(attr.value)) {
                    try { node.setAttribute(attr.name, new URL(attr.value, location.href).href); } catch (_) { /* retain original */ }
                }
            }
        });
    }

    function exportedInteractiveScript() {
        return `(function(){
'use strict';
var root=document.documentElement;
var css=document.createElement('style');css.textContent='#ap-export-toolbar{position:fixed;z-index:2147483647;top:10px;right:12px;display:flex;gap:6px;padding:6px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:Canvas;color:CanvasText;font:12px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.18)}#ap-export-toolbar button,.ap-export-code-actions button{font:12px system-ui,sans-serif;border:1px solid rgba(127,127,127,.4);border-radius:5px;padding:5px 8px;background:Canvas;color:CanvasText;cursor:pointer}.ap-export-code-actions{position:absolute;top:5px;right:5px;z-index:30;display:flex;gap:4px}.ap-export-pre{position:relative!important}';document.head.appendChild(css);
function text(el){return (el.getAttribute('aria-label')||el.title||el.textContent||'').trim()}
function makeBtn(label,act){var b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',act);return b}
var toolbar=document.createElement('div');toolbar.id='ap-export-toolbar';toolbar.appendChild(makeBtn('Theme',function(){var dark=!root.classList.contains('dark');root.classList.toggle('dark',dark);root.classList.toggle('light',!dark);root.setAttribute('data-theme',dark?'dark':'light')}));toolbar.appendChild(makeBtn('Expand reasoning',function(){document.querySelectorAll('[data-ap-export-thinking-toggle]').forEach(function(b){setThinking(b,true)})}));toolbar.appendChild(makeBtn('Collapse reasoning',function(){document.querySelectorAll('[data-ap-export-thinking-toggle]').forEach(function(b){setThinking(b,false)})}));document.body.appendChild(toolbar);
function setThinking(button,open){var id=button.getAttribute('data-ap-export-panel');var panel=id&&document.getElementById(id);if(!panel)return;button.setAttribute('aria-expanded',String(open));button.setAttribute('data-state',open?'open':'closed');panel.hidden=!open;panel.setAttribute('data-state',open?'open':'closed')}
document.addEventListener('click',function(event){var toggle=event.target.closest('[data-ap-export-thinking-toggle]');if(toggle){var isOpen=toggle.getAttribute('aria-expanded')==='true';setThinking(toggle,!isOpen);return}var copy=event.target.closest('[data-ap-export-copy]');var download=event.target.closest('[data-ap-export-download]');if(copy||download){var pre=(copy||download).closest('pre');var code=pre&&pre.querySelector('code');var value=code?code.textContent:(pre?Array.from(pre.childNodes).filter(function(n){return !n.classList||!n.classList.contains('ap-export-code-actions')}).map(function(n){return n.textContent||''}).join(''):'');if(copy){if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(value).catch(function(){});else{var t=document.createElement('textarea');t.value=value;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove()}}else{var name=pre.getAttribute('data-ap-export-filename')||'snippet.txt';var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([value],{type:'text/plain'}));a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},1000)}}},true);
document.querySelectorAll('pre').forEach(function(pre,i){pre.classList.add('ap-export-pre');var code=pre.querySelector('code');var classes=(pre.className+' '+(code?code.className:''));var m=classes.match(/(?:language|lang)[-_: ]([a-z0-9+#.-]+)/i);var lang=m?m[1].toLowerCase():'txt';var ext=({typescript:'ts',javascript:'js',python:'py',rust:'rs',shell:'sh',bash:'sh',jsx:'jsx',tsx:'tsx'})[lang]||lang.replace(/[^a-z0-9]+/g,'')||'txt';if(!pre.hasAttribute('data-ap-export-filename'))pre.setAttribute('data-ap-export-filename','snippet-'+(i+1)+'.'+ext);var bar=document.createElement('div');bar.className='ap-export-code-actions';bar.appendChild(makeBtn('Copy',function(){}));bar.lastChild.setAttribute('data-ap-export-copy','1');bar.appendChild(makeBtn('⬇',function(){}));bar.lastChild.setAttribute('data-ap-export-download','1');pre.appendChild(bar)});
})();`;
    }

    function prepareThinkingForExport(clone) {
        let counter = 0;
        for (const button of qa('button[data-state],button[aria-expanded]', clone)) {
            const label = `${textContent(button)} ${button.getAttribute('aria-label') || ''} ${button.title || ''}`;
            if (!THINKING_RE.test(label)) continue;
            const wrapper = button.closest('div.not-prose[data-state], [data-thinking-block], div[data-state]') || button.parentElement;
            if (!wrapper) continue;
            let panel = Array.from(wrapper.children).find(child => child !== button && (child.hidden || child.hasAttribute('hidden') || child.getAttribute('data-state') === 'closed' || child.matches('[role="region"]')));
            if (!panel) panel = qa('[hidden],[data-state="closed"],[role="region"]', wrapper).find(child => child !== button && !child.contains(button));
            if (!panel) continue;
            const id = 'ap-export-thinking-panel-' + (++counter);
            panel.id = id;
            panel.hidden = false;
            panel.removeAttribute('hidden');
            panel.setAttribute('data-state', 'open');
            button.setAttribute('data-ap-export-thinking-toggle', '1');
            button.setAttribute('data-ap-export-panel', id);
            button.setAttribute('aria-expanded', 'true');
            button.setAttribute('data-state', 'open');
        }
        for (const details of qa('details', clone)) {
            if (THINKING_RE.test(textContent(q('summary', details) || details))) details.open = true;
        }
    }

    async function exportConversationHTML(options = {}) {
        if (!document.documentElement) return '';
        const clone = document.implementation.createHTMLDocument(document.title || 'Arena.ai conversation');
        const htmlClone = document.documentElement.cloneNode(true);
        clone.replaceChild(clone.importNode(htmlClone, true), clone.documentElement);
        restoreExportClone(clone);
        prepareThinkingForExport(clone);
        const budget = { bytes: 0, maxBytes: 20 * 1024 * 1024, maxAssetBytes: 3 * 1024 * 1024, requests: 0, maxRequests: 48, cache: new Map() };
        const cssText = await inlineCssAssets(await collectStylesheets(), budget);
        await inlineMediaAssets(clone, budget);
        const style = clone.createElement('style');
        style.id = 'ap-export-captured-styles';
        style.textContent = cssText;
        clone.head.appendChild(style);
        const script = clone.createElement('script');
        script.textContent = exportedInteractiveScript();
        clone.body.appendChild(script);
        const title = clone.createElement('title');
        title.textContent = (document.title || 'Arena.ai conversation') + ' — exported';
        const oldTitle = q('title', clone);
        if (oldTitle) oldTitle.replaceWith(title); else clone.head.appendChild(title);
        const html = '<!doctype html>\n' + clone.documentElement.outerHTML;
        if (options.download !== false) {
            downloadText(html, exportStem() + '.html', 'text/html;charset=utf-8');
            toast('Standalone conversation HTML exported.');
        }
        return html;
    }

    function diffControl() {
        const exact = q('[aria-label*="diff" i]:not(#ap-nav-export),[title*="diff" i]:not(#ap-nav-export),[data-testid*="diff" i]');
        if (exact) return exact;
        return qa('button,a,[role="button"]').find(button => !isOwn(button) && /\bdiff\b/i.test(controlLabel(button))) || null;
    }

    function ensureNavExport() {
        if (!cfg.showExport) { navExportButton?.remove(); navExportButton = null; return; }
        if (!navExportButton || !navExportButton.isConnected) {
            navExportButton = make('button', { id: 'ap-nav-export', type: 'button', title: 'Export full conversation as standalone HTML', onclick: () => exportConversationHTML() }, 'Export HTML');
        }
        const diff = diffControl();
        if (diff?.parentElement) {
            navExportButton.classList.remove('ap-floating');
            navExportButton.style.position = 'relative';
            if (diff.nextElementSibling !== navExportButton) diff.insertAdjacentElement('afterend', navExportButton);
        } else {
            navExportButton.classList.add('ap-floating');
            (document.body || document.documentElement).appendChild(navExportButton);
        }
    }

    function guardReactContainer(parent) {
        if (!parent || parent.__apClearGuard) return;
        try {
            const removeChild = parent.removeChild;
            const insertBefore = parent.insertBefore;
            const replaceChild = parent.replaceChild;
            parent.removeChild = function (child) {
                if (child && child.parentNode !== this) return child;
                return removeChild.call(this, child);
            };
            parent.insertBefore = function (child, reference) {
                if (reference && reference.parentNode !== this) return insertBefore.call(this, child, null);
                return insertBefore.call(this, child, reference);
            };
            parent.replaceChild = function (replacement, oldChild) {
                if (oldChild && oldChild.parentNode !== this) return this.appendChild(replacement);
                return replaceChild.call(this, replacement, oldChild);
            };
            Object.defineProperty(parent, '__apClearGuard', { value: { removeChild, insertBefore, replaceChild }, configurable: true });
        } catch (error) { console.warn('[Arena Pro] Could not install React reconciliation guard.', error); }
    }

    async function clearChat() {
        const log = currentLog || findLog();
        if (!log) { toast('Could not find the conversation message list.', true); return false; }
        const { parent, messages } = findMessageList(log);
        if (!parent) { toast('Could not identify the message container safely.', true); return false; }
        if (!messages.length) { toast('The rendered conversation is already clear.'); return true; }
        guardReactContainer(parent);
        for (const message of messages) {
            delete message.dataset.apHidden;
            delete message.dataset.apThinking;
            message.remove();
        }
        revealedExtra = 0;
        hiddenCount = 0;
        codeControlMap.forEach(control => control.remove());
        codeControlMap.clear();
        await Promise.resolve();
        await new Promise(resolve => nextFrame(resolve));
        const verifyLog = findLog() || log;
        const remaining = getMessages(verifyLog).length;
        if (remaining === 0) {
            currentLog = verifyLog;
            virtualize();
            schedule();
            toast('Conversation messages cleared from the current view.');
            return true;
        }
        toast(`Could not verify clear: ${remaining} message(s) remain rendered.`, true, 4500);
        return false;
    }

    function applyThinkingSetting(mode) {
        setThinkingMode(mode);
    }

    function allMessageText() {
        return orderedMessages(currentLog || findLog()).messages.map(message => safeText(message)).join('\n');
    }

    async function runDiagnostics() {
        const log = currentLog || findLog();
        const messages = getMessages(log);
        const composer = findComposer();
        const report = {
            version: VERSION,
            timestamp: new Date().toISOString(),
            url: location.href,
            title: document.title,
            theme: arenaIsDark() ? 'dark' : 'light',
            conversation: log ? { tag: log.tagName, childCount: log.children.length, messageCount: messages.length, hiddenCount, reversed: orderedMessages(log).reversed } : null,
            composer: composer ? { tag: composer.tagName, role: composer.getAttribute('role'), placeholder: composer.getAttribute('placeholder'), panel: composerPanel(composer)?.className || '' } : null,
            agentModes: cfg.agentModes.map(mode => ({ id: mode.id, name: mode.name, active: mode.id === cfg.activeAgentModeId, promptCharacters: mode.prompt.length })),
            controls: qa('button').filter(button => !isOwn(button)).slice(0, 80).map(button => ({ label: controlLabel(button).slice(0, 100), dataState: button.getAttribute('data-state'), ariaExpanded: button.getAttribute('aria-expanded') })),
            settings: { ...cfg, agentModes: cfg.agentModes.map(mode => ({ id: mode.id, name: mode.name, promptCharacters: mode.prompt.length })) }
        };
        const json = JSON.stringify(report, null, 2);
        console.log('[Arena Pro] Diagnostics\n' + json);
        const copied = await copyText(json);
        toast(copied ? 'Diagnostics logged and copied to clipboard.' : 'Diagnostics logged; clipboard access was unavailable.', !copied);
        return report;
    }

    function applyThemeObserver() {
        if (!document.documentElement || typeof MutationObserver !== 'function') return;
        if (themeObserver) themeObserver.disconnect();
        themeObserver = new MutationObserver(applyTheme);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        applyTheme();
    }

    function bindWindowListeners() {
        window.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const ownSurfaceOpen = modePopup?.style.display === 'block' || composerMenu?.style.display === 'block' || drawer?.classList.contains('ap-open');
            if (!ownSurfaceOpen) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
            closeMenus();
            closeDrawer();
        }, true);
        window.addEventListener('keydown', interceptComposerSubmit, true);
        window.addEventListener('click', interceptComposerSubmit, true);
        window.addEventListener('resize', positionCodeControls, { passive: true });
        document.addEventListener('scroll', positionCodeControls, { passive: true, capture: true });
        document.addEventListener('pointerdown', event => {
            if (drawer?.classList.contains('ap-open') && !drawer.contains(event.target) && !drawerToggle?.contains(event.target)) closeDrawer();
        }, true);
    }

    function observeDOM() {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return;
        if (mainObserver) mainObserver.disconnect();
        mainObserver = new MutationObserver(records => {
            const relevant = records.some(record => {
                if (record.target?.closest?.(ownSelector)) return false;
                const changed = [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])];
                return changed.some(node => node.nodeType === 1 && !isOwn(node)) || record.type === 'characterData';
            });
            if (relevant) schedule();
        });
        mainObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }

    function attachLogObserver(log) {
        if (log === currentLog && logObserver) return;
        if (logObserver) logObserver.disconnect();
        currentLog = log;
        if (!log || typeof MutationObserver !== 'function') return;
        attachScroller(log);
        logObserver = new MutationObserver(() => {
            if (cfg.autoScroll && autoStickToBottom) {
                nextFrame(() => {
                    if (currentLog !== log || !log.isConnected) return;
                    scrollToBottom(activeScroller);
                });
            }
            schedule();
        });
        logObserver.observe(log, { childList: true, subtree: true, characterData: true });
    }

    function schedule() {
        if (scheduleTimer) return;
        scheduleTimer = setTimeout(() => {
            scheduleTimer = null;
            update();
        }, 80);
    }

    function update() {
        if (!document.documentElement) return;
        injectStyle();
        ensureDrawer();
        applyTheme();
        const log = findLog();
        if (log) {
            attachLogObserver(log);
            if (activeScroller !== scrollElement(log)) attachScroller(log);
            virtualize();
            applyThinkingMode();
            updateCodeControls();
        }
        ensureAgentControls();
        ensureNavExport();
        applyComposerSettings();
        if (drawer?.classList.contains('ap-open')) renderUI(false);
    }

    function initialize() {
        if (initialized || !document.documentElement) return;
        if (!document.body && document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize, { once: true });
            return;
        }
        initialized = true;
        injectStyle();
        applyThemeObserver();
        ensureDrawer();
        bindWindowListeners();
        observeDOM();
        update();
        statsTimer = setInterval(() => {
            if (drawer?.classList.contains('ap-open') && currentTab === 'statistics') renderUI(false);
            positionCodeControls();
        }, 1200);
        window.addEventListener('pagehide', () => {
            clearInterval(statsTimer);
            mainObserver?.disconnect();
            logObserver?.disconnect();
            themeObserver?.disconnect();
        }, { once: true });
        console.info('[Arena Pro] v' + VERSION + ' initialized.');
    }

    function testApi() {
        return {
            initialize,
            getConfig: () => JSON.parse(JSON.stringify(cfg)),
            setConfig: patch => { cfg = sanitizeConfig(Object.assign({}, cfg, patch)); saveConfig(); schedule(); return cfg; },
            addAgentMode: (name, prompt) => { const mode = { id: newId(), name: String(name), prompt: String(prompt) }; cfg.agentModes.push(mode); saveConfig(); ensureAgentControls(); renderUI(true); return mode; },
            selectAgentMode,
            findComposer,
            findSendButton,
            findLog,
            getMessages,
            orderedMessages,
            virtualize,
            revealOlder,
            flattenCode,
            restoreFlattened,
            applyThinkingMode,
            exportChatMarkdown,
            exportConversationHTML,
            clearChat,
            runDiagnostics,
            ensureAgentControls,
            applyCompactMode,
            openComposerMenu,
            openDrawer,
            renderUI,
            setNativeValue,
            detectFilename,
            interceptComposerSubmit,
            submitThroughComposer
        };
    }

    if (window.__ARENA_PRO_TEST_MODE__) window.__ARENA_PRO_TEST_API__ = testApi();
    initialize();
})();
