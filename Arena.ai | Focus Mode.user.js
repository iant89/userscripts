// ==UserScript==
// @name         Arena.ai | Focus Mode
// @namespace    https://arena.ai/
// @version      1.4.0
// @author       Piknockyou (vibe-coded)
// @license      AGPL-3.0
// @description  Keeps an Arena conversation flowing: sticky auto-scroll that pauses the moment you interact and resumes when you click Arena's scroll-down arrow, locked zoom, a navbar pinned to the top, a composer pinned to the bottom and widened to fit the viewport, the diff viewer widened to fit it too, a flattened/optimized DOM, one-click HTML export of the whole conversation (theme + layout preserved, folding still works), and a slide-out settings menu.
// @match        *://*.arena.ai/*
// @match        *://*.canaryarena.ai/*
// @match        *://chat.lmsys.org/*
// @icon         https://arena.ai/favicon.ico
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ══════════════════════════════════════════════════════════════════
 * Arena.ai | Focus Mode — v1.4.0
 * ══════════════════════════════════════════════════════════════════
 *
 * A deliberately small script with five jobs:
 *
 *   1. FOLLOW    Auto-scroll the message log while Arena streams. The
 *                moment the user does anything that means "I want to
 *                read here" (wheel up, touch drag, PageUp/Home/ArrowUp,
 *                mouse-down in the log, selecting text) following stops
 *                and stays stopped. Clicking Arena's own scroll-down
 *                arrow — the round button centred just above the
 *                composer — turns following back on.
 *
 *   2. NO ZOOM   Ctrl/⌘+wheel, Ctrl/⌘ +/−/0, Safari gesture events,
 *                two-finger pinch and the viewport meta tag are all
 *                neutralised so the layout can never balloon.
 *
 *   3. CHROME    The composer bar is made to stay on the bottom edge of
 *                the viewport and to span the full viewport width, the
 *                top navbar is made to stay on the top edge, and the diff
 *                viewer is widened to the viewport too. The bar and the
 *                navbar use sticky first and fall back to a measured
 *                fixed pin with space reserved, so nothing hides
 *                underneath; the diff viewer is measured and widened in
 *                place, whether it floats or sits in the layout.
 *
 *   4. EXPORT    A download icon is inserted in the top nav directly to
 *                the left of Arena's diff-browser control. It writes a
 *                single self-contained .html file containing the entire
 *                conversation, Arena's own captured stylesheet, the
 *                active theme, and a tiny vanilla shim that keeps the
 *                reasoning / tool-output folds (Radix collapsibles and
 *                native <details>) working in the exported file.
 *
 *   5. SETTINGS  A small gear tab on the right edge of the viewport
 *                expands into a drawer with every option below. Changes
 *                are saved to localStorage and most apply immediately;
 *                the drawer says when one needs a reload.
 *
 * Plus DOM optimisation: Shiki code blocks are flattened from tens of
 * thousands of spans to plain text, empty inline wrappers are unwrapped,
 * blurs/animations/transitions are neutralised and messages get CSS
 * containment. All of that runs only on messages that have been idle for
 * a few seconds, so it can never fight React while an answer streams.
 *
 * No dependencies, no build step, no network calls.
 * All of our own DOM is tagged with data-afx-ui / afx-* ids and is
 * excluded from export, from observers and from the follow heuristics.
 * ══════════════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    // ════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ════════════════════════════════════════════════════════════════

    const CFG = {
        // Follow
        autoScroll: true,
        followThreshold: 120,   // px from the bottom that still counts as "at the bottom"
        resumeOnArrow: true,    // clicking Arena's scroll-down arrow resumes following
        idleFollowPoll: 450,    // ms safety poll while following (cheap no-op when already at bottom)

        // Zoom
        preventZoom: true,

        // Viewport chrome
        pinComposer: true,
        wideComposer: true,     // composer spans the full viewport width
        pinTopNav: true,        // top navbar stays on the top edge
        wideDiffViewer: true,   // diff viewer spans the full viewport width

        // DOM optimisation
        optimizeDOM: true,
        killTransitions: true,
        killBlurs: true,
        flattenCode: true,
        unwrapEmptySpans: true,
        contentVisibility: true,
        idleBeforeOptimize: 2500, // ms of no mutations before a message is touched
        sweepInterval: 2500,

        // Export
        showExportButton: true,
        exportMaxCSSBytes: 4 * 1024 * 1024,

        // Diagnostics
        verbose: false,
    };

    const MARKER = '/* Arena.ai | Focus Mode */';
    const VERSION = '1.4.0';

    const AFX = {
        styleId: 'afx-style',
        exportBtnId: 'afx-nav-export',
        settingsId: 'afx-settings',
        ui: 'data-afx-ui',
    };

    // ════════════════════════════════════════════════════════════════
    // SAVED SETTINGS
    // ════════════════════════════════════════════════════════════════
    //
    // The settings menu writes overrides of CFG to localStorage. Only keys
    // that differ from the defaults above are stored, so changing a default
    // in a new version still reaches anyone who never touched that setting.

    const SETTINGS_KEY = 'afx-focus-mode-settings';
    const DEFAULTS = Object.assign({}, CFG);

    function loadSettings() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        } catch (_e) {}
        if (!saved || typeof saved !== 'object') return;
        for (const key of Object.keys(saved)) {
            if (!(key in DEFAULTS) || typeof saved[key] !== typeof DEFAULTS[key]) continue;
            CFG[key] = saved[key];
        }
    }

    function saveSettings() {
        const overrides = {};
        for (const key of Object.keys(DEFAULTS)) {
            if (CFG[key] !== DEFAULTS[key]) overrides[key] = CFG[key];
        }
        try {
            if (Object.keys(overrides).length) localStorage.setItem(SETTINGS_KEY, JSON.stringify(overrides));
            else localStorage.removeItem(SETTINGS_KEY);
        } catch (_e) {}
    }

    loadSettings();
    // What this page load booted with; some settings only fully apply on reload.
    const BOOT_CFG = Object.assign({}, CFG);

    const log = (...args) => { if (CFG.verbose) console.log('[FocusMode]', ...args); };

    // ════════════════════════════════════════════════════════════════
    // SMALL UTILITIES
    // ════════════════════════════════════════════════════════════════

    const $$ = (sel, root = document) => Array.prototype.slice.call(root.querySelectorAll(sel));

    const isElement = (node) => node instanceof Element;
    const text = (el) => ((el && el.textContent) || '').trim();

    function isVisible(el) {
        if (!isElement(el) || !el.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.opacity !== '' && Number(style.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function isOurs(el) {
        return isElement(el) && !!el.closest('[' + AFX.ui + '], #' + AFX.exportBtnId + ', #' + AFX.styleId);
    }

    function viewportBottom() {
        const vv = window.visualViewport;
        return vv ? vv.offsetTop + vv.height : window.innerHeight;
    }

    function escapeHTML(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function pageTitle() {
        return (document.title || 'Arena conversation')
            .replace(/\s*[|–—-]\s*Arena\.ai.*$/i, '')
            .trim() || 'Arena conversation';
    }

    function slugify(name) {
        return String(name)
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^\.+|\.+$/g, '')
            .slice(0, 90) || 'arena-conversation';
    }

    function rafThrottle(fn) {
        let queued = false;
        let lastArgs = null;
        return function throttled(...args) {
            lastArgs = args;
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                fn.apply(null, lastArgs || []);
            });
        };
    }

    // ════════════════════════════════════════════════════════════════
    // STYLES
    // ════════════════════════════════════════════════════════════════

    function buildCSS() {
        let css = MARKER + '\n';

        if (CFG.preventZoom) {
            css += `
                html, body { touch-action: pan-x pan-y; overscroll-behavior: none; }
            `;
        }

        if (CFG.optimizeDOM) {
            if (CFG.killTransitions) {
                css += `
                    *, *::before, *::after {
                        animation-duration: 0.001s !important;
                        animation-delay: 0s !important;
                        transition-duration: 0.001s !important;
                        transition-delay: 0s !important;
                    }
                    [class*="transition-[max-height]"] { transition: none !important; }
                `;
            }
            if (CFG.killBlurs) {
                css += `
                    [class*="backdrop-blur"], [style*="backdrop-filter"] {
                        backdrop-filter: none !important;
                        -webkit-backdrop-filter: none !important;
                    }
                `;
            }
            css += `
                [role="log"] > * { contain: layout style; }
                [role="log"] pre { contain: layout style; }
                .afx-cv { content-visibility: auto; contain-intrinsic-size: auto 240px; }
            `;
        }

        css += `
            /* ── Composer stays on the bottom edge of the viewport ── */
            [data-afx-composer="1"] {
                position: sticky !important;
                bottom: 0 !important;
                z-index: 30 !important;
            }
            [data-afx-wide="1"] {
                max-width: none !important;
                width: 100% !important;
                margin-left: 0 !important;
                margin-right: 0 !important;
            }

            /* ── Diff viewer spans the viewport width ── */
            [data-afx-diff="1"] {
                max-width: none !important;
                min-width: 0 !important;
                margin-left: 0 !important;
                margin-right: 0 !important;
            }
            [data-afx-diff="1"][data-afx-diff-floating="1"] {
                right: auto !important;
                max-width: none !important;
            }
            [data-afx-diff="1"] [data-afx-diff-wide="1"] {
                max-width: none !important;
                width: 100% !important;
                margin-left: 0 !important;
                margin-right: 0 !important;
            }

            /* ── Top navbar stays on the top edge of the viewport ── */
            [data-afx-topbar="1"] {
                position: sticky !important;
                top: 0 !important;
                z-index: 40 !important;
            }
            [data-afx-topbar="1"][data-afx-top-pinned="1"] { z-index: 60 !important; }

            /* ── Nav export button (looks like Arena's own icon buttons) ── */
            #${AFX.exportBtnId} {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                padding: 0;
                margin: 0;
                border: 0;
                border-radius: 8px;
                background: transparent;
                color: inherit;
                cursor: pointer;
                opacity: .8;
                flex: 0 0 auto;
                transition: opacity .12s ease, background-color .12s ease;
            }
            #${AFX.exportBtnId}:hover { opacity: 1; background: rgba(127,127,127,.16); }
            #${AFX.exportBtnId}:active { background: rgba(127,127,127,.26); }
            #${AFX.exportBtnId}:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; opacity: 1; }
            #${AFX.exportBtnId} svg { width: 18px; height: 18px; display: block; }
            #${AFX.exportBtnId}[data-afx-floating="1"] {
                position: fixed;
                top: 10px;
                right: 56px;
                z-index: 60;
                background: rgba(127,127,127,.14);
            }
            @media print { #${AFX.exportBtnId} { display: none !important; } }
        ` + buildSettingsCSS();

        return css;
    }

    function injectCSS() {
        let style = document.getElementById(AFX.styleId);
        if (!style) {
            style = document.createElement('style');
            style.id = AFX.styleId;
            style.setAttribute(AFX.ui, '1');
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = buildCSS();
    }

    // ════════════════════════════════════════════════════════════════
    // ZOOM LOCK
    // ════════════════════════════════════════════════════════════════

    function installZoomLock() {
        // Ctrl/⌘ + wheel (also how trackpad pinch is reported on most desktops).
        // Always installed; every handler checks CFG.preventZoom so the
        // settings menu can switch the lock on and off without a reload.
        window.addEventListener('wheel', (ev) => {
            if (!CFG.preventZoom) return;
            if (!ev.ctrlKey && !ev.metaKey) return;
            ev.preventDefault();
            ev.stopPropagation();
        }, { passive: false, capture: true });

        // Ctrl/⌘ + '+' / '-' / '0'.
        window.addEventListener('keydown', (ev) => {
            if (!CFG.preventZoom) return;
            if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
            const key = ev.key;
            if (key === '+' || key === '=' || key === '-' || key === '_' || key === '0') {
                ev.preventDefault();
                ev.stopPropagation();
            }
        }, { passive: false, capture: true });

        // Safari pinch gestures.
        ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
            window.addEventListener(type, (ev) => { if (CFG.preventZoom) ev.preventDefault(); }, { passive: false });
        });

        // Two-finger pinch on touch devices.
        window.addEventListener('touchmove', (ev) => {
            if (CFG.preventZoom && ev.touches && ev.touches.length > 1) ev.preventDefault();
        }, { passive: false, capture: true });

        // Belt and braces: a non-scalable viewport meta, re-applied if Arena
        // ever replaces the head contents during a route change.
        let originalMeta;
        const lockMeta = () => {
            let meta = document.querySelector('meta[name="viewport"]');
            if (originalMeta === undefined) originalMeta = meta ? meta.getAttribute('content') : null;
            if (!CFG.preventZoom) {
                // Hand Arena's own viewport meta back once the lock is off.
                const restore = originalMeta || 'width=device-width, initial-scale=1';
                if (meta && meta.getAttribute('content') !== restore) meta.setAttribute('content', restore);
                return;
            }
            if (!meta) {
                meta = document.createElement('meta');
                meta.setAttribute('name', 'viewport');
                (document.head || document.documentElement).appendChild(meta);
            }
            const content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
            if (meta.getAttribute('content') !== content) meta.setAttribute('content', content);
        };
        lockMeta();
        setInterval(lockMeta, 4000);
        zoomLockMeta = lockMeta;
    }

    let zoomLockMeta = null;

    // ════════════════════════════════════════════════════════════════
    // ARENA DOM SHAPE HELPERS
    // ════════════════════════════════════════════════════════════════

    function findLog() {
        const logs = $$('[role="log"]');
        if (!logs.length) return null;
        return logs.reduce((best, el) => (el.children.length > best.children.length ? el : best));
    }

    function validMessage(el) {
        if (!isElement(el)) return false;
        if (el.hasAttribute(AFX.ui)) return false;
        const content = text(el);
        if (content.length > 40) return true;
        return !!el.querySelector('pre,.prose,[class*="prose"],[class*="markdown"],button[data-state]');
    }

    /**
     * Arena nests the message list a couple of levels below [role="log"].
     * Walk down while a container has a single (or zero-valid) child until
     * we find the actual list of messages.
     */
    function findMessageList(root) {
        if (!root) return { parent: null, messages: [] };
        let node = root;
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
        return { parent: root, messages: Array.from(root.children).filter(validMessage) };
    }

    function findScroller(log) {
        if (!log) return null;
        let node = log;
        for (let depth = 0; depth < 8 && node; depth++) {
            const style = getComputedStyle(node);
            const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);
            if (scrollable && node.scrollHeight > node.clientHeight + 4) return node;
            node = node.parentElement;
        }
        // Fall back to anything scrollable at all, then the document itself.
        node = log;
        for (let depth = 0; depth < 8 && node; depth++) {
            if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node;
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    // ════════════════════════════════════════════════════════════════
    // 1. FOLLOW ENGINE
    // ════════════════════════════════════════════════════════════════

    const follow = {
        log: null,
        listParent: null,
        scroller: null,
        following: CFG.autoScroll,
        programmatic: false,
        programmaticTimer: 0,
        observer: null,
        resizeObserver: null,
        cleanup: [],
        rafQueued: false,
    };

    function nearBottom(scroller = follow.scroller) {
        if (!scroller) return true;
        const remaining = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        return remaining <= Math.max(0, CFG.followThreshold);
    }

    function stickToBottom() {
        if (!CFG.autoScroll || !follow.following) return;
        const scroller = follow.scroller;
        if (!scroller) return;
        const top = scroller.scrollHeight - scroller.clientHeight;
        if (top <= 0) return;
        if (Math.abs(scroller.scrollTop - top) < 1.5) return;
        scroller.scrollTop = top;
    }

    const scheduleFollow = rafThrottle(() => {
        stickToBottom();
    });

    function setFollowing(value, reason) {
        if (follow.following === value) return;
        follow.following = value;
        log('following =', value, reason ? '(' + reason + ')' : '');
    }

    function stopFollowing(reason) {
        if (!follow.following) {
            follow.programmatic = false;
            return;
        }
        follow.programmatic = false;
        clearTimeout(follow.programmaticTimer);
        setFollowing(false, reason);
    }

    function resumeFollowing(reason) {
        follow.following = true;
        follow.programmatic = true;
        clearTimeout(follow.programmaticTimer);
        follow.programmaticTimer = setTimeout(() => { follow.programmatic = false; }, 1200);

        const scroller = follow.scroller;
        if (scroller) {
            const top = scroller.scrollHeight - scroller.clientHeight;
            if (typeof scroller.scrollTo === 'function') {
                scroller.scrollTo({ top, behavior: 'smooth' });
            } else {
                scroller.scrollTop = top;
            }
        }
        log('following = true', reason ? '(' + reason + ')' : '');
    }

    // ── Arena's scroll-down arrow ───────────────────────────────────

    // Arena's control is:
    //   <button aria-label="Scroll to bottom" class="... px-3 py-1 text-xs
    //           ... backdrop-blur-md shadow-md"><svg .../></button>
    // It floats, centred, just above the composer.
    const ARROW_LABEL_EXACT = [
        'scroll to bottom',
        'scroll to the bottom',
        'scroll down',
        'jump to bottom',
        'jump to latest',
        'go to bottom',
        'back to bottom',
    ];

    const ARROW_LABEL = /(scroll|jump|go)\s*(back\s*)?(to\s*)?(the\s*)?(bottom|down|latest|newest)|latest\s*(message|response|reply)|new\s*(messages?|responses?)|bottom\s*of\s*(the\s*)?(chat|conversation)/i;
    // Any label mentioning a composer/nav control wins over the geometry
    // fallback, so the model picker or send button can never re-arm following.
    const NOT_ARROW_LABEL = /(send|attach|stop|upload|record|mic|voice|model|settings|search|share|menu|close|download|copy|retry|edit|new chat|agent|plan)/i;

    function classish(el) {
        if (!isElement(el)) return '';
        return typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    }

    function positionedAncestor(el, levels = 4) {
        let node = el;
        for (let i = 0; node && i < levels; i++, node = node.parentElement) {
            const pos = getComputedStyle(node).position;
            if (pos && pos !== 'static') return node;
        }
        return null;
    }

    /** Floating-overlay tell-tales in Arena's Tailwind classes. */
    function looksFloating(el) {
        const chain = classish(el) + ' ' + classish(el.parentElement);
        return /(^|\s)(absolute|fixed|sticky)(\s|$)|backdrop-blur|shadow-(md|lg|xl|2xl)/.test(chain);
    }

    /**
     * Decide whether a click landed on Arena's "scroll to bottom" control.
     * Primary signal is the accessible name; geometry is the fallback for
     * the case where the label changes: the arrow is small, horizontally
     * centred on the log, and sits in the lower part of the viewport just
     * above the composer.
     */
    function isArenaScrollArrow(target) {
        const el = target.closest('button, [role="button"], a, [tabindex]') || target;
        if (!isElement(el) || isOurs(el)) return false;

        const rawLabel = [
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
        ].filter(Boolean).join(' ').trim();
        const label = rawLabel || text(el).slice(0, 60);
        const normalised = label.toLowerCase().replace(/\s+/g, ' ').trim();

        if (normalised && ARROW_LABEL_EXACT.indexOf(normalised) !== -1) return true;
        if (label && ARROW_LABEL.test(label)) return true;
        if (label && NOT_ARROW_LABEL.test(label)) return false;

        // Geometry fallback.
        const scroller = follow.scroller;
        if (!scroller) return false;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (r.width > 72 || r.height > 72) return false;
        if (!el.querySelector('svg,path,img')) return false;

        const sr = scroller.getBoundingClientRect();
        const centre = sr.left + sr.width / 2;
        if (Math.abs((r.left + r.width / 2) - centre) > Math.max(64, sr.width * 0.22)) return false;
        if (r.top < viewportBottom() * 0.55) return false;

        return !!positionedAncestor(el) || looksFloating(el);
    }

    // ── Binding ──────────────────────────────────────────────────────

    function teardownFollowBinding() {
        follow.cleanup.forEach((fn) => { try { fn(); } catch (_e) {} });
        follow.cleanup = [];
        if (follow.observer) { follow.observer.disconnect(); follow.observer = null; }
        if (follow.resizeObserver) { follow.resizeObserver.disconnect(); follow.resizeObserver = null; }
        follow.log = null;
        follow.listParent = null;
        follow.scroller = null;
    }

    function bindFollow(logEl) {
        teardownFollowBinding();

        const scroller = findScroller(logEl);
        follow.log = logEl;
        follow.listParent = findMessageList(logEl).parent;
        follow.scroller = scroller;
        follow.following = CFG.autoScroll ? nearBottom(scroller) : false;
        follow.programmatic = false;
        log('bound to log/scroller', scroller);

        const on = (target, type, handler, opts) => {
            target.addEventListener(type, handler, opts);
            follow.cleanup.push(() => target.removeEventListener(type, handler, opts));
        };

        // ── Scroll state ────────────────────────────────────────────
        on(scroller, 'scroll', () => {
            if (follow.programmatic) {
                if (nearBottom(scroller)) follow.programmatic = false;
                return;
            }
            // Nudging back down to the bottom (scrollbar, End key, trackpad)
            // naturally re-arms following.
            setFollowing(nearBottom(scroller), 'scroll');
        }, { passive: true });

        // ── Deliberate interventions ────────────────────────────────
        on(scroller, 'wheel', (ev) => {
            if (isOurs(ev.target)) return;
            if (ev.deltaY < 0) stopFollowing('wheel up');
        }, { passive: true });

        let touchY = 0;
        on(scroller, 'touchstart', (ev) => {
            touchY = ev.touches && ev.touches[0] ? ev.touches[0].clientY : 0;
        }, { passive: true });
        on(scroller, 'touchmove', (ev) => {
            if (isOurs(ev.target)) return;
            const t = ev.touches && ev.touches[0];
            if (!t) return;
            if (t.clientY - touchY > 6) stopFollowing('touch drag');
            touchY = t.clientY;
        }, { passive: true });

        on(scroller, 'mousedown', (ev) => {
            const target = ev.target;
            if (!isElement(target) || isOurs(target)) return;
            if (target.closest('button,a,[role="button"],input,textarea,select,[contenteditable="true"]')) return;
            stopFollowing('pointer down in log');
        }, { passive: true });

        // ── Follow on new content ───────────────────────────────────
        follow.observer = new MutationObserver((records) => {
            markActivity(records);
            scheduleFollow();
        });
        follow.observer.observe(logEl, { childList: true, subtree: true, characterData: true });

        if (typeof ResizeObserver === 'function') {
            follow.resizeObserver = new ResizeObserver(() => scheduleFollow());
            follow.resizeObserver.observe(logEl);
        }
    }

    function ensureFollowBinding() {
        const logEl = findLog();
        if (!logEl) {
            if (follow.log) teardownFollowBinding();
            return;
        }
        const scroller = findScroller(logEl);
        if (follow.log === logEl && follow.scroller === scroller && follow.log.isConnected) return;
        bindFollow(logEl);
    }

    /** One-time document level listeners for follow mode. */
    function installFollowListeners() {
        // Keyboard navigation away from the bottom.
        document.addEventListener('keydown', (ev) => {
            const target = ev.target;
            if (isElement(target) && target.closest('input,textarea,select,[contenteditable="true"]')) return;
            if (isOurs(target)) return;
            if (ev.key === 'PageUp' || ev.key === 'Home' || ev.key === 'ArrowUp') stopFollowing('key ' + ev.key);
        }, { passive: true, capture: true });

        // Text selection means the user is reading/copying.
        document.addEventListener('selectionchange', () => {
            if (!follow.following) return;
            const selection = window.getSelection && window.getSelection();
            if (!selection || !selection.rangeCount || selection.isCollapsed) return;
            if (!String(selection).trim()) return;
            const anchor = selection.anchorNode;
            const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
            if (host && follow.log && follow.log.contains(host)) stopFollowing('text selection');
        });

        // Clicking Arena's own scroll-down arrow resumes following.
        document.addEventListener('click', (ev) => {
            if (!CFG.resumeOnArrow || !CFG.autoScroll) return;
            const target = ev.target;
            if (!isElement(target)) return;
            if (isArenaScrollArrow(target)) resumeFollowing('native arrow');
        }, true);

        // Follow through late-loading images / embeds.
        document.addEventListener('load', (ev) => {
            const target = ev.target;
            if (isElement(target) && follow.log && follow.log.contains(target)) scheduleFollow();
        }, true);

        // Safety poll: catches layout changes no observer reported.
        setInterval(() => {
            if (!follow.following || !follow.scroller) return;
            if (!nearBottom(follow.scroller)) stickToBottom();
        }, Math.max(200, CFG.idleFollowPoll));

        window.addEventListener('resize', () => {
            scheduleFollow();
            syncTopBarPin();
            syncDiffViewerWidth();
        }, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => scheduleFollow(), { passive: true });
        }
    }

    // ════════════════════════════════════════════════════════════════
    // 2. COMPOSER PINNING
    // ════════════════════════════════════════════════════════════════

    const composer = { el: null, bar: null, pinned: false, lastCheck: 0 };

    // Text fields that belong to a code editor or the workspace/diff panel,
    // never to the composer (CodeMirror's role="textbox", Monaco's textarea).
    const EDITOR_FIELD_HINTS =
        '.cm-editor, .monaco-editor, .CodeMirror, [class*="monaco" i], [class*="codemirror" i]';

    function isComposerField(el) {
        if (el.matches('[readonly], [aria-readonly="true"], [aria-hidden="true"]')) return false;
        if (el.closest(EDITOR_FIELD_HINTS)) return false;
        if (diffview.el && diffview.el.contains(el)) return false;
        if (el.closest('[data-afx-diff="1"]')) return false;
        return true;
    }

    function findComposer() {
        const candidates = [];
        const nodes = $$('[role="textbox"], textarea, [contenteditable="true"], [role="composer"]');
        for (const el of nodes) {
            if (isOurs(el) || !isVisible(el)) continue;
            if (!isComposerField(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.height < 16) continue;
            candidates.push({ el, bottom: r.bottom });
        }
        if (!candidates.length) return null;
        // The composer is the input closest to the bottom of the viewport.
        candidates.sort((a, b) => b.bottom - a.bottom);
        return candidates[0].el;
    }

    function findComposerBar(el) {
        let node = el;
        let best = el;
        for (let i = 0; i < 6 && node.parentElement; i++) {
            const parent = node.parentElement;
            const r = parent.getBoundingClientRect();
            if (r.height > window.innerHeight * 0.6) break; // that is the whole layout
            best = parent;
            node = parent;
            if (r.width >= window.innerWidth * 0.9) break;  // reached the full-width bar
        }
        return best;
    }

    function viewportWidth() {
        return document.documentElement.clientWidth || window.innerWidth;
    }

    /** Left/width for a pinned composer: full viewport when asked to fit it. */
    function composerBox(rect) {
        if (CFG.wideComposer) return { left: 0, width: viewportWidth() };
        if (!rect) return null;
        return { left: Math.round(rect.left), width: Math.round(rect.width) };
    }

    function applyFixedPin(bar, rect) {
        composer.pinned = true;
        bar.dataset.afxPinned = '1';
        bar.style.setProperty('position', 'fixed', 'important');
        bar.style.setProperty('z-index', '45', 'important');
        bar.style.setProperty('box-sizing', 'border-box', 'important');
        const box = composerBox(rect);
        if (box) {
            bar.style.setProperty('left', box.left + 'px', 'important');
            bar.style.setProperty('width', box.width + 'px', 'important');
            bar.style.setProperty('max-width', 'none', 'important');
            bar.style.setProperty('margin-left', '0', 'important');
            bar.style.setProperty('margin-right', '0', 'important');
        }
        syncFixedPin(bar);
        const scroller = follow.scroller;
        if (scroller && rect) {
            scroller.style.setProperty('padding-bottom', Math.round(rect.height + 24) + 'px', 'important');
        }
        log('composer pinned (fixed fallback)');
    }

    function syncFixedPin(bar) {
        // Keep the pin glued to the visual viewport (mobile keyboards).
        const offset = Math.max(0, window.innerHeight - viewportBottom());
        bar.style.setProperty('bottom', offset + 'px', 'important');
        if (CFG.wideComposer) {
            bar.style.setProperty('left', '0px', 'important');
            bar.style.setProperty('width', viewportWidth() + 'px', 'important');
            return;
        }
        const parent = bar.parentElement;
        if (parent) {
            const pr = parent.getBoundingClientRect();
            if (pr.width > 0) {
                bar.style.setProperty('left', Math.round(pr.left) + 'px', 'important');
                bar.style.setProperty('width', Math.round(pr.width) + 'px', 'important');
            }
        }
    }

    /**
     * Remove whatever width cap keeps the composer narrower than the
     * viewport (typically a `max-w-3xl mx-auto` column). We walk up from the
     * bar and refuse to widen any ancestor that also holds the message log —
     * widening that would restyle the whole conversation, not the composer.
     *
     * Returns true when the bar is still narrower than the viewport, which is
     * the signal to fall back to a full-width fixed pin.
     */
    function widenComposer(bar) {
        if (!CFG.wideComposer || !bar) return false;
        const vw = viewportWidth();

        let node = bar;
        for (let depth = 0; node && depth < 5; depth++) {
            if (node === document.body || node === document.documentElement) break;
            if (node === composer.el) break;
            if (follow.log && node.contains(follow.log)) break;

            const rect = node.getBoundingClientRect();
            const maxWidth = parseFloat(getComputedStyle(node).maxWidth);
            const capped = (!isNaN(maxWidth) && maxWidth < vw - 8) ||
                (rect.width > 0 && rect.width < vw - 8);

            if (capped) {
                node.style.setProperty('max-width', 'none', 'important');
                node.style.setProperty('width', '100%', 'important');
                node.style.setProperty('margin-left', '0', 'important');
                node.style.setProperty('margin-right', '0', 'important');
                node.dataset.afxWide = '1';
            }
            node = node.parentElement;
        }

        const rect = bar.getBoundingClientRect();
        return rect.width > 0 && rect.width < vw - 8;
    }

    function ensureComposerPinned() {
        const el = findComposer();
        if (!el) {
            composer.el = null;
            return;
        }
        if (el !== composer.el) {
            composer.el = el;
            composer.bar = null;
            composer.pinned = false;
        }
        if (!composer.bar || !composer.bar.isConnected || !composer.bar.contains(el)) {
            composer.bar = findComposerBar(el);
        }
        const bar = composer.bar;
        if (!bar) return;

        if (!CFG.pinComposer) {
            widenComposer(bar);
            return;
        }

        if (composer.pinned) {
            if (bar.getBoundingClientRect().height === 0) {
                // The bar was re-rendered away from our pin.
                composer.pinned = false;
                delete bar.dataset.afxPinned;
            } else {
                syncFixedPin(bar);
                return;
            }
        }

        // Preferred approach: sticky in normal flow. Only touch the bar when
        // Arena has not already positioned it itself.
        const position = getComputedStyle(bar).position || 'static';
        if ((position === 'static' || position === 'relative') && bar.dataset.afxComposer !== '1') {
            bar.dataset.afxComposer = '1';
        }

        // Verify it really is on the bottom edge; fall back to fixed if the
        // ancestors clip sticky positioning.
        const now = performance.now();
        if (now - composer.lastCheck < 500) return;
        composer.lastCheck = now;

        const stillNarrow = widenComposer(bar);

        const rect = bar.getBoundingClientRect();
        if (!rect.height) return;
        // Pin when the bar is not on the bottom edge, or when the surrounding
        // layout refuses to let it span the viewport.
        if (rect.bottom > viewportBottom() + 4 || stillNarrow) applyFixedPin(bar, rect);
    }

    // ════════════════════════════════════════════════════════════════
    // 2b. TOP NAV PINNING
    // ════════════════════════════════════════════════════════════════

    const topbar = { el: null, pinned: false, spacerParent: null, lastCheck: 0 };

    function findTopBar() {
        let best = null;
        let bestRect = null;

        for (const el of $$('header, [role="banner"], nav')) {
            if (isOurs(el) || !isVisible(el)) continue;
            if (el.closest('[role="log"]')) continue;
            if (el.closest('[data-afx-composer="1"], [data-afx-wide="1"]')) continue;

            const rect = el.getBoundingClientRect();
            if (rect.top > 32) continue;                       // must hug the top edge
            if (rect.height < 20 || rect.height > 200) continue; // bar, not a whole pane
            if (rect.width < viewportWidth() * 0.5) continue;    // not a side rail

            if (!bestRect || rect.width > bestRect.width ||
                (rect.width === bestRect.width && rect.height > bestRect.height)) {
                best = el;
                bestRect = rect;
            }
        }
        if (!best) return null;

        // Climb to the outermost wrapper that is still just the top bar.
        let node = best;
        while (node.parentElement && node.parentElement !== document.body) {
            const parent = node.parentElement;
            if (parent.matches('main, [role="main"], [role="log"]')) break;
            if (follow.log && parent.contains(follow.log)) break;
            const rect = parent.getBoundingClientRect();
            if (rect.top > 32 || rect.height < 20 || rect.height > 200) break;
            if (rect.width < viewportWidth() * 0.5) break;
            node = parent;
        }
        return node;
    }

    function currentScrollTop() {
        let top = window.scrollY || document.documentElement.scrollTop || 0;
        if (follow.scroller && follow.scroller !== document.scrollingElement) {
            top = Math.max(top, follow.scroller.scrollTop || 0);
        }
        return top;
    }

    function applyTopBarFixed(bar, rect) {
        topbar.pinned = true;
        bar.dataset.afxTopPinned = '1';
        bar.style.setProperty('position', 'fixed', 'important');
        bar.style.setProperty('top', '0px', 'important');
        bar.style.setProperty('left', Math.round(rect.left) + 'px', 'important');
        bar.style.setProperty('width', Math.round(rect.width) + 'px', 'important');
        bar.style.setProperty('box-sizing', 'border-box', 'important');
        bar.style.setProperty('z-index', '60', 'important');

        // Reserve the space the bar used to occupy so the content below does
        // not jump up underneath it.
        const parent = bar.parentElement;
        if (parent && !topbar.spacerParent) {
            topbar.spacerParent = parent;
            parent.style.setProperty('padding-top', Math.round(rect.height) + 'px', 'important');
        }
        syncTopBarPin();
        log('top nav pinned (fixed fallback)');
    }

    /** Keep a fixed top bar matched to its slot after viewport resizes. */
    function syncTopBarPin() {
        const bar = topbar.el;
        if (!topbar.pinned || !bar) return;
        const parent = bar.parentElement;
        const rect = parent ? parent.getBoundingClientRect() : null;
        if (rect && rect.width > 0) {
            bar.style.setProperty('left', Math.round(rect.left) + 'px', 'important');
            bar.style.setProperty('width', Math.round(rect.width) + 'px', 'important');
        } else {
            bar.style.setProperty('left', '0px', 'important');
            bar.style.setProperty('width', viewportWidth() + 'px', 'important');
        }
    }

    function releaseTopBar(bar) {
        if (bar) {
            delete bar.dataset.afxTopPinned;
            delete bar.dataset.afxTopbar;
        }
        if (topbar.spacerParent) {
            topbar.spacerParent.style.removeProperty('padding-top');
            topbar.spacerParent = null;
        }
        topbar.pinned = false;
    }

    function ensureTopBarPinned() {
        if (!CFG.pinTopNav) return;

        const bar = findTopBar();
        if (!bar) {
            if (topbar.el) releaseTopBar(topbar.el);
            topbar.el = null;
            return;
        }
        if (bar !== topbar.el) {
            if (topbar.el && topbar.el !== bar) releaseTopBar(topbar.el);
            topbar.el = bar;
            topbar.pinned = false;
        }

        if (topbar.pinned) {
            const rect = bar.getBoundingClientRect();
            if (!bar.isConnected || rect.height === 0) {
                // React re-rendered it away from our pin.
                if (topbar.spacerParent) {
                    topbar.spacerParent.style.removeProperty('padding-top');
                    topbar.spacerParent = null;
                }
                topbar.pinned = false;
                delete bar.dataset.afxTopPinned;
            }
            return;
        }

        // Arena may already keep it at the top itself; only step in if not.
        const tagged = bar.dataset.afxTopbar === '1';
        if (!tagged) {
            const position = getComputedStyle(bar).position || 'static';
            if (position === 'fixed' || position === 'sticky') {
                topbar.el = null;
                return;
            }
            bar.dataset.afxTopbar = '1';
        }

        const now = performance.now();
        if (now - topbar.lastCheck < 500) return;
        topbar.lastCheck = now;

        const rect = bar.getBoundingClientRect();
        if (!rect.height) return;
        // Sticky only works while its ancestors cooperate. Once the page is
        // scrolled, a working sticky bar sits at top ~= 0; anything else means
        // it has scrolled away (negative top) or is being pushed around.
        const offTopEdge = rect.top > 4 || rect.top < -1;
        if (currentScrollTop() > 4 && offTopEdge) applyTopBarFixed(bar, rect);
    }

    // ════════════════════════════════════════════════════════════════
    // 2c. DIFF VIEWER WIDTH
    // ════════════════════════════════════════════════════════════════

    const diffview = { el: null, floating: false, lastCheck: 0 };

    // The diff viewer lives inside Arena's "workspace" panel, opened from the
    // top nav: <button aria-label="Open workspace"> (folder icon, h-8 w-8).
    // That button is the anchor: aria-controls / aria-expanded tell us whether
    // the panel is open and, when present, which element it is.
    const WORKSPACE_TOGGLE_LABEL = /^(open|show|toggle|view)\s+(the\s+)?(workspace|files|diff|changes)\b|^(workspace|file\s*tree|files changed)$/i;

    // Panels Arena may render the diff in: an overlay drawer, a split pane or
    // a dialog. Anything that is just the nav icon is far too small to pass
    // the size gate below.
    const DIFF_PANEL_HINTS = [
        '[data-testid*="workspace" i]',
        '[class*="workspace-panel" i]',
        '[class*="workspace-pane" i]',
        '[aria-label*="workspace" i]',
        '[data-testid*="file-tree" i]',
        '[class*="file-tree" i]',
        '[class*="filetree" i]',
        '[data-testid*="diff" i]',
        '[data-testid*="patch" i]',
        '[data-testid*="changes" i]',
        '[data-diff]',
        '[class*="diff-view" i]',
        '[class*="diffview" i]',
        '[class*="diff-panel" i]',
        '[class*="diff-container" i]',
        '[class*="diffEditor" i]',
        '[class*="monaco-diff" i]',
        '[class*="react-diff" i]',
        '[class*="code-diff" i]',
        '[class*="changes-panel" i]',
        '[aria-label*="diff" i]',
        '[aria-label*="files changed" i]',
        // Generic surfaces: only accepted when they actually hold diff content.
        '[role="dialog"]',
        '[role="complementary"]',
        'aside',
    ];

    const DIFF_CONTENT_HINTS =
        '[class*="diff-line" i],[class*="diff-row" i],[class*="diff-hunk" i],' +
        '[class*="monaco" i],[data-line-type],[data-diff-key],[class*="patch" i],' +
        'pre[class*="diff" i],[data-line-number]';

    function metaOf(el) {
        return [
            classish(el),
            el.id || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('data-testid') || '',
        ].join(' ');
    }

    /** A real diff surface is only trusted if it actually holds diff content. */
    function holdsDiffContent(el) {
        return !!el.querySelector(DIFF_CONTENT_HINTS);
    }

    function isFloating(el) {
        const position = getComputedStyle(el).position || 'static';
        return position === 'fixed' || position === 'absolute';
    }

    /** The "Open workspace" nav button (any size: it is only an anchor). */
    function findWorkspaceToggle() {
        for (const el of $$('button, [role="button"], a, [role="tab"]')) {
            if (isOurs(el) || el.closest('[role="log"]')) continue;
            if (el.querySelector('[role="log"]')) continue;
            if (!isVisible(el)) continue;
            const label = [
                el.getAttribute('aria-label'),
                el.getAttribute('title'),
                text(el).slice(0, 40),
            ].filter(Boolean).join(' ').trim();
            if (!label) continue;
            if (!WORKSPACE_TOGGLE_LABEL.test(label)) continue;
            // A toggle is a control, not the panel itself.
            const rect = el.getBoundingClientRect();
            if (rect.width > 320 || rect.height > 120) continue;
            return el;
        }
        return null;
    }

    /** Whether the toggle (or its tab wrapper) says the panel is open. */
    function toggleIsOpen(toggle) {
        if (!toggle) return false;
        for (const level of [toggle, toggle.parentElement, toggle.closest('[data-state]')]) {
            if (!level) continue;
            const state = level.getAttribute('data-state');
            if (state === 'open' || state === 'on') return true;
            if (state === 'closed' || state === 'off') return false;
            const expanded = level.getAttribute('aria-expanded');
            if (expanded === 'true') return true;
            if (expanded === 'false') return false;
            const pressed = level.getAttribute('aria-pressed');
            if (pressed === 'true') return true;
            if (pressed === 'false') return false;
        }
        return true; // no explicit state: fall back to visibility checks
    }

    /**
     * Whether an element is, sits inside, or wraps the composer. The composer
     * is often a tall floating bar (especially once pinned), so without this
     * the generic panel/dialog fallback can grab its text field.
     */
    function touchesComposer(el) {
        if (el.closest('[data-afx-composer="1"], [data-afx-pinned="1"]')) return true;
        if (el.querySelector('[data-afx-composer="1"], [data-afx-pinned="1"]')) return true;
        if (el.matches('textarea, input, [role="textbox"], [contenteditable="true"]')) return true;
        for (const part of [composer.el, composer.bar]) {
            if (!part || !part.isConnected) continue;
            if (part === el || part.contains(el) || el.contains(part)) return true;
        }
        return false;
    }

    function isPanelCandidate(el, vw) {
        if (!isElement(el) || isOurs(el)) return false;
        if (el.closest('[role="log"]')) return false;
        if (el.querySelector('[role="log"]')) return false;
        if (touchesComposer(el)) return false;
        if (el.id === AFX.exportBtnId) return false;
        if (!isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 200) return false;
        if (rect.width > vw + 2 && !isFloating(el)) return false;
        if (rect.right < 80 || rect.left > vw - 80) return false;
        if (rect.bottom < 80 || rect.top > viewportBottom() - 80) return false;
        return true;
    }

    /** Resolve the panel through the toggle's aria-controls, if it has one. */
    function panelFromToggle(toggle) {
        if (!toggle) return null;
        const holder = toggle.hasAttribute('aria-controls') ? toggle : toggle.closest('[aria-controls]');
        if (!holder) return null;
        const id = holder.getAttribute('aria-controls');
        if (!id) return null;
        let target = null;
        try {
            target = document.getElementById(id);
        } catch (_e) {}
        if (!target || target.contains(toggle)) return null;
        return isPanelCandidate(target, viewportWidth()) ? target : null;
    }

    /**
     * Find the panel that holds the diff viewer.
     *
     * 1. The "Open workspace" nav button is authoritative: when it reports the
     *    panel as open, use its aria-controls target or the largest
     *    workspace-flavoured panel on screen.
     * 2. Otherwise fall back to diff-flavoured surfaces and content sniffing.
     */
    function findDiffPanel() {
        const vw = viewportWidth();
        const toggle = findWorkspaceToggle();
        const open = toggleIsOpen(toggle);

        if (open) {
            const controlled = panelFromToggle(toggle);
            if (controlled) return controlled;
        }

        const seen = new Set();
        let best = null;
        let bestArea = 0;

        /** Largest accepted surface wins, which favours the outer panel. */
        const consider = (el) => {
            if (seen.has(el)) return;
            seen.add(el);
            if (!isPanelCandidate(el, vw)) return;

            const meta = metaOf(el);
            const workspaceish = /workspace|file-?tree|file-?browser/i.test(meta);
            const diffish = /diff|patch|changes/i.test(meta);
            const content = holdsDiffContent(el);

            // Without the toggle's blessing we need some evidence.
            if (!open && !workspaceish && !diffish && !content) return;
            if (!isFloating(el) && !content && !workspaceish) return;

            const area = el.getBoundingClientRect().width * el.getBoundingClientRect().height;
            if (area > bestArea) {
                best = el;
                bestArea = area;
            }
        };

        for (const selector of DIFF_PANEL_HINTS) {
            for (const el of $$(selector)) consider(el);
        }

        if (!best && open) {
            // The toggle says it is open but nothing is flavoured: accept the
            // largest panel-sized surface that is not the conversation.
            for (const el of $$('[role="dialog"], aside, [class*="panel" i], [class*="drawer" i], [class*="sidebar" i]')) {
                consider(el);
            }
        }
        return best;
    }

    /** Verbose diagnostics for the panel detection (console only). */
    function debugDiffPanel() {
        const vw = viewportWidth();
        const toggle = findWorkspaceToggle();
        const report = {
            viewport: { width: vw, height: viewportBottom() },
            toggle: toggle ? {
                label: toggle.getAttribute('aria-label') || text(toggle).slice(0, 40),
                open: toggleIsOpen(toggle),
                ariaControls: toggle.getAttribute('aria-controls'),
                rect: (() => { const r = toggle.getBoundingClientRect(); return [r.top, r.left, r.width, r.height]; })(),
            } : null,
            chosen: null,
            candidates: [],
        };

        const seen = new Set();
        for (const selector of DIFF_PANEL_HINTS) {
            for (const el of $$(selector)) {
                if (seen.has(el)) continue;
                seen.add(el);
                const rect = el.getBoundingClientRect();
                report.candidates.push({
                    selector,
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    cls: (classish(el) || '').slice(0, 120),
                    aria: el.getAttribute('aria-label'),
                    testid: el.getAttribute('data-testid'),
                    rect: [rect.top, rect.left, rect.width, rect.height],
                    visible: isVisible(el),
                    floating: isFloating(el),
                    content: holdsDiffContent(el),
                    accepted: isPanelCandidate(el, vw),
                });
            }
        }

        const chosen = findDiffPanel();
        if (chosen) {
            const rect = chosen.getBoundingClientRect();
            report.chosen = {
                tag: chosen.tagName.toLowerCase(),
                cls: (classish(chosen) || '').slice(0, 120),
                rect: [rect.top, rect.left, rect.width, rect.height],
            };
        }
        console.log('[FocusMode] diff/workspace panel report', report);
        return report;
    }

    /**
     * Clear width caps on descendants so the diff body — not just its shell —
     * uses the room. Narrow side rails (file trees, gutters) are left at their
     * own width: only capped columns and the panel's main region are widened.
     */
    function widenDiffContents(panel) {
        const vw = viewportWidth();
        const panelWidth = panel.getBoundingClientRect().width || vw;
        let depth = 0;
        let level = [panel];

        while (level.length && depth < 3) {
            const next = [];
            for (const node of level) {
                for (const child of node.children) {
                    if (!isElement(child) || isOurs(child)) continue;
                    next.push(child);

                    const rect = child.getBoundingClientRect();
                    if (rect.height < 40) continue;                  // toolbars, gutters
                    if (rect.width <= 0) continue;
                    if (rect.width >= vw - 8) continue;              // already wide

                    const meta = metaOf(child);
                    if (/tree|sidebar|explorer|file-?list|outline/i.test(meta)) continue;

                    const style = getComputedStyle(child);
                    const maxWidth = parseFloat(style.maxWidth);
                    const capped = !isNaN(maxWidth) && maxWidth < vw - 8;
                    const mainRegion = rect.width >= panelWidth * 0.6;
                    if (!capped && !mainRegion) continue;             // leave side rails alone
                    if (child.dataset.afxDiffWide === '1') continue;
                    child.dataset.afxDiffWide = '1';
                    child.style.setProperty('max-width', 'none', 'important');
                    child.style.setProperty('width', '100%', 'important');
                    child.style.setProperty('margin-left', '0', 'important');
                    child.style.setProperty('margin-right', '0', 'important');
                }
            }
            level = next;
            depth++;
        }
    }

    function applyDiffWidth(panel) {
        const vw = viewportWidth();
        const rect = panel.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        panel.dataset.afxDiff = '1';
        const floating = isFloating(panel);

        if (floating) {
            diffview.floating = true;
            panel.dataset.afxDiffFloating = '1';

            // A centred modal uses a transform for its offset; clearing it
            // without freezing the box would teleport the panel.
            const transform = getComputedStyle(panel).transform;
            if (transform && transform !== 'none') {
                panel.style.setProperty('transform', 'none', 'important');
                panel.style.setProperty('top', Math.round(Math.max(0, rect.top)) + 'px', 'important');
            }

            panel.style.setProperty('left', '0px', 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('width', vw + 'px', 'important');
            panel.style.setProperty('max-width', 'none', 'important');
            panel.style.setProperty('margin-left', '0', 'important');
            panel.style.setProperty('margin-right', '0', 'important');
        } else {
            diffview.floating = false;
            delete panel.dataset.afxDiffFloating;
            panel.style.removeProperty('left');
            panel.style.removeProperty('right');
            panel.style.setProperty('max-width', 'none', 'important');
            panel.style.setProperty('width', '100%', 'important');
            panel.style.setProperty('min-width', '0', 'important');
            panel.style.setProperty('margin-left', '0', 'important');
            panel.style.setProperty('margin-right', '0', 'important');
            panel.style.setProperty('flex', '1 1 auto', 'important');

            // Let the surrounding column give it more room, but never touch an
            // ancestor that also holds the conversation.
            let node = panel.parentElement;
            for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
                if (node === document.body || node === document.documentElement) break;
                if (node.matches('main, [role="main"]')) break;
                if (follow.log && node.contains(follow.log)) break;
                if (node.dataset.afxWideDiffParent === '1') continue;
                const parentRect = node.getBoundingClientRect();
                const maxWidth = parseFloat(getComputedStyle(node).maxWidth);
                const capped = (!isNaN(maxWidth) && maxWidth < vw - 8) ||
                    (parentRect.width > 0 && parentRect.width < vw - 8);
                if (!capped) continue;
                node.dataset.afxWideDiffParent = '1';
                node.style.setProperty('max-width', 'none', 'important');
                node.style.setProperty('width', '100%', 'important');
                node.style.setProperty('margin-left', '0', 'important');
                node.style.setProperty('margin-right', '0', 'important');
            }
        }

        widenDiffContents(panel);
        log('diff viewer widened', floating ? '(floating)' : '(in flow)');
    }

    function ensureDiffViewerWide() {
        if (!CFG.wideDiffViewer) return;

        const panel = findDiffPanel();
        if (!panel) {
            if (diffview.el) {
                diffview.el = null;
                diffview.floating = false;
            }
            return;
        }
        if (panel !== diffview.el) {
            diffview.el = panel;
            diffview.lastCheck = 0;
        }

        // Cheap guard: only do work while something is actually off.
        const rect = panel.getBoundingClientRect();
        const wideEnough = rect.width >= viewportWidth() - 8;
        if (wideEnough && panel.dataset.afxDiff === '1') return;

        const now = performance.now();
        if (now - diffview.lastCheck < 400) return;
        diffview.lastCheck = now;

        applyDiffWidth(panel);
    }

    /** Re-apply a fixed pixel width after the viewport changes. */
    function syncDiffViewerWidth() {
        const panel = diffview.el;
        if (!CFG.wideDiffViewer || !panel || !panel.isConnected) return;
        if (diffview.floating) applyDiffWidth(panel);
    }

    // ════════════════════════════════════════════════════════════════
    // 3. DOM OPTIMISATION
    // ════════════════════════════════════════════════════════════════

    const activity = new WeakMap();      // message element -> last mutation timestamp
    const optimized = new WeakSet();     // message elements already flattened
    const codeOriginals = new WeakMap(); // flattened <code> -> highlighted markup

    function markActivity(records) {
        const listParent = follow.listParent;
        if (!listParent) return;

        const messageEls = new Set();
        for (const record of records) {
            let node = record.target;
            while (node && node.parentElement && node.parentElement !== listParent) {
                node = node.parentElement;
            }
            if (!node || node.parentElement !== listParent) continue;
            messageEls.add(node);
        }
        const now = Date.now();
        messageEls.forEach((el) => {
            activity.set(el, now);
            optimized.delete(el);
        });
    }

    function flattenCodeBlocks(root) {
        if (!CFG.flattenCode) return 0;
        let flattened = 0;
        for (const code of $$('pre code', root)) {
            if (code.dataset.afxFlat === '1') continue;
            if (code.children.length < 4) {
                code.dataset.afxFlat = '1';
                continue;
            }
            const lines = code.querySelectorAll('.line');
            const plain = lines.length
                ? Array.from(lines, (line) => line.textContent).join('\n')
                : code.textContent;
            if (!plain) continue;
            // Keep the highlighted markup so exports stay colourful.
            codeOriginals.set(code, code.innerHTML);
            code.textContent = plain;
            code.dataset.afxFlat = '1';
            flattened++;
        }
        return flattened;
    }

    function unwrapEmptySpans(root) {
        if (!CFG.unwrapEmptySpans) return 0;
        let unwrapped = 0;
        for (const span of $$('span:not([class]):not([style]):not([data-afx-keep])', root)) {
            if (span.attributes.length) continue;
            if (span.children.length !== 1 || span.firstChild.nodeType !== 3) continue;
            span.replaceWith(span.firstChild);
            unwrapped++;
        }
        return unwrapped;
    }

    function optimizeSweep() {
        if (!CFG.optimizeDOM) return;
        const logEl = follow.log || findLog();
        if (!logEl) return;

        const list = findMessageList(logEl);
        const messages = list.messages;
        if (!messages.length) return;

        const now = Date.now();
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const isNewest = i >= messages.length - 2;
            const last = activity.get(msg) || 0;
            if (isNewest || now - last < CFG.idleBeforeOptimize) continue;
            if (optimized.has(msg)) continue;

            flattenCodeBlocks(msg);
            unwrapEmptySpans(msg);

            if (CFG.contentVisibility && i < messages.length - 3 && !msg.classList.contains('afx-cv')) {
                msg.classList.add('afx-cv');
            }
            optimized.add(msg);
        }
    }

    function installOptimizer() {
        optimizeSweep(); // first pass on whatever already exists
        setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(optimizeSweep, { timeout: 2000 });
            } else {
                optimizeSweep();
            }
        }, CFG.sweepInterval);
    }

    // ════════════════════════════════════════════════════════════════
    // 4. HTML EXPORT
    // ════════════════════════════════════════════════════════════════

    /** Absolute-ise relative url() references so the file keeps its assets. */
    function absolutiseURLs(cssText) {
        return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote, url) => {
            if (/^(data:|blob:|https?:|\/\/|#)/i.test(url)) return match;
            try {
                return 'url("' + new URL(url, location.href).href + '")';
            } catch (_e) {
                return match;
            }
        });
    }

    function collectPageCSS() {
        const chunks = [];
        let total = 0;

        // Never ship our own injected stylesheet into the export.
        const ownSheets = new Set();
        for (const el of $$('#' + AFX.styleId + ', style[' + AFX.ui + ']')) {
            if (el.sheet) ownSheets.add(el.sheet);
        }

        const sheets = [];
        try { sheets.push(...Array.from(document.styleSheets)); } catch (_e) {}
        try {
            if (document.adoptedStyleSheets) sheets.push(...Array.from(document.adoptedStyleSheets));
        } catch (_e) {}

        for (const sheet of sheets) {
            if (ownSheets.has(sheet)) continue;
            const owner = sheet.ownerNode;
            if (owner && (owner.id === AFX.styleId || owner.hasAttribute?.(AFX.ui))) continue;
            let rules = null;
            try { rules = sheet.cssRules; } catch (_e) { continue; } // cross-origin
            if (!rules || !rules.length) continue;

            let text = '';
            for (const rule of rules) {
                try { text += rule.cssText + '\n'; } catch (_e) {}
            }
            if (!text) continue;
            if (text.includes(MARKER)) continue; // last resort: our own banner comment

            const media = sheet.media && sheet.media.mediaText;
            let block = media && media !== 'all' ? '@media ' + media + ' {\n' + text + '\n}' : text;
            block = absolutiseURLs(block);

            if (total + block.length > CFG.exportMaxCSSBytes) break;
            chunks.push(block);
            total += block.length;
        }
        return chunks.join('\n');
    }

    function sanitizeClone(root) {
        // Deliberately narrow: only executable nodes and our own UI are removed,
        // so the exported markup stays pixel-identical to Arena's.
        for (const sel of ['script', 'noscript', 'template', '[' + AFX.ui + ']', '#' + AFX.exportBtnId]) {
            for (const el of $$(sel, root)) el.remove();
        }

        for (const el of $$('[contenteditable],[spellcheck],[autofocus],[draggable]', root)) {
            el.removeAttribute('contenteditable');
            el.removeAttribute('spellcheck');
            el.removeAttribute('autofocus');
            el.removeAttribute('draggable');
        }
        return root;
    }

    /**
     * Flattening is a live-page optimisation; inside the export we want the
     * original Shiki markup back so syntax colours survive.
     */
    function restoreCodeOriginals(logEl, clone) {
        const live = $$('pre code', logEl);
        const copy = $$('pre code', clone);
        if (live.length !== copy.length) return 0;
        let restored = 0;
        for (let i = 0; i < live.length; i++) {
            const original = codeOriginals.get(live[i]);
            if (!original) continue;
            copy[i].innerHTML = original;
            copy[i].removeAttribute('data-afx-flat');
            restored++;
        }
        return restored;
    }

    /** Virtualised shells must not hide messages inside the export. */
    function unhideMessageShells(root) {
        const list = findMessageList(root);
        for (const msg of list.messages) {
            msg.removeAttribute('hidden');
            msg.removeAttribute('aria-hidden');
            msg.classList.remove('afx-cv');
            msg.style.removeProperty('content-visibility');
            if (msg.style.display === 'none') msg.style.removeProperty('display');
        }
    }

    // ── Folding ──────────────────────────────────────────────────────

    function isOpenState(trigger, panel) {
        const state = trigger.getAttribute('data-state');
        if (state) return state === 'open';
        const expanded = trigger.getAttribute('aria-expanded');
        if (expanded != null) return expanded === 'true';
        const panelState = panel.getAttribute('data-state');
        if (panelState) return panelState === 'open';
        return !panel.hasAttribute('hidden');
    }

    function applyPanelVisibility(panel, open) {
        if (open) {
            panel.removeAttribute('hidden');
            panel.removeAttribute('inert');
            if (panel.style.display === 'none') panel.style.removeProperty('display');
            if (panel.style.height) panel.style.removeProperty('height');
            if (panel.style.overflow) panel.style.removeProperty('overflow');
            panel.setAttribute('data-state', 'open');
        } else {
            panel.setAttribute('hidden', '');
            panel.setAttribute('data-state', 'closed');
        }
    }

    function findFoldPanel(trigger, group, root) {
        const controls = trigger.getAttribute('aria-controls');
        if (controls) {
            // Resolve inside the detached clone, never against the live page.
            let target = null;
            try {
                const safeId = String(controls).replace(/["\\]/g, '\\$&');
                target = root.querySelector('[id="' + safeId + '"]');
            } catch (_e) {}
            if (target && !target.contains(trigger)) return target;
        }
        if (!group) return null;
        for (const candidate of group.querySelectorAll('[data-state],[role="region"]')) {
            if (candidate === trigger) continue;
            if (candidate.contains(trigger)) continue;
            if (candidate.matches('button,[role="button"],a,input,select')) continue;
            return candidate;
        }
        // Last resort: a sibling that follows the trigger's header row.
        const header = trigger.parentElement;
        if (header && header.parentElement === group) {
            const sibling = header.nextElementSibling;
            if (sibling && !sibling.contains(trigger)) return sibling;
        }
        return null;
    }

    function prepareFolds(root) {
        let groups = 0;
        const triggers = $$('button[data-state], button[aria-expanded], [role="button"][aria-expanded]', root);

        for (const trigger of triggers) {
            if (trigger.closest('[data-afx-group]')) continue; // nested, already handled
            if (trigger.hasAttribute('data-afx-trigger')) continue;

            // Radix collapsibles: the wrapper carries data-state too.
            let group = null;
            let node = trigger.parentElement;
            for (let i = 0; node && i < 4; i++, node = node.parentElement) {
                const state = node.getAttribute && node.getAttribute('data-state');
                if (state === 'open' || state === 'closed') { group = node; break; }
            }

            const panel = findFoldPanel(trigger, group, root);
            if (!panel) continue;
            if (!group) group = trigger.parentElement;
            if (!group) continue;

            const open = isOpenState(trigger, panel);
            group.setAttribute('data-afx-group', '1');
            group.setAttribute('data-afx-open', open ? '1' : '0');
            trigger.setAttribute('data-afx-trigger', '1');
            panel.setAttribute('data-afx-panel', '1');
            applyPanelVisibility(panel, open);
            groups++;
        }
        return groups;
    }

    const EXPORT_SHIM = `
(function () {
    function setOpen(group, open) {
        var trigger = group.querySelector('[data-afx-trigger]');
        var panel = group.querySelector('[data-afx-panel]');
        group.setAttribute('data-afx-open', open ? '1' : '0');
        if (trigger) {
            trigger.setAttribute('data-state', open ? 'open' : 'closed');
            trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (panel) {
            panel.setAttribute('data-state', open ? 'open' : 'closed');
            if (open) {
                panel.removeAttribute('hidden');
                panel.removeAttribute('inert');
                if (panel.style.display === 'none') panel.style.removeProperty('display');
                if (panel.style.height) panel.style.removeProperty('height');
                if (panel.style.overflow) panel.style.removeProperty('overflow');
            } else {
                panel.setAttribute('hidden', '');
            }
        }
    }
    document.querySelectorAll('[data-afx-trigger]').forEach(function (trigger) {
        trigger.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var group = trigger.closest('[data-afx-group]');
            if (!group) return;
            setOpen(group, group.getAttribute('data-afx-open') !== '1');
        });
    });
    var expandAll = document.getElementById('afx-expand-all');
    var collapseAll = document.getElementById('afx-collapse-all');
    function setAll(open) {
        document.querySelectorAll('[data-afx-group]').forEach(function (group) { setOpen(group, open); });
    }
    if (expandAll) expandAll.addEventListener('click', function () { setAll(true); });
    if (collapseAll) collapseAll.addEventListener('click', function () { setAll(false); });
})();`;

    const EXPORT_CSS = `
/* ── Export shell ─────────────────────────────────────────────────── */
html, body { margin: 0 !important; padding: 0 !important; }
body { min-height: 100vh; }
.afx-export { max-width: 52rem; margin: 0 auto; padding: 28px 20px 96px; box-sizing: border-box; }
.afx-export [role="log"] {
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
    padding: 0 !important;
}
.afx-export [role="log"] > * { contain: none !important; content-visibility: visible !important; }
.afx-export [role="log"] * { scroll-behavior: auto !important; }
[data-afx-panel][hidden] { display: none !important; }
[data-afx-trigger] { cursor: pointer; }
.afx-doc-head { margin: 0 0 22px; padding-bottom: 14px; border-bottom: 1px solid rgba(127,127,127,.28); }
.afx-doc-head h1 { font-size: 19px; line-height: 1.3; margin: 0 0 6px; }
.afx-doc-head .afx-meta { font-size: 12px; line-height: 1.6; opacity: .72; }
.afx-doc-head .afx-meta a { color: inherit; }
.afx-tools { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 6px; z-index: 20; }
.afx-tools button {
    font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 7px 11px; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(127,127,127,.35);
    background: rgba(127,127,127,.14);
    color: inherit;
}
.afx-tools button:hover { background: rgba(127,127,127,.26); }
@media print { .afx-tools { display: none !important; } .afx-export { padding: 0; } }
`;

    function buildExportDocument() {
        const logEl = follow.log && follow.log.isConnected ? follow.log : findLog();
        if (!logEl) {
            console.warn('[FocusMode] No conversation found to export.');
            return null;
        }

        const clone = logEl.cloneNode(true);
        sanitizeClone(clone);
        restoreCodeOriginals(logEl, clone);
        unhideMessageShells(clone);
        const foldCount = prepareFolds(clone);

        const list = findMessageList(logEl);
        const messageCount = list.messages.length;
        const title = pageTitle();
        const root = document.documentElement;
        const bodyStyle = getComputedStyle(document.body || root);

        const htmlClass = root.getAttribute('class') || '';
        const dataTheme = root.getAttribute('data-theme') || '';
        const dataColorMode = root.getAttribute('data-color-mode') || '';
        const rootStyle = root.getAttribute('style') || '';
        const bodyClass = document.body ? (document.body.getAttribute('class') || '') : '';
        const exportedAt = new Date();

        const css = collectPageCSS();

        return '<!DOCTYPE html>\n' +
'<html lang="' + escapeHTML(root.getAttribute('lang') || 'en') + '"' +
(htmlClass ? ' class="' + escapeHTML(htmlClass) + '"' : '') +
(dataTheme ? ' data-theme="' + escapeHTML(dataTheme) + '"' : '') +
(dataColorMode ? ' data-color-mode="' + escapeHTML(dataColorMode) + '"' : '') +
(rootStyle ? ' style="' + escapeHTML(rootStyle) + '"' : '') + '>\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>' + escapeHTML(title) + '</title>\n' +
'<style>\n' + css + '\n' + EXPORT_CSS + '\n</style>\n' +
'</head>\n' +
'<body' + (bodyClass ? ' class="' + escapeHTML(bodyClass) + '"' : '') + ' style="background-color:' + escapeHTML(bodyStyle.backgroundColor) +
';color:' + escapeHTML(bodyStyle.color) + ';font-family:' + escapeHTML(bodyStyle.fontFamily) + '">\n' +
'<main class="afx-export">\n' +
'  <header class="afx-doc-head">\n' +
'    <h1>' + escapeHTML(title) + '</h1>\n' +
'    <div class="afx-meta">\n' +
'      Exported ' + escapeHTML(exportedAt.toLocaleString()) + ' &middot; ' +
escapeHTML(String(messageCount)) + ' messages &middot; ' +
escapeHTML(String(foldCount)) + ' collapsible blocks<br>\n' +
'      Source: <a href="' + escapeHTML(location.href) + '">' + escapeHTML(location.href) + '</a>\n' +
'    </div>\n' +
'  </header>\n' +
clone.outerHTML + '\n' +
'</main>\n' +
'<div class="afx-tools">\n' +
'  <button type="button" id="afx-expand-all">Expand all</button>\n' +
'  <button type="button" id="afx-collapse-all">Collapse all</button>\n' +
'</div>\n' +
'<script>\n' + EXPORT_SHIM + '\n<\/script>\n' +
'</body>\n</html>\n';
    }

    function download(content, filename, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function exportConversation() {
        try {
            const html = buildExportDocument();
            if (!html) return;
            const filename = 'arena-' + slugify(pageTitle()) + '-' + new Date().toISOString().slice(0, 10) + '.html';
            download(html, filename, 'text/html;charset=utf-8');
            log('exported', filename, html.length, 'bytes');
        } catch (error) {
            console.error('[FocusMode] Export failed:', error);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // 5. NAV EXPORT BUTTON
    // ════════════════════════════════════════════════════════════════

    const EXPORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 3v10.5"></path>' +
        '<path d="m8.25 10.25 3.75 3.75 3.75-3.75"></path>' +
        '<path d="M4.5 16.5v2.25A2.25 2.25 0 0 0 6.75 21h10.5a2.25 2.25 0 0 0 2.25-2.25V16.5"></path>' +
        '</svg>';

    const DIFF_SELECTORS = [
        '[aria-label*="diff" i]',
        '[title*="diff" i]',
        '[data-testid*="diff" i]',
        '[aria-label*="changes" i]',
        '[title*="changes" i]',
        '[aria-label*="files changed" i]',
        '[title*="files changed" i]',
        '[data-testid*="files" i]',
    ];

    function findDiffControl() {
        for (const selector of DIFF_SELECTORS) {
            for (const el of $$(selector)) {
                if (isOurs(el) || el.closest('[role="log"]')) continue;
                if (el.closest('[data-afx-diff="1"]') || el.hasAttribute('data-afx-diff')) continue;
                if (!isVisible(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.top > window.innerHeight * 0.22) continue; // must live in the top nav
                return el;
            }
        }
        return null;
    }

    function findNavBar() {
        for (const el of $$('header, nav')) {
            if (isOurs(el) || !isVisible(el) || el.closest('[role="log"]')) continue;
            const r = el.getBoundingClientRect();
            if (r.top <= 24 && r.height > 20 && r.height < 140) return el;
        }
        return null;
    }

    function placeExportButton(btn) {
        const diff = findDiffControl();
        if (diff && diff.parentElement) {
            if (btn.parentElement !== diff.parentElement || btn.nextElementSibling !== diff) {
                diff.parentElement.insertBefore(btn, diff);
            }
            delete btn.dataset.afxFloating;
            return true;
        }

        const nav = findNavBar();
        if (nav) {
            if (!btn.isConnected || !nav.contains(btn)) nav.appendChild(btn);
            delete btn.dataset.afxFloating;
            return true;
        }

        // Last resort: a floating button that still works.
        if (!btn.isConnected || btn.parentElement !== document.body) {
            document.body.appendChild(btn);
        }
        btn.dataset.afxFloating = '1';
        return false;
    }

    function createExportButton() {
        const btn = document.createElement('button');
        btn.id = AFX.exportBtnId;
        btn.type = 'button';
        btn.setAttribute(AFX.ui, '1');
        btn.setAttribute('aria-label', 'Export conversation as HTML');
        btn.title = 'Export conversation as HTML';
        btn.innerHTML = EXPORT_ICON;
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            exportConversation();
        });
        return btn;
    }

    let lastNavCheck = 0;

    function ensureExportButton() {
        if (!CFG.showExportButton) return;
        let btn = document.getElementById(AFX.exportBtnId);
        if (!btn) {
            btn = createExportButton();
            document.body.appendChild(btn);
            placeExportButton(btn);
            lastNavCheck = performance.now();
            return;
        }
        if (!btn.isConnected) {
            document.body.appendChild(btn);
            placeExportButton(btn);
            lastNavCheck = performance.now();
            return;
        }
        const now = performance.now();
        if (now - lastNavCheck < 4000) return; // re-verify placement occasionally only
        lastNavCheck = now;
        placeExportButton(btn);
    }

    // ════════════════════════════════════════════════════════════════
    // 5. SETTINGS MENU
    // ════════════════════════════════════════════════════════════════
    //
    // A small tab on the right edge of the viewport expands into a drawer
    // holding every CFG option. Changes are saved straight away. Most apply
    // live; the few that undo layout work done earlier on the page (or that
    // set up timers at boot) ask for a reload instead of half-applying.

    // reload: 'off'    → switching it on applies live, switching it off needs a reload
    // reload: 'always' → any change needs a reload
    // requires         → greyed out while that other setting is off
    const SETTINGS_SCHEMA = [
        {
            title: 'Follow',
            items: [
                { key: 'autoScroll', label: 'Auto-scroll while streaming',
                    hint: 'Stays on the newest message until you scroll up, select text or press PageUp/Home.' },
                { key: 'resumeOnArrow', label: 'Resume on the scroll-down arrow', requires: 'autoScroll',
                    hint: "Clicking Arena's round arrow above the composer turns following back on." },
                { key: 'followThreshold', label: 'Bottom threshold', type: 'number', unit: 'px',
                    min: 0, max: 2000, step: 10, requires: 'autoScroll',
                    hint: 'How close to the bottom still counts as "at the bottom".' },
            ],
        },
        {
            title: 'Zoom',
            items: [
                { key: 'preventZoom', label: 'Lock page zoom',
                    hint: 'Blocks Ctrl/\u2318 + wheel, Ctrl/\u2318 +/\u2212/0 and pinch zoom.' },
            ],
        },
        {
            title: 'Layout',
            items: [
                { key: 'pinComposer', label: 'Pin composer to the bottom', reload: 'off' },
                { key: 'wideComposer', label: 'Full-width composer', reload: 'off' },
                { key: 'pinTopNav', label: 'Pin navbar to the top', reload: 'off' },
                { key: 'wideDiffViewer', label: 'Full-width diff viewer', reload: 'off' },
            ],
        },
        {
            title: 'Performance',
            items: [
                { key: 'optimizeDOM', label: 'Optimise idle messages', reload: 'off',
                    hint: 'Master switch for everything in this section.' },
                { key: 'killTransitions', label: 'Disable animations', requires: 'optimizeDOM' },
                { key: 'killBlurs', label: 'Disable backdrop blur', requires: 'optimizeDOM' },
                { key: 'flattenCode', label: 'Flatten highlighted code blocks', requires: 'optimizeDOM', reload: 'off',
                    hint: 'Turns syntax-highlighted code into plain text once a message is idle.' },
                { key: 'unwrapEmptySpans', label: 'Unwrap empty inline wrappers', requires: 'optimizeDOM', reload: 'off' },
                { key: 'contentVisibility', label: 'Skip rendering off-screen messages', requires: 'optimizeDOM', reload: 'off' },
                { key: 'idleBeforeOptimize', label: 'Idle time before optimising', type: 'number', unit: 's',
                    scale: 1000, min: 0.5, max: 60, step: 0.5, requires: 'optimizeDOM' },
            ],
        },
        {
            title: 'Export',
            items: [
                { key: 'showExportButton', label: 'Show export button in the navbar' },
                { key: 'exportMaxCSSBytes', label: 'Stylesheet size limit', type: 'number', unit: 'MB',
                    scale: 1024 * 1024, min: 0.5, max: 64, step: 0.5,
                    hint: 'How much of Arena\'s CSS is copied into an exported file.' },
            ],
        },
        {
            title: 'Advanced',
            items: [
                { key: 'idleFollowPoll', label: 'Follow safety poll', type: 'number', unit: 'ms',
                    min: 200, max: 10000, step: 50, reload: 'always' },
                { key: 'sweepInterval', label: 'Optimiser sweep interval', type: 'number', unit: 'ms',
                    min: 500, max: 60000, step: 500, reload: 'always' },
                { key: 'verbose', label: 'Verbose console logging' },
            ],
        },
    ];

    const SETTINGS_OPEN_KEY = 'afx-focus-mode-settings-open';

    const GEAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>' +
        '<circle cx="12" cy="12" r="3"/></svg>';

    const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

    const settingsUI = { root: null, tab: null, drawer: null, closeBtn: null, reloadBar: null, rows: new Map() };

    function buildSettingsCSS() {
        const root = '#' + AFX.settingsId;
        const dark = `
            --afx-bg: #18181b;
            --afx-fg: #f4f4f5;
            --afx-muted: #a1a1aa;
            --afx-border: rgba(255,255,255,.10);
            --afx-hover: rgba(255,255,255,.06);
            --afx-track: #3f3f46;
            --afx-accent: #3b82f6;
            --afx-shadow: rgba(0,0,0,.5);
        `;
        return `
            /* ── Settings drawer ── */
            ${root} {
                --afx-bg: #ffffff;
                --afx-fg: #18181b;
                --afx-muted: #71717a;
                --afx-border: rgba(0,0,0,.10);
                --afx-hover: rgba(0,0,0,.05);
                --afx-track: #d4d4d8;
                --afx-accent: #2563eb;
                --afx-shadow: rgba(0,0,0,.18);
                position: fixed !important;
                top: 0; right: 0; bottom: 0;
                width: min(340px, 100vw);
                z-index: 2147483000 !important;
                transform: translateX(100%);
                transition: transform .22s cubic-bezier(.2,.8,.2,1) !important;
                pointer-events: none;
                font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                color: var(--afx-fg);
                text-align: left;
            }
            @media (prefers-color-scheme: dark) {
                html:not(.light):not([data-theme="light"]) ${root} { ${dark} }
            }
            html.dark ${root}, html[data-theme="dark"] ${root}, html[style*="color-scheme: dark"] ${root} { ${dark} }
            ${root}[data-open="1"] { transform: none; }
            ${root} *, ${root} *::before, ${root} *::after { box-sizing: border-box; }

            ${root} .afx-s-tab {
                position: absolute;
                top: 50%;
                left: -28px;
                width: 28px;
                height: 44px;
                margin-top: -22px;
                padding: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                border: 1px solid var(--afx-border);
                border-right: 0;
                border-radius: 10px 0 0 10px;
                background: var(--afx-bg);
                color: var(--afx-muted);
                box-shadow: -2px 0 8px var(--afx-shadow);
                cursor: pointer;
                pointer-events: auto;
                opacity: .55;
                transition: opacity .12s ease, color .12s ease !important;
            }
            ${root} .afx-s-tab:hover, ${root}[data-open="1"] .afx-s-tab { opacity: 1; color: var(--afx-fg); }
            ${root} .afx-s-tab:focus-visible { outline: 2px solid var(--afx-accent); outline-offset: -2px; opacity: 1; }
            ${root} .afx-s-tab svg { width: 16px; height: 16px; display: block; transition: transform .22s ease !important; }
            ${root}[data-open="1"] .afx-s-tab svg { transform: rotate(90deg); }

            ${root} .afx-s-drawer {
                height: 100%;
                display: flex;
                flex-direction: column;
                background: var(--afx-bg);
                border-left: 1px solid var(--afx-border);
                box-shadow: -8px 0 24px var(--afx-shadow);
                pointer-events: auto;
            }

            ${root} .afx-s-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 14px 16px;
                border-bottom: 1px solid var(--afx-border);
            }
            ${root} .afx-s-title { font-size: 15px; font-weight: 600; }
            ${root} .afx-s-sub { color: var(--afx-muted); font-size: 12px; }
            ${root} .afx-s-icon-btn {
                width: 30px; height: 30px; padding: 0;
                display: inline-flex; align-items: center; justify-content: center;
                border: 0; border-radius: 8px;
                background: transparent; color: var(--afx-muted);
                cursor: pointer;
            }
            ${root} .afx-s-icon-btn:hover { background: var(--afx-hover); color: var(--afx-fg); }
            ${root} .afx-s-icon-btn:focus-visible { outline: 2px solid var(--afx-accent); }
            ${root} .afx-s-icon-btn svg { width: 16px; height: 16px; }

            ${root} .afx-s-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 12px; }
            ${root} .afx-s-section { padding: 10px 16px 4px; }
            ${root} .afx-s-section-title {
                margin: 0 0 4px;
                font-size: 11px;
                font-weight: 600;
                letter-spacing: .06em;
                text-transform: uppercase;
                color: var(--afx-muted);
            }
            ${root} .afx-s-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin: 0 -8px;
                padding: 8px;
                border-radius: 8px;
                cursor: pointer;
            }
            ${root} .afx-s-row:hover { background: var(--afx-hover); }
            ${root} .afx-s-row[data-disabled="1"] { opacity: .45; cursor: default; }
            ${root} .afx-s-row[data-disabled="1"]:hover { background: transparent; }
            ${root} .afx-s-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
            ${root} .afx-s-label { font-weight: 500; }
            ${root} .afx-s-hint { color: var(--afx-muted); font-size: 12px; }
            ${root} .afx-s-badge {
                margin-left: 6px;
                padding: 0 5px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 600;
                vertical-align: 1px;
                color: var(--afx-accent);
                border: 1px solid currentColor;
            }

            ${root} .afx-s-switch {
                appearance: none;
                -webkit-appearance: none;
                flex: 0 0 auto;
                position: relative;
                width: 34px;
                height: 20px;
                margin: 0;
                border-radius: 999px;
                background: var(--afx-track);
                cursor: inherit;
                transition: background-color .15s ease !important;
            }
            ${root} .afx-s-switch::after {
                content: "";
                position: absolute;
                top: 2px; left: 2px;
                width: 16px; height: 16px;
                border-radius: 50%;
                background: #fff;
                box-shadow: 0 1px 2px rgba(0,0,0,.3);
                transition: transform .15s ease !important;
            }
            ${root} .afx-s-switch:checked { background: var(--afx-accent); }
            ${root} .afx-s-switch:checked::after { transform: translateX(14px); }
            ${root} .afx-s-switch:focus-visible { outline: 2px solid var(--afx-accent); outline-offset: 2px; }

            ${root} .afx-s-num { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; color: var(--afx-muted); }
            ${root} .afx-s-num input {
                width: 76px;
                padding: 4px 6px;
                border: 1px solid var(--afx-border);
                border-radius: 6px;
                background: transparent;
                color: var(--afx-fg);
                font: inherit;
                text-align: right;
            }
            ${root} .afx-s-num input:focus { outline: 2px solid var(--afx-accent); outline-offset: -1px; }

            ${root} .afx-s-reload {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                margin: 0 12px 10px;
                padding: 10px 12px;
                border-radius: 8px;
                background: color-mix(in srgb, var(--afx-accent) 14%, transparent);
                font-size: 12px;
            }
            ${root} .afx-s-reload[hidden] { display: none; }
            ${root} .afx-s-foot {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 10px 16px 14px;
                border-top: 1px solid var(--afx-border);
                color: var(--afx-muted);
                font-size: 12px;
            }
            ${root} .afx-s-btn {
                padding: 6px 10px;
                border: 1px solid var(--afx-border);
                border-radius: 8px;
                background: transparent;
                color: var(--afx-fg);
                font: inherit;
                font-weight: 500;
                cursor: pointer;
            }
            ${root} .afx-s-btn:hover { background: var(--afx-hover); }
            ${root} .afx-s-btn:focus-visible { outline: 2px solid var(--afx-accent); }
            ${root} .afx-s-btn-primary { border-color: transparent; background: var(--afx-accent); color: #fff; }
            ${root} .afx-s-btn-primary:hover { background: var(--afx-accent); filter: brightness(1.1); }

            @media print { ${root} { display: none !important; } }
        `;
    }

    function schemaItem(key) {
        for (const section of SETTINGS_SCHEMA) {
            for (const item of section.items) if (item.key === key) return item;
        }
        return null;
    }

    function needsReload() {
        for (const section of SETTINGS_SCHEMA) {
            for (const item of section.items) {
                if (!item.reload || CFG[item.key] === BOOT_CFG[item.key]) continue;
                if (item.reload === 'always') return true;
                if (item.reload === 'off' && BOOT_CFG[item.key] === true && CFG[item.key] === false) return true;
            }
        }
        return false;
    }

    /** Push the side effects of one setting change into the running page. */
    function applySettingLive(key) {
        injectCSS();
        if (key === 'autoScroll') {
            if (CFG.autoScroll) resumeFollowing('settings');
            else stopFollowing('settings');
        }
        if (key === 'preventZoom' && zoomLockMeta) zoomLockMeta();
        if (key === 'showExportButton' && !CFG.showExportButton) {
            const btn = document.getElementById(AFX.exportBtnId);
            if (btn) btn.remove();
        }
        if (key === 'optimizeDOM' || key === 'flattenCode' || key === 'unwrapEmptySpans' ||
            key === 'contentVisibility' || key === 'idleBeforeOptimize') {
            optimizeSweep();
        }
        scan();
    }

    function setSetting(key, value) {
        if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) return false;
        if (typeof value === 'number' && !isFinite(value)) return false;
        if (CFG[key] === value) return true;
        CFG[key] = value;
        saveSettings();
        log('setting', key, '=', value);
        applySettingLive(key);
        refreshSettingsUI();
        return true;
    }

    function resetSettings() {
        const changed = Object.keys(DEFAULTS).filter((key) => CFG[key] !== DEFAULTS[key]);
        Object.assign(CFG, DEFAULTS);
        saveSettings();
        changed.forEach(applySettingLive);
        refreshSettingsUI();
    }

    function refreshSettingsUI() {
        if (!settingsUI.root) return;
        for (const [key, row] of settingsUI.rows) {
            const item = schemaItem(key);
            const disabled = !!(item.requires && !CFG[item.requires]);
            row.el.dataset.disabled = disabled ? '1' : '0';
            row.input.disabled = disabled;
            if (item.type === 'number') {
                if (document.activeElement !== row.input) row.input.value = String(CFG[key] / (item.scale || 1));
            } else {
                row.input.checked = !!CFG[key];
                row.input.setAttribute('aria-checked', String(!!CFG[key]));
            }
        }
        settingsUI.reloadBar.hidden = !needsReload();
    }

    function make(tag, className, props) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (props) Object.assign(node, props);
        return node;
    }

    function buildSettingsRow(item) {
        const id = 'afx-s-' + item.key;
        const row = make('label', 'afx-s-row');
        row.htmlFor = id;

        const textBox = make('span', 'afx-s-text');
        const label = make('span', 'afx-s-label', { textContent: item.label });
        if (item.reload === 'always') {
            label.appendChild(make('span', 'afx-s-badge', { textContent: 'RELOAD', title: 'Changes apply after a reload' }));
        }
        textBox.appendChild(label);
        if (item.hint) textBox.appendChild(make('span', 'afx-s-hint', { textContent: item.hint }));
        row.appendChild(textBox);

        let input;
        if (item.type === 'number') {
            const wrap = make('span', 'afx-s-num');
            const scale = item.scale || 1;
            input = make('input', '', { type: 'number', id, min: item.min, max: item.max, step: item.step });
            input.addEventListener('change', () => {
                let value = parseFloat(input.value);
                if (!isFinite(value)) value = DEFAULTS[item.key] / scale;
                value = Math.min(item.max, Math.max(item.min, value));
                setSetting(item.key, Math.round(value * scale));
                input.value = String(CFG[item.key] / scale);
            });
            wrap.appendChild(input);
            if (item.unit) wrap.appendChild(make('span', '', { textContent: item.unit }));
            row.appendChild(wrap);
        } else {
            input = make('input', 'afx-s-switch', { type: 'checkbox', id });
            input.setAttribute('role', 'switch');
            input.addEventListener('change', () => setSetting(item.key, input.checked));
            row.appendChild(input);
        }

        settingsUI.rows.set(item.key, { el: row, input });
        return row;
    }

    function buildSettingsMenu() {
        settingsUI.rows.clear();

        const root = make('div');
        root.id = AFX.settingsId;
        root.setAttribute(AFX.ui, '1');
        root.dataset.open = '0';

        const tab = make('button', 'afx-s-tab', { type: 'button', title: 'Focus Mode settings', innerHTML: GEAR_ICON });
        tab.setAttribute('aria-label', 'Focus Mode settings');
        tab.setAttribute('aria-controls', AFX.settingsId + '-drawer');
        tab.setAttribute('aria-expanded', 'false');
        tab.addEventListener('click', () => setSettingsOpen(root.dataset.open !== '1'));

        const drawer = make('div', 'afx-s-drawer');
        drawer.id = AFX.settingsId + '-drawer';
        drawer.setAttribute('role', 'region');
        drawer.setAttribute('aria-label', 'Focus Mode settings');
        drawer.inert = true;

        const head = make('div', 'afx-s-head');
        const titles = make('div');
        titles.appendChild(make('div', 'afx-s-title', { textContent: 'Focus Mode' }));
        titles.appendChild(make('div', 'afx-s-sub', { textContent: 'Settings \u00b7 v' + VERSION }));
        const closeBtn = make('button', 'afx-s-icon-btn', { type: 'button', title: 'Close', innerHTML: CLOSE_ICON });
        closeBtn.setAttribute('aria-label', 'Close settings');
        closeBtn.addEventListener('click', () => setSettingsOpen(false, true));
        head.append(titles, closeBtn);

        const body = make('div', 'afx-s-body');
        for (const section of SETTINGS_SCHEMA) {
            const box = make('section', 'afx-s-section');
            box.appendChild(make('h3', 'afx-s-section-title', { textContent: section.title }));
            section.items.forEach((item) => box.appendChild(buildSettingsRow(item)));
            body.appendChild(box);
        }

        const reloadBar = make('div', 'afx-s-reload', { hidden: true });
        reloadBar.appendChild(make('span', '', { textContent: 'Some changes apply after a reload.' }));
        const reloadBtn = make('button', 'afx-s-btn afx-s-btn-primary', { type: 'button', textContent: 'Reload' });
        reloadBtn.addEventListener('click', () => {
            try { sessionStorage.setItem(SETTINGS_OPEN_KEY, '1'); } catch (_e) {}
            location.reload();
        });
        reloadBar.appendChild(reloadBtn);

        const foot = make('div', 'afx-s-foot');
        foot.appendChild(make('span', '', { textContent: 'Saved automatically' }));
        const resetBtn = make('button', 'afx-s-btn', { type: 'button', textContent: 'Reset to defaults' });
        resetBtn.addEventListener('click', resetSettings);
        foot.appendChild(resetBtn);

        drawer.append(head, body, reloadBar, foot);
        root.append(tab, drawer);

        root.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && root.dataset.open === '1') {
                ev.stopPropagation();
                setSettingsOpen(false, true);
            }
        });

        Object.assign(settingsUI, { root, tab, drawer, closeBtn, reloadBar });
        refreshSettingsUI();
        return root;
    }

    function setSettingsOpen(open, returnFocus) {
        const root = settingsUI.root || (ensureSettingsMenu(), settingsUI.root);
        if (!root) return;
        root.dataset.open = open ? '1' : '0';
        settingsUI.tab.setAttribute('aria-expanded', String(open));
        if (open) {
            refreshSettingsUI();
            settingsUI.drawer.inert = false;
            settingsUI.closeBtn.focus({ preventScroll: true });
        } else {
            if (returnFocus || settingsUI.drawer.contains(document.activeElement)) {
                settingsUI.tab.focus({ preventScroll: true });
            }
            // Off-screen drawer stays out of the tab order and the a11y tree.
            settingsUI.drawer.inert = true;
        }
    }

    function ensureSettingsMenu() {
        if (!document.body) return;
        if (!settingsUI.root) {
            document.body.appendChild(buildSettingsMenu());
            let reopen = false;
            try {
                reopen = sessionStorage.getItem(SETTINGS_OPEN_KEY) === '1';
                sessionStorage.removeItem(SETTINGS_OPEN_KEY);
            } catch (_e) {}
            if (reopen) setSettingsOpen(true);
            return;
        }
        // React may wipe body children on a route change; put it back.
        if (!settingsUI.root.isConnected) document.body.appendChild(settingsUI.root);
    }

    // ════════════════════════════════════════════════════════════════
    // SCAN + BOOT
    // ════════════════════════════════════════════════════════════════

    function scan() {
        ensureFollowBinding();
        if (CFG.pinComposer || CFG.wideComposer) ensureComposerPinned();
        ensureTopBarPinned();
        ensureDiffViewerWide();
        if (CFG.showExportButton) ensureExportButton();
        ensureSettingsMenu();
        scheduleFollow();
    }

    function boot() {
        injectCSS();
        installZoomLock();
        installFollowListeners();

        scan();
        // Arena is a SPA: poll for the log / composer / nav to appear, move,
        // or be re-rendered by React.
        setInterval(scan, 600);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') scan();
        });

        // Installed regardless: optimizeSweep() checks CFG.optimizeDOM, so
        // the settings menu can switch it on later.
        installOptimizer();
        setTimeout(optimizeSweep, 500);
        setTimeout(optimizeSweep, 2000);
        log('booted');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    // Expose a tiny handle for debugging (and for other Arena userscripts).
    window.arenaFocus = {
        get following() { return follow.following; },
        resume: () => resumeFollowing('api'),
        stop: () => stopFollowing('api'),
        export: exportConversation,
        /** Print what the diff/workspace panel detection sees. */
        debugDiff: debugDiffPanel,
        config: CFG,
        /** Open / close the settings drawer. */
        openSettings: () => setSettingsOpen(true),
        closeSettings: () => setSettingsOpen(false),
        /** Change a setting from code: arenaFocus.set('autoScroll', false). */
        set: (key, value) => setSetting(key, value),
        resetSettings: () => resetSettings(),
        _internals: {
            findComposer, findComposerBar, ensureComposerPinned, composer,
            findTopBar, ensureTopBarPinned, widenComposer, topbar,
            findDiffPanel, ensureDiffViewerWide, applyDiffWidth, diffview,
            findWorkspaceToggle, debugDiffPanel,
        },
    };
})();
