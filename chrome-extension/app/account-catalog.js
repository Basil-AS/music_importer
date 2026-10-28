/* Reuse exact recording IDs already present in a fully scanned target account. */
(() => {
  const normalizeISRC = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isValidISRC = (value) => /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(value);
  const normalizeTitle = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

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
    if (!trackId || !trackName || !artistName) return null;
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
      isrc: isValidISRC(isrc) ? isrc : '',
    };
  }

  function buildIndex(snapshot, provider) {
    const index = new Map();
    index.byTitle = new Map();
    if (snapshot?.service !== provider || snapshot?.completeness?.confirmed !== true) return index;
    const seen = new Set();
    for (const track of accountTrackRows(snapshot)) {
      const candidate = candidateFor(track, provider);
      if (!candidate) continue;
      const identity = `${candidate.trackId}:${candidate.isrc}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (candidate.isrc) {
        const candidates = index.get(candidate.isrc) || [];
        candidates.push(candidate);
        index.set(candidate.isrc, candidates);
      }
      const titleKeys = new Set([
        normalizeTitle(candidate.trackName),
        normalizeTitle(window.MusicMatcher?.romanize(candidate.trackName) || candidate.trackName),
      ].filter(Boolean));
      for (const titleKey of titleKeys) {
        const titleCandidates = index.byTitle.get(titleKey) || [];
        titleCandidates.push(candidate);
        index.byTitle.set(titleKey, titleCandidates);
      }
    }
    return index;
  }

  function findByISRC(index, track) {
    const isrc = normalizeISRC(track?.isrc || track?.ISRC || track?.externalIds?.isrc || track?.external_ids?.isrc);
    return isValidISRC(isrc) ? index.get(isrc) || [] : [];
  }

  function resolveTracks(tracks, index) {
    const matches = new Map();
    const unresolved = [];
    for (const track of tracks || []) {
      if (track?.manualQuery) {
        unresolved.push(track);
        continue;
      }
      const isrcCandidates = findByISRC(index, track);
      if (isrcCandidates.length) {
        matches.set(track, isrcCandidates);
        continue;
      }
      const titleKeys = new Set([
        normalizeTitle(track?.title || track?.trackName || track?.name),
        normalizeTitle(window.MusicMatcher?.romanize(track?.title || track?.trackName || track?.name) || track?.title || track?.trackName || track?.name),
      ].filter(Boolean));
      const titleCandidates = [...new Map([...titleKeys].flatMap((key) => index.byTitle?.get(key) || [])
        .map((candidate) => [candidate.trackId, candidate])).values()];
      const suggestion = titleCandidates.length && window.MusicMatcher?.suggestBestMatch(track, titleCandidates);
      if (suggestion?.automatic && suggestion.best) matches.set(track, [suggestion.best]);
      else unresolved.push(track);
    }
    return { matches, unresolved };
  }

  window.MusicAccountCatalog = { buildIndex, findByISRC, resolveTracks };
})();
