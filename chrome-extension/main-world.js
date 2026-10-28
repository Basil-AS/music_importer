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
  let favoriteScanStarted = false;
  let favoriteCursorError = '';
  let lastCollectionPageAt = 0;
  let lastCollectionHasMore = true;
  const captureAckWaiters = new Map();
  const xhrRequestHeaders = new WeakMap();
  const xhrRequestMethods = new WeakMap();
  let captureAckSequence = 0;

  if (startAtLoad) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete(captureParam);
    history.replaceState(history.state, '', cleanUrl.href);
  }

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  function postWithAck(type, detail = {}) {
    const captureAckId = `capture-${++captureAckSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        captureAckWaiters.delete(captureAckId);
        resolve(false);
      }, 20000);
      captureAckWaiters.set(captureAckId, (ok) => {
        clearTimeout(timer);
        captureAckWaiters.delete(captureAckId);
        resolve(ok === true);
      });
      window.postMessage({ source: marker, type, ...detail, captureAckId }, location.origin);
    });
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
        post('favorites-scroll-stall', { reason: favoriteCursorError || 'Не удалось получить первую страницу избранного.' });
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
          post('favorites-scroll-stall', { reason: favoriteCursorError || 'Сервис сообщил, что в избранном есть продолжение, но новые страницы не появились.' });
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
    let requestUrl;
    try { requestUrl = new URL(url, location.origin); } catch { return ''; }
    if (requestUrl.origin !== location.origin || !requestUrl.pathname.endsWith('/api/v1/graphql')) return '';
    return parseOperation(body);
  }

  function copyHeaders(...sources) {
    const output = Object.create(null);
    for (const source of sources) {
      if (!source) continue;
      if (typeof source.forEach === 'function') {
        source.forEach((value, name) => { output[String(name).toLowerCase()] = String(value); });
      } else if (Array.isArray(source)) {
        for (const [name, value] of source) output[String(name).toLowerCase()] = String(value);
      } else if (typeof source === 'object') {
        for (const [name, value] of Object.entries(source)) output[String(name).toLowerCase()] = String(value);
      }
    }
    return output;
  }

  function replayRequestOptions(input, init) {
    const request = input instanceof Request ? input : null;
    return {
      ...(init || {}),
      method: init?.method || request?.method || 'POST',
      credentials: init?.credentials || request?.credentials || 'include',
      headers: copyHeaders(request?.headers, init?.headers),
    };
  }

  function sanitizeTrack(track) {
    const release = track.release || {};
    const artwork = release.artwork?.url || release.coverUri || release.coverUrl || release.cover?.url || release.cover
      || release.image?.url || release.imageUrl || release.picture?.url || track.artwork?.url || track.coverUri || track.coverUrl
      || track.cover?.url || track.cover || track.image?.url || track.imageUrl || '';
    return {
      id: String(track.id || ''),
      title: String(track.title || ''),
      artworkUrl: String(typeof artwork === 'object' ? artwork.url || artwork.src || '' : artwork),
      releaseDate: String(release.releaseDate || release.year || ''),
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
        artworkUrl: String(typeof artwork === 'object' ? artwork.url || artwork.src || '' : artwork),
        releaseDate: String(release.releaseDate || release.year || ''),
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
      return reportFavoritePage(page);
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

  function reportFavoritePage(page) {
    if (!Array.isArray(page?.items)) return false;
    const tracks = page.items.map(sanitizeTrack).filter((track) => track.id && track.title);
    lastFavoritePageAt = Date.now();
    lastFavoriteHasMore = Boolean(page.page?.endCursor);
    favoriteEndReported = false;
    return postWithAck('favorite-page', { tracks, hasMore: lastFavoriteHasMore });
  }

  async function readFavoritesByCursor(url, init, bodyText, firstPage) {
    if (location.pathname !== '/favorites' || !Array.isArray(firstPage?.items)) return false;
    let cursor = firstPage.page?.endCursor;
    if (cursor === null || cursor === undefined || cursor === '') {
      favoriteEndReported = true;
      return postWithAck('favorites-scroll-end');
    }
    let requestBody;
    try {
      requestBody = JSON.parse(bodyText);
      if (!requestBody.variables || !Object.hasOwn(requestBody.variables, 'after')) return false;
    } catch { return false; }

    const seen = new Set();
    let pagesRead = 1;
    try {
      while (cursor !== null && cursor !== undefined && cursor !== '') {
        const nextCursor = String(cursor);
        if (seen.has(nextCursor)) throw new Error('Звук повторил cursor списка лайков.');
        seen.add(nextCursor);
        const nextBody = {
          ...requestBody,
          variables: { ...requestBody.variables, after: nextCursor },
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);
        let response;
        let payload;
        try {
          response = await originalFetch.call(window, url, {
            ...init,
            method: init?.method || 'POST',
            credentials: init?.credentials || 'include',
            body: JSON.stringify(nextBody),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) throw new Error('Страница избранного Звука не ответила за 45 секунд.');
          throw error;
        }
        try {
          if (!response.ok) throw new Error(`GraphQL ответил HTTP ${response.status}.`);
          payload = await response.json();
        } catch (error) {
          if (controller.signal.aborted) throw new Error('Страница избранного Звука не загрузилась за 45 секунд.');
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (!payload?.data || payload.errors?.length) throw new Error('Звук не вернул страницу избранного.');
        const page = payload.data?.paginatedCollection?.tracks;
        if (!Array.isArray(page?.items) || !await reportFavoritePage(page)) throw new Error('Звук не сохранил страницу избранного.');
        pagesRead += 1;
        cursor = page.page?.endCursor;
        if (cursor && !page.items.length) throw new Error('Звук вернул пустую страницу лайков с продолжением.');
        if (!await postWithAck('scan-progress', { phase: 'favorites', message: `Избранное Звука: получено страниц ${pagesRead}.` })) {
          throw new Error('Приложение не подтвердило сохранение прогресса избранного Звука.');
        }
      }
      favoriteEndReported = true;
      stopAutoScroll();
      return await postWithAck('favorites-scroll-end');
    } catch (error) {
      // If replaying the observed request is unsupported, fall back to the page's own infinite scroll.
      favoriteCursorError = error instanceof Error ? error.message : 'Не удалось прочитать следующую страницу избранного.';
      startAutoScroll();
      return false;
    }
  }

  async function continueFavoriteScan(url, init, bodyText, firstPage, reported) {
    if (location.pathname !== '/favorites' || favoriteScanStarted) return;
    favoriteScanStarted = true;
    try {
      if (await reported !== true) {
        favoriteCursorError = 'Приложение не подтвердило получение первой страницы избранного.';
        startAutoScroll();
        return;
      }
      const handled = await readFavoritesByCursor(url, init || {}, bodyText, firstPage);
      if (!handled) {
        if (!favoriteCursorError) favoriteCursorError = 'В запросе избранного не удалось определить курсор следующей страницы.';
        startAutoScroll();
      }
    } finally {
      favoriteScanStarted = false;
    }
  }

  function observeFetch(input, init, originalFetch, receiver) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/v1/graphql')) return originalFetch.call(receiver, input, init);
    const body = typeof init?.body === 'string'
      ? Promise.resolve(init.body)
      : input instanceof Request ? input.clone().text().catch(() => '') : Promise.resolve('');
    const request = body.then((text) => ({ text, operation: operationFor(url, text) }));
    return originalFetch.call(receiver, input, init).then((response) => {
      request.then(({ text, operation }) => {
        if (operation.name) response.clone().json().then((payload) => {
          const reported = reportOperation(operation, payload);
          if (operation.name === 'getPaginatedCollection') void continueFavoriteScan(
            url, replayRequestOptions(input, init), text, payload?.data?.paginatedCollection?.tracks, reported,
          );
        }).catch(() => {});
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
    xhrRequestMethods.set(this, String(method || 'POST'));
    xhrRequestHeaders.set(this, Object.create(null));
    return xhrOpen.call(this, method, url, ...rest);
  };
  const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  if (xhrSetRequestHeader) XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
    const headers = xhrRequestHeaders.get(this) || Object.create(null);
    const key = String(name).toLowerCase();
    headers[key] = headers[key] ? `${headers[key]}, ${String(value)}` : String(value);
    xhrRequestHeaders.set(this, headers);
    return xhrSetRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const url = this.__musicImporterUrl || '';
    if (url.includes('/api/v1/graphql')) {
      const parsed = parseOperation(body);
      if (parsed.name) {
        this.addEventListener('load', () => {
          try {
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            const reported = reportOperation(parsed, payload);
            if (parsed.name === 'getPaginatedCollection') void continueFavoriteScan(
              this.responseURL || url,
              {
                method: xhrRequestMethods.get(this) || 'POST', credentials: 'include',
                headers: copyHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }, xhrRequestHeaders.get(this)),
              },
              typeof body === 'string' ? body : '',
              payload?.data?.paginatedCollection?.tracks,
              reported,
            );
          } catch { /* A non-JSON provider response is ignored. */ }
        }, { once: true });
      }
    }
    return xhrSend.call(this, body);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type === 'capture-ack') {
      captureAckWaiters.get(String(event.data.captureAckId || ''))?.(event.data.ok === true);
      return;
    }
    if (event.data.type === 'start') enabled = true;
    if (event.data.type === 'stop') { enabled = false; stopAutoScroll(); }
  });

  if (startAtLoad && (location.pathname.startsWith('/collection') || /^\/playlist\/[^/]+/.test(location.pathname))) startAutoScroll();
})();
