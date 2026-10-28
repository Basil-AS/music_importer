/* Reuse exact recording IDs already present in a fully scanned target account. */
(() => {
  const normalizeISRC = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isValidISRC = (value) => /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(value);

  function accountTrackRows(snapshot) {
    return [
      ...(Array.isArray(snapshot?.tracks) ? snapshot.tracks : []),
      ...(Array.isArray(snapshot?.playlists) ? snapshot.playlists.flatMap((playlist) => Array.isArray(playlist?.tracks) ? playlist.tracks : []) : []),
    ];
  }

  function candidateFor(track, provider) {
    const trackId = String(provider === 'apple-music'
      ? track?.catalogId || ''
      : track?.trackId || track?.providerId || track?.id || '').trim();
    const trackName = String(track?.trackName || track?.title || track?.name || '').trim();
    const artistValue = track?.artistName || track?.artist || track?.artists || '';
    const artistName = Array.isArray(artistValue)
      ? artistValue.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title || '').filter(Boolean).join(', ')
      : String(artistValue || '').trim();
    const isrc = normalizeISRC(track?.isrc || track?.ISRC || track?.externalIds?.isrc || track?.external_ids?.isrc);
    if (!trackId || !trackName || !artistName || !isValidISRC(isrc)) return null;
    const albumValue = track?.collectionName || track?.album || '';
    const collectionName = typeof albumValue === 'string' ? albumValue : albumValue?.name || albumValue?.title || '';
    const duration = Number(track?.trackTimeMillis || track?.durationMs || track?.duration || 0);
    return {
      ...track,
      trackId,
      providerId: trackId,
      trackName,
      artistName,
      collectionName: String(collectionName || ''),
      trackTimeMillis: Number.isFinite(duration) ? duration : 0,
      isrc,
    };
  }

  function buildIndex(snapshot, provider) {
    const index = new Map();
    if (snapshot?.service !== provider || snapshot?.completeness?.confirmed !== true) return index;
    const seen = new Set();
    for (const track of accountTrackRows(snapshot)) {
      const candidate = candidateFor(track, provider);
      if (!candidate) continue;
      const identity = `${candidate.trackId}:${candidate.isrc}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const candidates = index.get(candidate.isrc) || [];
      candidates.push(candidate);
      index.set(candidate.isrc, candidates);
    }
    return index;
  }

  function findByISRC(index, track) {
    const isrc = normalizeISRC(track?.isrc || track?.ISRC || track?.externalIds?.isrc || track?.external_ids?.isrc);
    return isValidISRC(isrc) ? index.get(isrc) || [] : [];
  }

  window.MusicAccountCatalog = { buildIndex, findByISRC };
})();
