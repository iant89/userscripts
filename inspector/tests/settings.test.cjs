const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { readZip, readZipBuffers } = require('./zip.cjs');

const script = fs.readFileSync(path.join(__dirname, '..', 'Web Inspector.user.js'), 'utf8');
const storageKey = 'webInspector.preferences.v1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
let browser;

before(async () => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { await browser?.close(); });

const html = `<!doctype html><html><head><link rel="icon" href="data:,">
  <link rel="stylesheet" href="/css/site.css"><base href="https://site.test/"></head>
  <body><p id="styled">Styled</p>
  <img id="logo" src="/img/logo.png?v=3" srcset="/img/logo.png?v=3 1x, /img/logo@2x.png 2x" alt="">
  <div id="banner" style="background-image: url('/img/banner.png'); width: 1px; height: 1px"></div>
  <a id="about" href="/about">About</a><a id="top" href="#top">Top</a><img id="dyn" alt="">
  <script>var imageName = "bg"; const route = "/users/:id"; const about = "/about";
    document.getElementById('dyn').src = "/img/" + imageName + ".png";</script>
  <script src="/js/app.js"></script></body></html>`;
const assets = {
  'https://site.test/css/site.css': ['text/css', '#styled { color: rgb(1, 2, 3) } body { background: url("../img/bg.png") }'],
  'https://site.test/img/logo.png?v=3': ['image/png', png],
  'https://site.test/img/logo@2x.png': ['image/png', png],
  'https://site.test/img/banner.png': ['image/png', png],
  'https://site.test/img/bg.png': ['image/png', png],
  'https://site.test/js/app.js': ['text/javascript', 'const list = "/data/list.json"; const spa = "/about";'],
  'https://site.test/data/list.json': ['application/json', '[1,2]'],
};

async function fixture(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'https://site.test/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (assets[url]) return route.fulfill({ status: 200, contentType: assets[url][0], body: assets[url][1] });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://site.test/');
  await page.evaluate(source => (0, eval)(source), script);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  return { page, context, inspector: page.locator('#web-inspector-host-v1') };
}

async function setSettings(inspector, values) {
  await inspector.locator('[data-tab="settings"]').click();
  for (const [key, on] of Object.entries(values)) await inspector.locator(`[data-setting="${key}"]`).setChecked(on);
}

async function exportAll(page, inspector) {
  await inspector.locator('[data-tab="source"]').click();
  await inspector.locator('[data-action="export-source"]').click();
  await inspector.locator('[data-action="export-all-files"]').click();
  await inspector.locator('[data-export-start]:not([disabled])').waitFor();
  await inspector.locator('.urlrow', { hasText: '/data/list.json' }).locator('input').check();
  const [download] = await Promise.all([page.waitForEvent('download'), inspector.locator('[data-export-start]').click()]);
  return fs.readFileSync(await download.path());
}

test('the Settings tab shows both options, off by default, and saves changes', async t => {
  const { page, inspector } = await fixture(t);
  await inspector.locator('[data-tab="settings"]').click();
  assert.equal(await inspector.locator('[data-tab="settings"]').getAttribute('aria-selected'), 'true');
  const rewrite = inspector.locator('[data-setting="rewriteUrls"]'), strip = inspector.locator('[data-setting="stripQuery"]');
  assert.ok(!(await rewrite.isChecked()) && !(await strip.isChecked()));
  await inspector.locator('.setting', { hasText: 'Rewrite URLs to the saved copies' }).click();
  assert.ok(await rewrite.isChecked());
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(saved.rewriteUrls, true);
  assert.equal(saved.stripQuery, false);
  assert.equal(saved.activeTab, 'settings');

  // A fresh instance (as after navigation) restores the tab and the options.
  await page.evaluate(() => window.__webInspectorInstanceV1.destroy());
  await page.evaluate(source => (0, eval)(source), script);
  assert.equal(await inspector.locator('[data-tab="settings"]').getAttribute('aria-selected'), 'true');
  assert.ok(await rewrite.isChecked());
  assert.ok(!(await strip.isChecked()));
});

test('without the settings, the saved source and names are unchanged', async t => {
  const { page, inspector } = await fixture(t);
  const files = readZip(await exportAll(page, inspector));
  const source = files.get('site.test.html');
  assert.ok(source.includes('<link rel="stylesheet" href="/css/site.css">'));
  assert.ok(source.includes('<base href="https://site.test/">'));
  assert.ok(source.includes('"/img/" + imageName + ".png"'));
  assert.equal(files.get('files/site.test/js/app.js'), 'const list = "/data/list.json"; const spa = "/about";');
  assert.ok([...files.keys()].some(name => /^files\/site\.test\/img\/logo_[0-9a-f]+\.png$/.test(name)), [...files.keys()].join('\n'));
  assert.match(files.get('download-report.txt'), /Links: unchanged\nScript URLs: unchanged\nSaved names: URL variables kept as a short hash/);
});

test('Remove variables saves files without their query string', async t => {
  const { page, inspector } = await fixture(t);
  await setSettings(inspector, { stripQuery: true });
  const files = readZip(await exportAll(page, inspector));
  assert.ok(files.has('files/site.test/img/logo.png'));
  assert.match(files.get('download-report.txt'), /OK {6}https:\/\/site\.test\/img\/logo\.png\?v=3\n {8}-> files\/site\.test\/img\/logo\.png/);
});

test('Rewrite URLs points the saved page and stylesheets at the saved copies', async t => {
  const { page, inspector } = await fixture(t);
  await setSettings(inspector, { rewriteUrls: true, rewriteScripts: true, stripQuery: true });
  const zip = await exportAll(page, inspector);
  const files = readZip(zip);
  const source = files.get('site.test.html');
  assert.ok(source.includes('<link rel="stylesheet" href="files/site.test/css/site.css">'), source);
  assert.ok(source.includes('src="files/site.test/img/logo.png"'));
  assert.ok(source.includes('srcset="files/site.test/img/logo.png 1x, files/site.test/img/logo%402x.png 2x"'));
  assert.ok(source.includes('style="background-image: url(&quot;files/site.test/img/banner.png&quot;); width: 1px; height: 1px"'));
  assert.ok(source.includes('<a id="about" href="https://site.test/about">'), 'links that were not saved become absolute');
  assert.ok(source.includes('<a id="top" href="#top">'), 'in-page anchors are kept');
  assert.ok(source.includes('<base>'), 'the base URL is removed so links resolve from the saved file');
  assert.equal(files.get('files/site.test/css/site.css'), '#styled { color: rgb(1, 2, 3) } body { background: url("../img/bg.png") }');
  assert.match(files.get('download-report.txt'), /Links: rewritten to the saved copies/);

  // Open the saved copy from disk with the network blocked: everything still loads.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, data] of readZipBuffers(zip)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  const offline = await browser.newContext();
  t.after(() => offline.close());
  const copy = await offline.newPage();
  const remote = [];
  await copy.route(/^https?:/, route => { remote.push(route.request().url()); return route.abort(); });
  await copy.goto(pathToFileURL(path.join(dir, 'site.test.html')).href);
  await copy.waitForLoadState('load');
  assert.equal(await copy.locator('#styled').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)');
  assert.equal(await copy.locator('#logo').evaluate(img => img.naturalWidth), 1);
  // The inline script sets this image's URL at runtime; it was rewritten too.
  assert.equal(await copy.locator('#dyn').evaluate(img => img.naturalWidth), 1);
  assert.deepEqual(remote, []);
});

test('Rewrite URLs in scripts changes only script URLs of saved files', async t => {
  const { page, inspector } = await fixture(t);
  await setSettings(inspector, { rewriteScripts: true });
  const files = readZip(await exportAll(page, inspector));
  const source = files.get('site.test.html');
  assert.ok(source.includes('document.getElementById(\'dyn\').src = "files/site.test/img/bg.png";'), source);
  assert.ok(source.includes('const route = "/users/:id"; const about = "/about";'), 'strings that are not saved files are untouched');
  assert.ok(source.includes('<link rel="stylesheet" href="/css/site.css">'), 'markup is untouched without Rewrite URLs');
  assert.equal(files.get('files/site.test/js/app.js'), 'const list = "files/site.test/data/list.json"; const spa = "/about";');
  assert.match(files.get('download-report.txt'), /Script URLs: rewritten to the saved copies/);
});
