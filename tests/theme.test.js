const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function createThemeHarness({ systemLight = false, stored = null } = {}) {
  const listeners = new Map();
  const mediaListeners = new Map();
  const storage = new Map(stored ? [['music-importer-theme', stored]] : []);
  const attributes = new Map();
  const themeColor = { content: '' };
  const toggle = {
    title: '',
    setAttribute(name, value) { attributes.set(name, value); },
    addEventListener(name, callback) { listeners.set(`toggle:${name}`, callback); },
  };
  const media = {
    matches: systemLight,
    addEventListener(name, callback) { mediaListeners.set(name, callback); },
  };
  const document = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (selector === 'meta[name="theme-color"]') return themeColor;
      if (selector === '#themeToggle') return toggle;
      return null;
    },
    addEventListener(name, callback) { listeners.set(`document:${name}`, callback); },
  };
  const window = {
    matchMedia: () => media,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    addEventListener(name, callback) { listeners.set(`window:${name}`, callback); },
  };

  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/theme.js'), 'utf8'), { window, document });
  listeners.get('window:DOMContentLoaded')();

  return {
    click() { listeners.get('toggle:click')(); },
    changeSystemPreference(light) {
      media.matches = light;
      mediaListeners.get('change')();
    },
    get theme() { return document.documentElement.dataset.theme; },
    get themeColor() { return themeColor.content; },
    get label() { return attributes.get('aria-label'); },
    get storedPreference() { return storage.get('music-importer-theme'); },
  };
}

test('theme follows the system by default and can return to system mode after a manual toggle', () => {
  const lightSystem = createThemeHarness({ systemLight: true });
  assert.equal(lightSystem.theme, 'light');
  assert.equal(lightSystem.themeColor, '#f5f5f7');
  assert.equal(lightSystem.label, 'Переключить на тёмную тему');

  lightSystem.click();
  assert.equal(lightSystem.theme, 'dark');
  assert.equal(lightSystem.storedPreference, 'dark');
  assert.equal(lightSystem.label, 'Вернуться к системной теме (сейчас тёмная)');

  lightSystem.changeSystemPreference(false);
  assert.equal(lightSystem.theme, 'dark');
  lightSystem.click();
  assert.equal(lightSystem.theme, 'dark');
  assert.equal(lightSystem.storedPreference, 'system');
  assert.equal(lightSystem.label, 'Переключить на светлую тему');

  lightSystem.changeSystemPreference(true);
  assert.equal(lightSystem.theme, 'light');
});

test('stored explicit themes can be reset to the current system theme', () => {
  const darkSystem = createThemeHarness({ systemLight: false, stored: 'light' });
  assert.equal(darkSystem.theme, 'light');
  darkSystem.click();
  assert.equal(darkSystem.theme, 'dark');
  assert.equal(darkSystem.storedPreference, 'system');
});
