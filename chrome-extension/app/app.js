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
  const state = { source: '', sourceProvider: '', targetProvider: '', sourceSnapshot: null, librarySnapshots: {}, libraryStatuses: {}, collectionType: 'library', tracks: [], loaded: false, report: null, searching: false, transferInProgress: false, extensionAvailable: false, unresolvedTransferJob: null };
  const extensionApp = location.protocol === 'chrome-extension:' && typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  const extensionAppPort = extensionApp ? chrome.runtime.connect({ name: 'music-importer-app' }) : null;
  let trackPage = 0;
  let extensionCheckInProgress = false;
  let accountScanInProgress = false;
  let focusScanQueued = false;
  let focusScanTimer = null;
  let lastFocusScanAt = 0;
  let activeSearchController = null;
  window.MusicTransferSafety.installBeforeUnloadGuard(() => state.transferInProgress);
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
    if (extensionApp) {
      state.extensionAvailable = true;
      $('#openServicesBtn').disabled = false;
      status.textContent = 'Music Importer запущен в Chrome. Проверяю открытые аккаунты…';
      button.textContent = 'Подключаем аккаунты…';
      button.disabled = false;
      void scanOpenAccounts(true);
      return;
    }
    if (extensionCheckInProgress || state.extensionAvailable) return;
    if (!window.crypto?.randomUUID) {
      status.textContent = 'Этот браузер не поддерживает проверку локального расширения. Используйте Chrome.';
      button.textContent = 'Откройте в Chrome';
      button.disabled = true;
      return;
    }
    extensionCheckInProgress = true;
    button.disabled = true;
    button.textContent = 'Проверяем расширение…';
    status.textContent = 'Проверяем связь с расширением Music Importer…';
    const requestId = window.crypto.randomUUID();
    let answered = false;
    const timeout = setTimeout(() => {
      if (answered) return;
      window.removeEventListener('message', onMessage);
      extensionCheckInProgress = false;
      status.textContent = 'Расширение не подключено к этой странице. Если страница открыта во встроенном окне (например, Codex) или другом браузере, Chrome-расширение её не увидит. Откройте Music Importer значком в панели обычного Chrome: приложение внутри расширения просканирует открытые аккаунты. Эта localhost-страница — запасной режим.';
      button.textContent = 'Повторить проверку';
      button.disabled = false;
      $('#extensionHelp').open = true;
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
      $('#openServicesBtn').disabled = false;
      status.textContent = `Локальное расширение Chrome подключено · версия ${String(event.data.version || 'неизвестна')}. Начинаю сбор открытых аккаунтов.`;
      button.textContent = 'Подключаем аккаунты…';
      button.disabled = false;
      void scanOpenAccounts(true);
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
    const searchBusy = state.searching || state.tracks.some((track) => track.searching);
    const selected = state.tracks.filter((track) => track.selected && track.match).length;
    const reviewed = state.tracks.filter((track) => track.searched && track.matches.length && !track.match && !track.userExcluded).length;
    const missing = state.tracks.filter((track) => track.searched && !track.matches.length).length;
    $('#readyStat').textContent = state.loaded ? selected : '—';
    $('#reviewStat').textContent = state.loaded ? reviewed : '—';
    $('#missingStat').textContent = state.loaded ? missing : '—';
    $('#matchCount').textContent = state.loaded ? `${state.tracks.length} треков` : 'ожидает список';
    $('#selectedCount').textContent = `${selected} выбрано`;
    const hasPlaylistMappings = ['playlists', 'library'].includes(state.collectionType) && state.sourceSnapshot?.collections?.some((collection) => collection.type === 'playlists');
    $('#importBtn').disabled = !state.targetProvider || (selected === 0 && !hasPlaylistMappings) || searchBusy || Boolean(state.unresolvedTransferJob);
    $('#searchBtn').disabled = !state.loaded || !state.targetProvider || searchBusy;
    $('#targetProvider').disabled = searchBusy;
    $('#storefront').disabled = searchBusy;
    $('#loadBtn').disabled = searchBusy;
    $('#fileInput').disabled = searchBusy;
    $('#clearMatchCache').disabled = searchBusy;
    $('#cancelSearchBtn').hidden = !state.searching;
    $('#toggleAll').textContent = selected ? 'Снять выбор со всех' : 'Выбрать совпадения';
  }

  function renderTracks() {
    const needsReviewOnly = $('#needsReviewOnly').checked;
    const reviewable = state.tracks.some((track) => track.searched || track.searchError);
    const needsReview = (track) => track.searchError || (track.searched && !track.match && !track.userExcluded);
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
      const status = track.searching ? 'Ищем…' : track.searchError ? 'Ошибка поиска' : track.userExcluded ? 'Исключено вами' : track.searched && !track.matches.length ? (track.cachedResults ? 'Нет совпадений · кэш' : 'Не найдено') : track.match ? (track.accountLibraryMatch ? `Уже в аккаунте · ${Math.round(track.matchConfidence * 100)}%` : track.cachedMatch ? `Локальный кэш · ${Math.round(track.matchConfidence * 100)}%` : track.autoMatched ? `Автоматически · ${Math.round(track.matchConfidence * 100)}%` : 'Выбрано вручную') : track.searched ? (track.cachedResults ? 'Проверьте · кэш' : 'Проверьте') : 'Не искали';
      const badgeClass = track.searchError ? 'error' : track.match ? '' : !track.userExcluded && track.searched && track.matches.length ? 'review' : 'pending';
      const targetName = ({ 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс Музыка', spotify: 'Spotify', zvuk: 'Звук' })[state.targetProvider] || state.targetProvider;
      const options = track.matches.map((match) => `<option value="${escapeHTML(match.trackId)}" ${String(track.match?.trackId || '') === String(match.trackId) ? 'selected' : ''}>${escapeHTML(match.artistName)} — ${escapeHTML(match.trackName)}${match.collectionName ? ` · ${escapeHTML(match.collectionName)}` : ''}</option>`).join('');
      const matchControl = `<input class="track-query" data-index="${index}" aria-label="Поисковый запрос для ${title}" value="${escapeHTML(track.query || `${track.title} ${track.artist}`)}" ${state.searching ? 'disabled' : ''}><button class="track-search" type="button" data-index="${index}" ${state.searching ? 'disabled' : ''}>Искать</button>${track.matches.length ? `<select class="track-match" data-index="${index}" aria-label="Совпадение ${targetName} для ${title}"><option value="">${track.match && track.autoMatched ? 'Автоматическое совпадение · изменить' : 'Выберите версию…'}</option>${options}</select>${track.match ? `<a href="${escapeHTML(track.match.trackViewUrl)}" target="_blank" rel="noopener noreferrer">Открыть в ${targetName} ↗</a><div class="confidence ${track.autoMatched ? '' : 'review'}">${track.accountLibraryMatch ? `Уже в библиотеке аккаунта · ${Math.round(track.matchConfidence * 100)}%` : track.cachedMatch ? `Из локального кэша · ${Math.round(track.matchConfidence * 100)}%` : track.autoMatched ? `Автосопоставление · ${Math.round(track.matchConfidence * 100)}%` : 'Выбрано вручную'}</div>` : '<div class="confidence review">Нужно проверить: неоднозначное совпадение</div>'}` : `<div class="quiet ${track.searchError ? 'search-error' : ''}">${track.searchError ? (track.errorMessage || 'Повторите поиск') : track.searched ? 'В каталоге ничего не найдено' : 'Результаты появятся здесь'}</div>`}`;
      const collection = state.collectionType === 'library' ? `<div class="track-artist">${track.sourceCollectionType === 'favorites' ? 'Любимое' : escapeHTML(track.sourceCollectionName || 'Плейлист')}</div>` : '';
      return `<div class="track" data-index="${index}"><div class="cover" aria-hidden="true">♫</div><div><div class="track-name">${title}</div><div class="track-artist">${artist}</div>${collection}${track.album ? `<div class="track-artist">${escapeHTML(track.album)}</div>` : ''}</div><div class="match">${matchControl}</div><span class="badge ${badgeClass}">${status}</span><input class="include" type="checkbox" aria-label="Включить ${title}" data-index="${index}" ${track.selected && track.match ? 'checked' : ''} ${track.match ? '' : 'disabled'}></div>`;
    }).join('');

    $$('.track-match').forEach((select) => select.addEventListener('change', () => {
      const track = state.tracks[Number(select.dataset.index)];
      track.match = track.matches.find((match) => String(match.trackId) === select.value) || null;
      track.selected = Boolean(track.match);
      track.userExcluded = !track.match;
      track.autoMatched = false;
      track.cachedMatch = false;
      track.matchReason = track.match ? 'manual_review' : null;
      track.matchConfidence = track.match ? window.MusicMatcher.scoreCandidate(track, track.match).score : 0;
      persistMatchDecision(track);
      const duplicates = propagateSourceRecording(track);
      state.report = null;
      $('#report').classList.remove('show');
      renderTracks();
      if (duplicates.length > 1) toast(`Совпадение применено к ${duplicates.length} вхождениям этой записи; выбор можно менять отдельно`);
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
      const track = state.tracks[Number(checkbox.dataset.index)];
      track.selected = checkbox.checked;
      persistMatchDecision(track);
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
      query: [track.title, track.artist, track.album].filter(Boolean).join(' ').trim(),
      manualQuery: false,
      matches: [],
      match: null,
      selected: false,
      userExcluded: false,
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
    if (state.targetProvider) void searchCatalog();
  }

  const sourceLabels = { zvuk: 'Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс Музыка', 'apple-music': 'Apple Music' };

  function renderSourceAvailability(statuses = {}) {
    if (Object.keys(statuses).length) state.libraryStatuses = { ...statuses };
    $$('.source').forEach((card) => {
      const provider = card.dataset.provider;
      const snapshot = state.librarySnapshots[provider];
      const status = statuses[provider];
      const label = card.querySelector('.source-status');
      const button = card.querySelector('.connect');
      if (snapshot) {
        const playlistCount = snapshot.playlists.length;
        const count = `${snapshot.tracks.length} лайков · ${playlistCount} плейлистов`;
        if (status?.status === 'scanning' && status.cached) {
          label.textContent = `Обновляем · предыдущий снимок: ${count}`;
        } else if (status?.status === 'stale' || status?.status === 'unavailable') {
          label.textContent = `Последний полный снимок · ${count}`;
          button.title = status.message || 'Аккаунт сейчас не обновлён.';
        } else {
          label.textContent = card.classList.contains('selected') ? `Выбран · ${count}` : `Подключено · ${count}`;
          button.title = '';
        }
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
      } else if (status?.status === 'failed') {
        label.textContent = status.message || 'Не удалось прочитать библиотеку';
        label.classList.remove('connected');
        button.disabled = true;
        button.textContent = 'Ошибка чтения';
      } else {
        label.textContent = state.extensionAvailable
          ? 'Откройте сервис и войдите в аккаунт'
          : 'Подключите расширение для проверки открытой вкладки';
        label.classList.remove('connected');
        button.disabled = true;
        button.textContent = state.extensionAvailable ? 'Нет библиотеки' : 'Нет соединения';
      }
    });
    updateTargetLabel();
  }

  function selectProviderSnapshot(provider) {
    const payload = state.librarySnapshots[provider];
    if (!payload) {
      toast(`Сначала откройте ${sourceLabels[provider] || provider} в Chrome и обновите список аккаунтов`);
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
    $('[aria-labelledby="source-heading"] .count').textContent = `1 из ${$$('.source').length}`;
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

  async function searchWithMetadataFallback(track, search) {
    const queries = window.MusicMatcher.buildSearchQueries(track);
    track.searchExpansionComplete = false;
    const primaryCandidates = await search(queries.primary);
    const unique = new Map();
    const addCandidates = (candidates) => {
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const id = candidate?.trackId ?? candidate?.providerId ?? candidate?.id;
        const key = id ? `id:${id}` : `metadata:${[candidate?.trackName || candidate?.title || candidate?.name, candidate?.artistName || candidate?.artist, candidate?.collectionName || candidate?.album].map((value) => String(value || '').toLocaleLowerCase().trim()).join('|')}`;
        if (!unique.has(key)) unique.set(key, candidate);
      }
    };
    addCandidates(primaryCandidates);

    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean).join(' ')
      : String(track.artist || '');
    const romanized = track.manualQuery ? '' : [track.title, artists].map((value) => window.MusicMatcher.romanize(value)).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const cyrillicVariant = !track.manualQuery && ['yandex-music', 'zvuk'].includes(state.targetProvider)
      ? window.MusicMatcher.detransliterate(`${track.title || ''} ${artists}`).replace(/\s+/g, ' ').trim()
      : '';
    const normalizeQuery = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    const expandedQueries = [...new Set([queries.fallback, romanized, cyrillicVariant]
      .map((query) => String(query || '').trim())
      .filter((query) => query && normalizeQuery(query) !== normalizeQuery(queries.primary)))];

    // Catalogs can return irrelevant results even for a precise query. Expand
    // only while no candidate reaches the existing safe auto-match threshold.
    let expansionFailed = false;
    let reachedSafeMatch = false;
    for (const query of expandedQueries) {
      if (window.MusicMatcher.suggestBestMatch(track, [...unique.values()]).automatic) {
        reachedSafeMatch = true;
        break;
      }
      try {
        addCandidates(await search(query));
        if (window.MusicMatcher.suggestBestMatch(track, [...unique.values()]).automatic) {
          reachedSafeMatch = true;
          break;
        }
      } catch {
        // Keep usable first-page results. Mark the expansion incomplete so a
        // later run can retry the query that failed.
        expansionFailed = true;
      }
    }
    track.searchExpansionComplete = reachedSafeMatch || !expansionFailed;
    return [...unique.values()];
  }

  async function searchWithExactIsrc(track, provider, search) {
    const isrcQuery = exactIsrcQuery(track, provider);
    if (!isrcQuery) return searchWithMetadataFallback(track, search);
    const isrc = isrcQuery.slice('isrc:'.length);
    const exactCandidates = await search(isrcQuery);
    if (exactCandidates.some((candidate) => candidateHasIsrc(candidate, isrc))) {
      track.searchExpansionComplete = true;
      return exactCandidates;
    }
    return searchWithMetadataFallback(track, search);
  }

  function targetCommandError(response, fallback) {
    const error = new Error(response?.error || fallback);
    const status = Number(response?.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
    if (response?.retryAfter !== undefined && response?.retryAfter !== null) error.retryAfter = String(response.retryAfter);
    const retryAfterMs = Number(response?.retryAfterMs);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) error.retryAfterMs = retryAfterMs;
    return error;
  }

  const appleCatalogAdapter = {
    id: 'apple-music',
    maxConcurrentSearches: 2,
    batchSearchSize: 25,
    canBatchSearch(track, context = {}) {
      return context.accountWrite === true && Boolean(exactIsrcQuery(track, 'apple-music'));
    },
    async searchTracksBatch(tracks, context = {}) {
      const isrcs = tracks.map((track) => exactIsrcQuery(track, 'apple-music').slice('isrc:'.length));
      const response = await requestExtensionCommand('search-tracks', {
        query: `isrc:${isrcs.join(',')}`,
        storefront: context.storefront || $('#storefront').value,
      }, 'apple');
      if (!response?.ok || !Array.isArray(response.results)) throw targetCommandError(response, 'Не удалось пакетно найти ISRC в каталоге Apple Music.');
      const candidatesByIsrc = new Map(isrcs.map((isrc) => [isrc, []]));
      for (const candidate of response.results) {
        const isrc = window.MusicMatcher.normalizeISRC(candidate?.isrc || '');
        if (candidatesByIsrc.has(isrc)) candidatesByIsrc.get(isrc).push(candidate);
      }
      return isrcs.map((isrc) => candidatesByIsrc.get(isrc) || []);
    },
    async searchTracks(track, context = {}) {
      if (context.accountWrite !== true) {
        return searchWithMetadataFallback(track, async (query) => {
          const params = new URLSearchParams({
            term: query,
            entity: 'song', limit: '15', country: context.storefront || $('#storefront').value,
          });
          const response = await fetch(`https://itunes.apple.com/search?${params}`);
          if (!response.ok) throw targetCommandError({ status: response.status, retryAfter: response.headers.get('retry-after') }, `Каталог Apple ответил ${response.status}`);
          const payload = await response.json();
          return (payload.results || []).filter((item) => item.trackId && item.trackViewUrl).slice(0, 15);
        });
      }
      return searchWithExactIsrc(track, 'apple-music', async (query) => {
        const response = await requestExtensionCommand('search-tracks', {
          query,
          storefront: context.storefront || $('#storefront').value,
        }, 'apple');
        if (!response?.ok || !Array.isArray(response.results)) throw targetCommandError(response, 'Не удалось получить каталог Apple Music.');
        return response.results.filter((item) => item.trackId && item.trackViewUrl).slice(0, 25);
      });
    },
  };

  const yandexCatalogAdapter = {
    id: 'yandex-music',
    maxConcurrentSearches: 2,
    async searchTracks(track) {
      return searchWithMetadataFallback(track, async (query) => {
        const response = await requestExtensionCommand('search-tracks', { query });
        if (!response?.ok || !Array.isArray(response.results)) throw targetCommandError(response, 'Не удалось получить каталог Яндекс Музыки.');
        return response.results;
      });
    },
  };

  const zvukCatalogAdapter = {
    id: 'zvuk',
    maxConcurrentSearches: 2,
    async searchTracks(track) {
      return searchWithMetadataFallback(track, async (query) => {
        const response = await requestExtensionCommand('search-tracks', { query }, 'zvuk');
        if (!response?.ok || !Array.isArray(response.results)) throw targetCommandError(response, 'Не удалось получить каталог Звука.');
        return response.results;
      });
    },
  };

  const spotifyCatalogAdapter = {
    id: 'spotify',
    maxConcurrentSearches: 2,
    async searchTracks(track) {
      return searchWithExactIsrc(track, 'spotify', async (query) => {
        const response = await requestExtensionCommand('search-tracks', { query }, 'spotify');
        if (!response?.ok || !Array.isArray(response.results)) throw targetCommandError(response, 'Не удалось получить каталог Spotify.');
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

  function requestExtensionCommand(action, details = {}, provider = 'yandex', onProgress = null) {
    if (!window.crypto?.randomUUID) return Promise.reject(new Error('Этот браузер не поддерживает защищённый запрос к расширению.'));
    const requestId = window.crypto.randomUUID();
    if (extensionApp) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          extensionAppPort.onMessage.removeListener(onProgressMessage);
          reject(new Error('Сервис не ответил вовремя. Перезагрузите его вкладку и повторите.'));
        }, action === 'execute-transfer' ? 30 * 60 * 1000 : 45000);
        const onProgressMessage = (message) => {
          if (message?.type !== 'transfer-progress' || message.provider !== provider || message.requestId !== requestId) return;
          if (message.progress?.message) {
            $('#importBtn').textContent = message.progress.message;
            $('#searchStatus').textContent = message.progress.message;
          }
          if (typeof onProgress === 'function') {
            const acknowledge = (ok) => {
              if (!message.checkpointAckId) return;
              try { extensionAppPort.postMessage({ type: 'transfer-progress-ack', checkpointAckId: message.checkpointAckId, ok }); }
              catch { /* The writer will time out and stop before its next write. */ }
            };
            void Promise.resolve(onProgress(message.progress || {})).then((saved) => {
              acknowledge(saved === true);
            }).catch(() => {
              acknowledge(false);
            });
          }
        };
        extensionAppPort.onMessage.addListener(onProgressMessage);
        chrome.runtime.sendMessage({
          type: `music-importer:${provider}-command`,
          requestId,
          action,
          ...details,
        }).then((response) => {
          clearTimeout(timeout);
          extensionAppPort.onMessage.removeListener(onProgressMessage);
          if (response?.ok === false && response?.error) reject(targetCommandError(response, 'Сервис не выполнил команду.'));
          else resolve(response || { ok: false, error: 'Сервис не вернул результат.' });
        }, (error) => {
          clearTimeout(timeout);
          extensionAppPort.onMessage.removeListener(onProgressMessage);
          reject(error);
        });
      });
    }
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
          if (typeof onProgress === 'function') {
            void Promise.resolve(onProgress(progress || {})).then((saved) => {
              if (messageEvent.data.checkpointAckId) window.postMessage({
                source: 'music-importer-local-app', type: 'transfer-progress-ack', requestId,
                checkpointAckId: messageEvent.data.checkpointAckId, ok: saved === true,
              }, location.origin);
            }).catch(() => {
              if (messageEvent.data.checkpointAckId) window.postMessage({
                source: 'music-importer-local-app', type: 'transfer-progress-ack', requestId,
                checkpointAckId: messageEvent.data.checkpointAckId, ok: false,
              }, location.origin);
            });
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
    const symbols = { 'apple-music': '♫', 'yandex-music': 'Я', spotify: '●', zvuk: 'з' };
    const sourceProvider = state.sourceSnapshot?.provider || (state.loaded ? state.sourceProvider : '');
    const targetSelect = $('#targetProvider');
    for (const option of targetSelect.options) {
      option.disabled = Boolean(option.value && sourceProvider && option.value === sourceProvider);
    }
    if (targetSelect.selectedOptions[0]?.disabled) {
      targetSelect.value = '';
      state.targetProvider = '';
    }
    const label = labels[state.targetProvider] || '';
    const providerIcon = $('#targetProviderIcon');
    providerIcon.textContent = symbols[state.targetProvider] || '♫';
    providerIcon.dataset.provider = state.targetProvider || '';
    $('#targetProviderName').textContent = label;
    $('#review-heading').textContent = label ? `Сверка с каталогом ${label}` : 'Сверка с каталогом назначения';
    $('#searchBtn').textContent = label ? `Найти в ${label}` : 'Выберите сервис назначения';
    $('#storefront').hidden = state.targetProvider !== 'apple-music';
    $('#storefront').previousElementSibling.hidden = state.targetProvider !== 'apple-music';
    $('#importBtn').innerHTML = ({
      'yandex-music': 'Перенести в Яндекс Музыку <span aria-hidden="true">→</span>',
      'apple-music': 'Перенести в Apple Music <span aria-hidden="true">→</span>',
      zvuk: 'Перенести в Звук <span aria-hidden="true">→</span>',
      spotify: 'Перенести в Spotify <span aria-hidden="true">→</span>',
    })[state.targetProvider] || 'Выберите сервис назначения';
    $('#targetCollection').textContent = state.collectionType === 'library'
      ? 'Лайки и плейлисты'
      : state.collectionType === 'playlists' ? 'Плейлисты' : 'Избранные песни';

    const statusElement = $('#targetAccountStatus');
    const targetStatus = state.libraryStatuses[state.targetProvider];
    const targetSnapshot = state.librarySnapshots[state.targetProvider];
    if (!state.targetProvider) {
      statusElement.textContent = 'Выберите целевой сервис после подключения нужных аккаунтов.';
    } else if (targetStatus?.status === 'ready' && targetSnapshot) {
      statusElement.textContent = `Аккаунт ${label} доступен · ${targetStatus.trackCount ?? targetSnapshot.tracks?.length ?? 0} лайков · ${targetStatus.playlistCount ?? targetSnapshot.playlists?.length ?? 0} плейлистов.`;
    } else if (targetStatus?.status === 'scanning') {
      statusElement.textContent = targetStatus.message || `Проверяю аккаунт ${label}…`;
    } else if (targetStatus?.status === 'stale') {
      statusElement.textContent = `Снимок ${label} сохранён, но текущая сессия не обновилась. Проверьте вкладку и повторите сканирование.`;
    } else if (targetStatus?.status === 'unavailable') {
      statusElement.textContent = `${label}: ${targetStatus.message || 'аккаунт не подключён'}. Откройте сервис и войдите в Chrome.`;
    } else if (targetSnapshot) {
      statusElement.textContent = `Библиотека ${label} считана. Перед записью потребуется активная вкладка этого сервиса.`;
    } else if (state.extensionAvailable) {
      statusElement.textContent = `Аккаунт ${label} не найден среди открытых библиотек. Войдите в сервис и нажмите «Обновить открытые аккаунты».`;
    } else if (state.loaded && state.sourceSnapshot?.completeness?.confirmed !== true) {
      statusElement.textContent = 'Демо и CSV подходят для предпросмотра; для записи нужен полный снимок и открытый целевой аккаунт.';
    } else {
      statusElement.textContent = `Для поиска по аккаунту и записи откройте ${label} в Chrome и войдите в него.`;
    }
  }

  function applySuggestion(track) {
    const suggestion = window.MusicMatcher.suggestBestMatch(track, track.matches);
    track.match = suggestion.automatic ? suggestion.best : null;
    track.matchConfidence = suggestion.confidence;
    track.matchReason = suggestion.reason;
    track.autoMatched = suggestion.automatic;
    track.cachedMatch = false;
    track.userExcluded = false;
    track.selected = suggestion.automatic;
  }

  function matchCacheContext() {
    return {
      targetProvider: state.targetProvider,
      storefront: $('#storefront').value,
      accountCatalog: state.sourceSnapshot?.completeness?.confirmed === true,
      sourceProvider: state.sourceProvider,
    };
  }

  function restoreMatchDecision(track, decisions) {
    const cache = window.MusicMatchCache;
    if (!cache || !decisions) return;
    const context = matchCacheContext();
    const key = cache.decisionKeyFor(track, context.targetProvider, context.storefront, context.accountCatalog, context.sourceProvider);
    const decision = key ? decisions.get(key) : null;
    if (!decision) return;
    if (!decision.targetTrackId) {
      track.match = null;
      track.selected = false;
      track.autoMatched = false;
      track.cachedMatch = false;
      track.userExcluded = true;
      return;
    }
    const match = track.matches.find((candidate) => String(candidate.trackId) === String(decision.targetTrackId));
    if (!match) return;
    track.match = match;
    track.selected = decision.selected;
    track.autoMatched = false;
    track.cachedMatch = false;
    track.userExcluded = false;
    track.matchReason = 'manual_review';
    track.matchConfidence = window.MusicMatcher.scoreCandidate(track, match).score;
  }

  function persistMatchDecision(track) {
    const cache = window.MusicMatchCache;
    if (!cache || !track) return;
    const context = matchCacheContext();
    void cache.putDecision(track, context.targetProvider, {
      selected: Boolean(track.selected && track.match),
      trackId: track.match?.trackId || null,
    }, context.storefront, context.accountCatalog, context.sourceProvider);
  }

  function propagateSourceRecording(track) {
    const duplicates = window.MusicMatcher.propagateSourceMatch(state.tracks, track, state.sourceProvider);
    for (const duplicate of duplicates) if (duplicate !== track) persistMatchDecision(duplicate);
    return duplicates;
  }

  async function updateMatchCacheStatus() {
    const status = $('#matchCacheStatus');
    if (!status || !window.MusicMatchCache) return;
    const count = await window.MusicMatchCache.count();
    status.textContent = `На этом устройстве сохранено результатов поиска и решений: ${count.toLocaleString('ru-RU')}. Результаты хранятся до 30 дней (пустые — 7), решения — до 180 дней.`;
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
    track.cachedMatch = false;
    track.accountLibraryMatch = false;
    track.cachedResults = false;
    track.matches = [];
    track.match = null;
    track.selected = false;
    track.userExcluded = false;
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
      try {
        const context = matchCacheContext();
        const decisions = await window.MusicMatchCache?.getDecisions([track], context.targetProvider, context.storefront, context.accountCatalog, context.sourceProvider);
        restoreMatchDecision(track, decisions);
      } catch { /* A saved review choice must not interrupt a fresh search. */ }
      await window.MusicMatchCache?.putSearchResults([track], state.targetProvider, $('#storefront').value, state.sourceSnapshot?.completeness?.confirmed === true);
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
    if (!state.loaded || !state.targetProvider || state.searching || state.tracks.some((track) => track.searching)) return;
    const controller = new AbortController();
    activeSearchController = controller;
    state.searching = true;
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchBtn').textContent = 'Идёт поиск…';
    $('#searchStatus').classList.remove('search-error');
    setStep(3);
    const pending = state.tracks.filter((track) => !track.searched || track.searchError);
    let completed = state.tracks.length - pending.length;
    let cachedCount = 0;
    $('#searchStatus').textContent = `${completed} из ${state.tracks.length}`;
    updateCounts();

    try {
      pending.forEach((track) => {
        track.searching = true;
        track.searchError = false;
        track.cachedMatch = false;
        track.accountLibraryMatch = false;
        track.cachedResults = false;
        track.matches = [];
        track.match = null;
        track.selected = false;
      });
      let cacheHits = new Map();
      let savedDecisions = new Map();
      try {
        cacheHits = await window.MusicMatchCache?.getMany(pending, state.targetProvider, $('#storefront').value, state.sourceSnapshot?.completeness?.confirmed === true) || cacheHits;
      } catch { /* A local cache failure must not prevent a fresh catalog search. */ }
      try {
        const context = matchCacheContext();
        savedDecisions = await window.MusicMatchCache?.getDecisions(pending, context.targetProvider, context.storefront, context.accountCatalog, context.sourceProvider) || savedDecisions;
      } catch { /* Saved review choices are optional; fresh matching remains available. */ }
      if (controller.signal.aborted) throw new DOMException('Поиск отменён', 'AbortError');
      const pendingSearch = [];
      const accountCatalogIndex = window.MusicAccountCatalog?.buildIndex(state.librarySnapshots[state.targetProvider], state.targetProvider) || new Map();
      const accountMatches = window.MusicAccountCatalog?.resolveTracks(pending, accountCatalogIndex)?.matches || new Map();
      let accountLibraryCount = 0;
      for (const track of pending) {
        if (track.searched) continue;
        const key = window.MusicMatchCache?.keyFor(track, state.targetProvider, $('#storefront').value, state.sourceSnapshot?.completeness?.confirmed === true);
        const cached = key ? cacheHits.get(key) : null;
        const accountCandidates = accountMatches.get(track) || [];
        const useAccountCandidates = accountCandidates.length > 0;
        if (!useAccountCandidates && !Array.isArray(cached?.candidates)) { pendingSearch.push(track); continue; }
        track.matches = useAccountCandidates ? accountCandidates : cached.candidates;
        track.searched = true;
        track.searching = false;
        track.searchError = false;
        track.accountLibraryMatch = useAccountCandidates;
        track.cachedResults = !track.accountLibraryMatch;
        applySuggestion(track);
        if (!track.accountLibraryMatch) restoreMatchDecision(track, savedDecisions);
        track.searchExpansionComplete = track.accountLibraryMatch || cached.searchExpansionComplete === true;
        if (!track.accountLibraryMatch && track.matches.length && !track.match && !track.userExcluded && !track.searchExpansionComplete) {
          track.searching = true;
          pendingSearch.push(track);
          continue;
        }
        if (track.accountLibraryMatch) {
          accountLibraryCount += 1;
        } else if (track.autoMatched && track.match) {
          track.cachedMatch = true;
        }
        completed += 1;
        if (!track.accountLibraryMatch) cachedCount += 1;
      }
      if (cacheHits.size) {
        $('#searchStatus').textContent = `${completed} из ${state.tracks.length} · из локального кэша ${cachedCount}${accountLibraryCount ? ` · уже в аккаунте: ${accountLibraryCount}` : ''}`;
        renderTracks();
      }
      updateCounts();
      renderTracks();
      if (controller.signal.aborted) throw new DOMException('Поиск отменён', 'AbortError');
      await window.MusicTransferEngine.searchMany(targetAdapter(), pendingSearch, {
        context: {
          storefront: $('#storefront').value,
          accountWrite: state.sourceSnapshot?.completeness?.confirmed === true,
        },
        keyFor: (track) => {
          const query = exactIsrcQuery(track, state.targetProvider) || window.MusicMatcher.buildSearchQueries(track).primary.toLowerCase().replace(/\s+/g, ' ').trim();
          return window.MusicMatcher.catalogSearchGroupKey(track, state.sourceProvider, state.targetProvider, $('#storefront').value, query);
        },
        signal: controller.signal,
        onProgress: async (group) => {
          for (const track of group.tracks) {
            track.searching = false;
            track.cachedMatch = false;
            track.cachedResults = false;
            track.searchError = Boolean(group.error);
            track.errorMessage = group.error ? (group.error instanceof TypeError ? 'Каталог недоступен. Проверьте соединение и повторите поиск.' : group.error.message) : '';
            track.searched = !group.error;
            track.matches = group.candidates;
            if (track.searched) {
              applySuggestion(track);
              restoreMatchDecision(track, savedDecisions);
            }
            else { track.match = null; track.selected = false; }
          }
          try { await window.MusicMatchCache?.putSearchResults(group.tracks, state.targetProvider, $('#storefront').value, state.sourceSnapshot?.completeness?.confirmed === true); }
          catch { /* Keep catalog matching usable if browser storage is unavailable. */ }
          completed += group.tracks.length;
          $('#searchStatus').textContent = `${completed} из ${state.tracks.length}`;
          if (completed % (trackPageSize * 2) < group.tracks.length || completed >= state.tracks.length) renderTracks();
        },
      });
      const withResults = state.tracks.filter((track) => track.searched && track.matches.length).length;
      const failed = state.tracks.filter((track) => track.searchError).length;
      const resultStatus = failed ? `Найдено: ${withResults} · ошибок: ${failed}` : `Найдено: ${withResults} из ${state.tracks.length}`;
      $('#searchStatus').textContent = `${resultStatus}${accountLibraryCount ? ` · уже в аккаунте: ${accountLibraryCount}` : ''}${cachedCount ? ` · из локального кэша: ${cachedCount}` : ''}`;
      $('#searchStatus').classList.toggle('search-error', failed > 0);
      setStep(4);
      toast(failed ? 'Часть запросов не прошла — можно повторить' : `Совпадений в каталоге: ${withResults}`);
      void updateMatchCacheStatus();
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      const message = aborted
        ? 'Поиск остановлен. Завершённые результаты сохранены; следующий запуск продолжит с оставшихся треков.'
        : error?.message || 'Массовый поиск прервался. Повторите поиск для оставшихся треков.';
      for (const track of state.tracks) {
        if (!track.searching) continue;
        track.searching = false;
        if (!aborted) {
          track.searchError = true;
          track.errorMessage = message;
        }
      }
      $('#searchStatus').textContent = message;
      $('#searchStatus').classList.toggle('search-error', !aborted);
      if (aborted) toast('Поиск остановлен; готовые совпадения сохранены');
    } finally {
      state.searching = false;
      if (activeSearchController === controller) activeSearchController = null;
      const labels = { 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс Музыке', spotify: 'Spotify', zvuk: 'Звуке' };
      $('#searchBtn').textContent = `Найти в ${labels[state.targetProvider] || state.targetProvider}`;
      renderTracks();
    }
  }

  $('#cancelSearchBtn').addEventListener('click', () => activeSearchController?.abort());

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

  const providerLabels = { zvuk: 'Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс Музыка', 'apple-music': 'Apple Music' };

  function renderUnresolvedTransferJob() {
    const job = state.unresolvedTransferJob;
    const warning = $('#transferJobWarning');
    if (!warning) return;
    warning.classList.toggle('show', Boolean(job));
    const resumeButton = $('#resumeTransferJob');
    if (resumeButton) {
      resumeButton.hidden = !job?.recoveryPlan;
      resumeButton.disabled = state.transferInProgress || !job?.recoveryPlan;
    }
    if (!job) return;
    const source = providerLabels[job.sourceProvider] || job.sourceProvider;
    const target = providerLabels[job.targetProvider] || job.targetProvider;
    const progress = job.progress?.phase ? ` Этап: ${job.progress.phase}${job.progress.total != null ? ` (${job.progress.completed ?? 0}/${job.progress.total})` : ''}.` : '';
    const outcome = job.outcome ? ` ${job.outcome}` : '';
    $('#transferJobDetails').textContent = `${source} → ${target} · ${job.operationCount} треков · ${job.playlistCount} плейлистов.${progress}${outcome}`;
  }

  async function refreshUnresolvedTransferJob() {
    state.unresolvedTransferJob = await window.MusicTransferJobStore?.latestUnresolved() || null;
    renderUnresolvedTransferJob();
    updateCounts();
  }

  void refreshUnresolvedTransferJob();

  $('#resumeTransferJob')?.addEventListener('click', async () => {
    const job = state.unresolvedTransferJob;
    if (!job?.recoveryPlan || state.transferInProgress) return;
    const providerName = providerLabels[job.targetProvider] || job.targetProvider;
    if (!window.confirm(`Продолжить прежний план в ${providerName}? Сначала приложение сверит уже записанные лайки и порядок треков. Новые записи возможны только для подтверждённого остатка.`)) return;
    state.transferInProgress = true;
    updateCounts();
    renderUnresolvedTransferJob();
    let jobClaimed = false;
    try {
      const resumed = await window.MusicTransferJobStore?.resume(job.id);
      if (!resumed) throw new Error('Не удалось безопасно открыть сохранённую операцию для продолжения.');
      jobClaimed = true;
      const plan = {
        ...job.recoveryPlan,
        recovery: { playlistTargets: job.playlistTargets || {}, progress: job.progress || null },
      };
      const commandProvider = ({ 'apple-music': 'apple', 'yandex-music': 'yandex', zvuk: 'zvuk', spotify: 'spotify' })[job.targetProvider];
      if (!commandProvider) throw new Error('Сервис назначения сохранённой операции неизвестен.');
      const response = await requestExtensionCommand('execute-transfer', { plan }, commandProvider, (progress) => window.MusicTransferJobStore.updateProgress(job.id, progress));
      if (!response?.ok) {
        const status = response?.report?.status === 'partial_failure' ? 'partial_failure' : 'failed';
        await window.MusicTransferJobStore.finish(job.id, status, response?.error || 'Продолжение не прошло проверку целевого аккаунта.');
        toast(response?.error || 'Продолжение остановлено: проверьте целевой аккаунт.');
      } else {
        await window.MusicTransferJobStore.finish(job.id, 'complete', 'Продолжение завершено и подтверждено read-back.');
        toast('Перенос продолжен и сверен с целевым аккаунтом.');
      }
    } catch (error) {
      if (jobClaimed) await window.MusicTransferJobStore?.finish(job.id, 'unknown', 'Связь прервалась во время продолжения; проверьте целевой аккаунт.');
      toast(error instanceof Error ? error.message : 'Не удалось продолжить перенос.');
    } finally {
      state.transferInProgress = false;
      await refreshUnresolvedTransferJob();
      updateCounts();
    }
  });

  $('#acknowledgeTransferJob')?.addEventListener('click', async () => {
    const job = state.unresolvedTransferJob;
    if (!job) return;
    const acknowledged = await window.MusicTransferJobStore?.acknowledge(job.id);
    if (!acknowledged) {
      toast('Не удалось сохранить отметку сверки. Проверьте доступность локального хранилища.');
      return;
    }
    state.unresolvedTransferJob = null;
    renderUnresolvedTransferJob();
    updateCounts();
    toast('Сверка сохранена; можно подготовить следующий перенос');
  });

  $$('.source .connect').forEach((button) => button.addEventListener('click', () => {
    if (state.searching || state.tracks.some((track) => track.searching)) {
      toast('Остановите поиск перед сменой источника.');
      return;
    }
    const card = button.closest('.source');
    const provider = card.dataset.provider;
    if (provider && state.librarySnapshots[provider]) {
      selectProviderSnapshot(provider);
      return;
    }
    toast(`Сначала откройте ${sourceLabels[provider] || provider} в Chrome и подключите его библиотеку`);
  }));

  $('#loadBtn').addEventListener('click', () => loadTracks(demoTracks, 'Демо-данные', { provider: 'file' }));
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

  function requestAllLibraries(refresh = false, refreshProviders = null) {
    if (!window.crypto?.randomUUID) return Promise.reject(new Error('Этот браузер не поддерживает запрос к локальному расширению.'));
    const requestId = window.crypto.randomUUID();
    if (extensionApp) {
      return chrome.runtime.sendMessage({ type: 'music-importer:get-all-libraries', requestId, refresh, refreshProviders })
        .catch(() => ({ error: 'Не удалось связаться с расширением. Перезапустите Music Importer из панели Chrome.' }));
    }
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
      window.postMessage({ source: 'music-importer-local-app', type: 'get-all-libraries', requestId, refresh, refreshProviders }, location.origin);
    });
  }

  function requestOpenProviderTabs() {
    if (!window.crypto?.randomUUID) return Promise.reject(new Error('Этот браузер не поддерживает запуск вкладок сервисов.'));
    const requestId = window.crypto.randomUUID();
    if (extensionApp) {
      return chrome.runtime.sendMessage({ type: 'music-importer:open-provider-tabs' })
        .catch(() => ({ ok: false, error: 'Не удалось связаться с расширением Chrome.' }));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Расширение не ответило. Перезапустите Music Importer в обычном Chrome.'));
      }, 10000);
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== location.origin
          || event.data?.source !== 'music-importer-local-app'
          || event.data?.type !== 'provider-tabs-response'
          || event.data?.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'music-importer-local-app', type: 'open-provider-tabs', requestId }, location.origin);
    });
  }

  async function openMissingServices() {
    const button = $('#openServicesBtn');
    if (!state.extensionAvailable) return;
    button.disabled = true;
    try {
      const response = await requestOpenProviderTabs();
      if (!response?.ok) throw new Error(response?.error || 'Не удалось открыть сервисы.');
      const names = { zvuk: 'Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс Музыка', 'apple-music': 'Apple Music' };
      const opened = (response.opened || []).map((id) => names[id] || id);
      const alreadyOpen = (response.alreadyOpen || []).map((id) => names[id] || id);
      $('#extensionStatus').textContent = opened.length
        ? `Открыты вкладки: ${opened.join(', ')}. Войдите в нужные аккаунты и вернитесь в Music Importer — он проверит их автоматически. Уже открыты: ${alreadyOpen.join(', ') || 'нет'}.`
        : `Все вкладки уже открыты: ${alreadyOpen.join(', ') || 'нет'}. Войдите в нужные аккаунты и вернитесь в Music Importer — он проверит их автоматически.`;
      toast(opened.length ? `Открыто вкладок для входа: ${opened.length}` : 'Все вкладки сервисов уже открыты');
    } catch (error) {
      $('#extensionStatus').textContent = error.message || 'Не удалось открыть сервисы.';
      toast(error.message || 'Не удалось открыть сервисы.');
    } finally {
      button.disabled = !state.extensionAvailable;
    }
  }

  async function scanOpenAccounts(automatic = false, refreshProviders = null) {
    const button = $('#extensionImportBtn');
    if (!state.extensionAvailable) {
      checkLocalExtension();
      return;
    }
    if (accountScanInProgress) {
      if (automatic) focusScanQueued = true;
      return;
    }
    accountScanInProgress = true;
    button.disabled = true;
    button.textContent = 'Сканируем аккаунты…';
    $('#extensionStatus').textContent = automatic
      ? 'Расширение подключено. Проверяю открытые вкладки сервисов и читаю библиотеки…'
      : 'Проверяю открытые вкладки сервисов и читаю подтверждённые библиотеки…';
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    try {
      let response = await requestAllLibraries(true, refreshProviders);
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
      const connected = Object.keys(state.librarySnapshots).filter((provider) => response.libraries?.[provider] || ['ready', 'stale'].includes(response.statuses?.[provider]?.status));
      if (!connected.length) {
        const details = Object.entries(response.statuses || {}).map(([provider, status]) => `${sourceLabels[provider]}: ${status.message || 'недоступен'}`).join(' · ');
        throw new Error(details || 'Не нашёл открытых библиотек. Войдите в музыкальные сервисы в Chrome и повторите.');
      }
      const selectedProvider = connected.includes(state.sourceProvider) ? state.sourceProvider : connected[0];
      selectProviderSnapshot(selectedProvider);
      const unavailable = Object.values(response.statuses || {}).filter((status) => status.status === 'unavailable').length;
      const stale = Object.values(response.statuses || {}).filter((status) => status.status === 'stale').length;
      $('#extensionStatus').textContent = `Библиотек доступно: ${connected.length} из 4${stale ? ` · не обновились: ${stale}` : ''}${unavailable ? ` · без снимка: ${unavailable}` : ''}. Выберите источник выше.`;
      if (!automatic || connected.length) {
        if (stale) toast(`Доступно библиотек: ${connected.length}; часть снимков не обновилась`);
        else if (unavailable) toast(`Загружено библиотек: ${connected.length}; часть сервисов не открыта`);
        else toast(`Загружены библиотеки всех ${connected.length} аккаунтов`);
      }
    } catch (error) {
      $('#extensionStatus').textContent = error.message || 'Не удалось загрузить открытые библиотеки.';
      if (!automatic) toast(error.message || 'Не удалось получить данные из расширения.');
    } finally {
      accountScanInProgress = false;
      button.disabled = false;
      button.textContent = 'Обновить открытые аккаунты';
      if (focusScanQueued) {
        focusScanQueued = false;
        scheduleFocusRefresh();
      }
    }
  }

  function missingAccountProviders() {
    const providers = ['zvuk', 'spotify', 'yandex-music', 'apple-music'];
    return providers.filter((provider) => {
      const status = state.libraryStatuses[provider]?.status;
      return !state.librarySnapshots[provider] || status === 'unavailable' || status === 'stale';
    });
  }

  function scheduleFocusRefresh() {
    if (!extensionApp || !state.extensionAvailable || document.visibilityState !== 'visible') return;
    const providers = missingAccountProviders();
    if (!providers.length) return;
    if (accountScanInProgress) {
      focusScanQueued = true;
      return;
    }
    if (Date.now() - lastFocusScanAt < 10000) return;
    lastFocusScanAt = Date.now();
    void scanOpenAccounts(true, providers);
  }

  document.addEventListener('visibilitychange', () => {
    if (!extensionApp || !state.extensionAvailable || document.visibilityState !== 'visible') return;
    if (focusScanTimer) clearTimeout(focusScanTimer);
    focusScanTimer = setTimeout(() => {
      focusScanTimer = null;
      scheduleFocusRefresh();
    }, 700);
  });

  $('#extensionImportBtn').addEventListener('click', () => {
    if (state.searching || state.tracks.some((track) => track.searching)) {
      toast('Дождитесь окончания поиска или остановите его перед обновлением библиотек.');
      return;
    }
    scanOpenAccounts(false);
  });

  $('#openServicesBtn').addEventListener('click', openMissingServices);

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
    if (state.searching || state.tracks.some((track) => track.searching)) return;
    state.targetProvider = $('#targetProvider').value;
    trackPage = 0;
    state.tracks.forEach((track) => { track.searched = false; track.searchError = false; track.matches = []; track.match = null; track.selected = false; });
    state.report = null;
    $('#report').classList.remove('show');
    updateTargetLabel();
    $('#searchStatus').textContent = state.targetProvider
      ? 'Начинаю автоматический поиск в выбранном каталоге…'
      : state.loaded ? 'Выберите сервис назначения, отличный от источника.' : 'Сначала выберите сервис назначения';
    renderTracks();
    if (state.targetProvider && state.loaded) void searchCatalog();
  });
  $('#storefront').addEventListener('change', () => {
    if (!state.loaded || state.searching || state.tracks.some((track) => track.searching)) return;
    trackPage = 0;
    state.tracks.forEach((track) => { track.searched = false; track.searchError = false; track.matches = []; track.match = null; track.selected = false; });
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchStatus').textContent = 'Страна каталога изменена; обновляю совпадения…';
    renderTracks();
    if (state.targetProvider) void searchCatalog();
  });

  $('#toggleAll').addEventListener('click', () => {
    const shouldSelect = !state.tracks.some((track) => track.selected && track.match);
    state.tracks.forEach((track) => { track.selected = shouldSelect && Boolean(track.match); });
    const context = matchCacheContext();
    void window.MusicMatchCache?.putDecisions(state.tracks.filter((track) => track.match), context.targetProvider, (track) => ({
      selected: Boolean(shouldSelect && track.match),
      trackId: track.match?.trackId || null,
    }), context.storefront, context.accountCatalog, context.sourceProvider);
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
        state.transferInProgress = true;
        $('#importBtn').disabled = true;
        $('#importBtn').textContent = 'Подготавливаем журнал переноса…';
        if (state.unresolvedTransferJob) {
          throw new Error('Сначала сверьте предыдущий перенос с целевым аккаунтом и подтвердите это в предупреждении.');
        }
        if (!window.MusicTransferJobStore || !window.crypto?.randomUUID) {
          throw new Error('Не удалось включить защищённый журнал переноса. Обновите страницу в Chrome и повторите.');
        }
        const transferJobId = window.crypto.randomUUID();
        const jobStarted = await window.MusicTransferJobStore.start({
          id: transferJobId,
          sourceProvider: state.sourceProvider,
          targetProvider: state.targetProvider,
          operationCount: plan.operations.length,
          playlistCount,
          recoveryPlan: plan,
        });
        if (!jobStarted) throw new Error('Не удалось надёжно сохранить начало переноса на этом устройстве. Запись в музыкальный аккаунт не запускалась.');
        $('#importBtn').textContent = 'Записываем и сверяем…';
        const commandProvider = ({ 'apple-music': 'apple', 'yandex-music': 'yandex', zvuk: 'zvuk', spotify: 'spotify' })[state.targetProvider];
        let response;
        try {
          response = await requestExtensionCommand('execute-transfer', { plan }, commandProvider, (progress) => window.MusicTransferJobStore.updateProgress(transferJobId, progress));
        } catch (error) {
          await window.MusicTransferJobStore.finish(transferJobId, 'unknown', 'Связь прервалась; проверьте целевой аккаунт.');
          await refreshUnresolvedTransferJob();
          throw error;
        }
        if (!response?.ok) {
          const failedStatus = response?.report?.status === 'partial_failure' ? 'partial_failure' : 'failed';
          const outcome = failedStatus === 'partial_failure'
            ? 'Сервис сообщил о частичной ошибке; проверьте целевой аккаунт.'
            : 'Сервис не подтвердил перенос; проверьте целевой аккаунт.';
          await window.MusicTransferJobStore.finish(transferJobId, failedStatus, outcome);
          await refreshUnresolvedTransferJob();
        } else {
          const jobFinished = await window.MusicTransferJobStore.finish(transferJobId, 'complete', 'Сервис подтвердил запись обратной сверкой.');
          if (!jobFinished) await refreshUnresolvedTransferJob();
        }
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
      state.transferInProgress = false;
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

  $('#clearMatchCache').addEventListener('click', async () => {
    await window.MusicMatchCache?.clear();
    await updateMatchCacheStatus();
    toast('Локальные результаты и решения очищены');
  });

  updateCounts();
  updateTargetLabel();
  void updateMatchCacheStatus();
})();
