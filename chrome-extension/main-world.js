(() => {
  const marker = 'music-importer-zvuk';
  const captureParam = 'music_importer_capture';
  const startAtLoad = new URL(location.href).searchParams.get(captureParam) === '1';
  let enabled = startAtLoad;

  if (startAtLoad) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete(captureParam);
    history.replaceState(history.state, '', cleanUrl.href);
  }

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  function parseOperation(body) {
    if (typeof body !== 'string') return '';
    try {
      const payload = JSON.parse(body);
      if (payload.operationName) return String(payload.operationName);
      const match = String(payload.query || '').match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }

  function operationFor(url, body) {
    if (!url.includes('/api/v1/graphql')) return '';
    return parseOperation(body);
  }

  function reportOperation(operation, payload) {
    if (!enabled || !payload || payload.errors?.length) {
      if (enabled && payload?.errors?.length && operation === 'getPaginatedCollection') post('read-error');
      return;
    }

    if (operation === 'getPaginatedCollection') {
      const page = payload.data?.paginatedCollection?.tracks;
      if (!page || !Array.isArray(page.items)) return;
      const tracks = page.items.map((track) => ({
        id: String(track.id || ''),
        title: String(track.title || ''),
        duration: Number(track.duration || 0),
        explicit: Boolean(track.explicit),
        availability: track.availability ?? null,
        artists: Array.isArray(track.artists) ? track.artists.map((artist) => ({
          id: String(artist.id || ''),
          title: String(artist.title || ''),
        })).filter((artist) => artist.title) : [],
        release: track.release ? {
          id: String(track.release.id || ''),
          title: String(track.release.title || ''),
        } : null,
      })).filter((track) => track.id && track.title);
      post('favorite-page', {
        tracks,
        hasMore: Boolean(page.page?.endCursor),
      });
      return;
    }

    if (operation === 'getCollectionIds') {
      const ids = payload.data?.collection?.tracks;
      if (Array.isArray(ids)) post('collection-count', { uniqueTrackCount: new Set(ids.map((item) => String(item.id || '')).filter(Boolean)).size });
    }
  }

  function observeFetch(input, init, originalFetch, receiver) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/v1/graphql')) return originalFetch.call(receiver, input, init);
    const body = typeof init?.body === 'string'
      ? Promise.resolve(init.body)
      : input instanceof Request ? input.clone().text().catch(() => '') : Promise.resolve('');
    const operation = body.then((value) => operationFor(url, value));
    return originalFetch.call(receiver, input, init).then((response) => {
      operation.then((name) => {
        if (name) response.clone().json().then((payload) => reportOperation(name, payload)).catch(() => {});
      });
      return response;
    });
  }

  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    return observeFetch(input, init, originalFetch, this);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__musicImporterUrl = String(url);
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const url = this.__musicImporterUrl || '';
    if (url.includes('/api/v1/graphql')) {
      const name = parseOperation(body);
      if (name) {
        this.addEventListener('load', () => {
          try {
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            reportOperation(name, payload);
          } catch { /* A non-JSON provider response is ignored. */ }
        }, { once: true });
      }
    }
    return xhrSend.call(this, body);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type === 'start') enabled = true;
    if (event.data.type === 'stop') enabled = false;
  });
})();
