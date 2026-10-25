// ==UserScript==
// @name         Arena Roadmap Runner
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Adds a collapsible side panel to Arena for pasting a roadmap.md file. Parses Markdown steps and feeds them sequentially to Arena, waiting for each response to finish before sending the next step.
// @match        https://lmarena.ai/*
// @match        https://arena.ai/*
// @match        https://*.lmarena.ai/*
// @match        https://*.arena.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // 1.  CONFIGURATION
    // ------------------------------------------------------------------
    const PANEL_ID = 'arena-roadmap-panel';

    // Tiered selectors – tried in order until one matches
    const INPUT_SELECTORS = [
        'form textarea',
        'textarea[placeholder*="Ask"]',
        'textarea[placeholder*="anything"]',
        'div[contenteditable="true"]',
        '[role="textbox"]'
    ];

    // The single button slot Arena toggles between send/stop
    const ACTION_BUTTON_SELECTOR = 'button[data-perf-target="send"]';

    let steps = [];
    let currentStepIndex = 0;
    let isRunning = false;
    let stopRequested = false;

    // ------------------------------------------------------------------
    // 2.  ROADMAP PARSER
    // ------------------------------------------------------------------
    /**
     * Parses Markdown into an array of step strings.
     * Recognises:
     *   - Unordered list items: "- step", "* step", "+ step"
     *   - Ordered list items:   "1. step", "2) step"
     *   - Task list items:      "- [ ] step", "- [x] step"
     */
    function parseRoadmap(markdown) {
        const lines = markdown.split(/\r?\n/);
        const result = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            let m = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)/);
            if (m) { result.push(m[1].trim()); continue; }
            m = line.match(/^\d+[.)]\s+(.+)/);
            if (m) { result.push(m[1].trim()); continue; }
        }
        return result;
    }

    // ------------------------------------------------------------------
    // 3.  UTILITIES
    // ------------------------------------------------------------------
    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function findInputElement() {
        for (const sel of INPUT_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    function waitForInputElement(timeout = 20000) {
        return new Promise((resolve, reject) => {
            const existing = findInputElement();
            if (existing) return resolve(existing);

            const observer = new MutationObserver(() => {
                const found = findInputElement();
                if (found) {
                    observer.disconnect();
                    resolve(found);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(
                    `No input element found. Tried selectors: ${INPUT_SELECTORS.join(', ')}. ` +
                    `Make sure you are on the chat page and Arena has fully loaded.`
                ));
            }, timeout);
        });
    }

    function setInputValue(el, value) {
        if (el.tagName === 'TEXTAREA') {
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
            el.focus();
            el.textContent = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    /**
     * Returns true if Arena is currently generating a response.
     * The same button slot toggles its aria-label between "Send" and
     * "Stop generating"; we just read that.
     */
    function isAgentBusy() {
        const btn = document.querySelector(ACTION_BUTTON_SELECTOR);
        if (btn) {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            return label.includes('stop');
        }
        // Fallback if the attribute was ever renamed:
        if (document.querySelector('button[aria-label*="Stop" i]')) return true;
        const ta = document.querySelector('form textarea');
        return !!(ta && ta.disabled);
    }

    /**
     * Clicks the send button. Since we know the exact slot, this is reliable.
     */
    function clickSendButton(inputEl) {
        // Preferred: the tracked slot button
        const slotBtn = document.querySelector(ACTION_BUTTON_SELECTOR);
        if (slotBtn && !slotBtn.disabled) {
            slotBtn.click();
            return true;
        }

        // Fallback 1: form submit button
        const form = inputEl.closest('form');
        if (form) {
            const submit = form.querySelector('button[type="submit"]:not([disabled])');
            if (submit) { submit.click(); return true; }
        }

        // Fallback 2: any enabled "send" button
        const allBtns = Array.from(document.querySelectorAll('button:not([disabled])'));
        const sendBtn = allBtns.find(btn => {
            const label = (btn.getAttribute('aria-label') || btn.title || '').toLowerCase();
            return label.includes('send') || label.includes('submit');
        });
        if (sendBtn) { sendBtn.click(); return true; }

        console.warn('[Roadmap Runner] Could not locate send button.');
        return false;
    }

    // ------------------------------------------------------------------
    // 4.  STEP EXECUTION
    // ------------------------------------------------------------------
    /**
     * Sends one step and waits for the response to finish.
     * Two-phase wait avoids the race where we check "is it busy?"
     * before Arena has swapped the send button into the stop button.
     */
    async function sendStepAndWait(stepText) {
        const inputEl = await waitForInputElement();
        setInputValue(inputEl, stepText);
        await sleep(200); // let React re-enable the button

        if (!clickSendButton(inputEl)) {
            throw new Error('Send button not found');
        }

        // Phase A – wait for busy state to START
        const BUSY_START_TIMEOUT = 15000; // 15s
        const busyStart = Date.now();
        let sawBusy = false;

        while (Date.now() - busyStart < BUSY_START_TIMEOUT) {
            if (isAgentBusy()) { sawBusy = true; break; }
            await sleep(100);
        }

        if (!sawBusy) {
            updateStatus('Warning: never observed busy state for this step.');
            await sleep(2000);
            return;
        }

        // Phase B – wait for busy state to END
        const BUSY_END_TIMEOUT = 300000; // 5 min
        const busyEnd = Date.now();

        while (isAgentBusy()) {
            if (stopRequested) throw new Error('Stopped by user');
            if (Date.now() - busyEnd > BUSY_END_TIMEOUT) {
                throw new Error('Timeout: Arena still generating after 5 minutes');
            }
            await sleep(300);
        }

        await sleep(800); // buffer between steps
    }

    // ------------------------------------------------------------------
    // 5.  SEQUENTIAL CONTROLLER
    // ------------------------------------------------------------------
    async function runSteps() {
        if (isRunning || steps.length === 0) return;
        isRunning = true;
        stopRequested = false;
        currentStepIndex = 0;
        updateStatus(`Running… (0/${steps.length})`);

        while (currentStepIndex < steps.length && !stopRequested) {
            const step = steps[currentStepIndex];
            updateStatus(`Step ${currentStepIndex + 1}/${steps.length}: sending…`);
            try {
                await sendStepAndWait(step);
            } catch (err) {
                console.error('[Roadmap Runner] Step error:', err);
                if (err.message === 'Stopped by user') {
                    updateStatus('Stopped by user.');
                } else {
                    updateStatus(`Error on step ${currentStepIndex + 1}: ${err.message}. Stopping.`);
                }
                isRunning = false;
                return;
            }
            currentStepIndex++;
            updateStatus(`Completed step ${currentStepIndex}/${steps.length}`);
        }

        updateStatus(stopRequested ? 'Stopped by user.' : `All ${steps.length} steps completed.`);
        isRunning = false;
    }

    // ------------------------------------------------------------------
    // 6.  UI
    // ------------------------------------------------------------------
    let panel, bodyContainer, statusEl, stepCountEl, startBtn, stopBtn, loadBtn, textareaEl;
    let isCollapsed = false;

    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        Object.assign(panel.style, {
            position: 'fixed', top: '80px', right: '20px', width: '340px',
            maxHeight: '80vh', background: 'rgba(28,28,30,0.97)', backdropFilter: 'blur(12px)',
            borderRadius: '12px', border: '1px solid rgba(100,100,100,0.35)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)', zIndex: 99999,
            display: 'flex', flexDirection: 'column',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            color: '#e0e0e0', overflow: 'hidden', transition: 'height 0.25s ease'
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', background: 'rgba(40,40,42,0.9)',
            borderBottom: '1px solid rgba(100,100,100,0.25)',
            cursor: 'pointer', userSelect: 'none'
        });
        header.innerHTML = `<span style="font-weight:600;font-size:14px;">📋 Roadmap Runner</span>
                            <span id="rr-toggle-icon" style="font-size:16px;opacity:0.7;">▾</span>`;
        header.onclick = toggleCollapse;

        bodyContainer = document.createElement('div');
        Object.assign(bodyContainer.style, {
            display: 'flex', flexDirection: 'column', gap: '10px',
            padding: '14px', overflowY: 'auto', maxHeight: 'calc(80vh - 44px)'
        });

        textareaEl = document.createElement('textarea');
        textareaEl.placeholder = 'Paste your roadmap.md content here…';
        Object.assign(textareaEl.style, {
            width: '100%', minHeight: '160px', resize: 'vertical', fontSize: '13px',
            padding: '8px', borderRadius: '8px', border: '1px solid #555',
            background: '#3a3a3c', color: '#e0e0e0', boxSizing: 'border-box'
        });
        bodyContainer.appendChild(textareaEl);

        const infoRow = document.createElement('div');
        Object.assign(infoRow.style, {
            display: 'flex', justifyContent: 'space-between',
            fontSize: '12px', color: '#aaa', gap: '8px'
        });
        stepCountEl = document.createElement('span');
        stepCountEl.textContent = '0 steps';
        statusEl = document.createElement('span');
        statusEl.textContent = 'Ready';
        statusEl.style.textAlign = 'right';
        statusEl.style.flex = '1';
        statusEl.style.overflow = 'hidden';
        statusEl.style.textOverflow = 'ellipsis';
        statusEl.style.whiteSpace = 'nowrap';
        infoRow.appendChild(stepCountEl);
        infoRow.appendChild(statusEl);
        bodyContainer.appendChild(infoRow);

        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

        loadBtn = makeButton('Load Steps', '#5a5a5e', () => {
            const parsed = parseRoadmap(textareaEl.value);
            if (parsed.length === 0) {
                updateStatus('No steps found. Use Markdown list items (-, *, 1.).');
                return;
            }
            steps = parsed;
            currentStepIndex = 0;
            stepCountEl.textContent = `${steps.length} steps`;
            updateStatus('Steps loaded. Click Start.');
        });

        startBtn = makeButton('Start', '#2d7a3a', () => {
            if (steps.length === 0) { updateStatus('Load steps first.'); return; }
            if (isRunning) return;
            runSteps();
        });

        stopBtn = makeButton('Stop', '#7a2d2d', () => {
            stopRequested = true;
            updateStatus('Stopping…');
        });

        btnRow.appendChild(loadBtn);
        btnRow.appendChild(startBtn);
        btnRow.appendChild(stopBtn);
        bodyContainer.appendChild(btnRow);

        panel.appendChild(header);
        panel.appendChild(bodyContainer);
        document.body.appendChild(panel);
    }

    function makeButton(label, bg, onClick) {
        const btn = document.createElement('button');
        btn.textContent = label;
        Object.assign(btn.style, {
            padding: '7px 14px', borderRadius: '7px', border: 'none',
            background: bg, color: '#fff', fontSize: '13px',
            fontWeight: '500', cursor: 'pointer', transition: 'opacity 0.15s'
        });
        btn.onmouseover = () => (btn.style.opacity = '0.85');
        btn.onmouseout = () => (btn.style.opacity = '1');
        btn.onclick = onClick;
        return btn;
    }

    function toggleCollapse() {
        isCollapsed = !isCollapsed;
        bodyContainer.style.display = isCollapsed ? 'none' : 'flex';
        const icon = document.getElementById('rr-toggle-icon');
        if (icon) icon.textContent = isCollapsed ? '▸' : '▾';
        panel.style.height = isCollapsed ? 'auto' : '';
    }

    function updateStatus(msg) {
        if (statusEl) statusEl.textContent = msg;
    }

    // ------------------------------------------------------------------
    // 7.  INIT
    // ------------------------------------------------------------------
    function init() {
        buildPanel();
        // Rebuild if SPA navigation nukes the panel
        const observer = new MutationObserver(() => {
            if (!document.getElementById(PANEL_ID)) buildPanel();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();