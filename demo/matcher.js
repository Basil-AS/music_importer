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

  const cyrillicToLatin = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
  };

  function romanize(value) {
    return Array.from(String(value || '').normalize('NFKC').toLowerCase(), (character) => (
      Object.hasOwn(cyrillicToLatin, character) ? cyrillicToLatin[character] : character
    )).join('');
  }

  function detransliterate(value) {
    const source = String(value || '').normalize('NFKC').toLowerCase();
    if (!source || /[\u0400-\u04ff]/u.test(source) || !/[a-z]/i.test(source)) return '';
    if (!/(?:shch|zh|kh|ts|ch|sh|yo|yu|ya|ye|yi)/i.test(source)) return '';
    const replacements = {
      shch: 'щ', zh: 'ж', kh: 'х', ts: 'ц', ch: 'ч', sh: 'ш',
      yo: 'ё', yu: 'ю', ya: 'я', ye: 'є', yi: 'ї',
      a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', e: 'е', z: 'з', i: 'и', y: 'й',
      k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с', t: 'т',
      u: 'у', f: 'ф',
    };
    const converted = source.replace(/shch|zh|kh|ts|ch|sh|yo|yu|ya|ye|yi|[a-z]/gi, (part) => replacements[part.toLowerCase()] || part);
    if (/[a-z]/i.test(converted)) return '';
    const comparable = (text) => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    return comparable(romanize(converted)) === comparable(source) ? converted : '';
  }

  const normalizeISRC = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function sourceRecordingKey(track, provider) {
    const service = String(provider || track?.provider || '');
    if (!service || !track) return '';
    const isrc = normalizeISRC(track.isrc || track.ISRC || track.externalIds?.isrc);
    if (/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) return `${service}:isrc:${isrc}`;
    const providerId = String(track.sourceId || track.providerId || track.id || '').trim();
    return providerId ? `${service}:id:${providerId}` : '';
  }

  function sourceSearchGroupKey(track, provider) {
    if (track?.manualQuery) return '';
    return sourceRecordingKey(track, provider);
  }

  function catalogSearchGroupKey(track, sourceProvider, targetProvider, storefront, fallbackQuery) {
    const sourceKey = sourceSearchGroupKey(track, sourceProvider);
    const fallback = String(fallbackQuery || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const identity = sourceKey ? `source:${sourceKey}` : `query:${fallback}`;
    const target = String(targetProvider || '');
    const region = target === 'apple-music' ? `:${String(storefront || '').toUpperCase()}` : '';
    return `${target}${region}:${identity}`;
  }

  function propagateSourceMatch(tracks, track, provider) {
    const key = sourceRecordingKey(track, provider);
    if (!key) return [track];
    const duplicates = tracks.filter((candidate) => sourceRecordingKey(candidate, provider) === key);
    const fields = [
      'matches', 'match', 'matchConfidence', 'matchReason', 'autoMatched', 'cachedMatch',
      'cachedResults', 'searched', 'searchError', 'errorMessage', 'searchExpansionComplete',
      'userExcluded', 'selected',
    ];
    for (const duplicate of duplicates) {
      if (duplicate === track) continue;
      for (const field of fields) duplicate[field] = track[field];
    }
    return duplicates;
  }

  function buildSearchQueries(track) {
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean).join(', ')
      : String(track.artist || '');
    const title = String(track.title || track.name || '').trim();
    const album = String(track.album || track.collectionName || '').trim();
    const broad = [title, artists].filter(Boolean).join(' ').trim();
    const primary = String(track.query || [title, artists, album].filter(Boolean).join(' ')).trim();
    return {
      primary,
      fallback: !track.manualQuery && primary !== broad ? broad : '',
    };
  }

  const versionGroups = {
    live: ['live'],
    remix: ['remix', 'remixed'],
    remaster: ['remaster', 'remastered'],
    acoustic: ['acoustic'],
    instrumental: ['instrumental'],
    karaoke: ['karaoke'],
    radio_edit: ['radio edit'],
    extended_mix: ['extended mix', 'extended version'],
    sped_up: ['sped up', 'speed up'],
    slowed: ['slowed', 'slowed down'],
    mono: ['mono'],
    stereo: ['stereo'],
    demo: ['demo'],
    edit: ['edit'],
  };

  function versions(value) {
    const text = normalizeText(value);
    return new Set(Object.entries(versionGroups)
      .filter(([, markers]) => markers.some((marker) => (` ${text} `).includes(` ${marker} `)))
      .map(([group]) => group));
  }

  function similarityNormalized(a, b) {
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

  function similarity(left, right) {
    const direct = similarityNormalized(normalizeText(left), normalizeText(right));
    const romanized = similarityNormalized(normalizeText(romanize(left)), normalizeText(romanize(right)));
    return Math.max(direct, romanized);
  }

  function titleWithoutFeatureCredits(value) {
    return String(value || '')
      .replace(/[([{]\s*(?:feat\.?|featuring|ft\.?|with)\s+[^)\]}]*[)\]}]/gi, ' ')
      .replace(/\s+(?:feat\.?|featuring|ft\.?)\s+.*$/i, ' ');
  }

  function artistScore(sourceArtist, candidateArtist) {
    const splitCredits = (value) => {
      const names = Array.isArray(value) ? value.map((item) => typeof item === 'string' ? item : item?.name || item?.title || '') : [String(value || '')];
      return names.flatMap((name) => String(name).split(/\s+(?:feat\.?|featuring|ft\.?|with|and)\s+|,|;|\s*&\s*/i))
        .map(normalizeText).filter(Boolean);
    };
    const source = splitCredits(sourceArtist);
    const candidate = splitCredits(candidateArtist);
    if (!source.length || !candidate.length) return 0;
    const matrix = source.map((name) => candidate.map((other) => similarity(name, other)));
    if (source.length === 1 || candidate.length === 1) {
      // Providers frequently omit featured artists in one catalog. A lone
      // credit on either side should match the strongest corresponding name.
      return Math.max(...matrix.flat());
    }
    const sourceCoverage = matrix.map((scores) => Math.max(...scores));
    const candidateCoverage = matrix[0].map((_, candidateIndex) => Math.max(...matrix.map((scores) => scores[candidateIndex])));
    const allCoverage = [...sourceCoverage, ...candidateCoverage];
    return allCoverage.reduce((sum, score) => sum + score, 0) / allCoverage.length;
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

    const title = similarity(
      titleWithoutFeatureCredits(source.title),
      titleWithoutFeatureCredits(candidate.trackName || candidate.title || candidate.name),
    );
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

  function candidateISRC(candidate) {
    return normalizeISRC(candidate?.isrc || candidate?.ISRC || candidate?.externalIds?.isrc);
  }

  function suggestBestMatch(source, candidates) {
    const ranked = candidates.map((candidate) => ({ candidate, ...scoreCandidate(source, candidate) }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0] || null;
    const runnerUp = ranked[1] || null;
    const margin = best ? best.score - (runnerUp?.score ?? 0) : 0;
    const bestISRC = candidateISRC(best?.candidate);
    const closeRivals = best ? ranked.filter((candidate) => best.score - candidate.score < 0.035) : [];
    const sameRecordingDuplicates = Boolean(bestISRC && closeRivals.length > 1
      && closeRivals.every((candidate) => candidateISRC(candidate.candidate) === bestISRC && !candidate.versionConflict));
    const automatic = Boolean(best && !best.versionConflict && (best.exactISRC
      || (best.score >= 0.96 && (margin >= 0.035 || sameRecordingDuplicates))));
    return {
      best: best?.candidate || null,
      confidence: best?.score || 0,
      automatic,
      reason: !best ? 'no_candidates' : best.exactISRC ? 'exact_isrc' : sameRecordingDuplicates && automatic ? 'catalog_duplicates_same_isrc' : automatic ? 'high_confidence_metadata' : 'manual_review',
      ranked,
      margin,
    };
  }

  window.MusicMatcher = { normalizeISRC, sourceRecordingKey, sourceSearchGroupKey, catalogSearchGroupKey, propagateSourceMatch, romanize, detransliterate, buildSearchQueries, scoreCandidate, suggestBestMatch };
})();
