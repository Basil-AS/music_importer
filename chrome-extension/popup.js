const $ = (selector) => document.querySelector(selector);
const send = (type, detail = {}) => chrome.runtime.sendMessage({ type: `zvuk:${type}`, ...detail });

function getCompleteness(state) {
  const parts = [];
  const phases = { favorites: 'собираем избранное', playlists: 'собираем каталог плейлистов', playlists_items: 'собираем содержимое плейлистов' };
  if (state.scan?.active) parts.push(`Автосбор: ${phases[state.scan.phase] || state.scan.phase}.`);
  else if (state.scan?.phase === 'complete') parts.push('Полная библиотека собрана и сверена.');
  else if (state.scan?.phase === 'needs_review') parts.push(state.scan.error || 'Сбор остановился; проверьте полноту.');
  else if (state.scan?.phase === 'stopped') parts.push('Сбор остановлен вручную.');
  if (state.tracks.length) {
    if (state.hasMore === false && state.expectedCount === state.tracks.length) parts.push(`Избранное подтверждено: ${state.tracks.length} из ${state.expectedCount}.`);
    else if (state.hasMore === true) parts.push(`Избранное: ${state.tracks.length} треков; прокрутите «Любимое» дальше.`);
    else parts.push(`Избранное: ${state.tracks.length} треков; полнота не подтверждена (контроль: ${state.expectedCount ?? 'нет данных'}).`);
  }
  if (state.playlistPagesSeen) {
    if (state.playlistListHasMore === false && state.expectedPlaylistCount === state.playlists.length) parts.push(`Список плейлистов подтверждён: ${state.playlists.length}.`);
    else if (state.playlistListHasMore) parts.push(`Список плейлистов: ${state.playlists.length}; прокрутите «Коллекция» дальше.`);
    else parts.push(`Список плейлистов: ${state.playlists.length}; полнота не подтверждена (контроль: ${state.expectedPlaylistCount ?? 'нет данных'}).`);
  }
  if (state.automation?.active) parts.push(`Автосбор плейлистов выполняется: ${state.playlists.filter((playlist) => playlist.complete).length} из ${state.playlists.length} подтверждено.`);
  const completePlaylists = state.playlists.filter((playlist) => playlist.complete).length;
  const playlistsWithItems = state.playlists.filter((playlist) => playlist.pagesSeen).length;
  if (playlistsWithItems) parts.push(`Треки собраны для ${completePlaylists} из ${state.playlists.length} плейлистов.`);
  return parts.join(' ') || 'Откройте «Любимое» или «Коллекция» в Звуке.';
}

async function render() {
  const state = await send('state');
  $('#trackCount').textContent = String(state.tracks.length);
  $('#playlistCount').textContent = String(state.playlists.length);
  $('#completeness').textContent = getCompleteness(state);
  $('#startBtn').disabled = Boolean(state.scan?.active);
  $('#startBtn').textContent = state.scan?.active ? 'Собираем библиотеку…' : 'Собрать библиотеку целиком';
  $('#stopBtn').disabled = !state.scan?.active && !state.automation?.active;
  $('#exportFavoritesBtn').disabled = state.tracks.length === 0;
  $('#exportPlaylistsBtn').disabled = state.playlists.length === 0;
  $('#runPlaylistsBtn').disabled = state.automation?.active || !state.playlistPagesSeen || state.playlistListHasMore !== false || state.expectedPlaylistCount !== state.playlists.length || state.playlists.length === 0;
  $('#runPlaylistsBtn').textContent = state.automation?.active ? 'Сбор плейлистов выполняется…' : 'Собрать треки всех плейлистов';
  $('#exportLibraryBtn').disabled = state.scan?.phase !== 'complete';
  $('#clearBtn').disabled = state.tracks.length === 0 && state.playlists.length === 0;
  $('#error').hidden = !state.error;
  $('#error').textContent = state.error || '';
}

$('#startBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let isZvuk = false;
  try { isZvuk = new URL(tab?.url || '').origin === 'https://zvuk.com'; } catch { /* No active page URL. */ }
  if (!tab?.id || !isZvuk) {
    $('#completeness').textContent = 'Откройте Звук и войдите в свой аккаунт. Запуск не читает пароль или токены.';
    return;
  }
  const result = await send('start-library', { tabId: tab.id });
  if (!result?.ok) $('#completeness').textContent = result?.error || 'Не удалось начать сбор библиотеки.';
  else $('#completeness').textContent = 'Сбор начался: избранное и плейлисты будут загружены по очереди.';
  await render();
});

$('#runPlaylistsBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const result = await send('run-playlists', { tabId: tab.id });
  if (!result?.ok) {
    $('#completeness').textContent = result?.error || 'Сначала завершите сбор списка плейлистов.';
    return;
  }
  $('#completeness').textContent = 'Открываются страницы плейлистов. Не закрывайте вкладку до завершения.';
  await render();
});

$('#stopBtn').addEventListener('click', async () => {
  await send('stop');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'zvuk:stop' }).catch(() => {});
  await render();
});

$('#clearBtn').addEventListener('click', async () => {
  if (!confirm('Удалить сохранённые локальные лайки и плейлисты?')) return;
  await send('clear');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'zvuk:stop' }).catch(() => {});
  await render();
});

$('#exportFavoritesBtn').addEventListener('click', async () => {
  const state = await send('state');
  const payload = {
    schemaVersion: 1,
    service: 'zvuk',
    collection: { type: 'favorites', name: 'Любимое' },
    completeness: {
      pagesSeen: state.pagesSeen,
      receivedCount: state.receivedCount,
      uniqueCount: state.tracks.length,
      expectedUniqueCount: state.expectedCount,
      lastPageHasMore: state.hasMore,
      confirmed: state.hasMore === false && state.expectedCount === state.tracks.length,
    },
    tracks: state.tracks,
  };
  downloadJSON(payload, 'zvuk-favorites.json');
});

$('#exportLibraryBtn').addEventListener('click', async () => {
  const state = await send('state');
  const favoritesConfirmed = state.favoritesScanFinished && state.hasMore === false
    && Number.isInteger(state.expectedCount) && state.expectedCount === state.tracks.length;
  const catalogConfirmed = state.playlistListHasMore === false
    && Number.isInteger(state.expectedPlaylistCount) && state.expectedPlaylistCount === state.playlists.length;
  const playlistItemsConfirmed = state.playlists.every((playlist) => playlist.complete);
  const payload = {
    schemaVersion: 1,
    service: 'zvuk',
    collection: { type: 'library', name: 'Вся библиотека' },
    completeness: {
      confirmed: state.scan?.phase === 'complete' && favoritesConfirmed && catalogConfirmed && playlistItemsConfirmed,
      favoritesConfirmed,
      favoritesCount: state.tracks.length,
      catalogConfirmed,
      playlistItemsConfirmed,
      playlistItemsTotal: state.playlists.length,
    },
    tracks: state.tracks,
    playlists: state.playlists,
  };
  downloadJSON(payload, 'zvuk-library.json');
});

$('#exportPlaylistsBtn').addEventListener('click', async () => {
  const state = await send('state');
  const catalogConfirmed = state.playlistListHasMore === false && state.expectedPlaylistCount === state.playlists.length;
  const playlistItemsConfirmed = state.playlists.every((playlist) => playlist.complete);
  const payload = {
    schemaVersion: 1,
    service: 'zvuk',
    collection: { type: 'playlists', name: 'Плейлисты' },
    completeness: {
      catalogPagesSeen: state.playlistPagesSeen,
      catalogCount: state.playlists.length,
      expectedCatalogCount: state.expectedPlaylistCount,
      catalogHasMore: state.playlistListHasMore,
      catalogConfirmed,
      playlistItemsConfirmed: state.playlists.filter((playlist) => playlist.complete).length,
      playlistItemsTotal: state.playlists.length,
      confirmed: catalogConfirmed && playlistItemsConfirmed,
    },
    playlists: state.playlists,
  };
  downloadJSON(payload, 'zvuk-playlists.json');
});

function downloadJSON(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.zvukFavoriteCapture) render();
});
render();
