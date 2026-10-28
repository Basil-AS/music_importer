(() => {
  const marker = 'music-importer-zvuk-target';
  const favoritesQuery = `query getPaginatedCollection($limit: Int = 30, $after: String = null) {
    paginatedCollection {
      tracks(pagination: { first: $limit, after: $after }) {
        items { id }
        page { endCursor }
      }
    }
  }`;
  const searchQuery = `query search($query: String, $limit: Int = 20) {
    search(query: $query) {
      tracks(limit: $limit) {
        items { id title duration artists { id title } release { id title } }
      }
    }
  }`;
  const addFavoritesMutation = `mutation AddItemsToCollection($items: [CollectionItemInput]!) {
    collection { addItems(items: $items) }
  }`;
  const createPlaylistMutation = `mutation createPlaylist($items: [PlaylistItem!] = [], $name: String!) {
    playlist { createV1(items: $items, name: $name) { id } }
  }`;
  const addPlaylistItemsMutation = `mutation addItems($id: ID!, $items: [PlaylistItem!] = []) {
    playlist { addItemsV1(id: $id, items: $items) { id } }
  }`;
  const playlistTracksQuery = `query getPlaylistTracks($id: ID!, $limit: Int = 100, $offset: Int = 0) {
    playlistTracks(id: $id, limit: $limit, offset: $offset) { id }
  }`;
  const batchSize = 100;
  const checkpointWaiters = new Map();
  let checkpointSequence = 0;

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

  async function graphql(operationName, query, variables = {}) {
    const response = await window.fetch('/api/v1/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName, query, variables }),
    });
    if (!response.ok) throw Object.assign(new Error(`Звук: GraphQL ${operationName} ответил HTTP ${response.status}.`), {
      status: response.status,
      retryAfter: response.headers?.get?.('retry-after') || null,
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`Звук: GraphQL ${operationName} вернул не JSON.`); }
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      throw new Error(`Звук: ${String(payload.errors[0]?.message || `ошибка ${operationName}`).slice(0, 300)}`);
    }
    if (!payload?.data || typeof payload.data !== 'object') throw new Error(`Звук: пустой ответ GraphQL ${operationName}.`);
    return payload.data;
  }

  function idOf(item) {
    const value = item?.id ?? item?.item_id;
    return value === null || value === undefined ? '' : String(value);
  }

  function normalizeCandidate(item) {
    const id = idOf(item);
    const title = String(item?.title || '').trim();
    const artists = Array.isArray(item?.artists) ? item.artists.map((artist) => String(artist?.title || '')).filter(Boolean) : [];
    if (!id || !title || !artists.length) return null;
    const release = item?.release || {};
    const duration = Number(item?.duration || 0);
    return {
      trackId: id,
      providerId: id,
      collectionId: release.id === undefined ? null : String(release.id),
      trackName: title,
      artistName: artists.join(', '),
      collectionName: String(release.title || ''),
      trackTimeMillis: Number.isFinite(duration) ? duration : null,
      isrc: String(item?.isrc || item?.ISRC || item?.externalIds?.isrc || item?.external_ids?.isrc || item?.recording?.isrc || ''),
      trackViewUrl: `https://zvuk.com/track/${encodeURIComponent(id)}`,
    };
  }

  async function searchTracks(query) {
    const value = String(query || '').trim().slice(0, 400);
    if (!value) throw new Error('Введите название или исполнителя для поиска в Звуке.');
    const data = await graphql('search', searchQuery, { query: value, limit: 20 });
    const items = data?.search?.tracks?.items;
    if (!Array.isArray(items)) throw new Error('Звук вернул неизвестный формат поиска.');
    return items.map(normalizeCandidate).filter(Boolean);
  }

  async function readFavoriteIds(progress = null, expectedIds = []) {
    const seenCursors = new Set();
    const expected = new Set(expectedIds.map(String));
    const foundExpected = new Set();
    let cursor = null;
    let scannedCount = 0;
    while (true) {
      const data = await graphql('getPaginatedCollection', favoritesQuery, { limit: 100, after: cursor });
      const tracks = data?.paginatedCollection?.tracks;
      if (!Array.isArray(tracks?.items) || !tracks?.page || !Object.hasOwn(tracks.page, 'endCursor')) {
        throw new Error('Звук не подтвердил страницу списка лайков.');
      }
      const pageIds = tracks.items.map(idOf);
      if (pageIds.some((id) => !id)) throw new Error('В лайках Звука найден трек без ID.');
      scannedCount += pageIds.length;
      pageIds.forEach((id) => {
        if (expected.has(id)) foundExpected.add(id);
      });
      progress?.({ phase: 'favorites-read', completed: scannedCount, message: `Сверяем лайки Звука: ${scannedCount} прочитано.` });
      if (expected.size && foundExpected.size === expected.size) return { foundIds: foundExpected };
      const next = tracks.page.endCursor === null || tracks.page.endCursor === undefined || tracks.page.endCursor === ''
        ? null : String(tracks.page.endCursor);
      if (next === null) return { foundIds: foundExpected };
      if (!tracks.items.length) throw new Error('Звук вернул пустую страницу лайков с продолжением; остановил сверку.');
      if (seenCursors.has(next) || next === cursor) throw new Error('Звук повторил cursor списка лайков; остановил сверку.');
      seenCursors.add(next);
      cursor = next;
    }
  }

  async function writeFavorites(operations, progress, onWriteStarted) {
    const wanted = [...new Set(operations.map((operation) => String(operation?.target?.providerId || '')).filter(Boolean))];
    if (!wanted.length) return { requested: 0, added: 0, alreadyPresent: 0, verified: 0 };
    const before = await readFavoriteIds(progress, wanted);
    const missing = wanted.filter((id) => !before.foundIds.has(id));
    let added = 0;
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const ids = missing.slice(offset, offset + batchSize);
      onWriteStarted?.();
      const data = await graphql('AddItemsToCollection', addFavoritesMutation, {
        items: ids.map((id) => ({ id, type: 'track' })),
      });
      if (!data?.collection || !Object.hasOwn(data.collection, 'addItems')) throw new Error('Звук не подтвердил добавление лайков.');
      added += ids.length;
      progress?.({ phase: 'favorites-write', completed: added, total: missing.length, message: `Добавляем лайки в Звук: ${added} из ${missing.length}.` });
    }
    const after = await readFavoriteIds(progress, wanted);
    const verified = wanted.filter((id) => after.foundIds.has(id)).length;
    if (verified !== wanted.length) throw new Error(`Обратная сверка лайков Звука подтвердила ${verified} из ${wanted.length}.`);
    return { requested: wanted.length, added, alreadyPresent: wanted.length - missing.length, verified };
  }

  async function readPlaylistIds(playlistId, expectedIds = null) {
    const ids = [];
    const expected = Array.isArray(expectedIds) ? expectedIds.map(String) : null;
    let offset = 0;
    while (true) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Смещение плейлиста Звука вышло за безопасный диапазон.');
      const data = await graphql('getPlaylistTracks', playlistTracksQuery, { id: String(playlistId), limit: batchSize, offset });
      const page = data?.playlistTracks;
      if (!Array.isArray(page)) throw new Error('Звук вернул неизвестный формат треков плейлиста.');
      const pageIds = page.map(idOf);
      if (pageIds.some((id) => !id)) throw new Error('В плейлисте Звука найден трек без ID.');
      if (expected) {
        if (ids.length + pageIds.length > expected.length
          || pageIds.some((id, index) => id !== expected[ids.length + index])) {
          throw new Error('Содержимое плейлиста Звука не совпадает с префиксом плана; остановил сверку.');
        }
      }
      ids.push(...pageIds);
      if (page.length < batchSize) return ids;
      const nextOffset = offset + page.length;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) throw new Error('Не удалось безопасно продолжить чтение плейлиста Звука.');
      offset = nextOffset;
    }
  }

  function playlistItem(id) {
    if (!id) throw new Error('В плане переноса найден трек без ID Звука.');
    return { type: 'track', item_id: String(id) };
  }

  async function createPlaylist(name, items) {
    const data = await graphql('createPlaylist', createPlaylistMutation, {
      name: String(name || 'Перенесённый плейлист').trim().slice(0, 120),
      items: items.slice(0, batchSize).map(playlistItem),
    });
    const id = data?.playlist?.createV1?.id;
    if (id === null || id === undefined || String(id) === '') throw new Error(`Звук не вернул ID нового плейлиста «${name}».`);
    return String(id);
  }

  async function executeTransfer(plan, requestId) {
    if (!plan || plan.type !== 'music-transfer-plan' || plan.target?.provider !== 'zvuk') throw new Error('Нужен план переноса с целью «Звук».');
    if (!Array.isArray(plan.operations) || (!plan.operations.length && !plan.collectionMappings?.length)) throw new Error('В плане нет выбранных совпадений или плейлистов.');
    if (!['favorites', 'playlists', 'library'].includes(plan.target.collectionType)) throw new Error('Неизвестный тип коллекции назначения.');
    if (!Array.isArray(plan.completeness?.source) || !plan.completeness.source.length || plan.completeness.source.some((status) => status?.confirmed !== true)) {
      throw new Error('Запись остановлена: полнота исходной библиотеки не подтверждена.');
    }
    if (plan.operations.some((operation) => !operation?.target?.providerId)) throw new Error('В плане есть совпадение без ID трека назначения.');
    const report = { status: 'writing', targetProvider: 'zvuk', startedAt: new Date().toISOString(), favorites: null, playlists: [], failures: [] };
    let writesStarted = false;
    const progress = (value) => post('transfer-progress', {
      requestId,
      progress: { ...value, message: value.message || `Перенос в Звук: ${value.completed || 0}${value.total ? ` из ${value.total}` : ''}.` },
    });
    try {
      const favorites = plan.target.collectionType === 'playlists' ? [] : plan.operations.filter((operation) => operation.operation === 'add_to_favorites');
      report.favorites = await writeFavorites(favorites, progress, () => { writesStarted = true; });
      const playlistOperations = plan.operations.filter((operation) => operation.operation === 'add_to_playlist');
      const mappings = plan.target.collectionType === 'favorites' ? [] : (plan.collectionMappings || []);
      const recovery = plan.recovery && typeof plan.recovery === 'object' ? plan.recovery : {};
      const recoveryProgress = recovery.progress && typeof recovery.progress === 'object' ? recovery.progress : {};
      const playlistTargets = recovery.playlistTargets && typeof recovery.playlistTargets === 'object' ? recovery.playlistTargets : {};
      const completedPlaylistCount = recoveryProgress.phase === 'playlists' ? Math.max(0, Number(recoveryProgress.completed) || 0) : 0;
      for (const [index, mapping] of mappings.entries()) {
        const key = String(mapping.sourceId || mapping.sourceName || '');
        const matching = playlistOperations.filter((operation) => String(operation.source.collectionId || operation.source.collectionName || '') === key)
          .sort((left, right) => Number(left.source.position || 0) - Number(right.source.position || 0));
        const expectedIds = matching.map((operation) => String(operation.target.providerId));
        writesStarted = true;
        let playlistId = String(playlistTargets[key] || '');
        if (!playlistId && recoveryProgress.sourceKey === key
          && ['playlist-creating', 'playlist-items'].includes(recoveryProgress.phase)) {
          throw new Error(`Нельзя безопасно продолжить «${mapping.sourceName}»: сервис мог создать плейлист, но его ID не сохранился. Сверьте цель вручную.`);
        }
        let written = 0;
        let currentIds;
        if (playlistId) {
          currentIds = await readPlaylistIds(playlistId, expectedIds);
          const isPrefix = currentIds.length <= expectedIds.length
            && currentIds.every((id, position) => id === expectedIds[position]);
          if (!isPrefix) throw new Error(`Содержимое «${mapping.targetName || mapping.sourceName}» не является префиксом плана. Остановил продолжение без записи.`);
          if (index < completedPlaylistCount && currentIds.length !== expectedIds.length) {
            throw new Error(`Плейлист «${mapping.targetName || mapping.sourceName}» отмечен завершённым, но read-back неполный.`);
          }
        } else {
          if (index < completedPlaylistCount) throw new Error(`Не найден сохранённый ID завершённого плейлиста «${mapping.sourceName}».`);
          const createCheckpointSaved = await awaitCheckpoint(requestId, {
            phase: 'playlist-creating', completed: index, total: mappings.length, sourceKey: key, playlistIndex: index,
          });
          if (!createCheckpointSaved) throw new Error('Не удалось локально сохранить контрольную точку перед созданием плейлиста. Запись остановлена без изменения аккаунта.');
          playlistId = await createPlaylist(mapping.targetName || mapping.sourceName, []);
          const targetCheckpointSaved = await awaitCheckpoint(requestId, {
            phase: 'playlist-items', completed: 0, total: expectedIds.length, sourceKey: key, targetPlaylistId: playlistId, playlistIndex: index,
          });
          if (!targetCheckpointSaved) throw new Error(`Плейлист «${mapping.targetName || mapping.sourceName}» создан, но его ID не сохранён. Сверьте целевой аккаунт вручную; добавление треков остановлено.`);
          currentIds = await readPlaylistIds(playlistId, expectedIds);
          const seededPrefix = currentIds.length <= expectedIds.length
            && currentIds.every((id, position) => id === expectedIds[position]);
          if (!seededPrefix) throw new Error(`Созданный плейлист «${mapping.targetName || mapping.sourceName}» не совпал с началом плана.`);
          written = currentIds.length;
        }
        for (let offset = currentIds.length; offset < matching.length; offset += batchSize) {
          const batch = matching.slice(offset, offset + batchSize);
          const data = await graphql('addItems', addPlaylistItemsMutation, {
            id: playlistId,
            items: batch.map((operation) => playlistItem(operation.target.providerId)),
          });
          if (!data?.playlist || !Object.hasOwn(data.playlist, 'addItemsV1')) throw new Error(`Звук не подтвердил добавление треков в «${mapping.targetName || mapping.sourceName}».`);
          written += batch.length;
          progress({ phase: 'playlist-items', completed: offset + batch.length, total: matching.length, sourceKey: key, targetPlaylistId: playlistId, playlistIndex: index });
        }
        const actualIds = await readPlaylistIds(playlistId, expectedIds);
        const verified = expectedIds.length === actualIds.length && expectedIds.every((id, position) => id === actualIds[position]);
        report.playlists.push({ title: mapping.targetName || mapping.sourceName, targetId: playlistId, written, verified: verified ? expectedIds.length : 0 });
        if (!verified) throw new Error(`Обратная сверка плейлиста «${mapping.targetName || mapping.sourceName}» обнаружила несовпадение треков или порядка.`);
        progress({ phase: 'playlists', completed: index + 1, total: mappings.length, sourceKey: key, targetPlaylistId: playlistId, playlistIndex: index, message: `Плейлисты Звука: ${index + 1} из ${mappings.length}.` });
      }
      report.status = 'complete';
      report.finishedAt = new Date().toISOString();
      return report;
    } catch (error) {
      report.status = writesStarted || report.favorites?.verified || report.playlists.length ? 'partial_failure' : 'failed';
      report.error = error instanceof Error ? error.message : 'Звук не завершил перенос.';
      report.finishedAt = new Date().toISOString();
      throw Object.assign(new Error(report.error), { transferReport: report });
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const requestId = String(event.data.requestId || '');
    if (!/^[a-z0-9-]{16,80}$/i.test(requestId)) return;
    if (event.data.type === 'search-tracks') {
      try {
        const results = await searchTracks(event.data.query);
        post('command-response', { requestId, ok: true, results });
      } catch (error) {
        post('command-response', {
          requestId, ok: false,
          error: error instanceof Error ? error.message : 'Поиск в Звуке не выполнен.',
          status: Number(error?.status) || null,
          retryAfter: error?.retryAfter || null,
        });
      }
    }
    if (event.data.type === 'execute-transfer') {
      try {
        const report = await executeTransfer(event.data.plan, requestId);
        post('command-response', { requestId, ok: true, report });
      } catch (error) {
        post('command-response', { requestId, ok: false, error: error instanceof Error ? error.message : 'Перенос в Звук не выполнен.', report: error?.transferReport || null });
      }
    }
  });
})();
