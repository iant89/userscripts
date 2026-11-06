const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { readZip } = require('./zip.cjs');

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

async function codePage(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = `<!doctype html><html><head><link rel="icon" href="data:,"><script src="/app.js"></script></head><body>
    <form method="post" action="/submit"><button>Send</button></form>
    <script>
      var paramString = "token=abc";
      var casinoURL = "https://ogs-gl.nyxgib.eu/game/?" + String(paramString);
      const lang = 'en';
      const help = "/help/" + lang + "/guide.pdf";
      const theme = \`https://site.test/assets/\${lang}/theme.css\`;
      var random = "https://cdn.site.test/img/" + Math.random() + ".png";
      function makeId() { return 7; }
      fetch("/data/" + makeId() + ".json");
      fetch("/api/save.json", { method: "POST", body: "x" });
      fetch("/api/list.json");
      const ajax = { ajax() {} }; ajax.ajax({ url: "/api/remove.json", type: "DELETE" });
      navigator.sendBeacon("/beacon.gif", "d");
      const home = "https://www.google.com";
      const folder = "https://site.test/about/";
      const report = "https://site.test/files/report.pdf?dl=1";
    </script></body></html>`;
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'https://site.test/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url === 'https://site.test/app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'const api = "https://site.test/v1/config.json"; const xhr = new XMLHttpRequest(); xhr.open("POST", "https://site.test/v1/log.json");' });
    if (url === 'https://ogs-gl.nyxgib.eu/game/?token=abc') return route.abort('accessdenied');
    return route.fulfill({ status: 200, contentType: 'application/json', body: `{"url":"${url}"}` });
  });
  await page.goto('https://site.test/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  const inspector = page.locator('#web-inspector-host-v1');
  await inspector.locator('[data-tab="source"]').click();
  await inspector.locator('[data-action="export-source"]').click();
  await inspector.locator('[data-action="export-all-files"]').click();
  await inspector.locator('[data-export-start]:not([disabled])').waitFor();
  return { page, inspector };
}
const groupUrls = async (inspector, kind) => (await inspector.locator(`.urlgroup[data-kind="${kind}"] .urltext`).allInnerTexts()).map(text => text.split('\n')[0]).sort();

test('Other files in code lists only URLs naming a file, including in fetched scripts', async t => {
  const { inspector } = await codePage(t);
  assert.deepEqual(await groupUrls(inspector, 'other'), [
    'https://site.test/api/list.json', 'https://site.test/files/report.pdf?dl=1', 'https://site.test/v1/config.json',
  ]);
  const all = (await inspector.locator('.urltext').allInnerTexts()).join('\n');
  assert.ok(!all.includes('google.com') && !all.includes('/about/'), all);
});

test('URLs built by expressions are resolved from page values or loaded URLs', async t => {
  const { inspector } = await codePage(t);
  assert.deepEqual(await groupUrls(inspector, 'dynamic'), [
    'https://ogs-gl.nyxgib.eu/game/?token=abc', 'https://site.test/assets/en/theme.css',
    'https://site.test/data/7.json', 'https://site.test/help/en/guide.pdf',
  ]);
  const casino = inspector.locator('.urlrow', { hasText: 'ogs-gl.nyxgib.eu' });
  assert.match(await casino.innerText(), /from "https:\/\/ogs-gl\.nyxgib\.eu\/game\/\?" \+ String\(paramString\) · resolved from values in the page/);
  assert.match(await inspector.locator('.urlrow', { hasText: '/data/7.json' }).innerText(), /matched a URL the page loaded/);
  assert.ok(!(await casino.locator('input').isChecked()));
});

test('non-GET requests and unresolvable expressions are noted, not included', async t => {
  const { page, inspector } = await codePage(t);
  await inspector.locator('details.urlnotes summary').click();
  const notes = await inspector.locator('details.urlnotes .urlrow').allInnerTexts();
  for (const expected of [
    'POST https://site.test/submit (in page source)', 'POST https://site.test/api/save.json (in page source)',
    'DELETE https://site.test/api/remove.json (in page source)', 'POST https://site.test/beacon.gif (in page source)',
    'POST https://site.test/v1/log.json (in app.js)',
    'Built in code, value unknown: "https://cdn.site.test/img/" + Math.random() + ".png" (in page source)',
  ]) assert.ok(notes.some(note => note.startsWith(expected)), `${expected}\n${notes.join('\n')}`);
  const all = (await inspector.locator('.urltext').allInnerTexts()).join('\n');
  for (const url of ['/submit', '/api/save.json', '/api/remove.json', '/beacon.gif', '/v1/log.json']) assert.ok(!all.includes(url), url);

  await inspector.locator('.urlgroup[data-kind="dynamic"] .urlgroup-head input').check();
  const [download] = await Promise.all([page.waitForEvent('download'), inspector.locator('[data-export-start]').click()]);
  const files = readZip(fs.readFileSync(await download.path()));
  assert.equal(files.get('files/site.test/help/en/guide.pdf'), '{"url":"https://site.test/help/en/guide.pdf"}');
  const reportText = files.get('download-report.txt');
  assert.match(reportText, /FAILED {2}https:\/\/ogs-gl\.nyxgib\.eu\/game\/\?token=abc/);
  assert.match(reportText, /Not included:\n {2}POST https:\/\/site\.test\/submit/);
});
