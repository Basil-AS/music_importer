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
  const state = { source: '', sourceProvider: '', targetProvider: '', sourceSnapshot: null, librarySnapshots: {}, partialLibraries: {}, libraryStatuses: {}, sourceCollectionScope: 'all', collectionType: 'library', tracks: [], albums: [], albumsSkipped: false, loaded: false, report: null, searching: false, transferInProgress: false, extensionAvailable: false, unresolvedTransferJob: null, pendingLoginProviders: new Set(), openingProviderTabs: new Set() };
  const extensionApp = location.protocol === 'chrome-extension:' && typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  const extensionAppPort = extensionApp ? chrome.runtime.connect({ name: 'music-importer-app' }) : null;
  let trackPage = 0;
  let albumPage = 0;
  let extensionCheckInProgress = false;
  let accountScanInProgress = false;
  const pendingProviderRetries = new Set();
  let focusScanQueued = false;
  let focusScanTimer = null;
  let lastFocusScanAt = 0;
  let activeSearchController = null;
  window.MusicTransferSafety.installBeforeUnloadGuard(() => state.transferInProgress);
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  function normalizeArtworkUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const expanded = raw.replace(/^\/\//, 'https://')
      .replace(/\{w\}/g, '600').replace(/\{h\}/g, '600').replace(/\{f\}/g, 'jpg')
      .replace(/%%/g, '300x300').replace(/(^|\/)100x100bb(?=\.)/g, (_match, prefix) => `${prefix}600x600bb`);
    try {
      const url = new URL(expanded);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  }

  function artworkFromTrack(track) {
    const album = Array.isArray(track?.albums) ? track.albums[0] : track?.album;
    const release = track?.release;
    const candidates = [
      track?.artworkUrl, track?.artwork?.url, track?.artwork?.src,
      track?.coverUrl, track?.coverUri, track?.cover?.url, track?.cover,
      track?.imageUrl, track?.image?.url, track?.image,
      album?.artwork?.url, album?.coverUri, album?.coverUrl, album?.cover?.url, album?.cover,
      album?.imageUrl, album?.image?.url, album?.image,
      release?.artwork?.url, release?.coverUri, release?.coverUrl, release?.cover?.url, release?.cover,
      release?.imageUrl, release?.image?.url, release?.image,
    ];
    for (const candidate of candidates) {
      const url = normalizeArtworkUrl(typeof candidate === 'object' ? candidate?.url || candidate?.src || candidate?.uri : candidate);
      if (url) return url;
    }
    return '';
  }

  function formatDuration(value) {
    const milliseconds = Number(value) || 0;
    if (milliseconds <= 0) return '';
    const seconds = Math.floor(milliseconds / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 3000);
  }

  function updateSourceCount() {
    const count = $('[aria-labelledby="source-heading"] .count');
    if (!count) return;
    count.textContent = state.extensionAvailable
      ? `${new Set([...Object.keys(state.librarySnapshots), ...Object.keys(state.partialLibraries)]).size} из ${$$('.source').length}`
      : 'Подключите расширение';
  }

  function sourceSnapshotForProvider(provider) {
    return state.librarySnapshots[provider] || state.partialLibraries[provider] || null;
  }

  function applyLibraryResponse(response) {
    state.librarySnapshots = { ...state.librarySnapshots, ...(response.libraries || {}) };
    state.partialLibraries = response.partialLibraries || {};
  }

  function checkLocalExtension() {
    const button = $('#extensionImportBtn');
    const status = $('#extensionStatus');
    if (extensionApp) {
      state.extensionAvailable = true;
      updateSourceCount();
      $('#openServicesBtn').disabled = false;
      status.textContent = 'Проверяю сервисы…';
      button.textContent = 'Обновить библиотеки';
      button.disabled = false;
      void chrome.runtime.sendMessage({ type: 'music-importer:repair-provider-bridges', skipProviders: ['spotify'] })
        .catch(() => null)
        .finally(() => scanOpenAccounts(true));
      return;
    }
    if (extensionCheckInProgress || state.extensionAvailable) return;
    if (!window.crypto?.randomUUID) {
      status.textContent = 'Откройте приложение в Chrome.';
      button.textContent = 'Откройте в Chrome';
      button.disabled = true;
      return;
    }
    extensionCheckInProgress = true;
    button.disabled = true;
    button.textContent = 'Проверяем расширение…';
    status.textContent = 'Проверка связи…';
    const requestId = window.crypto.randomUUID();
    let answered = false;
    const timeout = setTimeout(() => {
      if (answered) return;
      window.removeEventListener('message', onMessage);
      extensionCheckInProgress = false;
      status.textContent = 'Откройте Music Importer из панели Chrome.';
      updateSourceCount();
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
      updateSourceCount();
      $('#openServicesBtn').disabled = false;
      status.textContent = `Подключено · ${String(event.data.version || 'неизвестна')}`;
      button.textContent = 'Обновить библиотеки';
      button.disabled = false;
      void scanOpenAccounts(true);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'music-importer-local-app', type: 'extension-ping', requestId }, location.origin);
  }

  function setStep(step) {
    $$('.step').forEach((element, index) => {
      const active = index + 1 === step;
      element.classList.toggle('active', active);
      element.classList.toggle('done', index + 1 < step);
      element.querySelector('.step-num').textContent = index + 1 < step ? '✓' : String(index + 1);
      if (active) element.setAttribute('aria-current', 'step');
      else element.removeAttribute('aria-current');
    });
  }

  function updatePrivacyControls() {
    const button = $('#clearLibrarySnapshots');
    if (!button) return;
    button.disabled = !extensionApp || !state.extensionAvailable || accountScanInProgress
      || state.transferInProgress || Boolean(state.unresolvedTransferJob);
  }

  function formatStorageBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  let snapshotUsageRequest = 0;
  let lastSnapshotUsageSignature = null;
  async function updateSnapshotStorageEstimate() {
    const status = $('#libraryStorageEstimate');
    if (!status) return;
    const snapshots = { ...state.librarySnapshots, ...state.partialLibraries };
    const signature = Object.entries(snapshots).map(([provider, snapshot]) => [
      provider,
      snapshot.snapshotCachedAt || snapshot.exportedAt || '',
      snapshot.tracks?.length || 0,
      snapshot.playlists?.length || 0,
      window.MusicAlbumMatcher.extractSourceAlbums(snapshot)?.rows.length || 0,
    ].join(':')).sort().join('|');
    if (signature === lastSnapshotUsageSignature) return;
    lastSnapshotUsageSignature = signature;
    const getBytesInUse = chrome.storage?.local?.getBytesInUse;
    if (!extensionApp || typeof getBytesInUse !== 'function') {
      status.textContent = 'Недоступно';
      return;
    }
    const request = ++snapshotUsageRequest;
    try {
      const bytes = await getBytesInUse.call(chrome.storage.local, ['providerLibraryBridge', 'zvukFavoriteCapture']);
      if (request !== snapshotUsageRequest) return;
      const accountCount = Object.keys(snapshots).length;
      status.textContent = accountCount
        ? `Снимки: ${accountCount} · ${formatStorageBytes(bytes)}`
        : 'Нет снимков';
    } catch {
      if (request === snapshotUsageRequest) status.textContent = 'Размер недоступен';
    }
  }

  function updateCounts() {
    const searchBusy = state.searching || state.tracks.some((track) => track.searching) || state.albums.some((album) => album.searching);
    const selected = state.tracks.filter((track) => track.selected && track.match).length;
    const reviewed = state.tracks.filter((track) => (track.metadataComplete === false && !track.match)
      || (track.searched && track.matches.length && !track.match && !track.userExcluded)).length;
    const missing = state.tracks.filter((track) => track.searched && !track.matches.length).length;
    const albumsBusy = state.albums.some((album) => album.searching);
    const albumsSelected = state.albums.filter((album) => album.selected && album.match).length;
    const albumsReviewed = state.albums.filter((album) => album.searchError || (album.searched && album.matches.length && !album.match && !album.userExcluded)).length;
    $('#readyStat').textContent = state.loaded ? selected : '—';
    $('#reviewStat').textContent = state.loaded ? reviewed : '—';
    $('#missingStat').textContent = state.loaded ? missing : '—';
    $('#albumReadyStat').textContent = state.loaded && state.albums.length ? albumsSelected : '—';
    $('#albumReviewStat').textContent = state.loaded && state.albums.length ? albumsReviewed : '—';
    $('#matchCount').textContent = state.loaded ? `${state.tracks.length} треков${state.albums.length ? ` · ${state.albums.length} альбомов` : ''}` : 'ожидает список';
    $('#selectedCount').textContent = `${selected + albumsSelected} выбрано`;
    const hasPlaylistMappings = ['playlists', 'library'].includes(state.collectionType) && state.sourceSnapshot?.collections?.some((collection) => collection.type === 'playlists');
    $('#importBtn').disabled = !state.targetProvider || (selected === 0 && albumsSelected === 0 && !hasPlaylistMappings) || searchBusy || albumsBusy || Boolean(state.unresolvedTransferJob);
    $('#searchBtn').disabled = !state.loaded || !state.targetProvider || searchBusy || albumsBusy;
    $('#targetProvider').disabled = searchBusy;
    $('#storefront').disabled = searchBusy;
    $('#loadBtn').disabled = searchBusy;
    $('#uploadFileBtn').disabled = searchBusy;
    $('#fileInput').disabled = searchBusy;
    $('#clearMatchCache').disabled = searchBusy;
    $('#cancelSearchBtn').hidden = !state.searching;
    $('#toggleAll').textContent = selected + albumsSelected ? 'Снять выбор со всех' : 'Выбрать совпадения';
    updatePrivacyControls();
  }

  function renderTracks() {
    renderTrackRows();
    renderAlbums();
  }

  function filteredTrackEntries() {
    const filter = $('#trackStatusFilter').value || 'all';
    const sort = $('#trackSort').value || 'source';
    const needsReview = (track) => track.searchError || track.metadataComplete === false
      || (track.searched && !track.match && !track.userExcluded);
    const rows = state.tracks.map((track, index) => ({ track, index })).filter(({ track }) => {
      if (filter === 'review') return needsReview(track);
      if (filter === 'matched') return Boolean(track.match) && !track.userExcluded;
      if (filter === 'missing') return track.searched && !track.matches.length && !track.searchError;
      if (filter === 'excluded') return Boolean(track.userExcluded);
      return true;
    });
    if (sort === 'source') return rows;
    const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
    rows.sort((left, right) => {
      if (sort === 'confidence') {
        const difference = (Number(right.track.matchConfidence) || 0) - (Number(left.track.matchConfidence) || 0);
        if (difference) return difference;
      } else {
        const key = sort === 'artist' ? 'artist' : 'title';
        const difference = collator.compare(String(left.track[key] || ''), String(right.track[key] || ''));
        if (difference) return difference;
        if (key === 'title') {
          const artistDifference = collator.compare(String(left.track.artist || ''), String(right.track.artist || ''));
          if (artistDifference) return artistDifference;
        }
      }
      return left.index - right.index;
    });
    return rows;
  }

  function renderTrackRows() {
    const filter = $('#trackStatusFilter').value || 'all';
    const displayedTracks = filteredTrackEntries();
    const pageCount = Math.max(1, Math.ceil(displayedTracks.length / trackPageSize));
    trackPage = Math.min(trackPage, pageCount - 1);
    const first = trackPage * trackPageSize;
    const visibleTracks = displayedTracks.slice(first, first + trackPageSize);
    const tools = $('#trackTools');
    tools.hidden = state.tracks.length === 0;
    $('#trackPageStatus').textContent = displayedTracks.length
      ? `Показаны ${first + 1}–${Math.min(first + trackPageSize, displayedTracks.length)} из ${displayedTracks.length}`
      : filter === 'review' ? 'Проверка не требуется'
        : filter === 'matched' ? 'Совпадений пока нет'
          : filter === 'missing' ? 'Ненайденных треков нет'
            : filter === 'excluded' ? 'Исключённых треков нет' : '0 записей';
    $('#previousTrackPage').disabled = trackPage === 0;
    $('#nextTrackPage').disabled = trackPage >= pageCount - 1;
    const visibleMatches = visibleTracks.map(({ track }) => track).filter((track) => track.match);
    const allVisibleSelected = visibleMatches.length > 0 && visibleMatches.every((track) => track.selected);
    $('#selectVisibleMatches').disabled = !visibleMatches.length || state.searching;
    $('#selectVisibleMatches').textContent = allVisibleSelected
      ? 'Снять выбор на странице' : 'Выбрать совпадения на странице';

    if (!state.tracks.length || !visibleTracks.length) {
      const playlistCount = state.sourceSnapshot?.collections?.filter((collection) => collection.type === 'playlists').length || 0;
      $('#trackList').innerHTML = state.tracks.length
        ? `<div class="empty">${filter === 'review' ? 'Проверка не требуется.' : filter === 'matched' ? 'Совпадений по этому фильтру пока нет.' : filter === 'missing' ? 'Ненайденных треков нет.' : filter === 'excluded' ? 'Исключённых треков нет.' : 'Треков для показа нет.'}</div>`
        : playlistCount ? `<div class="empty">Загружено плейлистов: ${playlistCount}. Треки для сопоставления не найдены.</div>`
          : state.albums.length && !state.tracks.length ? '<div class="empty">Треки не выбраны для переноса; альбомы для сверки ниже.</div>'
            : '<div class="empty">Загрузите пример или свой список треков</div>';
      updateCounts();
      return;
    }

    $('#trackList').innerHTML = visibleTracks.map(({ track, index }) => {
      const missingMetadata = track.metadataComplete === false && !track.title && !track.artist;
      const title = escapeHTML(track.title || (missingMetadata ? 'Метаданные недоступны' : 'Без названия'));
      const artist = escapeHTML(track.artist || (missingMetadata ? 'Введите название или исполнителя для ручного поиска' : ''));
      const status = track.searching ? 'Ищем…' : track.searchError ? 'Ошибка поиска' : track.userExcluded ? 'Исключено вами' : missingMetadata && !track.query ? 'Нужны данные' : track.searched && !track.matches.length ? (track.cachedResults ? 'Нет совпадений · кэш' : 'Не найдено') : track.match ? (track.accountLibraryMatch ? `Уже в аккаунте · ${Math.round(track.matchConfidence * 100)}%` : track.cachedMatch ? `Локальный кэш · ${Math.round(track.matchConfidence * 100)}%` : track.autoMatched ? `Автоматически · ${Math.round(track.matchConfidence * 100)}%` : 'Выбрано вручную') : track.searched ? (track.cachedResults ? 'Проверьте · кэш' : 'Проверьте') : 'Не искали';
      const badgeClass = track.searchError ? 'error' : track.match ? '' : !track.userExcluded && track.searched && track.matches.length ? 'review' : 'pending';
      const targetName = ({ 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс.Музыка', spotify: 'Spotify', zvuk: 'Сбер.Звук' })[state.targetProvider] || state.targetProvider;
      const options = track.matches.map((match) => `<option value="${escapeHTML(match.trackId)}" ${String(track.match?.trackId || '') === String(match.trackId) ? 'selected' : ''}>${escapeHTML(match.artistName)} — ${escapeHTML(match.trackName)}${match.collectionName ? ` · ${escapeHTML(match.collectionName)}` : ''}</option>`).join('');
      const matchControl = `<input class="track-query" data-index="${index}" aria-label="Поисковый запрос для ${title}" value="${escapeHTML(track.query || `${track.title} ${track.artist}`)}" ${state.searching ? 'disabled' : ''}><button class="track-search" type="button" data-index="${index}" aria-label="Искать совпадение для ${title}" ${state.searching ? 'disabled' : ''}>Искать</button>${track.matches.length ? `<select class="track-match" data-index="${index}" aria-label="Совпадение ${targetName} для ${title}"><option value="">${track.match && track.autoMatched ? 'Автоматическое совпадение · изменить' : 'Выберите версию…'}</option>${options}</select>${track.match ? `<a href="${escapeHTML(track.match.trackViewUrl)}" target="_blank" rel="noopener noreferrer">Открыть в ${targetName} ↗</a><div class="confidence ${track.autoMatched ? '' : 'review'}">${track.accountLibraryMatch ? `Уже в библиотеке аккаунта · ${Math.round(track.matchConfidence * 100)}%` : track.cachedMatch ? `Из локального кэша · ${Math.round(track.matchConfidence * 100)}%` : track.autoMatched ? `Автосопоставление · ${Math.round(track.matchConfidence * 100)}%` : 'Выбрано вручную'}</div>` : '<div class="confidence review">Нужно проверить: неоднозначное совпадение</div>'}` : `<div class="quiet ${track.searchError ? 'search-error' : ''}">${track.searchError ? (track.errorMessage || 'Повторите поиск') : track.searched ? 'В каталоге ничего не найдено' : 'Результаты появятся здесь'}</div>`}`;
      const collection = state.collectionType === 'library' ? `<div class="track-artist">${track.sourceCollectionType === 'favorites' ? 'Любимое' : escapeHTML(track.sourceCollectionName || 'Плейлист')}</div>` : '';
      const album = track.album || track.match?.collectionName || track.matches[0]?.collectionName || '';
      const duration = formatDuration(track.durationMs || track.match?.trackTimeMillis || track.matches[0]?.trackTimeMillis);
      const releaseYear = String(track.releaseDate || track.match?.releaseDate || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
      const artworkUrl = normalizeArtworkUrl(track.artworkUrl || track.match?.artworkUrl || track.matches.find((match) => match.artworkUrl)?.artworkUrl);
      const cover = artworkUrl ? `<img class="cover-image" src="${escapeHTML(artworkUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span aria-hidden="true">♫</span>';
      return `<div class="track" data-index="${index}"><div class="cover" aria-hidden="true">${cover}</div><div><div class="track-name">${title}</div><div class="track-artist">${artist}</div>${collection}${album ? `<div class="track-artist">${escapeHTML(album)}${releaseYear ? ` · ${releaseYear}` : ''}</div>` : ''}${duration ? `<div class="track-artist">${duration}</div>` : ''}</div><div class="match">${matchControl}</div><span class="badge ${badgeClass}">${status}</span><input class="include" type="checkbox" aria-label="Включить ${title}" data-index="${index}" ${track.selected && track.match ? 'checked' : ''} ${track.match ? '' : 'disabled'}></div>`;
    }).join('');

    $$('.cover-image').forEach((image) => image.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.textContent = '♫';
      fallback.setAttribute('aria-hidden', 'true');
      image.replaceWith(fallback);
    }, { once: true }));

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
    albumPage = 0;
    const sourceAlbums = metadata.albums || null;
    state.albumsSkipped = metadata.albumsSkipped === true;
    state.albums = (sourceAlbums?.rows || []).map((album) => ({
      ...album,
      query: [album.title, album.artist].filter(Boolean).join(' ').trim(),
      matches: [],
      match: null,
      selected: false,
      userExcluded: false,
      searched: false,
      searching: false,
      searchError: false,
    }));
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
      albums: sourceAlbums ? { items: sourceAlbums.rows, completeness: { confirmed: sourceAlbums.confirmed, totalCount: sourceAlbums.rows.length } } : null,
      completeness: metadata.completeness || { confirmed: false, reason: 'file_import' },
    });
    state.loaded = true;
    state.report = null;
    $('#report').classList.remove('show');
    const playlistCount = state.sourceSnapshot.collections.filter((collection) => collection.type === 'playlists').length;
    const missingMetadataCount = list.filter((track) => track.metadataComplete === false && !track.title && !track.artist).length;
    $('#reviewSub').textContent = `${label} · ${list.length} треков${state.albums.length ? ` · ${state.albums.length} альбомов` : ''}${state.albumsSkipped ? ' · альбомы не подтверждены и не переносятся' : ''}${playlistCount ? ` · ${playlistCount} плейлистов` : ''}${missingMetadataCount ? ` · без метаданных: ${missingMetadataCount}` : ''} готовы к поиску`;
    updateTargetLabel();
    $('#searchStatus').textContent = 'Поиск не запускался';
    $('#searchStatus').classList.remove('search-error');
    renderTracks();
    setStep(2);
    $('#reviewCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(`Загружено треков: ${list.length}${state.albums.length ? `, альбомов: ${state.albums.length}` : ''}`);
  }

  const sourceLabels = { zvuk: 'Сбер.Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс.Музыка', 'apple-music': 'Apple Music' };
  const providerLabels = sourceLabels;

  function renderSourceAvailability(statuses = {}) {
    void updateSnapshotStorageEstimate();
    if (Object.keys(statuses).length) {
      state.libraryStatuses = { ...state.libraryStatuses, ...statuses };
      for (const [provider, status] of Object.entries(state.libraryStatuses)) {
        const snapshot = state.librarySnapshots[provider];
        if (!snapshot) continue;
        const cachedAt = snapshot.snapshotCachedAt || snapshot.exportedAt || '';
        const age = window.MusicLibraryCache?.formatAge(cachedAt) || '';
        const freshness = window.MusicLibraryCache?.evaluate({ cachedSnapshot: snapshot, lastCheckedAt: cachedAt }) || 'stale';
        state.libraryStatuses[provider] = {
          ...status,
          cacheAge: age,
          ...(status.status === 'ready' && freshness !== 'fresh'
            ? { status: 'stale', message: 'Сохранённый снимок старше шести часов; обновите библиотеку.' }
            : {}),
        };
      }
    }
    for (const [provider, status] of Object.entries(state.libraryStatuses)) {
      if (/не сообщал о прогрессе 2 минуты|неполный снимок не сохранён/i.test(String(status.message || ''))) {
        state.libraryStatuses[provider] = {
          ...status,
          message: `${sourceLabels[provider] || provider}: нет прогресса 2 минуты. Снимок не сохранён.`,
        };
      }
    }
    $$('.source').forEach((card) => {
      const provider = card.dataset.provider;
      const snapshot = state.librarySnapshots[provider];
      const partial = state.partialLibraries[provider];
      const status = state.libraryStatuses[provider];
      const label = card.querySelector('.source-status');
      const progress = card.querySelector('.source-progress');
      const collections = card.querySelector('.source-collections');
      const button = card.querySelector('.connect');
      const retryButton = card.querySelector('.source-retry');
      const scanning = status?.status === 'scanning';
      label.classList.remove('partial', 'connected', 'failed', 'stale');
      card.toggleAttribute('aria-busy', scanning);
      progress.hidden = !scanning;
      progress.setAttribute('aria-label', `Сбор библиотеки ${sourceLabels[provider] || provider}`);
      const progressCounts = scanning
        ? [...String(status.message || '').matchAll(/(\d+)\s+из\s+(\d+)/gi)].at(-1) || null
        : null;
      const progressValue = progressCounts ? Number(progressCounts[1]) : 0;
      const progressMax = progressCounts ? Number(progressCounts[2]) : 0;
      if (progressMax > 0) {
        progress.setAttribute('max', String(progressMax));
        progress.setAttribute('value', String(Math.min(progressValue, progressMax)));
        progress.setAttribute('aria-valuetext', `${Math.min(progressValue, progressMax)} из ${progressMax}`);
      } else {
        progress.removeAttribute('max');
        progress.removeAttribute('value');
        progress.removeAttribute('aria-valuetext');
      }
      card.dataset.scanPhase = scanning ? String(status.phase || 'reading') : '';
      const refreshAction = window.MusicProviderConnectionFlow.refreshAction({
        extensionAvailable: state.extensionAvailable,
        status,
        queued: pendingProviderRetries.has(provider),
      });
      retryButton.hidden = !(snapshot || partial) || !refreshAction.visible;
      retryButton.disabled = refreshAction.disabled;
      retryButton.textContent = refreshAction.label;
      retryButton.title = refreshAction.title;
      if (snapshot) {
        const count = window.MusicAccountCatalog.snapshotSummary(snapshot);
        const albumInfo = window.MusicAlbumMatcher.extractSourceAlbums(snapshot);
        const collectionParts = [`Лайки: ${snapshot.tracks?.length || 0}`];
        if (albumInfo?.confirmed) collectionParts.push(`Альбомы: ${albumInfo.rows.length}`);
        else if (albumInfo) collectionParts.push('Альбомы: не подтверждены');
        collectionParts.push(`Плейлисты: ${snapshot.playlists?.length || 0}`);
        collections.textContent = collectionParts.join(' · ');
        collections.hidden = false;
        if (scanning) {
          label.textContent = status.message || `Обновляем ${sourceLabels[provider]}…`;
        } else if (status?.status === 'stale' || status?.status === 'unavailable') {
          label.textContent = `${status.message || 'Последний полный снимок'} · ${count}${status.cacheAge ? ` · ${status.cacheAge}` : ''}`;
          button.title = status.message || 'Аккаунт сейчас не обновлён.';
        } else if (status?.status === 'failed') {
          label.textContent = `Обновление не завершилось: ${status.message || 'ошибка чтения'}`;
          button.title = status.message || '';
        } else {
          const labelPrefix = card.classList.contains('selected') ? 'Выбран' : 'Подключено';
          label.textContent = `${labelPrefix} · ${count}${status?.cacheAge ? ` · ${status.cacheAge}` : ''}`;
          button.title = '';
        }
        label.classList.toggle('failed', status?.status === 'failed');
        label.classList.toggle('stale', status?.status === 'stale' || status?.status === 'unavailable');
        label.classList.toggle('connected', !['failed', 'stale', 'unavailable'].includes(status?.status));
      } else if (partial) {
        collections.textContent = `Лайки: ${partial.tracks.length} · Плейлисты: не подтверждены`;
        collections.hidden = false;
        label.textContent = scanning
          ? status.message || `Читаем библиотеку ${sourceLabels[provider]}…`
          : `Подтверждены только лайки · ${partial.tracks.length}. Можно выбрать и перенести их отдельно.${status?.status === 'failed' && status.message ? ` Ошибка: ${status.message}` : ''}`;
        label.classList.add('partial');
        label.classList.toggle('failed', status?.status === 'failed');
        label.classList.toggle('stale', status?.status === 'stale' || status?.status === 'unavailable');
        button.title = status?.message || 'Каталог или содержимое плейлистов не подтверждено.';
      } else if (status?.status === 'scanning') {
        collections.hidden = true;
        label.textContent = status.message || 'Сканируем открытую сессию…';
      } else if (status?.status === 'unavailable') {
        collections.hidden = true;
        label.textContent = status.message || 'Войдите в аккаунт и вернитесь сюда';
        label.classList.add('stale');
      } else if (status?.status === 'failed') {
        collections.hidden = true;
        label.textContent = status.message || 'Не удалось прочитать библиотеку';
        label.classList.add('failed');
      } else {
        collections.hidden = true;
        label.textContent = state.extensionAvailable
          ? 'Войдите в аккаунт, чтобы загрузить библиотеку'
          : 'Подключите расширение для проверки открытой вкладки';
        label.classList.remove('connected');
      }
      const action = window.MusicProviderConnectionFlow.sourceAction({
        extensionAvailable: state.extensionAvailable,
        snapshot: snapshot || partial,
        status,
        providerName: sourceLabels[provider],
        selected: card.classList.contains('selected'),
        opening: state.openingProviderTabs.has(provider),
      queued: pendingProviderRetries.has(provider),
      });
      button.disabled = action.disabled;
      button.textContent = action.label;
      button.title = action.title;
    });
    updateSourceCount();
    updateTargetLabel();
  }

  function renderSourceCollectionPicker(provider, selectedScope = 'all') {
    const payload = sourceSnapshotForProvider(provider);
    const tools = $('#sourceCollectionTools');
    const select = $('#sourceCollectionSelect');
    const playlists = Array.isArray(payload?.playlists) ? payload.playlists : [];
    const favoritesOnly = payload?.partialScope === 'favorites';
    const canScope = Boolean(payload && (playlists.length || Array.isArray(payload.tracks)));
    tools.hidden = !canScope;
    if (!canScope) return;
    const albumInfo = window.MusicAlbumMatcher.extractSourceAlbums(payload);
    const options = favoritesOnly
      ? [new Option(`Только подтверждённые лайки (${payload.tracks.length})`, 'favorites')]
      : [new Option(albumInfo?.confirmed ? 'Лайки, альбомы и все плейлисты' : 'Лайки и все плейлисты', 'all')];
    if (!favoritesOnly && Array.isArray(payload.tracks)) options.push(new Option(`Только лайки (${payload.tracks.length})`, 'favorites'));
    if (!favoritesOnly && albumInfo) options.push(new Option(albumInfo.confirmed ? `Только альбомы (${albumInfo.rows.length})` : 'Только альбомы (не подтверждены)', 'albums'));
    for (const playlist of favoritesOnly ? [] : playlists) {
      const id = String(playlist.id || playlist.title || playlist.name || '');
      const title = String(playlist.title || playlist.name || 'Плейлист');
      const count = Number.isInteger(playlist.trackCount) ? playlist.trackCount : (playlist.tracks || playlist.items || []).length;
      options.push(new Option(`${title} (${count})`, `playlist:${id}`));
    }
    select.replaceChildren(...options);
    select.value = options.some((option) => option.value === selectedScope) ? selectedScope : 'all';
    if (favoritesOnly) select.value = 'favorites';
    select.disabled = favoritesOnly;
    const onePlaylist = select.value.startsWith('playlist:');
    $('#targetPlaylistName').hidden = !onePlaylist;
    $('#targetPlaylistNameLabel').hidden = !onePlaylist;
    if (!onePlaylist) $('#targetPlaylistName').value = '';
  }

  function selectProviderSnapshot(provider, collectionScope = null) {
    const originalPayload = sourceSnapshotForProvider(provider);
    const favoritesOnly = originalPayload?.partialScope === 'favorites';
    const scope = collectionScope || (state.sourceProvider === provider ? state.sourceCollectionScope : favoritesOnly ? 'favorites' : 'all');
    renderSourceCollectionPicker(provider, scope);
    let payload = originalPayload;
    if (!payload) {
      toast(`Сначала откройте ${sourceLabels[provider] || provider} в Chrome и обновите список аккаунтов`);
      return;
    }
    state.sourceCollectionScope = $('#sourceCollectionSelect').value || 'all';
    if (state.sourceCollectionScope === 'favorites') {
      payload = {
        ...payload,
        playlists: [],
        completeness: {
          ...payload.completeness,
          ...(favoritesOnly ? { confirmed: payload.completeness.favoritesConfirmed === true, libraryComplete: false } : {}),
          playlists: [], playlistCount: 0, playlistItemsTotal: 0,
          ...(favoritesOnly ? { playlistItemsConfirmed: true } : {}),
        },
      };
    } else if (state.sourceCollectionScope === 'albums') {
      payload = {
        ...payload,
        tracks: [],
        playlists: [],
        completeness: { ...payload.completeness, favoritesCount: 0, favoritesConfirmed: true, playlistCount: 0, playlists: [] },
      };
    } else if (state.sourceCollectionScope.startsWith('playlist:')) {
      const selectedId = state.sourceCollectionScope.slice('playlist:'.length);
      const playlist = (originalPayload.playlists || []).find((item) => String(item.id || item.title || item.name || '') === selectedId);
      if (!playlist) {
        state.sourceCollectionScope = 'all';
        renderSourceCollectionPicker(provider, 'all');
      } else {
        payload = {
          ...originalPayload,
          tracks: [],
          playlists: [playlist],
          completeness: { ...originalPayload.completeness, favoritesCount: 0, favoritesConfirmed: true, playlistCount: 1 },
        };
      }
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
    const albumScope = favoritesOnly ? { albums: null, skipped: false } : window.MusicAlbumMatcher.albumsForScope(originalPayload, state.sourceCollectionScope);
    loadTracks(tracks, `${state.source} · ${favoritesOnly ? 'только лайки, плейлисты не подтверждены' : 'библиотека из расширения'}`, {
      provider,
      collectionName: payload.collection?.name,
      collectionType: payload.collection?.type,
      completeness: payload.completeness,
      playlists: payload.playlists,
      albums: albumScope.albums,
      albumsSkipped: albumScope.skipped,
    });
    $('#targetPlaylistName').value = '';
    $('#targetPlaylistName').hidden = !state.sourceCollectionScope.startsWith('playlist:');
    $('#targetPlaylistNameLabel').hidden = !state.sourceCollectionScope.startsWith('playlist:');
    renderSourceAvailability();
  }

  $('#sourceCollectionSelect').addEventListener('change', () => {
    if (!state.sourceProvider) return;
    if (state.searching || state.tracks.some((track) => track.searching) || state.albums.some((album) => album.searching)) {
      toast('Остановите поиск перед сменой коллекции.');
      $('#sourceCollectionSelect').value = state.sourceCollectionScope;
      return;
    }
    selectProviderSnapshot(state.sourceProvider, $('#sourceCollectionSelect').value);
  });

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
        artworkUrl: artworkFromTrack(track),
        releaseDate: String(track?.releaseDate || track?.release_date || track?.album?.releaseDate || track?.release?.releaseDate || ''),
        isrc: String(track?.isrc || track?.ISRC || track?.externalIds?.isrc || track?.external_ids?.isrc || ''),
        durationMs: normalizeDuration(track?.durationMs || track?.duration_ms || track?.duration),
        sourceId: String(track?.id || track?.trackId || track?.track_id || track?.uri || ''),
        sourceCollectionType: String(row?.__sourceCollectionType || track?.collectionType || (row?.__sourceCollectionId ? 'playlists' : 'favorites')),
        sourceCollectionId: String(row?.__sourceCollectionId || track?.playlistId || ''),
        sourceCollectionName: String(row?.__sourceCollectionName || track?.playlistName || ''),
        sourceCollectionItemCount: Number.isInteger(row?.__sourceCollectionItemCount) ? row.__sourceCollectionItemCount : null,
        sourceCollectionComplete: row?.__sourceCollectionComplete === true,
        sourcePosition: Number.isInteger(row?.__sourcePosition) ? row.__sourcePosition : Number(track?.position || 0),
        metadataComplete: track?.metadataComplete !== false,
      };
    }).filter((track) => (track.title && track.artist) || (track.metadataComplete === false && track.sourceId));
  }

  function exactIsrcQuery(track, provider) {
    if (track.manualQuery || !['apple-music', 'spotify'].includes(provider)) return '';
    const isrc = window.MusicMatcher.normalizeISRC(track.isrc || '');
    return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc) ? `isrc:${isrc}` : '';
  }

  function albumBatchSearchKey(track) {
    if (!track || track.manualQuery) return '';
    const album = String(track.album?.name || track.album || track.collectionName || '').trim();
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean)
      : [track.artist || track.artistName || ''];
    const artist = String(artists[0] || '').trim();
    const normalize = window.MusicMatcher.normalizeText;
    const albumKey = normalize(album);
    const artistKey = normalize(artist);
    return albumKey && artistKey ? `album:${albumKey}|artist:${artistKey}` : '';
  }

  function albumBatchTrackCandidates(tracks, candidates) {
    return tracks.map((track) => {
      const suggestion = window.MusicMatcher.suggestBestMatch(track, candidates);
      return suggestion.automatic && suggestion.best ? [suggestion.best] : [];
    });
  }

  async function searchAlbumBatch(provider, tracks, context = {}) {
    const track = tracks[0];
    const album = String(track?.album?.name || track?.album || track?.collectionName || '').trim();
    const artists = Array.isArray(track?.artists)
      ? track.artists.map((artist) => typeof artist === 'string' ? artist : artist?.name || artist?.title).filter(Boolean)
      : [track?.artist || track?.artistName || ''];
    const artist = String(artists[0] || '').trim();
    const action = provider === 'zvuk' ? 'search-tracks' : 'search-album-tracks';
    const details = provider === 'zvuk'
      ? { query: `${album} ${artist}`.trim() }
      : { album, artist, storefront: context.storefront || $('#storefront').value };
    const response = await requestExtensionCommand(action, details, provider === 'apple-music' ? 'apple' : provider);
    if (!response?.ok || !Array.isArray(response.results)) {
      throw targetCommandError(response, `Не удалось пакетно прочитать альбом в каталоге ${provider}.`);
    }
    return albumBatchTrackCandidates(tracks, response.results);
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
    if (response?.report) error.report = response.report;
    return error;
  }

  const appleCatalogAdapter = {
    id: 'apple-music',
    maxConcurrentSearches: 2,
    batchSearchSize: 25,
    canBatchSearch(track, context = {}) {
      return context.accountWrite === true && (Boolean(exactIsrcQuery(track, 'apple-music')) || Boolean(albumBatchSearchKey(track)));
    },
    batchSearchKey(track) {
      return exactIsrcQuery(track, 'apple-music') ? 'apple-isrc-batch' : albumBatchSearchKey(track);
    },
    async searchTracksBatch(tracks, context = {}) {
      if (!tracks.every((track) => exactIsrcQuery(track, 'apple-music'))) return searchAlbumBatch('apple-music', tracks, context);
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
          return (payload.results || []).filter((item) => item.trackId && item.trackViewUrl).slice(0, 15).map((item) => ({
            ...item,
            artworkUrl: item.artworkUrl || item.artworkUrl100 || '',
            releaseDate: item.releaseDate || '',
          }));
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
    batchSearchRequiresGroup: true,
    canBatchSearch(track) { return Boolean(albumBatchSearchKey(track)); },
    batchSearchKey(track) { return albumBatchSearchKey(track); },
    async searchTracksBatch(tracks, context = {}) { return searchAlbumBatch('yandex-music', tracks, context); },
    async searchTracks(track) {
      return searchWithMetadataFallback(track, async (query) => {
        const response = await requestExtensionCommand('search-tracks', { query });
        if (!response?.ok || !Array.isArray(response.results)) throw targetCommandError(response, 'Не удалось получить каталог Яндекс.Музыки.');
        return response.results;
      });
    },
  };

  const zvukCatalogAdapter = {
    id: 'zvuk',
    maxConcurrentSearches: 2,
    batchSearchRequiresGroup: true,
    canBatchSearch(track) { return Boolean(albumBatchSearchKey(track)); },
    batchSearchKey(track) { return albumBatchSearchKey(track); },
    async searchTracksBatch(tracks, context = {}) { return searchAlbumBatch('zvuk', tracks, context); },
    async searchTracks(track) {
      return searchWithMetadataFallback(track, async (query) => {
        const response = await requestExtensionCommand('search-tracks', { query }, 'zvuk');
        if (!response?.ok || !Array.isArray(response.results)) throw targetCommandError(response, 'Не удалось получить каталог Сбер.Звука.');
        return response.results;
      });
    },
  };

  const spotifyCatalogAdapter = {
    id: 'spotify',
    maxConcurrentSearches: 2,
    batchSearchRequiresGroup: true,
    canBatchSearch(track) { return Boolean(albumBatchSearchKey(track)); },
    batchSearchKey(track) { return albumBatchSearchKey(track); },
    async searchTracksBatch(tracks, context = {}) { return searchAlbumBatch('spotify', tracks, context); },
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

  // The catalog adapters expose the album part of the engine contract next to searchTracks().
  for (const adapter of [appleCatalogAdapter, yandexCatalogAdapter, zvukCatalogAdapter, spotifyCatalogAdapter]) {
    const albumTarget = () => window.MusicAlbumMatcher.createAlbumTarget(adapter.id, requestExtensionCommand);
    adapter.searchAlbums = (album, context = {}) => albumTarget().searchAlbums(album, { storefront: context.storefront || $('#storefront').value });
    adapter.writeAlbums = (targets, options = {}) => albumTarget().writeAlbums(targets, options);
    adapter.readDestination = (query = {}) => query.collectionType === 'albums'
      ? albumTarget().readDestination()
      : Promise.reject(new Error('Чтение этой коллекции назначения не подключено.'));
    adapter.readBack = (request) => request?.type === 'albums'
      ? albumTarget().readBack(request)
      : Promise.reject(new Error('Сверка этой коллекции не подключена.'));
  }

  function updateTargetLabel() {
    const labels = { 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс.Музыка', spotify: 'Spotify', zvuk: 'Сбер.Звук' };
    const logoPaths = {
      'apple-music': 'assets/providers/apple-music.png',
      'yandex-music': 'assets/providers/yandex-music.png',
      spotify: 'assets/providers/spotify.png',
      zvuk: 'assets/providers/zvuk.png',
    };
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
    const logoPath = logoPaths[state.targetProvider];
    if (logoPath) {
      const logo = document.createElement('img');
      logo.className = 'provider-logo';
      logo.src = logoPath;
      logo.alt = '';
      providerIcon.replaceChildren(logo);
    } else {
      providerIcon.textContent = '♫';
    }
    providerIcon.dataset.provider = state.targetProvider || '';
    $('#targetProviderName').textContent = label;
    $('#review-heading').textContent = label ? `Сверка с каталогом ${label}` : 'Сверка с каталогом назначения';
    $('#searchBtn').textContent = label ? `Найти в ${label}` : 'Выберите сервис назначения';
    $('#storefront').hidden = state.targetProvider !== 'apple-music';
    $('#storefront').previousElementSibling.hidden = state.targetProvider !== 'apple-music';
    $('#importBtn').innerHTML = ({
      'yandex-music': 'Перенести в Яндекс Музыку <span aria-hidden="true">→</span>',
      'apple-music': 'Перенести в Apple Music <span aria-hidden="true">→</span>',
      zvuk: 'Перенести в Сбер.Звук <span aria-hidden="true">→</span>',
      spotify: 'Перенести в Spotify <span aria-hidden="true">→</span>',
    })[state.targetProvider] || 'Выберите сервис назначения';
    $('#targetCollection').textContent = state.collectionType === 'library'
      ? 'Лайки и плейлисты'
      : state.collectionType === 'playlists' ? 'Плейлисты' : 'Избранные песни';

    const statusElement = $('#targetAccountStatus');
    const targetStatus = state.libraryStatuses[state.targetProvider];
    const targetSnapshot = state.librarySnapshots[state.targetProvider];
    if (!state.targetProvider) {
      statusElement.textContent = 'Выберите сервис назначения.';
    } else if (targetStatus?.status === 'ready' && targetSnapshot) {
      statusElement.textContent = `Аккаунт ${label} доступен · ${targetStatus.trackCount ?? targetSnapshot.tracks?.length ?? 0} лайков · ${targetStatus.playlistCount ?? targetSnapshot.playlists?.length ?? 0} плейлистов.`;
    } else if (targetStatus?.status === 'scanning') {
      statusElement.textContent = targetStatus.message || `Проверяю аккаунт ${label}…`;
    } else if (targetStatus?.status === 'stale') {
      statusElement.textContent = `Снимок ${label} сохранён; обновление не завершено.`;
    } else if (targetStatus?.status === 'unavailable') {
      statusElement.textContent = `${label}: ${targetStatus.message || 'нет подключения'}`;
    } else if (targetSnapshot) {
      statusElement.textContent = `Библиотека ${label} считана.`;
    } else if (state.extensionAvailable) {
      statusElement.textContent = `${label} не найден. Обновите библиотеки.`;
    } else if (state.loaded && state.sourceSnapshot?.completeness?.confirmed !== true) {
      statusElement.textContent = 'Для переноса нужен полный снимок и целевой аккаунт.';
    } else {
      statusElement.textContent = `Войдите в ${label} в Chrome.`;
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
    if (track.searched && !track.searchError) {
      void cache.putSearchResults([track], context.targetProvider, context.storefront, context.accountCatalog);
    }
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
    status.textContent = `Кэш поиска: ${count.toLocaleString('ru-RU')}`;
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

  const albumPageSize = 50;

  function applyAlbumSuggestion(album) {
    const suggestion = window.MusicAlbumMatcher.suggestAlbumMatch(album, album.matches);
    album.match = suggestion.automatic ? suggestion.best : null;
    album.matchConfidence = suggestion.confidence;
    album.matchReason = suggestion.reason;
    album.autoMatched = suggestion.automatic;
    album.userExcluded = false;
    album.selected = suggestion.automatic;
  }

  function resetAlbumMatches() {
    albumPage = 0;
    state.albums.forEach((album) => {
      album.searched = false; album.searchError = false; album.matches = []; album.match = null; album.selected = false;
      album.userExcluded = false; album.autoMatched = false;
    });
  }

  function albumLabel(candidate) {
    const artists = Array.isArray(candidate.artists) && candidate.artists.length ? candidate.artists.join(', ') : candidate.artistName || '';
    const year = String(candidate.releaseDate || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
    return `${artists ? `${artists} — ` : ''}${candidate.title || candidate.name || ''}${candidate.trackCount ? ` · ${candidate.trackCount} тр.` : ''}${year ? ` · ${year}` : ''}`;
  }

  function renderAlbums() {
    const section = $('#albumSection');
    if (!section) return;
    section.hidden = !state.albums.length && !state.albumsSkipped;
    if (section.hidden) {
      $('#albumNotice').hidden = true;
      $('#albumCount').textContent = '0 альбомов';
      $('#albumPageStatus').textContent = '';
      $('#albumPages').hidden = true;
      $('#previousAlbumPage').disabled = true;
      $('#nextAlbumPage').disabled = true;
      $('#albumList').innerHTML = '';
      return;
    }
    $('#albumNotice').hidden = !state.albumsSkipped;
    const pageCount = Math.max(1, Math.ceil(state.albums.length / albumPageSize));
    albumPage = Math.min(albumPage, pageCount - 1);
    const first = albumPage * albumPageSize;
    $('#albumCount').textContent = `${state.albums.length} альбомов`;
    $('#albumPageStatus').textContent = state.albums.length ? `Показаны ${first + 1}–${Math.min(first + albumPageSize, state.albums.length)} из ${state.albums.length}` : '';
    $('#albumPages').hidden = state.albums.length <= albumPageSize;
    $('#previousAlbumPage').disabled = albumPage === 0;
    $('#nextAlbumPage').disabled = albumPage >= pageCount - 1;
    const targetName = providerLabels[state.targetProvider] || state.targetProvider;
    const candidateId = window.MusicAlbumMatcher.candidateId;
    $('#albumList').innerHTML = state.albums.slice(first, first + albumPageSize).map((album, offset) => {
      const index = first + offset;
      const title = escapeHTML(album.title || 'Метаданные недоступны');
      const missingMetadata = !album.title || !(album.artist || album.upc);
      const status = album.searching ? 'Ищем…' : album.searchError ? 'Ошибка поиска' : album.userExcluded ? 'Исключено вами' : missingMetadata ? 'Нужны данные' : album.searched && !album.matches.length ? 'Не найдено' : album.match ? (album.autoMatched ? `${album.matchReason === 'upc_exact' ? 'UPC' : 'Автоматически'} · ${Math.round(album.matchConfidence * 100)}%` : 'Выбрано вручную') : album.searched ? 'Проверьте' : 'Не искали';
      const badgeClass = album.searchError ? 'error' : album.match ? '' : !album.userExcluded && album.searched && album.matches.length ? 'review' : 'pending';
      const options = album.matches.map((match) => `<option value="${escapeHTML(candidateId(match))}" ${album.match && candidateId(album.match) === candidateId(match) ? 'selected' : ''}>${escapeHTML(albumLabel(match))}</option>`).join('');
      const control = album.matches.length
        ? `<select class="album-match" data-album-index="${index}" aria-label="Совпадение ${escapeHTML(targetName)} для альбома ${title}"><option value="">${album.match && album.autoMatched ? 'Автоматическое совпадение · изменить' : 'Выберите издание…'}</option>${options}</select>${album.match ? `<div class="confidence ${album.autoMatched ? '' : 'review'}">${album.autoMatched ? `Автосопоставление · ${Math.round(album.matchConfidence * 100)}%` : 'Выбрано вручную'}</div>` : '<div class="confidence review">Нужно проверить: неоднозначное совпадение</div>'}`
        : `<div class="quiet ${album.searchError ? 'search-error' : ''}">${album.searchError ? escapeHTML(album.errorMessage || 'Повторите поиск') : album.searched ? 'В каталоге ничего не найдено' : 'Результаты появятся здесь'}</div>`;
      const year = String(album.releaseDate || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
      const details = [album.trackCount ? `${album.trackCount} тр.` : '', year, album.upc ? `UPC ${album.upc}` : ''].filter(Boolean).map(escapeHTML).join(' · ');
      const artworkUrl = normalizeArtworkUrl(album.artworkUrl);
      const cover = artworkUrl ? `<img class="cover-image" src="${escapeHTML(artworkUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span aria-hidden="true">◉</span>';
      return `<div class="track album" data-album-index="${index}"><div class="cover" aria-hidden="true">${cover}</div><div><div class="track-name">${title}</div><div class="track-artist">${escapeHTML(album.artist)}</div>${details ? `<div class="track-artist">${details}</div>` : ''}</div><div class="match">${control}<button class="track-search album-search" type="button" data-album-index="${index}" aria-label="Искать совпадение для альбома ${title}" ${state.searching ? 'disabled' : ''}>Искать</button></div><span class="badge ${badgeClass}">${status}</span><input class="album-include" type="checkbox" aria-label="Включить альбом ${title}" data-album-index="${index}" ${album.selected && album.match ? 'checked' : ''} ${album.match ? '' : 'disabled'}></div>`;
    }).join('');
    $$('#albumList .cover-image').forEach((image) => image.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.textContent = '◉';
      fallback.setAttribute('aria-hidden', 'true');
      image.replaceWith(fallback);
    }, { once: true }));
  }

  $('#albumList').addEventListener('change', (event) => {
    const element = event.target;
    const album = state.albums[Number(element.dataset.albumIndex)];
    if (!album) return;
    if (element.classList.contains('album-match')) {
      album.match = album.matches.find((match) => window.MusicAlbumMatcher.candidateId(match) === element.value) || null;
      album.selected = Boolean(album.match);
      album.userExcluded = !album.match;
      album.autoMatched = false;
      album.matchReason = album.match ? 'manual_review' : null;
      album.matchConfidence = album.match ? window.MusicAlbumMatcher.scoreAlbum(album, album.match).score : 0;
    } else if (element.classList.contains('album-include')) {
      album.selected = element.checked;
    } else return;
    state.report = null;
    $('#report').classList.remove('show');
    renderTracks();
  });
  $('#albumList').addEventListener('click', (event) => {
    const button = event.target.closest?.('.album-search');
    if (!button || state.searching) return;
    void searchOneAlbum(state.albums[Number(button.dataset.albumIndex)]);
  });
  $('#previousAlbumPage').addEventListener('click', () => { albumPage = Math.max(0, albumPage - 1); renderAlbums(); $('#albumSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  $('#nextAlbumPage').addEventListener('click', () => { albumPage += 1; renderAlbums(); $('#albumSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });

  async function requestAlbumMatches(album, signal = null) {
    album.searching = true;
    album.searchError = false;
    album.matches = [];
    album.match = null;
    album.selected = false;
    album.userExcluded = false;
    try {
      let candidates;
      for (let attempt = 0; ; attempt += 1) {
        try {
          candidates = await targetAdapter().searchAlbums(album, { storefront: $('#storefront').value });
          break;
        } catch (error) {
          const retriable = error?.status === 429 || error?.status >= 500;
          if (!retriable || attempt >= 3 || signal?.aborted) throw error;
          const retryAfter = Number(error.retryAfter);
          await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1500 * (attempt + 1)));
        }
      }
      album.matches = candidates;
      album.searched = true;
      applyAlbumSuggestion(album);
    } catch (error) {
      album.searched = false;
      album.searchError = true;
      album.matches = [];
      album.errorMessage = error instanceof TypeError ? 'Каталог недоступен. Проверьте соединение и повторите поиск.' : error.message;
    } finally {
      album.searching = false;
    }
  }

  async function searchOneAlbum(album) {
    if (!album || state.searching) return;
    state.searching = true;
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchStatus').textContent = `Ищем альбом: ${album.title}`;
    renderTracks();
    await requestAlbumMatches(album);
    state.searching = false;
    $('#searchStatus').textContent = album.searchError ? 'Поиск альбома не удался — повторите' : album.matches.length ? `Изданий найдено: ${album.matches.length}` : 'Альбом в каталоге не найден';
    renderTracks();
  }

  async function searchAlbumsCatalog(controller) {
    const pending = state.albums.filter((album) => (!album.searched || album.searchError) && album.title && (album.artist || album.upc));
    if (!pending.length) return;
    let done = 0;
    let cursor = 0;
    const label = providerLabels[state.targetProvider] || state.targetProvider;
    const worker = async () => {
      while (cursor < pending.length && !controller.signal.aborted) {
        const album = pending[cursor];
        cursor += 1;
        await requestAlbumMatches(album, controller.signal);
        done += 1;
        $('#searchStatus').textContent = `Альбомы в каталоге ${label}: ${done} из ${pending.length}`;
        if (done % 10 === 0 || done === pending.length) renderTracks();
      }
    };
    await Promise.all([worker(), worker()]);
    if (controller.signal.aborted) throw new DOMException('Поиск отменён', 'AbortError');
  }

  async function searchCatalog() {
    if (!state.loaded || !state.targetProvider || state.searching || state.tracks.some((track) => track.searching) || state.albums.some((album) => album.searching)) return;
    const controller = new AbortController();
    activeSearchController = controller;
    state.searching = true;
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchBtn').textContent = 'Идёт поиск…';
    $('#searchStatus').classList.remove('search-error');
    setStep(3);
    const pending = state.tracks.filter((track) => (!track.searched || track.searchError)
      && (track.query || track.title || track.artist || track.isrc));
    let completed = state.tracks.length - pending.length;
    let cachedCount = 0;
    let searchResultWriter = null;
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
      searchResultWriter = window.MusicMatchCache?.createBatchWriter(
        (tracks) => window.MusicMatchCache.putSearchResults(tracks, state.targetProvider, $('#storefront').value,
          state.sourceSnapshot?.completeness?.confirmed === true),
        100,
      ) || null;
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
        onRequestStart: ({ completed: finishedGroups, total }) => {
          const labels = { 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс.Музыки', spotify: 'Spotify', zvuk: 'Сбер.Звука' };
          $('#searchStatus').textContent = `Ищем в каталоге ${labels[state.targetProvider] || state.targetProvider}: обработано ${completed} из ${state.tracks.length} · запросы ${finishedGroups} из ${total}`;
        },
        onRetry: ({ status, attempt, maxRetries, delayMs }) => {
          const labels = { 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс.Музыка', spotify: 'Spotify', zvuk: 'Сбер.Звук' };
          const seconds = Math.ceil(delayMs / 1000);
          $('#searchStatus').textContent = `${labels[state.targetProvider] || state.targetProvider}: HTTP ${status || 'network'}; повтор ${attempt}/${maxRetries} через ${seconds} с · обработано ${completed} из ${state.tracks.length}`;
        },
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
          try { await searchResultWriter?.enqueue(group.tracks); }
          catch { /* Keep catalog matching usable if browser storage is unavailable. */ }
          completed += group.tracks.length;
          $('#searchStatus').textContent = `${completed} из ${state.tracks.length}`;
          if (completed % (trackPageSize * 2) < group.tracks.length || completed >= state.tracks.length) renderTracks();
        },
      });
      await searchAlbumsCatalog(controller);
      const withResults = state.tracks.filter((track) => track.searched && track.matches.length).length;
      const failed = state.tracks.filter((track) => track.searchError).length + state.albums.filter((album) => album.searchError).length;
      const albumsFound = state.albums.filter((album) => album.searched && album.matches.length).length;
      const missingMetadataCount = state.tracks.filter((track) => track.metadataComplete === false && !track.title && !track.artist).length;
      const resultStatus = failed ? `Найдено: ${withResults} · ошибок: ${failed}` : `Найдено: ${withResults} из ${state.tracks.length}`;
      $('#searchStatus').textContent = `${resultStatus}${state.albums.length ? ` · альбомы: ${albumsFound} из ${state.albums.length}` : ''}${missingMetadataCount ? ` · без метаданных: ${missingMetadataCount}` : ''}${accountLibraryCount ? ` · уже в аккаунте: ${accountLibraryCount}` : ''}${cachedCount ? ` · из локального кэша: ${cachedCount}` : ''}`;
      $('#searchStatus').classList.toggle('search-error', failed > 0);
      setStep(4);
      toast(failed ? 'Часть запросов не прошла — можно повторить' : `Совпадений в каталоге: ${withResults}`);
      void updateMatchCacheStatus();
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      const message = aborted
        ? 'Поиск остановлен. Завершённые результаты сохранены; следующий запуск продолжит с оставшихся треков.'
        : error?.message || 'Массовый поиск прервался. Повторите поиск для оставшихся треков.';
      for (const track of [...state.tracks, ...state.albums]) {
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
      try { await searchResultWriter?.flush(); }
      catch { /* Completed catalog results remain usable when local caching fails. */ }
      state.searching = false;
      if (activeSearchController === controller) activeSearchController = null;
      const labels = { 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс.Музыке', spotify: 'Spotify', zvuk: 'Сбер.Звуке' };
      $('#searchBtn').textContent = `Найти в ${labels[state.targetProvider] || state.targetProvider}`;
      renderTracks();
    }
  }

  $('#cancelSearchBtn').addEventListener('click', () => activeSearchController?.abort());

  function buildPlan() {
    const plan = window.MusicTransferCore.createTransferPlan({
      sourceSnapshot: state.sourceSnapshot,
      targetProvider: state.targetProvider,
      targetCollectionType: state.sourceCollectionScope === 'albums' ? 'albums' : state.collectionType,
      targetCollectionName: state.sourceCollectionScope === 'albums' ? 'Альбомы' : state.sourceCollectionScope === 'favorites' || state.collectionType === 'favorites' ? 'Любимые песни' : state.collectionType === 'library' ? 'Любимое, альбомы и плейлисты' : 'Плейлисты',
      storefront: state.targetProvider === 'apple-music' ? $('#storefront').value : null,
      tracks: state.tracks,
      albums: state.albums,
    });
    const nameOverride = $('#targetPlaylistName').value.trim();
    if (nameOverride && state.sourceCollectionScope.startsWith('playlist:')) {
      if (nameOverride.length > 100) throw new Error('Название плейлиста должно быть не длиннее 100 символов.');
      plan.collectionMappings = plan.collectionMappings.map((mapping) => ({ ...mapping, targetName: nameOverride }));
    }
    return plan;
  }

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
    $('#transferJobDetails').textContent = `${source} → ${target} · ${job.operationCount} записей${job.albumCount ? ` (альбомов: ${job.albumCount})` : ''} · ${job.playlistCount} плейлистов.${progress}${outcome}`;
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
      if (!['apple-music', 'yandex-music', 'zvuk', 'spotify'].includes(job.targetProvider)) throw new Error('Сервис назначения сохранённой операции неизвестен.');
      const response = await window.MusicAlbumMatcher.executePlanOnTarget(job.targetProvider, plan, requestExtensionCommand, (progress) => window.MusicTransferJobStore.updateProgress(job.id, progress));
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

  function queueProviderRetry(provider) {
    if (!provider) return;
    pendingProviderRetries.add(provider);
    state.libraryStatuses[provider] = {
      ...state.libraryStatuses[provider],
      status: state.libraryStatuses[provider]?.status === 'stale' ? 'stale' : 'failed',
      message: `Повтор ${sourceLabels[provider]} поставлен в очередь после текущего сбора.`,
    };
    renderSourceAvailability();
    toast(`Повтор ${sourceLabels[provider]} запустится после текущего сбора.`);
  }

  $$('.source .connect').forEach((button) => button.addEventListener('click', () => {
    if (state.searching || state.tracks.some((track) => track.searching)) {
      toast('Остановите поиск перед сменой источника.');
      return;
    }
    const card = button.closest('.source');
    const provider = card.dataset.provider;
    const action = window.MusicProviderConnectionFlow.sourceAction({
      extensionAvailable: state.extensionAvailable,
      snapshot: sourceSnapshotForProvider(provider),
      status: state.libraryStatuses[provider],
      providerName: sourceLabels[provider],
      selected: card.classList.contains('selected'),
      opening: state.openingProviderTabs.has(provider),
      queued: pendingProviderRetries.has(provider),
    });
    if (provider && sourceSnapshotForProvider(provider)) {
      selectProviderSnapshot(provider);
      return;
    }
    if (action.action === 'retry') {
      if (accountScanInProgress) {
        queueProviderRetry(provider);
        return;
      }
      void scanOpenAccounts(false, [provider]);
      return;
    }
    void openProviderLogin(provider);
  }));

  $$('.source .source-retry').forEach((button) => button.addEventListener('click', () => {
    const provider = button.closest('.source')?.dataset.provider;
    if (!provider || button.disabled || state.searching || state.tracks.some((track) => track.searching)) return;
    if (accountScanInProgress) {
      queueProviderRetry(provider);
      return;
    }
    void scanOpenAccounts(false, [provider]);
  }));

  $('#loadBtn').addEventListener('click', () => loadTracks(demoTracks, 'Демо-данные', { provider: 'file' }));
  $('#uploadFileBtn').addEventListener('click', () => {
    if (!$('#uploadFileBtn').disabled) $('#fileInput').click();
  });
  $('#fileInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      let label = file.name;
      let tracks;
      let payload = null;
      const sourceLabels = { zvuk: 'Сбер.Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс.Музыка', 'apple-music': 'Apple Music' };
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
        ...(() => { const scope = window.MusicAlbumMatcher.albumsForScope(payload, 'all'); return { albums: scope.albums, albumsSkipped: scope.skipped }; })(),
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

  function requestOpenProviderTabs(providerIds = null, focusProviderId = null) {
    if (!window.crypto?.randomUUID) return Promise.reject(new Error('Этот браузер не поддерживает запуск вкладок сервисов.'));
    const requestId = window.crypto.randomUUID();
    if (extensionApp) {
      return chrome.runtime.sendMessage({ type: 'music-importer:open-provider-tabs', providerIds, focusProviderId })
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
      window.postMessage({ source: 'music-importer-local-app', type: 'open-provider-tabs', requestId, providerIds, focusProviderId }, location.origin);
    });
  }

  async function openProviderLogin(provider) {
    if (!state.extensionAvailable || !sourceLabels[provider]) return;
    if (state.searching || state.tracks.some((track) => track.searching)) {
      toast('Остановите поиск перед подключением аккаунта.');
      return;
    }
    state.pendingLoginProviders.add(provider);
    state.openingProviderTabs.add(provider);
    renderSourceAvailability();
    try {
      const response = await requestOpenProviderTabs([provider], provider);
      if (!response?.ok) throw new Error(response?.error || `Не удалось открыть ${sourceLabels[provider]}.`);
      const opened = (response.opened || []).includes(provider);
      $('#extensionStatus').textContent = opened
        ? `Открыл ${sourceLabels[provider]}. Войдите и вернитесь.`
        : `${sourceLabels[provider]} уже открыт. Войдите и вернитесь.`;
      toast(opened ? `Открыт ${sourceLabels[provider]} для входа` : `${sourceLabels[provider]} уже открыт`);
    } catch (error) {
      state.pendingLoginProviders.delete(provider);
      $('#extensionStatus').textContent = error.message || `Не удалось открыть ${sourceLabels[provider]}.`;
      toast(error.message || `Не удалось открыть ${sourceLabels[provider]}.`);
    } finally {
      state.openingProviderTabs.delete(provider);
      renderSourceAvailability();
    }
  }

  async function openMissingServices() {
    const button = $('#openServicesBtn');
    if (!state.extensionAvailable) return;
    button.disabled = true;
    try {
      const sourceProvider = state.sourceSnapshot?.provider || (state.loaded ? state.sourceProvider : '');
      const supportedProviders = new Set(['zvuk', 'spotify', 'yandex-music', 'apple-music']);
      const selectedProviders = [...new Set([sourceProvider, state.targetProvider].filter((provider) => supportedProviders.has(provider)))];
      const response = await requestOpenProviderTabs(selectedProviders.length ? selectedProviders : null);
      if (!response?.ok) throw new Error(response?.error || 'Не удалось открыть сервисы.');
      const names = { zvuk: 'Сбер.Звук', spotify: 'Spotify', 'yandex-music': 'Яндекс.Музыка', 'apple-music': 'Apple Music' };
      const opened = (response.opened || []).map((id) => names[id] || id);
      const alreadyOpen = (response.alreadyOpen || []).map((id) => names[id] || id);
      $('#extensionStatus').textContent = opened.length
        ? `Открыты: ${opened.join(', ')}. Уже открыты: ${alreadyOpen.join(', ') || 'нет'}.`
        : `Уже открыты: ${alreadyOpen.join(', ') || 'нет'}.`;
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
    updatePrivacyControls();
    button.disabled = true;
    button.textContent = 'Обновить библиотеки';
    $('#extensionStatus').textContent = automatic
      ? 'Проверяю библиотеки…'
      : 'Обновляю библиотеки…';
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    let providersBeingRefreshed = refreshProviders;
    try {
      let response;
      if (automatic && refreshProviders === null) {
        response = await requestAllLibraries(false);
        applyLibraryResponse(response);
        renderSourceAvailability(response.statuses || {});
        const providers = ['zvuk', 'spotify', 'yandex-music', 'apple-music'];
        const providersToRefresh = providers.filter((provider) => {
          const snapshot = state.librarySnapshots[provider];
          const status = state.libraryStatuses[provider];
          if (status?.status === 'scanning') return false;
          if (!snapshot || ['failed', 'unavailable', 'stale'].includes(status?.status)) return true;
          return window.MusicLibraryCache.evaluate({ cachedSnapshot: snapshot, lastCheckedAt: snapshot.snapshotCachedAt || snapshot.exportedAt }) !== 'fresh';
        });
        const automaticProviders = window.MusicProviderConnectionFlow.providersForAutomaticRefresh(providersToRefresh, state.pendingLoginProviders);
        if (automaticProviders.length) {
          providersBeingRefreshed = automaticProviders;
          response = await requestAllLibraries(true, providersBeingRefreshed);
        }
      } else {
        response = await requestAllLibraries(true, providersBeingRefreshed);
      }
      while (response.pending && Date.now() < deadline) {
        applyLibraryResponse(response);
        renderSourceAvailability(response.statuses || {});
        const running = Object.entries(response.statuses || {}).filter(([, status]) => status.status === 'scanning');
        button.textContent = 'Обновить библиотеки';
        $('#extensionStatus').textContent = running.length
          ? `Сбор: ${running.length} ${running.length === 1 ? 'сервис' : 'сервисов'}`
          : 'Проверка…';
        await new Promise((resolve) => setTimeout(resolve, 2000));
        response = await requestAllLibraries(false, providersBeingRefreshed);
      }
      if (response.pending) throw new Error('Сбор ещё выполняется. Библиотеки можно будет выбрать после завершения.');
      if (response.error) throw new Error(response.error);
      applyLibraryResponse(response);
      renderSourceAvailability(response.statuses || {});
      for (const provider of state.pendingLoginProviders) {
        if (response.statuses?.[provider]?.status === 'ready' && state.librarySnapshots[provider]) {
          state.pendingLoginProviders.delete(provider);
        }
      }
      const availableProviders = new Set([...Object.keys(state.librarySnapshots), ...Object.keys(state.partialLibraries)]);
      const connected = [...availableProviders].filter((provider) => response.libraries?.[provider]
        || response.partialLibraries?.[provider]
        || ['ready', 'stale'].includes(response.statuses?.[provider]?.status));
      if (!connected.length) {
        const details = Object.entries(response.statuses || {}).map(([provider, status]) => `${sourceLabels[provider]}: ${status.message || 'недоступен'}`).join(' · ');
        throw new Error(details || 'Не нашёл открытых библиотек. Войдите в музыкальные сервисы в Chrome и повторите.');
      }
      const selectedProvider = connected.includes(state.sourceProvider) ? state.sourceProvider : connected[0];
      selectProviderSnapshot(selectedProvider);
      const unavailable = Object.values(response.statuses || {}).filter((status) => status.status === 'unavailable').length;
      const failed = Object.values(response.statuses || {}).filter((status) => status.status === 'failed').length;
      const stale = Object.values(response.statuses || {}).filter((status) => status.status === 'stale').length;
      const partialCount = connected.filter((provider) => state.partialLibraries[provider] && !state.librarySnapshots[provider]).length;
      $('#extensionStatus').textContent = `${connected.length} из 4${partialCount ? ` · частичный снимок: ${partialCount}` : ''}${stale ? ` · устарел: ${stale}` : ''}${failed ? ` · ошибка: ${failed}` : ''}${unavailable ? ` · нет сессии: ${unavailable}` : ''}`;
      if (!automatic || connected.length) {
        if (stale) toast(`Доступно библиотек: ${connected.length}; часть снимков не обновилась`);
        else if (failed) toast(`Загружено библиотек: ${connected.length}; часть сервисов не смогла прочитать аккаунт`);
        else if (unavailable) toast(`Загружено библиотек: ${connected.length}; часть сервисов не подключена`);
        else toast(`Загружены библиотеки всех ${connected.length} аккаунтов`);
      }
    } catch (error) {
      $('#extensionStatus').textContent = error.message || 'Не удалось загрузить открытые библиотеки.';
      if (!automatic) toast(error.message || 'Не удалось получить данные из расширения.');
    } finally {
      accountScanInProgress = false;
      button.disabled = false;
      button.textContent = 'Обновить библиотеки';
      updatePrivacyControls();
      const nextRetry = pendingProviderRetries.values().next().value;
      if (nextRetry) {
        pendingProviderRetries.delete(nextRetry);
        setTimeout(() => { void scanOpenAccounts(false, [nextRetry]); }, 0);
      }
      if (focusScanQueued) {
        focusScanQueued = false;
        scheduleFocusRefresh();
      }
    }
  }

  function scheduleFocusRefresh() {
    if (!state.extensionAvailable || document.visibilityState !== 'visible') return;
    const providers = window.MusicProviderConnectionFlow.providersForAutomaticRefresh(window.MusicProviderConnectionFlow.providersForFocusRefresh(
      ['zvuk', 'spotify', 'yandex-music', 'apple-music'],
      state.librarySnapshots,
      state.libraryStatuses,
      state.pendingLoginProviders,
    ), state.pendingLoginProviders);
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
    if (!state.extensionAvailable || document.visibilityState !== 'visible') return;
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
    if (state.searching || state.tracks.some((track) => track.searching) || state.albums.some((album) => album.searching)) return;
    state.targetProvider = $('#targetProvider').value;
    trackPage = 0;
    state.tracks.forEach((track) => { track.searched = false; track.searchError = false; track.matches = []; track.match = null; track.selected = false; });
    resetAlbumMatches();
    state.report = null;
    $('#report').classList.remove('show');
    updateTargetLabel();
    $('#searchStatus').textContent = state.targetProvider
      ? 'Проверьте выбранный список и запустите поиск кнопкой выше или для отдельного трека.'
      : state.loaded ? 'Выберите сервис назначения, отличный от источника.' : 'Сначала выберите сервис назначения';
    renderTracks();
  });
  $('#storefront').addEventListener('change', () => {
    if (!state.loaded || state.searching || state.tracks.some((track) => track.searching)) return;
    trackPage = 0;
    state.tracks.forEach((track) => { track.searched = false; track.searchError = false; track.matches = []; track.match = null; track.selected = false; });
    resetAlbumMatches();
    state.report = null;
    $('#report').classList.remove('show');
    $('#searchStatus').textContent = 'Страна каталога изменена; обновляю совпадения…';
    renderTracks();
    if (state.targetProvider) void searchCatalog();
  });

  $('#toggleAll').addEventListener('click', () => {
    const shouldSelect = !state.tracks.some((track) => track.selected && track.match) && !state.albums.some((album) => album.selected && album.match);
    state.tracks.forEach((track) => { track.selected = shouldSelect && Boolean(track.match); });
    state.albums.forEach((album) => { album.selected = shouldSelect && Boolean(album.match); });
    const context = matchCacheContext();
    void window.MusicMatchCache?.putDecisions(state.tracks.filter((track) => track.match), context.targetProvider, (track) => ({
      selected: Boolean(shouldSelect && track.match),
      trackId: track.match?.trackId || null,
    }), context.storefront, context.accountCatalog, context.sourceProvider);
    state.report = null;
    $('#report').classList.remove('show');
    renderTracks();
  });

  $('#trackStatusFilter').addEventListener('change', () => {
    trackPage = 0;
    renderTracks();
  });
  $('#trackSort').addEventListener('change', () => {
    trackPage = 0;
    renderTracks();
  });
  $('#selectVisibleMatches').addEventListener('click', () => {
    const start = trackPage * trackPageSize;
    const visibleMatches = filteredTrackEntries().slice(start, start + trackPageSize)
      .map(({ track }) => track).filter((track) => track.match);
    const shouldSelect = visibleMatches.some((track) => !track.selected);
    visibleMatches.forEach((track) => { track.selected = shouldSelect; });
    const context = matchCacheContext();
    void window.MusicMatchCache?.putDecisions(visibleMatches, context.targetProvider, (track) => ({
      selected: Boolean(shouldSelect && track.match),
      trackId: track.match?.trackId || null,
    }), context.storefront, context.accountCatalog, context.sourceProvider);
    state.report = null;
    $('#report').classList.remove('show');
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
    state.albums = [];
    state.albumsSkipped = false;
    albumPage = 0;
    trackPage = 0;
    state.loaded = false;
    state.report = null;
    $('#trackStatusFilter').value = 'all';
    $('#trackSort').value = 'source';
    $('#report').classList.remove('show');
    $('#searchStatus').textContent = 'Поиск не запускался';
    $('#reviewSub').textContent = 'Загрузите список и найдите версии песен';
    setStep(1);
    renderTracks();
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
        const summary = window.MusicAlbumMatcher.albumPlanSummary(plan);
        const providerName = ({ 'apple-music': 'Apple Music', 'yandex-music': 'Яндекс.Музыка', zvuk: 'Сбер.Звук', spotify: 'Spotify' })[state.targetProvider] || state.targetProvider;
        const playlistNames = plan.collectionMappings.map((mapping) => `«${mapping.targetName}»`).join(', ');
        if (!window.confirm(`Записать в ${providerName}: лайки — ${summary.likes}, альбомы — ${summary.albums} (целыми альбомами, без разворачивания в треки), плейлисты — ${playlistCount}${playlistNames ? ` ${playlistNames}` : ''} (треков в них: ${summary.playlistItems})? Это изменит аккаунт. После записи приложение сверит лайки, альбомы, треки и порядок.`)) return;
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
          albumCount: summary.albums,
          playlistCount,
          recoveryPlan: plan,
        });
        if (!jobStarted) throw new Error('Не удалось надёжно сохранить начало переноса на этом устройстве. Запись в музыкальный аккаунт не запускалась.');
        $('#importBtn').textContent = 'Записываем и сверяем…';
        let response;
        try {
          response = await window.MusicAlbumMatcher.executePlanOnTarget(state.targetProvider, plan, requestExtensionCommand, (progress) => window.MusicTransferJobStore.updateProgress(transferJobId, progress));
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
            const partialAlbums = Number(response.report?.albums?.verified || 0);
            const partialPlaylists = (response.report?.playlists || []).reduce((sum, playlist) => sum + Number(playlist.verified || 0), 0);
            showReportBreakdown(partialFavorites, partialAlbums, partialPlaylists);
            $('#addedMetric').textContent = String(partialFavorites + partialAlbums + partialPlaylists);
            $('#skippedMetric').textContent = String(plan.skipped.length);
            $('#report').querySelector('h3').textContent = response.report.status === 'partial_failure'
              ? 'Перенос остановлен · нужна сверка'
              : 'Перенос не выполнен';
            $('#report').querySelector('.report-grid .metric:last-child b').textContent = String(partialFavorites + partialAlbums + partialPlaylists);
            $('#report').querySelector('.report-grid .metric:last-child span').textContent = `проверено в ${providerName}`;
            $('#report').classList.add('show');
            setStep(5);
          }
          throw new Error(response?.error || `Перенос в ${providerName} не выполнен.`);
        }
        state.report = { ...plan, mode: 'account-write', execution: response.report || { status: 'complete' } };
        const verifiedFavorites = Number(response.report?.favorites?.verified || 0);
        const verifiedAlbums = Number(response.report?.albums?.verified || 0);
        const verifiedPlaylists = (response.report?.playlists || []).reduce((sum, playlist) => sum + Number(playlist.verified || 0), 0);
        showReportBreakdown(verifiedFavorites, verifiedAlbums, verifiedPlaylists);
        $('#addedMetric').textContent = verifiedFavorites + verifiedAlbums + verifiedPlaylists;
        $('#skippedMetric').textContent = plan.skipped.length;
        $('#report').querySelector('h3').textContent = 'Перенос завершён и сверен';
        $('#report').querySelector('.report-grid .metric:last-child b').textContent = String(verifiedFavorites + verifiedAlbums + verifiedPlaylists);
        $('#report').querySelector('.report-grid .metric:last-child span').textContent = `подтверждено в ${providerName}`;
        $('#report').classList.add('show');
        setStep(5);
        toast(`${providerName} подтвердила запись`);
      } else {
        state.report = plan;
        const planSummary = window.MusicAlbumMatcher.albumPlanSummary(plan);
        $('#reportBreakdown').textContent = `Лайки: ${planSummary.likes} · Альбомы: ${planSummary.albums} · Плейлисты: ${planSummary.playlists} (треков: ${planSummary.playlistItems})`;
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

  // Likes, albums and playlists are reported separately so album writes never read as tracks.
  function showReportBreakdown(likes, albums, playlistItems) {
    $('#reportBreakdown').textContent = `Лайки: ${likes} · Альбомы: ${albums} · Плейлисты (треков): ${playlistItems}`;
  }

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
    toast('Кэш поиска очищен');
  });

  $('#clearLibrarySnapshots')?.addEventListener('click', async () => {
    if (!extensionApp || !state.extensionAvailable) {
      toast('Откройте Music Importer значком расширения, чтобы удалить сохранённые снимки.');
      return;
    }
    if (accountScanInProgress || state.transferInProgress) {
      toast('Дождитесь завершения текущей операции.');
      return;
    }
    const unresolved = await window.MusicTransferJobStore?.latestUnresolved() || state.unresolvedTransferJob;
    if (unresolved) {
      toast('Сначала завершите перенос или подтвердите сверку незавершённого задания.');
      return;
    }
    if (!window.confirm('Удалить сохранённые снимки лайков и плейлистов из профиля Chrome? Аккаунты музыкальных сервисов не изменятся. Для нового переноса запустите «Обновить библиотеки».')) return;
    const button = $('#clearLibrarySnapshots');
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'music-importer:clear-library-snapshots' });
      if (!response?.ok) throw new Error(response?.error || 'Не удалось удалить снимки библиотек.');
      state.librarySnapshots = {};
      state.partialLibraries = {};
      state.libraryStatuses = {};
      state.sourceSnapshot = null;
      state.sourceProvider = '';
      state.source = '';
      state.tracks = [];
      state.albums = [];
      state.albumsSkipped = false;
      state.loaded = false;
      state.report = null;
      $$('.source').forEach((card) => card.classList.remove('selected'));
      $('[aria-labelledby="source-heading"] .count').textContent = `0 из ${$$('.source').length}`;
      $('#report').classList.remove('show');
      renderSourceAvailability({});
      renderTracks();
      updateCounts();
      $('#extensionStatus').textContent = 'Снимки удалены';
      $('#extensionImportBtn').disabled = false;
      $('#extensionImportBtn').textContent = 'Обновить библиотеки';
      toast('Снимки удалены');
    } catch (error) {
      toast(error.message || 'Не удалось удалить снимки библиотек.');
    } finally {
      updatePrivacyControls();
    }
  });

  updateCounts();
  updateTargetLabel();
  void updateMatchCacheStatus();
})();
