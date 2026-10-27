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
  const state = { source: 'Звук', tracks: [], loaded: false, report: null, searching: false };
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
    $('#importBtn').disabled = selected === 0 || state.searching;
    $('#searchBtn').disabled = !state.loaded || state.searching;
    $('#toggleAll').textContent = selected ? 'Снять выбор со всех' : 'Выбрать совпадения';
  }

  function renderTracks() {
    if (!state.tracks.length) {
      $('#trackList').innerHTML = '<div class="empty">Загрузите пример или свой список треков</div>';
      updateCounts();
      return;
    }

    $('#trackList').innerHTML = state.tracks.map((track, index) => {
      const title = escapeHTML(track.title);
      const artist = escapeHTML(track.artist);
      const status = track.searching ? 'Ищем…' : track.searchError ? 'Ошибка поиска' : track.searched && !track.matches.length ? 'Не найдено' : track.match ? 'Выбрано' : track.searched ? 'Проверьте' : 'Не искали';
      const badgeClass = track.searchError ? 'error' : track.match ? '' : track.searched && track.matches.length ? 'review' : 'pending';
      const options = track.matches.map((match) => `<option value="${match.trackId}" ${track.match?.trackId === match.trackId ? 'selected' : ''}>${escapeHTML(match.artistName)} — ${escapeHTML(match.trackName)}${match.collectionName ? ` · ${escapeHTML(match.collectionName)}` : ''}</option>`).join('');
      const matchControl = `<input class="track-query" data-index="${index}" aria-label="Поисковый запрос для ${title}" value="${escapeHTML(track.query || `${track.title} ${track.artist}`)}" ${state.searching ? 'disabled' : ''}><button class="track-search" type="button" data-index="${index}" ${state.searching ? 'disabled' : ''}>Искать</button>${track.matches.length ? `<select class="track-match" data-index="${index}" aria-label="Совпадение Apple Music для ${title}"><option value="">Выберите версию…</option>${options}</select>${track.match ? `<a href="${escapeHTML(track.match.trackViewUrl)}" target="_blank" rel="noopener noreferrer">Открыть в Apple Music ↗</a>` : '<div class="confidence review">Просмотрите результаты и выберите версию</div>'}` : `<div class="quiet ${track.searchError ? 'search-error' : ''}">${track.searchError ? (track.errorMessage || 'Повторите поиск') : track.searched ? 'В каталоге ничего не найдено' : 'Результаты появятся здесь'}</div>`}`;
      return `<div class="track" data-index="${index}"><div class="cover" aria-hidden="true">♫</div><div><div class="track-name">${title}</div><div class="track-artist">${artist}</div>${track.album ? `<div class="track-artist">${escapeHTML(track.album)}</div>` : ''}</div><div class="match">${matchControl}</div><span class="badge ${badgeClass}">${status}</span><input class="include" type="checkbox" aria-label="Включить ${title}" data-index="${index}" ${track.selected && track.match ? 'checked' : ''} ${track.match ? '' : 'disabled'}></div>`;
    }).join('');

    $$('.track-match').forEach((select) => select.addEventListener('change', () => {
      const track = state.tracks[Number(select.dataset.index)];
      track.match = track.matches.find((match) => String(match.trackId) === select.value) || null;
      track.selected = Boolean(track.match);
      state.report = null;
      $('#report').classList.remove('show');
      renderTracks();
    }));
    $$('.track-query').forEach((input) => input.addEventListener('input', () => {
      state.tracks[Number(input.dataset.index)].query = input.value;
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

  function loadTracks(list, label) {
    state.tracks = list.map((track) => ({
      ...track,
      query: `${track.title} ${track.artist}`.trim(),
      matches: [],
      match: null,
      selected: false,
      searched: false,
      searching: false,
      searchError: false,
    }));
    state.source = label;
    state.loaded = true;
    state.report = null;
    $('#report').classList.remove('show');
    $('#reviewSub').textContent = `${label} · ${list.length} треков готовы к поиску`;
    $('#searchStatus').textContent = 'Поиск не запускался';
    $('#searchStatus').classList.remove('search-error');
    renderTracks();
    setStep(2);
    $('#reviewCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(`Загружено треков: ${list.length}`);
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
    if (titleIndex < 0 || artistIndex < 0) throw new Error('Нужны столбцы title и artist (или название и исполнитель)');
    return rows.map((values) => ({ title: values[titleIndex]?.trim(), artist: values[artistIndex]?.trim(), album: albumIndex < 0 ? '' : values[albumIndex]?.trim() })).filter((track) => track.title && track.artist);
  }

  function normalizeJSON(value) {
    const root = Array.isArray(value) ? value : value?.tracks || value?.items || value?.data;
    if (!Array.isArray(root)) throw new Error('Ожидается массив треков или поле tracks/items/data');
    return root.map((row) => {
      const track = row?.track || row;
      const artist = track?.artist || track?.artists || track?.performer || track?.artistName || track?.artist_name || track?.artist_names;
      return {
        title: String(track?.title || track?.name || track?.trackName || track?.track_name || ''),
        artist: Array.isArray(artist) ? artist.map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean).join(', ') : String(artist || ''),
        album: String((typeof track?.album === 'object' ? track.album?.name : track?.album) || track?.albumName || track?.album_name || ''),
      };
    }).filter((track) => track.title && track.artist);
  }

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    renderTracks();
    const params = new URLSearchParams({ term: (track.query || `${track.title} ${track.artist}`).trim(), entity: 'song', limit: '15', country: $('#storefront').value });
    try {
      const response = await fetch(`https://itunes.apple.com/search?${params.toString()}`);
      if (!response.ok) throw new Error(`Каталог ответил ${response.status}`);
      const payload = await response.json();
      track.matches = (payload.results || []).filter((item) => item.trackId && item.trackViewUrl).slice(0, 15);
      track.searched = true;
      track.searchError = false;
      track.match = null;
      track.selected = false;
    } catch (error) {
      track.searched = false;
      track.searchError = true;
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
      for (const track of pending) {
        await requestTrackMatches(track);
        completed += 1;
        $('#searchStatus').textContent = `${completed} из ${state.tracks.length}`;
        renderTracks();
        await wait(180);
      }
      const withResults = state.tracks.filter((track) => track.searched && track.matches.length).length;
      const failed = state.tracks.filter((track) => track.searchError).length;
      $('#searchStatus').textContent = failed ? `Найдено: ${withResults} · ошибок: ${failed}` : `Найдено: ${withResults} из ${state.tracks.length}`;
      $('#searchStatus').classList.toggle('search-error', failed > 0);
      setStep(4);
      toast(failed ? 'Часть запросов не прошла — можно повторить' : `Совпадений в каталоге: ${withResults}`);
    } finally {
      state.searching = false;
      $('#searchBtn').textContent = 'Найти совпадения';
      renderTracks();
    }
  }

  function buildPlan() {
    const selected = state.tracks.filter((track) => track.selected && track.match);
    const skipped = state.tracks.filter((track) => !selected.includes(track));
    return {
      schemaVersion: 1,
      mode: 'preview-only',
      createdAt: new Date().toISOString(),
      source: state.source,
      target: { service: 'Apple Music', collection: 'favorite songs', storefront: $('#storefront').value },
      search: { service: 'Apple iTunes Search API', writesPerformed: 0 },
      selected: selected.map((track) => ({
        source: { title: track.title, artist: track.artist, album: track.album || null },
        target: {
          trackId: track.match.trackId,
          title: track.match.trackName,
          artist: track.match.artistName,
          album: track.match.collectionName || null,
          url: track.match.trackViewUrl,
          artworkUrl: track.match.artworkUrl100 || null,
          durationMs: track.match.trackTimeMillis || null,
        },
        action: 'favorite',
      })),
      skipped: skipped.map((track) => ({ title: track.title, artist: track.artist, reason: track.searched && !track.matches.length ? 'no_catalog_match' : 'not_selected' })),
      appleMusicWritesPerformed: 0,
    };
  }

  $$('.source .connect').forEach((button) => button.addEventListener('click', () => {
    const card = button.closest('.source');
    state.source = card.dataset.source;
    $$('.source').forEach((item) => {
      const active = item === card;
      item.classList.toggle('selected', active);
      item.querySelector('.source-status').textContent = active ? 'Выбран · импорт из файла' : 'Не выбран';
      item.querySelector('.source-status').classList.toggle('connected', active);
      item.querySelector('.connect').disabled = active;
      item.querySelector('.connect').textContent = active ? '✓ Выбрано' : 'Выбрать';
    });
    $('.count').textContent = `1 из ${$$('.source').length}`;
    toast(`${state.source}: выбран как подпись источника`);
  }));

  $('#loadBtn').addEventListener('click', () => loadTracks(demoTracks, `${state.source} · пример`));
  $('#fileInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      const tracks = file.name.toLowerCase().endsWith('.json') ? normalizeJSON(JSON.parse(text)) : parseCSV(text);
      if (!tracks.length) throw new Error('В файле не нашёл треков с названием и исполнителем');
      loadTracks(tracks, file.name);
    } catch (error) {
      toast(error.message || 'Не удалось прочитать файл');
    } finally {
      event.target.value = '';
    }
  });

  $('#templateBtn').addEventListener('click', () => {
    const blob = new Blob(['title,artist,album\n"Снег","Моя Мишель","Кино"\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'music-import-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  });

  $('#searchBtn').addEventListener('click', searchCatalog);
  $('#storefront').addEventListener('change', () => {
    if (!state.loaded) return;
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

  $('#resetBtn').addEventListener('click', () => {
    state.tracks = [];
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

  $('#importBtn').addEventListener('click', () => {
    state.report = buildPlan();
    $('#addedMetric').textContent = state.report.selected.length;
    $('#skippedMetric').textContent = state.report.skipped.length;
    $('#report').classList.add('show');
    setStep(5);
    toast('JSON-план сформирован; Apple Music не менялся');
  });

  $('#downloadReport').addEventListener('click', () => {
    if (!state.report) return;
    const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'apple-music-transfer-plan.json';
    anchor.click();
    URL.revokeObjectURL(url);
    toast('План скачан');
  });

  updateCounts();
})();
