const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const solid = require('@fortawesome/free-solid-svg-icons');

const script = fs.readFileSync(path.join(__dirname, '..', 'Web Inspector.user.js'), 'utf8');
const definitions = {
  search: solid.faMagnifyingGlass,
  minus: solid.faMinus,
  close: solid.faXmark,
  code: solid.faCode,
  terminal: solid.faTerminal,
  'file-code': solid.faFileCode,
  database: solid.faDatabase,
  'expand-tree': solid.faAnglesDown,
  pick: solid.faCrosshairs,
  eye: solid.faEye,
  'eye-slash': solid.faEyeSlash,
  trash: solid.faTrashCan,
  plus: solid.faPlus,
  refresh: solid.faRotateRight,
  play: solid.faPlay,
  copy: solid.faCopy,
  'file-lines': solid.faFileLines,
  broom: solid.faBroom,
  down: solid.faArrowDown,
  up: solid.faArrowUp,
  'chevron-down': solid.faChevronDown,
  'chevron-right': solid.faChevronRight,
  circle: solid.faCircle,
  undo: solid.faRotateLeft,
};
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
  });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.route('**/*', route => {
    if (route.request().url() !== 'https://inspector.test/') return route.abort();
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html>
      <html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body { margin: 0; min-height: 1000px; }
        #container { position: absolute; left: 850px; top: 120px; }
        #target { width: 200px; height: 90px; }
        /* Page CSS should not distort the inspector's inline icons, including the reopen button. */
        svg { width: 200px !important; height: 200px !important; fill: magenta !important; pointer-events: auto !important; }
        path { fill: red !important; pointer-events: auto !important; }
        button[data-web-inspector-reopen] { display: flex !important; }
      </style></head><body>
      <main id="container"><section id="section"><button id="target">Target</button><div id="secondary">Second</div></section></main>
      <script>window.pageClicks = 0; document.querySelector('#target').addEventListener('click', () => window.pageClicks++);</script>
      </body></html>` });
  });
  await page.goto('https://inspector.test/');
  const requestsBeforeInjection = requests.length;
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'the userscript should not raise page errors');
    assert.deepEqual(requests.slice(requestsBeforeInjection), [], 'icons must not trigger network requests');
  });
  await page.evaluate(source => (0, eval)(source), script);
  return { page, inspector: page.locator('#web-inspector-host-v1') };
}

async function clickIcon(page, control) {
  const icon = control.locator('svg.fa-icon');
  assert.equal(await icon.count(), 1, 'the control should have exactly one icon');
  const rect = await icon.boundingBox();
  assert.ok(rect && rect.width > 0 && rect.height > 0, 'the icon should be visible');
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

async function assertOfficialIcons(page, seen) {
  const snapshots = await page.evaluate(() => {
    const root = document.querySelector('#web-inspector-host-v1').shadowRoot;
    const icons = [...root.querySelectorAll('svg.fa-icon'), document.querySelector('[data-web-inspector-reopen] svg.fa-icon')];
    return icons.map(svg => {
      const paths = svg.querySelectorAll('path');
      const path = paths[0];
      return {
        name: svg.dataset.icon,
        namespace: svg.namespaceURI,
        viewBox: svg.getAttribute('viewBox'),
        hidden: svg.getAttribute('aria-hidden'),
        focusable: svg.getAttribute('focusable'),
        pathCount: paths.length,
        path: path?.getAttribute('d'),
        svgPointer: getComputedStyle(svg).pointerEvents,
        pathPointer: getComputedStyle(path).pointerEvents,
        color: getComputedStyle(path).color,
        fill: getComputedStyle(path).fill,
      };
    });
  });
  assert.ok(snapshots.length > 0);
  for (const icon of snapshots) {
    const definition = definitions[icon.name];
    assert.ok(definition, `unexpected icon ${icon.name}`);
    const [width, height, , , svgPath] = definition.icon;
    assert.equal(icon.namespace, 'http://www.w3.org/2000/svg');
    assert.equal(icon.viewBox, `0 0 ${width} ${height}`, `${icon.name} viewBox`);
    assert.equal(icon.pathCount, 1, `${icon.name} path count`);
    assert.equal(icon.path, svgPath, `${icon.name} should match the official icon path`);
    assert.equal(icon.hidden, 'true', `${icon.name} should be decorative`);
    assert.equal(icon.focusable, 'false', `${icon.name} should not take keyboard focus`);
    assert.equal(icon.svgPointer, 'none', `${icon.name} should not intercept pointer input`);
    assert.equal(icon.pathPointer, 'none', `${icon.name} path should not intercept pointer input`);
    assert.equal(icon.fill, icon.color, `${icon.name} should use the control's current color`);
    seen.add(icon.name);
  }
}

test('controls use labeled, decorative Font Awesome icons with official paths', async t => {
  const { page, inspector } = await fixture(t);
  const controls = [
    ['[data-action="collapse"]', 'Collapse inspector', 'minus'],
    ['[data-action="close"]', 'Hide inspector', 'close'],
    ['[data-action="expand-all"]', 'Expand document tree', 'expand-tree'],
    ['.detail-actions [data-action="pick"]', 'Pick an element from the page', 'pick'],
    ['[data-action="visibility"]', 'Toggle selected element visibility', 'eye'],
    ['[data-action="delete-element"]', 'Delete selected element', 'trash'],
    ['[data-action="add-element"]', 'Add an element', 'plus'],
    ['[data-action="refresh-element"]', 'Refresh selected element', 'refresh'],
    ['[data-action="execute"]', 'Execute command', 'play'],
    ['.sourcebar [data-action="copy-source"]', 'Copy source', 'copy'],
    ['[data-action="refresh-source"]', 'Refresh source', 'refresh'],
    ['[data-action="resource-copy"]', 'Copy selected resource', 'copy'],
    ['[data-action="resource-view"]', 'View selected value in Source', 'file-lines'],
    ['[data-action="resource-delete"]', 'Delete selected resource', 'trash'],
    ['[data-action="resource-clean"]', 'Clear this storage category', 'broom'],
    ['[data-action="resource-refresh"]', 'Refresh resources', 'refresh'],
    ['[data-action="search-elements"]', 'Search elements', 'search'],
    ['[data-action="search-next"]', 'Next result', 'down'],
    ['[data-action="search-prev"]', 'Previous result', 'up'],
    ['#toolbar [data-action="pick"]', 'Pick target on page', 'pick'],
  ];
  for (const [selector, label, icon] of controls) {
    const control = inspector.locator(selector);
    assert.equal(await control.getAttribute('aria-label'), label, selector);
    assert.ok(await control.getAttribute('title'), `${selector} should keep its tooltip`);
    assert.equal(await control.locator('svg').getAttribute('data-icon'), icon, selector);
  }
  for (const [tab, label, icon] of [
    ['elements', 'Elements', 'code'], ['console', 'Console', 'terminal'],
    ['source', 'Source', 'file-code'], ['resources', 'Resources', 'database'],
  ]) {
    assert.equal(await inspector.getByRole('tab', { name: label, exact: true }).count(), 1);
    assert.equal(await inspector.locator(`[data-tab="${tab}"] svg`).getAttribute('data-icon'), icon);
  }
  assert.equal(await inspector.getByRole('button', { name: 'Pick target on page', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Open Web Inspector', exact: true }).count(), 0, 'the reopen button is hidden while the inspector is visible');

  const seen = new Set();
  await assertOfficialIcons(page, seen);

  const container = inspector.locator('.tree-row').filter({ hasText: '#container' });
  assert.equal(await container.locator('.twisty').getAttribute('aria-label'), 'Expand element');
  assert.equal(await container.locator('svg').getAttribute('data-icon'), 'chevron-right');
  await clickIcon(page, container.locator('.twisty'));
  assert.equal(await container.locator('.twisty').getAttribute('aria-label'), 'Collapse element');
  assert.equal(await container.locator('svg').getAttribute('data-icon'), 'chevron-down');
  const section = inspector.locator('.tree-row').filter({ hasText: '#section' });
  await clickIcon(page, section.locator('.twisty'));
  const target = inspector.locator('.tree-row').filter({ hasText: '#target' });
  assert.equal(await target.locator('.twisty').getAttribute('aria-label'), 'No children');
  assert.equal(await target.locator('.twisty').isDisabled(), true);
  assert.equal(await target.locator('.twisty svg').getAttribute('data-icon'), 'circle');
  await target.click();
  await clickIcon(page, inspector.locator('[data-action="visibility"]'));
  assert.equal(await target.getByRole('img', { name: 'Hidden', exact: true }).count(), 1);
  assert.equal(await target.locator('.hidden-indicator svg').getAttribute('data-icon'), 'eye-slash');
  assert.equal(await target.locator('.tag').textContent(), '<button>', 'the page tag name stays text, not HTML');
  await assertOfficialIcons(page, seen);
  await clickIcon(page, inspector.locator('[data-action="visibility"]'));
  assert.equal(await target.locator('.hidden-indicator').count(), 0);

  page.once('dialog', dialog => dialog.accept());
  await clickIcon(page, inspector.locator('[data-action="delete-element"]'));
  assert.equal(await page.locator('#target').count(), 0);
  const undo = inspector.locator('[data-action="undo-delete"]');
  assert.equal(await undo.getAttribute('aria-label'), 'Undo deletion');
  assert.equal(await undo.locator('svg').getAttribute('data-icon'), 'undo');
  await assertOfficialIcons(page, seen);
  await clickIcon(page, undo);
  assert.equal(await page.locator('#target').count(), 1);

  await clickIcon(page, inspector.locator('[data-tab="source"]'));
  assert.equal(await inspector.locator('[data-action="source-find"]').getAttribute('aria-label'), 'Find in source');
  assert.equal(await inspector.locator('[data-action="source-find"] svg').getAttribute('data-icon'), 'search');
  assert.equal(await inspector.locator('#toolbar [data-action="copy-source"] svg').getAttribute('data-icon'), 'copy');
  await assertOfficialIcons(page, seen);
  assert.deepEqual([...seen].sort(), Object.keys(definitions).sort(), 'all embedded icon definitions are exercised');
});

test('clicking and dragging icon areas keeps inspector controls working without icon requests', async t => {
  const { page, inspector } = await fixture(t);

  await inspector.locator('#element-filter').fill('id=target');
  await clickIcon(page, inspector.locator('[data-action="search-elements"]'));
  assert.equal(await inspector.locator('#selected-label').textContent(), 'button#target');

  // Drag from the icon itself; the page target must be previewed, not activated.
  const pickIcon = inspector.locator('#toolbar [data-action="pick"] svg');
  const pickRect = await pickIcon.boundingBox();
  await page.mouse.move(pickRect.x + pickRect.width / 2, pickRect.y + pickRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(900, 150, { steps: 8 });
  await page.waitForFunction(() => {
    const box = document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.pickbox');
    return getComputedStyle(box).display !== 'none' && getComputedStyle(box).backgroundColor === 'rgba(134, 239, 172, 0.38)';
  });
  await page.mouse.up();
  assert.equal(await inspector.locator('#selected-label').textContent(), 'button#target');
  assert.equal(await page.evaluate(() => window.pageClicks), 0);

  await clickIcon(page, inspector.locator('[data-action="collapse"]'));
  assert.equal(await inspector.locator('.wi').evaluate(el => el.classList.contains('collapsed')), true);
  await clickIcon(page, inspector.locator('[data-action="collapse"]'));
  assert.equal(await inspector.locator('.wi').evaluate(el => el.classList.contains('collapsed')), false);

  await clickIcon(page, inspector.locator('[data-tab="console"]'));
  assert.equal(await inspector.locator('[data-tab="console"]').getAttribute('aria-selected'), 'true');
  await inspector.locator('#command').fill('window.iconTestValue = 42');
  await clickIcon(page, inspector.locator('[data-action="execute"]'));
  assert.equal(await page.evaluate(() => window.iconTestValue), 42);

  await page.evaluate(() => localStorage.setItem('icon-test-setting', '{"enabled":true}'));
  await clickIcon(page, inspector.locator('[data-tab="resources"]'));
  await inspector.locator('.resrow').filter({ hasText: 'icon-test-setting' }).click();
  await clickIcon(page, inspector.locator('[data-action="resource-view"]'));
  assert.equal(await inspector.locator('[data-tab="source"]').getAttribute('aria-selected'), 'true');
  assert.match(await inspector.locator('#sourceview').textContent(), /"enabled": true/);
  await clickIcon(page, inspector.locator('[data-action="refresh-source"]'));
  assert.match(await inspector.locator('#source-label').textContent(), /Reconstructed live DOM/);

  await clickIcon(page, inspector.locator('[data-action="close"]'));
  assert.equal(await inspector.locator('.wi').isVisible(), false);
  const reopen = page.locator('[data-web-inspector-reopen]');
  const iconSize = await reopen.locator('svg').boundingBox();
  assert.ok(iconSize.width < 30 && iconSize.height < 30, 'page SVG rules must not enlarge the reopen icon');
  await clickIcon(page, reopen);
  assert.equal(await inspector.locator('.wi').isVisible(), true);
  assert.match(await inspector.locator('#status-text').textContent(), /Inspector reopened/);
});

async function assertCollapseState(inspector, collapsed) {
  const button = inspector.locator('[data-action="collapse"]');
  const label = collapsed ? 'Expand inspector' : 'Collapse inspector';
  const icon = collapsed ? solid.faPlus : solid.faMinus;
  assert.equal(await inspector.locator('.wi').evaluate(el => el.classList.contains('collapsed')), collapsed);
  assert.equal(await button.getAttribute('title'), label);
  assert.equal(await button.getAttribute('aria-label'), label);
  assert.equal(await button.getAttribute('aria-expanded'), String(!collapsed));
  assert.equal(await inspector.getByRole('button', { name: label, exact: true }).count(), 1);
  assert.equal(await button.locator('svg').getAttribute('data-icon'), collapsed ? 'plus' : 'minus');
  assert.equal(await button.locator('path').getAttribute('d'), icon.icon[4]);
}

async function assertReopenState(page, inspector, closed) {
  const reopen = page.locator('[data-web-inspector-reopen]');
  assert.equal(await inspector.locator('.wi').isVisible(), !closed);
  assert.equal(await reopen.isVisible(), closed);
  assert.equal(await reopen.evaluate(el => el.hidden), !closed);
  assert.equal(await page.getByRole('button', { name: 'Open Web Inspector', exact: true }).count(), closed ? 1 : 0);
}

test('collapse icon and accessible state follow toggles and restored preferences', async t => {
  const { page, inspector } = await fixture(t);
  await assertCollapseState(inspector, false);
  await assertReopenState(page, inspector, false);

  await clickIcon(page, inspector.locator('[data-action="collapse"]'));
  await assertCollapseState(inspector, true);
  await assertReopenState(page, inspector, false);
  await page.setViewportSize({ width: 1100, height: 750 });
  await assertCollapseState(inspector, true);

  // The saved collapsed preference must also initialize the icon and label on a new instance.
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('webInspector.preferences.v1') || '{}').collapsed === true);
  await page.evaluate(() => window.__webInspectorInstanceV1.destroy());
  await page.evaluate(source => (0, eval)(source), script);
  await assertCollapseState(inspector, true);
  await assertReopenState(page, inspector, false);

  await inspector.getByRole('button', { name: 'Expand inspector', exact: true }).focus();
  await page.keyboard.press('Enter');
  await assertCollapseState(inspector, false);
  await assertReopenState(page, inspector, false);
});

test('the circle is shown only while hidden, including shortcut and API transitions', async t => {
  const { page, inspector } = await fixture(t);
  const reopen = page.locator('[data-web-inspector-reopen]');
  await assertReopenState(page, inspector, false);

  // A hidden reopen control must not cover or intercept the page beneath it.
  await page.evaluate(() => {
    const underneath = document.createElement('button');
    underneath.id = 'under-reopen'; underneath.textContent = 'Page button';
    Object.assign(underneath.style, { position: 'fixed', right: '12px', bottom: '12px', width: '44px', height: '44px' });
    underneath.onclick = () => { window.underReopenClicks = (window.underReopenClicks || 0) + 1; };
    document.body.appendChild(underneath);
  });
  await page.locator('#under-reopen').click();
  assert.equal(await page.evaluate(() => window.underReopenClicks), 1);

  // A collapsed title bar is still visible, so it must not show the circle.
  await clickIcon(page, inspector.locator('[data-action="collapse"]'));
  await assertCollapseState(inspector, true);
  await assertReopenState(page, inspector, false);
  await clickIcon(page, inspector.locator('[data-action="close"]'));
  await assertReopenState(page, inspector, true);
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-web-inspector-reopen]').getBoundingClientRect();
    const v = window.visualViewport;
    return Math.abs(rect.right - (v.offsetLeft + v.width - 12)) < 1 && Math.abs(rect.bottom - (v.offsetTop + v.height - 12)) < 1;
  });
  await clickIcon(page, reopen);
  await assertReopenState(page, inspector, false);
  await assertCollapseState(inspector, true);

  await page.keyboard.press('Control+Shift+i');
  await assertReopenState(page, inspector, true);
  await page.keyboard.press('Control+Shift+i');
  await assertReopenState(page, inspector, false);
  await assertCollapseState(inspector, true);

  await clickIcon(page, inspector.locator('[data-action="close"]'));
  await assertReopenState(page, inspector, true);
  await page.evaluate(() => window.__webInspectorInstanceV1.open());
  await assertReopenState(page, inspector, false);
  await page.locator('#under-reopen').click();
  assert.equal(await page.evaluate(() => window.underReopenClicks), 2);

  // Hiding through the shortcut while picking cancels the mask and leaves the circle usable.
  await clickIcon(page, inspector.locator('[data-action="collapse"]'));
  await clickIcon(page, inspector.locator('#toolbar [data-action="pick"]'));
  assert.equal(await inspector.locator('.pickmask').count(), 1);
  await page.keyboard.press('Control+Shift+i');
  await assertReopenState(page, inspector, true);
  assert.equal(await inspector.locator('.pickmask').count(), 0);
  await clickIcon(page, reopen);
  await assertReopenState(page, inspector, false);
});

test('the expand control stays reachable when the collapsed inspector is docked', async t => {
  const { page, inspector } = await fixture(t);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const viewport = page.viewportSize();
  for (const dock of ['left', 'right', 'top', 'bottom']) {
    await page.evaluate(dock => {
      const app = window.__webInspectorInstanceV1;
      app.state.dock = dock;
      app.state.collapsed = false;
      app.open();
    }, dock);
    await assertCollapseState(inspector, false);
    await clickIcon(page, inspector.locator('[data-action="collapse"]'));
    await assertCollapseState(inspector, true);
    await assertReopenState(page, inspector, false);
    const rect = await inspector.locator('[data-action="collapse"]').boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width && rect.y >= 0 && rect.y + rect.height <= viewport.height,
      `the ${dock}-docked expand control must be on screen`);
    if (dock === 'bottom') {
      const windowRect = await inspector.locator('.wi').boundingBox();
      assert.equal(windowRect.y + windowRect.height, viewport.height, 'the collapsed bottom dock stays at the bottom edge');
    }
    await clickIcon(page, inspector.locator('[data-action="collapse"]'));
    await assertCollapseState(inspector, false);
  }
});

test('touch users can collapse, hide, reopen and expand without a duplicate circle', async t => {
  const { page, inspector } = await fixture(t, { mobile: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const collapse = inspector.locator('[data-action="collapse"]');
  const reopen = page.locator('[data-web-inspector-reopen]');
  await assertCollapseState(inspector, false);
  await assertReopenState(page, inspector, false);
  await collapse.tap();
  await assertCollapseState(inspector, true);
  await assertReopenState(page, inspector, false);
  await inspector.locator('[data-action="close"]').tap();
  await assertReopenState(page, inspector, true);
  const insideVisibleViewport = await page.evaluate(() => {
    const rect = document.querySelector('[data-web-inspector-reopen]').getBoundingClientRect();
    const v = window.visualViewport;
    return rect.left >= v.offsetLeft && rect.right <= v.offsetLeft + v.width &&
      rect.top >= v.offsetTop && rect.bottom <= v.offsetTop + v.height;
  });
  assert.equal(insideVisibleViewport, true, 'the reopen button must stay in the visible mobile viewport even on an overflowing page');
  await reopen.tap();
  await assertReopenState(page, inspector, false);
  await assertCollapseState(inspector, true);
  await collapse.tap();
  await assertCollapseState(inspector, false);
});

async function waitForWindowAnimations(page) {
  await page.evaluate(async () => {
    const win = document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.wi');
    win.getBoundingClientRect();
    await Promise.all(win.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}

async function captureCollapseFrames(page, inspector, mobile) {
  const initialHeight = await inspector.locator('.wi').evaluate(el => el.getBoundingClientRect().height);
  await page.evaluate(() => {
    const root = document.querySelector('#web-inspector-host-v1').shadowRoot;
    const win = root.querySelector('.wi');
    const title = root.querySelector('.title');
    const button = root.querySelector('[data-action="collapse"]');
    window.__dockCollapseFrames = [];
    window.__dockCollapseDone = false;
    button.addEventListener('click', () => {
      const start = performance.now();
      const sample = () => {
        const v = window.visualViewport;
        const top = v?.offsetTop || 0, bottom = top + (v?.height || innerHeight);
        const wr = win.getBoundingClientRect(), tr = title.getBoundingClientRect(), br = button.getBoundingClientRect();
        window.__dockCollapseFrames.push({
          ms: Math.round(performance.now() - start),
          windowTop: wr.top, windowBottom: wr.bottom, windowHeight: wr.height,
          titleTop: tr.top, buttonTop: br.top, buttonBottom: br.bottom, viewportTop: top, viewportBottom: bottom,
          visibleTitleHeight: Math.max(0, Math.min(tr.bottom, wr.bottom, bottom) - Math.max(tr.top, wr.top, top)),
        });
        if (performance.now() - start < 300) requestAnimationFrame(sample);
        else window.__dockCollapseDone = true;
      };
      requestAnimationFrame(sample);
    }, { once: true });
  });
  const button = inspector.locator('[data-action="collapse"]');
  if (mobile) await button.tap(); else await button.click();
  await page.waitForFunction(() => window.__dockCollapseDone === true);
  const frames = await page.evaluate(() => window.__dockCollapseFrames);
  assert.ok(frames.some(frame => frame.windowHeight > 45 && frame.windowHeight < initialHeight - 1),
    'the test must observe the non-reduced-motion collapse animation');
  const clipped = frames.find(frame => frame.visibleTitleHeight < 42 ||
    frame.buttonTop < frame.viewportTop || frame.buttonBottom > frame.viewportBottom ||
    frame.buttonTop < frame.windowTop || frame.buttonBottom > frame.windowBottom);
  assert.equal(clipped, undefined, `the title and expand button must stay visible throughout collapse: ${JSON.stringify(clipped)}`);
}

for (const mobile of [false, true]) {
  test(`top-docked collapse keeps the title reachable during animation and after restoring (${mobile ? 'touch' : 'desktop'})`, async t => {
    const { page, inspector } = await fixture(t, { mobile });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const viewport = page.viewportSize();
    const title = await inspector.locator('.title').boundingBox();
    const start = { x: title.x + 110, y: title.y + 20 };
    const target = { x: viewport.width / 2, y: 2 };
    if (mobile) {
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: points.map(({ x, y }) => ({ x, y, id: 1 })),
      });
      await touch('touchStart', [start]);
      await touch('touchMove', [target]);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.ghost')).display === 'block');
      await touch('touchEnd', []);
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 6 });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.ghost')).display === 'block');
      await page.mouse.up();
    }
    assert.equal(await page.evaluate(() => window.__webInspectorInstanceV1.state.dock), 'top');
    await waitForWindowAnimations(page);
    await captureCollapseFrames(page, inspector, mobile);
    await assertCollapseState(inspector, true);
    await assertReopenState(page, inspector, false);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('webInspector.preferences.v1')));
    assert.equal(stored.dock, 'top');
    assert.equal(stored.collapsed, true);

    // A persisted collapsed top dock must initialize on-screen, not off the top edge.
    await page.evaluate(() => window.__webInspectorInstanceV1.destroy());
    await page.evaluate(source => (0, eval)(source), script);
    await waitForWindowAnimations(page);
    await assertCollapseState(inspector, true);
    await assertReopenState(page, inspector, false);
    const restored = await inspector.locator('.title').boundingBox();
    assert.ok(restored.y >= 0 && restored.y + restored.height <= viewport.height);
    if (mobile) await inspector.locator('[data-action="collapse"]').tap();
    else await inspector.locator('[data-action="collapse"]').click();
    await waitForWindowAnimations(page);
    await assertCollapseState(inspector, false);
    assert.equal(await page.evaluate(() => window.__webInspectorInstanceV1.state.dock), 'top');
    const expanded = await inspector.locator('.title').boundingBox();
    assert.ok(expanded.y >= 0 && expanded.y + expanded.height <= viewport.height);
  });
}

test('bottom-docked collapse keeps the title reachable throughout its animation', async t => {
  const { page, inspector } = await fixture(t);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    const app = window.__webInspectorInstanceV1;
    app.state.dock = 'bottom'; app.open();
  });
  await waitForWindowAnimations(page);
  await captureCollapseFrames(page, inspector, false);
  await assertCollapseState(inspector, true);
  await assertReopenState(page, inspector, false);
  const rect = await inspector.locator('.wi').boundingBox();
  assert.equal(rect.y + rect.height, page.viewportSize().height);
});

test('a top-docked title stays in a shifted mobile visual viewport when collapsed', async t => {
  const { page, inspector } = await fixture(t, { mobile: true });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const preferredHeight = await page.evaluate(() => {
    const v = window.visualViewport;
    Object.defineProperty(v, 'offsetTop', { configurable: true, value: 190 });
    Object.defineProperty(v, 'height', { configurable: true, value: 360 });
    const app = window.__webInspectorInstanceV1;
    app.state.dock = 'top'; app.open();
    v.dispatchEvent(new Event('resize'));
    return app.state.height;
  });
  await waitForWindowAnimations(page);
  await captureCollapseFrames(page, inspector, true);
  assert.equal(await page.evaluate(() => window.__webInspectorInstanceV1.state.height), preferredHeight,
    'the temporary viewport must not overwrite the preferred height');
  await page.evaluate(() => {
    const v = window.visualViewport;
    delete v.offsetTop; delete v.height;
    v.dispatchEvent(new Event('resize'));
  });
  await waitForWindowAnimations(page);
  const restored = await inspector.locator('.title').boundingBox();
  assert.ok(restored.y >= 0 && restored.y + restored.height <= page.viewportSize().height);
  await inspector.locator('[data-action="collapse"]').tap();
  await waitForWindowAnimations(page);
  await assertCollapseState(inspector, false);
});
