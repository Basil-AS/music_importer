/* Decides whether a cached library snapshot can be reused and which collections need re-reading. */
(() => {
  const defaultCheckIntervalMs = 10 * 60 * 1000;
  const defaultMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

  function collectionKey(collection) {
    return `${collection.type}:${collection.id ?? ''}`;
  }

  function summarizeSnapshot(snapshot) {
    const summary = { fetchedAt: snapshot?.exportedAt || null, collections: {} };
    for (const collection of snapshot?.collections || []) {
      summary.collections[collectionKey(collection)] = {
        itemCount: Number.isInteger(collection.itemCount) ? collection.itemCount : (collection.items || []).length,
        revision: collection.revision ?? collection.completeness?.revision ?? null,
        confirmed: collection.completeness?.confirmed === true,
      };
    }
    return summary;
  }

  // pulse: cheap provider probe, { collections: [{ type, id, itemCount, revision }] }.
  function diffAgainstPulse(cachedSummary, pulse) {
    const cached = cachedSummary?.collections || {};
    const seen = new Set();
    const reread = [];
    for (const current of pulse?.collections || []) {
      const key = collectionKey(current);
      seen.add(key);
      const previous = cached[key];
      const countChanged = Number.isInteger(current.itemCount) && previous?.itemCount !== current.itemCount;
      const revisionChanged = current.revision != null && previous?.revision !== current.revision;
      if (!previous || !previous.confirmed || countChanged || revisionChanged) reread.push(key);
    }
    const removed = Object.keys(cached).filter((key) => !seen.has(key));
    return { reread, removed, unchanged: !reread.length && !removed.length };
  }

  // 'missing' no snapshot; 'stale' too old or unconfirmed (show, but refresh);
  // 'fresh' checked recently; 'check' show cache and probe the provider in the background.
  function evaluate({ cachedSnapshot, lastCheckedAt = null, now = Date.now(), checkIntervalMs = defaultCheckIntervalMs, maxAgeMs = defaultMaxAgeMs } = {}) {
    if (!cachedSnapshot?.collections?.length) return 'missing';
    const fetchedAt = Date.parse(cachedSnapshot.exportedAt || '');
    if (cachedSnapshot.completeness?.confirmed !== true || !Number.isFinite(fetchedAt) || now - fetchedAt > maxAgeMs) return 'stale';
    const checkedAt = Number.isFinite(Date.parse(lastCheckedAt || '')) ? Date.parse(lastCheckedAt) : fetchedAt;
    return now - checkedAt < checkIntervalMs ? 'fresh' : 'check';
  }

  // Replace only re-read collections; a failed re-read keeps the previous confirmed copy.
  function mergeSnapshots(cachedSnapshot, rereadCollections, removedKeys = []) {
    const replaced = new Map(rereadCollections.map((collection) => [collectionKey(collection), collection]));
    const removed = new Set(removedKeys);
    const merged = [];
    for (const collection of cachedSnapshot?.collections || []) {
      const key = collectionKey(collection);
      if (removed.has(key)) continue;
      const next = replaced.get(key);
      merged.push(next && next.completeness?.confirmed === true ? next : collection);
      replaced.delete(key);
    }
    for (const [key, collection] of replaced) if (collection.completeness?.confirmed === true && !removed.has(key)) merged.push(collection);
    const confirmed = merged.length > 0 && merged.every((collection) => collection.completeness?.confirmed === true);
    return {
      ...cachedSnapshot,
      exportedAt: new Date().toISOString(),
      completeness: { ...(cachedSnapshot?.completeness || {}), collectionsConfirmed: confirmed, confirmed: confirmed && cachedSnapshot?.completeness?.confirmed !== false },
      collections: merged,
    };
  }

  function formatAge(fetchedAt, now = Date.now()) {
    const minutes = Math.max(0, Math.round((now - Date.parse(fetchedAt || '')) / 60000));
    if (!Number.isFinite(minutes)) return 'нет данных';
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
  }

  window.MusicLibraryCache = Object.freeze({ collectionKey, summarizeSnapshot, diffAgainstPulse, evaluate, mergeSnapshots, formatAge });
})();
