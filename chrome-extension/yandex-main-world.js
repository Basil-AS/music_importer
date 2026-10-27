(() => {
  const marker = 'music-importer-yandex';
  const api = 'https://api.music.yandex.ru';
  const batchSize = 100;
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
      complete: true,
      tracks,
    };
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
