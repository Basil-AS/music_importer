(() => {
  const marker = 'music-importer-yandex';
  const api = 'https://api.music.yandex.ru';
  const batchSize = 25;
  const playlistPageSize = 100;
  const maxPlaylistPages = 2000;
  let scanPromise = null;
  const checkpointWaiters = new Map();
  let checkpointSequence = 0;

  function post(type, detail = {}) {
    window.postMessage({ source: marker, type, ...detail }, location.origin);
  }

  function awaitCheckpoint(requestId, progress) {
    const checkpointId = `${requestId}:${++checkpointSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        checkpointWaiters.delete(checkpointId);
        resolve(false);
      }, 20000);
      checkpointWaiters.set(checkpointId, (ok) => {
        clearTimeout(timer);
        checkpointWaiters.delete(checkpointId);
        resolve(ok === true);
      });
      post('transfer-progress', { requestId, progress: { ...progress, checkpointId } });
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker
      || event.data?.type !== 'transfer-progress-ack') return;
    checkpointWaiters.get(String(event.data.checkpointId || ''))?.(event.data.ok === true);
  });

  async function request(path, init = {}) {
    const safePath = path.split('?')[0].replace(/^\/users\/[^/]+/, '/users/{uid}');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await window.fetch(`${api}${path}`, {
        credentials: 'include',
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(init.headers || {}),
        },
      });
      if (!response.ok) throw Object.assign(new Error(`Яндекс Музыка: HTTP ${response.status} для ${safePath}`), {
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') || null,
      });
      const payload = await response.json();
      if (payload?.error) throw new Error(`Яндекс Музыка: ${String(payload.error.message || payload.error.name || 'ошибка API')}`);
      return payload?.result ?? payload;
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error(`Яндекс Музыка не ответила за 45 с: ${safePath}`), { name: 'AbortError' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function retryAfterDelay(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  async function libraryRequest(path, init = {}) {
    const label = path.split('?')[0];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(path, init);
      } catch (error) {
        const status = Number(error?.status);
        const retryable = (error?.name === 'TypeError' || error?.name === 'AbortError')
          || status === 408 || status === 429 || status >= 500;
        if (!retryable || attempt >= 3) throw error;
        const retryAfter = status === 429 ? retryAfterDelay(error.retryAfter) : null;
        let remaining = retryAfter ?? 500 * (2 ** attempt);
        while (remaining > 0) {
          const interval = Math.min(remaining, 15000);
          await new Promise((resolve) => setTimeout(resolve, interval));
          remaining -= interval;
          if (scanPromise) {
            const seconds = Math.ceil(remaining / 1000);
            post('scan-progress', {
              phase: 'retry',
              message: seconds
                ? `Яндекс Музыка временно ограничила запросы; повторим через ${seconds} с (${label}).`
                : `Повторяем временно неудачный запрос Яндекс Музыки (${label}).`,
            });
          }
        }
      }
    }
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
      artworkUrl: String(album?.coverUri || album?.coverUrl || album?.cover?.url || track?.coverUri || track?.cover?.url || ''),
      releaseDate: String(album?.releaseDate || album?.year || track?.releaseDate || ''),
      isrc: String(track?.isrc || track?.ISRC || ''),
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      position,
    };
  }

  function normalizeLibraryTrack(value, position = null) {
    const normalized = normalizeTrack(value, position);
    if (normalized) return { ...normalized, metadataComplete: true };
    const id = trackId(value);
    if (!id) throw new Error('В библиотеке Яндекс Музыки есть трек без ID.');
    return {
      id,
      title: '',
      artists: [],
      album: '',
      isrc: '',
      durationMs: 0,
      position,
      metadataComplete: false,
    };
  }

  async function hydrate(ids, label) {
    const hydrated = [];
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize);
      const form = new URLSearchParams({ 'track-ids': batch.join(','), 'with-positions': 'false' });
      const result = await libraryRequest('/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: form.toString(),
      });
      const rows = asArray(result);
      if (!rows) throw new Error(`Неизвестный ответ Яндекс Музыки при чтении ${label}.`);
      const byId = new Map(rows.map((row) => [trackId(row), row]).filter(([id]) => id));
      for (const id of batch) {
        const known = byId.get(String(id));
        if (known) {
          hydrated.push(known);
          continue;
        }

        // A successful batch can still omit individual cards (e.g. stale or
        // partially indexed IDs). Retry only those IDs before preserving them
        // as metadata-incomplete entries in the confirmed collection.
        post('scan-progress', {
          phase: 'metadata',
          message: `${label}: отдельно запрашиваем карточку трека ${hydrated.length + 1} из ${ids.length}.`,
        });
        let recovered = null;
        try {
          const singleForm = new URLSearchParams({ 'track-ids': String(id), 'with-positions': 'false' });
          const singleResult = await libraryRequest('/tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: singleForm.toString(),
          });
          const singleRows = asArray(singleResult);
          recovered = singleRows?.find((row) => trackId(row) === String(id)) || null;
        } catch {
          // Keep the source ID even when a best-effort metadata retry fails.
        }
        hydrated.push(recovered || { id: String(id) });
      }
      post('scan-progress', { phase: 'metadata', message: `${label}: загружено ${hydrated.length} из ${ids.length}.` });
      if (offset + batchSize < ids.length) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return hydrated;
  }

  async function readFavorites(uid) {
    const result = await libraryRequest(`/users/${encodeURIComponent(uid)}/likes/tracks?if-modified-since-revision=0`);
    const library = result?.library || result;
    const refs = asArray(library);
    const revision = Number(library?.revision);
    if (!refs || library?.revision === null || library?.revision === undefined || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Не удалось подтвердить список лайков Яндекс Музыки.');
    }
    const ids = refs.map(trackId);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('В ответе лайков Яндекс Музыки есть пустые или повторные ID.');
    const rows = await hydrate(ids, 'Лайки');
    const tracks = rows.map((row, index) => normalizeLibraryTrack(row, index));
    if (tracks.length !== refs.length) throw new Error('Карточки лайков Яндекс Музыки неполны.');
    const metadataIncompleteCount = tracks.filter((track) => !track.metadataComplete).length;
    return { tracks, revision, count: refs.length, metadataIncompleteCount };
  }

  function albumRefId(value) {
    const album = value?.album || value;
    const id = album?.id ?? value?.albumId ?? value?.id;
    return id === null || id === undefined ? '' : String(id);
  }

  function normalizeAlbum(value) {
    const album = value?.album || value;
    const id = albumRefId(album);
    if (!id) return null;
    const artists = (Array.isArray(album?.artists) ? album.artists : [])
      .map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean);
    const title = String(album?.title || album?.name || '').trim();
    const count = Number(album?.trackCount ?? album?.track_count ?? 0);
    const cover = String(album?.coverUri || album?.cover?.uri || album?.cover?.url || '');
    return {
      providerId: id,
      title,
      artists,
      upc: '',
      trackCount: Number.isInteger(count) && count > 0 ? count : 0,
      releaseDate: String(album?.releaseDate || album?.year || ''),
      artworkUrl: cover ? (cover.startsWith('http') ? cover : `https://${cover.replace('%%', '400x400')}`) : '',
      metadataComplete: Boolean(title && artists.length),
    };
  }

  async function postAlbumIds(ids) {
    const result = await libraryRequest('/albums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ 'album-ids': ids.join(',') }).toString(),
    });
    const rows = Array.isArray(result) ? result : Array.isArray(result?.albums) ? result.albums : Array.isArray(result?.items) ? result.items : null;
    if (!rows) throw new Error('Неизвестный ответ Яндекс Музыки при чтении карточек альбомов.');
    return new Map(rows.map((row) => [albumRefId(row), row]).filter(([id]) => id));
  }

  async function hydrateAlbums(ids) {
    const hydrated = [];
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize);
      const byId = await postAlbumIds(batch);
      for (const id of batch) {
        let known = byId.get(id) || null;
        if (!known) {
          // Retry omitted cards one by one; keep the ID as an incomplete item if still missing.
          try { known = (await postAlbumIds([id])).get(id) || null; } catch { /* keep ID only */ }
        }
        hydrated.push(known ? normalizeAlbum(known) : normalizeAlbum({ id }));
      }
      post('scan-progress', { phase: 'albums', message: `Альбомы: загружено ${hydrated.length} из ${ids.length}.` });
      if (offset + batchSize < ids.length) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return hydrated;
  }

  async function readAlbumIds(uid) {
    const result = await libraryRequest(`/users/${encodeURIComponent(uid)}/likes/albums`);
    const refs = Array.isArray(result) ? result : Array.isArray(result?.albums) ? result.albums : Array.isArray(result?.items) ? result.items : null;
    if (!refs) throw new Error('Не удалось подтвердить список лайкнутых альбомов Яндекс Музыки.');
    const ids = refs.map(albumRefId);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('В лайкнутых альбомах Яндекс Музыки есть пустые или повторные ID.');
    return ids;
  }

  async function readAlbums(uid) {
    const ids = await readAlbumIds(uid);
    const items = await hydrateAlbums(ids);
    const metadataIncompleteCount = items.filter((item) => !item.metadataComplete).length;
    if (items.length !== ids.length) throw new Error('Карточки лайкнутых альбомов Яндекс Музыки неполны.');
    return {
      type: 'albums', name: 'Альбомы', count: ids.length, complete: true,
      metadataComplete: metadataIncompleteCount === 0, metadataIncompleteCount, items,
    };
  }

  function playlistListFrom(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.playlists)) return result.playlists;
    if (Array.isArray(result?.items)) return result.items;
    return null;
  }

  function playlistPager(detail, requestedPage, refs, title) {
    const pager = detail?.pager;
    if (!pager || typeof pager !== 'object' || Array.isArray(pager)) return null;
    const total = Number(pager.total);
    const page = Number(pager.page);
    const perPage = Number(pager.perPage ?? pager.per_page ?? pager.pageSize ?? pager.page_size);
    if (!Number.isInteger(total) || total < 0
      || !Number.isInteger(page) || page !== requestedPage
      || !Number.isInteger(perPage) || perPage < 0
      || (perPage > 0 && refs.length > perPage)) {
      throw new Error(`Некорректный счётчик страниц плейлиста «${title}».`);
    }
    return { total, page, perPage };
  }

  async function readPlaylist(uid, playlist) {
    const ownerId = String(playlist.uid ?? playlist.owner?.uid ?? uid);
    const kind = String(playlist.kind ?? playlist.id ?? '');
    if (!kind) throw new Error('В каталоге Яндекс Музыки есть playlist без kind.');
    const title = String(playlist.title || playlist.name || kind);
    const rawCatalogTotal = playlist.trackCount ?? playlist.track_count;
    const totalFromCatalog = rawCatalogTotal === undefined || rawCatalogTotal === null ? null : Number(rawCatalogTotal);
    const getPage = async (page) => {
      const params = new URLSearchParams({
        page: String(page), pageSize: String(playlistPageSize), trackPlayCounts: 'false', richTracks: 'true',
      });
      const result = await libraryRequest(`/users/${encodeURIComponent(ownerId)}/playlists/${encodeURIComponent(kind)}?${params}`);
      const detail = Array.isArray(result) ? result[0] : result?.playlist || result;
      const refs = asArray(detail);
      return { detail, refs };
    };
    const first = await getPage(1);
    const refs = first.refs;
    const detailTotal = first.detail?.trackCount ?? first.detail?.track_count;
    // Virtual collections can expose stale counts on both list and detail. The
    // page counter is the pagination contract; final hydrated rows verify it.
    const firstPager = playlistPager(first.detail, 1, refs || [], title);
    const total = firstPager?.total
      ?? (detailTotal === null || detailTotal === undefined ? totalFromCatalog : Number(detailTotal));
    const revisionValue = first.detail?.revision;
    const revision = revisionValue === null || revisionValue === undefined ? '' : String(revisionValue);
    const missingEvidence = [];
    if (!refs) missingEvidence.push('tracks');
    if (!Number.isInteger(total) || total < 0) missingEvidence.push('track-count');
    if (!revision) missingEvidence.push('revision');
    if (missingEvidence.length) {
      throw new Error(`Нет подтверждённого состава плейлиста «${title}» (не подтверждены поля: ${missingEvidence.join(', ')}).`);
    }
    const pages = [...refs];
    let pageInfo = firstPager;
    if (pages.length > total) throw new Error(`Ответ плейлиста «${title}» содержит больше треков, чем каталог.`);
    if (pages.length < total && !pageInfo) {
      throw new Error(`Плейлист «${title}» обрезан, а API не вернул данные пагинации.`);
    }
    if (pages.length < total) post('scan-progress', { phase: 'playlists', message: `Плейлист «${title}»: получено ${pages.length} из ${total} треков.` });
    let page = 1;
    while (pages.length < total) {
      if (!pageInfo || page >= maxPlaylistPages) throw new Error(`Не удалось дочитать все страницы плейлиста «${title}».`);
      page += 1;
      const next = await getPage(page);
      if (!next.refs || !next.refs.length) throw new Error(`Страница ${page} плейлиста «${title}» оказалась пустой до конца списка.`);
      const nextRevisionValue = next.detail?.revision;
      const nextRevision = nextRevisionValue === null || nextRevisionValue === undefined ? '' : String(nextRevisionValue);
      if (!nextRevision || nextRevision !== revision) {
        throw new Error(`Плейлист «${title}» изменился во время чтения (revision); повторите сбор.`);
      }
      pageInfo = playlistPager(next.detail, page, next.refs, title);
      if (pageInfo && pageInfo.total !== total) throw new Error(`Размер плейлиста «${title}» изменился во время чтения; повторите сбор.`);
      if (!pageInfo) throw new Error(`Яндекс Музыка потеряла счётчик страниц плейлиста «${title}».`);
      pages.push(...next.refs);
      if (pages.length > total) throw new Error(`Страницы плейлиста «${title}» содержат больше треков, чем заявлено.`);
      post('scan-progress', { phase: 'playlists', message: `Плейлист «${title}»: получено ${pages.length} из ${total} треков.` });
    }
    if (pageInfo && pageInfo.total !== total) throw new Error(`Полнота плейлиста «${title}» не сошлась с каталогом.`);
    let rows;
    if (pages.every((row) => (row?.track || row)?.title && (row?.track || row)?.artists)) rows = pages.map((row) => row?.track || row);
    else rows = await hydrate(pages.map(trackId), `Плейлист ${title}`);
    const tracks = rows.map((row, position) => normalizeLibraryTrack(row, position));
    if (tracks.length !== total) throw new Error(`Полнота плейлиста «${title}» не сошлась: ${tracks.length} из ${total}.`);
    return {
      id: `yandex:${ownerId}:${kind}`,
      title: String(playlist.title || playlist.name || first.detail.title || `Плейлист ${kind}`),
      trackCount: total,
      revision,
      complete: true,
      tracks,
      metadataIncompleteCount: tracks.filter((track) => !track.metadataComplete).length,
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
      artworkUrl: normalized.artworkUrl,
      releaseDate: normalized.releaseDate,
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

  async function searchAlbumTracks(albumName, artistName) {
    const album = String(albumName || '').trim().slice(0, 200);
    const artist = String(artistName || '').trim().slice(0, 200);
    if (!album || !artist) throw new Error('Для пакетного поиска Яндекс Музыки нужны альбом и артист.');
    const params = new URLSearchParams({ text: `${album} ${artist}`, page: '0', type: 'album' });
    const result = await request(`/search?${params.toString()}`);
    const albums = result?.albums?.results ?? result?.albums;
    if (!Array.isArray(albums)) throw new Error('Яндекс Музыка вернула неизвестную выдачу альбомов.');
    const candidates = new Map();
    for (const albumResult of albums.slice(0, 3)) {
      const albumId = String(albumResult?.id || '').trim();
      if (!albumId) continue;
      const albumDetail = await request(`/albums/${encodeURIComponent(albumId)}/with-tracks`);
      const detail = Array.isArray(albumDetail) ? albumDetail[0] : albumDetail?.album || albumDetail;
      const volumes = Array.isArray(detail?.volumes) ? detail.volumes : null;
      if (!volumes) throw new Error('Яндекс Музыка не вернула треклист найденного альбома.');
      for (const row of volumes.flat()) {
        const track = row?.track || row;
        const albumMetadata = Array.isArray(track?.albums) && track.albums.length
          ? track.albums
          : [{ id: albumId, title: detail?.title || albumResult?.title || album }];
        const candidate = normalizeCandidate({ ...track, albums: albumMetadata });
        if (candidate?.trackId) candidates.set(candidate.trackId, candidate);
      }
    }
    return [...candidates.values()];
  }

  async function searchAlbums(query, artistName) {
    const text = [query, artistName].map((part) => String(part || '').trim().slice(0, 200)).filter(Boolean).join(' ');
    if (!text) throw new Error('Для поиска альбома Яндекс Музыки нужен запрос.');
    const params = new URLSearchParams({ text, page: '0', type: 'album' });
    const result = await request(`/search?${params.toString()}`);
    const rows = result?.albums?.results ?? result?.albums;
    if (!Array.isArray(rows)) throw new Error('Яндекс Музыка вернула неизвестную выдачу альбомов.');
    return rows.map((row) => {
      const album = normalizeAlbum(row);
      if (!album || !album.title) return null;
      const year = Number(row?.year) || Number(String(album.releaseDate).slice(0, 4)) || 0;
      return {
        providerId: album.providerId, title: album.title, artists: album.artists, trackCount: album.trackCount,
        year, releaseDate: album.releaseDate, artworkUrl: album.artworkUrl, upc: '',
        albumViewUrl: `https://music.yandex.ru/album/${encodeURIComponent(album.providerId)}`,
      };
    }).filter(Boolean).slice(0, 20);
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
    const favoriteOperations = plan.operations.filter((operation) => operation.operation === 'add_to_favorites' || (plan.target.collectionType === 'favorites' && operation.operation !== 'add_album'));
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

  async function addAlbums(uid, plan, progress, onWriteStarted) {
    const albumOperations = plan.operations.filter((operation) => operation.operation === 'add_album');
    if (!albumOperations.length) return { added: 0, existing: 0, verified: 0 };
    const wanted = [...new Set(albumOperations.map((operation) => String(operation.target?.providerId || '')))];
    if (wanted.some((id) => !id)) throw new Error('В плане есть альбом без ID альбома назначения.');
    const existingIds = new Set(await readAlbumIds(uid));
    const missing = wanted.filter((id) => !existingIds.has(id));
    let added = 0;
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const batch = missing.slice(offset, offset + batchSize);
      onWriteStarted?.();
      await postForm(`/users/${encodeURIComponent(uid)}/likes/albums/add-multiple`, { 'album-ids': batch.join(',') });
      added += batch.length;
      progress?.({ phase: 'albums', completed: Math.min(offset + batch.length, missing.length), total: missing.length });
    }
    const afterIds = new Set(await readAlbumIds(uid));
    const verified = wanted.filter((id) => afterIds.has(id)).length;
    if (verified !== wanted.length) throw new Error(`Обратная сверка лайкнутых альбомов неполная: подтверждено ${verified} из ${wanted.length}.`);
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
    if (!['favorites', 'playlists', 'library', 'albums'].includes(plan.target.collectionType)) throw new Error('Неизвестный тип коллекции назначения.');
    if (!Array.isArray(plan.completeness?.source) || !plan.completeness.source.length || plan.completeness.source.some((status) => status?.confirmed !== true)) {
      throw new Error('Запись остановлена: полнота исходной библиотеки не подтверждена.');
    }
    if (plan.operations.some((operation) => !operation?.target?.providerId)) throw new Error('В плане есть совпадение без ID трека назначения.');
    const account = await request('/account/status');
    const uidValue = account?.account?.uid ?? account?.uid;
    if (uidValue === null || uidValue === undefined) throw new Error('Войдите в Яндекс Музыку в этой вкладке и повторите запись.');
    const uid = String(uidValue);
    const recovery = plan.recovery && typeof plan.recovery === 'object' ? plan.recovery : {};
    const recoveryProgress = recovery.progress && typeof recovery.progress === 'object' ? recovery.progress : {};
    const playlistTargets = recovery.playlistTargets && typeof recovery.playlistTargets === 'object' ? recovery.playlistTargets : {};
    const completedPlaylistCount = recoveryProgress.phase === 'playlists' ? Math.max(0, Number(recoveryProgress.completed) || 0) : 0;
    const report = { status: 'writing', targetProvider: 'yandex-music', startedAt: new Date().toISOString(), favorites: null, albums: null, playlists: [], failures: [] };
    let writesStarted = false;
    const update = (progress) => post('transfer-progress', {
      requestId,
      progress: {
        ...progress,
        message: progress.message || (progress.phase === 'favorites'
          ? `Добавляем лайки: ${progress.completed} из ${progress.total}`
          : progress.phase === 'albums'
            ? `Добавляем альбомы: ${progress.completed} из ${progress.total}`
            : `Добавляем треки в плейлист: ${progress.completed} из ${progress.total}`),
      },
    });
    try {
      report.favorites = await addFavorites(uid, plan, update, () => { writesStarted = true; });
      report.albums = await addAlbums(uid, plan, update, () => { writesStarted = true; });
      const playlistOperations = plan.operations.filter((operation) => operation.operation === 'add_to_playlist' || (plan.target.collectionType === 'playlists' && operation.operation !== 'add_album'));
      const mappings = ['favorites', 'albums'].includes(plan.target.collectionType) ? [] : (plan.collectionMappings || []);
      for (const [index, mapping] of mappings.entries()) {
        const key = String(mapping.sourceId || mapping.sourceName || '');
        const matching = playlistOperations.filter((operation) => sourcePlaylistKey(operation) === key)
          .sort((left, right) => Number(left.source.position || 0) - Number(right.source.position || 0));
        writesStarted = true;
        const expectedIds = matching.map((operation) => String(operation.target.providerId));
        let targetId = String(playlistTargets[key] || '');
        if (!targetId && recoveryProgress.sourceKey === key
          && ['playlist-creating', 'playlist-items'].includes(recoveryProgress.phase)) {
          throw new Error(`Нельзя безопасно продолжить «${mapping.sourceName}»: сервис мог создать плейлист, но его ID не сохранился. Сверьте цель вручную.`);
        }
        let playlist;
        let written = 0;
        if (targetId) {
          playlist = await readPlaylistDetail(uid, targetId);
          const currentIds = playlist.refs.map(trackId);
          const isPrefix = playlist.total === currentIds.length && currentIds.length <= expectedIds.length
            && currentIds.every((id, position) => id === expectedIds[position]);
          if (!isPrefix) throw new Error(`Содержимое «${mapping.targetName || mapping.sourceName}» не является префиксом плана. Остановил продолжение без записи.`);
          if (index < completedPlaylistCount && currentIds.length !== expectedIds.length) {
            throw new Error(`Плейлист «${mapping.targetName || mapping.sourceName}» отмечен завершённым, но read-back неполный.`);
          }
          const remainder = matching.slice(currentIds.length);
          const result = await appendPlaylistItems(uid, targetId, remainder, (value) => update({
            ...value, sourceKey: key, targetPlaylistId: targetId, playlistIndex: index,
          }));
          written = result.written;
          playlist = await readPlaylistDetail(uid, targetId);
        } else {
          if (index < completedPlaylistCount) throw new Error(`Не найден сохранённый ID завершённого плейлиста «${mapping.sourceName}».`);
          const createCheckpointSaved = await awaitCheckpoint(requestId, {
            phase: 'playlist-creating', completed: index, total: mappings.length, sourceKey: key, playlistIndex: index,
          });
          if (!createCheckpointSaved) throw new Error('Не удалось локально сохранить контрольную точку перед созданием плейлиста. Запись остановлена без изменения аккаунта.');
          playlist = await createPlaylist(uid, String(mapping.targetName || mapping.sourceName || 'Перенесённый плейлист').slice(0, 100));
          targetId = playlist.kind;
          const targetCheckpointSaved = await awaitCheckpoint(requestId, {
            phase: 'playlist-items', completed: 0, total: expectedIds.length, sourceKey: key, targetPlaylistId: targetId, playlistIndex: index,
          });
          if (!targetCheckpointSaved) throw new Error(`Плейлист «${playlist.title}» создан, но его ID не сохранён. Сверьте целевой аккаунт вручную; добавление треков остановлено.`);
          const result = await appendPlaylistItems(uid, targetId, matching, (value) => update({
            ...value, sourceKey: key, targetPlaylistId: targetId, playlistIndex: index,
          }));
          written = result.written;
          playlist = await readPlaylistDetail(uid, targetId);
        }
        const actualIds = playlist.refs.map(trackId);
        const exact = playlist.total === expectedIds.length && actualIds.length === expectedIds.length
          && actualIds.every((id, position) => id === expectedIds[position]);
        if (!exact) throw new Error(`Обратная сверка плейлиста «${mapping.targetName || mapping.sourceName}» обнаружила несовпадение треков или порядка.`);
        report.playlists.push({ title: mapping.targetName || mapping.sourceName, targetId, written, verified: actualIds.length });
        update({ phase: 'playlists', completed: index + 1, total: mappings.length, sourceKey: key, targetPlaylistId: targetId, playlistIndex: index, message: `Плейлисты: ${index + 1} из ${mappings.length}` });
      }
      report.status = 'complete';
      report.finishedAt = new Date().toISOString();
      return report;
    } catch (error) {
      report.status = writesStarted || report.favorites?.verified || report.albums?.verified || report.playlists.length ? 'partial_failure' : 'failed';
      report.error = error instanceof Error ? error.message : 'Яндекс Музыка не завершила перенос.';
      report.finishedAt = new Date().toISOString();
      throw Object.assign(new Error(report.error), { transferReport: report });
    }
  }

  async function scanLibrary() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      const accountResult = await libraryRequest('/account/status');
      const uidValue = accountResult?.account?.uid ?? accountResult?.uid;
      if (uidValue === null || uidValue === undefined) throw new Error('Яндекс Музыка не вернула UID текущего аккаунта. Войдите в сервис и повторите.');
      const uid = String(uidValue);
      post('scan-progress', { phase: 'favorites', message: 'Читаем лайки Яндекс Музыки…' });
      const favorites = await readFavorites(uid);
      post('favorites-snapshot', {
        payload: {
          schemaVersion: 1,
          service: 'yandex-music',
          collection: { type: 'library', name: 'Только лайки' },
          partialScope: 'favorites',
          completeness: {
            confirmed: false,
            favoritesConfirmed: true,
            favoritesCount: favorites.count,
            favoritesRevision: favorites.revision,
            metadataComplete: favorites.metadataIncompleteCount === 0,
            metadataIncompleteCount: favorites.metadataIncompleteCount,
            catalogConfirmed: false,
            playlistCatalogKindsConfirmed: false,
            playlistItemsConfirmed: false,
            playlistItemsTotal: null,
            albumsConfirmed: false,
            albumsCount: null,
          },
          tracks: favorites.tracks.map((track) => ({ ...track, collectionType: 'favorites' })),
          playlists: [],
        },
      });
      post('scan-progress', { phase: 'playlists', message: 'Читаем каталог плейлистов Яндекс Музыки…' });
      const playlistResult = await libraryRequest(`/users/${encodeURIComponent(uid)}/playlists/list`);
      const playlistRows = playlistListFrom(playlistResult);
      if (!playlistRows) throw new Error('Яндекс Музыка вернула неизвестный формат списка плейлистов.');
      const kindsResult = await libraryRequest(`/users/${encodeURIComponent(uid)}/playlists/list/kinds`);
      if (!Array.isArray(kindsResult)) throw new Error('Яндекс Музыка не вернула независимый список playlist kinds.');
      const expectedKinds = kindsResult.map((kind) => String(kind));
      const listedKinds = playlistRows.map((playlist) => String(playlist.kind ?? playlist.id ?? ''));
      const expectedSorted = expectedKinds.slice().sort();
      const listedSorted = listedKinds.slice().sort();
      if (expectedKinds.some((kind) => !kind) || listedKinds.some((kind) => !kind)
        || new Set(expectedKinds).size !== expectedKinds.length
        || new Set(listedKinds).size !== listedKinds.length) {
        throw new Error('Список плейлистов Яндекс Музыки и независимый список kinds содержат пустые или повторные значения.');
      }
      if (expectedKinds.length !== listedKinds.length) {
        throw new Error('Список плейлистов Яндекс Музыки и независимый список kinds не совпали: количество записей различается.');
      }
      if (expectedSorted.some((kind, index) => kind !== listedSorted[index])) {
        throw new Error('Список плейлистов Яндекс Музыки и независимый список kinds не совпали: состав значений различается.');
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
      post('scan-progress', { phase: 'albums', message: 'Читаем лайкнутые альбомы Яндекс Музыки…' });
      let albums;
      try {
        albums = await readAlbums(uid);
      } catch (error) {
        // Never drop albums silently: surface an unconfirmed collection instead of failing the whole scan.
        albums = {
          type: 'albums', name: 'Альбомы', count: 0, complete: false, metadataComplete: false, metadataIncompleteCount: 0,
          items: [], error: error instanceof Error ? error.message.slice(0, 300) : 'Лайкнутые альбомы не прочитаны.',
        };
      }
      const metadataIncompleteCount = favorites.metadataIncompleteCount
        + playlists.reduce((total, playlist) => total + playlist.metadataIncompleteCount, 0);
      return {
        schemaVersion: 1,
        service: 'yandex-music',
        collection: { type: 'library', name: 'Вся библиотека' },
        completeness: {
          confirmed: true,
          favoritesConfirmed: true,
          favoritesCount: favorites.count,
          favoritesRevision: favorites.revision,
          metadataComplete: metadataIncompleteCount === 0,
          metadataIncompleteCount,
          catalogConfirmed: true,
          playlistCatalogKindsConfirmed: true,
          playlistItemsConfirmed: playlists.every((playlist) => playlist.complete),
          playlistItemsTotal: playlists.length,
          albumsConfirmed: albums.complete,
          albumsCount: albums.count,
          albumsMetadataComplete: albums.metadataComplete,
          albumsMetadataIncompleteCount: albums.metadataIncompleteCount,
        },
        collections: [albums],
        tracks: favorites.tracks.map((track) => ({ ...track, collectionType: 'favorites' })),
        playlists,
      };
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    if (event.data.type === 'search-album-tracks') {
      const requestId = String(event.data.requestId || '');
      try {
        const results = await searchAlbumTracks(event.data.album, event.data.artist);
        post('command-response', { requestId, ok: true, results });
      } catch (error) {
        post('command-response', {
          requestId, ok: false,
          error: error instanceof Error ? error.message : 'Поиск альбома Яндекс Музыки не выполнен.',
          status: Number(error?.status) || null,
          retryAfter: error?.retryAfter || null,
        });
      }
      return;
    }
    if (event.data.type === 'search-albums' || event.data.type === 'read-albums') {
      const requestId = String(event.data.requestId || '');
      try {
        if (event.data.type === 'search-albums') {
          const results = await searchAlbums(event.data.query || event.data.album, event.data.artist);
          post('command-response', { requestId, ok: true, results });
        } else {
          const account = await libraryRequest('/account/status');
          const uidValue = account?.account?.uid ?? account?.uid;
          if (uidValue === null || uidValue === undefined) throw new Error('Войдите в Яндекс Музыку в этой вкладке и повторите.');
          const collection = await readAlbums(String(uidValue));
          post('command-response', { requestId, ok: true, collection, items: collection.items });
        }
      } catch (error) {
        post('command-response', {
          requestId, ok: false,
          error: error instanceof Error ? error.message : 'Операция с альбомами Яндекс Музыки не выполнена.',
          status: Number(error?.status) || null,
          retryAfter: error?.retryAfter || null,
        });
      }
      return;
    }
    if (event.data.type === 'search-tracks') {
      const requestId = String(event.data.requestId || '');
      try {
        const results = await searchTracks(event.data.query);
        post('command-response', { requestId, ok: true, results });
      } catch (error) {
        post('command-response', {
          requestId, ok: false,
          error: error instanceof Error ? error.message : 'Поиск Яндекс Музыки не выполнен.',
          status: Number(error?.status) || null,
          retryAfter: error?.retryAfter || null,
        });
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
      post('scan-error', {
        error: typeof error?.message === 'string' && error.message
          ? error.message.slice(0, 500)
          : 'Не удалось прочитать библиотеку Яндекс Музыки.',
      });
    }
  });
})();
