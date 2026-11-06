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

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body>
  <main id="main"><section class="cards"><article id="card" class="card product" data-sku="SKU-1">Hello <b>world</b> again</article></section></main>
  ${Array.from({ length: 40 }, (_, i) => `<p id="filler-${i}">filler ${i}</p>`).join('')}</body></html>`;

async function fixture(t, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1000, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce', ...(options.mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://layout.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  return { page, inspector: page.locator('#web-inspector-host-v1') };
}
async function select(inspector, query) {
  await inspector.locator('#element-filter').fill(query);
  await inspector.locator('#element-filter').press('Enter');
}
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const width = locator => locator.evaluate(el => el.getBoundingClientRect().width);

test('details appear only when an element is selected, and close with ✕ or Esc', async t => {
  const { page, inspector } = await fixture(t);
  const detail = inspector.locator('.detailpane'), hint = inspector.locator('.tree-hint');
  assert.ok(!(await detail.isVisible()));
  assert.ok(await hint.isVisible());
  const full = await width(inspector.locator('.columns'));
  assert.ok(Math.abs(await width(inspector.locator('.treepane')) - full) < 2, 'the tree uses the full width');

  await select(inspector, 'id=card');
  assert.ok(await detail.isVisible());
  assert.ok(!(await hint.isVisible()));
  await inspector.locator('[data-action="close-details"]').click();
  assert.ok(!(await detail.isVisible()));
  assert.equal(await inspector.locator('.tree-row.selected').count(), 0);

  await select(inspector, 'id=card');
  await inspector.locator('.tree-row.selected').click();
  await page.keyboard.press('Escape');
  assert.ok(!(await detail.isVisible()), 'Esc closes the details');

  await select(inspector, 'id=card');
  await inspector.locator('.attrtable .cell.value').first().focus();
  await page.keyboard.press('Escape');
  assert.ok(await detail.isVisible(), 'Esc inside a field only undoes that field');
});

test('the breadcrumb shows the path and selects ancestors', async t => {
  const { inspector } = await fixture(t);
  await select(inspector, 'id=card');
  assert.deepEqual(await inspector.locator('#crumbs .crumb').allTextContents(), ['html', 'body', 'main#main', 'section.cards', 'article#card.card.product']);
  assert.equal(await inspector.locator('#selected-label').textContent(), 'article#card.card.product');
  await inspector.locator('#crumbs .crumb', { hasText: 'section.cards' }).click();
  assert.equal(await inspector.locator('#selected-label').textContent(), 'section.cards');
  assert.match(await inspector.locator('.tree-row.selected').textContent(), /<section>/);
});

test('the divider resizes the panels, resets on double-click, and is remembered', async t => {
  const { page, inspector } = await fixture(t);
  await select(inspector, 'id=card');
  const columns = await inspector.locator('.columns').boundingBox();
  const splitter = await inspector.locator('.splitter').boundingBox();
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(columns.x + columns.width * 0.25, splitter.y + splitter.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs(await width(inspector.locator('.treepane')) - columns.width * 0.25) < 3);
  assert.ok(Math.abs((await saved(page)).treeSplit - 0.25) < 0.01);

  await inspector.locator('.splitter').focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(Math.abs((await saved(page)).treeSplit - 0.27) < 0.01, 'arrow keys move the divider');

  await page.evaluate(() => window.__webInspectorInstanceV1.destroy());
  await page.evaluate(source => (0, eval)(source), script);
  await select(inspector, 'id=card');
  assert.ok(Math.abs(await width(inspector.locator('.treepane')) - columns.width * 0.27) < 3, 'restored after reload');

  await inspector.locator('.splitter').dblclick();
  assert.equal((await saved(page)).treeSplit, 0.42);
});

test('narrow inspectors stack the panels with a horizontal divider', async t => {
  const { inspector } = await fixture(t, { viewport: { width: 390, height: 760 }, mobile: true });
  await select(inspector, 'id=card');
  assert.equal(await inspector.locator('.columns.stacked').count(), 1);
  assert.equal(await inspector.locator('.splitter').getAttribute('aria-orientation'), 'horizontal');
  const tree = await inspector.locator('.treepane').boundingBox(), detail = await inspector.locator('.detailpane').boundingBox();
  assert.ok(detail.y >= tree.y + tree.height - 1, 'details sit below the tree');
  const row = await inspector.locator('.tree-row.selected').boundingBox();
  assert.ok(row.y >= tree.y && row.y + row.height <= tree.y + tree.height, 'the selected row is visible in the shorter tree');
  assert.ok(await inspector.locator('#toolbar [data-action="pick"]').isVisible(), 'Pick stays reachable');
  const pick = await inspector.locator('#toolbar [data-action="pick"]').boundingBox(), bar = await inspector.locator('#toolbar').boundingBox();
  assert.ok(pick.x + pick.width <= bar.x + bar.width, 'Pick is not cut off');
});

test('sections collapse and expand, and the choice is remembered', async t => {
  const { page, inspector } = await fixture(t);
  await select(inspector, 'id=card');
  const text = inspector.locator('.dsection[data-section="text"]');
  await text.locator('.dsection-head').click();
  assert.ok(!(await text.locator('.dsection-body').isVisible()));
  assert.equal(await text.locator('.dsection-head').getAttribute('aria-expanded'), 'false');
  assert.deepEqual((await saved(page)).collapsedSections, ['text']);
  await select(inspector, 'id=main');
  assert.ok(!(await text.locator('.dsection-body').isVisible()), 'stays collapsed for the next element');
  await text.locator('.dsection-head').click();
  assert.ok(await text.locator('.dsection-body').isVisible());
  assert.deepEqual((await saved(page)).collapsedSections, []);
});

test('attributes are edited in a table, with a + button to add rows', async t => {
  const { page, inspector } = await fixture(t);
  await select(inspector, 'id=card');
  const card = page.locator('#card');
  const rows = inspector.locator('.attrtable tbody tr');
  assert.deepEqual(await inspector.locator('.attrtable th').allTextContents(), ['Name', 'Value', 'Remove']);
  assert.equal(await rows.count(), 3);
  assert.equal(await inspector.locator('.dsection[data-section="attributes"] .count').textContent(), '(3)');

  // Edit a value: applied on Enter.
  await inspector.locator('[aria-label="Attribute value data-sku"]').fill('SKU-2');
  await inspector.locator('[aria-label="Attribute value data-sku"]').press('Enter');
  assert.equal(await card.getAttribute('data-sku'), 'SKU-2');

  // Rename: applied when the field is left.
  await inspector.locator('[aria-label="Attribute name data-sku"]').fill('data-code');
  await inspector.locator('[aria-label="Attribute name data-sku"]').blur();
  assert.equal(await card.getAttribute('data-code'), 'SKU-2');
  assert.equal(await card.getAttribute('data-sku'), null);

  // Invalid and duplicate names are refused and marked.
  await inspector.locator('[aria-label="Attribute name data-code"]').fill('bad name');
  await inspector.locator('[aria-label="Attribute name data-code"]').press('Enter');
  assert.equal(await inspector.locator('.cell.invalid').count(), 1);
  assert.equal(await inspector.locator('#status-text').textContent(), 'Invalid attribute name: bad name');
  await page.keyboard.press('Escape');
  assert.equal(await inspector.locator('[aria-label="Attribute name data-code"]').inputValue(), 'data-code', 'Esc restores the name');

  // The centered + adds a row; it is applied once it has a name.
  const add = inspector.locator('.addrow');
  const [addBox, tableBox] = [await add.boundingBox(), await inspector.locator('.attrtable').boundingBox()];
  assert.ok(Math.abs((addBox.x + addBox.width / 2) - (tableBox.x + tableBox.width / 2)) < 2, 'the + is centered under the table');
  await add.click();
  assert.equal(await rows.count(), 4);
  await page.keyboard.type('title');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Product card');
  await page.keyboard.press('Enter');
  assert.equal(await card.getAttribute('title'), 'Product card');
  assert.equal(await inspector.locator('.dsection[data-section="attributes"] .count').textContent(), '(4)');

  // Remove a row.
  await inspector.locator('[aria-label="Remove attribute id"]').click();
  assert.equal(await page.evaluate(() => document.querySelector('article').hasAttribute('id')), false);
  assert.equal(await rows.count(), 3);
});

test('text content is a multiline field that saves on leaving or Ctrl+Enter', async t => {
  const { page, inspector } = await fixture(t);
  await select(inspector, 'id=main');
  const area = inspector.locator('textarea[aria-label="Direct text content"]');
  const before = await area.evaluate(el => el.getBoundingClientRect().height);
  await area.fill('line one\nline two\nline three\nline four');
  const grown = await area.evaluate(el => el.getBoundingClientRect().height);
  assert.ok(grown > before + 30, `the field grows with its text (${before} -> ${grown})`);
  await area.press('Control+Enter');
  assert.equal(await page.evaluate(() => document.getElementById('main').firstChild.nodeValue), 'line one\nline two\nline three\nline four');
  assert.equal(await inspector.locator('#status-text').textContent(), 'Text updated');
  await area.press('End');
  await page.keyboard.type(' (edited)');
  await page.keyboard.press('Escape');
  assert.equal(await area.inputValue(), 'line one\nline two\nline three\nline four', 'Esc undoes unsaved typing');
});
