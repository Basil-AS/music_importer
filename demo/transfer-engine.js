(() => {
  const providerIds = new Set(['spotify', 'apple-music', 'yandex-music', 'zvuk']);

  function validateAdapter(adapter) {
    if (!adapter || !providerIds.has(adapter.id)) throw new Error('Adapter должен объявить один из четырёх provider ID');
    const methods = [
      'connect', 'disconnect', 'discoverCollectionPage', 'readCollectionPage', 'searchTracks',
      'readDestination', 'writeFavorites', 'createPlaylist', 'writePlaylistItems', 'readBack',
    ];
    return Object.fromEntries(methods.map((method) => [method, typeof adapter[method] === 'function']));
  }

  function normalizedQuery(track) {
    const norm = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const isrc = String(track.isrc || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (isrc) return `isrc:${isrc}`;
    const artists = Array.isArray(track.artists) ? track.artists.join(' ') : track.artist || '';
    return `${norm(track.title)}|${norm(artists)}|${norm(track.album)}|${Number(track.durationMs) || ''}`;
  }

  function searchStatus(error) {
    if (Number.isInteger(error?.status)) return error.status;
    const message = String(error?.message || error || '');
    const match = /\bHTTP\s*(\d{3})\b|ответил\s+(\d{3})\b/i.exec(message);
    return Number(match?.[1] || match?.[2]) || null;
  }

  function retryableSearchError(error) {
    const status = searchStatus(error);
    if (status !== null) return status === 408 || status === 429 || status >= 500;
    return error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(error?.message || error || ''));
  }

  function waitForRetry(delayMs, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Поиск отменён', 'AbortError'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new DOMException('Поиск отменён', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async function searchWithRetry(adapter, track, options) {
    const maxRetries = Math.max(0, Math.min(5, Math.floor(options.maxRetries ?? 3)));
    for (let attempt = 0; ; attempt += 1) {
      if (options.signal?.aborted) throw new DOMException('Поиск отменён', 'AbortError');
      try {
        return await adapter.searchTracks(track, options.context || {});
      } catch (error) {
        if (attempt >= maxRetries || !retryableSearchError(error)) throw error;
        const status = searchStatus(error);
        const baseDelay = status === 429 ? 2500 : 500;
        const delayMs = Math.min(30000, baseDelay * (2 ** attempt));
        await waitForRetry(delayMs, options.signal);
      }
    }
  }

  async function searchMany(adapter, tracks, options = {}) {
    if (!adapter || typeof adapter.searchTracks !== 'function') throw new Error('У адаптера назначения нет searchTracks()');
    const concurrency = Math.max(1, Math.floor(options.concurrency || adapter.maxConcurrentSearches || 3));
    const keyFor = options.keyFor || normalizedQuery;
    const groups = new Map();
    for (const track of tracks) {
      const key = String(keyFor(track));
      if (!groups.has(key)) groups.set(key, { key, tracks: [] });
      groups.get(key).tracks.push(track);
    }

    const queue = [...groups.values()];
    const results = new Array(queue.length);
    let nextIndex = 0;
    let completed = 0;
    const workerCount = Math.min(concurrency, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= queue.length) return;
        const group = queue[index];
        try {
          const candidates = await searchWithRetry(adapter, group.tracks[0], options);
          results[index] = { key: group.key, tracks: group.tracks, candidates: Array.isArray(candidates) ? candidates : [], error: null };
        } catch (error) {
          if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
          results[index] = { key: group.key, tracks: group.tracks, candidates: [], error };
        }
        completed += 1;
        if (options.onProgress) await options.onProgress(results[index], completed, queue.length);
      }
    }));
    return results;
  }

  async function readCompleteCollection(adapter, collection, options = {}) {
    if (!adapter || typeof adapter.readCollectionPage !== 'function') throw new Error('У адаптера источника нет readCollectionPage()');
    if (!collection?.id || !['favorites', 'playlists'].includes(collection.type)) throw new Error('Нужна collection с id и type favorites/playlists');
    const pageSize = Math.max(1, Math.floor(options.pageSize || adapter.pageSize || 100));
    const seenCursors = new Set(options.checkpoint?.seenCursors || []);
    const favoriteItems = new Map();
    const playlistItems = [...(options.checkpoint?.items || [])];
    for (const item of options.checkpoint?.items || []) {
      if (collection.type === 'favorites' && item?.providerId) favoriteItems.set(String(item.providerId), item);
    }
    let cursor = options.checkpoint?.nextCursor ?? null;
    let pagesRead = Number(options.checkpoint?.pagesRead || 0);
    let totalCount = Number.isInteger(options.checkpoint?.totalCount) ? options.checkpoint.totalCount : null;
    let hasMore = true;

    while (hasMore) {
      const page = await adapter.readCollectionPage({ collection, cursor, limit: pageSize, signal: options.signal });
      if (!page || !Array.isArray(page.items)) throw new Error('readCollectionPage() должен вернуть массив items');
      pagesRead += 1;
      const pageOffset = Number.isInteger(page.offset) ? page.offset : playlistItems.length;
      page.items.forEach((item, index) => {
        if (!item || (!item.providerId && !item.id) || !item.title) return;
        const normalized = {
          ...item,
          providerId: String(item.providerId || item.id),
          position: collection.type === 'playlists' ? (Number.isInteger(item.position) ? item.position : pageOffset + index) : null,
        };
        if (collection.type === 'favorites') favoriteItems.set(normalized.providerId, normalized);
        else playlistItems.push(normalized);
      });

      if (Number.isInteger(page.totalCount)) {
        if (totalCount !== null && totalCount !== page.totalCount) totalCount = NaN;
        else if (totalCount === null) totalCount = page.totalCount;
      }
      const nextCursor = page.nextCursor ?? null;
      hasMore = typeof page.hasMore === 'boolean' ? page.hasMore : nextCursor !== null;
      if (hasMore && nextCursor === null) throw new Error('Адаптер сообщает hasMore без nextCursor');
      if (hasMore) {
        const cursorKey = JSON.stringify(nextCursor);
        if (seenCursors.has(cursorKey) || JSON.stringify(cursor) === cursorKey) throw new Error('API повторил pagination cursor; остановил сбор, чтобы не зациклиться');
        seenCursors.add(cursorKey);
      }
      cursor = nextCursor;
      if (options.onPage) await options.onPage({ page, pagesRead, nextCursor, hasMore });
      if (options.onCheckpoint) await options.onCheckpoint({
        nextCursor,
        pagesRead,
        totalCount: Number.isInteger(totalCount) ? totalCount : null,
        seenCursors: [...seenCursors],
        items: collection.type === 'favorites' ? [...favoriteItems.values()] : playlistItems,
      });
    }

    const items = collection.type === 'favorites' ? [...favoriteItems.values()] : playlistItems;
    if (collection.type === 'playlists') items.sort((left, right) => left.position - right.position);
    const positionIntegrity = collection.type !== 'playlists' || items.every((item, index) => item.position === index);
    const totalCountConsistent = Number.isInteger(totalCount) && totalCount === items.length && positionIntegrity;
    const completeness = {
      paginationExhausted: true,
      totalCount: Number.isInteger(totalCount) ? totalCount : null,
      totalCountConsistent,
      positionIntegrity,
      confirmed: totalCountConsistent,
      reason: Number.isNaN(totalCount) ? 'provider_total_changed_during_read' : totalCount === null ? 'provider_total_unavailable' : totalCountConsistent ? null : 'provider_total_mismatch',
      pagesRead,
    };
    return {
      schemaVersion: 2,
      type: 'music-library-snapshot',
      provider: adapter.id,
      exportedAt: new Date().toISOString(),
      collections: [{ ...collection, itemCount: items.length, completeness, items: items.map((track, index) => ({ position: collection.type === 'playlists' ? track.position : index, track })) }],
      checkpoint: { nextCursor: null, pagesRead, itemCount: items.length },
    };
  }

  async function discoverAllCollections(adapter, options = {}) {
    if (!adapter || typeof adapter.discoverCollectionPage !== 'function') throw new Error('У адаптера источника нет discoverCollectionPage()');
    const pageSize = Math.max(1, Math.floor(options.pageSize || adapter.collectionPageSize || 100));
    const collectionsByKey = new Map();
    const seenCursors = new Set(options.checkpoint?.seenCursors || []);
    let cursor = options.checkpoint?.nextCursor ?? null;
    let pagesRead = Number(options.checkpoint?.pagesRead || 0);
    let totalCount = Number.isInteger(options.checkpoint?.totalCount) ? options.checkpoint.totalCount : null;
    let hasMore = true;
    for (const collection of options.checkpoint?.collections || []) {
      if (collection?.id && collection?.type) collectionsByKey.set(`${collection.type}:${collection.id}`, collection);
    }

    while (hasMore) {
      const page = await adapter.discoverCollectionPage({ cursor, limit: pageSize, signal: options.signal });
      if (!page || !Array.isArray(page.collections)) throw new Error('discoverCollectionPage() должен вернуть массив collections');
      pagesRead += 1;
      for (const collection of page.collections) {
        if (!collection?.id || !['favorites', 'playlists'].includes(collection.type)) continue;
        collectionsByKey.set(`${collection.type}:${collection.id}`, { ...collection, id: String(collection.id) });
      }
      if (Number.isInteger(page.totalCount)) {
        if (totalCount !== null && totalCount !== page.totalCount) totalCount = NaN;
        else if (totalCount === null) totalCount = page.totalCount;
      }
      const nextCursor = page.nextCursor ?? null;
      hasMore = typeof page.hasMore === 'boolean' ? page.hasMore : nextCursor !== null;
      if (hasMore && nextCursor === null) throw new Error('Адаптер сообщает hasMore без nextCursor при поиске коллекций');
      if (hasMore) {
        const cursorKey = JSON.stringify(nextCursor);
        if (seenCursors.has(cursorKey) || JSON.stringify(cursor) === cursorKey) throw new Error('API повторил collections cursor; остановил обнаружение');
        seenCursors.add(cursorKey);
      }
      cursor = nextCursor;
      if (options.onPage) await options.onPage({ page, pagesRead, nextCursor, hasMore });
      if (options.onCheckpoint) await options.onCheckpoint({ nextCursor, pagesRead, totalCount: Number.isInteger(totalCount) ? totalCount : null, seenCursors: [...seenCursors], collections: [...collectionsByKey.values()] });
    }

    const collections = [...collectionsByKey.values()];
    const totalCountConsistent = Number.isInteger(totalCount) && totalCount === collections.length;
    return {
      collections,
      completeness: {
        paginationExhausted: true,
        totalCount: Number.isInteger(totalCount) ? totalCount : null,
        totalCountConsistent,
        confirmed: totalCountConsistent,
        pagesRead,
        reason: Number.isNaN(totalCount) ? 'provider_collection_total_changed_during_read' : totalCount === null ? 'provider_collection_total_unavailable' : totalCountConsistent ? null : 'provider_collection_total_mismatch',
      },
      checkpoint: { nextCursor: null, pagesRead, totalCount: Number.isInteger(totalCount) ? totalCount : null, collections },
    };
  }

  async function readLibrary(adapter, options = {}) {
    const discovery = await discoverAllCollections(adapter, options.discover || {});
    const snapshots = [];
    for (let index = 0; index < discovery.collections.length; index += 1) {
      const collection = discovery.collections[index];
      const checkpoint = options.checkpoints?.[`${collection.type}:${collection.id}`] || null;
      const snapshot = await readCompleteCollection(adapter, collection, {
        ...(options.read || {}),
        checkpoint,
        onCheckpoint: async (value) => {
          if (options.onCheckpoint) await options.onCheckpoint(collection, value);
        },
      });
      snapshots.push(snapshot.collections[0]);
      if (options.onCollection) await options.onCollection({ collection, snapshot: snapshot.collections[0], completed: index + 1, total: discovery.collections.length });
    }
    const collectionsConfirmed = snapshots.every((collection) => collection.completeness.confirmed);
    return {
      schemaVersion: 2,
      type: 'music-library-snapshot',
      provider: adapter.id,
      exportedAt: new Date().toISOString(),
      completeness: {
        collectionCatalog: discovery.completeness,
        collectionsConfirmed,
        confirmed: discovery.completeness.confirmed && collectionsConfirmed,
        discoveredCount: discovery.collections.length,
      },
      collections: snapshots,
    };
  }

  function destinationIds(destination) {
    const items = Array.isArray(destination) ? destination : destination?.items || [];
    return new Set(items.map((item) => String(item?.providerId || item?.id || '')).filter(Boolean));
  }

  function completeRead(read) {
    return read?.complete === true || read?.completeness?.confirmed === true;
  }

  async function executeTransferPlan(adapter, plan, options = {}) {
    if (!adapter || !providerIds.has(adapter.id)) throw new Error('Нужен адаптер целевого музыкального сервиса');
    if (plan?.type !== 'music-transfer-plan' || plan.target?.provider !== adapter.id) throw new Error('План не предназначен для этого сервиса');
    if (!Array.isArray(plan.operations) || plan.operations.some((operation) => !operation?.target?.providerId)) throw new Error('В плане есть операции без ID целевого трека');
    if (options.confirmed !== true) throw new Error('Перед записью пользователь должен явно подтвердить перенос');
    if (typeof adapter.readDestination !== 'function' || typeof adapter.readBack !== 'function') throw new Error('Адаптеру нужны чтение назначения и обратная сверка');
    const targetType = plan.target.collectionType;
    if (!['favorites', 'playlists', 'library'].includes(targetType)) throw new Error('Неизвестный тип целевой коллекции');
    const favoriteOperations = plan.operations.filter((operation) => operation.operation === 'add_to_favorites' || (targetType === 'favorites' && !operation.operation));
    const playlistOperations = plan.operations.filter((operation) => operation.operation === 'add_to_playlist' || (targetType === 'playlists' && !operation.operation));
    if (favoriteOperations.length + playlistOperations.length !== plan.operations.length) throw new Error('План содержит неизвестный тип записи');
    const playlistMappings = targetType === 'favorites' ? [] : (plan.collectionMappings || []);
    const writeFavorites = favoriteOperations.length > 0;
    const writePlaylists = playlistOperations.length > 0 || playlistMappings.length > 0;
    if (writeFavorites && typeof adapter.writeFavorites !== 'function') throw new Error('Адаптер не умеет добавлять треки в избранное');
    if (writePlaylists && (typeof adapter.createPlaylist !== 'function' || typeof adapter.writePlaylistItems !== 'function')) throw new Error('Адаптер не умеет создавать и наполнять плейлисты');
    const sourceCompleteness = plan.completeness?.source || [];
    if (!sourceCompleteness.length || sourceCompleteness.some((status) => status?.confirmed !== true)) throw new Error('Перенос остановлен: полнота исходной библиотеки не подтверждена');

    const batchSize = Math.max(1, Math.min(500, Math.floor(options.batchSize || adapter.writeBatchSize || 50)));
    const report = {
      status: 'writing', targetProvider: adapter.id, collectionType: plan.target.collectionType,
      startedAt: new Date().toISOString(), writesAttempted: 0, writesPerformed: 0,
      alreadyPresent: 0, verified: 0, collectionsExpected: 0, collectionsVerified: 0, failures: [], checkpoints: [],
    };
    const checkpoint = async (value) => {
      report.checkpoints.push(value);
      if (options.onCheckpoint) await options.onCheckpoint(structuredClone(report));
    };
    const runStep = async (phase, action) => {
      try {
        return await action();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        report.status = report.writesPerformed > 0 ? 'partial_failure' : 'failed';
        report.failures.push({ phase, message: failure.message });
        report.finishedAt = new Date().toISOString();
        failure.transferReport = structuredClone(report);
        throw failure;
      }
    };
    let existingFavorites = null;
    let existingPlaylists = null;
    if (writeFavorites) {
      existingFavorites = await adapter.readDestination({ collectionType: 'favorites', collectionName: 'Любимое', signal: options.signal });
      if (!completeRead(existingFavorites)) throw new Error('Перенос остановлен: не удалось подтвердить полный список уже сохранённых лайков');
    }
    if (writePlaylists) {
      existingPlaylists = await adapter.readDestination({ collectionType: 'playlists', signal: options.signal });
      if (!completeRead(existingPlaylists)) throw new Error('Перенос остановлен: не удалось подтвердить полный список целевых плейлистов');
    }
    if (writeFavorites) {
      const present = destinationIds(existingFavorites);
      const pending = favoriteOperations.filter((operation) => !present.has(String(operation.target?.providerId || '')));
      report.alreadyPresent += favoriteOperations.length - pending.length;
      for (let offset = 0; offset < pending.length; offset += batchSize) {
        if (options.signal?.aborted) throw new DOMException('Перенос отменён', 'AbortError');
        const batch = pending.slice(offset, offset + batchSize);
        report.writesAttempted += batch.length;
        const result = await runStep(`write_favorites:${offset}`, () => adapter.writeFavorites(batch.map((operation) => operation.target), {
          signal: options.signal, idempotencyKey: `${plan.createdAt}:favorites:${offset}`,
        }));
        report.writesPerformed += Number.isInteger(result?.writtenCount) ? result.writtenCount : batch.length;
        await runStep(`checkpoint_favorites:${offset}`, () => checkpoint({ phase: 'favorites', offset, count: batch.length }));
      }
      const back = await runStep('read_back_favorites', () => adapter.readBack({ type: 'favorites', operations: favoriteOperations }, { signal: options.signal }));
      const readIds = destinationIds(back);
      report.verified = completeRead(back)
        ? favoriteOperations.filter((operation) => readIds.has(String(operation.target.providerId))).length
        : 0;
    }
    if (writePlaylists) {
      const groups = new Map();
      for (const mapping of playlistMappings) {
        const key = String(mapping.sourceId || mapping.sourceName || 'Перенесённая музыка');
        groups.set(key, []);
      }
      for (const operation of playlistOperations) {
        const key = String(operation.source?.collectionId || operation.source?.collectionName || plan.target.collectionName || 'Перенесённая музыка');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(operation);
      }
      for (const [sourceKey, operations] of groups) {
        report.collectionsExpected += 1;
        operations.sort((left, right) => (left.source?.position ?? 0) - (right.source?.position ?? 0));
        const sourceMapping = (plan.collectionMappings || []).find((mapping) => String(mapping.sourceId || mapping.sourceName) === sourceKey);
        const name = sourceMapping?.targetName || sourceMapping?.sourceName || plan.target.collectionName || 'Перенесённая музыка';
        const playlist = await runStep(`create_playlist:${sourceKey}`, () => adapter.createPlaylist({
          name, sourceId: sourceMapping?.sourceId || operations[0]?.source?.collectionId || null,
          idempotencyKey: `${plan.createdAt}:playlist:${sourceKey}`,
        }, { signal: options.signal, existing: existingPlaylists }));
        if (!playlist?.id) throw new Error(`Адаптер не вернул ID плейлиста «${name}»`);
        for (let offset = 0; offset < operations.length; offset += batchSize) {
          if (options.signal?.aborted) throw new DOMException('Перенос отменён', 'AbortError');
          const batch = operations.slice(offset, offset + batchSize);
          report.writesAttempted += batch.length;
          const result = await runStep(`write_playlist:${sourceKey}:${offset}`, () => adapter.writePlaylistItems(String(playlist.id), batch.map((operation, index) => ({
            ...operation.target, position: offset + index,
          })), {
            signal: options.signal, idempotencyKey: `${plan.createdAt}:playlist:${sourceKey}:${offset}`,
          }));
          report.writesPerformed += Number.isInteger(result?.writtenCount) ? result.writtenCount : batch.length;
          await runStep(`checkpoint_playlist:${sourceKey}:${offset}`, () => checkpoint({ phase: 'playlist', playlistId: String(playlist.id), offset, count: batch.length }));
        }
        const back = await runStep(`read_back_playlist:${sourceKey}`, () => adapter.readBack({ type: 'playlist', playlistId: String(playlist.id), operations }, { signal: options.signal }));
        if (completeRead(back) && back?.collectionPresent === true) report.collectionsVerified += 1;
        if (completeRead(back)) {
          report.verified += Number.isInteger(back?.verifiedCount)
            ? Math.min(operations.length, Math.max(0, back.verifiedCount))
            : Array.isArray(back?.items)
              ? operations.filter((operation, index) => String(back.items[index]?.providerId || back.items[index]?.id || '') === String(operation.target.providerId)).length
              : 0;
        }
      }
    }
    report.status = report.verified === plan.operations.length
      && report.collectionsVerified === report.collectionsExpected ? 'complete' : 'needs_review';
    report.finishedAt = new Date().toISOString();
    if (options.onComplete) await options.onComplete(structuredClone(report));
    return report;
  }

  window.MusicTransferEngine = Object.freeze({ discoverAllCollections, executeTransferPlan, normalizedQuery, readCompleteCollection, readLibrary, searchMany, validateAdapter });
})();
