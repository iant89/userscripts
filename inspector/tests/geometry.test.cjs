const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const script = fs.readFileSync(path.join(__dirname, '..', 'Web Inspector.user.js'), 'utf8');
let browser;

before(async () => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture(t) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 1, reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({
    status: 200, contentType: 'text/html', body: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
      <style>body { margin: 0; min-height: 1800px; }</style></head>
      <body><main><button id="page-button">Page button</button></main></body></html>`,
  }));
  await page.goto('https://geometry.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  return { page, context, inspector: page.locator('#web-inspector-host-v1') };
}

async function geometry(page) {
  return page.evaluate(() => {
    const app = window.__webInspectorInstanceV1;
    const { x, y, width, height, dock } = app.state;
    const rect = app.host.shadowRoot.querySelector('.wi').getBoundingClientRect();
    return { saved: { x, y, width, height, dock }, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
}

// Headless Chromium does not show an OS keyboard. Simulate the VisualViewport
// resize/pan events a keyboard produces on mobile Safari without changing the layout viewport.
async function visualViewport(page, values) {
  await page.evaluate(values => {
    const viewport = window.visualViewport;
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete viewport[key];
      else Object.defineProperty(viewport, key, { configurable: true, value });
    }
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
  }, values);
}

async function dragTitle(page, inspector, dy) {
  const rect = await inspector.locator('.title').boundingBox();
  const x = rect.x + 150, y = rect.y + 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 6 });
  await page.mouse.up();
}

test('keyboard-like visual viewport changes do not alter saved position or size', async t => {
  const { page, inspector } = await fixture(t);
  await dragTitle(page, inspector, 230);
  await inspector.locator('[data-tab="console"]').click();
  await inspector.locator('#command').focus();
  const before = await geometry(page);
  assert.ok(before.rect.y > 200, 'the fixture should have a deliberately moved window');

  for (const [index, viewport] of [
    { height: 360, offsetTop: 400 },
    { height: 320, offsetTop: 60 },
    { height: 430, offsetTop: 250 },
  ].entries()) {
    await visualViewport(page, viewport);
    const during = await geometry(page);
    assert.deepEqual(during.saved, before.saved, 'temporary keyboard bounds must not overwrite preferred geometry');
    assert.ok(during.rect.y >= viewport.offsetTop && during.rect.y + 44 <= viewport.offsetTop + viewport.height,
      'the title bar remains reachable while the keyboard is open');
    assert.ok(during.rect.height <= viewport.height, 'the window fits the temporarily smaller viewport');

    if (index === 0) {
      // Commands save preferences while the keyboard is open; they must not save temporary bounds.
      await inspector.locator('#command').fill('2 + 2');
      await inspector.locator('#command').press('Enter');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('webInspector.preferences.v1') || '{}').activeTab === 'console');
      const saved = await page.evaluate(() => {
        const { x, y, width, height, dock } = JSON.parse(localStorage.getItem('webInspector.preferences.v1'));
        return { x, y, width, height, dock };
      });
      assert.deepEqual(saved, before.saved, 'other actions must persist the preferred, not keyboard-clamped, geometry');
    }

    await visualViewport(page, { height: null, offsetTop: null });
    assert.deepEqual(await geometry(page), before, 'the original position and size return when the keyboard closes');
  }
});

test('real layout viewport resizes are temporary and restore the floating geometry', async t => {
  const { page, inspector } = await fixture(t);
  await dragTitle(page, inspector, 230);
  await inspector.locator('#element-filter').focus();
  const before = await geometry(page);

  for (const viewport of [{ width: 390, height: 260 }, { width: 320, height: 420 }, { width: 390, height: 320 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(({ width, height }) => {
      const rect = document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.wi').getBoundingClientRect();
      return Math.abs(window.visualViewport.width - width) < 1 && Math.abs(window.visualViewport.height - height) < 1 &&
        rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + 44 <= height;
    }, viewport);
    const during = await geometry(page);
    assert.deepEqual(during.saved, before.saved);
    assert.ok(during.rect.y >= 0 && during.rect.y + 44 <= viewport.height, 'the title stays within the smaller viewport');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(expected => {
      const rect = document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.wi').getBoundingClientRect();
      return Math.abs(window.visualViewport.height - 844) < 1 && rect.y === expected.y && rect.height === expected.height;
    }, before.rect);
    assert.deepEqual(await geometry(page), before);
  }
});

test('a deliberate move and horizontal resize while the keyboard is open are retained', async t => {
  const { page, inspector } = await fixture(t);
  const before = await geometry(page);
  await visualViewport(page, { height: 400, offsetTop: 0 });
  await dragTitle(page, inspector, 50);
  const moved = await geometry(page);
  assert.equal(moved.saved.y, before.rect.y + 50, 'an intentional drag updates the preferred position');
  assert.equal(moved.saved.x, before.saved.x, 'a vertical drag preserves the preferred horizontal position');
  assert.equal(moved.saved.height, before.saved.height, 'dragging must not save the keyboard-clamped height');

  const edge = await inspector.locator('.resize.e').boundingBox();
  await page.mouse.move(edge.x + 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x - 38, edge.y + edge.height / 2, { steps: 5 });
  await page.mouse.up();
  const resized = await geometry(page);
  assert.ok(resized.saved.width < moved.rect.width, 'a deliberate horizontal resize changes the preferred width');
  assert.equal(resized.saved.height, before.saved.height, 'a horizontal resize must not change the preferred height');
  assert.equal(resized.saved.y, moved.saved.y, 'a horizontal resize must not move the preferred vertical position');
  assert.equal(resized.rect.x, moved.rect.x, 'a right-edge resize keeps the left edge in place');

  await visualViewport(page, { height: null, offsetTop: null });
  const restored = await geometry(page);
  assert.deepEqual(restored.saved, resized.saved);
  assert.equal(restored.rect.y, resized.saved.y);
  assert.equal(restored.rect.height, before.rect.height);
  assert.equal(restored.rect.width, resized.saved.width);
});

test('docked windows and the reopen button adapt to temporary viewport changes', async t => {
  const { page } = await fixture(t);
  for (const dock of ['left', 'right', 'top', 'bottom']) {
    await page.evaluate(dock => { const app = window.__webInspectorInstanceV1; app.state.dock = dock; app.open(); }, dock);
    const before = await geometry(page);
    await visualViewport(page, { height: 360, offsetTop: 200 });
    assert.deepEqual((await geometry(page)).saved, before.saved);
    await visualViewport(page, { height: null, offsetTop: null });
    assert.deepEqual(await geometry(page), before, `${dock} dock restores its original geometry`);
  }
  await page.keyboard.press('Control+Shift+i');
  const reopen = page.locator('[data-web-inspector-reopen]');
  assert.equal(await reopen.isVisible(), true);
  await visualViewport(page, { height: 360, offsetTop: 200 });
  const position = await reopen.boundingBox();
  assert.equal(position.y + position.height, 200 + 360 - 12, 'the reopen button follows the visible viewport');
  await visualViewport(page, { height: null, offsetTop: null });
  const restored = await reopen.boundingBox();
  assert.equal(restored.y + restored.height, 844 - 12);
});

test('saved geometry is preserved when the inspector initializes with the keyboard open', async t => {
  const { page, inspector } = await fixture(t);
  await dragTitle(page, inspector, 230);
  const before = await geometry(page);
  await page.waitForFunction(expected => {
    const saved = JSON.parse(localStorage.getItem('webInspector.preferences.v1') || '{}');
    return ['x', 'y', 'width', 'height', 'dock'].every(key => saved[key] === expected[key]);
  }, before.saved);
  await visualViewport(page, { height: 360, offsetTop: 400 });
  await page.evaluate(() => window.__webInspectorInstanceV1.destroy());
  await page.evaluate(source => (0, eval)(source), script);
  const initialized = await geometry(page);
  assert.deepEqual(initialized.saved, before.saved);
  assert.ok(initialized.rect.y >= 400 && initialized.rect.y + 44 <= 760);
  await visualViewport(page, { height: null, offsetTop: null });
  assert.deepEqual(await geometry(page), before);
});

test('a resize moved back to its starting point keeps the original preferred geometry', async t => {
  const { page, inspector } = await fixture(t);
  const before = await geometry(page);
  await visualViewport(page, { height: 400, offsetTop: 0 });
  const edge = await inspector.locator('.resize.e').boundingBox();
  const x = edge.x + 2, y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y, { steps: 4 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual((await geometry(page)).saved, before.saved);
  await visualViewport(page, { height: null, offsetTop: null });
  assert.deepEqual(await geometry(page), before);
});

test('intentional docking and undocking still work with preferred geometry', async t => {
  const { page, inspector } = await fixture(t);
  const title = await inspector.locator('.title').boundingBox();
  const startX = title.x + 150, startY = title.y + 20;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(5, 200, { steps: 8 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.ghost')).display === 'block');
  await page.mouse.up();
  assert.equal((await geometry(page)).saved.dock, 'left');

  const docked = await inspector.locator('.title').boundingBox();
  const x = docked.x + 120, y = docked.y + 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y + 160, { steps: 6 });
  await page.mouse.up();
  const undocked = await geometry(page);
  assert.equal(undocked.saved.dock, 'float');
  assert.ok(undocked.rect.x >= 0 && undocked.rect.x + undocked.rect.width <= 390);
  assert.ok(undocked.rect.y > 100 && undocked.rect.y + 44 < 844);
});

test('vertical resizing during a keyboard viewport change leaves the preferred width alone', async t => {
  const { page, inspector } = await fixture(t);
  const before = await geometry(page);
  await visualViewport(page, { height: 600, offsetTop: 0 });
  const edge = await inspector.locator('.resize.s').boundingBox();
  const x = edge.x + edge.width / 2, y = edge.y + 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 90, { steps: 5 });
  await page.mouse.up();
  const resized = await geometry(page);
  assert.equal(resized.saved.height, before.rect.height - 90);
  assert.equal(resized.saved.width, before.saved.width);
  assert.equal(resized.saved.x, before.saved.x);
  assert.equal(resized.rect.y, before.rect.y, 'a bottom-edge resize keeps the top edge in place');
  await visualViewport(page, { height: null, offsetTop: null });
  assert.deepEqual((await geometry(page)).saved, resized.saved);
  assert.equal((await geometry(page)).rect.height, resized.saved.height);
});

test('dragging away and back while the keyboard is open retains the original preference', async t => {
  const { page, inspector } = await fixture(t);
  const before = await geometry(page);
  await visualViewport(page, { height: 400, offsetTop: 200 });
  const title = await inspector.locator('.title').boundingBox();
  const x = title.x + 150, y = title.y + 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 50, { steps: 4 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual((await geometry(page)).saved, before.saved);
  await visualViewport(page, { height: null, offsetTop: null });
  assert.deepEqual(await geometry(page), before);
});

test('animated viewport changes settle back to the original geometry without drifting', async t => {
  const { page, inspector } = await fixture(t);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await dragTitle(page, inspector, 230);
  const before = await geometry(page);
  for (let i = 0; i < 3; i++) {
    await visualViewport(page, { height: 360, offsetTop: 400 });
    await page.waitForFunction(expected => {
      const rect = document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.wi').getBoundingClientRect();
      return rect.height < expected.height - 30;
    }, before.rect);
    await visualViewport(page, { height: null, offsetTop: null });
    await page.waitForFunction(expected => {
      const rect = document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.wi').getBoundingClientRect();
      return Math.abs(rect.x - expected.x) < 0.1 && Math.abs(rect.y - expected.y) < 0.1 &&
        Math.abs(rect.width - expected.width) < 0.1 && Math.abs(rect.height - expected.height) < 0.1;
    }, before.rect);
    assert.deepEqual((await geometry(page)).saved, before.saved);
  }
});

test('a touch drag while the keyboard is open keeps its intentional position', async t => {
  const { page, context, inspector } = await fixture(t);
  const before = await geometry(page);
  await visualViewport(page, { height: 500, offsetTop: 0 });
  const title = await inspector.locator('.title').boundingBox();
  const x = title.x + 150, y = title.y + 20;
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y]) => ({ x, y, id: 1 })),
  });
  await touch('touchStart', [[x, y]]);
  await touch('touchMove', [[x, y + 50]]);
  await touch('touchEnd', []);
  const moved = await geometry(page);
  assert.equal(moved.saved.y, before.rect.y + 50);
  assert.equal(moved.saved.height, before.saved.height);
  assert.equal(moved.saved.x, before.saved.x);
  await visualViewport(page, { height: null, offsetTop: null });
  const restored = await geometry(page);
  assert.deepEqual(restored.saved, moved.saved);
  assert.equal(restored.rect.y, moved.saved.y);
  assert.equal(restored.rect.height, before.rect.height);
});
