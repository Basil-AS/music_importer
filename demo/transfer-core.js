(() => {
  const musicProviderIds = new Set(['spotify', 'apple-music', 'yandex-music', 'zvuk']);
  const sourceIds = new Set([...musicProviderIds, 'file']);
  const collectionTypes = new Set(['favorites', 'playlists']);

  function requireValue(value, label) {
    if (!value) throw new Error(`Не задано обязательное поле: ${label}`);
    return value;
  }

  function normalizeTrack(track, provider, position = null) {
    return {
      provider,
      providerId: track.sourceId ? String(track.sourceId) : null,
      isrc: track.isrc ? String(track.isrc).replace(/[^a-z0-9]/gi, '').toUpperCase() : null,
      title: String(track.title || '').trim(),
      artists: Array.isArray(track.artists) ? track.artists.map(String).filter(Boolean) : String(track.artist || '').split(/\s*,\s*/).filter(Boolean),
      album: String(track.album || '').trim() || null,
      durationMs: Number(track.durationMs) || null,
      collectionId: track.sourceCollectionId ? String(track.sourceCollectionId) : null,
      collectionName: track.sourceCollectionName ? String(track.sourceCollectionName) : null,
      position: Number.isInteger(track.sourcePosition) ? track.sourcePosition : Number.isInteger(position) ? position : null,
    };
  }

  function createSnapshot({ provider, collectionType, collectionName, tracks, completeness = {} }) {
    requireValue(provider, 'provider');
    requireValue(collectionType, 'collectionType');
    if (!sourceIds.has(provider)) throw new Error(`Неизвестный сервис-источник: ${provider}`);
    if (!collectionTypes.has(collectionType)) throw new Error(`Неизвестный тип коллекции: ${collectionType}`);
    if (!Array.isArray(tracks)) throw new Error('tracks должен быть массивом');

    return {
      schemaVersion: 1,
      type: 'music-library-snapshot',
      provider,
      exportedAt: new Date().toISOString(),
      collections: [{
        id: null,
        type: collectionType,
        name: collectionName || (collectionType === 'favorites' ? 'Любимое' : 'Плейлисты'),
        completeness: { confirmed: false, ...completeness },
        items: tracks.map((track, index) => ({
          position: Number.isInteger(track.sourcePosition) ? track.sourcePosition : index,
          track: normalizeTrack(track, provider, index),
        })),
      }],
    };
  }

  function createTransferPlan({ sourceSnapshot, targetProvider, targetCollectionType, targetCollectionName = null, storefront = null, tracks }) {
    requireValue(sourceSnapshot?.provider, 'sourceSnapshot.provider');
    requireValue(targetProvider, 'targetProvider');
    requireValue(targetCollectionType, 'targetCollectionType');
    if (!sourceIds.has(sourceSnapshot.provider) || !musicProviderIds.has(targetProvider)) throw new Error('Неизвестный сервис в плане переноса');
    if (!collectionTypes.has(targetCollectionType)) throw new Error(`Неизвестный тип назначения: ${targetCollectionType}`);

    const prepared = (tracks || []).map((track, index) => ({ track, index }));
    const chosen = prepared.filter(({ track }) => track.selected && track.match);
    const skipped = prepared.filter(({ track }) => !(track.selected && track.match));
    const playlists = new Map();
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
      group.sourceItemCount += 1;
      if (track.selected && track.match) group.selectedItemCount += 1;
    }

    const sourceCollection = sourceSnapshot.collections?.[0] || null;
    const { items: _items, ...sourceCollectionSummary } = sourceCollection || {};

    return {
      schemaVersion: 2,
      type: 'music-transfer-plan',
      mode: 'preview-only',
      createdAt: new Date().toISOString(),
      source: {
        provider: sourceSnapshot.provider,
        collection: sourceCollection ? sourceCollectionSummary : null,
      },
      target: { provider: targetProvider, collectionType: targetCollectionType, collectionName: targetCollectionName, storefront },
      collectionMappings: [...playlists.values()],
      operations: chosen.map(({ track }) => ({
        source: normalizeTrack(track, sourceSnapshot.provider),
        target: {
          provider: targetProvider,
          providerId: String(track.match.trackId),
          title: track.match.trackName,
          artists: [track.match.artistName].filter(Boolean),
          album: track.match.collectionName || null,
          url: track.match.trackViewUrl || null,
          durationMs: track.match.trackTimeMillis || null,
        },
        operation: targetCollectionType === 'favorites' ? 'add_to_favorites' : 'add_to_playlist',
        match: { method: track.matchReason || 'manual_review', confidence: track.matchConfidence || null, automatic: Boolean(track.autoMatched) },
      })),
      skipped: skipped.map(({ track }) => ({
        source: normalizeTrack(track, sourceSnapshot.provider),
        reason: track.searched && !track.matches.length ? 'no_catalog_match' : 'not_selected',
      })),
      execution: { status: 'preview-only', writesPerformed: 0 },
      completeness: { source: sourceSnapshot.collections?.[0]?.completeness || { confirmed: false }, writesPerformed: 0 },
    };
  }

  window.MusicTransferCore = Object.freeze({ createSnapshot, createTransferPlan, normalizeTrack });
})();
