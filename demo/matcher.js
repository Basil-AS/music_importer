/* Provider-neutral matching helpers shared by future service adapters. */
(() => {
  const normalizeText = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  const normalizeISRC = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const versionMarkers = [
    'live', 'remix', 'remaster', 'remastered', 'acoustic', 'instrumental',
    'karaoke', 'radio edit', 'extended mix', 'sped up', 'slowed', 'mono',
    'stereo', 'demo', 'edit', 'deluxe', 'anniversary edition',
  ];

  function versions(value) {
    const text = normalizeText(value);
    return new Set(versionMarkers.filter((marker) => (` ${text} `).includes(` ${marker} `)));
  }

  function similarity(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aTokens = new Set(a.split(' '));
    const bTokens = new Set(b.split(' '));
    const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
    const tokenScore = (2 * overlap) / (aTokens.size + bTokens.size);
    const maxLength = Math.max(a.length, b.length);
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row += 1) {
      const current = [row];
      for (let column = 1; column <= b.length; column += 1) {
        current[column] = Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    const editScore = 1 - previous[b.length] / maxLength;
    return Math.max(tokenScore, editScore);
  }

  function artistScore(sourceArtist, candidateArtist) {
    const source = normalizeText(sourceArtist).split(/\s+(?:feat|ft|featuring|with|and)\s+|,|\s+&\s+/).filter(Boolean);
    const candidate = normalizeText(candidateArtist).split(/\s+(?:feat|ft|featuring|with|and)\s+|,|\s+&\s+/).filter(Boolean);
    if (!source.length || !candidate.length) return 0;
    const matches = source.map((name) => Math.max(...candidate.map((other) => similarity(name, other))));
    return matches.reduce((sum, score) => sum + score, 0) / matches.length;
  }

  function durationScore(source, candidate) {
    const left = Number(source.durationMs || source.trackTimeMillis || 0);
    const right = Number(candidate.durationMs || candidate.trackTimeMillis || 0);
    if (!left || !right) return null;
    const delta = Math.abs(left - right);
    if (delta <= 2000) return 1;
    if (delta <= 5000) return 0.82;
    if (delta <= 10000) return 0.58;
    if (delta <= 20000) return 0.25;
    return 0;
  }

  function scoreCandidate(source, candidate) {
    const sourceISRC = normalizeISRC(source.isrc || source.ISRC || source.externalIds?.isrc);
    const candidateISRC = normalizeISRC(candidate.isrc || candidate.ISRC || candidate.externalIds?.isrc);
    if (sourceISRC && candidateISRC && sourceISRC === candidateISRC) {
      return { score: 1, exactISRC: true, versionConflict: false };
    }

    const title = similarity(source.title, candidate.trackName || candidate.title || candidate.name);
    const artist = artistScore(source.artist, candidate.artistName || candidate.artist || candidate.artists);
    const sourceAlbum = source.album || '';
    const candidateAlbum = candidate.collectionName || candidate.album || '';
    const album = sourceAlbum && candidateAlbum ? similarity(sourceAlbum, candidateAlbum) : null;
    const duration = durationScore(source, candidate);
    const sourceVersions = versions(`${source.title} ${source.album || ''}`);
    const candidateVersions = versions(`${candidate.trackName || candidate.title || candidate.name || ''} ${candidate.collectionName || candidate.album || ''}`);
    const versionConflict = [...sourceVersions].some((marker) => !candidateVersions.has(marker))
      || [...candidateVersions].some((marker) => !sourceVersions.has(marker));

    let total = title * 0.53 + artist * 0.39;
    let weight = 0.92;
    if (album !== null) { total += album * 0.04; weight += 0.04; }
    if (duration !== null) { total += duration * 0.04; weight += 0.04; }
    const score = Math.max(0, Math.min(0.98, total / weight - (versionConflict ? 0.2 : 0)));
    return { score, exactISRC: false, versionConflict, titleScore: title, artistScore: artist, durationScore: duration };
  }

  function suggestBestMatch(source, candidates) {
    const ranked = candidates.map((candidate) => ({ candidate, ...scoreCandidate(source, candidate) }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0] || null;
    const runnerUp = ranked[1] || null;
    const margin = best ? best.score - (runnerUp?.score ?? 0) : 0;
    const automatic = Boolean(best && !best.versionConflict && (best.exactISRC || (best.score >= 0.96 && margin >= 0.035)));
    return {
      best: best?.candidate || null,
      confidence: best?.score || 0,
      automatic,
      reason: !best ? 'no_candidates' : best.exactISRC ? 'exact_isrc' : automatic ? 'high_confidence_metadata' : 'manual_review',
      ranked,
      margin,
    };
  }

  window.MusicMatcher = { normalizeISRC, scoreCandidate, suggestBestMatch };
})();
