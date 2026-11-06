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

// 30 levels of nesting pushes the deepest rows far past the narrow tree pane.
const nested = '<div class="level">'.repeat(30) + '<span id="deepest" class="leaf-node">deep</span>' + '</div>'.repeat(30);

test('deeply nested tree rows can be scrolled into view horizontally', async t => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body>${nested}</body></html>`,
  }));
  await page.goto('https://tree.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });

  await page.locator('#web-inspector-host-v1 [data-action="expand-all"]').click();
  const result = await page.evaluate(() => {
    const root = window.__webInspectorInstanceV1.host.shadowRoot;
    const tree = root.querySelector('#tree');
    const rows = [...tree.querySelectorAll('.tree-row')];
    const deepest = rows.find(row => row.textContent.includes('#deepest'));
    const tag = deepest.querySelector('.tag');
    tag.scrollIntoView({ block: 'nearest', inline: 'start' });
    const treeRect = tree.getBoundingClientRect(), tagRect = tag.getBoundingClientRect();
    const widths = new Set(rows.map(row => Math.round(row.getBoundingClientRect().width)));
    return {
      overflows: tree.scrollWidth > tree.clientWidth,
      tagVisible: tagRect.left >= treeRect.left && tagRect.right <= treeRect.right,
      tagWidth: tagRect.width,
      uniformWidth: widths.size === 1,
    };
  });
  assert.ok(result.overflows, 'tree should scroll horizontally when rows are deeply indented');
  assert.ok(result.tagWidth > 0, 'deepest tag should not be squashed to zero width');
  assert.ok(result.tagVisible, 'deepest tag should be reachable by scrolling horizontally');
  assert.ok(result.uniformWidth, 'rows should share one width so selection highlights line up');
});

async function largePage(t) {
  let rows = '';
  for (let i = 0; i < 800; i++) rows += `<div id="item-${i}">row ${i}</div>`;
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${rows}</body></html>`,
  }));
  await page.goto('https://large.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  return { page, inspector: page.locator('#web-inspector-host-v1') };
}

const treeIds = inspector => inspector.evaluate(host => [...host.shadowRoot.querySelectorAll('#tree .tree-row .meta')].map(m => m.textContent));
const rowTop = (inspector, id) => inspector.evaluate((host, id) => {
  const tree = host.shadowRoot.querySelector('#tree');
  const meta = [...tree.querySelectorAll('.tree-row .meta')].find(m => m.textContent === id);
  return meta ? meta.closest('.tree-row').getBoundingClientRect().top - tree.getBoundingClientRect().top : null;
}, id);

test('large trees draw a window of rows with buttons to page through the rest', async t => {
  const { inspector } = await largePage(t);
  let ids = await treeIds(inspector);
  assert.equal(ids.length, 500);
  const later = inspector.locator('[data-action="tree-later"]');
  assert.equal(await later.textContent(), 'Show 250 more (303 below)');
  assert.equal(await inspector.locator('[data-action="tree-earlier"]').count(), 0);

  const lastId = ids[ids.length - 1];
  await later.click();
  ids = await treeIds(inspector);
  assert.equal(ids.length, 500);
  assert.ok(ids.includes('#item-746'));
  assert.ok(await inspector.locator('[data-action="tree-earlier"]').isVisible());
  // The last row before the click stays on screen so reading continues smoothly.
  const top = await rowTop(inspector, lastId);
  const height = await inspector.locator('#tree').evaluate(tree => tree.clientHeight);
  assert.ok(top !== null && top >= 0 && top < height, `anchor row at ${top}`);

  await inspector.locator('[data-action="tree-earlier"]').click();
  ids = await treeIds(inspector);
  assert.equal(ids[0], '');
});

test('selecting an element beyond the drawn rows moves the window to it', async t => {
  const { inspector } = await largePage(t);
  await inspector.locator('#element-filter').fill('row 790');
  await inspector.locator('#element-filter').press('Enter');
  assert.equal(await inspector.locator('#selected-label').textContent(), 'div#item-790');
  const ids = await treeIds(inspector);
  assert.ok(ids.includes('#item-790'));
  const top = await rowTop(inspector, '#item-790');
  const height = await inspector.locator('#tree').evaluate(tree => tree.clientHeight);
  assert.ok(top >= 0 && top < height, `selected row at ${top}`);
  assert.ok(await inspector.locator('[data-action="tree-earlier"]').count());
});
