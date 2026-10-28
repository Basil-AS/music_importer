/* Local, credential-free cache for bounded catalog search results. */
(() => {
  const databaseName = 'music-importer-local';
  const databaseVersion = 4;
  const cacheFormatVersion = 3;
  const decisionFormatVersion = 2;
  const previousStoreName = 'automatic-matches';
  const storeName = 'catalog-search-results';
  const decisionStoreName = 'match-decisions';
  const expiresAfterMs = 30 * 24 * 60 * 60 * 1000;
  const noResultExpiresAfterMs = 7 * 24 * 60 * 60 * 1000;
  const decisionExpiresAfterMs = 180 * 24 * 60 * 60 * 1000;
  const maxEntries = 25000;
  const maxCandidatesPerEntry = 12;
  const memory = new Map();
  const memoryDecisions = new Map();
  let databasePromise;
  let lastPrunedAt = 0;
  let lastDecisionsPrunedAt = 0;

  function normalized(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase()
      .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }

  function keyFor(track, targetProvider, storefront = '', accountCatalog = false) {
    if (!track || track.manualQuery || !targetProvider) return '';
    const isrc = String(track.isrc || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    const region = targetProvider === 'apple-music' ? String(storefront || '').toUpperCase() : '';
    const catalogMode = targetProvider === 'apple-music' ? (accountCatalog ? 'account' : 'preview') : '';
    const identity = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)
      ? ['isrc', isrc]
      : [
        'metadata', normalized(track.title), normalized(track.artist || (Array.isArray(track.artists) ? track.artists.join(' ') : '')),
        normalized(track.album), String(Number(track.durationMs || 0) || ''),
      ];
    if (identity[0] === 'metadata' && (!identity[1] || !identity[2])) return '';
    return JSON.stringify([cacheFormatVersion, String(targetProvider), region, catalogMode, ...identity]);
  }

  function decisionKeyFor(track, targetProvider, storefront = '', accountCatalog = false, sourceProvider = '') {
    if (!track || !targetProvider) return '';
    const catalogKey = keyFor({ ...track, manualQuery: false }, targetProvider, storefront, accountCatalog);
    if (!catalogKey) return '';
    const collectionId = String(track.sourceCollectionId || track.collectionId || '');
    const position = Number.isInteger(track.sourcePosition) ? track.sourcePosition : Number.isInteger(track.position) ? track.position : null;
    const providerId = String(track.sourceId || track.providerId || track.id || '');
    const occurrence = collectionId && position !== null
      ? ['playlist-item', collectionId, position]
      : (track.sourceCollectionType || track.collectionType) === 'favorites' && providerId
        ? ['favorite-item', providerId]
        : ['recording'];
    return JSON.stringify([decisionFormatVersion, String(sourceProvider || track.provider || 'file'), catalogKey, ...occurrence]);
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      let request;
      try { request = window.indexedDB.open(databaseName, databaseVersion); }
      catch { return resolve(null); }
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (event.oldVersion < 3 && db.objectStoreNames.contains(previousStoreName)) db.deleteObjectStore(previousStoreName);
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: 'key' });
          store.createIndex('expiresAt', 'expiresAt');
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains(decisionStoreName)) {
          const decisions = db.createObjectStore(decisionStoreName, { keyPath: 'key' });
          decisions.createIndex('expiresAt', 'expiresAt');
          decisions.createIndex('updatedAt', 'updatedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  }

  function candidateFor(match) {
    const trackId = String(match?.trackId || match?.providerId || match?.id || '');
    if (!trackId) return null;
    return {
      trackId,
      providerId: trackId,
      albumId: String(match.albumId || match.collectionId || '') || null,
      trackName: String(match.trackName || match.title || match.name || ''),
      artistName: String(match.artistName || match.artist || (Array.isArray(match.artists) ? match.artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean).join(', ') : '')),
      collectionName: String(match.collectionName || match.album || ''),
      isrc: String(match.isrc || match.ISRC || ''),
      trackTimeMillis: Number(match.trackTimeMillis || match.durationMs || 0) || null,
      trackViewUrl: String(match.trackViewUrl || match.url || ''),
    };
  }

  function recordFor(track, targetProvider, storefront, accountCatalog) {
    if (!track || track.manualQuery || track.searchError || track.searched !== true || !Array.isArray(track.matches)) return null;
    const key = keyFor(track, targetProvider, storefront, accountCatalog);
    const candidates = track.matches.slice(0, maxCandidatesPerEntry).map(candidateFor).filter(Boolean);
    if (!key || (track.matches.length > 0 && !candidates.length)) return null;
    const now = Date.now();
    return {
      key,
      cacheVersion: cacheFormatVersion,
      targetProvider: String(targetProvider),
      storefront: targetProvider === 'apple-music' ? String(storefront || '').toUpperCase() : '',
      candidates,
      searchExpansionComplete: track.searchExpansionComplete === true,
      resultKind: candidates.length ? 'candidates' : 'no-results',
      updatedAt: now,
      expiresAt: now + (candidates.length ? expiresAfterMs : noResultExpiresAfterMs),
    };
  }

  async function getMany(tracks, targetProvider, storefront = '', accountCatalog = false) {
    const keys = [...new Set(tracks.map((track) => keyFor(track, targetProvider, storefront, accountCatalog)).filter(Boolean))];
    const result = new Map();
    if (!keys.length) return result;
    const db = await openDatabase();
    if (!db) {
      for (const key of keys) {
        const record = memory.get(key);
        if (record?.expiresAt > Date.now()) result.set(key, record);
        else if (record) memory.delete(key);
      }
      return result;
    }
    return new Promise((resolve) => {
      let transaction;
      try { transaction = db.transaction(storeName, 'readonly'); }
      catch { return resolve(result); }
      const store = transaction.objectStore(storeName);
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result;
          if (record?.cacheVersion === cacheFormatVersion && record.expiresAt > Date.now()) result.set(key, record);
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => resolve(result);
      transaction.onabort = () => resolve(result);
    });
  }

  async function prune(db) {
    const now = Date.now();
    if (now - lastPrunedAt < 60 * 60 * 1000) return;
    lastPrunedAt = now;
    let records = [];
    try {
      records = await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch { return; }
    const expired = records.filter((record) => record.cacheVersion !== cacheFormatVersion || Number(record.expiresAt) <= now);
    const live = records.filter((record) => record.cacheVersion === cacheFormatVersion && Number(record.expiresAt) > now)
      .sort((left, right) => Number(left.updatedAt) - Number(right.updatedAt));
    const excess = Math.max(0, live.length - maxEntries);
    const remove = [...expired, ...live.slice(0, excess)];
    if (!remove.length) return;
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        remove.forEach((record) => store.delete(record.key));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch { /* Cache pruning must never interrupt matching. */ }
  }

  async function pruneDecisions(db) {
    const now = Date.now();
    if (now - lastDecisionsPrunedAt < 60 * 60 * 1000) return;
    lastDecisionsPrunedAt = now;
    let records = [];
    try {
      records = await new Promise((resolve, reject) => {
        const transaction = db.transaction(decisionStoreName, 'readonly');
        const request = transaction.objectStore(decisionStoreName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch { return; }
    const expired = records.filter((record) => record.decisionVersion !== decisionFormatVersion || Number(record.expiresAt) <= now);
    const live = records.filter((record) => record.decisionVersion === decisionFormatVersion && Number(record.expiresAt) > now)
      .sort((left, right) => Number(left.updatedAt) - Number(right.updatedAt));
    const remove = [...expired, ...live.slice(0, Math.max(0, live.length - maxEntries))];
    if (!remove.length) return;
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(decisionStoreName, 'readwrite');
        const store = transaction.objectStore(decisionStoreName);
        remove.forEach((record) => store.delete(record.key));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch { /* Pruning must not interrupt a user decision. */ }
  }

  async function putSearchResults(tracks, targetProvider, storefront = '', accountCatalog = false) {
    const records = tracks.map((track) => recordFor(track, targetProvider, storefront, accountCatalog)).filter(Boolean);
    if (!records.length) return 0;
    const db = await openDatabase();
    if (!db) {
      records.forEach((record) => memory.set(record.key, record));
      while (memory.size > maxEntries) memory.delete(memory.keys().next().value);
      return records.length;
    }
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        records.forEach((record) => store.put(record));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      void prune(db);
      return records.length;
    } catch {
      return 0;
    }
  }

  async function getDecisions(tracks, targetProvider, storefront = '', accountCatalog = false, sourceProvider = '') {
    const keys = [...new Set(tracks.map((track) => decisionKeyFor(track, targetProvider, storefront, accountCatalog, sourceProvider)).filter(Boolean))];
    const result = new Map();
    if (!keys.length) return result;
    const db = await openDatabase();
    if (!db) {
      for (const key of keys) {
        const record = memoryDecisions.get(key);
        if (record?.expiresAt > Date.now()) result.set(key, record);
        else if (record) memoryDecisions.delete(key);
      }
      return result;
    }
    return new Promise((resolve) => {
      let transaction;
      try { transaction = db.transaction(decisionStoreName, 'readonly'); }
      catch { return resolve(result); }
      const store = transaction.objectStore(decisionStoreName);
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result;
          if (record?.decisionVersion === decisionFormatVersion && record.expiresAt > Date.now()) result.set(key, record);
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => resolve(result);
      transaction.onabort = () => resolve(result);
    });
  }

  function decisionRecord(track, targetProvider, decision, storefront, accountCatalog, sourceProvider) {
    if (!decision || typeof decision.selected !== 'boolean') return false;
    const targetTrackId = String(decision.trackId || '');
    if (decision.selected && !targetTrackId) return false;
    const key = decisionKeyFor(track, targetProvider, storefront, accountCatalog, sourceProvider);
    if (!key) return false;
    const now = Date.now();
    const record = {
      key,
      decisionVersion: decisionFormatVersion,
      sourceProvider: String(sourceProvider || track.provider || 'file'),
      targetProvider: String(targetProvider),
      storefront: targetProvider === 'apple-music' ? String(storefront || '').toUpperCase() : '',
      catalogMode: targetProvider === 'apple-music' ? (accountCatalog ? 'account' : 'preview') : '',
      selected: decision.selected,
      targetTrackId: targetTrackId || null,
      updatedAt: now,
      expiresAt: now + decisionExpiresAfterMs,
    };
    return record;
  }

  async function putDecisions(tracks, targetProvider, decide, storefront = '', accountCatalog = false, sourceProvider = '') {
    if (!Array.isArray(tracks) || typeof decide !== 'function') return 0;
    const records = tracks.map((track) => decisionRecord(track, targetProvider, decide(track), storefront, accountCatalog, sourceProvider)).filter(Boolean);
    if (!records.length) return 0;
    const db = await openDatabase();
    if (!db) {
      records.forEach((record) => memoryDecisions.set(record.key, record));
      while (memoryDecisions.size > maxEntries) memoryDecisions.delete(memoryDecisions.keys().next().value);
      return records.length;
    }
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(decisionStoreName, 'readwrite');
        const store = transaction.objectStore(decisionStoreName);
        records.forEach((record) => store.put(record));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      void pruneDecisions(db);
      return records.length;
    } catch { return 0; }
  }

  async function putDecision(track, targetProvider, decision, storefront = '', accountCatalog = false, sourceProvider = '') {
    const written = await putDecisions([track], targetProvider, () => decision, storefront, accountCatalog, sourceProvider);
    return written === 1;
  }

  async function clear() {
    memory.clear();
    memoryDecisions.clear();
    const db = await openDatabase();
    if (!db) return;
    await new Promise((resolve) => {
      let transaction;
      try { transaction = db.transaction([storeName, decisionStoreName], 'readwrite'); }
      catch { return resolve(); }
      transaction.objectStore(storeName).clear();
      transaction.objectStore(decisionStoreName).clear();
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }

  async function count() {
    const db = await openDatabase();
    if (!db) return memory.size + memoryDecisions.size;
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction([storeName, decisionStoreName], 'readonly');
        const resultCache = transaction.objectStore(storeName).count();
        const resultDecisions = transaction.objectStore(decisionStoreName).count();
        let resultCount = 0;
        let decisionCount = 0;
        resultCache.onsuccess = () => { resultCount = resultCache.result || 0; };
        resultDecisions.onsuccess = () => { decisionCount = resultDecisions.result || 0; };
        transaction.oncomplete = () => resolve(resultCount + decisionCount);
        transaction.onerror = () => resolve(0);
        transaction.onabort = () => resolve(0);
      } catch { resolve(0); }
    });
  }

  window.MusicMatchCache = { keyFor, decisionKeyFor, getMany, putSearchResults, getDecisions, putDecision, putDecisions, clear, count };
})();
