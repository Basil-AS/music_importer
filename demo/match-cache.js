/* Local, credential-free cache for confident catalog matches only. */
(() => {
  const databaseName = 'music-importer-local';
  const databaseVersion = 2;
  const cacheFormatVersion = 2;
  const storeName = 'automatic-matches';
  const expiresAfterMs = 180 * 24 * 60 * 60 * 1000;
  const maxEntries = 25000;
  const memory = new Map();
  let databasePromise;
  let lastPrunedAt = 0;

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

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      let request;
      try { request = window.indexedDB.open(databaseName, databaseVersion); }
      catch { return resolve(null); }
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (event.oldVersion < 2 && db.objectStoreNames.contains(storeName)) db.deleteObjectStore(storeName);
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: 'key' });
          store.createIndex('expiresAt', 'expiresAt');
          store.createIndex('updatedAt', 'updatedAt');
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
      trackName: String(match.trackName || match.title || match.name || ''),
      artistName: String(match.artistName || match.artist || (Array.isArray(match.artists) ? match.artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean).join(', ') : '')),
      collectionName: String(match.collectionName || match.album || ''),
      isrc: String(match.isrc || match.ISRC || ''),
      trackTimeMillis: Number(match.trackTimeMillis || match.durationMs || 0) || null,
      trackViewUrl: String(match.trackViewUrl || match.url || ''),
    };
  }

  function recordFor(track, targetProvider, storefront, accountCatalog) {
    if (!track?.autoMatched || !track.match || !Number.isFinite(track.matchConfidence)) return null;
    const key = keyFor(track, targetProvider, storefront, accountCatalog);
    const candidate = candidateFor(track.match);
    if (!key || !candidate) return null;
    const now = Date.now();
    return {
      key,
      cacheVersion: cacheFormatVersion,
      targetProvider: String(targetProvider),
      storefront: targetProvider === 'apple-music' ? String(storefront || '').toUpperCase() : '',
      candidate,
      confidence: track.matchConfidence,
      updatedAt: now,
      expiresAt: now + expiresAfterMs,
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

  async function putAutomatic(tracks, targetProvider, storefront = '', accountCatalog = false) {
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

  async function clear() {
    memory.clear();
    const db = await openDatabase();
    if (!db) return;
    await new Promise((resolve) => {
      let transaction;
      try { transaction = db.transaction(storeName, 'readwrite'); }
      catch { return resolve(); }
      transaction.objectStore(storeName).clear();
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }

  async function count() {
    const db = await openDatabase();
    if (!db) return memory.size;
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).count();
        request.onsuccess = () => resolve(request.result || 0);
        request.onerror = () => resolve(0);
      } catch { resolve(0); }
    });
  }

  window.MusicMatchCache = { keyFor, getMany, putAutomatic, clear, count };
})();
