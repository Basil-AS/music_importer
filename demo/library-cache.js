/* Decides whether a cached library snapshot can be reused and which collections need re-reading. */
(() => {
  // Until every service has a verified cheap pulse, this interval means a full refresh window.
  const defaultCheckIntervalMs = 6 * 60 * 60 * 1000;
  const defaultMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

  function collectionKey(collection) {
    return `${collection.type}:${collection.id ?? ''}`;
  }

  function summarizeSnapshot(snapshot) {
    const summary = { fetchedAt: snapshot?.snapshotCachedAt || snapshot?.exportedAt || null, collections: {} };
    for (const collection of snapshot?.collections || []) {
      summary.collections[collectionKey(collection)] = {
        itemCount: Number.isInteger(collection.itemCount) ? collection.itemCount : (collection.items || []).length,
        revision: collection.revision ?? collection.completeness?.revision ?? null,
        fingerprint: collection.fingerprint ?? collection.completeness?.fingerprint ?? null,
        confirmed: collection.completeness?.confirmed === true,
      };
    }
    return summary;
  }

  // A pulse can prove unchanged only with a stable revision/fingerprint. Counts alone cannot do so.
  function diffAgainstPulse(cachedSummary, pulse) {
    const cached = cachedSummary?.collections || {};
    const allCachedKeys = Object.keys(cached);
    const invalid = () => ({ reread: allCachedKeys, removed: [], unchanged: false, verified: false });
    if (pulse?.complete !== true || !Array.isArray(pulse.collections)) return invalid();
    const currentKeys = pulse.collections.map((collection) => collectionKey(collection));
    if (pulse.collections.some((collection) => !collection?.type || collection.id === undefined)
      || new Set(currentKeys).size !== currentKeys.length) return invalid();
    const seen = new Set();
    const reread = [];
    for (const current of pulse?.collections || []) {
      const key = collectionKey(current);
      seen.add(key);
      const previous = cached[key];
      const hasCount = Number.isInteger(current.itemCount) && current.itemCount >= 0;
      const revision = current.revision ?? null;
      const fingerprint = current.fingerprint ?? null;
      const hasStableMarker = revision !== null || fingerprint !== null;
      const countChanged = hasCount && previous?.itemCount !== current.itemCount;
      const revisionChanged = revision !== null && previous?.revision !== revision;
      const fingerprintChanged = fingerprint !== null && previous?.fingerprint !== fingerprint;
      if (!previous || !previous.confirmed || !hasStableMarker || countChanged || revisionChanged || fingerprintChanged) reread.push(key);
    }
    const removed = allCachedKeys.filter((key) => !seen.has(key));
    return { reread, removed, unchanged: !reread.length && !removed.length, verified: true };
  }

  // 'missing' no snapshot; 'stale' too old or unconfirmed (show, but refresh);
  // 'fresh' checked recently; 'check' show cache and probe the provider in the background.
  function evaluate({ cachedSnapshot, lastCheckedAt = null, now = Date.now(), checkIntervalMs = defaultCheckIntervalMs, maxAgeMs = defaultMaxAgeMs } = {}) {
    if (!cachedSnapshot?.collections?.length) return 'missing';
    const fetchedAt = Date.parse(cachedSnapshot.snapshotCachedAt || cachedSnapshot.exportedAt || '');
    if (cachedSnapshot.completeness?.confirmed !== true || !Number.isFinite(fetchedAt)
      || fetchedAt > now || now - fetchedAt > maxAgeMs) return 'stale';
    const checkedAt = Number.isFinite(Date.parse(lastCheckedAt || '')) ? Date.parse(lastCheckedAt) : fetchedAt;
    return now - checkedAt < checkIntervalMs ? 'fresh' : 'check';
  }

  // Replace only confirmed re-reads; removals require a complete catalog pulse. Never renew the
  // snapshot timestamp when any old collection is retained after a failed or incomplete read.
  function mergeSnapshots(cachedSnapshot, rereadCollections, { removedKeys = [], completeCatalog = false, now = Date.now() } = {}) {
    const replaced = new Map(rereadCollections.map((collection) => [collectionKey(collection), collection]));
    const removed = new Set(completeCatalog === true ? removedKeys : []);
    const merged = [];
    let retainedCachedCollection = false;
    for (const collection of cachedSnapshot?.collections || []) {
      const key = collectionKey(collection);
      if (removed.has(key)) continue;
      const next = replaced.get(key);
      if (next && next.completeness?.confirmed === true) merged.push(next);
      else {
        retainedCachedCollection = true;
        merged.push(collection);
      }
      replaced.delete(key);
    }
    for (const [key, collection] of replaced) if (collection.completeness?.confirmed === true && !removed.has(key)) merged.push(collection);
    const confirmed = merged.length > 0 && merged.every((collection) => collection.completeness?.confirmed === true);
    const fullyRefreshed = confirmed && !retainedCachedCollection;
    const fetchedAt = fullyRefreshed ? new Date(now).toISOString() : (cachedSnapshot?.snapshotCachedAt || cachedSnapshot?.exportedAt || null);
    return {
      ...cachedSnapshot,
      ...(fetchedAt ? { snapshotCachedAt: fetchedAt } : {}),
      ...(fullyRefreshed ? { exportedAt: fetchedAt } : {}),
      completeness: { ...(cachedSnapshot?.completeness || {}), collectionsConfirmed: confirmed, confirmed: confirmed && cachedSnapshot?.completeness?.confirmed === true },
      collections: merged,
    };
  }

  function formatAge(fetchedAt, now = Date.now()) {
    const timestamp = Date.parse(fetchedAt || '');
    if (!Number.isFinite(timestamp) || timestamp > now) return 'нет данных';
    const minutes = Math.round((now - timestamp) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
  }

  window.MusicLibraryCache = Object.freeze({ collectionKey, summarizeSnapshot, diffAgainstPulse, evaluate, mergeSnapshots, formatAge });
})();
