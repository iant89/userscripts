// ==UserScript==
// @name         Arena Roadmap Runner
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a collapsible side panel to Arena for pasting a roadmap.md file. Parses Markdown steps and feeds them sequentially to Arena, waiting for each response to finish before sending the next step.
// @match        https://lmarena.ai/*
// @match        https://arena.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // 1.  CONFIGURATION & STATE
    // ------------------------------------------------------------------
    const PANEL_ID = 'arena-roadmap-panel';
    const TEXTAREA_SELECTOR = 'textarea[placeholder="Ask anything…"], textarea[placeholder="Ask anything..."]';
    const STREAM_URL_KEYWORDS = ['/nextjs-api/stream/create-evaluation', '/api/stream/post-to-evaluation'];

    let steps = [];               // Parsed roadmap steps
    let currentStepIndex = 0;
    let isRunning = false;
    let stopRequested = false;

    // Promise resolver that the fetch interceptor will call when a stream finishes
    let finishResolver = null;

    // ------------------------------------------------------------------
    // 2.  FETCH INTERCEPTOR – detects when Arena finishes a response
    // ------------------------------------------------------------------
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);

        // Only inspect relevant streaming endpoints
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (!STREAM_URL_KEYWORDS.some(k => url.includes(k))) return response;

        // We need to read the stream without consuming it for the page.
        // Clone the response so the original remains usable by Arena.
        const cloned = response.clone();

        // Fire-and-forget: read the cloned stream and look for "finishReason":"stop"
        (async () => {
            try {
                const reader = cloned.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    if (buffer.includes('"finishReason":"stop"') || buffer.includes('"finish_reason":"stop"')) {
                        if (finishResolver) {
                            const resolve = finishResolver;
                            finishResolver = null;
                            resolve();
                        }
                        break;
                    }
                }
            } catch (e) {
                // Silently ignore stream-reading errors
            }
        })();

        return response;
    };

    // ------------------------------------------------------------------
    // 3.  ROADMAP PARSER
    // ------------------------------------------------------------------
    /**
     * Parses a Markdown roadmap string into an array of step strings.
     * Recognises:
     *   - Unordered list items: "- step", "* step", "+ step"
     *   - Ordered list items:   "1. step", "2) step"
     *   - Task list items:      "- [ ] step", "- [x] step"
     * Lines that are plain headings (#, ##, …) or blank are ignored.
     */
    function parseRoadmap(markdown) {
        const lines = markdown.split(/\r?\n/);
        const result = [];

        for (let raw of lines) {
            const line = raw.trim();
            if (!line) continue;

            // Unordered / task list:  - something  |  * [ ] something
            let m = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)/);
            if (m) {
                result.push(m[1].trim());
                continue;
            }

            // Ordered list:  1. something  |  2) something
            m = line.match(/^\d+[.)]\s+(.+)/);
            if (m) {
                result.push(m[1].trim());
                continue;
            }

            // If the line is not a list item, you could choose to treat it as a step.
            // Here we ignore headings / plain paragraphs to keep only explicit steps.
        }

        return result;
    }

    // ------------------------------------------------------------------
    // 4.  ARENA AUTOMATION HELPERS
    // ------------------------------------------------------------------
    function waitForElement(selector, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const observer = new MutationObserver(() => {
                const found = document.querySelector(selector);
                if (found) {
                    observer.disconnect();
                    resolve(found);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Element ${selector} not found within ${timeout}ms`));
            }, timeout);
        });
    }

    /** Sets the value of a React-controlled textarea and fires the necessary events. */
    function setReactTextareaValue(textarea, value) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
        ).set;
        nativeSetter.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** Finds the send button near the textarea and clicks it. */
    function clickSendButton(textarea) {
        // Common patterns: a submit button inside the same form, or a button with an arrow icon.
        const form = textarea.closest('form');
        if (form) {
            const submitBtn = form.querySelector('button[type="submit"], button:not([disabled])');
            if (submitBtn) {
                submitBtn.click();
                return true;
            }
        }

        // Fallback: look for a button with an aria-label containing "send"
        const allButtons = Array.from(document.querySelectorAll('button'));
        const sendBtn = allButtons.find(btn => {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            return label.includes('send') || label.includes('submit');
        });
        if (sendBtn) {
            sendBtn.click();
            return true;
        }

        console.warn('[Roadmap Runner] Could not locate send button.');
        return false;
    }

    /** Sends a single step to Arena and resolves when the response has finished. */
    async function sendStepAndWait(stepText) {
        const textarea = await waitForElement(TEXTAREA_SELECTOR);
        setReactTextareaValue(textarea, stepText);
        // Give React a tick to update the send button state
        await new Promise(r => setTimeout(r, 150));

        // Create a fresh promise that the fetch interceptor will resolve
        const finishedPromise = new Promise(resolve => {
            finishResolver = resolve;
        });

        const clicked = clickSendButton(textarea);
        if (!clicked) {
            throw new Error('Send button not found');
        }

        // Wait for the stream to signal completion, with a generous timeout (e.g. 5 min)
        await Promise.race([
            finishedPromise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for Arena response')), 300000)
            )
        ]);

        // Small buffer between steps
        await new Promise(r => setTimeout(r, 800));
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
            updateStatus(`Sending step ${currentStepIndex + 1}/${steps.length}…`);
            try {
                await sendStepAndWait(step);
            } catch (err) {
                console.error('[Roadmap Runner] Error on step', currentStepIndex + 1, err);
                updateStatus(`Error on step ${currentStepIndex + 1}: ${err.message}. Stopping.`);
                isRunning = false;
                return;
            }
            currentStepIndex++;
            updateStatus(`Completed step ${currentStepIndex}/${steps.length}`);
        }

        if (stopRequested) {
            updateStatus('Stopped by user.');
        } else {
            updateStatus(`All ${steps.length} steps completed.`);
        }
        isRunning = false;
    }

    // ------------------------------------------------------------------
    // 6.  UI CONSTRUCTION
    // ------------------------------------------------------------------
    let panel, bodyContainer, statusEl, stepCountEl, startBtn, stopBtn, loadBtn, textareaEl;
    let isCollapsed = false;

    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;

        // Main panel
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        Object.assign(panel.style, {
            position: 'fixed',
            top: '80px',
            right: '20px',
            width: '340px',
            maxHeight: '80vh',
            background: 'rgba(28, 28, 30, 0.97)',
            backdropFilter: 'blur(12px)',
            borderRadius: '12px',
            border: '1px solid rgba(100,100,100,0.35)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            color: '#e0e0e0',
            overflow: 'hidden',
            transition: 'height 0.25s ease',
        });

        // Header (clickable to collapse/expand)
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            background: 'rgba(40,40,42,0.9)',
            borderBottom: '1px solid rgba(100,100,100,0.25)',
            cursor: 'pointer',
            userSelect: 'none',
        });
        header.innerHTML = `<span style="font-weight:600;font-size:14px;">📋 Roadmap Runner</span>
                            <span id="rr-toggle-icon" style="font-size:16px;opacity:0.7;">▾</span>`;
        header.onclick = toggleCollapse;

        // Body container (holds everything that collapses)
        bodyContainer = document.createElement('div');
        Object.assign(bodyContainer.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '14px',
            overflowY: 'auto',
            maxHeight: 'calc(80vh - 44px)',
        });

        // Textarea for roadmap input
        textareaEl = document.createElement('textarea');
        textareaEl.placeholder = 'Paste your roadmap.md content here…';
        Object.assign(textareaEl.style, {
            width: '100%',
            minHeight: '160px',
            resize: 'vertical',
            fontSize: '13px',
            padding: '8px',
            borderRadius: '8px',
            border: '1px solid #555',
            background: '#3a3a3c',
            color: '#e0e0e0',
            boxSizing: 'border-box',
        });
        bodyContainer.appendChild(textareaEl);

        // Step count / status
        const infoRow = document.createElement('div');
        Object.assign(infoRow.style, { display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#aaa' });
        stepCountEl = document.createElement('span');
        stepCountEl.textContent = '0 steps';
        statusEl = document.createElement('span');
        statusEl.textContent = 'Ready';
        infoRow.appendChild(stepCountEl);
        infoRow.appendChild(statusEl);
        bodyContainer.appendChild(infoRow);

        // Buttons
        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

        loadBtn = makeButton('Load Steps', '#5a5a5e', async () => {
            const text = textareaEl.value;
            const parsed = parseRoadmap(text);
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
            if (steps.length === 0) {
                updateStatus('Load steps first.');
                return;
            }
            if (isRunning) return;
            runSteps();
        });

        stopBtn = makeButton('Stop', '#7a2d2d', () => {
            stopRequested = true;
            updateStatus('Stopping after current step…');
        });

        btnRow.appendChild(loadBtn);
        btnRow.appendChild(startBtn);
        btnRow.appendChild(stopBtn);
        bodyContainer.appendChild(btnRow);

        // Assemble
        panel.appendChild(header);
        panel.appendChild(bodyContainer);
        document.body.appendChild(panel);
    }

    function makeButton(label, bg, onClick) {
        const btn = document.createElement('button');
        btn.textContent = label;
        Object.assign(btn.style, {
            padding: '7px 14px',
            borderRadius: '7px',
            border: 'none',
            background: bg,
            color: '#fff',
            fontSize: '13px',
            fontWeight: '500',
            cursor: 'pointer',
            transition: 'opacity 0.15s',
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
    // 7.  INITIALISE
    // ------------------------------------------------------------------
    function init() {
        buildPanel();
        // If the panel is somehow removed by SPA navigation, rebuild it
        const observer = new MutationObserver(() => {
            if (!document.getElementById(PANEL_ID)) {
                buildPanel();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();