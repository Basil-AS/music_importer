const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makePage(path = '/favorites', respond = null, timerScale = 1) {
  const listeners = new Map();
  const messages = [];
  const requests = [];
  let scrollCallback = null;
  let now = Date.now();
  class TestDate extends Date { static now() { return now; } }
  const location = { origin: 'https://zvuk.com', pathname: path, href: `https://zvuk.com${path}?music_importer_capture=1` };
  const history = { state: {}, replaceState(_state, _title, url) { location.href = String(url); } };
  class Request {
    constructor(url, init = {}) {
      this.url = String(url);
      this.method = init.method || 'GET';
      this.credentials = init.credentials || 'same-origin';
      this.headers = new Headers(init.headers || {});
      this.body = init.body || '';
    }
    clone() { return { text: async () => this.body }; }
  }
  class XMLHttpRequest {
    constructor() { this.headers = {}; this.listeners = {}; }
    open(method, url) { this.method = method; this.url = String(url); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    async send(body) {
      const request = {
        url: this.url,
        init: { method: this.method, credentials: 'include', headers: this.headers, body },
        payload: JSON.parse(body || '{}'),
      };
      requests.push(request);
      const result = respond(request);
      const payload = result?.payload || result;
      this.responseURL = this.url;
      this.status = Number(result?.statusCode || 200);
      this.responseText = JSON.stringify(payload);
      for (const callback of this.listeners.load || []) callback.call(this);
    }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  }
  const window = {
    location,
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(message) {
      messages.push(message);
      if (message.captureAckId) queueMicrotask(() => listeners.get('message')?.({
        source: window, origin: location.origin,
        data: { source: 'music-importer-zvuk', type: 'capture-ack', captureAckId: message.captureAckId, ok: true },
      }));
    },
    scrollTo() {},
    fetch: async (input, init = {}) => {
      const fromRequest = input instanceof Request ? input : null;
      const effectiveInit = { ...(fromRequest ? {
        method: fromRequest.method, credentials: fromRequest.credentials, headers: fromRequest.headers, body: fromRequest.body,
      } : {}), ...init };
      const url = fromRequest ? fromRequest.url : String(input);
      const request = { url, init: effectiveInit, payload: JSON.parse(effectiveInit.body || '{}') };
      requests.push(request);
      const operation = request.payload.operationName;
      const defaultPayload = operation === 'getPaginatedCollection'
        ? { data: { paginatedCollection: { tracks: {
          items: [{ id: 'favorite-1', title: 'Favorite', artists: [{ id: 'artist-1', title: 'Artist' }], release: { id: 'release-1', title: 'Album' }, isrc: 'USABC1234567', duration: 180000, privateField: 'must-not-leak' }],
          page: { endCursor: null },
        } } } }
        : operation === 'getPaginatedCollectionAll'
          ? { data: { paginatedCollectionAll: { playlists: { items: [
            { id: 'playlist-road', title: 'Road', trackCount: 2 },
            { id: 'playlist-empty', title: 'Empty', trackCount: 0 },
          ], page: { endCursor: null } } } } }
          : operation === 'getPlaylistTracks'
            ? { data: { playlistTracks: { items: [
              { id: 'repeat-track', title: 'Repeated', artists: [{ title: 'Artist' }] },
              { id: 'repeat-track', title: 'Repeated', artists: [{ title: 'Artist' }] },
            ] } } }
            : { errors: [{ message: 'Unexpected fixture operation' }] };
      const result = respond ? respond(request) : defaultPayload;
      const payload = result?.payload || result;
      const status = Number(result?.statusCode || 200);
      const readPayload = async () => {
        if (!result?.pendingBody) return payload;
        await new Promise((resolve, reject) => {
          if (effectiveInit.signal.aborted) reject(new Error('aborted'));
          else effectiveInit.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return payload;
      };
      return { ok: status >= 200 && status < 300, status, json: readPayload, clone: () => ({ json: readPayload }) };
    },
  };
  const context = {
    window, location, history, document: { documentElement: { scrollHeight: 100, clientHeight: 100, scrollTop: 0 }, querySelectorAll: () => [] }, XMLHttpRequest, URL, Request, Headers, Promise,
    Map, Set, String, Number, Array, Object, Error, JSON, Date: TestDate, RegExp, Math, AbortController,
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay * timerScale, ...args),
    clearTimeout, setInterval: (callback) => { scrollCallback = callback; return 1; }, clearInterval() {},
    getComputedStyle: () => ({ overflowY: 'visible' }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../chrome-extension/main-world.js'), 'utf8'), context);
  return {
    messages,
    requests,
    async request(operationName, variables = {}) {
      const response = await window.fetch('https://zvuk.com/api/v1/graphql', {
        method: 'POST', body: JSON.stringify({ operationName, variables }),
      });
      await response.clone().json();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async requestAsRequest(operationName, variables = {}, headers = {}) {
      const input = new Request('https://zvuk.com/api/v1/graphql', {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({ operationName, variables }),
      });
      const response = await window.fetch(input);
      await response.clone().json();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async requestAsXhr(operationName, variables = {}, headers = {}) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://zvuk.com/api/v1/graphql');
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      await xhr.send(JSON.stringify({ operationName, variables }));
      await new Promise((resolve) => setImmediate(resolve));
    },
    setPath(pathname) { location.pathname = pathname; },
    async tickScrollAfter(ms) { now += ms; scrollCallback?.(); await new Promise((resolve) => setImmediate(resolve)); },
  };
}

test('Zvuk page connector captures only normalized favorites and playlist catalog data', async () => {
  const page = makePage('/favorites');
  await page.request('getPaginatedCollection', { first: 100, after: null });
  const favoritePage = page.messages.find((message) => message.type === 'favorite-page');
  assert.deepEqual(Array.from(favoritePage.tracks, (track) => [track.id, track.title, track.isrc]), [
    ['favorite-1', 'Favorite', 'USABC1234567'],
  ]);
  assert.equal(favoritePage.hasMore, false);
  assert.ok(!JSON.stringify(page.messages).includes('must-not-leak'));

  page.setPath('/collection');
  await page.request('getPaginatedCollectionAll', { first: 100, after: null });
  const catalog = page.messages.find((message) => message.type === 'playlist-list-page');
  assert.deepEqual(Array.from(catalog.playlists, (playlist) => [playlist.id, playlist.title, playlist.trackCount]), [
    ['playlist-road', 'Road', 2], ['playlist-empty', 'Empty', 0],
  ]);
  assert.equal(catalog.hasMore, false);
});

test('Zvuk page connector preserves repeated playlist tracks and their requested offset', async () => {
  const page = makePage('/playlist/playlist-road');
  await page.request('getPlaylistTracks', { id: 'playlist-road', offset: 20, limit: 2 });
  const playlistPage = page.messages.find((message) => message.type === 'playlist-track-page');
  assert.equal(playlistPage.playlistId, 'playlist-road');
  assert.equal(playlistPage.offset, 20);
  assert.equal(playlistPage.limit, 2);
  assert.deepEqual(Array.from(playlistPage.tracks, (track) => track.id), ['repeat-track', 'repeat-track']);
});

test('Zvuk source reader follows observed favorite cursors without relying on scroll events', async () => {
  const page = makePage('/favorites', ({ payload }) => {
    const cursor = payload.variables?.after || null;
    const pages = {
      null: { items: [{ id: 'favorite-a', title: 'A', artists: [{ title: 'Artist' }] }], page: { endCursor: 'cursor-b' } },
      'cursor-b': { items: [{ id: 'favorite-b', title: 'B', artists: [{ title: 'Artist' }] }], page: { endCursor: 'cursor-c' } },
      'cursor-c': { items: [{ id: 'favorite-c', title: 'C', artists: [{ title: 'Artist' }] }], page: { endCursor: null } },
    };
    return { data: { paginatedCollection: { tracks: pages[String(cursor)] } } };
  });

  await page.request('getPaginatedCollection', { first: 100, after: null });
  for (let attempt = 0; attempt < 20 && !page.messages.some((message) => message.type === 'favorites-scroll-end'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const favoritePages = page.messages.filter((message) => message.type === 'favorite-page');
  assert.deepEqual(favoritePages.flatMap((message) => message.tracks.map((track) => track.id)), [
    'favorite-a', 'favorite-b', 'favorite-c',
  ]);
  assert.deepEqual(page.messages.filter((message) => message.type === 'favorites-scroll-end').length, 1);
  assert.deepEqual(page.requests.filter((request) => request.payload.operationName === 'getPaginatedCollection')
    .map((request) => request.payload.variables.after), [null, 'cursor-b', 'cursor-c']);
});

test('Zvuk cursor replay preserves page-local headers from Request and XHR without forwarding them', async () => {
  for (const transport of ['request', 'xhr']) {
    const page = makePage('/favorites', ({ payload, init }) => {
      const cursor = payload.variables?.after || null;
      if (cursor) assert.equal(init.headers.get?.('x-fixture-client') || init.headers['x-fixture-client'], 'page-session-header');
      return { data: { paginatedCollection: { tracks: cursor
        ? { items: [{ id: 'favorite-next', title: 'Next', artists: [{ title: 'Artist' }] }], page: { endCursor: null } }
        : { items: [{ id: 'favorite-first', title: 'First', artists: [{ title: 'Artist' }] }], page: { endCursor: 'next-page' } },
      } } };
    });

    if (transport === 'request') {
      await page.requestAsRequest('getPaginatedCollection', { first: 100, after: null }, { 'X-Fixture-Client': 'page-session-header' });
    } else {
      await page.requestAsXhr('getPaginatedCollection', { first: 100, after: null }, { 'X-Fixture-Client': 'page-session-header' });
    }
    for (let attempt = 0; attempt < 20 && !page.messages.some((message) => message.type === 'favorites-scroll-end'); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(page.messages.filter((message) => message.type === 'favorite-page')
      .flatMap((message) => message.tracks.map((track) => track.id)), ['favorite-first', 'favorite-next']);
    assert.ok(page.messages.some((message) => message.type === 'favorites-scroll-end'));
    assert.ok(!JSON.stringify(page.messages).includes('page-session-header'));
  }
});

test('Zvuk source reader exposes a failed cursor request when scroll fallback stalls', async () => {
  const page = makePage('/favorites', ({ payload }) => {
    const cursor = payload.variables?.after || null;
    if (cursor) return { statusCode: 503, payload: { errors: [{ message: 'temporarily unavailable' }] } };
    return { data: { paginatedCollection: { tracks: {
      items: [{ id: 'favorite-a', title: 'A', artists: [{ title: 'Artist' }] }],
      page: { endCursor: 'cursor-b' },
    } } } };
  });

  await page.request('getPaginatedCollection', { first: 100, after: null });
  await page.tickScrollAfter(21000);
  const stalled = page.messages.find((message) => message.type === 'favorites-scroll-stall');
  assert.match(stalled.reason, /GraphQL ответил HTTP 503/);
});

test('Zvuk playlist catalog timeout allows slow page hydration before reporting a stall', async () => {
  const page = makePage('/collection', null, 1);
  await page.tickScrollAfter(20000);
  assert.equal(page.messages.some((message) => message.type === 'collection-scroll-stall'), false);
  await page.tickScrollAfter(41000);
  assert.equal(page.messages.find((message) => message.type === 'collection-scroll-stall')?.reason, 'no-response');
});

test('Zvuk playlist catalog read errors carry only safe operation and HTTP metadata', async () => {
  const page = makePage('/collection', () => ({ statusCode: 401, payload: { errors: [{ message: 'private response detail' }] } }));
  await page.request('getPaginatedCollectionAll', { first: 100, after: null });
  const error = page.messages.find((message) => message.type === 'read-error');
  assert.equal(error.operation, 'getPaginatedCollectionAll');
  assert.equal(error.httpStatus, 401);
  assert.equal(error.graphqlError, true);
  assert.ok(!JSON.stringify(error).includes('private response detail'));
});

test('Zvuk source reader keeps its deadline active while reading cursor response JSON', async () => {
  const page = makePage('/favorites', ({ payload }) => {
    if (payload.variables?.after) return { pendingBody: true };
    return { data: { paginatedCollection: { tracks: {
      items: [{ id: 'favorite-a', title: 'A', artists: [{ title: 'Artist' }] }],
      page: { endCursor: 'cursor-b' },
    } } } };
  }, 0.001);

  await page.request('getPaginatedCollection', { first: 100, after: null });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await page.tickScrollAfter(21000);
  const stalled = page.messages.find((message) => message.type === 'favorites-scroll-stall');
  assert.match(stalled.reason, /не загрузилась за 45 секунд/);
});
