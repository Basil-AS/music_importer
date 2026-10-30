// Runs demo/app.js against a tiny fake DOM and a scripted extension (chrome.runtime) so the
// app-level album flow (scope picker, matching, plan, execution, report) can be driven end to end.
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

function makeElement(selector, registry) {
  const listeners = {};
  const classes = new Set();
  const attributes = new Map();
  const element = {
    selector, dataset: {}, style: {}, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', checked: false, open: false,
    options: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    get selectedOptions() { return element.options.filter((option) => option.value === element.value); },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    querySelector: (child) => registry.get(`${selector} ${child}`),
    querySelectorAll: () => [],
    closest: () => null,
    replaceChildren(...children) { element.options = children; },
    scrollIntoView() {},
    previousElementSibling: { hidden: false },
    async emit(type, event = {}) { for (const handler of listeners[type] || []) await handler({ target: element, ...event }); },
  };
  return element;
}

function createAppHarness({ libraries, partialLibraries = {}, handler, statuses = {} }) {
  const cache = new Map();
  const registry = { get(selector) { if (!cache.has(selector)) cache.set(selector, makeElement(selector, registry)); return cache.get(selector); } };
  const cards = ['zvuk', 'spotify', 'yandex-music', 'apple-music'].map((provider) => {
    const card = registry.get(`.source[data-provider="${provider}"]`);
    card.dataset.provider = provider;
    card.connect = registry.get(`.source[data-provider="${provider}"] .connect`);
    card.connect.closest = () => card;
    card.querySelector = (child) => (child === '.connect' ? card.connect : registry.get(`${provider} ${child}`));
    return card;
  });
  const steps = Array.from({ length: 5 }, (_, index) => registry.get(`.step[data-step="${index + 1}"]`));
  steps[0].setAttribute('aria-current', 'step');
  const target = registry.get('#targetProvider');
  target.options = [{ value: '', disabled: false }, ...['zvuk', 'spotify', 'yandex-music', 'apple-music'].map((value) => ({ value, disabled: false }))];
  registry.get('#storefront').value = 'US';
  registry.get('#sourceCollectionSelect').value = 'all';
  const sent = [];
  const progressPorts = [];
  const document = {
    querySelector: (selector) => registry.get(selector),
    querySelectorAll: (selector) => (selector === '.source' ? cards : selector === '.source .connect' ? cards.map((card) => card.connect) : selector === '.step' ? steps : []),
    addEventListener() {},
    createElement: (tag) => makeElement(`<${tag}>`, registry),
    visibilityState: 'visible',
  };
  const window = {
    crypto: { randomUUID: () => crypto.randomUUID() },
    confirm: (text) => { window.confirmations.push(text); return true; },
    confirmations: [],
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    MusicTransferSafety: { installBeforeUnloadGuard() {} },
    MusicTransferJobStore: {
      jobs: [],
      async start(job) { this.jobs.push(job); return true; },
      async updateProgress() { return true; },
      async finish() { return true; },
      async latestUnresolved() { return null; },
      async acknowledge() { return true; },
    },
  };
  const chrome = {
    runtime: {
      id: 'fixture-extension',
      connect: () => ({
        onMessage: {
          addListener(listener) { progressPorts.push(listener); },
          removeListener(listener) { const index = progressPorts.indexOf(listener); if (index >= 0) progressPorts.splice(index, 1); },
        },
        postMessage() {},
      }),
      async sendMessage(message) {
        sent.push(message);
        if (message.type === 'music-importer:repair-provider-bridges') return { ok: true };
        if (message.type === 'music-importer:get-all-libraries') return { libraries, partialLibraries, statuses, pending: false };
        return handler(message, { emitProgress: (provider, requestId, progress) => progressPorts.forEach((listener) => listener({ type: 'transfer-progress', provider, requestId, progress })) });
      },
    },
  };
  const context = {
    window, document, chrome, location: { protocol: 'chrome-extension:', origin: 'chrome-extension://fixture-extension', href: 'chrome-extension://fixture-extension/app/index.html' },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    setTimeout, clearTimeout, URL, URLSearchParams, Blob: class {}, AbortController, DOMException, Promise, Map, Set, Number, String, Array, Object, Error, JSON, Math, Date, RegExp,
    TypeError, Intl, structuredClone, console,
  };
  window.window = window;
  vm.createContext(context);
  for (const file of ['theme.js', 'matcher.js', 'album-matcher.js', 'library-cache.js', 'account-catalog.js', 'transfer-core.js', 'transfer-engine.js', 'provider-connection-flow.js']) {
    if (file === 'theme.js') continue;
    vm.runInContext(fs.readFileSync(require.resolve(`../../demo/${file}`), 'utf8'), context, { filename: file });
  }
  window.MusicProviderConnectionFlow = context.MusicProviderConnectionFlow; // attached to globalThis, not window
  vm.runInContext(fs.readFileSync(require.resolve('../../demo/app.js'), 'utf8'), context, { filename: 'app.js' });
  return {
    $: (selector) => registry.get(selector), window, sent, cards, steps,
    async waitFor(predicate, label = 'condition') {
      for (let attempt = 0; attempt < 2000; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
  };
}

module.exports = { createAppHarness };
