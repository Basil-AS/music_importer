const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadSafety() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/transfer-safety.js'), 'utf8'), context);
  return context.window.MusicTransferSafety;
}

test('page-close guard only warns while an account write is active', () => {
  const safety = loadSafety();
  let handler;
  let active = false;
  const targetWindow = { addEventListener: (name, listener) => { if (name === 'beforeunload') handler = listener; } };
  assert.equal(safety.installBeforeUnloadGuard(() => active, targetWindow), true);
  let prevented = false;
  const inactiveEvent = { preventDefault() { prevented = true; } };
  handler(inactiveEvent);
  assert.equal(prevented, false);
  assert.equal(inactiveEvent.returnValue, undefined);
  active = true;
  const activeEvent = { preventDefault() { prevented = true; } };
  handler(activeEvent);
  assert.equal(prevented, true);
  assert.equal(activeEvent.returnValue, '');
});
