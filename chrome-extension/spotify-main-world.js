(() => {
  const marker = 'music-importer-spotify';
  const endpoint = 'https://api-partner.spotify.com/pathfinder/v2/query';
  const pageSize = 50;
  const apiTimeoutMs = 45000;
  const scriptTimeoutMs = 15000;
  const queryHashes = new Map([
    ['fetchLibraryTracks', '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240'],
    ['libraryV3', '973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3'],
    ['fetchPlaylistContents', '32b05e92e438438408674f95d0fdad8082865dc32acd55bd97f5113b8579092b'],
    ['addToLibrary', '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148'],
    ['addToPlaylist', 'b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a'],
  ]);
  let sessionHeaders = null;
  let sessionHeaderGeneration = 0;
  let scanPromise = null;
  let lastScanDiagnostic = null;
  const scanQueryDiagnostics = new WeakMap();
  let lastQueryAt = 0;
  let queryStartQueue = Promise.resolve();
  let activeCommandId = '';
  const scanProgressWaiters = new Map();
  let scanProgressSequence = 0;
  let scanTerminalSequence = 0;
  const checkpointWaiters = new Map();
  let checkpointSequence = 0;

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  function scanProgress(detail, timeoutMs = 15000) {
    const progressAckId = `scan-progress-${Date.now()}-${++scanProgressSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        scanProgressWaiters.delete(progressAckId);
        reject(new Error('Spotify не подтвердил обновление статуса сканирования. Перезагрузите страницу Spotify и повторите.'));
      }, timeoutMs);
      scanProgressWaiters.set(progressAckId, (ok) => {
        clearTimeout(timer);
        scanProgressWaiters.delete(progressAckId);
        if (ok) resolve(true);
        else reject(new Error('Spotify не смог передать статус сканирования расширению. Обновите вкладку сервиса и повторите.'));
      });
      post('scan-progress', { ...detail, progressAckId });
    });
  }

  function providerProgress(phase, message) {
    if (activeCommandId) {
      transferProgress(message);
      return Promise.resolve(true);
    }
    return scanProgress({ phase, message });
  }

  function scanTerminal(type, detail, timeoutMs = 15000) {
    const terminalAckId = `scan-terminal-${Date.now()}-${++scanTerminalSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        scanProgressWaiters.delete(terminalAckId);
        reject(new Error('Spotify: приложение не подтвердило получение результата сканирования.'));
      }, timeoutMs);
      scanProgressWaiters.set(terminalAckId, (ok) => {
        clearTimeout(timer);
        scanProgressWaiters.delete(terminalAckId);
        if (ok) resolve(true);
        else reject(new Error('Spotify: расширение не смогло сохранить результат сканирования.'));
      });
      post(type, { ...detail, terminalAckId });
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker
      || !['scan-progress-ack', 'scan-terminal-ack'].includes(event.data?.type)) return;
    const ackId = event.data.type === 'scan-progress-ack' ? event.data.progressAckId : event.data.terminalAckId;
    scanProgressWaiters.get(String(ackId || ''))?.(event.data.ok === true);
  });

  function scanPageCoordinates(variables) {
    const page = {};
    if (Number.isInteger(variables?.offset) && variables.offset >= 0) page.offset = variables.offset;
    if (Number.isInteger(variables?.limit) && variables.limit >= 0) page.limit = variables.limit;
    return page;
  }

  function emitScanDiagnostic(operation, variables, startedAt, result) {
    if (!scanPromise || activeCommandId) return;
    const diagnostic = {
      operation,
      ...scanPageCoordinates(variables),
      elapsedMs: Math.max(0, Date.now() - startedAt),
      result,
    };
    lastScanDiagnostic = diagnostic;
    const page = [diagnostic.offset, diagnostic.limit].filter(Number.isInteger).join('/');
    post('scan-progress', {
      phase: 'diagnostic',
      message: `Spotify scan: ${operation}${page ? ` ${page}` : ''} · ${diagnostic.elapsedMs} мс · ${result.code || `HTTP ${result.status}`}`,
      diagnostic,
    });
    return diagnostic;
  }

  function failScanShape(operation, variables, code, message, responseData) {
    const request = responseData && typeof responseData === 'object' ? scanQueryDiagnostics.get(responseData) : null;
    const startedAt = request?.operation === operation ? request.startedAt : Date.now();
    emitScanDiagnostic(operation, variables, startedAt, { code });
    throw new Error(message);
  }

  function scanDiagnosticSummary(diagnostic) {
    if (!diagnostic || typeof diagnostic.operation !== 'string') return '';
    const page = [diagnostic.offset, diagnostic.limit].filter(Number.isInteger).join('/');
    const result = diagnostic.result?.code || (Number.isInteger(diagnostic.result?.status) ? `HTTP ${diagnostic.result.status}` : 'unknown');
    return `Диагностика: ${diagnostic.operation}${page ? ` ${page}` : ''} · ${diagnostic.elapsedMs} мс · ${result}.`;
  }

  function awaitCheckpoint(requestId, progress) {
    const checkpointId = `${requestId}:${++checkpointSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        checkpointWaiters.delete(checkpointId);
        resolve(false);
      }, 20000);
      checkpointWaiters.set(checkpointId, (ok) => {
        clearTimeout(timer);
        checkpointWaiters.delete(checkpointId);
        resolve(ok === true);
      });
      post('transfer-progress', { requestId, progress: { ...progress, checkpointId } });
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker
      || event.data?.type !== 'transfer-progress-ack') return;
    checkpointWaiters.get(String(event.data.checkpointId || ''))?.(event.data.ok === true);
  });

  function retryAfterDelay(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  function transferProgress(message) {
    if (activeCommandId) post('transfer-progress', { requestId: activeCommandId, progress: { message } });
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
      sessionHeaderGeneration += 1;
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
    const unresolvedNames = names.filter((name) => !queryHashes.has(name));
    if (!unresolvedNames.length) return;
    const scripts = [...document.querySelectorAll('script[src]')]
      .map((script) => script.src)
      .filter((src) => {
        try { return new URL(src).hostname.endsWith('spotifycdn.com') && src.endsWith('.js'); }
        catch { return false; }
      });
    for (const src of scripts) {
      let source;
      try {
        const response = await fetchWithTimeout(src, {}, scriptTimeoutMs);
        if (!response.ok) continue;
        source = await response.text();
      } catch { continue; }
      for (const name of unresolvedNames) {
        const pattern = new RegExp(`\\W${escapeRegExp(name)}\\W[\\s\\S]{0,200}?(?<![0-9a-f])([0-9a-f]{64})(?![0-9a-f])`);
        const hash = pattern.exec(source)?.[1];
        if (hash) queryHashes.set(name, hash);
      }
      if (unresolvedNames.every((name) => queryHashes.has(name))) return;
    }
  }

  async function waitForSession(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (!sessionHeaders && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!sessionHeaders) throw new Error('Spotify не передал активные заголовки сессии. Откройте «Любимые треки» и повторите.');
    return sessionHeaders;
  }

  async function fetchWithTimeout(input, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await originalFetch.call(window, input, { ...init, signal: controller.signal });
      // Fetch resolves when headers arrive. Keep the abort timer active until the body
      // has arrived too, otherwise a stalled JSON body can leave a library scan pending.
      if (response.ok) await response.clone().arrayBuffer();
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Spotify не ответил за ${Math.ceil(timeoutMs / 1000)} с. Повторите сканирование.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForRateLimit(waitMs, operationName) {
    let remaining = waitMs;
    while (remaining > 0) {
      const interval = Math.min(remaining, 15000);
      await new Promise((resolve) => setTimeout(resolve, interval));
      remaining -= interval;
      const seconds = Math.ceil(remaining / 1000);
      const message = seconds
        ? `Spotify ограничил запросы; ждём ещё ${seconds} с (${operationName}).`
        : `Spotify продолжит запрос (${operationName}).`;
      if (activeCommandId) transferProgress(message);
      else await providerProgress('rate-limit', message);
    }
  }

  async function reserveQueryStart() {
    const previous = queryStartQueue;
    let release;
    queryStartQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const spacing = 300 - (Date.now() - lastQueryAt);
      if (spacing > 0) await new Promise((resolve) => setTimeout(resolve, spacing));
      lastQueryAt = Date.now();
    } finally {
      release();
    }
  }

  async function query(operationName, variables) {
    const startedAt = Date.now();
    let headers = await waitForSession();
    let headerGeneration = sessionHeaderGeneration;
    let hash = queryHashes.get(operationName);
    if (!hash) throw new Error(`В bundle Spotify не найден query hash для ${operationName}.`);
    let retries = 0;
    let hashRefreshes = 0;
    let sessionRefreshes = 0;
    while (true) {
      await reserveQueryStart();
      let response;
      try {
        response = await fetchWithTimeout(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
        }, apiTimeoutMs);
      } catch (error) {
        const code = /не ответил за/i.test(error?.message || '') ? 'request_timeout' : 'network_error';
        emitScanDiagnostic(operationName, variables, startedAt, { code });
        if (code === 'request_timeout') throw error;
        throw new Error('Не удалось выполнить запрос Spotify. Повторите сканирование.');
      }
      if (response.status === 429 && retries < 4) {
        const retryAfter = retryAfterDelay(response.headers.get('retry-after'));
        const waitMs = retryAfter === null ? 1000 * (2 ** retries) : retryAfter;
        retries += 1;
        await waitForRateLimit(waitMs, operationName);
        continue;
      }
      if (response.status === 401 && sessionRefreshes < 1) {
        sessionRefreshes += 1;
        const message = 'Spotify отклонил запрос. Проверяем, обновилась ли сессия страницы…';
        if (activeCommandId) transferProgress(message);
        else await providerProgress('auth-refresh', message);
        for (let attempt = 0; attempt < 32 && sessionHeaderGeneration <= headerGeneration; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (sessionHeaderGeneration > headerGeneration && sessionHeaders) {
          headers = sessionHeaders;
          headerGeneration = sessionHeaderGeneration;
          continue;
        }
      }
      if (!response.ok) {
        emitScanDiagnostic(operationName, variables, startedAt, { status: response.status });
        throw Object.assign(new Error(`${operationName}: HTTP ${response.status}`), {
        status: response.status,
        retryAfter: response.headers.get('retry-after') || null,
        });
      }
      let payload;
      try { payload = await response.json(); }
      catch {
        emitScanDiagnostic(operationName, variables, startedAt, { code: 'invalid_json' });
        throw new Error(`${operationName}: Spotify returned invalid JSON.`);
      }
      if (payload.errors?.length) {
        const errorMessage = String(payload.errors[0]?.message || 'ошибка GraphQL');
        if (/persisted.?query.?not.?found/i.test(errorMessage) && hashRefreshes < 1) {
          const previousHash = hash;
          queryHashes.delete(operationName);
          await discoverHashes([operationName]);
          hash = queryHashes.get(operationName);
          hashRefreshes += 1;
          if (hash && hash !== previousHash) continue;
        }
        emitScanDiagnostic(operationName, variables, startedAt, { code: 'provider_error' });
        throw new Error(`${operationName}: Spotify returned a provider error.`);
      }
      if (!payload.data) {
        emitScanDiagnostic(operationName, variables, startedAt, { code: 'missing_data' });
        throw new Error(`${operationName}: Spotify returned no data.`);
      }
      const diagnostic = emitScanDiagnostic(operationName, variables, startedAt, { status: response.status });
      if (diagnostic && payload.data && typeof payload.data === 'object') {
        scanQueryDiagnostics.set(payload.data, { operation: operationName, startedAt });
      }
      return payload.data;
    }
  }

  function trackFrom(data, idOverride = null) {
    const uri = String(idOverride || data?.uri || '');
    if (!uri.startsWith('spotify:track:')) return null;
    const artists = data?.artists?.items || data?.artists || [];
    const album = data?.albumOfTrack || data?.album || {};
    const albumImages = album?.images || album?.coverArt?.sources || [];
    const artistNames = artists.map((artist) => ({ id: String(artist?.uri || ''), name: String(artist?.profile?.name || artist?.name || '') })).filter((artist) => artist.name);
    const duration = Number(data?.duration?.totalMilliseconds || data?.trackDuration?.totalMilliseconds || data?.duration_ms || 0);
    return {
      id: uri,
      title: String(data?.name || ''),
      artists: artistNames,
      album: { name: String(album?.name || '') },
      artworkUrl: String(albumImages.slice().sort((left, right) => (Number(right?.width) || 0) - (Number(left?.width) || 0))[0]?.url || ''),
      releaseDate: String(album?.releaseDate || album?.date?.isoString || ''),
      isrc: String(data?.externalIds?.isrc || data?.external_ids?.isrc || ''),
      durationMs: Number.isFinite(duration) ? duration : 0,
    };
  }

  async function readFavorites() {
    const tracksData = [];
    let total = null;
    let lastPageData = null;
    let lastOffset = 0;
    for (let offset = 0; total === null || offset < total;) {
      await providerProgress('favorites', `Читаем Spotify Liked Songs: страница с ${offset + 1}…`);
      const data = await query('fetchLibraryTracks', { offset, limit: pageSize });
      lastPageData = data;
      lastOffset = offset;
      const library = data?.me?.library?.tracks;
      if (!Array.isArray(library?.items) || !Number.isInteger(library.totalCount)) failScanShape('fetchLibraryTracks', { offset, limit: pageSize }, 'invalid_page_shape', 'Неожиданный ответ Spotify с любимыми треками.', data);
      if (total !== null && total !== library.totalCount) failScanShape('fetchLibraryTracks', { offset, limit: pageSize }, 'total_changed', 'Spotify изменил число любимых треков во время чтения.', data);
      const pageOffset = Number(library?.pagingInfo?.offset ?? offset);
      if (!Number.isInteger(pageOffset) || pageOffset !== offset) failScanShape('fetchLibraryTracks', { offset, limit: pageSize }, 'unexpected_offset', 'Spotify вернул неверное смещение страницы любимых треков.', data);
      total = library.totalCount;
      tracksData.push(...library.items);
      await providerProgress('favorites', `Собираем Spotify Liked Songs: ${Math.min(tracksData.length, total)} из ${total}.`);
      if (library.items.length === 0 && offset < total) failScanShape('fetchLibraryTracks', { offset, limit: pageSize }, 'empty_page', 'Spotify вернул пустую страницу до конца библиотеки.', data);
      offset = pageOffset + library.items.length;
    }
    const tracks = tracksData.map((row) => trackFrom(row?.track?.data, row?.track?._uri)).filter(Boolean);
    const unique = new Set(tracks.map((track) => track.id));
    if (tracks.length !== total || unique.size !== tracks.length) {
      failScanShape('fetchLibraryTracks', { offset: lastOffset, limit: pageSize }, 'track_count_mismatch', 'Число любимых треков Spotify не сошлось с totalCount.', lastPageData);
    }
    return { tracks, total };
  }

  async function readPlaylists() {
    const playlists = [];
    let total = null;
    let lastPageData = null;
    let lastOffset = 0;
    for (let offset = 0; total === null || offset < total;) {
      await providerProgress('playlists', `Читаем каталог плейлистов Spotify: страница с ${offset + 1}…`);
      const data = await query('libraryV3', {
        filters: ['Playlists'], order: null, textFilter: '',
        features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'EVENTS'],
        limit: 50, offset, flatten: true, expandedFolders: [], folderUri: null,
        includeFoldersWhenFlattening: false,
      });
      lastPageData = data;
      lastOffset = offset;
      const library = data?.me?.libraryV3;
      if (!Array.isArray(library?.items) || !Number.isInteger(library.totalCount)) failScanShape('libraryV3', { offset, limit: 50 }, 'invalid_page_shape', 'Неожиданный ответ Spotify с каталогом плейлистов.', data);
      if (total !== null && total !== library.totalCount) failScanShape('libraryV3', { offset, limit: 50 }, 'total_changed', 'Spotify изменил число плейлистов во время чтения.', data);
      total = library.totalCount;
      for (const row of library.items) {
        const wrapper = row?.item;
        const uri = String(wrapper?._uri || wrapper?.data?.uri || '');
        if (!uri.startsWith('spotify:playlist:')) continue;
        const data = wrapper?.data || {};
        playlists.push({ id: uri, title: String(data.name || ''), trackCount: Number.isInteger(data.totalLength) ? data.totalLength : null });
      }
      await providerProgress('playlists', `Найдено плейлистов Spotify: ${playlists.length} из ${total}.`);
      if (library.items.length === 0 && offset < total) failScanShape('libraryV3', { offset, limit: 50 }, 'empty_page', 'Spotify вернул пустую страницу каталога до конца.', data);
      offset += library.items.length;
    }
    if (playlists.length !== total || new Set(playlists.map((playlist) => playlist.id)).size !== playlists.length) {
      failScanShape('libraryV3', { offset: lastOffset, limit: 50 }, 'catalog_count_mismatch', 'Число или уникальность плейлистов Spotify не сошлись с totalCount.', lastPageData);
    }
    return playlists;
  }

  async function readPlaylist(playlist) {
    const rows = [];
    let total = null;
    let lastPageData = null;
    let lastOffset = 0;
    for (let offset = 0; total === null || offset < total;) {
      await providerProgress('playlist-items', `Запрашиваем треки плейлиста «${playlist.title}» с позиции ${offset + 1}…`);
      const data = await query('fetchPlaylistContents', { uri: playlist.id, offset, limit: pageSize, includeEpisodeContentRatingsV2: true });
      lastPageData = data;
      lastOffset = offset;
      const page = data?.playlistV2?.content;
      if (!Array.isArray(page?.items) || !Number.isInteger(page.totalCount)) failScanShape('fetchPlaylistContents', { offset, limit: pageSize }, 'invalid_page_shape', 'Неожиданный ответ плейлиста Spotify.', data);
      if (total !== null && total !== page.totalCount) failScanShape('fetchPlaylistContents', { offset, limit: pageSize }, 'total_changed', 'Spotify изменил число элементов плейлиста во время чтения.', data);
      total = page.totalCount;
      const pageOffset = Number(page?.pagingInfo?.offset ?? offset);
      if (pageOffset !== offset) failScanShape('fetchPlaylistContents', { offset, limit: pageSize }, 'unexpected_offset', 'Spotify вернул неверное смещение страницы плейлиста.', data);
      rows.push(...page.items);
      offset = pageOffset + page.items.length;
      await providerProgress('playlist-items', `Читаем «${playlist.title}»: ${Math.min(rows.length, total)} из ${total}.`);
      if (page.items.length === 0 && offset < total) failScanShape('fetchPlaylistContents', { offset, limit: pageSize }, 'empty_page', 'Spotify вернул пустую страницу плейлиста.', data);
    }
    const tracks = rows.map((row) => trackFrom(row?.itemV2?.data)).filter(Boolean).map((track, position) => ({ ...track, position }));
    const playlistTotal = total ?? 0;
    if (rows.length !== playlistTotal || tracks.length !== rows.length) failScanShape('fetchPlaylistContents', { offset: lastOffset, limit: pageSize }, 'item_count_mismatch', 'Не все элементы плейлиста удалось прочитать.', lastPageData);
    return { ...playlist, trackCount: playlistTotal, complete: true, tracks };
  }

  function spotifyCandidate(item) {
    const track = item?.track || item;
    const uri = String(track?.uri || (track?.id ? `spotify:track:${track.id}` : ''));
    const artists = Array.isArray(track?.artists) ? track.artists : [];
    if (!uri.startsWith('spotify:track:') || !track?.name || !artists.length) return null;
    return {
      uri,
      id: uri,
      trackId: uri,
      trackName: String(track.name),
      title: String(track.name),
      artistName: artists.map((artist) => artist?.name).filter(Boolean).join(', '),
      artists: artists.map((artist) => ({ id: artist?.id || '', name: artist?.name || '' })).filter((artist) => artist.name),
      collectionName: String(track.album?.name || ''),
      album: { name: String(track.album?.name || '') },
      artworkUrl: String(track.album?.images?.slice().sort((left, right) => (Number(right?.width) || 0) - (Number(left?.width) || 0))[0]?.url || ''),
      releaseDate: String(track.album?.release_date || ''),
      isrc: String(track.external_ids?.isrc || ''),
      durationMs: Number(track.duration_ms) || 0,
    };
  }

  async function searchCatalog(term) {
    const normalized = String(term || '').trim().slice(0, 400);
    if (!normalized) throw new Error('Введите название песни или исполнителя.');
    const headers = await waitForSession();
    const params = new URLSearchParams({ q: normalized, type: 'track', limit: '10', market: 'from_token' });
    await reserveQueryStart();
    const response = await originalFetch.call(window, `https://api.spotify.com/v1/search?${params}`, {
      method: 'GET', credentials: 'include', headers: { ...headers, Accept: 'application/json' },
    });
    if (!response.ok) throw Object.assign(new Error(`Каталог Spotify: HTTP ${response.status}.`), {
      status: response.status,
      retryAfter: response.headers?.get?.('retry-after') || null,
    });
    const payload = await response.json();
    if (!Array.isArray(payload?.tracks?.items)) throw new Error('Spotify вернул неожиданный ответ каталога.');
    return payload.tracks.items.map(spotifyCandidate).filter(Boolean);
  }

  async function searchAlbumTracks(albumName, artistName) {
    const album = String(albumName || '').trim().slice(0, 200);
    const artist = String(artistName || '').trim().slice(0, 200);
    if (!album || !artist) throw new Error('Для пакетного поиска Spotify нужны альбом и артист.');
    const headers = await waitForSession();
    const fetchCatalog = async (url, label) => {
      await reserveQueryStart();
      const response = await originalFetch.call(window, url, {
        method: 'GET', credentials: 'include', headers: { ...headers, Accept: 'application/json' },
      });
      if (!response.ok) throw Object.assign(new Error(`Каталог Spotify: HTTP ${response.status} (${label}).`), {
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') || null,
      });
      return response.json();
    };
    const searchParams = new URLSearchParams({ q: `album:${album} artist:${artist}`, type: 'album', limit: '5', market: 'from_token' });
    const search = await fetchCatalog(`https://api.spotify.com/v1/search?${searchParams}`, 'поиск альбома');
    if (!Array.isArray(search?.albums?.items)) throw new Error('Spotify вернул неизвестную выдачу альбомов.');
    const candidates = new Map();
    for (const albumResult of search.albums.items.slice(0, 3)) {
      const albumId = String(albumResult?.id || '').trim();
      if (!albumId) continue;
      let offset = 0;
      let total = null;
      const seen = new Set();
      while (total === null || offset < total) {
        if (seen.has(offset)) throw new Error('Spotify повторил страницу треклиста альбома.');
        seen.add(offset);
        const params = new URLSearchParams({ limit: '50', offset: String(offset), market: 'from_token' });
        const page = await fetchCatalog(`https://api.spotify.com/v1/albums/${encodeURIComponent(albumId)}/tracks?${params}`, 'треклист альбома');
        if (!Array.isArray(page?.items) || !Number.isInteger(page.total)) throw new Error('Spotify вернул неизвестный формат треклиста альбома.');
        if (total !== null && total !== page.total) throw new Error('Spotify изменил число треков альбома во время чтения.');
        total = page.total;
        for (const row of page.items) {
          const candidate = spotifyCandidate({ ...row, album: { name: albumResult?.name || album } });
          if (candidate?.trackId) candidates.set(candidate.trackId, candidate);
        }
        if (!page.items.length && offset < total) throw new Error('Spotify вернул пустую страницу треклиста альбома до его конца.');
        if (offset + page.items.length <= offset && offset < total) throw new Error('Spotify не продвинул смещение треклиста альбома.');
        offset += page.items.length;
      }
    }
    return [...candidates.values()];
  }

  async function addSpotifyLibraryItems(uris) {
    for (let offset = 0; offset < uris.length; offset += 40) {
      await query('addToLibrary', { libraryItemUris: uris.slice(offset, offset + 40), interactionId: null });
      transferProgress(`Сохраняем в Spotify: ${Math.min(offset + 40, uris.length)} из ${uris.length}.`);
    }
  }

  async function createSpotifyPlaylist(name) {
    const headers = await waitForSession();
    const delta = {
      ops: [{
        kind: 'UPDATE_LIST_ATTRIBUTES',
        updateListAttributes: { newAttributes: { values: { name, formatAttributes: [], pictureSize: [] }, noValue: [] } },
      }],
      info: { source: { client: 'WEBPLAYER' } },
    };
    const response = await originalFetch.call(window, 'https://spclient.wg.spotify.com/playlist/v2/playlist', {
      method: 'POST', credentials: 'include',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(delta),
    });
    if (!response.ok) throw new Error(`Spotify: не удалось создать плейлист (HTTP ${response.status}).`);
    const payload = await response.json();
    const rawUri = String(payload?.uri || payload?.playlist?.uri || '');
    const playlistUri = rawUri.startsWith('spotify:playlist:')
      ? rawUri
      : rawUri.match(/(?:playlist\/|playlist:)([A-Za-z0-9]{22})/)?.[1]
        ? `spotify:playlist:${rawUri.match(/(?:playlist\/|playlist:)([A-Za-z0-9]{22})/)[1]}`
        : '';
    if (!playlistUri) throw new Error('Spotify создал плейлист, но не вернул его URI для проверки.');
    try {
      await addSpotifyPlaylistToLibrary(playlistUri);
    } catch (error) {
      error.partialPlaylistUri = playlistUri;
      throw error;
    }
    return playlistUri;
  }

  async function addSpotifyPlaylistToLibrary(playlistUri) {
    const headers = await waitForSession();
    const meResponse = await originalFetch.call(window, 'https://api.spotify.com/v1/me', {
      method: 'GET', credentials: 'include', headers: { ...headers, Accept: 'application/json' },
    });
    if (!meResponse.ok) throw new Error(`Spotify не вернул профиль владельца (HTTP ${meResponse.status}).`);
    const me = await meResponse.json();
    const username = String(me?.id || '');
    if (!/^[A-Za-z0-9]{1,64}$/.test(username)) throw new Error('Spotify не вернул ID пользователя для списка плейлистов.');
    const body = {
      deltas: [{
        ops: [{ kind: 'ADD', add: { addLast: true, items: [{ uri: playlistUri, attributes: { timestamp: String(Date.now()), formatAttributes: [], availableSignals: [] } }] } }],
        info: { source: { client: 'WEBPLAYER' } },
      }],
      wantResultingRevisions: false,
      wantSyncResult: false,
      nonces: [],
    };
    const response = await originalFetch.call(window, `https://spclient.wg.spotify.com/playlist/v2/user/${encodeURIComponent(username)}/rootlist/changes`, {
      method: 'POST', credentials: 'include',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Spotify: созданный плейлист не добавлен в библиотеку (HTTP ${response.status}).`);
  }

  async function addSpotifyPlaylistItems(playlistUri, uris, onWritten = () => {}, onProgress = () => {}) {
    for (let offset = 0; offset < uris.length; offset += 100) {
      await query('addToPlaylist', {
        playlistUri,
        playlistItemUris: uris.slice(offset, offset + 100),
        newPosition: { moveType: 'BOTTOM_OF_PLAYLIST', fromUid: null },
        interactionId: null,
      });
      onWritten(Math.min(offset + 100, uris.length));
      onProgress(Math.min(offset + 100, uris.length), uris.length);
    }
  }

  async function restRequest(method, url, label, body = null) {
    const startedAt = Date.now();
    let headers = await waitForSession();
    let headerGeneration = sessionHeaderGeneration;
    let retries = 0;
    let sessionRefreshes = 0;
    while (true) {
      await reserveQueryStart();
      let response;
      try {
        response = await fetchWithTimeout(url, {
          method, credentials: 'include',
          headers: { ...headers, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }, apiTimeoutMs);
      } catch (error) {
        const code = /не ответил за/i.test(error?.message || '') ? 'request_timeout' : 'network_error';
        emitScanDiagnostic(label, null, startedAt, { code });
        if (code === 'request_timeout') throw error;
        throw new Error('Не удалось выполнить запрос Spotify. Повторите операцию.');
      }
      if (response.status === 429 && retries < 4) {
        const retryAfter = retryAfterDelay(response.headers?.get?.('retry-after'));
        const waitMs = retryAfter === null ? 1000 * (2 ** retries) : retryAfter;
        retries += 1;
        await waitForRateLimit(waitMs, label);
        continue;
      }
      if (response.status === 401 && sessionRefreshes < 1) {
        sessionRefreshes += 1;
        const message = 'Spotify отклонил запрос. Проверяем, обновилась ли сессия страницы…';
        if (activeCommandId) transferProgress(message);
        else await providerProgress('auth-refresh', message);
        for (let attempt = 0; attempt < 32 && sessionHeaderGeneration <= headerGeneration; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (sessionHeaderGeneration > headerGeneration && sessionHeaders) {
          headers = sessionHeaders;
          headerGeneration = sessionHeaderGeneration;
          continue;
        }
      }
      if (!response.ok) {
        emitScanDiagnostic(label, null, startedAt, { status: response.status });
        throw Object.assign(new Error(`${label}: HTTP ${response.status}`), {
          status: response.status,
          retryAfter: response.headers?.get?.('retry-after') || null,
        });
      }
      emitScanDiagnostic(label, null, startedAt, { status: response.status });
      if (response.status === 204) return null;
      try { return await response.json(); }
      catch { return null; }
    }
  }

  function albumIdFrom(value) {
    const text = String(value || '').trim();
    const id = text.startsWith('spotify:album:') ? text.slice('spotify:album:'.length) : text;
    return /^[A-Za-z0-9]{22}$/.test(id) ? id : '';
  }

  function albumFrom(data) {
    const id = albumIdFrom(data?.uri || data?.id);
    if (!id) return null;
    const images = Array.isArray(data?.images) ? data.images : [];
    return {
      providerId: `spotify:album:${id}`,
      title: String(data?.name || ''),
      artists: (Array.isArray(data?.artists) ? data.artists : []).map((artist) => String(artist?.name || '')).filter(Boolean),
      upc: String(data?.external_ids?.upc || data?.external_ids?.ean || ''),
      trackCount: Number.isInteger(data?.total_tracks) ? data.total_tracks : null,
      releaseDate: String(data?.release_date || ''),
      artworkUrl: String(images.slice().sort((left, right) => (Number(right?.width) || 0) - (Number(left?.width) || 0))[0]?.url || ''),
    };
  }

  async function readSavedAlbums() {
    const albums = [];
    let total = null;
    for (let offset = 0; total === null || offset < total;) {
      const progressMessage = `Читаем сохранённые альбомы Spotify: страница с ${offset + 1}…`;
      if (activeCommandId) transferProgress(progressMessage);
      else await providerProgress('albums', progressMessage);
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset), market: 'from_token' });
      const page = await restRequest('GET', `https://api.spotify.com/v1/me/albums?${params}`, 'savedAlbums');
      if (!Array.isArray(page?.items) || !Number.isInteger(page.total)) throw Object.assign(new Error('Неожиданный ответ Spotify с сохранёнными альбомами.'), { code: 'invalid_page_shape' });
      if (total !== null && total !== page.total) throw Object.assign(new Error('Spotify изменил число сохранённых альбомов во время чтения.'), { code: 'total_changed' });
      if (Number.isInteger(page.offset) && page.offset !== offset) throw Object.assign(new Error('Spotify вернул неверное смещение страницы альбомов.'), { code: 'unexpected_offset' });
      total = page.total;
      for (const row of page.items) {
        const album = albumFrom(row?.album);
        if (!album) throw Object.assign(new Error('Spotify вернул альбом без ID.'), { code: 'invalid_item_shape' });
        albums.push(album);
      }
      const progressSummary = `Собираем сохранённые альбомы Spotify: ${Math.min(albums.length, total)} из ${total}.`;
      if (activeCommandId) transferProgress(progressSummary);
      else await providerProgress('albums', progressSummary);
      if (page.items.length === 0 && offset < total) throw Object.assign(new Error('Spotify вернул пустую страницу альбомов до конца библиотеки.'), { code: 'empty_page' });
      offset += page.items.length;
    }
    if (albums.length !== total || new Set(albums.map((album) => album.providerId)).size !== albums.length) {
      throw Object.assign(new Error('Число или уникальность сохранённых альбомов Spotify не сошлись с total.'), { code: 'album_count_mismatch' });
    }
    return { albums, total };
  }

  function normalizedUpc(value) {
    return String(value || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
  }

  async function hydrateAlbums(ids) {
    const byId = new Map();
    for (let offset = 0; offset < ids.length; offset += 20) {
      const params = new URLSearchParams({ ids: ids.slice(offset, offset + 20).join(','), market: 'from_token' });
      const payload = await restRequest('GET', `https://api.spotify.com/v1/albums?${params}`, 'albumDetails');
      if (!Array.isArray(payload?.albums)) throw new Error('Spotify вернул неизвестный ответ с данными альбомов.');
      for (const data of payload.albums) {
        const album = albumFrom(data);
        if (album) byId.set(album.providerId, album);
      }
    }
    return [...byId.values()];
  }

  async function searchAlbumIds(q) {
    const params = new URLSearchParams({ q, type: 'album', limit: '5', market: 'from_token' });
    const payload = await restRequest('GET', `https://api.spotify.com/v1/search?${params}`, 'albumSearch');
    if (!Array.isArray(payload?.albums?.items)) throw new Error('Spotify вернул неизвестную выдачу альбомов.');
    return [...new Set(payload.albums.items.map((item) => albumIdFrom(item?.uri || item?.id)).filter(Boolean))];
  }

  async function searchAlbums(title, artist, upc) {
    const name = String(title || '').trim().slice(0, 200);
    const artistName = String(artist || '').trim().slice(0, 200);
    const code = String(upc || '').replace(/[^0-9]/g, '').slice(0, 20);
    if (!code && (!name || !artistName)) throw new Error('Для поиска альбома Spotify нужен UPC либо название и артист.');
    if (code) {
      const hydrated = await hydrateAlbums(await searchAlbumIds(`upc:${code}`));
      const exact = hydrated.filter((album) => normalizedUpc(album.upc) === normalizedUpc(code));
      if (exact.length) return exact.map((album) => ({ ...album, matchedBy: 'upc' }));
    }
    if (!name || !artistName) return [];
    const hydrated = await hydrateAlbums(await searchAlbumIds(`album:${name} artist:${artistName}`));
    return hydrated.map((album) => ({ ...album, matchedBy: 'title_artist' }));
  }

  async function savedAlbumFlags(ids) {
    const flags = new Map();
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      const result = await restRequest('GET', `https://api.spotify.com/v1/me/albums/contains?${new URLSearchParams({ ids: batch.join(',') })}`, 'savedAlbumsContains');
      if (!Array.isArray(result) || result.length !== batch.length || result.some((value) => typeof value !== 'boolean')) {
        throw new Error('Spotify вернул неизвестный ответ проверки сохранённых альбомов.');
      }
      batch.forEach((id, index) => flags.set(id, result[index]));
    }
    return flags;
  }

  async function readAlbums(providerIds) {
    if (Array.isArray(providerIds) && providerIds.length) {
      const ids = [...new Set(providerIds.map(albumIdFrom).filter(Boolean))];
      if (ids.length !== new Set(providerIds.map(String)).size) throw new Error('Некорректный ID альбома Spotify.');
      const flags = await savedAlbumFlags(ids);
      return { complete: true, items: ids.filter((id) => flags.get(id) === true).map((id) => ({ providerId: `spotify:album:${id}` })) };
    }
    const { albums, total } = await readSavedAlbums();
    return { complete: true, total, items: albums };
  }

  async function writeAlbums(targets) {
    const ids = [];
    for (const target of Array.isArray(targets) ? targets : []) {
      if (target?.provider !== 'spotify') throw new Error('Цель альбома не относится к Spotify.');
      const id = albumIdFrom(target.providerId);
      if (!id) throw new Error('Некорректный ID альбома Spotify в плане.');
      if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) throw new Error('В плане нет альбомов Spotify для записи.');
    const flags = await savedAlbumFlags(ids);
    const missing = ids.filter((id) => flags.get(id) !== true);
    for (let offset = 0; offset < missing.length; offset += 20) {
      const batch = missing.slice(offset, offset + 20);
      const checkpointSaved = await awaitCheckpoint(activeCommandId, {
        phase: 'albums', completed: offset, total: missing.length,
      });
      if (!checkpointSaved) throw new Error('Не удалось локально сохранить контрольную точку перед записью альбомов. Запись остановлена без изменения аккаунта.');
      await restRequest('PUT', 'https://api.spotify.com/v1/me/albums', 'saveAlbums', { ids: batch });
      transferProgress(`Сохраняем альбомы в Spotify: ${Math.min(offset + 20, missing.length)} из ${missing.length}.`);
    }
    const verifiedFlags = missing.length ? await savedAlbumFlags(ids) : flags;
    const verified = ids.filter((id) => verifiedFlags.get(id) === true).length;
    const report = { requested: ids.length, written: missing.length, writtenCount: missing.length, alreadyPresent: ids.length - missing.length, verified };
    if (verified !== ids.length) throw Object.assign(new Error('Spotify не подтвердил часть сохранённых альбомов.'), { transferReport: { status: 'partial_failure', albums: report } });
    return report;
  }

  function assertCompletePlan(plan) {
    const hasConfirmedEmptyPlaylist = Array.isArray(plan?.collectionMappings)
      && plan.collectionMappings.some((mapping) => mapping?.completeness?.confirmed === true && mapping.sourceItemCount === 0);
    if (plan?.type !== 'music-transfer-plan' || plan?.target?.provider !== 'spotify'
      || !Array.isArray(plan.operations) || (!plan.operations.length && !hasConfirmedEmptyPlaylist)
      || plan.operations.some((operation) => operation?.target?.provider !== 'spotify' || !operation?.target?.providerId)
      || !Array.isArray(plan.completeness?.source) || !plan.completeness.source.length
      || plan.completeness.source.some((status) => status?.confirmed !== true)) {
      throw new Error('План Spotify неполный или не подтверждена полнота библиотеки источника.');
    }
  }

  async function executeTransfer(plan) {
    assertCompletePlan(plan);
    const favoriteOperations = plan.operations.filter((operation) => operation.operation === 'add_to_favorites');
    const wantedFavoriteUris = [...new Set(favoriteOperations.map((operation) => String(operation.target.providerId)))];
    const existingFavorites = await readFavorites();
    const existingFavoriteUris = new Set(existingFavorites.tracks.map((track) => track.id));
    const missingFavorites = wantedFavoriteUris.filter((uri) => !existingFavoriteUris.has(uri));
    if (missingFavorites.length) await addSpotifyLibraryItems(missingFavorites);
    const verifiedFavorites = await readFavorites();
    const verifiedFavoriteUris = new Set(verifiedFavorites.tracks.map((track) => track.id));
    const unverifiedFavorites = wantedFavoriteUris.filter((uri) => !verifiedFavoriteUris.has(uri));
    const report = {
      status: 'complete',
      favorites: {
        requested: wantedFavoriteUris.length,
        added: missingFavorites.length,
        alreadyPresent: wantedFavoriteUris.length - missingFavorites.length,
        verified: wantedFavoriteUris.length - unverifiedFavorites.length,
      },
      playlists: [],
    };
    if (unverifiedFavorites.length) {
      throw Object.assign(new Error('Spotify не подтвердил часть добавленных лайков.'), {
        transferReport: { ...report, status: 'partial_failure' },
      });
    }
    const operationsByCollection = new Map();
    for (const operation of plan.operations.filter((item) => item.operation === 'add_to_playlist')) {
      const key = String(operation.source?.collectionId || operation.source?.collectionName || 'Плейлист');
      if (!operationsByCollection.has(key)) operationsByCollection.set(key, []);
      operationsByCollection.get(key).push(operation);
    }
    const mappings = new Map((plan.collectionMappings || []).map((mapping) => [String(mapping.sourceId || mapping.sourceName), mapping]));
    const recovery = plan.recovery && typeof plan.recovery === 'object' ? plan.recovery : {};
    const recoveryProgress = recovery.progress && typeof recovery.progress === 'object' ? recovery.progress : {};
    const playlistTargets = recovery.playlistTargets && typeof recovery.playlistTargets === 'object' ? recovery.playlistTargets : {};
    const completedPlaylistCount = recoveryProgress.phase === 'playlists' ? Math.max(0, Number(recoveryProgress.completed) || 0) : 0;
    const reportProgress = (progress) => post('transfer-progress', { requestId: activeCommandId, progress });
    let playlistIndex = 0;
    for (const [sourceKey, mapping] of mappings) {
      const operations = operationsByCollection.get(sourceKey) || [];
      const isConfirmedEmptyPlaylist = mapping.completeness?.confirmed === true && mapping.sourceItemCount === 0;
      if (!operations.length && !isConfirmedEmptyPlaylist) continue;
      const name = String(mapping.targetName || mapping.sourceName || operations[0]?.source?.collectionName || 'Music Import');
      const ordered = operations.slice().sort((a, b) => Number(a.source?.position || 0) - Number(b.source?.position || 0));
      const uris = ordered.map((operation) => String(operation.target.providerId));
      let playlistUri = String(playlistTargets[sourceKey] || '');
      let written = 0;
      try {
        if (!playlistUri && recoveryProgress.sourceKey === sourceKey
          && ['playlist-creating', 'playlist-items'].includes(recoveryProgress.phase)) {
          throw new Error(`Нельзя безопасно продолжить «${name}»: сервис мог создать плейлист, но его ID не сохранился. Сверьте цель вручную.`);
        }
        if (playlistUri) {
          const current = await readPlaylist({ id: playlistUri, title: name, trackCount: null });
          const actual = current.tracks.map((track) => track.id);
          const prefix = actual.length <= uris.length && actual.every((uri, position) => uri === uris[position]);
          if (!prefix) throw new Error(`Содержимое «${name}» не является префиксом плана. Остановил продолжение без записи.`);
          if (playlistIndex < completedPlaylistCount && actual.length !== uris.length) {
            throw new Error(`Плейлист «${name}» отмечен завершённым, но read-back неполный.`);
          }
          const remainder = uris.slice(actual.length);
          if (remainder.length) await addSpotifyPlaylistItems(playlistUri, remainder, (count) => { written = count; }, (completed, total) => reportProgress({
            phase: 'playlist-items', completed, total, sourceKey, targetPlaylistId: playlistUri, playlistIndex,
          }));
        } else {
          if (playlistIndex < completedPlaylistCount) throw new Error(`Не найден сохранённый ID завершённого плейлиста «${name}».`);
          const createCheckpointSaved = await awaitCheckpoint(activeCommandId, {
            phase: 'playlist-creating', completed: playlistIndex, total: mappings.size, sourceKey, playlistIndex,
          });
          if (!createCheckpointSaved) throw new Error('Не удалось локально сохранить контрольную точку перед созданием плейлиста. Запись остановлена без изменения аккаунта.');
          playlistUri = await createSpotifyPlaylist(name);
          const targetCheckpointSaved = await awaitCheckpoint(activeCommandId, {
            phase: 'playlist-items', completed: 0, total: uris.length, sourceKey, targetPlaylistId: playlistUri, playlistIndex,
          });
          if (!targetCheckpointSaved) throw new Error(`Плейлист «${name}» создан, но его ID не сохранён. Сверьте целевой аккаунт вручную; добавление треков остановлено.`);
          if (uris.length) await addSpotifyPlaylistItems(playlistUri, uris, (count) => { written = count; }, (completed, total) => reportProgress({
            phase: 'playlist-items', completed, total, sourceKey, targetPlaylistId: playlistUri, playlistIndex,
          }));
        }
        const verified = await readPlaylist({ id: playlistUri, title: name, trackCount: null });
        const actual = verified.tracks.map((track) => track.id);
        const exact = actual.length === uris.length && actual.every((uri, index) => uri === uris[index]);
        report.playlists.push({ name, uri: playlistUri, requested: uris.length, written, verified: exact ? actual.length : 0, exactOrder: exact });
        if (!exact) throw new Error(`Spotify не подтвердил порядок или состав плейлиста «${name}».`);
        reportProgress({ phase: 'playlists', completed: playlistIndex + 1, total: mappings.size, sourceKey, targetPlaylistId: playlistUri, playlistIndex });
      } catch (error) {
        const failure = { name, uri: playlistUri || error?.partialPlaylistUri || null, requested: uris.length, written, verified: 0, exactOrder: false, error: error instanceof Error ? error.message : 'Ошибка записи плейлиста.' };
        throw Object.assign(error instanceof Error ? error : new Error(failure.error), {
          transferReport: { ...report, status: 'partial_failure', playlists: [...report.playlists, failure] },
        });
      }
      playlistIndex += 1;
    }
    return report;
  }

  async function handleCommand(event) {
    const requestId = String(event.data.requestId || '');
    activeCommandId = requestId;
    try {
      const result = event.data.action === 'search-tracks'
        ? await searchCatalog(event.data.query)
        : event.data.action === 'search-album-tracks'
          ? await searchAlbumTracks(event.data.album, event.data.artist)
          : event.data.action === 'search-albums'
            ? await searchAlbums(event.data.album, event.data.artist, event.data.upc)
            : event.data.action === 'read-albums'
              ? await readAlbums(event.data.ids)
              : event.data.action === 'write-albums'
                ? await writeAlbums(event.data.targets)
                : await executeTransfer(event.data.plan);
      post('command-result', { requestId, ok: true, result });
    } catch (error) {
      post('command-result', {
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : 'Команда Spotify не выполнена.',
        status: Number(error?.status) || null,
        retryAfter: error?.retryAfter || null,
        report: error?.transferReport || null,
      });
    } finally {
      if (activeCommandId === requestId) activeCommandId = '';
    }
  }

  async function scanLibrary() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      lastScanDiagnostic = null;
      await waitForSession();
      await discoverHashes(['fetchLibraryTracks', 'libraryV3', 'fetchPlaylistContents']);
      const favorites = await readFavorites();
      await providerProgress('playlists', `Лайки Spotify сверены: ${favorites.total}. Читаем каталог плейлистов…`);
      const playlistCatalog = await readPlaylists();
      const playlists = [];
      for (const [index, playlist] of playlistCatalog.entries()) {
        await providerProgress('playlist-items', `Плейлист ${index + 1} из ${playlistCatalog.length}: ${playlist.title}.`);
        playlists.push(await readPlaylist(playlist));
      }
      let albums = null;
      let albumsError = '';
      try { albums = await readSavedAlbums(); }
      catch (error) { albumsError = String(error?.code || error?.status || 'albums_unavailable'); }
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
          albumsConfirmed: albums !== null,
          albumsCount: albums ? albums.total : null,
          ...(albumsError ? { albumsError } : {}),
        },
        collections: albums ? [{
          type: 'albums',
          name: 'Альбомы',
          completeness: { confirmed: true, total: albums.total, count: albums.albums.length },
          items: albums.albums,
        }] : [],
        tracks: favorites.tracks.map((track) => ({ ...track, collectionType: 'favorites' })),
        playlists,
      };
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type === 'command') {
      if (!/^[a-z0-9-]{16,80}$/i.test(String(event.data.requestId || '')) || !['search-tracks', 'search-album-tracks', 'search-albums', 'read-albums', 'write-albums', 'execute-transfer'].includes(event.data.action)) return;
      void handleCommand(event);
      return;
    }
    if (event.data.type !== 'start-library-scan') return;
    let payload;
    try {
      await scanProgress({ phase: 'reading', message: 'Читаем лайки и плейлисты Spotify…' });
      payload = await scanLibrary();
    } catch (error) {
      try { await scanTerminal('scan-error', {
        error: [error instanceof Error ? error.message : 'Не удалось прочитать библиотеку Spotify.', scanDiagnosticSummary(lastScanDiagnostic)].filter(Boolean).join(' '),
        diagnostic: lastScanDiagnostic,
      }); } catch { /* The extension context reloads itself if terminal delivery is unavailable. */ }
      return;
    }
    try { await scanTerminal('library-snapshot', { payload }); }
    catch { /* The worker may have stored the snapshot before its acknowledgment was delayed or lost. */ }
  });
})();
