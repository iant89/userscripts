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

let filler = '';
for (let i = 0; i < 120; i++) filler += `<div class="row-${i}"><span>a</span><span>b</span></div>`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head>
<body><p id="mixed">Hello <b>world</b> again</p><section id="wrap"><p id="needle">needle text</p></section>${filler}<i id="last">the end</i></body></html>`;

async function fixture(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://editing.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  return { page, inspector: page.locator('#web-inspector-host-v1') };
}

async function search(inspector, query) {
  await inspector.locator('#element-filter').fill(query);
  await inspector.locator('#element-filter').press('Enter');
}

test('Enter searches elements, and the query survives toolbar rebuilds', async t => {
  const { inspector } = await fixture(t);
  await search(inspector, 'needle');
  assert.equal(await inspector.locator('#selected-label').textContent(), 'p#needle');
  await inspector.locator('[data-tab="console"]').click();
  await inspector.locator('[data-tab="elements"]').click();
  assert.equal(await inspector.locator('#element-filter').inputValue(), 'needle');
});

test('element search matches an element by its own text, not its descendants', async t => {
  const { inspector } = await fixture(t);
  await search(inspector, 'needle text');
  assert.equal(await inspector.locator('#selected-label').textContent(), 'p#needle');
  assert.equal(await inspector.locator('#status-text').textContent(), 'Search result 1 of 1');
});

test('element search can find the root html element', async t => {
  const { inspector } = await fixture(t);
  await search(inspector, 'html');
  assert.equal(await inspector.locator('#selected-label').textContent(), 'html');
});

test('selecting an element scrolls its tree row into view', async t => {
  const { inspector } = await fixture(t);
  await search(inspector, 'the end');
  assert.equal(await inspector.locator('#selected-label').textContent(), 'i#last');
  const visible = await inspector.evaluate(host => {
    const tree = host.shadowRoot.querySelector('#tree');
    const row = tree.querySelector('.tree-row.selected').getBoundingClientRect(), view = tree.getBoundingClientRect();
    return row.top >= view.top && row.bottom <= view.bottom;
  });
  assert.ok(visible);
});

test('applying text content keeps text around child elements in place', async t => {
  const { page, inspector } = await fixture(t);
  await search(inspector, 'hello');
  // Leaving a field unchanged changes nothing.
  await inspector.locator('textarea[aria-label="Direct text content 1"]').focus();
  await inspector.locator('textarea[aria-label="Direct text content 1"]').blur();
  assert.equal(await page.locator('#mixed').evaluate(el => el.innerHTML), 'Hello <b>world</b> again');
  await inspector.locator('textarea[aria-label="Direct text content 1"]').fill('Hi ');
  await inspector.locator('textarea[aria-label="Direct text content 2"]').fill(' again!');
  await inspector.locator('textarea[aria-label="Direct text content 2"]').blur();
  assert.equal(await page.locator('#mixed').evaluate(el => el.innerHTML), 'Hi <b>world</b> again!');
});

test('body and head can be deleted and restored; html cannot', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('.tree-row', { hasText: '<body>' }).click();
  await inspector.locator('[data-action="delete-element"]').click();
  assert.equal(await page.evaluate(() => document.body), null);
  await inspector.locator('[data-action="undo-delete"]').click();
  assert.equal(await page.evaluate(() => document.body?.localName), 'body');
  await inspector.locator('.tree-row', { hasText: '<html>' }).click();
  await inspector.locator('[data-action="delete-element"]').click();
  assert.equal(await inspector.locator('#status-text').textContent(), 'Cannot remove an element that contains the inspector');
});

test('inserting beside the html element is refused without throwing', async t => {
  const { page, inspector } = await fixture(t);
  const messages = [];
  page.on('dialog', dialog => messages.push(dialog.message()));
  await inspector.locator('.tree-row', { hasText: '<html>' }).click();
  await inspector.locator('[data-action="add-element"]').click();
  await inspector.locator('[data-f="where"]').selectOption('before');
  await inspector.locator('[data-create]').click();
  assert.match(messages[0], /cannot be inserted before/);
  assert.equal(await inspector.locator('.dialog').count(), 1);
});

test('Find in source runs on Enter and steps through matches', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('[data-tab="source"]').click();
  await inspector.locator('#source-search').fill('needle');
  await inspector.locator('#source-search').press('Enter');
  assert.equal(await page.evaluate(() => String(getSelection())), 'needle');
  const first = await inspector.locator('#status-text').textContent();
  await inspector.locator('#source-search').press('Enter');
  const second = await inspector.locator('#status-text').textContent();
  assert.match(first, /^Match 1 of [2-9]/);
  assert.match(second, /^Match 2 of [2-9]/);
});

test('executed commands stay echoed in the console', async t => {
  const { inspector } = await fixture(t);
  await inspector.locator('[data-tab="console"]').click();
  await inspector.locator('#command').fill('6*7');
  await inspector.locator('#command').press('Enter');
  await inspector.locator('#consolelog').getByText('42').waitFor();
  assert.match(await inspector.locator('#consolelog').innerText(), />\s*6\*7[\s\S]*42/);
});
