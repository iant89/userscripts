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

async function exportSourceFile(inspector) {
  await inspector.locator('[data-action="export-source"]').click();
  await inspector.locator('[data-action="export-source-file"]').click();
}

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
  const [download] = await Promise.all([page.waitForEvent('download'), exportSourceFile(inspector)]);
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
  const [download] = await Promise.all([page.waitForEvent('download'), exportSourceFile(inspector)]);
  assert.equal(download.suggestedFilename(), 'settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(), 'utf8')), { a: 1, b: [1, 2] });
});

// Read a stored ZIP (the format the inspector writes) and check each CRC.
function readZip(buffer) {
  const files = new Map();
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xFFFFFFFF; for (const b of bytes) c = table[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18), nameLength = buffer.readUInt16LE(at + 26), extra = buffer.readUInt16LE(at + 28);
    const name = buffer.toString('utf8', at + 30, at + 30 + nameLength);
    const data = buffer.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
    assert.equal(crc(data), buffer.readUInt32LE(at + 14), `CRC of ${name}`);
    files.set(name, data.toString('utf8'));
    at += 30 + nameLength + extra + size;
  }
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.size);
  return files;
}

async function sitePage(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const assets = {
    'https://site.test/style.css': ['text/css', 'body { background: url("/bg.png") }'],
    'https://site.test/app.js': ['text/javascript', 'window.loaded = true;'],
    'https://site.test/img/logo.png': ['image/png', 'PNG-1x'],
    'https://site.test/img/logo@2x.png': ['image/png', 'PNG-2x'],
    'https://site.test/bg.png': ['image/png', 'BG'],
    'https://site.test/data.json?v=2': ['application/json', '{"v":2}'],
  };
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'https://site.test/') return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head>
      <link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><script src="app.js"></script></head>
      <body><img src="/img/logo.png" srcset="/img/logo.png 1x, /img/logo@2x.png 2x" alt="">
      <div style="background-image: url('/bg.png')"></div><a href="/about#team">About</a>
      <img src="https://cdn.test/no-cors.png" alt=""><img src="/missing.png" alt="">
      <script>const api = "https://site.test/data.json?v=2";</script></body></html>` });
    if (assets[url]) return route.fulfill({ status: 200, contentType: assets[url][0], body: assets[url][1] });
    // Playwright's fulfilled responses bypass CORS, so model a blocked
    // cross-origin file the way the page sees it: as a failed fetch.
    if (url === 'https://cdn.test/no-cors.png') return route.abort('accessdenied');
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto('https://site.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  const inspector = page.locator('#web-inspector-host-v1');
  await inspector.locator('[data-tab="source"]').click();
  await inspector.locator('[data-action="export-source"]').click();
  return { page, inspector };
}

test('Export opens a menu with Source and All files', async t => {
  const { page, inspector } = await sitePage(t);
  const button = inspector.locator('[data-action="export-source"]');
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await inspector.locator('[role="menuitem"] span:first-child').allTextContents(), ['Source', 'All files…']);
  await page.keyboard.press('Escape');
  assert.equal(await inspector.locator('[role="menu"]').count(), 0);
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  await button.click();
  await page.mouse.click(5, 5);
  assert.equal(await inspector.locator('[role="menu"]').count(), 0);
});

test('All files lists the URLs in the source, grouped, with resources selected', async t => {
  const { inspector } = await sitePage(t);
  await inspector.locator('[data-action="export-all-files"]').click();
  const group = kind => inspector.locator(`.urlgroup[data-kind="${kind}"] .urlrow`);
  const urls = async kind => (await group(kind).allTextContents()).sort();
  assert.deepEqual(await urls('resource'), [
    'https://cdn.test/no-cors.png', 'https://site.test/app.js', 'https://site.test/bg.png', 'https://site.test/img/logo.png',
    'https://site.test/img/logo@2x.png', 'https://site.test/missing.png', 'https://site.test/style.css',
  ]);
  assert.deepEqual(await urls('link'), ['https://site.test/about']);
  assert.deepEqual(await urls('other'), ['https://site.test/data.json?v=2']);
  for (const box of await group('resource').locator('input').all()) assert.ok(await box.isChecked());
  for (const box of await group('link').locator('input').all()) assert.ok(!(await box.isChecked()));
  assert.equal(await inspector.locator('[data-export-start]').textContent(), 'Download ZIP (7 files)');
});

test('All files saves the source and fetched files in a ZIP with a report', async t => {
  const { page, inspector } = await sitePage(t);
  await inspector.locator('[data-action="export-all-files"]').click();
  await inspector.locator('.urlrow', { hasText: 'data.json' }).locator('input').check();
  const [download] = await Promise.all([page.waitForEvent('download'), inspector.locator('[data-export-start]').click()]);
  assert.equal(download.suggestedFilename(), 'site.test-files.zip');
  const files = readZip(fs.readFileSync(await download.path()));
  assert.ok(files.get('site.test.html').includes('<link rel="stylesheet" href="/style.css">'));
  assert.equal(files.get('files/site.test/style.css'), 'body { background: url("/bg.png") }');
  assert.equal(files.get('files/site.test/app.js'), 'window.loaded = true;');
  assert.equal(files.get('files/site.test/img/logo@2x.png'), 'PNG-2x');
  assert.equal(files.get('files/site.test/bg.png'), 'BG');
  assert.equal([...files.keys()].filter(name => name.startsWith('files/site.test/data_')).map(name => files.get(name))[0], '{"v":2}');
  const report = files.get('download-report.txt');
  assert.match(report, /Files: 6 saved, 2 failed/);
  assert.match(report, /FAILED {2}https:\/\/cdn\.test\/no-cors\.png\n {8}blocked \(cross-origin or network error\)/);
  assert.match(report, /FAILED {2}https:\/\/site\.test\/missing\.png\n {8}HTTP 404/);
  assert.equal(await inspector.locator('.dialog').count(), 0);
  assert.equal(await inspector.locator('#status-text').textContent(), 'Exported site.test-files.zip: 6 files saved, 2 failed (see download-report.txt)');
});
