const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const script = fs.readFileSync(path.join(__dirname, '..', 'Web Inspector.user.js'), 'utf8');
let browser;

before(async () => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 },
    ...(options.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}),
    ...(options.reducedMotion ? { reducedMotion: 'reduce' } : {}),
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.setContent(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body { margin: 0; min-height: 2000px; background: #f7f9fb; }
      .target { position: absolute; left: 850px; width: 200px; height: 90px; background: white !important; }
      #first { top: 120px; } #second { top: 300px; }
      #shadow-host { position: absolute; left: 850px; top: 470px; width: 240px; height: 120px; background: #ddd; }
      .pickbox, .selectionbox { background: red !important; position: static !important; }
      @media (max-width: 600px) { .target { left: 50px; } #first { top: 630px; } #second { top: 740px; } }
    </style></head><body>
      <button id="first" class="target" style="color: navy; border-radius: 14px">First</button>
      <button id="second" class="target">Second</button>
      <div id="shadow-host"></div>
      <script>
        window.pageClicks = 0;
        document.querySelectorAll('.target').forEach(button => button.addEventListener('click', () => window.pageClicks++));
        const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
        shadow.innerHTML = '<style>button{width:150px;height:70px}</style><button id="shadow-button">Shadow target</button>';
        shadow.querySelector('button').addEventListener('click', () => window.pageClicks++);
      </script>
    </body></html>`);
  await page.evaluate(source => (0, eval)(source), script);
  return { page, context, inspector: page.locator('#web-inspector-host-v1') };
}

async function waitForBox(page, boxClass, targetSelector, outset = 0, shadow = false) {
  await page.waitForFunction(({ boxClass, targetSelector, outset, shadow }) => {
    const root = document.querySelector('#web-inspector-host-v1')?.shadowRoot;
    const box = root?.querySelector(`.${boxClass}`);
    const target = shadow ? document.querySelector('#shadow-host')?.shadowRoot?.querySelector(targetSelector) : document.querySelector(targetSelector);
    if (!box || !target || getComputedStyle(box).display === 'none') return false;
    const b = box.getBoundingClientRect(), r = target.getBoundingClientRect();
    return Math.abs(b.left - (r.left - outset)) < 0.75 && Math.abs(b.top - (r.top - outset)) < 0.75 &&
      Math.abs(b.width - (r.width + outset * 2)) < 0.75 && Math.abs(b.height - (r.height + outset * 2)) < 0.75;
  }, { boxClass, targetSelector, outset, shadow }, { timeout: 3000 });
}

async function inspectorState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#web-inspector-host-v1').shadowRoot;
    const pick = root.querySelector('.pickbox'), selection = root.querySelector('.selectionbox');
    return {
      mask: !!root.querySelector('.pickmask'),
      pickDisplay: getComputedStyle(pick).display,
      pickBackground: getComputedStyle(pick).backgroundColor,
      pickPointerEvents: getComputedStyle(pick).pointerEvents,
      pickRadius: getComputedStyle(pick).borderRadius,
      selectionDisplay: getComputedStyle(selection).display,
      selectionAnimation: getComputedStyle(selection).animationName,
      selectionBorder: getComputedStyle(selection).borderTopWidth,
      selectionPointerEvents: getComputedStyle(selection).pointerEvents,
      label: root.querySelector('#selected-label').textContent,
      status: root.querySelector('#status-text').textContent,
      clicks: window.pageClicks,
    };
  });
}

async function pickButton(inspector, mobile = false) {
  return mobile ? inspector.locator('.detail-actions [data-action="pick"]') : inspector.locator('#toolbar [data-action="pick"]');
}

async function startDrag(page, inspector) {
  const rect = await (await pickButton(inspector)).boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
}

test('click-to-pick previews the current element and selects it without changing the page', async t => {
  const { page, inspector } = await fixture(t);
  const originals = await page.locator('.target').evaluateAll(nodes => nodes.map(node => node.outerHTML));
  await (await pickButton(inspector)).click();
  assert.equal((await inspectorState(page)).mask, true);

  await page.mouse.move(900, 150);
  await waitForBox(page, 'pickbox', '#first');
  let state = await inspectorState(page);
  assert.equal(state.pickBackground, 'rgba(134, 239, 172, 0.38)');
  assert.equal(state.pickPointerEvents, 'none');
  assert.equal(state.pickRadius, '14px');

  await page.mouse.move(900, 330);
  await waitForBox(page, 'pickbox', '#second');
  await page.mouse.click(900, 330);
  await waitForBox(page, 'selectionbox', '#second', 6);
  state = await inspectorState(page);
  assert.equal(state.label, 'button#second.target');
  assert.equal(state.mask, false);
  assert.equal(state.pickDisplay, 'none');
  assert.equal(state.selectionAnimation, 'wi-selection-pulse');
  assert.equal(state.selectionBorder, '2px');
  assert.equal(state.selectionPointerEvents, 'none');
  assert.equal(state.clicks, 0, 'picking must not activate the page button');
  assert.deepEqual(await page.locator('.target').evaluateAll(nodes => nodes.map(node => node.outerHTML)), originals);

  // A fresh click immediately after picking must reach the page normally.
  await page.mouse.click(900, 330);
  assert.equal((await inspectorState(page)).clicks, 1);
});

test('dragging from Pick highlights each element and selects the one under the release', async t => {
  const { page, inspector } = await fixture(t);
  await startDrag(page, inspector);
  await page.mouse.move(900, 150, { steps: 8 });
  await waitForBox(page, 'pickbox', '#first');
  await page.mouse.move(900, 330, { steps: 8 });
  await waitForBox(page, 'pickbox', '#second');
  await page.mouse.up();
  await waitForBox(page, 'selectionbox', '#second', 6);
  const state = await inspectorState(page);
  assert.equal(state.label, 'button#second.target');
  assert.equal(state.mask, false, 'the drag must not re-arm Pick on release');
  assert.equal(state.pickDisplay, 'none');
  assert.equal(state.clicks, 0);
  await page.mouse.click(900, 330);
  assert.equal((await inspectorState(page)).clicks, 1);
});

test('touch dragging works from Pick and after tapping Pick, without scrolling or clicking the page', async t => {
  const { page, context, inspector } = await fixture(t, { mobile: true });
  const button = await pickButton(inspector, true);
  const rect = await button.boundingBox();
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y]) => ({ x, y, id: 1 })),
  });
  await touch('touchStart', [[rect.x + rect.width / 2, rect.y + rect.height / 2]]);
  await touch('touchMove', [[160, 670]]);
  await waitForBox(page, 'pickbox', '#first');
  await touch('touchMove', [[160, 780]]);
  await waitForBox(page, 'pickbox', '#second');
  await touch('touchEnd', []);
  await waitForBox(page, 'selectionbox', '#second', 6);
  assert.equal((await inspectorState(page)).clicks, 0);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.touchscreen.tap(160, 780);
  assert.equal((await inspectorState(page)).clicks, 1, 'a later tap should reach the page');

  await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
  assert.equal((await inspectorState(page)).mask, true);
  await touch('touchStart', [[160, 780]]);
  await touch('touchMove', [[160, 670]]);
  await waitForBox(page, 'pickbox', '#first');
  await touch('touchEnd', []);
  await waitForBox(page, 'selectionbox', '#first', 6);
  const state = await inspectorState(page);
  assert.equal(state.label, 'button#first.target');
  assert.equal(state.mask, false);
  assert.equal(state.clicks, 1);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.touchscreen.tap(160, 670);
  assert.equal((await inspectorState(page)).clicks, 2, 'the next touch tap should reach the page');
});

test('mobile tap selection and an interrupted touch clean up correctly', async t => {
  const { page, context, inspector } = await fixture(t, { mobile: true });
  const button = await pickButton(inspector, true);
  const rect = await button.boundingBox();
  await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.touchscreen.tap(160, 670);
  await waitForBox(page, 'selectionbox', '#first', 6);
  assert.equal((await inspectorState(page)).clicks, 0);
  await page.touchscreen.tap(160, 670);
  assert.equal((await inspectorState(page)).clicks, 1);

  await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const touchMoveAllowed = () => page.evaluate(() => window.dispatchEvent(new Event('touchmove', { cancelable: true })));
  assert.equal(await touchMoveAllowed(), false, 'touch scrolling is prevented while picking');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 780, id: 1 }] });
  await waitForBox(page, 'pickbox', '#second');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  const state = await inspectorState(page);
  assert.equal(state.mask, false);
  assert.equal(state.pickDisplay, 'none');
  assert.equal(state.label, 'button#first.target');
  assert.equal(state.clicks, 1);

  assert.equal(await touchMoveAllowed(), true, 'touch scrolling is restored after canceling');
});

test('Escape and pointer cancellation clear the preview without replacing the selection', async t => {
  const { page, inspector } = await fixture(t);
  await (await pickButton(inspector)).click();
  await page.mouse.click(900, 330);
  await waitForBox(page, 'selectionbox', '#second', 6);

  await (await pickButton(inspector)).click();
  await page.mouse.move(900, 150);
  await waitForBox(page, 'pickbox', '#first');
  await page.keyboard.press('Escape');
  let state = await inspectorState(page);
  assert.equal(state.mask, false);
  assert.equal(state.pickDisplay, 'none');
  assert.equal(state.label, 'button#second.target');
  assert.match(state.status, /Pick canceled/);

  await startDrag(page, inspector);
  await page.mouse.move(900, 150, { steps: 6 });
  await waitForBox(page, 'pickbox', '#first');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  state = await inspectorState(page);
  assert.equal(state.mask, false);
  assert.equal(state.label, 'button#second.target');
  assert.equal(state.clicks, 0);
  await page.mouse.click(900, 150);
  assert.equal((await inspectorState(page)).clicks, 1);

  // A canceled pointer, such as an interrupted touch, also tears down Pick mode.
  await startDrag(page, inspector);
  await page.mouse.move(900, 150, { steps: 6 });
  await waitForBox(page, 'pickbox', '#first');
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  await page.mouse.up();
  state = await inspectorState(page);
  assert.equal(state.mask, false);
  assert.equal(state.pickDisplay, 'none');
  assert.equal(state.label, 'button#second.target');
});

test('tree selection follows layout and scrolling and is hidden when appropriate', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('.tree-row').filter({ hasText: '#first' }).click();
  await waitForBox(page, 'selectionbox', '#first', 6);

  await page.locator('#first').evaluate(node => {
    node.style.left = '910px'; node.style.width = '250px'; node.style.transform = 'translateY(45px)';
  });
  await waitForBox(page, 'selectionbox', '#first', 6);
  await page.evaluate(() => window.scrollTo(0, 80));
  await waitForBox(page, 'selectionbox', '#first', 6);

  await inspector.locator('[data-action="visibility"]').click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.selectionbox')).display === 'none');
  await inspector.locator('[data-action="visibility"]').click();
  await waitForBox(page, 'selectionbox', '#first', 6);

  await inspector.locator('[data-action="close"]').click();
  assert.equal((await inspectorState(page)).selectionDisplay, 'none');
  await page.locator('[data-web-inspector-reopen]').click();
  await waitForBox(page, 'selectionbox', '#first', 6);

  await page.locator('#first').evaluate(node => node.remove());
  await page.waitForFunction(() => document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('#selected-label').textContent === 'No element selected');
  assert.equal((await inspectorState(page)).selectionDisplay, 'none');
});

test('picking inside open shadow roots and Source view exclude inspector overlays', async t => {
  const { page, inspector } = await fixture(t);
  await (await pickButton(inspector)).click();
  await page.mouse.move(900, 500);
  await waitForBox(page, 'pickbox', '#shadow-button', 0, true);
  await page.mouse.click(900, 500);
  await waitForBox(page, 'selectionbox', '#shadow-button', 6, true);
  assert.equal((await inspectorState(page)).label, 'button#shadow-button');
  assert.equal((await inspectorState(page)).clicks, 0);
  await inspector.locator('[data-tab="source"]').click();
  const source = await inspector.locator('#sourceview').textContent();
  assert.match(source, /id="shadow-host"/);
  assert.doesNotMatch(source, /data-web-inspector-host|data-web-inspector-reopen/);
  assert.doesNotMatch(source, /class="(?:pickbox|selectionbox|pickmask)"/);
});

test('keyboard activation and reduced motion retain a visible non-animated selection', async t => {
  const { page, inspector } = await fixture(t, { reducedMotion: true });
  const button = await pickButton(inspector);
  await button.focus();
  await page.keyboard.press('Enter');
  assert.equal((await inspectorState(page)).mask, true);
  await page.mouse.move(900, 150);
  await waitForBox(page, 'pickbox', '#first');
  await page.mouse.click(900, 150);
  await waitForBox(page, 'selectionbox', '#first', 6);
  const state = await inspectorState(page);
  assert.equal(state.selectionDisplay, 'block');
  assert.equal(state.selectionBorder, '2px');
  assert.equal(state.selectionAnimation, 'none');
});

test('search selection moves the border and ignores inspector-owned elements', async t => {
  const { page, inspector } = await fixture(t);
  const treeText = await inspector.locator('#tree').textContent();
  assert.doesNotMatch(treeText, /web-inspector-reopen|web-inspector-host/);

  await inspector.locator('#element-filter').fill('id=second');
  await inspector.locator('[data-action="search-elements"]').click();
  await waitForBox(page, 'selectionbox', '#second', 6);
  assert.equal((await inspectorState(page)).label, 'button#second.target');
  await inspector.locator('.tree-row').filter({ hasText: '#first' }).click();
  await waitForBox(page, 'selectionbox', '#first', 6);
  assert.equal((await inspectorState(page)).label, 'button#first.target');
});

test('destroy removes highlights, event handlers, and the reopen button', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('.tree-row').filter({ hasText: '#first' }).click();
  await waitForBox(page, 'selectionbox', '#first', 6);
  await (await pickButton(inspector)).click();
  await page.mouse.move(900, 330);
  await waitForBox(page, 'pickbox', '#second');
  await page.evaluate(() => window.__webInspectorInstanceV1.destroy());
  assert.equal(await page.locator('#web-inspector-host-v1').count(), 0);
  assert.equal(await page.locator('[data-web-inspector-reopen]').count(), 0);
  await page.mouse.click(900, 330);
  assert.equal(await page.evaluate(() => window.pageClicks), 1);

  await page.evaluate(source => (0, eval)(source), script);
  assert.equal(await page.locator('#web-inspector-host-v1').count(), 1);
  assert.equal(await page.locator('[data-web-inspector-reopen]').count(), 1);
});

test('userscript initializes at document start before the page body exists', async t => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: script });
  const html = '<!doctype html><html><head><style>#target{position:absolute;left:850px;top:120px;width:200px;height:90px}</style></head><body><button id="target">Target</button></body></html>';
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  const inspector = page.locator('#web-inspector-host-v1');
  await inspector.waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-web-inspector-reopen]').isVisible(), false, 'the reopen button starts hidden');
  await (await pickButton(inspector)).click();
  await page.mouse.move(900, 150);
  await waitForBox(page, 'pickbox', '#target');
  await page.mouse.click(900, 150);
  await waitForBox(page, 'selectionbox', '#target', 6);
  assert.equal((await inspectorState(page)).label, 'button#target');
  assert.deepEqual(errors, []);
});
