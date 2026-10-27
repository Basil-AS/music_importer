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
          const candidates = await adapter.searchTracks(group.tracks[0], options.context || {});
          results[index] = { key: group.key, tracks: group.tracks, candidates: Array.isArray(candidates) ? candidates : [], error: null };
        } catch (error) {
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

  window.MusicTransferEngine = Object.freeze({ discoverAllCollections, normalizedQuery, readCompleteCollection, readLibrary, searchMany, validateAdapter });
})();
