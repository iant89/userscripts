import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'Arena.ai | Pro.user.js'), 'utf8');

function messageMarkup(index, { codeAt = [], thinkingAt = [], thinkingOpenAt = [] } = {}) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const code = codeAt.includes(index)
        ? `<div class="code-block-header" data-filename="src/example-${index}.ts">src/example-${index}.ts</div><pre class="shiki"><code class="language-typescript">${Array.from({ length: 18 }, (_, n) => `<span class="line"><span class="token">const value${n} = ${n};</span></span>`).join('\n')}</code></pre>`
        : '';
    const thinking = thinkingAt.includes(index)
        ? `<div class="not-prose" data-state="${thinkingOpenAt.includes(index) ? 'open' : 'closed'}"><button type="button" data-state="${thinkingOpenAt.includes(index) ? 'open' : 'closed'}" aria-expanded="${thinkingOpenAt.includes(index)}">Thinking process</button><div class="thinking-content" data-state="${thinkingOpenAt.includes(index) ? 'open' : 'closed'}" ${thinkingOpenAt.includes(index) ? '' : 'hidden'}>Reasoning trace for message ${index}. This is private chain of thought text.</div></div>`
        : '';
    return `<article class="message" data-message-author-role="${role}" data-message-id="m-${index}"><p>Conversation message ${index}: a sufficiently detailed message body used for layout and export testing.</p>${code}${thinking}</article>`;
}

async function fixture(options = {}) {
    const {
        messageCount = 10,
        codeAt = [],
        thinkingAt = [],
        thinkingOpenAt = [],
        storedConfig = {},
        composer = true,
        useGM = true
    } = options;
    const messages = Array.from({ length: messageCount }, (_, index) => messageMarkup(index, { codeAt, thinkingAt, thinkingOpenAt })).join('');
    const composerMarkup = composer ? `
        <form class="chat-composer" id="composer-panel">
            <textarea id="message-input" placeholder="Message Arena"></textarea>
            <div class="composer-toolbar" id="composer-toolbar">
                <button type="button" id="attach-control" aria-label="Attach file">📎</button>
                <button type="button" id="model-control" aria-label="Choose model" data-state="closed">Model</button>
                <button type="button" id="send-control" aria-label="Send message">Send</button>
            </div>
        </form>` : '';
    const html = `<!doctype html><html><head><title>Example conversation | Arena.ai</title><style>.captured-proof{color:rgb(1,2,3)} :root{--test-theme:#123456}</style></head><body>
        <header><button type="button" aria-label="Diff browser">Diff</button></header>
        <main><div class="scroll-host"><div role="log" id="conversation-log"><div id="message-list">${messages}<div class="h-0" aria-hidden="true"></div></div></div></div>${composerMarkup}</main>
    </body></html>`;
    const stored = new Map(Object.entries(storedConfig));
    const downloads = [];
    const dom = new JSDOM(html, {
        url: 'https://arena.ai/chat/test',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.__ARENA_PRO_TEST_MODE__ = true;
            window.console.log = () => {};
            if (useGM) {
                window.GM_getValue = (key, fallback) => stored.has(key) ? stored.get(key) : fallback;
                window.GM_setValue = (key, value) => stored.set(key, value);
            }
            window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
            window.document.execCommand = command => { window.__execCommand = command; return true; };
            window.URL.createObjectURL = () => 'blob:arena-pro-test';
            window.URL.revokeObjectURL = () => {};
            window.HTMLAnchorElement.prototype.click = function () {
                if (this.download) downloads.push(this.download);
            };
            window.Element.prototype.getBoundingClientRect = function () {
                if (this.dataset?.apCompactHidden === '1' || this.style?.display === 'none') {
                    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
                }
                const left = this.style?.position === 'fixed' ? parseFloat(this.style.left) || 24 : 120;
                const top = this.style?.position === 'fixed' ? parseFloat(this.style.top) || 24 : (this.tagName === 'TEXTAREA' ? 700 : 650);
                const width = this.style?.position === 'fixed' ? parseFloat(this.style.width) || 44 : (this.tagName === 'TEXTAREA' ? 360 : 80);
                const height = this.style?.position === 'fixed' ? parseFloat(this.style.height) || 28 : (this.tagName === 'PRE' ? 130 : (this.tagName === 'TEXTAREA' ? 60 : 32));
                return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() {} };
            };
            Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.id === 'conversation-log' ? 500 : 100; } });
            Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
                if (this.id === 'conversation-log') return 1800 - this.querySelectorAll('[data-ap-hidden="1"]').length * 70;
                return 100;
            } });
        }
    });
    dom.window.eval(source);
    const api = dom.window.__ARENA_PRO_TEST_API__;
    assert.ok(api, 'userscript exposes the gated test API');
    api.initialize();
    await new Promise(resolve => setTimeout(resolve, 40));
    return { dom, window: dom.window, document: dom.window.document, api, stored, get downloads() { return downloads.slice(); } };
}

function wait(ms = 30) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withFixture(options, fn) {
    const testPage = await fixture(options);
    try { await fn(testPage); }
    finally { testPage.dom.window.close(); }
}

test('settings storage accepts JSON strings and persists custom Agent Modes as an object', async () => {
    const saved = { virtualize: false, agentModes: [{ id: 'review', name: 'Review', prompt: 'Review carefully.' }], activeAgentModeId: 'review' };
    await withFixture({ storedConfig: { arenaProConfig: JSON.stringify(saved) } }, async ({ api, stored }) => {
        assert.equal(api.getConfig().virtualize, false);
        assert.equal(api.getConfig().activeAgentModeId, 'review');
        const created = api.addAgentMode('Strict TDD', 'Write failing tests first.');
        const persisted = stored.get('arenaProConfig');
        assert.equal(typeof persisted, 'object');
        assert.equal(persisted.agentModes.at(-1).id, created.id);
        assert.equal(persisted.agentModes.at(-1).prompt, 'Write failing tests first.');
    });
});

test('localStorage fallback persists settings when no userscript GM storage exists', async () => {
    await withFixture({ useGM: false }, async ({ api, window }) => {
        api.addAgentMode('Explain', 'Explain the plan before making changes.');
        const stored = JSON.parse(window.localStorage.getItem('arenaProConfig'));
        assert.equal(stored.agentModes[0].name, 'Explain');
        assert.equal(stored.agentModes[0].prompt, 'Explain the plan before making changes.');
    });
});

test('Settings CRUD and composer popup select an Agent Mode, and its prompt is prepended on Enter and Send', async () => {
    await withFixture({ messageCount: 2 }, async ({ api, window, document, stored }) => {
        api.openDrawer('settings');
        const name = document.querySelector('#ap-mode-name');
        const prompt = document.querySelector('#ap-mode-prompt');
        name.value = 'Strict TDD';
        prompt.value = 'Write failing tests first.';
        document.querySelector('#ap-mode-add').click();
        const mode = api.getConfig().agentModes[0];
        assert.equal(mode.name, 'Strict TDD');
        assert.equal(stored.get('arenaProConfig').agentModes.length, 1);

        const modeButton = document.querySelector('#ap-mode-btn');
        modeButton.click();
        const popup = document.querySelector('#ap-mode-popup');
        assert.equal(popup.style.display, 'block');
        const choice = [...popup.querySelectorAll('button')].find(button => button.textContent.includes('Strict TDD'));
        assert.ok(choice);
        choice.click();
        assert.equal(api.getConfig().activeAgentModeId, mode.id);
        assert.match(modeButton.textContent, /Strict TDD/);

        const composer = document.querySelector('#message-input');
        const send = document.querySelector('#send-control');
        const submitted = [];
        send.addEventListener('click', () => submitted.push(composer.value));

        composer.value = 'Add a login endpoint';
        composer.dispatchEvent(new window.Event('input', { bubbles: true }));
        composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await wait(70);
        assert.equal(submitted[0], 'Write failing tests first.\n\nAdd a login endpoint');

        await wait(900);
        composer.value = 'Review the auth middleware';
        composer.dispatchEvent(new window.Event('input', { bubbles: true }));
        send.click();
        await wait(70);
        assert.equal(submitted[1], 'Write failing tests first.\n\nReview the auth middleware');

        await wait(900);
        composer.value = 'Write failing tests first.\n\nAlready prefixed';
        send.click();
        assert.equal(submitted[2], 'Write failing tests first.\n\nAlready prefixed', 'an existing prefix is not duplicated');

        await wait(900);
        composer.value = '';
        send.disabled = true;
        composer.addEventListener('input', () => { send.disabled = !composer.value; });
        api.submitThroughComposer('Create a pull request now.');
        await wait(50);
        assert.equal(submitted[3], 'Create a pull request now.', 'workflow shortcuts bypass the active mode prefix and enable Send from an empty draft');

        await wait(900);
        api.selectAgentMode('');
        composer.value = 'A normal unprefixed message';
        send.click();
        assert.equal(submitted[4], 'A normal unprefixed message', 'Off sends ordinary messages unchanged');

        api.openDrawer('settings');
        let modeCard = [...document.querySelectorAll('.ap-card')].find(card => card.textContent.includes('Strict TDD'));
        modeCard.querySelector('button').click();
        modeCard = [...document.querySelectorAll('.ap-card')].find(card => card.querySelector('textarea'));
        modeCard.querySelector('input').value = 'Strict TDD Edited';
        modeCard.querySelector('textarea').value = 'Write tests first, then implement.';
        modeCard.querySelector('button.ap-btn-primary').click();
        assert.equal(api.getConfig().agentModes[0].name, 'Strict TDD Edited');
        assert.equal(api.getConfig().agentModes[0].prompt, 'Write tests first, then implement.');
        modeCard = [...document.querySelectorAll('.ap-card')].find(card => card.textContent.includes('Strict TDD Edited'));
        modeCard.querySelectorAll('button')[1].click();
        assert.equal(api.getConfig().agentModes.length, 0);
        assert.equal(api.getConfig().activeAgentModeId, '');
    });
});

test('drawer closes outside or on Escape and tracks Arena dark/light theme changes', async () => {
    await withFixture({ messageCount: 2 }, async ({ api, document, window }) => {
        api.openDrawer('settings');
        const drawer = document.querySelector('#ap-drawer');
        assert.ok(drawer.classList.contains('ap-open'));
        document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
        assert.ok(!drawer.classList.contains('ap-open'));
        api.openDrawer('statistics');
        const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        window.dispatchEvent(escape);
        assert.ok(escape.defaultPrevented);
        assert.ok(!drawer.classList.contains('ap-open'));

        document.documentElement.classList.add('dark');
        await wait(10);
        assert.equal(document.documentElement.dataset.apTheme, 'dark');
        document.documentElement.classList.remove('dark');
        await wait(10);
        assert.equal(document.documentElement.dataset.apTheme, 'light');
        document.documentElement.style.setProperty('--background', '#111111');
        await wait(10);
        assert.equal(document.documentElement.dataset.apTheme, 'dark', 'CSS background variables are used to detect the site theme');
        document.documentElement.style.setProperty('--background', '#ffffff');
        await wait(10);
        assert.equal(document.documentElement.dataset.apTheme, 'light');
    });
});

test('virtualization flattens hidden Shiki spans and progressively reveals older messages', async () => {
    await withFixture({ messageCount: 25, codeAt: [8, 16] }, async ({ api, document, window }) => {
        api.setConfig({ keepMessages: 8, virtualize: true, flattenCode: true });
        const log = document.querySelector('#conversation-log');
        const messages = api.getMessages(log);
        const initial = api.virtualize();
        assert.equal(initial.total, 25);
        assert.equal(initial.hidden, 17);
        assert.equal(messages.filter(message => message.dataset.apHidden === '1').length, 17);
        const oldCode = messages[8].querySelector('pre code');
        assert.ok(oldCode);
        assert.equal(oldCode.querySelectorAll('span').length, 0, 'hidden syntax spans are flattened');

        log.scrollTop = 0;
        const before = log.scrollTop;
        log.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true }));
        assert.equal(api.virtualize().hidden, 9, 'scrolling upward at the top reveals the next older batch');
        assert.ok(messages[16].querySelector('pre code').querySelectorAll('span').length > 0, 'revealed code restores its highlighted spans');
        await wait(35);
        assert.ok(log.scrollTop > before, 'scroll anchor is compensated as the older batch is revealed');
        api.revealOlder();
        assert.equal(api.virtualize().hidden, 1);
        assert.ok(messages[8].querySelector('pre code').querySelectorAll('span').length > 0, 'newly revealed code restores its original Shiki HTML');
        assert.equal(document.documentElement.dataset.apPerf, '1', 'performance CSS activates on long chats');
    });
});

test('thinking settings collapse older traces, expand all, and hide reasoning wrappers', async () => {
    await withFixture({ messageCount: 3, thinkingAt: [0, 2], thinkingOpenAt: [0, 2] }, async ({ api, document }) => {
        const oldButton = document.querySelector('[data-message-id="m-0"] button[data-state]');
        const latestButton = document.querySelector('[data-message-id="m-2"] button[data-state]');
        oldButton.addEventListener('click', () => {
            const open = oldButton.dataset.state !== 'open';
            oldButton.dataset.state = open ? 'open' : 'closed';
            oldButton.setAttribute('aria-expanded', String(open));
        });
        latestButton.addEventListener('click', () => {
            const open = latestButton.dataset.state !== 'open';
            latestButton.dataset.state = open ? 'open' : 'closed';
            latestButton.setAttribute('aria-expanded', String(open));
        });

        api.setConfig({ thinkingMode: 'collapse' });
        api.applyThinkingMode();
        assert.equal(oldButton.dataset.state, 'closed');
        assert.equal(latestButton.dataset.state, 'open', 'the newest trace remains available in collapse mode');

        api.setConfig({ thinkingMode: 'expand' });
        api.applyThinkingMode();
        assert.equal(oldButton.dataset.state, 'open');
        api.setConfig({ thinkingMode: 'hide' });
        api.applyThinkingMode();
        assert.equal(document.querySelector('[data-message-id="m-0"] .not-prose').dataset.apThinking, '1');
        assert.equal(document.querySelector('[data-message-id="m-2"] .not-prose').dataset.apThinking, '1');
    });
});

test('Markdown, code filenames, statistics, and diagnostics include the complete conversation', async () => {
    await withFixture({ messageCount: 12, codeAt: [0, 5, 9] }, async page => {
        const { api, document } = page;
        const log = document.querySelector('#conversation-log');
        api.virtualize();
        const liveDownloadButtons = document.querySelectorAll('#ap-code-layer button[aria-label="Download code block"]');
        assert.equal(liveDownloadButtons.length, 3, 'every code block receives a download button');
        liveDownloadButtons[0].click();
        assert.equal(page.downloads[0], 'example-0.ts');
        const markdown = api.exportChatMarkdown();
        assert.match(markdown, /## User/);
        assert.match(markdown, /## Assistant/);
        assert.match(markdown, /```typescript/);
        assert.match(markdown, /Conversation message 11/);
        assert.equal((markdown.match(/## (?:User|Assistant)/g) || []).length, 12, 'all virtualized messages export');

        const messages = api.getMessages(log);
        const firstPre = messages[0].querySelector('pre');
        assert.equal(api.detectFilename(firstPre, 1), 'example-0.ts');
        firstPre.previousElementSibling.remove();
        firstPre.className = 'language-python';
        firstPre.querySelector('code').className = 'language-python';
        assert.equal(api.detectFilename(firstPre, 22), 'snippet-22.py');
        firstPre.className = 'language-rust';
        firstPre.querySelector('code').className = 'language-rust';
        assert.equal(api.detectFilename(firstPre, 23), 'snippet-23.rs');
        firstPre.className = 'language-bash';
        firstPre.querySelector('code').className = 'language-bash';
        assert.equal(api.detectFilename(firstPre, 24), 'snippet-24.sh');
        api.openDrawer('statistics');
        assert.ok(document.querySelector('.ap-progress[role="progressbar"]'));
        assert.match(document.querySelector('.ap-content').textContent, /Estimated tokens/);
        const diagnostic = await api.runDiagnostics();
        assert.equal(diagnostic.conversation.messageCount, 12);
    });
});

test('Clear chat removes rendered messages in-place, preserves the URL, and guards React container calls', async () => {
    await withFixture({ messageCount: 4 }, async ({ api, document, window }) => {
        const url = window.location.href;
        const log = document.querySelector('#conversation-log');
        const first = api.getMessages(log)[0];
        const list = first.parentElement;
        assert.equal(await api.clearChat(), true);
        assert.equal(window.location.href, url);
        assert.equal(api.getMessages(log).length, 0);
        const sentinel = list.querySelector('.h-0');
        assert.ok(sentinel, 'structural insertion sentinel is preserved');
        assert.doesNotThrow(() => list.removeChild(first), 'React removing an already detached node is safe');
        const next = document.createElement('article');
        assert.doesNotThrow(() => list.insertBefore(next, first), 'React inserting before an already detached reference is safe');
        assert.equal(next.parentElement, list);
        const sentinelInsertion = document.createElement('article');
        assert.doesNotThrow(() => list.insertBefore(sentinelInsertion, sentinel));
        assert.equal(sentinelInsertion.nextElementSibling, sentinel);
    });
});

test('standalone HTML restores virtualized Shiki, captures CSS, and includes interactive controls', async () => {
    await withFixture({ messageCount: 10, codeAt: [0], thinkingAt: [1], thinkingOpenAt: [] }, async ({ api, window, document }) => {
        api.virtualize();
        const exported = await api.exportConversationHTML({ download: false });
        assert.match(exported, /\.captured-proof/);
        assert.match(exported, /data-ap-export-thinking-toggle/);
        assert.match(exported, /snippet-/);
        const standalone = new JSDOM(exported, {
            url: 'file:///arena-conversation.html',
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            beforeParse(exportWindow) {
                exportWindow.document.execCommand = command => { exportWindow.__execCommand = command; return true; };
                exportWindow.URL.createObjectURL = () => 'blob:exported-code';
                exportWindow.URL.revokeObjectURL = () => {};
                exportWindow.HTMLAnchorElement.prototype.click = function () { if (this.download) exportWindow.__downloadClicked = true; };
            }
        });
        try {
            const exportedDoc = standalone.window.document;
            const code = exportedDoc.querySelector('pre.shiki code');
            assert.ok(code.querySelectorAll('span').length >= 18, 'flattened token spans are restored in the export');
            assert.equal(exportedDoc.querySelectorAll('[data-message-id]').length, 10, 'all messages, including virtualized ones, are present');
            const thinkingButton = exportedDoc.querySelector('[data-ap-export-thinking-toggle]');
            const thinkingPanel = exportedDoc.getElementById(thinkingButton.getAttribute('data-ap-export-panel'));
            assert.ok(thinkingButton && thinkingPanel);
            assert.equal(thinkingPanel.hidden, false, 'thinking content is initially expanded');
            thinkingButton.click();
            assert.equal(thinkingPanel.hidden, true, 'thinking trace can be collapsed');
            thinkingButton.click();
            assert.equal(thinkingPanel.hidden, false, 'thinking trace can be expanded again');
            exportedDoc.querySelector('[data-ap-export-copy]').click();
            assert.equal(standalone.window.__execCommand, 'copy');
            exportedDoc.querySelector('[data-ap-export-download]').click();
            assert.equal(standalone.window.__downloadClicked, true);
            exportedDoc.querySelector('#ap-export-toolbar button').click();
            assert.equal(exportedDoc.documentElement.getAttribute('data-theme'), 'dark');
        } finally { standalone.window.close(); }
    });
});

test('Composer compact preserves the text field and Send/Stop, exposes controls through …, and Hide restores', async () => {
    await withFixture({ messageCount: 2 }, async ({ api, document }) => {
        const composer = document.querySelector('#message-input');
        const panel = document.querySelector('#composer-panel');
        const model = document.querySelector('#model-control');
        let rectDuringClick = null;
        model.addEventListener('click', () => {
            model.dataset.state = 'open';
            rectDuringClick = model.getBoundingClientRect();
        });

        api.setConfig({ composerCompact: true });
        api.applyCompactMode();
        const more = document.querySelector('#ap-composer-more');
        assert.ok(more);
        assert.notEqual(composer.style.display, 'none');
        assert.notEqual(document.querySelector('#send-control').dataset.apCompactHidden, '1');
        assert.equal(model.dataset.apCompactHidden, '1');
        assert.equal(document.querySelector('#attach-control').dataset.apCompactHidden, '1');

        more.click();
        const menu = document.querySelector('#ap-composer-menu');
        assert.equal(menu.style.display, 'block');
        assert.match(menu.textContent, /Agent mode/);
        const modelItem = [...menu.querySelectorAll('button')].find(button => button.textContent.includes('Choose model'));
        assert.ok(modelItem);
        modelItem.click();
        assert.ok(rectDuringClick?.width > 0 && rectDuringClick?.height > 0, 'hidden native trigger has a real popup anchor rectangle');

        document.querySelector('#send-control').remove();
        const stop = document.createElement('button');
        stop.type = 'button'; stop.setAttribute('aria-label', 'Stop generating'); stop.id = 'stop-control'; stop.textContent = 'Stop';
        document.querySelector('#composer-toolbar').appendChild(stop);
        api.ensureAgentControls();
        assert.notEqual(stop.dataset.apCompactHidden, '1', 'Send-to-Stop swap stays visible');

        api.setConfig({ composerCompact: false });
        api.applyCompactMode();
        assert.notEqual(model.dataset.apCompactHidden, '1');
        assert.notEqual(document.querySelector('#attach-control').dataset.apCompactHidden, '1');

        api.setConfig({ hideComposer: true });
        await wait(100);
        assert.equal(panel.style.display, 'none');
        api.setConfig({ hideComposer: false });
        await wait(100);
        assert.notEqual(panel.style.display, 'none');
    });
});
