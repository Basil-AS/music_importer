(() => {
  const marker = 'music-importer-yandex';
  const api = 'https://api.music.yandex.ru';
  const batchSize = 25;
  let scanPromise = null;

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  async function request(path, init = {}) {
    const response = await window.fetch(`${api}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`Яндекс Музыка: HTTP ${response.status} для ${path.split('?')[0]}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(`Яндекс Музыка: ${String(payload.error.message || payload.error.name || 'ошибка API')}`);
    return payload?.result ?? payload;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.tracks)) return value.tracks;
    if (Array.isArray(value?.items)) return value.items;
    return null;
  }

  function trackId(value) {
    const track = value?.track || value;
    const id = track?.id ?? value?.id;
    return id === null || id === undefined ? '' : String(id);
  }

  function normalizeTrack(value, position = null) {
    const track = value?.track || value;
    const artists = Array.isArray(track?.artists) ? track.artists : track?.artist ? [track.artist] : [];
    const album = Array.isArray(track?.albums) ? track.albums[0] : track?.album;
    const title = String(track?.title || track?.name || '').trim();
    const artistNames = artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean);
    if (!title || artistNames.length === 0) return null;
    const durationMs = Number(track?.durationMs || track?.duration_ms || track?.duration || 0);
    return {
      id: trackId(track),
      title,
      artists: artistNames,
      album: String(album?.title || album?.name || (typeof album === 'string' ? album : '') || ''),
      isrc: String(track?.isrc || track?.ISRC || ''),
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      position,
    };
  }

  async function hydrate(ids, label) {
    const hydrated = [];
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize);
      const form = new URLSearchParams({ 'track-ids': batch.join(','), 'with-positions': 'false' });
      const result = await request('/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: form.toString(),
      });
      const rows = asArray(result);
      if (!rows) throw new Error(`Неизвестный ответ Яндекс Музыки при чтении ${label}.`);
      const byId = new Map(rows.map((row) => [trackId(row), row]).filter(([id]) => id));
      if (batch.some((id) => !byId.has(String(id)))) throw new Error(`Яндекс Музыка вернула не все карточки: ${label}, batch ${offset + 1}–${offset + batch.length}.`);
      for (const id of batch) hydrated.push(byId.get(String(id)));
      post('scan-progress', { phase: 'metadata', message: `${label}: загружено ${hydrated.length} из ${ids.length}.` });
      if (offset + batchSize < ids.length) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return hydrated;
  }

  async function readFavorites(uid) {
    const result = await request(`/users/${encodeURIComponent(uid)}/likes/tracks?if-modified-since-revision=0`);
    const library = result?.library || result;
    const refs = asArray(library);
    if (!refs || library?.revision === null || library?.revision === undefined || !Number.isInteger(Number(library.revision))) throw new Error('Не удалось подтвердить список лайков Яндекс Музыки.');
    const ids = refs.map(trackId);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('В ответе лайков Яндекс Музыки есть пустые или повторные ID.');
    const rows = await hydrate(ids, 'Лайки');
    const tracks = rows.map((row, index) => normalizeTrack(row, index));
    if (tracks.some((track) => !track) || tracks.length !== refs.length) throw new Error('Карточки лайков Яндекс Музыки неполны.');
    return { tracks, revision: Number(library.revision), count: refs.length };
  }

  function playlistListFrom(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.playlists)) return result.playlists;
    if (Array.isArray(result?.items)) return result.items;
    return null;
  }

  async function readPlaylist(uid, playlist) {
    const ownerId = String(playlist.uid ?? playlist.owner?.uid ?? uid);
    const kind = String(playlist.kind ?? playlist.id ?? '');
    if (!kind) throw new Error('В каталоге Яндекс Музыки есть playlist без kind.');
    const result = await request(`/users/${encodeURIComponent(ownerId)}/playlists/${encodeURIComponent(kind)}`);
    const detail = Array.isArray(result) ? result[0] : result?.playlist || result;
    const refs = asArray(detail);
    const total = Number(detail?.trackCount ?? detail?.track_count ?? playlist.trackCount ?? playlist.track_count);
    if (!refs || !Number.isInteger(total)) throw new Error(`Нет подтверждённого состава плейлиста «${playlist.title || playlist.name || kind}».`);
    let rows;
    if (refs.every((row) => (row?.track || row)?.title && (row?.track || row)?.artists)) rows = refs.map((row) => row?.track || row);
    else rows = await hydrate(refs.map(trackId), `Плейлист ${playlist.title || playlist.name || kind}`);
    const tracks = rows.map((row, position) => normalizeTrack(row, position));
    if (tracks.some((track) => !track) || tracks.length !== total) throw new Error(`Полнота плейлиста «${playlist.title || playlist.name || kind}» не сошлась: ${tracks.length} из ${total}.`);
    return {
      id: `yandex:${ownerId}:${kind}`,
      title: String(playlist.title || playlist.name || detail.title || `Плейлист ${kind}`),
      trackCount: total,
      revision: String(detail?.revision || ''),
      complete: true,
      tracks,
    };
  }

  function searchRows(result) {
    const tracks = result?.tracks?.results ?? result?.tracks ?? result?.results;
    return Array.isArray(tracks) ? tracks : null;
  }

  function normalizeCandidate(track) {
    const normalized = normalizeTrack(track);
    const album = Array.isArray(track?.albums) ? track.albums[0] : track?.album;
    const trackIdValue = track?.id;
    const albumId = album?.id ?? track?.albumId;
    if (!normalized || !trackIdValue || !albumId) return null;
    return {
      trackId: String(trackIdValue),
      providerId: String(trackIdValue),
      albumId: String(albumId),
      trackName: normalized.title,
      artistName: normalized.artists.join(', '),
      collectionName: String(album?.title || album?.name || ''),
      trackTimeMillis: normalized.durationMs,
      isrc: normalized.isrc,
      trackViewUrl: `https://music.yandex.ru/album/${encodeURIComponent(String(albumId))}/track/${encodeURIComponent(String(trackIdValue))}`,
    };
  }

  async function searchTracks(query) {
    const params = new URLSearchParams({ text: String(query || '').trim(), page: '0', type: 'track' });
    const result = await request(`/search?${params.toString()}`);
    const rows = searchRows(result);
    if (!rows) throw new Error('Яндекс Музыка вернула неизвестный формат поиска треков.');
    return rows.map(normalizeCandidate).filter(Boolean).slice(0, 20);
  }

  async function readPlaylistDetail(uid, kind) {
    const result = await request(`/users/${encodeURIComponent(uid)}/playlists/${encodeURIComponent(kind)}`);
    const detail = Array.isArray(result) ? result[0] : result?.playlist || result;
    const refs = asArray(detail);
    const total = Number(detail?.trackCount ?? detail?.track_count);
    if (!detail || !refs || !Number.isInteger(total) || !detail.revision) throw new Error('Яндекс Музыка не вернула revision и полное состояние плейлиста.');
    return { detail, refs, total, revision: String(detail.revision) };
  }

  async function postForm(path, fields) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
    });
  }

  function sourcePlaylistKey(operation) {
    return String(operation.source.collectionId || operation.source.collectionName || '');
  }

  async function addFavorites(uid, plan, progress, onWriteStarted) {
    const favoriteOperations = plan.operations.filter((operation) => operation.operation === 'add_to_favorites' || plan.target.collectionType === 'favorites');
    if (!favoriteOperations.length) return { added: 0, existing: 0, verified: 0 };
    const existingResult = await request(`/users/${encodeURIComponent(uid)}/likes/tracks?if-modified-since-revision=0`);
    const library = existingResult?.library || existingResult;
    const refs = asArray(library);
    if (!refs) throw new Error('Не удалось прочитать текущее избранное Яндекс Музыки перед записью.');
    const existingIds = new Set(refs.map(trackId).filter(Boolean));
    const wanted = [...new Set(favoriteOperations.map((operation) => String(operation.target.providerId || '')))].filter(Boolean);
    const missing = wanted.filter((id) => !existingIds.has(id));
    let added = 0;
    for (let offset = 0; offset < missing.length; offset += 25) {
      const batch = missing.slice(offset, offset + 25);
      onWriteStarted?.();
      await postForm(`/users/${encodeURIComponent(uid)}/likes/tracks/add-multiple`, { 'track-ids': batch.join(',') });
      added += batch.length;
      progress?.({ phase: 'favorites', completed: Math.min(offset + batch.length, missing.length), total: missing.length });
    }
    const afterResult = await request(`/users/${encodeURIComponent(uid)}/likes/tracks?if-modified-since-revision=0`);
    const afterLibrary = afterResult?.library || afterResult;
    const afterRefs = asArray(afterLibrary);
    if (!afterRefs) throw new Error('Избранное записано, но Яндекс Музыка не вернула список для обратной сверки.');
    const afterIds = new Set(afterRefs.map(trackId).filter(Boolean));
    const verified = wanted.filter((id) => afterIds.has(id)).length;
    if (verified !== wanted.length) throw new Error(`Обратная сверка лайков неполная: подтверждено ${verified} из ${wanted.length}.`);
    return { added, existing: wanted.length - missing.length, verified };
  }

  async function createPlaylist(uid, title) {
    const created = await postForm(`/users/${encodeURIComponent(uid)}/playlists/create`, { title, visibility: 'private' });
    const playlist = created?.playlist || created;
    const kind = playlist?.kind ?? playlist?.id;
    if (!kind) throw new Error(`Яндекс Музыка не вернула ID созданного плейлиста «${title}».`);
    return { kind: String(kind), title: String(playlist.title || title) };
  }

  async function appendPlaylistItems(uid, kind, items, progress) {
    const initial = await readPlaylistDetail(uid, kind);
    let expectedPosition = initial.total;
    let written = 0;
    for (let offset = 0; offset < items.length; offset += 25) {
      const batch = items.slice(offset, offset + 25);
      const current = await readPlaylistDetail(uid, kind);
      if (current.total !== expectedPosition) throw new Error('Плейлист изменился во время записи; остановил импорт для защиты порядка.');
      const tracks = batch.map((operation) => {
        const id = String(operation.target.providerId || '');
        const albumId = String(operation.target.albumId || '');
        if (!id || !albumId) throw new Error('Для записи в плейлист Яндекса нужны track ID и album ID.');
        return { id, albumId };
      });
      await postForm(`/users/${encodeURIComponent(uid)}/playlists/${encodeURIComponent(kind)}/change-relative`, {
        revision: current.revision,
        diff: JSON.stringify({ op: 'insert', at: expectedPosition, tracks }),
      });
      expectedPosition += batch.length;
      written += batch.length;
      progress?.({ phase: 'playlist-items', completed: written, total: items.length });
    }
    const after = await readPlaylistDetail(uid, kind);
    if (after.total !== expectedPosition) throw new Error(`Обратная сверка плейлиста не сошлась: ожидалось ${expectedPosition}, получено ${after.total}.`);
    const expectedIds = items.map((operation) => String(operation.target.providerId));
    const actualRefs = after.refs.slice(initial.total, initial.total + expectedIds.length).map(trackId);
    if (actualRefs.length !== expectedIds.length || actualRefs.some((id, index) => id !== expectedIds[index])) {
      throw new Error('Обратная сверка плейлиста обнаружила несовпадение треков или порядка.');
    }
    return { written, verified: actualRefs.length };
  }

  async function executeTransfer(plan, requestId) {
    if (!plan || plan.type !== 'music-transfer-plan' || plan.target?.provider !== 'yandex-music') throw new Error('Нужен план переноса с целью «Яндекс Музыка».');
    if (!Array.isArray(plan.operations) || (!plan.operations.length && !plan.collectionMappings?.length)) throw new Error('В плане нет выбранных совпадений или плейлистов.');
    if (!['favorites', 'playlists', 'library'].includes(plan.target.collectionType)) throw new Error('Неизвестный тип коллекции назначения.');
    if (!Array.isArray(plan.completeness?.source) || !plan.completeness.source.length || plan.completeness.source.some((status) => status?.confirmed !== true)) {
      throw new Error('Запись остановлена: полнота исходной библиотеки не подтверждена.');
    }
    if (plan.operations.some((operation) => !operation?.target?.providerId)) throw new Error('В плане есть совпадение без ID трека назначения.');
    const account = await request('/account/status');
    const uidValue = account?.account?.uid ?? account?.uid;
    if (uidValue === null || uidValue === undefined) throw new Error('Войдите в Яндекс Музыку в этой вкладке и повторите запись.');
    const uid = String(uidValue);
    const report = { status: 'writing', targetProvider: 'yandex-music', startedAt: new Date().toISOString(), favorites: null, playlists: [], failures: [] };
    let writesStarted = false;
    const update = (progress) => post('transfer-progress', {
      requestId,
      progress: {
        ...progress,
        message: progress.message || (progress.phase === 'favorites'
          ? `Добавляем лайки: ${progress.completed} из ${progress.total}`
          : `Добавляем треки в плейлист: ${progress.completed} из ${progress.total}`),
      },
    });
    try {
      report.favorites = await addFavorites(uid, plan, update, () => { writesStarted = true; });
      const playlistOperations = plan.operations.filter((operation) => operation.operation === 'add_to_playlist' || plan.target.collectionType === 'playlists');
      const mappings = plan.target.collectionType === 'favorites' ? [] : (plan.collectionMappings || []);
      for (const [index, mapping] of mappings.entries()) {
        const matching = playlistOperations.filter((operation) => sourcePlaylistKey(operation) === String(mapping.sourceId || mapping.sourceName || ''))
          .sort((left, right) => Number(left.source.position || 0) - Number(right.source.position || 0));
        writesStarted = true;
        const created = await createPlaylist(uid, String(mapping.targetName || mapping.sourceName || 'Перенесённый плейлист').slice(0, 100));
        const result = await appendPlaylistItems(uid, created.kind, matching, update);
        report.playlists.push({ title: created.title, written: result.written, verified: result.verified });
        update({ phase: 'playlists', completed: index + 1, total: mappings.length, message: `Плейлисты: ${index + 1} из ${mappings.length}` });
      }
      report.status = 'complete';
      report.finishedAt = new Date().toISOString();
      return report;
    } catch (error) {
      report.status = writesStarted || report.favorites?.verified || report.playlists.length ? 'partial_failure' : 'failed';
      report.error = error instanceof Error ? error.message : 'Яндекс Музыка не завершила перенос.';
      report.finishedAt = new Date().toISOString();
      throw Object.assign(new Error(report.error), { transferReport: report });
    }
  }

  async function scanLibrary() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      const accountResult = await request('/account/status');
      const uidValue = accountResult?.account?.uid ?? accountResult?.uid;
      if (uidValue === null || uidValue === undefined) throw new Error('Яндекс Музыка не вернула UID текущего аккаунта. Войдите в сервис и повторите.');
      const uid = String(uidValue);
      post('scan-progress', { phase: 'favorites', message: 'Читаем лайки Яндекс Музыки…' });
      const favorites = await readFavorites(uid);
      post('scan-progress', { phase: 'playlists', message: 'Читаем каталог плейлистов Яндекс Музыки…' });
      const playlistResult = await request(`/users/${encodeURIComponent(uid)}/playlists/list`);
      const playlistRows = playlistListFrom(playlistResult);
      if (!playlistRows) throw new Error('Яндекс Музыка вернула неизвестный формат списка плейлистов.');
      const kindsResult = await request(`/users/${encodeURIComponent(uid)}/playlists/list/kinds`);
      if (!Array.isArray(kindsResult)) throw new Error('Яндекс Музыка не вернула независимый список playlist kinds.');
      const expectedKinds = kindsResult.map((kind) => String(kind));
      const listedKinds = playlistRows.map((playlist) => String(playlist.kind ?? playlist.id ?? ''));
      const expectedSorted = expectedKinds.slice().sort();
      const listedSorted = listedKinds.slice().sort();
      if (expectedKinds.some((kind) => !kind) || listedKinds.some((kind) => !kind)
        || new Set(expectedKinds).size !== expectedKinds.length
        || expectedKinds.length !== listedKinds.length
        || expectedSorted.some((kind, index) => kind !== listedSorted[index])) {
        throw new Error('Список Яндекс Музыки и независимый список playlist kinds не совпали.');
      }
      const unique = new Set();
      const playlists = [];
      for (const [index, playlist] of playlistRows.entries()) {
        const key = `${playlist.uid ?? playlist.owner?.uid ?? uid}:${playlist.kind ?? playlist.id ?? ''}`;
        if (unique.has(key)) throw new Error('Каталог плейлистов Яндекс Музыки содержит повторный kind.');
        unique.add(key);
        post('scan-progress', { phase: 'playlists', message: `Плейлист ${index + 1} из ${playlistRows.length}: ${playlist.title || playlist.name || 'без названия'}.` });
        playlists.push(await readPlaylist(uid, playlist));
      }
      return {
        schemaVersion: 1,
        service: 'yandex-music',
        collection: { type: 'library', name: 'Вся библиотека' },
        completeness: {
          confirmed: true,
          favoritesConfirmed: true,
          favoritesCount: favorites.count,
          favoritesRevision: favorites.revision,
          catalogConfirmed: true,
          playlistCatalogKindsConfirmed: true,
          playlistItemsConfirmed: playlists.every((playlist) => playlist.complete),
          playlistItemsTotal: playlists.length,
        },
        tracks: favorites.tracks.map((track) => ({ ...track, collectionType: 'favorites' })),
        playlists,
      };
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type === 'search-tracks') {
      const requestId = String(event.data.requestId || '');
      try {
        const results = await searchTracks(event.data.query);
        post('command-response', { requestId, ok: true, results });
      } catch (error) {
        post('command-response', { requestId, ok: false, error: error instanceof Error ? error.message : 'Поиск Яндекс Музыки не выполнен.' });
      }
      return;
    }
    if (event.data.type === 'execute-transfer') {
      const requestId = String(event.data.requestId || '');
      try {
        const report = await executeTransfer(event.data.plan, requestId);
        post('command-response', { requestId, ok: true, report });
      } catch (error) {
        post('command-response', { requestId, ok: false, error: error instanceof Error ? error.message : 'Перенос в Яндекс Музыку не выполнен.', report: error?.transferReport || null });
      }
      return;
    }
    if (event.data.type !== 'start-library-scan') return;
    try {
      post('scan-progress', { phase: 'starting', message: 'Подключаем активную сессию Яндекс Музыки…' });
      const payload = await scanLibrary();
      post('library-snapshot', { payload });
    } catch (error) {
      post('scan-error', { error: error instanceof Error ? error.message : 'Не удалось прочитать библиотеку Яндекс Музыки.' });
    }
  });
})();
