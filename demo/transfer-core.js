(() => {
  const musicProviderIds = new Set(['spotify', 'apple-music', 'yandex-music', 'zvuk']);
  const sourceIds = new Set([...musicProviderIds, 'file']);
  const collectionTypes = new Set(['favorites', 'playlists']);

  function requireValue(value, label) {
    if (!value) throw new Error(`Не задано обязательное поле: ${label}`);
    return value;
  }

  function normalizeTrack(track, provider, position = null) {
    const artists = Array.isArray(track.artists) ? track.artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean) : String(track.artist || '').split(/\s*,\s*/).filter(Boolean);
    return {
      provider,
      providerId: track.providerId || track.sourceId || track.id ? String(track.providerId || track.sourceId || track.id) : null,
      isrc: track.isrc ? String(track.isrc).replace(/[^a-z0-9]/gi, '').toUpperCase() : null,
      title: String(track.title || '').trim(),
      artists,
      album: String(track.album || '').trim() || null,
      durationMs: Number(track.durationMs) || null,
      collectionType: track.sourceCollectionType || track.collectionType || (track.sourceCollectionId || track.collectionId ? 'playlists' : 'favorites'),
      collectionId: track.sourceCollectionId || track.collectionId ? String(track.sourceCollectionId || track.collectionId) : null,
      collectionName: track.sourceCollectionName || track.collectionName ? String(track.sourceCollectionName || track.collectionName) : null,
      position: Number.isInteger(track.sourcePosition) ? track.sourcePosition : Number.isInteger(position) ? position : null,
    };
  }

  function createSnapshot({ provider, collections, collectionType, collectionName, tracks, completeness = {} }) {
    requireValue(provider, 'provider');
    if (!sourceIds.has(provider)) throw new Error(`Неизвестный сервис-источник: ${provider}`);
    const inputCollections = collections || [{ id: null, type: collectionType, name: collectionName, completeness, items: tracks }];
    if (!Array.isArray(inputCollections) || !inputCollections.length) throw new Error('collections должен быть непустым массивом');

    const normalizedCollections = inputCollections.map((collection) => {
      if (!collectionTypes.has(collection?.type)) throw new Error(`Неизвестный тип коллекции: ${collection?.type}`);
      const rows = collection.items || collection.tracks;
      if (!Array.isArray(rows)) throw new Error(`Коллекция ${collection?.name || ''} не содержит items`);
      const positionIntegrity = collection.type !== 'playlists' || rows
        .map((row, index) => Number.isInteger(row?.position) ? row.position : Number.isInteger(row?.track?.position) ? row.track.position : index)
        .sort((left, right) => left - right)
        .every((position, index) => position === index);
      const reportedCount = Number.isInteger(collection.itemCount) ? collection.itemCount : Number.isInteger(collection.completeness?.totalCount) ? collection.completeness.totalCount : rows.length;
      const status = { confirmed: false, ...(collection.completeness || {}) };
      status.positionIntegrity = positionIntegrity;
      status.confirmed = Boolean(status.confirmed) && reportedCount === rows.length && positionIntegrity;
      return {
        id: collection.id ? String(collection.id) : null,
        type: collection.type,
        name: collection.name || (collection.type === 'favorites' ? 'Любимое' : 'Плейлист'),
        itemCount: rows.length,
        completeness: status,
        items: rows.map((row, index) => {
          const track = row?.track || row;
          const position = Number.isInteger(row?.position) ? row.position : Number.isInteger(track?.position) ? track.position : index;
          return { position, track: normalizeTrack(track, provider, position) };
        }),
      };
    });

    const snapshotCompleteness = { confirmed: false, ...(completeness || {}) };
    snapshotCompleteness.collectionsConfirmed = normalizedCollections.every((collection) => collection.completeness.confirmed);
    snapshotCompleteness.confirmed = Boolean(snapshotCompleteness.confirmed)
      && snapshotCompleteness.collectionsConfirmed
      && normalizedCollections.length > 0;
    return {
      schemaVersion: 2,
      type: 'music-library-snapshot',
      provider,
      exportedAt: new Date().toISOString(),
      completeness: snapshotCompleteness,
      collections: normalizedCollections,
    };
  }

  function createImportedSnapshot({ provider, tracks = [], playlists = [], collectionType = 'favorites', collectionName = null, completeness = {} }) {
    if (!['favorites', 'playlists', 'library'].includes(collectionType)) throw new Error(`Неизвестный тип импортируемой коллекции: ${collectionType}`);
    const isLibrary = collectionType === 'library';
    if (collectionType === 'favorites') {
      return createSnapshot({
        provider,
        collections: [{
          id: null, type: 'favorites', name: collectionName || 'Любимое', items: tracks,
          itemCount: tracks.length, completeness,
        }],
        completeness,
      });
    }

    const groups = new Map();
    const ensureGroup = (id, name, itemCount = null, confirmed = false) => {
      const key = String(id || name || 'playlist');
      if (!groups.has(key)) groups.set(key, { id: id || null, name: name || 'Плейлист', itemCount, confirmed, tracks: [] });
      const group = groups.get(key);
      if (Number.isInteger(itemCount)) group.itemCount = itemCount;
      group.confirmed = group.confirmed || confirmed;
      return group;
    };
    for (const playlist of playlists || []) {
      const itemCount = Number.isInteger(playlist.trackCount) ? playlist.trackCount : Array.isArray(playlist.tracks) ? playlist.tracks.length : null;
      ensureGroup(playlist.id, playlist.title || playlist.name, itemCount, playlist.complete === true);
    }
    for (const track of tracks) {
      if (isLibrary && track.sourceCollectionType === 'favorites') continue;
      if (!track.sourceCollectionId && !track.sourceCollectionName) continue;
      ensureGroup(track.sourceCollectionId, track.sourceCollectionName, track.sourceCollectionItemCount, track.sourceCollectionComplete === true).tracks.push(track);
    }
    if (!groups.size && !isLibrary) ensureGroup(null, collectionName || 'Плейлисты');

    const collections = [...groups.values()].map((group) => {
      group.tracks.sort((left, right) => (left.sourcePosition ?? 0) - (right.sourcePosition ?? 0));
      const totalCount = Number.isInteger(group.itemCount) ? group.itemCount : group.tracks.length;
      const positionIntegrity = group.tracks.every((track, index) => (Number.isInteger(track.sourcePosition) ? track.sourcePosition : index) === index);
      return {
        id: group.id,
        type: 'playlists',
        name: group.name,
        itemCount: totalCount,
        completeness: { confirmed: group.confirmed && totalCount === group.tracks.length && positionIntegrity, totalCount, positionIntegrity },
        items: group.tracks.map((track, index) => ({ position: Number.isInteger(track.sourcePosition) ? track.sourcePosition : index, track })),
      };
    });
    if (isLibrary) {
      const favoriteTracks = tracks.filter((track) => track.sourceCollectionType === 'favorites');
      const favoritesConfirmed = completeness.favoritesConfirmed === true;
      const snapshotCollections = [{
        id: null,
        type: 'favorites',
        name: 'Любимое',
        itemCount: Number.isInteger(completeness.favoritesCount) ? completeness.favoritesCount : favoriteTracks.length,
        completeness: {
          confirmed: favoritesConfirmed,
          totalCount: Number.isInteger(completeness.favoritesCount) ? completeness.favoritesCount : favoriteTracks.length,
        },
        items: favoriteTracks,
      }, ...collections];
      return createSnapshot({ provider, collections: snapshotCollections, completeness });
    }
    return createSnapshot({ provider, collections, completeness });
  }

  function createTransferPlan({ sourceSnapshot, targetProvider, targetCollectionType, targetCollectionName = null, storefront = null, tracks }) {
    requireValue(sourceSnapshot?.provider, 'sourceSnapshot.provider');
    requireValue(targetProvider, 'targetProvider');
    requireValue(targetCollectionType, 'targetCollectionType');
    if (!sourceIds.has(sourceSnapshot.provider) || !musicProviderIds.has(targetProvider)) throw new Error('Неизвестный сервис в плане переноса');
    if (!collectionTypes.has(targetCollectionType) && targetCollectionType !== 'library') throw new Error(`Неизвестный тип назначения: ${targetCollectionType}`);

    const prepared = (tracks || []).map((track, index) => ({ track, index }));
    const chosen = prepared.filter(({ track }) => track.selected && track.match);
    const skipped = prepared.filter(({ track }) => !(track.selected && track.match));
    const playlists = new Map();
    const sourceCollections = sourceSnapshot.collections || [];
    for (const collection of sourceCollections) {
      if (collection.type !== 'playlists') continue;
      const containsPlaylistItems = (collection.items || []).some((item) => item?.track?.collectionId || item?.track?.collectionName);
      if (!collection.id && containsPlaylistItems) continue;
      const key = String(collection.id || collection.name);
      playlists.set(key, {
        sourceId: collection.id || null,
        sourceName: collection.name || 'Плейлист',
        targetName: collection.name || 'Плейлист',
        sourceItemCount: Number.isInteger(collection.itemCount) ? collection.itemCount : (collection.items || []).length,
        selectedItemCount: 0,
        completeness: collection.completeness || { confirmed: false },
      });
    }
    for (const { track } of prepared) {
      if (!track.sourceCollectionId && !track.sourceCollectionName) continue;
      const key = track.sourceCollectionId || track.sourceCollectionName;
      if (!playlists.has(key)) playlists.set(key, {
        sourceId: track.sourceCollectionId || null,
        sourceName: track.sourceCollectionName || 'Плейлист',
        targetName: track.sourceCollectionName || 'Плейлист',
        sourceItemCount: 0,
        selectedItemCount: 0,
      });
      const group = playlists.get(key);
      if (!group.completeness) group.sourceItemCount += 1;
      if (track.selected && track.match) group.selectedItemCount += 1;
    }

    const sourceCollectionSummaries = sourceCollections.map(({ items: _items, ...summary }) => summary);
    const targetId = track => track.match.trackId ?? track.match.providerId ?? track.match.id;

    return {
      schemaVersion: 3,
      type: 'music-transfer-plan',
      mode: 'preview-only',
      createdAt: new Date().toISOString(),
      source: {
        provider: sourceSnapshot.provider,
        collections: sourceCollectionSummaries,
      },
      target: { provider: targetProvider, collectionType: targetCollectionType, collectionName: targetCollectionName, storefront },
      collectionMappings: [...playlists.values()],
      operations: chosen.map(({ track }) => ({
        source: normalizeTrack(track, sourceSnapshot.provider),
        target: {
          provider: targetProvider,
          providerId: String(targetId(track)),
          title: track.match.trackName || track.match.title,
          artists: track.match.artistName ? [track.match.artistName] : Array.isArray(track.match.artists) ? track.match.artists : [],
          album: track.match.collectionName || track.match.album || null,
          url: track.match.trackViewUrl || null,
          durationMs: track.match.trackTimeMillis || track.match.durationMs || null,
        },
        operation: targetCollectionType === 'library'
          ? (track.sourceCollectionType === 'favorites' ? 'add_to_favorites' : 'add_to_playlist')
          : targetCollectionType === 'favorites' ? 'add_to_favorites' : 'add_to_playlist',
        match: { method: track.matchReason || 'manual_review', confidence: track.matchConfidence || null, automatic: Boolean(track.autoMatched) },
      })),
      skipped: skipped.map(({ track }) => ({
        source: normalizeTrack(track, sourceSnapshot.provider),
        reason: track.searched && !track.matches.length ? 'no_catalog_match' : 'not_selected',
      })),
      execution: { status: 'preview-only', writesPerformed: 0 },
      completeness: { source: [sourceSnapshot.completeness, ...sourceCollectionSummaries.map(({ completeness: status }) => status)].filter(Boolean), writesPerformed: 0 },
    };
  }

  window.MusicTransferCore = Object.freeze({ createImportedSnapshot, createSnapshot, createTransferPlan, normalizeTrack });
})();
