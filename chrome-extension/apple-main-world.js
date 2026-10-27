(() => {
  const marker = 'music-importer-apple';
  const apiHost = 'amp-api.music.apple.com';
  const apiBase = `https://${apiHost}`;
  const pageSize = 100;
  let sessionHeaders = null;
  let scanPromise = null;

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  function headerBag(input, init) {
    try {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [name, value] of new Headers(init?.headers || {})) headers.set(name, value);
      return headers;
    } catch {
      return new Headers();
    }
  }

  function captureSession(input, init) {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '', location.href); }
    catch { return; }
    if (url.hostname !== apiHost || !url.pathname.startsWith('/v1/')) return;
    const headers = headerBag(input, init);
    const authorization = headers.get('authorization');
    const musicUserToken = headers.get('music-user-token');
    if (!authorization?.startsWith('Bearer ') || !musicUserToken) return;

    // Credentials stay only in this page closure. The extension and app receive normalized library data only.
    sessionHeaders = { authorization, 'music-user-token': musicUserToken };
  }

  const originalFetch = window.fetch;
  window.fetch = function musicImporterAppleFetch(input, init) {
    captureSession(input, init);
    return originalFetch.call(this, input, init);
  };

  async function waitForSession(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!sessionHeaders && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!sessionHeaders) throw new Error('Apple Music не передал сессию API. Откройте библиотеку в Apple Music и повторите.');
    return sessionHeaders;
  }

  function safeNext(value) {
    if (!value) return null;
    let url;
    try { url = new URL(value, apiBase); }
    catch { throw new Error('Apple Music вернул некорректную ссылку следующей страницы.'); }
    if (url.origin !== apiBase || !url.pathname.startsWith('/v1/me/')) throw new Error('Apple Music вернул ссылку пагинации за пределы личной библиотеки.');
    return `${url.pathname}${url.search}`;
  }

  async function request(path) {
    const headers = await waitForSession();
    const url = new URL(path, apiBase);
    if (url.origin !== apiBase || !url.pathname.startsWith('/v1/me/')) throw new Error('Разрешены только запросы к личной библиотеке Apple Music.');
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        response = await originalFetch.call(window, url.href, {
          method: 'GET',
          credentials: 'include',
          headers: { ...headers, Accept: 'application/json' },
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        continue;
      }
      if (response.ok) break;
      if (response.status !== 429 && response.status < 500 || attempt === 3) {
        throw new Error(`Apple Music: HTTP ${response.status} при чтении библиотеки.`);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 10000)));
    }
    if (!response?.ok) throw new Error('Apple Music не ответил после повторных попыток.');
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) throw new Error('Apple Music вернул неожиданный формат библиотеки.');
    return payload;
  }

  async function readPages(initialPath, label) {
    const rows = [];
    const seen = new Set();
    let path = initialPath;
    let expectedTotal = null;
    let pageNumber = 0;
    while (path) {
      if (seen.has(path)) throw new Error(`Apple Music повторил страницу при чтении: ${label}.`);
      seen.add(path);
      const payload = await request(path);
      pageNumber += 1;
      const total = payload.meta?.total;
      if (Number.isInteger(total)) {
        if (expectedTotal !== null && expectedTotal !== total) throw new Error(`Apple Music изменил число элементов во время чтения: ${label}.`);
        expectedTotal = total;
      }
      rows.push(...payload.data);
      post('scan-progress', { message: `${label}: ${rows.length}${expectedTotal === null ? '' : ` из ${expectedTotal}`}.` });
      path = safeNext(payload.next);
      if (pageNumber > 10000) throw new Error(`Слишком много страниц при чтении: ${label}.`);
    }
    if (expectedTotal === null || rows.length !== expectedTotal) throw new Error(`Apple Music не подтвердил полноту списка: ${label}.`);
    return { rows, total: expectedTotal };
  }

  function normalizeTrack(row, position = null) {
    const attributes = row?.attributes || {};
    const title = String(attributes.name || '').trim();
    const artist = String(attributes.artistName || '').trim();
    const id = String(row?.id || '').trim();
    if (!title || !artist || !id) throw new Error('В библиотеке Apple Music найден трек без ID, названия или артиста.');
    return {
      id,
      title,
      artist,
      artists: [artist],
      album: String(attributes.albumName || ''),
      isrc: String(attributes.isrc || ''),
      durationMs: Number(attributes.durationInMillis) || 0,
      inFavorites: attributes.inFavorites === true,
      position,
    };
  }

  async function readPlaylist(playlist, playlistIndex, playlistTotal) {
    const id = String(playlist?.id || '');
    const name = String(playlist?.attributes?.name || '');
    if (!id || !name) throw new Error('В каталоге Apple Music найден плейлист без ID или названия.');
    const result = await readPages(`/v1/me/library/playlists/${encodeURIComponent(id)}/tracks?limit=${pageSize}`, `Плейлист ${playlistIndex + 1} из ${playlistTotal}`);
    const tracks = result.rows.map((row, position) => normalizeTrack(row, position));
    return { id, title: name, name, trackCount: result.total, complete: true, tracks };
  }

  async function scanLibrary() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      await waitForSession();
      const [librarySongs, playlistCatalog] = await Promise.all([
        readPages(`/v1/me/library/songs?limit=${pageSize}`, 'Песни Apple Music'),
        readPages(`/v1/me/library/playlists?limit=${pageSize}`, 'Каталог плейлистов Apple Music'),
      ]);
      const tracks = librarySongs.rows.map((row) => normalizeTrack(row)).filter((track) => track.inFavorites);
      const playlists = [];
      for (const [index, playlist] of playlistCatalog.rows.entries()) {
        playlists.push(await readPlaylist(playlist, index, playlistCatalog.total));
      }
      const playlistItemsConfirmed = playlists.every((playlist) => playlist.complete && playlist.trackCount === playlist.tracks.length);
      return {
        schemaVersion: 1,
        service: 'apple-music',
        collection: { type: 'library', name: 'Вся библиотека' },
        completeness: {
          confirmed: true,
          favoritesConfirmed: true,
          favoritesCount: tracks.length,
          catalogConfirmed: true,
          librarySongsConfirmed: true,
          librarySongsCount: librarySongs.total,
          playlistItemsConfirmed,
          playlistItemsTotal: playlists.length,
        },
        tracks: tracks.map((track) => ({ ...track, collectionType: 'favorites' })),
        playlists,
      };
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type !== 'start-library-scan') return;
    try {
      post('scan-progress', { message: 'Читаем избранное и плейлисты Apple Music…' });
      const payload = await scanLibrary();
      post('library-snapshot', { payload });
    } catch (error) {
      post('scan-error', { error: error instanceof Error ? error.message : 'Не удалось прочитать библиотеку Apple Music.' });
    }
  });
})();
