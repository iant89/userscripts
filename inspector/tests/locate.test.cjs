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

// The inspector opens at x 18-738, y 70-590 in a 1000x700 viewport.
const html = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
  body { margin: 0; height: 3200px } div { position: absolute; width: 100px; height: 40px; background: #ddd }
  #far-away { top: 2600px; left: 850px } #under-panel { top: 200px; left: 100px } #corner { top: 10px; left: 860px }
  #gone { display: none }
</style></head><body><div id="far-away"></div><div id="under-panel"></div><div id="corner"></div><div id="gone"></div></body></html>`;

async function fixture(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://locate.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  return { page, inspector: page.locator('#web-inspector-host-v1') };
}

async function locate(inspector, id) {
  await inspector.locator('#element-filter').fill(`id=${id}`);
  await inspector.locator('#element-filter').press('Enter');
  assert.equal(await inspector.locator('#selected-label').textContent(), `div#${id}`);
  await inspector.locator('[data-action="locate-element"]').click();
}
const box = inspector => inspector.locator('.locatebox');
const geometry = (page, id) => page.evaluate(id => {
  const r = document.getElementById(id).getBoundingClientRect();
  const b = document.querySelector('#web-inspector-host-v1').shadowRoot.querySelector('.locatebox').getBoundingClientRect();
  return { el: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } };
}, id);
const opacity = inspector => inspector.evaluate(host => getComputedStyle(host.shadowRoot.querySelector('.wi')).opacity);

test('an element out of view is scrolled to, then highlighted for a few seconds', async t => {
  const { page, inspector } = await fixture(t);
  await locate(inspector, 'far-away');
  await box(inspector).waitFor({ state: 'visible' });
  assert.ok(await page.evaluate(() => scrollY) > 1500);
  const { el, box: b } = await geometry(page, 'far-away');
  assert.ok(el.top >= 0 && el.bottom <= 700, `element at ${el.top}-${el.bottom}`);
  assert.deepEqual([b.left, b.top, b.right, b.bottom].map(Math.round), [el.left - 4, el.top - 4, el.right + 4, el.bottom + 4].map(Math.round));
  assert.equal(await inspector.locator('#status-text').textContent(), 'Located div#far-away (scrolled into view)');
  assert.ok(!(await inspector.locator('.wi.see-through').count()), 'not behind the inspector, so it is not faded');
  await box(inspector).waitFor({ state: 'hidden', timeout: 4000 });
});

test('an element behind the inspector fades the inspector while highlighted', async t => {
  const { page, inspector } = await fixture(t, { reducedMotion: 'reduce' });
  await locate(inspector, 'under-panel');
  await box(inspector).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => scrollY), 0, 'already in view, so the page does not scroll');
  assert.equal(await opacity(inspector), '0.5');
  assert.match(await inspector.locator('#status-text').textContent(), /inspector faded while it is highlighted/);
  await box(inspector).waitFor({ state: 'hidden', timeout: 4000 });
  assert.equal(await inspector.locator('.wi.see-through').count(), 0);
  assert.equal(await opacity(inspector), '1');
});

test('a visible element clear of the inspector is highlighted in place', async t => {
  const { page, inspector } = await fixture(t, { reducedMotion: 'reduce' });
  await locate(inspector, 'corner');
  await box(inspector).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.equal(await opacity(inspector), '1');
  assert.equal(await inspector.locator('#status-text').textContent(), 'Located div#corner');
  await page.waitForTimeout(100);
  assert.ok(!(await inspector.locator('.selectionbox').isVisible()), 'the selection outline gives way to the locate flash');
  await box(inspector).waitFor({ state: 'hidden', timeout: 4000 });
  await inspector.locator('.selectionbox').waitFor({ state: 'visible' });
});

test('an element that is not rendered reports that instead', async t => {
  const { inspector } = await fixture(t);
  await locate(inspector, 'gone');
  assert.equal(await inspector.locator('#status-text').textContent(), 'div#gone is not rendered (for example display: none), so it has no position on the page');
  assert.ok(!(await box(inspector).isVisible()));
});

test('selecting another element ends the highlight', async t => {
  const { inspector } = await fixture(t, { reducedMotion: 'reduce' });
  await locate(inspector, 'under-panel');
  await box(inspector).waitFor({ state: 'visible' });
  await inspector.locator('#element-filter').fill('id=corner');
  await inspector.locator('#element-filter').press('Enter');
  assert.ok(!(await box(inspector).isVisible()));
  assert.equal(await inspector.locator('.wi.see-through').count(), 0);
});
