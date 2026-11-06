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

const html = `<!doctype html><html lang="en"><head><link rel="icon" href="data:,"><title>A &amp; B</title><style>
      body { margin: 0 }
    </style></head><body><ul><li><a href="/x?a=1&b=2">One</a></li></ul><p>Text with <b>bold</b> words</p><pre>  keep
    spacing</pre><img src="x.png" alt=""></body></html>`;

async function fixture(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://source.test/');
  await page.evaluate(() => { localStorage.setItem('settings', '{"a":1,"b":[1,2]}'); });
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  const inspector = page.locator('#web-inspector-host-v1');
  await inspector.locator('[data-tab="source"]').click();
  return { page, inspector };
}

test('Beautify indents the reconstructed HTML and toggles back', async t => {
  const { inspector } = await fixture(t);
  const view = inspector.locator('#sourceview');
  const beautify = inspector.locator('[data-action="beautify-source"]');
  const raw = await view.textContent();
  assert.equal(await beautify.getAttribute('aria-pressed'), 'false');

  await beautify.click();
  assert.equal(await beautify.getAttribute('aria-pressed'), 'true');
  const pretty = await view.textContent();
  assert.ok(pretty.includes([
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <link rel="icon" href="data:,">',
    '    <title>A &amp; B</title>',
    '    <style>',
    '      body { margin: 0 }',
    '    </style>',
    '  </head>',
    '  <body>',
    '    <ul>',
    '      <li><a href="/x?a=1&amp;b=2">One</a></li>',
    '    </ul>',
    '    <p>Text with <b>bold</b> words</p>',
    '    <pre>  keep\n    spacing</pre>',
    '    <img src="x.png" alt>',
    '  </body>',
    '</html>',
  ].join('\n')), pretty);
  assert.ok(!pretty.includes('web-inspector'));

  await beautify.click();
  assert.equal(await view.textContent(), raw);
});

test('Export downloads the source exactly as shown', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('[data-action="beautify-source"]').click();
  const shown = await inspector.locator('#sourceview').textContent();
  const [download] = await Promise.all([page.waitForEvent('download'), inspector.locator('[data-action="export-source"]').click()]);
  assert.equal(download.suggestedFilename(), 'source.test-formatted.html');
  assert.equal(fs.readFileSync(await download.path(), 'utf8'), shown);
  assert.equal(await inspector.locator('#status-text').textContent(), 'Exported source.test-formatted.html');
  assert.equal(page.url(), 'https://source.test/');
});

test('resource views export as their own file and cannot be beautified', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('[data-tab="resources"]').click();
  await inspector.locator('.resrow', { hasText: 'settings' }).click();
  await inspector.locator('[data-action="resource-view"]').click();
  assert.ok(await inspector.locator('[data-action="beautify-source"]').isDisabled());
  const [download] = await Promise.all([page.waitForEvent('download'), inspector.locator('[data-action="export-source"]').click()]);
  assert.equal(download.suggestedFilename(), 'settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(), 'utf8')), { a: 1, b: [1, 2] });
});
