// Service worker fixture shared by the album integration tests (copy of the all-libraries harness
// with an optional `respond(tabId, message)` hook for scripted provider replies).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function bootWorker(storageState, tabs = [], options = {}) {
  const messages = [];
  const updates = [];
  const reloads = [];
  const reloadedTabs = new Set();
  const tabUpdatedListeners = new Set();
  const portMessages = [];
  const createdTabs = [];
  let runtimeListener;
  let installedListener;
  let startupListener;
  let connectListener;
  let actionListener;
  const chrome = {
    runtime: {
      id: 'fixture-extension',
      getURL(path) { return `chrome-extension://fixture-extension/${path}`; },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      onInstalled: { addListener(listener) { installedListener = listener; } },
      onStartup: { addListener(listener) { startupListener = listener; } },
      onConnect: { addListener(listener) { connectListener = listener; } },
    },
    action: { onClicked: { addListener(listener) { actionListener = listener; } } },
    storage: { local: {
      setAccessLevel: async () => {},
      async get(key) {
        const value = storageState[key];
        return { [key]: options.cloneStorageReads ? structuredClone(value) : value };
      },
      async set(value) { Object.assign(storageState, value); },
      async remove(keys) { for (const key of keys) delete storageState[key]; },
    } },
    tabs: {
      async query(query) {
        if (!query.url) return tabs;
        const patterns = Array.isArray(query.url) ? query.url : [query.url];
        return tabs.filter((tab) => patterns.some((pattern) => {
          const expression = new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
          return expression.test(tab.url);
        }));
      },
      async get(tabId) { return tabs.find((tab) => tab.id === tabId) || null; },
      async update(tabId, update) {
        updates.push({ tabId, update });
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (tab && update.url) tab.url = update.url;
      },
      onUpdated: {
        addListener(listener) { tabUpdatedListeners.add(listener); },
        removeListener(listener) { tabUpdatedListeners.delete(listener); },
      },
      async reload(tabId) {
        reloads.push(tabId);
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error('No such tab');
        tab.status = 'loading';
        for (const listener of tabUpdatedListeners) listener(tabId, { status: 'loading' }, tab);
        tab.status = 'complete';
        for (const listener of tabUpdatedListeners) listener(tabId, { status: 'complete' }, tab);
        reloadedTabs.add(tabId);
      },
      async create(createProperties) {
        createdTabs.push(createProperties);
        const tab = { id: 99 + createdTabs.length, ...createProperties };
        tabs.push(tab);
        return tab;
      },
      async sendMessage(tabId, message) {
        messages.push({ tabId, message });
        if (message.type === 'music-importer:bridge-health-check'
          && options.healthFailureTabIds?.includes(tabId) && !reloadedTabs.has(tabId)) {
          throw new Error('Receiving end does not exist');
        }
        if (options.missingReceiverOnce?.includes(tabId) && !reloadedTabs.has(tabId)) throw new Error('Receiving end does not exist');
        if (message.type === 'music-importer:bridge-health-check') {
          return { ok: true, bridgeProtocol: options.oldBridgeTabIds?.includes(tabId) && !reloadedTabs.has(tabId) ? 2 : 3 };
        }
        if (options.respond) return options.respond(tabId, message);
        return { ok: true };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../chrome-extension/service-worker.js'), 'utf8'), {
    chrome, URL, Date, Number, String, Array, Promise, Set, Map, Object, Error, JSON, RegExp, Math, setTimeout, clearTimeout,
  });
  return {
    messages,
    updates,
    reloads,
    createdTabs,
    storageState,
    tabs,
    clickAction(tab) { return actionListener(tab); },
    install(reason = 'install') { return installedListener({ reason }); },
    startup() { return startupListener(); },
    completeTab(tabId) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      assert.ok(tab, `Expected fixture tab ${tabId}`);
      tab.status = 'complete';
      for (const listener of tabUpdatedListeners) listener(tabId, { status: 'complete' }, tab);
    },
    call(message) {
      return this.callFrom(message, 'http://127.0.0.1:8001/');
    },
    callFrom(message, url) {
      return new Promise((resolve) => {
        const keptOpen = runtimeListener(message, { id: 'fixture-extension', url }, resolve);
        assert.equal(keptOpen, true);
      });
    },
    pageMessage(message, tabId) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      assert.ok(tab, `Expected fixture tab ${tabId}`);
      return new Promise((resolve) => {
        runtimeListener(message, { id: 'fixture-extension', tab, url: tab.url }, resolve);
      });
    },
    connectApp(url = 'chrome-extension://fixture-extension/app/index.html') {
      const port = {
        name: 'music-importer-app',
        sender: { id: 'fixture-extension', url },
        onDisconnect: { addListener(listener) { port.onDisconnectListener = listener; } },
        onMessage: { addListener(listener) { port.onMessageListener = listener; } },
        postMessage(message) {
          portMessages.push(message);
          if (message.checkpointAckId && options.autoAckCheckpoints !== false) {
            queueMicrotask(() => port.onMessageListener?.({
              type: 'transfer-progress-ack', checkpointAckId: message.checkpointAckId, ok: true,
            }));
          }
        },
        acknowledge(message) { port.onMessageListener?.(message); },
        disconnect() { port.disconnected = true; },
      };
      connectListener(port);
      return port;
    },
    portMessages,
  };
}

module.exports = { bootWorker };
