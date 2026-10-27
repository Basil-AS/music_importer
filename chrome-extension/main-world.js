(() => {
  const marker = 'music-importer-zvuk';
  const captureParam = 'music_importer_capture';
  const startAtLoad = new URL(location.href).searchParams.get(captureParam) === '1';
  let enabled = startAtLoad;
  let autoScrollTimer = null;
  let lastPlaylistPageAt = 0;
  let lastFavoritePageAt = 0;
  let lastFavoriteHasMore = true;
  let favoriteEndReported = false;
  let lastCollectionPageAt = 0;
  let lastCollectionHasMore = true;

  if (startAtLoad) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete(captureParam);
    history.replaceState(history.state, '', cleanUrl.href);
  }

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  function stopAutoScroll() {
    if (autoScrollTimer) clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }

  function startAutoScroll() {
    if (autoScrollTimer) return;
    const startedAt = Date.now();
    autoScrollTimer = setInterval(() => {
      if (!enabled) { stopAutoScroll(); return; }
      const root = document.scrollingElement || document.documentElement;
      window.scrollTo(0, root.scrollHeight);
      for (const element of document.querySelectorAll('main,[class*="scroll"],[data-scroll]')) {
        const style = getComputedStyle(element);
        if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 16) element.scrollTop = element.scrollHeight;
      }
      const isPlaylist = /^\/playlist\/[^/]+/.test(location.pathname);
      const isFavorites = location.pathname === '/favorites';
      const isCollection = location.pathname.startsWith('/collection');
      if (Date.now() - startedAt > 20000 && isFavorites && !lastFavoritePageAt) {
        stopAutoScroll();
        post('favorites-scroll-stall');
      }
      if (Date.now() - startedAt > 20000 && isPlaylist && !lastPlaylistPageAt) {
        stopAutoScroll();
        post('read-error');
      }
      if (Date.now() - startedAt > 20000 && isCollection && !lastCollectionPageAt) {
        stopAutoScroll();
        post('collection-scroll-stall');
      }
      if (isCollection && lastCollectionPageAt && lastCollectionHasMore && Date.now() - lastCollectionPageAt > 12000) {
        stopAutoScroll();
        post('collection-scroll-stall');
      }
      if (isFavorites && lastFavoritePageAt && Date.now() - lastFavoritePageAt > 5000) {
        if (!lastFavoriteHasMore && !favoriteEndReported) {
          favoriteEndReported = true;
          stopAutoScroll();
          post('favorites-scroll-end');
        } else if (lastFavoriteHasMore && Date.now() - lastFavoritePageAt > 12000) {
          stopAutoScroll();
          post('favorites-scroll-stall');
        }
      }
      if (isPlaylist && lastPlaylistPageAt && Date.now() - lastPlaylistPageAt > 5000) {
        const playlistId = location.pathname.match(/^\/playlist\/([^/]+)/)?.[1] || '';
        stopAutoScroll();
        post('playlist-scroll-end', { playlistId });
      }
    }, 400);
  }

  function parseOperation(body) {
    if (typeof body !== 'string') return { name: '', variables: {} };
    try {
      const payload = JSON.parse(body);
      if (payload.operationName) return { name: String(payload.operationName), variables: payload.variables || {} };
      const match = String(payload.query || '').match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/);
      return { name: match?.[1] || '', variables: payload.variables || {} };
    } catch {
      return { name: '', variables: {} };
    }
  }

  function operationFor(url, body) {
    if (!url.includes('/api/v1/graphql')) return '';
    return parseOperation(body);
  }

  function sanitizeTrack(track) {
    return {
      id: String(track.id || ''),
      title: String(track.title || ''),
      isrc: String(track.isrc || track.ISRC || track.externalIds?.isrc || track.external_ids?.isrc || ''),
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
    };
  }

  function reportOperation(operation, payload) {
    const operationName = operation.name;
    if (!enabled || !payload || payload.errors?.length) {
      if (enabled && payload?.errors?.length && ['getPaginatedCollection', 'getPaginatedCollectionAll', 'getPlaylistTracks'].includes(operationName)) post('read-error');
      return;
    }

    if (operationName === 'getPaginatedCollection') {
      const page = payload.data?.paginatedCollection?.tracks;
      if (!page || !Array.isArray(page.items)) return;
      const tracks = page.items.map(sanitizeTrack).filter((track) => track.id && track.title);
      lastFavoritePageAt = Date.now();
      lastFavoriteHasMore = Boolean(page.page?.endCursor);
      favoriteEndReported = false;
      post('favorite-page', {
        tracks,
        hasMore: lastFavoriteHasMore,
      });
      return;
    }

    if (operationName === 'getPaginatedCollectionAll' || operationName === 'getPaginatedCollectionAllSections') {
      const collection = payload.data?.paginatedCollectionAll || payload.data?.paginatedCollectionAllSections;
      const page = collection?.playlists;
      const items = Array.isArray(page) ? page : page?.items;
      if (!Array.isArray(items)) return;
      lastCollectionPageAt = Date.now();
      lastCollectionHasMore = Boolean(page?.page?.endCursor);
      const playlists = items.map((playlist) => ({
        id: String(playlist.id || ''),
        title: String(playlist.title || ''),
        trackCount: Number.isInteger(playlist.trackCount) ? playlist.trackCount : null,
      })).filter((playlist) => playlist.id && playlist.title);
      post('playlist-list-page', { playlists, hasMore: Boolean(page?.page?.endCursor) });
      if (!lastCollectionHasMore && location.pathname.startsWith('/collection')) {
        stopAutoScroll();
        post('collection-scroll-end');
      }
      return;
    }

    if (operationName === 'getPlaylistTracks') {
      const page = payload.data?.playlistTracks;
      const items = Array.isArray(page) ? page : page?.items;
      if (!Array.isArray(items)) return;
      const pathId = location.pathname.match(/^\/playlist\/([^/]+)/)?.[1] || '';
      post('playlist-track-page', {
        playlistId: String(operation.variables?.id || pathId),
        offset: Number(operation.variables?.offset || 0),
        limit: Number(operation.variables?.limit || items.length),
        tracks: items.map(sanitizeTrack).filter((track) => track.id && track.title),
      });
      lastPlaylistPageAt = Date.now();
      return;
    }

    if (operationName === 'getPlaylists') {
      const playlists = payload.data?.playlists;
      if (!Array.isArray(playlists)) return;
      post('playlist-metadata', { playlists: playlists.map((playlist) => ({
        id: String(playlist.id || ''),
        title: String(playlist.title || ''),
        trackCount: Number.isInteger(playlist.trackCount) ? playlist.trackCount : null,
      })).filter((playlist) => playlist.id && playlist.title) });
      return;
    }

    if (operationName === 'getCollectionIds') {
      const collection = payload.data?.collection;
      if (Array.isArray(collection?.tracks) || Array.isArray(collection?.playlists)) {
        post('collection-count', {
          uniqueTrackCount: Array.isArray(collection.tracks) ? new Set(collection.tracks.map((item) => String(item.id || '')).filter(Boolean)).size : null,
          uniquePlaylistCount: Array.isArray(collection.playlists) ? new Set(collection.playlists.map((item) => String(item.id || '')).filter(Boolean)).size : null,
        });
      }
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
      operation.then((parsed) => {
        if (parsed.name) response.clone().json().then((payload) => reportOperation(parsed, payload)).catch(() => {});
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
      const parsed = parseOperation(body);
      if (parsed.name) {
        this.addEventListener('load', () => {
          try {
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            reportOperation(parsed, payload);
          } catch { /* A non-JSON provider response is ignored. */ }
        }, { once: true });
      }
    }
    return xhrSend.call(this, body);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type === 'start') enabled = true;
    if (event.data.type === 'stop') { enabled = false; stopAutoScroll(); }
  });

  if (startAtLoad && (location.pathname === '/favorites' || location.pathname.startsWith('/collection') || /^\/playlist\/[^/]+/.test(location.pathname))) startAutoScroll();
})();
