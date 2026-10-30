const assert = require('node:assert/strict');
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
