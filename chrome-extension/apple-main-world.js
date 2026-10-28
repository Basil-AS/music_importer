(() => {
  const marker = 'music-importer-apple';
  const apiHost = 'amp-api.music.apple.com';
  const apiBase = `https://${apiHost}`;
  const pageSize = 100;
  const checkpointWaiters = new Map();
  let checkpointSequence = 0;
  let sessionHeaders = null;
  let scanPromise = null;

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
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
    const userTokenHeader = headers.has('media-user-token') ? 'media-user-token' : 'music-user-token';
    const userToken = headers.get(userTokenHeader);
    if (!authorization?.startsWith('Bearer ') || !userToken) return;

    // Credentials stay only in this page closure. The extension and app receive normalized library data only.
    sessionHeaders = { authorization, [userTokenHeader]: userToken };
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

  function apiUrl(path, allowCatalog = false) {
    const url = new URL(path, apiBase);
    const personal = url.origin === apiBase && url.pathname.startsWith('/v1/me/');
    const catalog = allowCatalog && url.origin === apiBase && /^\/v1\/catalog\/[a-z]{2}\//i.test(url.pathname);
    if (!personal && !catalog) throw new Error('Разрешены только запросы Apple Music API к личной библиотеке и каталогу.');
    return url;
  }

  async function request(path, options = {}) {
    const headers = await waitForSession();
    const url = apiUrl(path, options.allowCatalog === true);
    const method = String(options.method || 'GET').toUpperCase();
    const requestHeaders = { ...headers, Accept: 'application/json' };
    const init = { method, credentials: 'include', headers: requestHeaders };
    if (options.body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let response;
    const retryable = method === 'GET' && options.retry !== false;
    const attempts = retryable ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        response = await originalFetch.call(window, url.href, init);
      } catch (error) {
        if (attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        continue;
      }
      if (response.ok) break;
      if (!retryable || (response.status !== 429 && response.status < 500) || attempt === attempts - 1) {
        throw Object.assign(new Error(`Apple Music: HTTP ${response.status} для ${method} ${url.pathname}.`), {
          status: response.status,
          retryAfter: response.headers.get('retry-after') || null,
        });
      }
      const retryAfter = retryAfterDelay(response.headers.get('retry-after'));
      const delay = retryAfter === null ? 500 * (2 ** attempt) : retryAfter;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (!response?.ok) throw new Error('Apple Music не ответил после повторных попыток.');
    if (response.status === 202 || response.status === 204) return { data: [] };
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Apple Music вернул ошибку запроса.');
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
    const catalogRelationship = row?.relationships?.catalog?.data;
    const catalogId = String(attributes.playParams?.id || attributes.catalogId || (Array.isArray(catalogRelationship) ? catalogRelationship[0]?.id : '') || '');
    return {
      id,
      catalogId,
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

  function resourceIds(row) {
    const catalogIds = Array.isArray(row?.relationships?.catalog?.data)
      ? row.relationships.catalog.data.map((item) => item?.id)
      : [];
    const values = [
      row?.id,
      row?.attributes?.playParams?.id,
      row?.attributes?.catalogId,
      ...catalogIds,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    return [...new Set(values)];
  }

  function normalizeCatalogSong(row) {
    const attributes = row?.attributes || {};
    const id = String(row?.id || '').trim();
    const title = String(attributes.name || '').trim();
    const artist = String(attributes.artistName || '').trim();
    if (!id || !title || !artist) throw new Error('Каталог Apple Music вернул песню без ID, названия или исполнителя.');
    return {
      trackId: id,
      trackName: title,
      artistName: artist,
      collectionName: String(attributes.albumName || ''),
      trackViewUrl: String(attributes.url || ''),
      trackTimeMillis: Number(attributes.durationInMillis) || 0,
      isrc: String(attributes.isrc || ''),
    };
  }

  async function searchCatalog(query, storefront) {
    const country = String(storefront || '').toLowerCase();
    const term = String(query || '').trim().slice(0, 400);
    if (!/^[a-z]{2}$/.test(country)) throw new Error('Укажите двухбуквенный storefront Apple Music.');
    if (!term) throw new Error('Введите название песни или исполнителя.');
    const isrcQuery = /^isrc:([a-z0-9]{12}(?:,[a-z0-9]{12}){0,24})$/i.exec(term);
    const params = isrcQuery
      ? new URLSearchParams({ 'filter[isrc]': isrcQuery[1].toUpperCase(), limit: '25' })
      : new URLSearchParams({ term, types: 'songs', limit: '25' });
    const path = isrcQuery ? `/v1/catalog/${country}/songs?${params}` : `/v1/catalog/${country}/search?${params}`;
    // Let the shared library-search engine enforce the catalog's Retry-After delay.
    const result = await request(path, { allowCatalog: true, retry: false });
    const songs = isrcQuery ? result?.data : result?.results?.songs?.data;
    if (!Array.isArray(songs)) throw new Error('Каталог Apple Music вернул неожиданный формат поиска.');
    return songs.map(normalizeCatalogSong);
  }

  async function readFavoriteRows() {
    const result = await readPages(`/v1/me/library/songs?limit=${pageSize}`, 'Избранное Apple Music');
    return result.rows.filter((row) => row?.attributes?.inFavorites === true);
  }

  async function readPlaylistCatalog() {
    return readPages(`/v1/me/library/playlists?limit=${pageSize}`, 'Плейлисты Apple Music');
  }

  async function readPlaylistTracks(playlistId) {
    return readPages(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${pageSize}`, 'Сверка плейлиста Apple Music');
  }

  function sourcePlaylistKey(operation) {
    return String(operation?.source?.collectionId || operation?.source?.collectionName || '');
  }

  async function addAppleFavorites(operations, progress) {
    const wanted = [...new Set(operations.map((operation) => String(operation?.target?.providerId || '')).filter(Boolean))];
    const currentRows = await readFavoriteRows();
    const currentIds = new Set(currentRows.flatMap(resourceIds));
    const missing = wanted.filter((id) => !currentIds.has(id));
    let written = 0;
    for (let offset = 0; offset < missing.length; offset += 50) {
      const batch = missing.slice(offset, offset + 50);
      const params = new URLSearchParams();
      params.set('ids[songs]', batch.join(','));
      await request(`/v1/me/favorites?${params}`, { method: 'POST' });
      written += batch.length;
      progress({ phase: 'favorites', completed: written, total: missing.length, message: `Добавляем лайки Apple Music: ${written} из ${missing.length}` });
    }
    return { wanted, written, alreadyPresent: wanted.length - missing.length };
  }

  async function createApplePlaylist(name) {
    const safeName = String(name || 'Перенесённый плейлист').trim().slice(0, 100) || 'Перенесённый плейлист';
    const response = await request('/v1/me/library/playlists', {
      method: 'POST',
      body: { attributes: { name: safeName, description: '', isPublic: false } },
    });
    const playlist = response?.data?.[0];
    if (!playlist?.id || playlist.type !== 'library-playlists') throw new Error(`Apple Music не вернул ID нового плейлиста «${safeName}».`);
    return { id: String(playlist.id), name: safeName };
  }

  async function appendApplePlaylistItems(playlistId, operations, progress) {
    let written = 0;
    for (let offset = 0; offset < operations.length; offset += 100) {
      const batch = operations.slice(offset, offset + 100);
      const data = batch.map((operation) => {
        const id = String(operation?.target?.providerId || '');
        if (!id) throw new Error('В плане Apple Music обнаружен трек без целевого ID.');
        return { id, type: 'songs' };
      });
      await request(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: 'POST', body: { data },
      });
      written += batch.length;
      progress({ phase: 'playlist-items', completed: written, total: operations.length, message: `Добавляем треки в Apple Music: ${written} из ${operations.length}` });
    }
    return written;
  }

  async function verifyFavorites(operations) {
    const rows = await readFavoriteRows();
    const actual = new Set(rows.flatMap(resourceIds));
    const expected = [...new Set(operations.map((operation) => String(operation?.target?.providerId || '')).filter(Boolean))];
    const verified = expected.filter((id) => actual.has(id)).length;
    return { complete: true, verifiedCount: verified, expectedCount: expected.length, ids: actual };
  }

  async function verifyPlaylist(playlistId, operations) {
    const result = await readPlaylistTracks(playlistId);
    const actual = result.rows.map((row) => resourceIds(row));
    const expected = operations.map((operation) => String(operation?.target?.providerId || ''));
    const verifiedCount = expected.filter((id, index) => actual[index]?.includes(id)).length;
    return {
      complete: Number.isInteger(result.total) && result.total === actual.length,
      collectionPresent: true,
      verifiedCount,
      items: result.rows.map((row, index) => ({ providerIds: resourceIds(row), position: index })),
      expectedCount: expected.length,
    };
  }

  async function executeTransfer(plan, requestId) {
    if (!plan || plan.type !== 'music-transfer-plan' || plan.target?.provider !== 'apple-music') throw new Error('Нужен план переноса с целью Apple Music.');
    if (!['favorites', 'playlists', 'library'].includes(plan.target.collectionType)) throw new Error('Неизвестный тип коллекции назначения.');
    if (!Array.isArray(plan.completeness?.source) || !plan.completeness.source.length || plan.completeness.source.some((status) => status?.confirmed !== true)) {
      throw new Error('Запись остановлена: полнота исходной библиотеки не подтверждена.');
    }
    if (!Array.isArray(plan.operations) || plan.operations.some((operation) => !operation?.target?.providerId)) throw new Error('В плане есть песня без ID Apple Music.');
    if (!plan.operations.length && !plan.collectionMappings?.length) throw new Error('В плане нет выбранных песен или плейлистов.');
    const favorites = plan.operations.filter((operation) => operation.operation === 'add_to_favorites' || plan.target.collectionType === 'favorites');
    const playlistItems = plan.operations.filter((operation) => operation.operation === 'add_to_playlist' || plan.target.collectionType === 'playlists');
    const mappings = plan.target.collectionType === 'favorites' ? [] : (plan.collectionMappings || []);
    const recovery = plan.recovery && typeof plan.recovery === 'object' ? plan.recovery : {};
    const recoveryProgress = recovery.progress && typeof recovery.progress === 'object' ? recovery.progress : {};
    const playlistTargets = recovery.playlistTargets && typeof recovery.playlistTargets === 'object' ? recovery.playlistTargets : {};
    const completedPlaylistCount = recoveryProgress.phase === 'playlists' ? Math.max(0, Number(recoveryProgress.completed) || 0) : 0;
    const report = { status: 'writing', targetProvider: 'apple-music', startedAt: new Date().toISOString(), favorites: null, playlists: [], failures: [] };
    let writesStarted = false;
    const progress = (value) => post('transfer-progress', {
      requestId,
      progress: { ...value, message: value.message || `Перенос в Apple Music: ${value.completed || 0} из ${value.total || 0}` },
    });
    try {
      if (favorites.length) {
        writesStarted = true;
        const queued = await addAppleFavorites(favorites, progress);
        let verified = { complete: false, verifiedCount: 0 };
        for (let attempt = 0; attempt < 8; attempt += 1) {
          verified = await verifyFavorites(favorites);
          if (verified.verifiedCount === queued.wanted.length) break;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        report.favorites = { written: queued.written, alreadyPresent: queued.alreadyPresent, verified: verified.verifiedCount, expected: queued.wanted.length };
        if (verified.verifiedCount !== queued.wanted.length) throw new Error(`Apple Music принял запрос, но обратная сверка подтвердила ${verified.verifiedCount} из ${queued.wanted.length} лайков.`);
      }
      for (const [index, mapping] of mappings.entries()) {
        const key = String(mapping.sourceId || mapping.sourceName || '');
        const items = playlistItems.filter((operation) => sourcePlaylistKey(operation) === key)
          .sort((left, right) => Number(left.source?.position || 0) - Number(right.source?.position || 0));
        writesStarted = true;
        const expectedIds = items.map((operation) => String(operation.target.providerId));
        const targetId = String(playlistTargets[key] || '');
        if (!targetId && recoveryProgress.sourceKey === key
          && ['playlist-creating', 'playlist-items'].includes(recoveryProgress.phase)) {
          throw new Error(`Нельзя безопасно продолжить «${mapping.sourceName}»: сервис мог создать плейлист, но его ID не сохранился. Сверьте цель вручную.`);
        }
        let playlist;
        let written = 0;
        if (targetId) {
          playlist = { id: targetId, name: mapping.targetName || mapping.sourceName };
          const existing = await verifyPlaylist(targetId, items);
          const isPrefix = existing.complete && existing.items.length <= expectedIds.length
            && existing.items.every((item, position) => item.providerIds.includes(expectedIds[position]));
          if (!isPrefix) throw new Error(`Содержимое «${playlist.name}» не является префиксом плана. Остановил продолжение без записи.`);
          if (index < completedPlaylistCount && existing.items.length !== expectedIds.length) {
            throw new Error(`Плейлист «${playlist.name}» отмечен как завершённый, но read-back неполный.`);
          }
          const remainder = items.slice(existing.items.length);
          written = await appendApplePlaylistItems(playlist.id, remainder, (value) => progress({
            ...value, sourceKey: key, targetPlaylistId: playlist.id, playlistIndex: index,
          }));
        } else {
          if (index < completedPlaylistCount) throw new Error(`Не найден сохранённый ID завершённого плейлиста «${mapping.sourceName}».`);
          const createCheckpointSaved = await awaitCheckpoint(requestId, {
            phase: 'playlist-creating', completed: index, total: mappings.length, sourceKey: key, playlistIndex: index,
          });
          if (!createCheckpointSaved) throw new Error('Не удалось локально сохранить контрольную точку перед созданием плейлиста. Запись остановлена без изменения аккаунта.');
          playlist = await createApplePlaylist(mapping.targetName || mapping.sourceName);
          const targetCheckpointSaved = await awaitCheckpoint(requestId, {
            phase: 'playlist-items', completed: 0, total: items.length, sourceKey: key, targetPlaylistId: playlist.id, playlistIndex: index,
          });
          if (!targetCheckpointSaved) throw new Error(`Плейлист «${playlist.name}» создан, но его ID не сохранён. Сверьте целевой аккаунт вручную; добавление треков остановлено.`);
          written = await appendApplePlaylistItems(playlist.id, items, (value) => progress({
            ...value, sourceKey: key, targetPlaylistId: playlist.id, playlistIndex: index,
          }));
        }
        const verified = await verifyPlaylist(playlist.id, items);
        const verifiedOrder = verified.items.length === expectedIds.length
          && verified.items.every((item, position) => item.providerIds.includes(expectedIds[position]));
        report.playlists.push({ id: playlist.id, name: playlist.name, written, verified: verified.verifiedCount, expected: items.length });
        progress({ phase: 'playlists', completed: index + 1, total: mappings.length, sourceKey: key, targetPlaylistId: playlist.id, playlistIndex: index, message: `Плейлисты Apple Music: ${index + 1} из ${mappings.length}` });
        if (!verified.complete || verified.verifiedCount !== items.length || !verifiedOrder) {
          throw new Error(`Плейлист «${playlist.name}» записан, но не прошёл проверку состава и порядка.`);
        }
      }
      report.status = 'complete';
      report.finishedAt = new Date().toISOString();
      return report;
    } catch (error) {
      report.status = writesStarted || report.favorites?.verified || report.playlists.length ? 'partial_failure' : 'failed';
      report.error = error instanceof Error ? error.message : 'Apple Music не завершил перенос.';
      report.finishedAt = new Date().toISOString();
      throw Object.assign(new Error(report.error), { transferReport: report });
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type === 'command') {
      const requestId = String(event.data.requestId || '');
      try {
        let result;
        if (event.data.action === 'search-tracks') result = await searchCatalog(event.data.query, event.data.storefront);
        else if (event.data.action === 'execute-transfer') result = await executeTransfer(event.data.plan, requestId);
        else throw new Error('Неизвестная команда Apple Music.');
        post('command-result', { requestId, ok: true, result });
      } catch (error) {
        post('command-result', {
          requestId, ok: false,
          error: error instanceof Error ? error.message : 'Не удалось выполнить команду Apple Music.',
          status: Number(error?.status) || null,
          retryAfter: error?.retryAfter || null,
          report: error?.transferReport || null,
        });
      }
      return;
    }
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
