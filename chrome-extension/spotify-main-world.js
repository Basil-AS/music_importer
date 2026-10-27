(() => {
  const marker = 'music-importer-spotify';
  const endpoint = 'https://api-partner.spotify.com/pathfinder/v2/query';
  const pageSize = 1000;
  const queryHashes = new Map([
    ['fetchLibraryTracks', '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240'],
    ['libraryV3', '973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3'],
    ['fetchPlaylistContents', '32b05e92e438438408674f95d0fdad8082865dc32acd55bd97f5113b8579092b'],
  ]);
  let sessionHeaders = null;
  let scanPromise = null;
  let lastQueryAt = 0;

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  function getHeaderBag(input, init) {
    try {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [name, value] of new Headers(init?.headers || {})) headers.set(name, value);
      return headers;
    } catch {
      return new Headers();
    }
  }

  function inspectRequest(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/pathfinder/v2/query')) return;
    const headers = getHeaderBag(input, init);
    const authorization = headers.get('authorization');
    const clientToken = headers.get('client-token');
    if (authorization?.startsWith('Bearer ') && clientToken) {
      // Keep Web Player credentials only in this page's private closure. They are never
      // posted to the extension or app; only normalized library records cross the bridge.
      sessionHeaders = {
        authorization,
        'client-token': clientToken,
        'app-platform': headers.get('app-platform') || 'WebPlayer',
      };
    }
    const body = typeof init?.body === 'string' ? init.body : null;
    if (!body) return;
    try {
      const payload = JSON.parse(body);
      const name = String(payload.operationName || '');
      const hash = payload.extensions?.persistedQuery?.sha256Hash;
      if (name && /^[a-f0-9]{64}$/i.test(String(hash || ''))) queryHashes.set(name, String(hash));
    } catch { /* Non-JSON Pathfinder requests are ignored. */ }
  }

  const originalFetch = window.fetch;
  window.fetch = function musicImporterSpotifyFetch(input, init) {
    inspectRequest(input, init);
    return originalFetch.call(this, input, init);
  };

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function discoverHashes(names) {
    const scripts = [...document.querySelectorAll('script[src]')]
      .map((script) => script.src)
      .filter((src) => {
        try { return new URL(src).hostname.endsWith('spotifycdn.com') && src.endsWith('.js'); }
        catch { return false; }
      });
    for (const src of scripts) {
      let source;
      try {
        const response = await originalFetch.call(window, src);
        if (!response.ok) continue;
        source = await response.text();
      } catch { continue; }
      for (const name of names) {
        const pattern = new RegExp(`\\W${escapeRegExp(name)}\\W[\\s\\S]{0,200}?(?<![0-9a-f])([0-9a-f]{64})(?![0-9a-f])`);
        const hash = pattern.exec(source)?.[1];
        if (hash) queryHashes.set(name, hash);
      }
      if (names.every((name) => queryHashes.has(name))) return;
    }
  }

  async function waitForSession(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (!sessionHeaders && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!sessionHeaders) throw new Error('Spotify не передал активные заголовки сессии. Откройте «Любимые треки» и повторите.');
    return sessionHeaders;
  }

  async function query(operationName, variables) {
    const headers = await waitForSession();
    let hash = queryHashes.get(operationName);
    if (!hash) throw new Error(`В bundle Spotify не найден query hash для ${operationName}.`);
    const spacing = 300 - (Date.now() - lastQueryAt);
    if (spacing > 0) await new Promise((resolve) => setTimeout(resolve, spacing));
    let retries = 0;
    let hashRefreshes = 0;
    while (true) {
      lastQueryAt = Date.now();
      const response = await originalFetch.call(window, endpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      if (response.status === 429 && retries < 4) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** retries);
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60000)));
        continue;
      }
      if (!response.ok) throw new Error(`${operationName}: HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.errors?.length) {
        const errorMessage = String(payload.errors[0]?.message || 'ошибка GraphQL');
        if (/persisted.?query.?not.?found/i.test(errorMessage) && hashRefreshes < 1) {
          const previousHash = hash;
          await discoverHashes([operationName]);
          hash = queryHashes.get(operationName);
          hashRefreshes += 1;
          if (hash && hash !== previousHash) continue;
        }
        throw new Error(`${operationName}: ${errorMessage}`);
      }
      if (!payload.data) throw new Error(`${operationName}: пустой ответ Spotify.`);
      return payload.data;
    }
  }

  function trackFrom(data, idOverride = null) {
    const uri = String(idOverride || data?.uri || '');
    if (!uri.startsWith('spotify:track:')) return null;
    const artists = data?.artists?.items || data?.artists || [];
    const album = data?.albumOfTrack || data?.album || {};
    const artistNames = artists.map((artist) => ({ id: String(artist?.uri || ''), name: String(artist?.profile?.name || artist?.name || '') })).filter((artist) => artist.name);
    const duration = Number(data?.duration?.totalMilliseconds || data?.trackDuration?.totalMilliseconds || data?.duration_ms || 0);
    return {
      id: uri,
      title: String(data?.name || ''),
      artists: artistNames,
      album: { name: String(album?.name || '') },
      isrc: String(data?.externalIds?.isrc || data?.external_ids?.isrc || ''),
      durationMs: Number.isFinite(duration) ? duration : 0,
    };
  }

  async function readFavorites() {
    const tracksData = [];
    let total = null;
    for (let offset = 0; total === null || offset < total; offset += pageSize) {
      const data = await query('fetchLibraryTracks', { offset, limit: pageSize });
      const library = data?.me?.library?.tracks;
      if (!Array.isArray(library?.items) || !Number.isInteger(library.totalCount)) throw new Error('Неожиданный ответ Spotify с любимыми треками.');
      if (total !== null && total !== library.totalCount) throw new Error('Spotify изменил число любимых треков во время чтения.');
      total = library.totalCount;
      tracksData.push(...library.items);
      post('scan-progress', { phase: 'favorites', message: `Собираем Spotify Liked Songs: ${Math.min(tracksData.length, total)} из ${total}.` });
      if (library.items.length === 0 && offset < total) throw new Error('Spotify вернул пустую страницу до конца библиотеки.');
    }
    const tracks = tracksData.map((row) => trackFrom(row?.track?.data, row?.track?._uri)).filter(Boolean);
    const unique = new Set(tracks.map((track) => track.id));
    if (tracks.length !== total || unique.size !== tracks.length) throw new Error('Число любимых треков Spotify не сошлось с totalCount.');
    return { tracks, total };
  }

  async function readPlaylists() {
    const playlists = [];
    let total = null;
    for (let offset = 0; total === null || offset < total; offset += 50) {
      const data = await query('libraryV3', {
        filters: ['Playlists'], order: null, textFilter: '',
        features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'EVENTS'],
        limit: 50, offset, flatten: true, expandedFolders: [], folderUri: null,
        includeFoldersWhenFlattening: false,
      });
      const library = data?.me?.libraryV3;
      if (!Array.isArray(library?.items) || !Number.isInteger(library.totalCount)) throw new Error('Неожиданный ответ Spotify с каталогом плейлистов.');
      if (total !== null && total !== library.totalCount) throw new Error('Spotify изменил число плейлистов во время чтения.');
      total = library.totalCount;
      for (const row of library.items) {
        const wrapper = row?.item;
        const uri = String(wrapper?._uri || wrapper?.data?.uri || '');
        if (!uri.startsWith('spotify:playlist:')) continue;
        const data = wrapper?.data || {};
        playlists.push({ id: uri, title: String(data.name || ''), trackCount: Number.isInteger(data.totalLength) ? data.totalLength : null });
      }
      post('scan-progress', { phase: 'playlists', message: `Найдено плейлистов Spotify: ${playlists.length} из ${total}.` });
      if (library.items.length === 0 && offset < total) throw new Error('Spotify вернул пустую страницу каталога до конца.');
    }
    if (playlists.length !== total || new Set(playlists.map((playlist) => playlist.id)).size !== playlists.length) {
      throw new Error('Число или уникальность плейлистов Spotify не сошлись с totalCount.');
    }
    return playlists;
  }

  async function readPlaylist(playlist) {
    const rows = [];
    let total = null;
    for (let offset = 0; total === null || offset < total; offset += pageSize) {
      const data = await query('fetchPlaylistContents', { uri: playlist.id, offset, limit: pageSize, includeEpisodeContentRatingsV2: true });
      const page = data?.playlistV2?.content;
      if (!Array.isArray(page?.items) || !Number.isInteger(page.totalCount)) throw new Error(`Неожиданный ответ плейлиста «${playlist.title}».`);
      if (total !== null && total !== page.totalCount) throw new Error(`Spotify изменил число треков плейлиста «${playlist.title}» во время чтения.`);
      total = page.totalCount;
      const pageOffset = Number(page?.pagingInfo?.offset ?? offset);
      if (pageOffset !== offset) throw new Error(`Spotify вернул неверный offset для «${playlist.title}».`);
      rows.push(...page.items);
      post('scan-progress', { phase: 'playlist-items', message: `Читаем «${playlist.title}»: ${Math.min(rows.length, total)} из ${total}.` });
      if (page.items.length === 0 && offset < total) throw new Error(`Spotify вернул пустую страницу плейлиста «${playlist.title}».`);
    }
    const tracks = rows.map((row) => trackFrom(row?.itemV2?.data)).filter(Boolean).map((track, position) => ({ ...track, position }));
    const playlistTotal = total ?? 0;
    if (rows.length !== playlistTotal || tracks.length !== rows.length) throw new Error(`Не все элементы плейлиста «${playlist.title}» удалось прочитать.`);
    return { ...playlist, trackCount: playlistTotal, complete: true, tracks };
  }

  async function scanLibrary() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      await waitForSession();
      await discoverHashes(['fetchLibraryTracks', 'libraryV3', 'fetchPlaylistContents']);
      const [favorites, playlistCatalog] = await Promise.all([readFavorites(), readPlaylists()]);
      const playlists = [];
      for (const [index, playlist] of playlistCatalog.entries()) {
        post('scan-progress', { phase: 'playlist-items', message: `Плейлист ${index + 1} из ${playlistCatalog.length}: ${playlist.title}.` });
        playlists.push(await readPlaylist(playlist));
      }
      return {
        schemaVersion: 1,
        service: 'spotify',
        collection: { type: 'library', name: 'Вся библиотека' },
        completeness: {
          confirmed: true,
          favoritesConfirmed: true,
          favoritesCount: favorites.total,
          catalogConfirmed: true,
          playlistItemsConfirmed: playlists.every((playlist) => playlist.complete),
          playlistItemsTotal: playlists.length,
        },
        tracks: favorites.tracks.map((track) => ({ ...track, collectionType: 'favorites' })),
        playlists,
      };
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type !== 'start-library-scan') return;
    try {
      post('scan-progress', { phase: 'reading', message: 'Читаем лайки и плейлисты Spotify…' });
      const payload = await scanLibrary();
      post('library-snapshot', { payload });
    } catch (error) {
      post('scan-error', { error: error instanceof Error ? error.message : 'Не удалось прочитать библиотеку Spotify.' });
    }
  });
})();
