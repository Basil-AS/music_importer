const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { createAppHarness } = require('./helpers/app-fixture');

test('the current transfer stage is exposed to assistive technology as the workflow advances', async () => {
  const harness = createAppHarness({ libraries: {}, handler: async () => ({ ok: true }) });
  const activeStep = () => harness.steps.findIndex((step) => step.getAttribute('aria-current') === 'step') + 1;

  assert.equal(activeStep(), 1);
  await harness.$('#loadBtn').emit('click');
  assert.equal(activeStep(), 2);
  await harness.$('#resetBtn').emit('click');
  assert.equal(activeStep(), 1);
  assert.equal(harness.steps.filter((step) => step.getAttribute('aria-current') === 'step').length, 1);
});

test('CSV and JSON upload has a keyboard reachable button that opens the native file picker', async () => {
  const harness = createAppHarness({ libraries: {}, handler: async () => ({ ok: true }) });
  const html = fs.readFileSync(require.resolve('../demo/index.html'), 'utf8');
  assert.match(html, /<button[^>]+id="uploadFileBtn"[^>]+aria-controls="fileInput"/);
  assert.match(html, /<input id="fileInput" type="file"[^>]+hidden/);
  await harness.$('#uploadFileBtn').emit('click');
  assert.equal(harness.$('#fileInput').clickCount, 1);
});

test('interactive controls have visible focus styles and skipped tracks retain full text contrast', () => {
  const css = fs.readFileSync(require.resolve('../demo/styles.css'), 'utf8');
  assert.match(css, /button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible/);
  assert.match(css, /\.track\.skipped\s*\{\s*border-left:\s*3px solid var\(--amber\)\s*\}/);
  assert.doesNotMatch(css, /\.track\.skipped\s*\{[^}]*opacity\s*:/);
});

test('track search buttons identify the track they search', async () => {
  const harness = createAppHarness({ libraries: {}, handler: async () => ({ ok: true }) });
  await harness.$('#loadBtn').emit('click');
  assert.match(harness.$('#trackList').innerHTML, /aria-label="Искать совпадение для Мокрые кроссы"/);
});
