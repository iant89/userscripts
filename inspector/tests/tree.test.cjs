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
