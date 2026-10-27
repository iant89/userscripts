const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const script = fs.readFileSync(path.join(__dirname, '..', 'Web Inspector.user.js'), 'utf8');
const storageKey = 'webInspector.preferences.v1';
let browser;

before(async () => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { await browser?.close(); });

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><style>body{margin:0;min-height:1200px}nav{position:absolute;top:10px;right:10px}nav a{margin:8px}</style>
</head><body><nav><a id="same" href="/another">Same site</a>
<a id="other" href="https://other.test/second">Other site</a><a id="origin" href="https://origin.test/first">First site</a></nav>
<main><h1>Page content</h1><button id="page-button">Page button</button></main></body></html>`;

// Model asynchronous userscript-manager storage in a Chromium isolated world.
// The inspector must bridge back to the real page world without exposing GM.
async function installManager(page, options) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.addBinding', { name: '__inspectorTestStorage', executionContextName: 'InspectorManagerTest' });
  const store = options.store || new Map();
  const writes = [], revisionIndex = new Map();
  let writeCount = 0;
  cdp.on('Runtime.bindingCalled', async event => {
    if (event.name !== '__inspectorTestStorage') return;
    const request = JSON.parse(event.payload);
    const fail = request.op === 'get' ? options.failGet : request.op === 'set' ? options.failSet : false;
    let delay = request.op === 'get' ? (options.readDelay || 0) : 0;
    if (request.op === 'set') {
      if (!revisionIndex.has(request.value.updatedAt)) revisionIndex.set(request.value.updatedAt, writeCount++);
      delay = options.writeDelays?.[revisionIndex.get(request.value.updatedAt)] || 0;
    }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    let value = null;
    if (!fail && request.op === 'get') value = store.has(request.key) ? store.get(request.key) : request.fallback;
    if (!fail && request.op === 'list') value = [...store.keys()];
    if (!fail && request.op === 'delete') store.delete(request.key);
    if (!fail && request.op === 'set') { value = request.value; store.set(request.key, value); writes.push(value); }
    try {
      const expression = `globalThis.__inspectorTestResolve(${JSON.stringify(request.id)},${JSON.stringify(value)},${JSON.stringify(!!fail)})`;
      await cdp.send('Runtime.evaluate', { contextId: event.executionContextId, expression, returnByValue: true });
    } catch (_) { /* A navigation may destroy the originating isolated world. */ }
  });
  const mock = `(() => {
    let sequence = 0; const pending = new Map();
    globalThis.__inspectorTestResolve = (id, value, failed) => {
      const entry = pending.get(id); if (!entry) return; pending.delete(id);
      failed ? entry.reject(new Error('storage unavailable')) : entry.resolve(value);
    };
    const call = (op, key, value, fallback) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      __inspectorTestStorage(JSON.stringify({ op, key, value, fallback, id }));
    });
    ${options.legacy ? `
    globalThis.GM_getValue = (key, fallback) => call('get', key, null, fallback);
    globalThis.GM_setValue = (key, value) => call('set', key, value, null);
    ${options.noJournal ? '' : `
    globalThis.GM_listValues = () => call('list', null, null, null);
    globalThis.GM_deleteValue = key => call('delete', key, null, null);
    `}
    ` : `
    globalThis.GM = {
      getValue: (key, fallback) => call('get', key, null, fallback),
      setValue: (key, value) => call('set', key, value, null),
      ${options.noJournal ? '' : `listValues: () => call('list', null, null, null),
      deleteValue: key => call('delete', key, null, null),`}
    };
    `}
  })();`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `${mock}\n${script}`, worldName: 'InspectorManagerTest' });
  return { store, writes, cdp };
}

async function fixture(t, options = {}) {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 },
    ...(options.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}),
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    headers: {
      ...(options.csp ? { 'Content-Security-Policy': "script-src 'none'; style-src 'unsafe-inline'" } : {}),
      ...(options.noReferrer ? { 'Referrer-Policy': 'no-referrer' } : {}),
    },
    body: html,
  }));
  if (options.blockLocal) {
    await context.addInitScript(() => Object.defineProperty(window, 'localStorage', {
      configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); },
    }));
  }
  if (options.localSeed) {
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: options.localSeed });
  }
  if (options.trackFirst) {
    await context.addInitScript(() => {
      window.firstInspectorStates = [];
      const observer = new MutationObserver(() => {
        const win = document.querySelector('#web-inspector-host-v1')?.shadowRoot?.querySelector('.wi');
        if (win) { window.firstInspectorStates.push(win.classList.contains('closed')); observer.disconnect(); }
      });
      observer.observe(document, { childList: true, subtree: true });
    });
  }
  let manager;
  if (options.manager) manager = await installManager(page, options);
  else await context.addInitScript({ content: script });
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.goto('https://origin.test/first');
  await page.locator('#web-inspector-host-v1').waitFor({ state: 'attached' });
  return { page, context, inspector: page.locator('#web-inspector-host-v1'), manager };
}

async function assertVisibility(page, closed) {
  const win = page.locator('#web-inspector-host-v1 .wi');
  const reopen = page.locator('[data-web-inspector-reopen]');
  await page.waitForFunction(expected => {
    const host = document.querySelector('#web-inspector-host-v1');
    const win = host?.shadowRoot?.querySelector('.wi');
    return !!win && win.classList.contains('closed') === expected;
  }, closed);
  assert.equal(await win.isVisible(), !closed);
  assert.equal(await reopen.isVisible(), closed);
}

async function savedState(page) {
  return page.evaluate(() => {
    const { x, y, width, height, dock, collapsed, closed, activeTab, lastResourceType } = window.__webInspectorInstanceV1.state;
    return { x, y, width, height, dock, collapsed, closed, activeTab, lastResourceType };
  });
}

async function waitForStored(manager, predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate(manager.store.get(storageKey))) {
    if (Date.now() > deadline) throw new Error('Manager storage was not updated');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('closed and reopened state survives same-site links, reload, back and forward', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('[data-action="close"]').click();
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).closed, storageKey), true, 'hiding writes immediately');
  await Promise.all([page.waitForURL('**/another'), page.locator('#same').click()]);
  await assertVisibility(page, true);
  await page.reload();
  await assertVisibility(page, true);
  await page.goBack();
  await assertVisibility(page, true);
  await page.goForward();
  await assertVisibility(page, true);

  // Reopening and navigating in the very same task must not race a debounce.
  await page.evaluate(() => {
    document.querySelector('[data-web-inspector-reopen]').click();
    document.querySelector('#origin').click();
  });
  await page.waitForURL('**/first');
  await assertVisibility(page, false);
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).closed, storageKey), false);
});

test('position, size, tab, resource type and collapsed state survive navigation while hidden', async t => {
  const { page, inspector } = await fixture(t);
  const title = await inspector.locator('.title').boundingBox();
  await page.mouse.move(title.x + 150, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(title.x + 260, title.y + 115, { steps: 5 });
  await page.mouse.up();
  const edge = await inspector.locator('.resize.se').boundingBox();
  await page.mouse.move(edge.x + 5, edge.y + 5);
  await page.mouse.down();
  await page.mouse.move(edge.x - 50, edge.y - 65, { steps: 4 });
  await page.mouse.up();
  await inspector.locator('[data-tab="resources"]').click();
  await inspector.locator('[data-resource="session"]').click();
  await inspector.locator('[data-action="collapse"]').click();
  await inspector.locator('[data-action="close"]').click();
  const expected = await savedState(page);
  assert.equal(expected.closed, true);
  assert.equal(expected.collapsed, true);
  assert.equal(expected.activeTab, 'resources');
  assert.equal(expected.lastResourceType, 'session');
  assert.notEqual(expected.y, 70, 'the title was deliberately moved');
  await Promise.all([page.waitForURL('**/another'), page.locator('#same').click()]);
  await assertVisibility(page, true);
  assert.deepEqual(await savedState(page), expected);
  await page.locator('[data-web-inspector-reopen]').click();
  assert.equal(await inspector.locator('[data-action="collapse"]').getAttribute('aria-label'), 'Expand inspector');
  await inspector.locator('[data-action="collapse"]').click();
  assert.equal(await inspector.locator('[data-tab="resources"]').getAttribute('aria-selected'), 'true');
  assert.equal(await inspector.locator('[data-resource="session"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual({ ...(await savedState(page)), collapsed: true, closed: true }, expected);
});

test('shortcut and API visibility transitions persist before immediate navigation', async t => {
  const { page } = await fixture(t);
  await page.keyboard.press('Control+Shift+i');
  await assertVisibility(page, true);
  await page.evaluate(() => document.querySelector('#same').click());
  await page.waitForURL('**/another');
  await assertVisibility(page, true);
  await page.evaluate(() => {
    window.__webInspectorInstanceV1.open();
    document.querySelector('#origin').click();
  });
  await page.waitForURL('**/first');
  await assertVisibility(page, false);
  await page.keyboard.press('Control+Shift+i');
  await page.keyboard.press('Control+Shift+i');
  await page.reload();
  await assertVisibility(page, false);
});

test('manager preferences follow links to another origin without losing page-context console access', async t => {
  const { page, inspector, manager } = await fixture(t, { manager: true });
  assert.equal(await page.evaluate(() => typeof window.GM), 'undefined', 'privileged manager APIs stay out of the page');
  await page.evaluate(() => { window.pageOnlyValue = 41; console.info('page-world capture'); });
  await inspector.locator('[data-tab="console"]').click();
  assert.match(await inspector.locator('#consolelog').innerText(), /page-world capture/);
  await inspector.locator('#command').fill('window.pageOnlyValue + 1');
  await inspector.locator('#command').press('Enter');
  await page.waitForFunction(() => document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('#consolelog').textContent.includes('42'));
  const expected = await savedState(page);
  await page.evaluate(() => {
    document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('[data-action="close"]').click();
    document.querySelector('#other').click();
  });
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
  const restored = await savedState(page);
  assert.deepEqual(restored, { ...expected, closed: true });
  await waitForStored(manager, value => value?.closed === true);
  await page.locator('[data-web-inspector-reopen]').click();
  await waitForStored(manager, value => value?.closed === false);
  await page.locator('#origin').click();
  await page.waitForURL('https://origin.test/first');
  await assertVisibility(page, false);
});

test('a delayed manager write is reconciled before the first cross-site render', async t => {
  const { page } = await fixture(t, { manager: true, writeDelays: [160], trackFirst: true });
  await page.evaluate(() => {
    document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('[data-action="close"]').click();
    document.querySelector('#other').click();
  });
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
  assert.deepEqual(await page.evaluate(() => window.firstInspectorStates), [true], 'the new page must not first paint an open inspector');
});

test('out-of-order manager writes are repaired to the newest user choice', async t => {
  const { page, manager } = await fixture(t, { manager: true, writeDelays: [150, 10] });
  await page.evaluate(() => {
    document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('[data-action="close"]').click();
    document.querySelector('[data-web-inspector-reopen]').click();
  });
  await waitForStored(manager, value => value?.closed === false);
  await page.waitForTimeout(260);
  assert.equal(manager.store.get(storageKey).closed, false);
  assert.ok(manager.writes.length >= 3, 'the stale completion is repaired');
  await page.locator('#other').click();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, false);
});

test('a restored back-forward-cache page picks up a newer shared preference', async t => {
  const { page, manager } = await fixture(t, { manager: true });
  await page.locator('#web-inspector-host-v1 [data-action="collapse"]').click();
  await waitForStored(manager, value => value?.collapsed === true);
  const original = manager.store.get(storageKey);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.locator('#web-inspector-host-v1 .wi').isVisible(), false, 'the old state is not shown while history is restored');
  manager.store.set(storageKey, { ...original, closed: true, updatedAt: original.updatedAt + 1 });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await assertVisibility(page, true);
  assert.equal((await savedState(page)).collapsed, true);
});

test('strict CSP falls back to a usable inspector and labels isolated console execution', async t => {
  const { page, inspector } = await fixture(t, { manager: true, csp: true });
  await inspector.locator('[data-tab="console"]').click();
  assert.match(await inspector.locator('#toolbar').innerText(), /userscript context/);
  await inspector.locator('#command').fill('2 + 2');
  await inspector.locator('#command').press('Enter');
  await page.waitForFunction(() => document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('#consolelog').textContent.includes('4'));
  await inspector.locator('[data-action="close"]').click();
  await page.locator('#same').click();
  await page.waitForURL('**/another');
  await assertVisibility(page, true);
});

test('storage failures do not break controls; available per-site storage is still used', async t => {
  const { page, inspector } = await fixture(t, { manager: true, failGet: true, failSet: true });
  await inspector.locator('[data-action="close"]').click();
  await page.locator('#same').click();
  await page.waitForURL('**/another');
  await assertVisibility(page, true);
  await page.locator('[data-web-inspector-reopen]').click();
  await assertVisibility(page, false);
});

test('the inspector remains usable when both manager and page storage are unavailable', async t => {
  const { page, inspector } = await fixture(t, { manager: true, failGet: true, failSet: true, blockLocal: true });
  await inspector.locator('[data-action="close"]').click();
  await assertVisibility(page, true);
  await page.locator('[data-web-inspector-reopen]').click();
  await assertVisibility(page, false);
  await page.reload();
  await assertVisibility(page, false);
});

test('intentional edge docking is restored after a link navigation', async t => {
  const { page, inspector } = await fixture(t);
  const title = await inspector.locator('.title').boundingBox();
  await page.mouse.move(title.x + 130, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(3, 200, { steps: 5 });
  await page.waitForTimeout(340);
  await page.mouse.up();
  assert.equal((await savedState(page)).dock, 'left');
  await inspector.locator('[data-action="close"]').click();
  const expected = await savedState(page);
  await page.locator('#same').click();
  await page.waitForURL('**/another');
  await assertVisibility(page, true);
  assert.deepEqual(await savedState(page), expected);
  await page.locator('[data-web-inspector-reopen]').click();
  assert.equal(await inspector.locator('.wi').evaluate(win => win.classList.contains('dock-left')), true);
});

test('older per-site preferences migrate to manager storage without losing their geometry', async t => {
  const legacy = {
    x: 280, y: 130, width: 420, height: 370, dock: 'float', collapsed: true,
    activeTab: 'source', lastResourceType: 'cookie', theme: 'dark', opacity: true,
  };
  const { page, manager } = await fixture(t, { manager: true, localSeed: legacy });
  const initial = await savedState(page);
  const { theme, opacity, ...expected } = legacy;
  assert.deepEqual(initial, { ...expected, closed: false });
  await waitForStored(manager, value => value?.x === legacy.x && value?.collapsed === true);
  await page.locator('#web-inspector-host-v1 [data-action="close"]').click();
  await page.locator('#other').click();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
  assert.deepEqual(await savedState(page), { ...initial, closed: true });
});

test('legacy manager storage APIs share preferences across origins', async t => {
  const { page, manager } = await fixture(t, { manager: true, legacy: true });
  await page.locator('#web-inspector-host-v1 [data-action="close"]').click();
  await waitForStored(manager, value => value?.closed === true);
  await page.locator('#other').click();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
});

test('manager storage works across origins even when page localStorage is blocked', async t => {
  const { page, manager } = await fixture(t, { manager: true, blockLocal: true });
  await page.locator('#web-inspector-host-v1 [data-action="close"]').click();
  await waitForStored(manager, value => value?.closed === true);
  await page.locator('#other').click();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
});

test('a real back navigation adopts a later close from another origin', async t => {
  const { page, manager } = await fixture(t, { manager: true });
  await page.locator('#other').click();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, false);
  await page.locator('#web-inspector-host-v1 [data-action="close"]').click();
  await waitForStored(manager, value => value?.closed === true);
  await page.goBack();
  await page.waitForURL('https://origin.test/first');
  await assertVisibility(page, true);
  await page.goForward();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
});

test('a slow manager read does not prevent startup and eventually restores its saved state', async t => {
  const record = {
    x: 18, y: 70, width: 720, height: 520, dock: 'float', collapsed: false, closed: true,
    activeTab: 'elements', lastResourceType: 'local', theme: 'dark', opacity: true, updatedAt: Date.now(),
  };
  const store = new Map([[storageKey, record]]);
  const { page } = await fixture(t, { manager: true, store, readDelay: 1000 });
  await assertVisibility(page, true);
});

test('the latest of rapid close and reopen actions survives out-of-order writes during navigation', async t => {
  const { page } = await fixture(t, { manager: true, writeDelays: [150, 10] });
  await page.evaluate(() => {
    document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('[data-action="close"]').click();
    document.querySelector('[data-web-inspector-reopen]').click();
    document.querySelector('#other').click();
  });
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, false);
});

test('managers with only get/set APIs still share preferences across sites', async t => {
  const { page, manager } = await fixture(t, { manager: true, noJournal: true });
  await page.locator('#web-inspector-host-v1 [data-action="close"]').click();
  await waitForStored(manager, value => value?.closed === true);
  await page.locator('#other').click();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
});

test('older manager journal entries are pruned only after a newer record is durable', async t => {
  const { page, manager } = await fixture(t, { manager: true });
  await page.evaluate(() => {
    const root = document.querySelector('#web-inspector-host-v1').shadowRoot;
    root.querySelector('[data-action="close"]').click();
    document.querySelector('[data-web-inspector-reopen]').click();
    root.querySelector('[data-action="close"]').click();
  });
  await waitForStored(manager, value => value?.closed === true);
  const deadline = Date.now() + 3000;
  let journal;
  do {
    journal = [...manager.store.entries()].filter(([key]) => key.startsWith(`${storageKey}.journal.`));
    if (journal.length === 1 && journal[0][1].closed) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  assert.equal(journal.length, 1);
  assert.equal(journal[0][1].closed, true);
  await page.locator('#other').click();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
});

test('on a touch viewport the closed state follows a link and the reopen circle remains reachable', async t => {
  const { page, inspector } = await fixture(t, { manager: true, mobile: true });
  await inspector.locator('[data-action="close"]').tap();
  await page.locator('#other').tap();
  await page.waitForURL('https://other.test/second');
  await assertVisibility(page, true);
  const box = await page.locator('[data-web-inspector-reopen]').boundingBox();
  const viewport = await page.evaluate(() => ({ width: visualViewport.width, height: visualViewport.height }));
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
  await page.locator('[data-web-inspector-reopen]').tap();
  await assertVisibility(page, false);
  await page.reload();
  await assertVisibility(page, false);
});

test('a slow cross-site write is reconciled even when the referrer is withheld', async t => {
  const { page } = await fixture(t, { manager: true, noReferrer: true, writeDelays: [700] });
  await page.evaluate(() => {
    document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('[data-action="close"]').click();
    document.querySelector('#other').click();
  });
  await page.waitForURL('https://other.test/second');
  assert.equal(await page.evaluate(() => document.referrer), '');
  await page.waitForFunction(() => document.querySelector('#web-inspector-host-v1')?.shadowRoot?.querySelector('.wi')?.classList.contains('closed'), null, { timeout: 3000 });
  await assertVisibility(page, true);
});

test('same-site history restores a newer closed state without manager storage', async t => {
  const { page } = await fixture(t);
  await page.locator('#same').click();
  await page.waitForURL('**/another');
  await page.locator('#web-inspector-host-v1 [data-action="close"]').click();
  await page.goBack();
  await page.waitForURL('**/first');
  await assertVisibility(page, true);
  await page.goForward();
  await page.waitForURL('**/another');
  await assertVisibility(page, true);
});
