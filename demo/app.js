(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const demoTracks = [
    { title: 'СОЛНЦЕ МОНАКО', artist: 'Люся Чеботина', album: '' },
    { title: 'Мокрые кроссы', artist: 'Тима Белорусских', album: '' },
    { title: 'Моя игра', artist: 'Баста', album: '' },
    { title: 'One More Time', artist: 'Daft Punk', album: 'Discovery' },
    { title: 'Blinding Lights', artist: 'The Weeknd', album: '' },
    { title: 'Плакала', artist: 'KAZKA', album: '' },
  ];
  const trackPageSize = 50;
  const state = { source: 'Звук', sourceProvider: 'zvuk', targetProvider: 'apple-music', sourceSnapshot: null, librarySnapshots: {}, collectionType: 'library', tracks: [], loaded: false, report: null, searching: false, extensionAvailable: false };
  let trackPage = 0;
  let extensionCheckInProgress = false;
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 3000);
  }

  function checkLocalExtension() {
    const button = $('#extensionImportBtn');
    const status = $('#extensionStatus');
    if (extensionCheckInProgress) return;
    if (!window.crypto?.randomUUID) {
      status.textContent = 'Этот браузер не поддерживает проверку локального расширения. Используйте Chrome.';
      button.textContent = 'Откройте в Chrome';
      button.disabled = true;
      return;
    }
    extensionCheckInProgress = true;
    button.disabled = true;
    button.textContent = 'Проверяем расширение…';
    status.textContent = 'Проверяем связь с Music Importer в Chrome…';
    const requestId = window.crypto.randomUUID();
    let answered = false;
    const timeout = setTimeout(() => {
      if (answered) return;
      window.removeEventListener('message', onMessage);
      extensionCheckInProgress = false;
      status.textContent = 'Chrome открыт, но Music Importer не ответил. Включите или обновите расширение, проверьте доступ к этому локальному адресу и нажмите «Повторить проверку».';
      button.textContent = 'Повторить проверку';
      button.disabled = false;
    }, 1200);
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== location.origin
        || event.data?.source !== 'music-importer-local-app'
        || event.data?.type !== 'extension-ready' || event.data?.requestId !== requestId) return;
      answered = true;
      extensionCheckInProgress = false;
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      state.extensionAvailable = true;
      status.textContent = `Локальное расширение Chrome подключено · версия ${String(event.data.version || 'неизвестна')}.`;
      button.textContent = 'Сканировать открытые аккаунты';
      button.disabled = false;
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'music-importer-local-app', type: 'extension-ping', requestId }, location.origin);
  }

  function setStep(step) {
    $$('.step').forEach((element, index) => {
      element.classList.toggle('active', index + 1 === step);
      element.classList.toggle('done', index + 1 < step);
      element.querySelector('.step-num').textContent = index + 1 < step ? '✓' : String(index + 1);
    });
  }

  function updateCounts() {
    const selected = state.tracks.filter((track) => track.selected && track.match).length;
    const reviewed = state.tracks.filter((track) => track.searched && track.matches.length && !track.match).length;
    const missing = state.tracks.filter((track) => track.searched && !track.matches.length).length;
    $('#readyStat').textContent = state.loaded ? selected : '—';
    $('#reviewStat').textContent = state.loaded ? reviewed : '—';
    $('#missingStat').textContent = state.loaded ? missing : '—';
    $('#matchCount').textContent = state.loaded ? `${state.tracks.length} треков` : 'ожидает список';
    $('#selectedCount').textContent = `${selected} выбрано`;
    const hasPlaylistMappings = ['playlists', 'library'].includes(state.collectionType) && state.sourceSnapshot?.collections?.some((collection) => collection.type === 'playlists');
    $('#importBtn').disabled = (selected === 0 && !hasPlaylistMappings) || state.searching;
    $('#searchBtn').disabled = !state.loaded || state.searching;
    $('#toggleAll').textContent = selected ? 'Снять выбор со всех' : 'Выбрать совпадения';
  }

  function renderTracks() {
    const needsReviewOnly = $('#needsReviewOnly').checked;
    const reviewable = state.tracks.some((track) => track.searched || track.searchError);
    const needsReview = (track) => track.searchError || (track.searched && !track.match);
    const indexedTracks = state.tracks.map((track, index) => ({ track, index }));
    const displayedTracks = needsReviewOnly ? indexedTracks.filter(({ track }) => needsReview(track)) : indexedTracks;
    const pageCount = Math.max(1, Math.ceil(displayedTracks.length / trackPageSize));
    trackPage = Math.min(trackPage, pageCount - 1);
    const first = trackPage * trackPageSize;
    const visibleTracks = displayedTracks.slice(first, first + trackPageSize);
    const tools = $('#trackTools');
    const reviewFilter = $('#needsReviewOnly');
    tools.hidden = state.tracks.length <= trackPageSize && !needsReviewOnly;
    reviewFilter.disabled = !reviewable || state.searching;
    $('#trackPageStatus').textContent = displayedTracks.length
      ? `Показаны ${first + 1}–${Math.min(first + trackPageSize, displayedTracks.length)} из ${displayedTracks.length}${needsReviewOnly ? ' · требуют внимания' : ''}`
      : needsReviewOnly ? 'Все записи имеют совпадения' : '0 записей';
    $('#previousTrackPage').disabled = trackPage === 0;
    $('#nextTrackPage').disabled = trackPage >= pageCount - 1;

    if (!state.tracks.length || !visibleTracks.length) {
      const playlistCount = state.sourceSnapshot?.collections?.filter((collection) => collection.type === 'playlists').length || 0;
      $('#trackList').innerHTML = needsReviewOnly && state.tracks.length
        ? '<div class="empty">Все записи имеют совпадения; проверка не требуется.</div>'
        : playlistCount && !state.tracks.length ? `<div class="empty">Загружено плейлистов: ${playlistCount}. Треки для сопоставления не найдены.</div>`
          : '<div class="empty">Загрузите пример или свой список треков</div>';
      updateCounts();
      return;
    }

    $('#trackList').innerHTML = visibleTracks.map(({ track, index }) => {
      const title = escapeHTML(track.title);
      const artist = escapeHTML(track.artist);
      const status = track.searching ? 'Ищем…' : track.searchError ? 'Ошибка поиска' : track.searched && !track.matches.length ? 'Не найдено' : track.match ? (track.autoMatched ? `Автоматически · ${Math.round(track.matchConfidence * 100)}%` : 'Выбрано вручную') : track.searched ? 'Проверьте' : 'Не искали';
      const badgeClass = track.searchError ? 'error' : track.match ? '' : track.searched && track.matches.length ? 'review' : 'pending';
      const targetName = ({ 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс Музыка', spotify: 'Spotify', zvuk: 'Звук' })[state.targetProvider] || state.targetProvider;
      const options = track.matches.map((match) => `<option value="${escapeHTML(match.trackId)}" ${String(track.match?.trackId || '') === String(match.trackId) ? 'selected' : ''}>${escapeHTML(match.artistName)} — ${escapeHTML(match.trackName)}${match.collectionName ? ` · ${escapeHTML(match.collectionName)}` : ''}</option>`).join('');
      const matchControl = `<input class="track-query" data-index="${index}" aria-label="Поисковый запрос для ${title}" value="${escapeHTML(track.query || `${track.title} ${track.artist}`)}" ${state.searching ? 'disabled' : ''}><button class="track-search" type="button" data-index="${index}" ${state.searching ? 'disabled' : ''}>Искать</button>${track.matches.length ? `<select class="track-match" data-index="${index}" aria-label="Совпадение ${targetName} для ${title}"><option value="">${track.match && track.autoMatched ? 'Автоматическое совпадение · изменить' : 'Выберите версию…'}</option>${options}</select>${track.match ? `<a href="${escapeHTML(track.match.trackViewUrl)}" target="_blank" rel="noopener noreferrer">Открыть в ${targetName} ↗</a><div class="confidence ${track.autoMatched ? '' : 'review'}">${track.autoMatched ? `Автосопоставление · ${Math.round(track.matchConfidence * 100)}%` : 'Выбрано вручную'}</div>` : '<div class="confidence review">Нужно проверить: неоднозначное совпадение</div>'}` : `<div class="quiet ${track.searchError ? 'search-error' : ''}">${track.searchError ? (track.errorMessage || 'Повторите поиск') : track.searched ? 'В каталоге ничего не найдено' : 'Результаты появятся здесь'}</div>`}`;
      const collection = state.collectionType === 'library' ? `<div class="track-artist">${track.sourceCollectionType === 'favorites' ? 'Любимое' : escapeHTML(track.sourceCollectionName || 'Плейлист')}</div>` : '';
      return `<div class="track" data-index="${index}"><div class="cover" aria-hidden="true">♫</div><div><div class="track-name">${title}</div><div class="track-artist">${artist}</div>${collection}${track.album ? `<div class="track-artist">${escapeHTML(track.album)}</div>` : ''}</div><div class="match">${matchControl}</div><span class="badge ${badgeClass}">${status}</span><input class="include" type="checkbox" aria-label="Включить ${title}" data-index="${index}" ${track.selected && track.match ? 'checked' : ''} ${track.match ? '' : 'disabled'}></div>`;
    }).join('');

    $$('.track-match').forEach((select) => select.addEventListener('change', () => {
      const track = state.tracks[Number(select.dataset.index)];
      track.match = track.matches.find((match) => String(match.trackId) === select.value) || null;
      track.selected = Boolean(track.match);
      track.autoMatched = false;
      track.matchReason = track.match ? 'manual_review' : null;
      track.matchConfidence = track.match ? window.MusicMatcher.scoreCandidate(track, track.match).score : 0;
      state.report = null;
      $('#report').classList.remove('show');
      renderTracks();
    }));
    $$('.track-query').forEach((input) => input.addEventListener('input', () => {
      const track = state.tracks[Number(input.dataset.index)];
      track.query = input.value;
      track.manualQuery = true;
    }));
    $$('.track-search').forEach((button) => button.addEventListener('click', () => {
      searchOne(state.tracks[Number(button.dataset.index)]);
    }));
    $$('.include').forEach((checkbox) => checkbox.addEventListener('change', () => {
      state.tracks[Number(checkbox.dataset.index)].selected = checkbox.checked;
      state.report = null;
      $('#report').classList.remove('show');
      updateCounts();
    }));
    updateCounts();
  }

  function loadTracks(list, label, metadata = {}) {
    trackPage = 0;
    state.tracks = list.map((track) => ({
      ...track,
      query: `${track.title} ${track.artist}`.trim(),
      manualQuery: false,
      matches: [],
      match: null,
      selected: false,
      searched: false,
      searching: false,
      searchError: false,
    }));
    state.source = label;
    state.sourceProvider = metadata.provider || state.sourceProvider || 'file';
    state.collectionType = metadata.collectionType || (list.some((track) => track.sourceCollectionId) ? 'playlists' : 'favorites');
    state.sourceSnapshot = window.MusicTransferCore.createImportedSnapshot({
      provider: state.sourceProvider,
      collectionType: state.collectionType,
      collectionName: metadata.collectionName,
      tracks: list,
      playlists: metadata.playlists || [],
      completeness: metadata.completeness || { confirmed: false, reason: 'file_import' },
    });
    state.loaded = true;
    state.report = null;
    $('#report').classList.remove('show');
    const playlistCount = state.sourceSnapshot.collections.filter((collection) => collection.type === 'playlists').length;
    $('#reviewSub').textContent = `${label} · ${list.length} треков${playlistCount ? ` · ${playlistCount} плейлистов` : ''} готовы к поиску`;
    updateTargetLabel();
    $('#searchStatus').textContent = 'Поиск не запускался';
    $('#searchStatus').classList.remove('search-error');
    renderTracks();
    setStep(2);
    $('#reviewCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(`Загружено треков: ${list.length}`);
  }

  const sourceLabels = { zvuk: 'Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс Музыка', 'apple-music': 'Apple Music' };

  function renderSourceAvailability(statuses = {}) {
    $$('.source').forEach((card) => {
      const provider = card.dataset.provider;
      const snapshot = state.librarySnapshots[provider];
      const status = statuses[provider];
      const label = card.querySelector('.source-status');
      const button = card.querySelector('.connect');
      if (snapshot) {
        const playlistCount = snapshot.playlists.length;
        const count = `${snapshot.tracks.length} лайков · ${playlistCount} плейлистов`;
        label.textContent = card.classList.contains('selected') ? `Выбран · ${count}` : `Подключено · ${count}`;
        label.classList.add('connected');
        button.disabled = false;
        button.textContent = card.classList.contains('selected') ? '✓ Источник' : 'Выбрать источник';
      } else if (status?.status === 'scanning') {
        label.textContent = status.message || 'Сканируем открытую сессию…';
        label.classList.remove('connected');
        button.disabled = true;
        button.textContent = 'Сканируем…';
      } else if (status?.status === 'unavailable') {
        label.textContent = 'Войдите и откройте сервис в Chrome';
        label.classList.remove('connected');
        button.disabled = true;
        button.textContent = 'Нет подключения';
        button.title = status.message || '';
      }
    });
  }

  function selectProviderSnapshot(provider) {
    const payload = state.librarySnapshots[provider];
    if (!payload) {
      toast(`Сначала откройте ${sourceLabels[provider] || provider} в Chrome и нажмите «Сканировать открытые аккаунты»`);
      return;
    }
    state.sourceProvider = provider;
    state.source = sourceLabels[provider] || provider;
    $$('.source').forEach((card) => {
      const active = card.dataset.provider === provider;
      card.classList.toggle('selected', active);
      const button = card.querySelector('.connect');
      button.disabled = false;
      button.textContent = active ? '✓ Источник' : 'Выбрать источник';
    });
    const tracks = normalizeJSON(payload);
    loadTracks(tracks, `${state.source} · библиотека из расширения`, {
      provider,
      collectionName: payload.collection?.name,
      collectionType: payload.collection?.type,
      completeness: payload.completeness,
      playlists: payload.playlists,
    });
    renderSourceAvailability();
  }

  function parseCSV(text) {
    const header = text.split(/\r?\n/, 1)[0] || '';
    const delimiters = [',', ';', '\t'];
    const counts = Object.fromEntries(delimiters.map((delimiter) => [delimiter, 0]));
    let quoted = false;
    for (let index = 0; index < header.length; index += 1) {
      if (header[index] === '"' && quoted && header[index + 1] === '"') index += 1;
      else if (header[index] === '"') quoted = !quoted;
      else if (!quoted && delimiters.includes(header[index])) counts[header[index]] += 1;
    }
    const delimiter = delimiters.sort((left, right) => counts[right] - counts[left])[0];
    return mapCSVRows(parseDelimitedCSV(text, delimiter));
  }

  function parseDelimitedCSV(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = !quoted;
      else if (character === delimiter && !quoted) { row.push(cell); cell = ''; }
      else if ((character === '\n' || character === '\r') && !quoted) {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        row.push(cell);
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        cell = '';
      } else cell += character;
    }
    if (quoted) throw new Error('В CSV не закрыта кавычка');
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
    return rows;
  }

  function mapCSVRows(rows) {
    if (rows.length < 2) throw new Error('В CSV нет строк с треками');
    const headers = rows.shift().map((value) => value.trim().toLowerCase());
    const column = (...names) => headers.findIndex((header) => names.includes(header));
    const titleIndex = column('title', 'track', 'track name', 'name', 'название', 'трек');
    const artistIndex = column('artist', 'artists', 'artist name', 'artist name(s)', 'artist_names', 'исполнитель', 'артист');
    const albumIndex = column('album', 'album name', 'альбом');
    const isrcIndex = column('isrc', 'recording code');
    const durationIndex = column('durationms', 'duration_ms', 'duration ms', 'duration');
    const idIndex = column('id', 'track id', 'track_id', 'uri', 'spotify uri', 'provider id');
    if (titleIndex < 0 || artistIndex < 0) throw new Error('Нужны столбцы title и artist (или название и исполнитель)');
    return rows.map((values) => ({ title: values[titleIndex]?.trim(), artist: values[artistIndex]?.trim(), album: albumIndex < 0 ? '' : values[albumIndex]?.trim(), isrc: isrcIndex < 0 ? '' : values[isrcIndex]?.trim(), durationMs: normalizeDuration(values[durationIndex]), sourceId: idIndex < 0 ? '' : values[idIndex]?.trim() })).filter((track) => track.title && track.artist);
  }

  function normalizeDuration(value) {
    const duration = Number(value) || 0;
    return duration > 0 && duration < 10000 ? duration * 1000 : duration;
  }

  function normalizeJSON(value) {
    const isLibrary = value?.collection?.type === 'library';
    const playlistRows = Array.isArray(value?.playlists) ? value.playlists.flatMap((playlist) => {
      const playlistTracks = playlist.tracks || playlist.items || [];
      if (!Array.isArray(playlistTracks)) return [];
      return playlistTracks.map((row, index) => ({
        ...row,
        __sourceCollectionId: playlist.id || '',
        __sourceCollectionName: playlist.title || playlist.name || '',
        __sourceCollectionType: 'playlists',
        __sourceCollectionItemCount: Number.isInteger(playlist.trackCount) ? playlist.trackCount : playlistTracks.length,
        __sourceCollectionComplete: playlist.complete === true,
        __sourcePosition: Number.isInteger(row.position) ? row.position : index,
      }));
    }) : null;
    const favoriteRows = isLibrary && Array.isArray(value.tracks) ? value.tracks.map((row) => ({ ...row, __sourceCollectionType: 'favorites' })) : null;
    const root = Array.isArray(value)
      ? value
      : isLibrary
        ? [...(favoriteRows || []), ...(playlistRows || [])]
        : playlistRows || value?.tracks || value?.items || value?.data;
    if (!Array.isArray(root)) throw new Error('Ожидается массив треков или поле tracks/items/data');
    return root.map((row) => {
      const track = row?.track || row;
      const artist = track?.artist || track?.artists || track?.performer || track?.artistName || track?.artist_name || track?.artist_names;
      return {
        title: String(track?.title || track?.name || track?.trackName || track?.track_name || ''),
        artist: Array.isArray(artist) ? artist.map((item) => typeof item === 'string' ? item : item?.name || item?.title).filter(Boolean).join(', ') : String(artist || ''),
        album: String((typeof track?.album === 'object' ? track.album?.name || track.album?.title : track?.album) || track?.albumName || track?.album_name || track?.release?.title || ''),
        isrc: String(track?.isrc || track?.ISRC || track?.externalIds?.isrc || track?.external_ids?.isrc || ''),
        durationMs: normalizeDuration(track?.durationMs || track?.duration_ms || track?.duration),
        sourceId: String(track?.id || track?.trackId || track?.track_id || track?.uri || ''),
        sourceCollectionType: String(row?.__sourceCollectionType || track?.collectionType || (row?.__sourceCollectionId ? 'playlists' : 'favorites')),
        sourceCollectionId: String(row?.__sourceCollectionId || track?.playlistId || ''),
        sourceCollectionName: String(row?.__sourceCollectionName || track?.playlistName || ''),
        sourceCollectionItemCount: Number.isInteger(row?.__sourceCollectionItemCount) ? row.__sourceCollectionItemCount : null,
        sourceCollectionComplete: row?.__sourceCollectionComplete === true,
        sourcePosition: Number.isInteger(row?.__sourcePosition) ? row.__sourcePosition : Number(track?.position || 0),
      };
    }).filter((track) => track.title && track.artist);
  }

  function exactIsrcQuery(track, provider) {
    if (track.manualQuery || !['apple-music', 'spotify'].includes(provider)) return '';
    const isrc = window.MusicMatcher.normalizeISRC(track.isrc || '');
    return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc) ? `isrc:${isrc}` : '';
  }

  function candidateHasIsrc(candidate, isrc) {
    return window.MusicMatcher.normalizeISRC(candidate?.isrc || candidate?.ISRC || candidate?.externalIds?.isrc || '') === isrc;
  }

  async function searchWithExactIsrc(track, provider, search) {
    const isrcQuery = exactIsrcQuery(track, provider);
    const metadataQuery = (track.query || `${track.title} ${track.artist}`).trim();
    if (!isrcQuery) return search(metadataQuery);
    const isrc = isrcQuery.slice('isrc:'.length);
    const exactCandidates = await search(isrcQuery);
    if (exactCandidates.some((candidate) => candidateHasIsrc(candidate, isrc))) return exactCandidates;
    return search(metadataQuery);
  }

  const appleCatalogAdapter = {
    id: 'apple-music',
    maxConcurrentSearches: 2,
    async searchTracks(track, context = {}) {
      if (context.accountWrite !== true) {
        const params = new URLSearchParams({
          term: (track.query || `${track.title} ${track.artist}`).trim(),
          entity: 'song', limit: '15', country: context.storefront || $('#storefront').value,
        });
        const response = await fetch(`https://itunes.apple.com/search?${params}`);
        if (!response.ok) throw new Error(`Каталог Apple ответил ${response.status}`);
        const payload = await response.json();
        return (payload.results || []).filter((item) => item.trackId && item.trackViewUrl).slice(0, 15);
      }
      return searchWithExactIsrc(track, 'apple-music', async (query) => {
        const response = await requestExtensionCommand('search-tracks', {
          query,
          storefront: context.storefront || $('#storefront').value,
        }, 'apple');
        if (!response?.ok || !Array.isArray(response.results)) throw new Error(response?.error || 'Не удалось получить каталог Apple Music.');
        return response.results.filter((item) => item.trackId && item.trackViewUrl).slice(0, 25);
      });
    },
  };

  const yandexCatalogAdapter = {
    id: 'yandex-music',
    maxConcurrentSearches: 2,
    async searchTracks(track) {
      const response = await requestExtensionCommand('search-tracks', { query: (track.query || `${track.title} ${track.artist}`).trim() });
      if (!response?.ok || !Array.isArray(response.results)) throw new Error(response?.error || 'Не удалось получить каталог Яндекс Музыки.');
      return response.results;
    },
  };

  const zvukCatalogAdapter = {
    id: 'zvuk',
    maxConcurrentSearches: 2,
    async searchTracks(track) {
      const response = await requestExtensionCommand('search-tracks', { query: (track.query || `${track.title} ${track.artist}`).trim() }, 'zvuk');
      if (!response?.ok || !Array.isArray(response.results)) throw new Error(response?.error || 'Не удалось получить каталог Звука.');
      return response.results;
    },
  };

  const spotifyCatalogAdapter = {
    id: 'spotify',
    maxConcurrentSearches: 2,
    async searchTracks(track) {
      return searchWithExactIsrc(track, 'spotify', async (query) => {
        const response = await requestExtensionCommand('search-tracks', { query }, 'spotify');
        if (!response?.ok || !Array.isArray(response.results)) throw new Error(response?.error || 'Не удалось получить каталог Spotify.');
        return response.results;
      });
    },
  };

  function targetAdapter() {
    if (state.targetProvider === 'apple-music') return appleCatalogAdapter;
    if (state.targetProvider === 'yandex-music') return yandexCatalogAdapter;
    if (state.targetProvider === 'zvuk') return zvukCatalogAdapter;
    if (state.targetProvider === 'spotify') return spotifyCatalogAdapter;
    throw new Error('Для выбранного сервиса назначения адаптер ещё не подключён.');
  }

  function requestExtensionCommand(action, details = {}, provider = 'yandex') {
    if (!window.crypto?.randomUUID) return Promise.reject(new Error('Этот браузер не поддерживает защищённый запрос к расширению.'));
    const requestId = window.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Расширение не ответило. Перезагрузите вкладки и повторите.'));
      }, action === 'execute-transfer' ? 30 * 60 * 1000 : 45000);
      const onMessage = (messageEvent) => {
        if (messageEvent.source !== window || messageEvent.origin !== location.origin
          || messageEvent.data?.source !== 'music-importer-local-app'
          || messageEvent.data?.requestId !== requestId) return;
        if (messageEvent.data?.type === `${provider}-progress`) {
          const progress = messageEvent.data.progress;
          if (progress?.message) {
            $('#importBtn').textContent = progress.message;
            $('#searchStatus').textContent = progress.message;
          }
          return;
        }
        if (messageEvent.data?.type !== `${provider}-command-response`) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(messageEvent.data);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'music-importer-local-app', type: `${provider}-command`, action, requestId, ...details }, location.origin);
    });
  }

  function updateTargetLabel() {
    const labels = { 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс Музыка', spotify: 'Spotify', zvuk: 'Звук' };
    const label = labels[state.targetProvider] || state.targetProvider;
    $('#targetProviderName').textContent = label;
    $('#review-heading').textContent = `Сверка с каталогом ${label}`;
    $('#searchBtn').textContent = `Найти в ${label}`;
    $('#storefront').hidden = state.targetProvider !== 'apple-music';
    $('#storefront').previousElementSibling.hidden = state.targetProvider !== 'apple-music';
    $('#importBtn').innerHTML = ({
      'yandex-music': 'Перенести в Яндекс Музыку <span aria-hidden="true">→</span>',
      'apple-music': 'Перенести в Apple Music <span aria-hidden="true">→</span>',
      zvuk: 'Перенести в Звук <span aria-hidden="true">→</span>',
      spotify: 'Перенести в Spotify <span aria-hidden="true">→</span>',
    })[state.targetProvider] || 'Сформировать план <span aria-hidden="true">→</span>';
    $('#targetCollection').textContent = state.collectionType === 'library'
      ? 'Лайки и плейлисты'
      : state.collectionType === 'playlists' ? 'Плейлисты' : 'Избранные песни';
  }

  function applySuggestion(track) {
    const suggestion = window.MusicMatcher.suggestBestMatch(track, track.matches);
    track.match = suggestion.automatic ? suggestion.best : null;
    track.matchConfidence = suggestion.confidence;
    track.matchReason = suggestion.reason;
    track.autoMatched = suggestion.automatic;
    track.selected = suggestion.automatic;
  }

  async function searchOne(track) {
    if (state.searching || !track) return;
    state.searching = true;
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchStatus').classList.remove('search-error');
    $('#searchStatus').textContent = `Ищем: ${track.title}`;
    setStep(3);
    updateCounts();
    await requestTrackMatches(track);
    state.searching = false;
    $('#searchStatus').textContent = track.searchError ? 'Поиск не удался — измените запрос или повторите' : track.matches.length ? `Результатов: ${track.matches.length}` : 'В каталоге ничего не найдено';
    $('#searchStatus').classList.toggle('search-error', track.searchError);
    setStep(4);
    renderTracks();
  }

  async function requestTrackMatches(track) {
    track.searching = true;
    track.searchError = false;
    track.matches = [];
    track.match = null;
    track.selected = false;
    renderTracks();
    try {
      const [result] = await window.MusicTransferEngine.searchMany(targetAdapter(), [track], {
        context: { storefront: $('#storefront').value },
      });
      if (result?.error) throw result.error;
      track.matches = result?.candidates || [];
      track.searched = true;
      track.searchError = false;
      applySuggestion(track);
    } catch (error) {
      track.searched = false;
      track.searchError = true;
      track.matches = [];
      track.match = null;
      track.selected = false;
      track.errorMessage = error instanceof TypeError ? 'Каталог недоступен. Проверьте соединение и повторите поиск.' : error.message;
    } finally {
      track.searching = false;
    }
  }

  async function searchCatalog() {
    if (!state.loaded || state.searching) return;
    state.searching = true;
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchBtn').textContent = 'Идёт поиск…';
    $('#searchStatus').classList.remove('search-error');
    setStep(3);
    const pending = state.tracks.filter((track) => !track.searched || track.searchError);
    let completed = state.tracks.length - pending.length;
    $('#searchStatus').textContent = `${completed} из ${state.tracks.length}`;
    updateCounts();

    try {
      pending.forEach((track) => {
        track.searching = true;
        track.searchError = false;
        track.matches = [];
        track.match = null;
        track.selected = false;
      });
      renderTracks();
      await window.MusicTransferEngine.searchMany(targetAdapter(), pending, {
        context: {
          storefront: $('#storefront').value,
          accountWrite: state.sourceSnapshot?.completeness?.confirmed === true,
        },
        keyFor: (track) => `${state.targetProvider}:${state.targetProvider === 'apple-music' ? $('#storefront').value : ''}:${exactIsrcQuery(track, state.targetProvider) || String(track.query || `${track.title} ${track.artist}`).toLowerCase().replace(/\s+/g, ' ').trim()}`,
        onProgress: async (group) => {
          for (const track of group.tracks) {
            track.searching = false;
            track.searchError = Boolean(group.error);
            track.errorMessage = group.error ? (group.error instanceof TypeError ? 'Каталог недоступен. Проверьте соединение и повторите поиск.' : group.error.message) : '';
            track.searched = !group.error;
            track.matches = group.candidates;
            if (track.searched) applySuggestion(track);
            else { track.match = null; track.selected = false; }
          }
          completed += group.tracks.length;
          $('#searchStatus').textContent = `${completed} из ${state.tracks.length}`;
          if (completed % (trackPageSize * 2) < group.tracks.length || completed >= state.tracks.length) renderTracks();
        },
      });
      const withResults = state.tracks.filter((track) => track.searched && track.matches.length).length;
      const failed = state.tracks.filter((track) => track.searchError).length;
      $('#searchStatus').textContent = failed ? `Найдено: ${withResults} · ошибок: ${failed}` : `Найдено: ${withResults} из ${state.tracks.length}`;
      $('#searchStatus').classList.toggle('search-error', failed > 0);
      setStep(4);
      toast(failed ? 'Часть запросов не прошла — можно повторить' : `Совпадений в каталоге: ${withResults}`);
    } finally {
      state.searching = false;
      const labels = { 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс Музыке', spotify: 'Spotify', zvuk: 'Звуке' };
      $('#searchBtn').textContent = `Найти в ${labels[state.targetProvider] || state.targetProvider}`;
      renderTracks();
    }
  }

  function buildPlan() {
    return window.MusicTransferCore.createTransferPlan({
      sourceSnapshot: state.sourceSnapshot,
      targetProvider: state.targetProvider,
      targetCollectionType: state.collectionType,
      targetCollectionName: state.collectionType === 'library' ? 'Любимое и плейлисты' : state.collectionType === 'favorites' ? 'Любимое' : 'Плейлисты',
      storefront: state.targetProvider === 'apple-music' ? $('#storefront').value : null,
      tracks: state.tracks,
    });
  }

  $$('.source .connect').forEach((button) => button.addEventListener('click', () => {
    const card = button.closest('.source');
    const provider = card.dataset.provider;
    if (provider && state.librarySnapshots[provider]) {
      selectProviderSnapshot(provider);
      return;
    }
    state.source = card.dataset.source;
    state.sourceProvider = provider || 'file';
    $$('.source').forEach((item) => {
      const active = item === card;
      item.classList.toggle('selected', active);
      const provider = item.dataset.provider;
      const sourceStatus = ['spotify', 'yandex-music'].includes(provider)
        ? 'Выбран · экспериментальное чтение'
        : ['zvuk', 'apple-music'].includes(provider) ? 'Выбран · локальное расширение' : 'Выбран · импорт из файла';
      item.querySelector('.source-status').textContent = active
        ? sourceStatus
        : 'Не выбран';
      item.querySelector('.source-status').classList.toggle('connected', active);
      item.querySelector('.connect').disabled = active;
      item.querySelector('.connect').textContent = active ? '✓ Выбрано' : 'Выбрать';
    });
    $('.count').textContent = `1 из ${$$('.source').length}`;
    toast(`${state.source}: выбран как источник`);
  }));

  $('#loadBtn').addEventListener('click', () => loadTracks(demoTracks, `${state.source} · пример`));
  $('#fileInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      let label = file.name;
      let tracks;
      let payload = null;
      const sourceLabels = { zvuk: 'Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс Музыка', 'apple-music': 'Apple Music' };
      if (file.name.toLowerCase().endsWith('.json')) {
        payload = JSON.parse(text);
        tracks = normalizeJSON(payload);
        if (payload?.service && sourceLabels[payload.service]) label = `${sourceLabels[payload.service]} · ${payload.collection?.name || 'избранное'}`;
      } else {
        tracks = parseCSV(text);
      }
      if (!tracks.length && !payload?.playlists?.length) throw new Error('В файле не нашёл треков с названием и исполнителем');
      const sourceProvider = payload?.service && sourceLabels[payload.service] ? payload.service : state.sourceProvider;
      loadTracks(tracks, label, {
        provider: sourceProvider,
        collectionName: payload?.collection?.name,
        collectionType: payload?.collection?.type,
        completeness: payload?.completeness,
        playlists: payload?.playlists,
      });
    } catch (error) {
      toast(error.message || 'Не удалось прочитать файл');
    } finally {
      event.target.value = '';
    }
  });

  function requestAllLibraries(refresh = false) {
    if (!window.crypto?.randomUUID) return Promise.reject(new Error('Этот браузер не поддерживает запрос к локальному расширению.'));
    const requestId = window.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Расширение не ответило. Обновите его и локальную страницу.'));
      }, 20000);
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== location.origin
          || event.data?.source !== 'music-importer-local-app'
          || event.data?.type !== 'all-libraries-response'
          || event.data?.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'music-importer-local-app', type: 'get-all-libraries', requestId, refresh }, location.origin);
    });
  }

  $('#extensionImportBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!state.extensionAvailable) {
      checkLocalExtension();
      return;
    }
    button.disabled = true;
    button.textContent = 'Сканируем аккаунты…';
    $('#extensionStatus').textContent = 'Проверяем открытые вкладки сервисов и читаем подтверждённые библиотеки…';
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    try {
      let response = await requestAllLibraries(true);
      while (response.pending && Date.now() < deadline) {
        state.librarySnapshots = { ...state.librarySnapshots, ...(response.libraries || {}) };
        renderSourceAvailability(response.statuses || {});
        const running = Object.values(response.statuses || {}).filter((status) => status.status === 'scanning').map((status) => status.message);
        button.textContent = running[0] || 'Сканируем библиотеки…';
        $('#extensionStatus').textContent = running.length ? running.join(' · ') : 'Читаем оставшиеся открытые сессии…';
        await new Promise((resolve) => setTimeout(resolve, 2000));
        response = await requestAllLibraries(false);
      }
      if (response.pending) throw new Error('Сбор ещё выполняется. Библиотеки можно будет выбрать после завершения.');
      if (response.error) throw new Error(response.error);
      state.librarySnapshots = { ...state.librarySnapshots, ...(response.libraries || {}) };
      renderSourceAvailability(response.statuses || {});
      const connected = Object.keys(state.librarySnapshots).filter((provider) => response.libraries?.[provider] || response.statuses?.[provider]?.status === 'ready');
      if (!connected.length) {
        const details = Object.entries(response.statuses || {}).map(([provider, status]) => `${sourceLabels[provider]}: ${status.message || 'недоступен'}`).join(' · ');
        throw new Error(details || 'Не нашёл открытых библиотек. Войдите в музыкальные сервисы в Chrome и повторите.');
      }
      const selectedProvider = connected.includes(state.sourceProvider) ? state.sourceProvider : connected[0];
      selectProviderSnapshot(selectedProvider);
      const unavailable = Object.values(response.statuses || {}).filter((status) => status.status === 'unavailable').length;
      $('#extensionStatus').textContent = `Подключено аккаунтов: ${connected.length} из 4${unavailable ? ` · остальные недоступны: ${unavailable}` : ''}. Выберите любой источник выше.`;
      if (unavailable) toast(`Загружено библиотек: ${connected.length}; часть сервисов не открыта`);
      else toast(`Загружены библиотеки всех ${connected.length} аккаунтов`);
    } catch (error) {
      $('#extensionStatus').textContent = error.message || 'Не удалось загрузить открытые библиотеки.';
      toast(error.message || 'Не удалось получить данные из расширения.');
    } finally {
      button.disabled = false;
      button.textContent = 'Обновить открытые аккаунты';
    }
  });

  $('#templateBtn').addEventListener('click', () => {
    const blob = new Blob(['title,artist,album,isrc,duration_ms,id\n"Снег","Моя Мишель","Кино",,,\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'music-import-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  });

  $('#searchBtn').addEventListener('click', searchCatalog);
  $('#targetProvider').addEventListener('change', () => {
    state.targetProvider = $('#targetProvider').value;
    trackPage = 0;
    state.tracks.forEach((track) => { track.searched = false; track.searchError = false; track.matches = []; track.match = null; track.selected = false; });
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchStatus').textContent = 'Цель изменена; выполните новый поиск';
    updateTargetLabel();
    renderTracks();
  });
  $('#storefront').addEventListener('change', () => {
    if (!state.loaded) return;
    trackPage = 0;
    state.tracks.forEach((track) => { track.searched = false; track.searchError = false; track.matches = []; track.match = null; track.selected = false; });
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchStatus').textContent = 'Страна каталога изменена';
    renderTracks();
  });

  $('#toggleAll').addEventListener('click', () => {
    const shouldSelect = !state.tracks.some((track) => track.selected && track.match);
    state.tracks.forEach((track) => { track.selected = shouldSelect && Boolean(track.match); });
    state.report = null;
    $('#report').classList.remove('show');
    renderTracks();
  });

  $('#needsReviewOnly').addEventListener('change', () => {
    trackPage = 0;
    renderTracks();
  });
  $('#previousTrackPage').addEventListener('click', () => {
    trackPage = Math.max(0, trackPage - 1);
    renderTracks();
    $('#trackTools').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#nextTrackPage').addEventListener('click', () => {
    trackPage += 1;
    renderTracks();
    $('#trackTools').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('#resetBtn').addEventListener('click', () => {
    state.tracks = [];
    trackPage = 0;
    state.loaded = false;
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchStatus').textContent = 'Поиск не запускался';
    $('#reviewSub').textContent = 'Загрузите список и найдите версии песен';
    $('#trackList').innerHTML = '<div class="empty">Загрузите пример или свой список треков</div>';
    setStep(1);
    updateCounts();
    toast('Список сброшен');
  });

  checkLocalExtension();

  $('#importBtn').addEventListener('click', async () => {
    try {
      const plan = buildPlan();
      const sourceComplete = plan.completeness.source.length > 0
        && plan.completeness.source.every((status) => status?.confirmed === true);
      if (['yandex-music', 'zvuk', 'spotify'].includes(state.targetProvider) || (state.targetProvider === 'apple-music' && sourceComplete)) {
        if (plan.completeness.source.some((status) => status?.confirmed !== true)) {
          throw new Error('Для записи нужен полный snapshot. Пример и ручной CSV остаются в preview-only режиме.');
        }
        const playlistCount = plan.collectionMappings.length;
        const providerName = ({ 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс Музыка', zvuk: 'Звук', spotify: 'Spotify' })[state.targetProvider] || state.targetProvider;
        if (!window.confirm(`Записать ${plan.operations.length} совпавших треков и создать ${playlistCount} плейлистов в ${providerName}? Это изменит аккаунт. После записи приложение сверит лайки, треки и порядок.`)) return;
        $('#importBtn').disabled = true;
        $('#importBtn').textContent = 'Записываем и сверяем…';
        const commandProvider = ({ 'apple-music': 'apple', 'yandex-music': 'yandex', zvuk: 'zvuk', spotify: 'spotify' })[state.targetProvider];
        const response = await requestExtensionCommand('execute-transfer', { plan }, commandProvider);
        if (!response?.ok) {
          if (response?.report) {
            state.report = { ...plan, mode: 'account-write', execution: response.report };
            const partialFavorites = Number(response.report?.favorites?.verified || 0);
            const partialPlaylists = (response.report?.playlists || []).reduce((sum, playlist) => sum + Number(playlist.verified || 0), 0);
            $('#addedMetric').textContent = String(partialFavorites + partialPlaylists);
            $('#skippedMetric').textContent = String(plan.skipped.length);
            $('#report').querySelector('h3').textContent = response.report.status === 'partial_failure'
              ? 'Перенос остановлен · нужна сверка'
              : 'Перенос не выполнен';
            $('#report').querySelector('.report-grid .metric:last-child b').textContent = String(partialFavorites + partialPlaylists);
            $('#report').querySelector('.report-grid .metric:last-child span').textContent = `проверено в ${providerName}`;
            $('#report').classList.add('show');
            setStep(5);
          }
          throw new Error(response?.error || `Перенос в ${providerName} не выполнен.`);
        }
        state.report = { ...plan, mode: 'account-write', execution: response.report || { status: 'complete' } };
        const verifiedFavorites = Number(response.report?.favorites?.verified || 0);
        const verifiedPlaylists = (response.report?.playlists || []).reduce((sum, playlist) => sum + Number(playlist.verified || 0), 0);
        $('#addedMetric').textContent = verifiedFavorites + verifiedPlaylists;
        $('#skippedMetric').textContent = plan.skipped.length;
        $('#report').querySelector('h3').textContent = 'Перенос завершён и сверен';
        $('#report').querySelector('.report-grid .metric:last-child b').textContent = String(verifiedFavorites + verifiedPlaylists);
        $('#report').querySelector('.report-grid .metric:last-child span').textContent = `подтверждено в ${providerName}`;
        $('#report').classList.add('show');
        setStep(5);
        toast(`${providerName} подтвердила запись`);
      } else {
        state.report = plan;
        $('#addedMetric').textContent = state.report.operations.length;
        $('#skippedMetric').textContent = state.report.skipped.length;
        $('#report').querySelector('h3').textContent = 'План готов · без записи';
        $('#report').classList.add('show');
        setStep(5);
        toast('План сформирован; аккаунт не менялся');
      }
    } catch (error) {
      toast(error.message || 'Не удалось выполнить перенос.');
    } finally {
      $('#importBtn').disabled = false;
      updateCounts();
      updateTargetLabel();
    }
  });

  $('#downloadReport').addEventListener('click', () => {
    if (!state.report) return;
    const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'music-transfer-plan.json';
    anchor.click();
    URL.revokeObjectURL(url);
    toast('План скачан');
  });

  updateCounts();
  updateTargetLabel();
})();
