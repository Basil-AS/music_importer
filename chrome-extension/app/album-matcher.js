/* Album matching: exact UPC first, then normalized title + artist + track count. */
(() => {
  const autoThreshold = 0.96;
  const reviewThreshold = 0.6;

  const normalizeUpc = (value) => String(value || '').replace(/[^0-9]/g, '').replace(/^0+/, '');

  function artistNames(value) {
    if (Array.isArray(value)) return value.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean).map(String);
    return String(value || '').split(/\s*,\s*/).filter(Boolean);
  }

  function sourceArtists(album) {
    const names = artistNames(album?.artists);
    return names.length ? names : artistNames(album?.artist || album?.artistName);
  }

  function candidateArtists(candidate) {
    const names = artistNames(candidate?.artists);
    return names.length ? names : artistNames(candidate?.artistName || candidate?.artist);
  }

  function candidateId(candidate) {
    return String(candidate?.albumId ?? candidate?.providerId ?? candidate?.id ?? '');
  }

  function artistScore(left, right) {
    const similarity = window.MusicMatcher.similarity;
    if (!left.length || !right.length) return 0;
    const sorted = (names) => names.map((name) => window.MusicMatcher.normalizeText(name)).sort().join(' ');
    return Math.max(
      similarity(left.join(' '), right.join(' ')),
      similarity(sorted(left), sorted(right)),
      similarity(left[0], right[0]) * (left.length === 1 || right.length === 1 ? 1 : 0.95),
    );
  }

  function scoreAlbum(source, candidate) {
    const sourceUpc = normalizeUpc(source?.upc);
    const candidateUpc = normalizeUpc(candidate?.upc);
    const title = window.MusicMatcher.similarity(source?.title || '', candidate?.title || candidate?.name || '');
    const artist = artistScore(sourceArtists(source), candidateArtists(candidate));
    const sourceTracks = Number(source?.trackCount) || 0;
    const candidateTracks = Number(candidate?.trackCount) || 0;
    const trackCount = sourceTracks && candidateTracks ? (sourceTracks === candidateTracks ? 'match' : 'mismatch') : 'unknown';
    const upcExact = Boolean(sourceUpc && candidateUpc && sourceUpc === candidateUpc);
    const trackBonus = trackCount === 'match' ? 1 : trackCount === 'unknown' ? 0.5 : 0;
    const score = upcExact ? 1 : Math.min(0.99, 0.5 * title + 0.4 * artist + 0.1 * trackBonus);
    return { score, title, artist, trackCount, upcExact };
  }

  // Auto-accept only exact UPC, or title+artist >= 0.96 with an equal known track count, and only
  // when exactly one distinct album qualifies; everything else goes to the review queue.
  function suggestAlbumMatch(source, candidates) {
    const rows = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidateId(candidate))
      .map((candidate) => ({ candidate, ...scoreAlbum(source, candidate) }))
      .sort((left, right) => right.score - left.score);
    if (!rows.length) return { best: null, confidence: 0, automatic: false, reason: 'no_candidates', ranked: [] };
    const isAuto = (row) => row.upcExact || (row.title >= autoThreshold && row.artist >= autoThreshold && row.trackCount === 'match');
    // An exact UPC outranks title/artist guesses; two different albums sharing one UPC stay ambiguous.
    const upcRows = rows.filter((row) => row.upcExact);
    const qualified = upcRows.length ? upcRows : rows.filter(isAuto);
    const qualifiedIds = new Set(qualified.map((row) => candidateId(row.candidate)));
    const best = rows[0];
    if (qualifiedIds.size === 1) {
      const winner = qualified[0];
      return { best: winner.candidate, confidence: winner.score, automatic: true, reason: winner.upcExact ? 'upc_exact' : 'title_artist_trackcount', ranked: rows };
    }
    return {
      best: best.score >= reviewThreshold ? best.candidate : null,
      confidence: best.score,
      automatic: false,
      reason: qualifiedIds.size > 1 ? 'ambiguous' : 'low_confidence',
      ranked: rows,
    };
  }

  // One catalog request per album: UPC when known (the provider falls back to title + artist).
  function albumSearchDetails(album) {
    return {
      album: String(album?.title || '').trim(),
      artist: sourceArtists(album)[0] || '',
      upc: normalizeUpc(album?.upc) ? String(album.upc).replace(/[^0-9]/g, '') : '',
    };
  }

  const commandProviders = { 'apple-music': 'apple', 'yandex-music': 'yandex', zvuk: 'zvuk', spotify: 'spotify' };

  function normalizeSourceAlbum(item) {
    const sourceId = String(item?.providerId || item?.id || '').trim();
    if (!sourceId) return null;
    const artists = sourceArtists(item);
    const title = String(item?.title || item?.name || '').trim();
    const trackCount = Number(item?.trackCount);
    return {
      sourceId, providerId: sourceId, title, artists, artist: artists.join(', '),
      upc: String(item?.upc || '').replace(/[^0-9]/g, ''),
      trackCount: Number.isInteger(trackCount) && trackCount > 0 ? trackCount : null,
      releaseDate: String(item?.releaseDate || ''),
      artworkUrl: String(item?.artworkUrl || ''),
      metadataComplete: item?.metadataComplete !== false && Boolean(title && artists.length),
    };
  }

  // Provider snapshots keep saved albums in `collections` (Spotify, Yandex, Zvuk) or `albumsCollection` (Apple).
  // Returns null for snapshots that predate album support; otherwise { rows, confirmed }.
  function extractSourceAlbums(payload) {
    const entry = (Array.isArray(payload?.collections) ? payload.collections.find((collection) => collection?.type === 'albums') : null)
      || (payload?.albumsCollection?.type === 'albums' ? payload.albumsCollection : null);
    const claimed = payload?.completeness?.albumsConfirmed;
    if (!entry && claimed === undefined) return null;
    const rawItems = Array.isArray(entry?.items) ? entry.items : [];
    const rows = rawItems.map(normalizeSourceAlbum).filter(Boolean);
    const ids = rows.map((row) => row.sourceId);
    const expected = payload?.completeness?.albumsCount;
    const confirmed = claimed === true && Boolean(entry) && entry.completeness?.confirmed !== false && entry.complete !== false
      && rows.length === rawItems.length && new Set(ids).size === ids.length
      && (!Number.isInteger(expected) || expected === rows.length);
    return { rows: confirmed ? rows : [], confirmed };
  }

  // Which albums a picker scope carries: 'all' takes confirmed albums only (unconfirmed ones are reported
  // as skipped, never half-transferred); 'albums' keeps the collection even when unconfirmed so the
  // plan fails closed; likes-only and single-playlist scopes carry none.
  function albumsForScope(payload, scope) {
    const info = extractSourceAlbums(payload);
    if (!info) return { albums: null, skipped: false };
    if (scope === 'albums') return { albums: { rows: info.rows, confirmed: info.confirmed }, skipped: false };
    if (scope === 'all') return info.confirmed ? { albums: info, skipped: false } : { albums: null, skipped: true };
    return { albums: null, skipped: false };
  }

  function albumPlanSummary(plan) {
    const operations = Array.isArray(plan?.operations) ? plan.operations : [];
    return {
      likes: operations.filter((operation) => operation.operation === 'add_to_favorites').length,
      albums: operations.filter((operation) => operation.operation === 'add_album').length,
      playlistItems: operations.filter((operation) => operation.operation === 'add_to_playlist').length,
      playlists: Array.isArray(plan?.collectionMappings) ? plan.collectionMappings.length : 0,
    };
  }

  function commandError(response, fallback) {
    const error = new Error(response?.error || fallback);
    const status = Number(response?.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
    if (response?.retryAfter !== undefined && response?.retryAfter !== null) error.retryAfter = String(response.retryAfter);
    if (response?.report) error.report = response.report;
    return error;
  }

  // Maps the engine's album adapter contract onto provider commands. `request` has the
  // requestExtensionCommand(action, details, commandProvider, onProgress) signature.
  function createAlbumTarget(provider, request) {
    const commandProvider = commandProviders[provider];
    if (!commandProvider) throw new Error('Для выбранного сервиса назначения альбомы не подключены.');

    async function searchAlbums(album, context = {}) {
      const details = albumSearchDetails(album);
      const payload = provider === 'zvuk' ? { query: `${details.album} ${details.artist}`.trim() }
        : provider === 'yandex-music' ? { album: details.album, artist: details.artist }
          : provider === 'spotify' ? details
            : { ...details, storefront: context.storefront };
      const response = await request('search-albums', payload, commandProvider);
      if (!response?.ok || !Array.isArray(response.results)) throw commandError(response, 'Не удалось найти альбом в каталоге.');
      return response.results.slice(0, 25);
    }

    async function readDestination() {
      if (provider === 'zvuk') return { complete: false, items: [], error: 'Сбер.Звук не отдаёт список сохранённых альбомов отдельной командой.' };
      const action = provider === 'apple-music' ? 'read-library-albums' : 'read-albums';
      const response = await request(action, {}, commandProvider);
      if (!response?.ok) throw commandError(response, 'Не удалось прочитать сохранённые альбомы.');
      const report = provider === 'yandex-music' ? { complete: response.collection?.complete === true, items: response.items } : response.report;
      const items = Array.isArray(report?.items) ? report.items : [];
      return {
        complete: report?.complete === true,
        total: Number.isInteger(report?.total) ? report.total : items.length,
        items: items.map((item) => ({ ...item, providerId: String(item?.providerId || item?.catalogId || item?.libraryId || item?.id || '') })),
      };
    }

    async function readBack(request_) {
      if (provider === 'spotify') {
        const ids = [...new Set((request_.operations || []).map((operation) => String(operation.target?.providerId || '')))].filter(Boolean);
        const response = await request('read-albums', { ids }, 'spotify');
        if (!response?.ok) throw commandError(response, 'Не удалось сверить сохранённые альбомы.');
        return { complete: response.report?.complete === true, items: Array.isArray(response.report?.items) ? response.report.items : [] };
      }
      return readDestination();
    }

    async function writeAlbums(targets, options = {}) {
      if (provider === 'spotify') {
        const response = await request('write-albums', { targets }, 'spotify', options.onProgress || null);
        if (!response?.ok) throw commandError(response, 'Spotify не сохранил альбомы.');
        return { writtenCount: Number(response.report?.writtenCount ?? response.report?.written ?? targets.length), report: response.report || null };
      }
      if (!options.plan) throw new Error('Для записи альбомов нужен подтверждённый план переноса.');
      const plan = { ...options.plan, target: { ...options.plan.target, collectionType: 'albums' }, collectionMappings: [],
        operations: options.plan.operations.filter((operation) => operation.operation === 'add_album') };
      const response = await request('execute-transfer', { plan }, commandProvider, options.onProgress || null);
      if (!response?.ok) throw commandError(response, 'Сервис не сохранил альбомы.');
      return { writtenCount: targets.length, report: response.report || null };
    }

    return { searchAlbums, readDestination, readBack, writeAlbums };
  }

  // Spotify saves albums with its own command; every other provider handles add_album inside execute-transfer.
  // The merged result keeps the single-response shape the UI already understands.
  async function executePlanOnTarget(provider, plan, request, onProgress = null) {
    const commandProvider = commandProviders[provider];
    if (!commandProvider) throw new Error('Сервис назначения неизвестен.');
    const albumOperations = provider === 'spotify' ? plan.operations.filter((operation) => operation.operation === 'add_album') : [];
    if (!albumOperations.length) return request('execute-transfer', { plan }, commandProvider, onProgress);
    const trackPlan = { ...plan, operations: plan.operations.filter((operation) => operation.operation !== 'add_album') };
    let report = { status: 'complete' };
    if (trackPlan.operations.length || (trackPlan.collectionMappings || []).length) {
      const response = await request('execute-transfer', { plan: trackPlan }, commandProvider, onProgress);
      if (!response?.ok) return response;
      report = response.report || report;
    }
    try {
      const written = await createAlbumTarget(provider, request).writeAlbums(albumOperations.map((operation) => operation.target), { onProgress });
      return { ok: true, report: { ...report, albums: written.report } };
    } catch (error) {
      return { ok: false, error: error.message, report: { ...report, status: 'partial_failure', ...(error.report ? { albums: error.report.albums || error.report } : {}) } };
    }
  }

  window.MusicAlbumMatcher = Object.freeze({ createAlbumTarget, executePlanOnTarget, extractSourceAlbums, albumsForScope, albumPlanSummary, normalizeSourceAlbum, normalizeUpc, scoreAlbum, suggestAlbumMatch, albumSearchDetails, sourceArtists, candidateId });
})();
