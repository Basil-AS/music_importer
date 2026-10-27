const $ = (selector) => document.querySelector(selector);
const send = (type, detail = {}) => chrome.runtime.sendMessage({ type: `zvuk:${type}`, ...detail });

function isCaptureUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://zvuk.com' && (url.pathname === '/favorites' || url.pathname === '/collection' || url.pathname.startsWith('/playlist/'));
  } catch {
    return false;
  }
}

function getCompleteness(state) {
  const parts = [];
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
  $('#exportFavoritesBtn').disabled = state.tracks.length === 0;
  $('#exportPlaylistsBtn').disabled = state.playlists.length === 0;
  $('#runPlaylistsBtn').disabled = state.automation?.active || !state.playlistPagesSeen || state.playlistListHasMore !== false || state.expectedPlaylistCount !== state.playlists.length || state.playlists.length === 0;
  $('#runPlaylistsBtn').textContent = state.automation?.active ? 'Сбор плейлистов выполняется…' : 'Собрать треки всех плейлистов';
  $('#clearBtn').disabled = state.tracks.length === 0 && state.playlists.length === 0;
  $('#error').hidden = !state.error;
  $('#error').textContent = state.error || '';
}

$('#startBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isCaptureUrl(tab.url)) {
    $('#completeness').textContent = 'Откройте «Любимое», «Коллекция» или страницу одного плейлиста в Звуке.';
    return;
  }
  await send('start');
  const url = new URL(tab.url);
  url.searchParams.set('music_importer_capture', '1');
  await chrome.tabs.update(tab.id, { url: url.href });
  $('#completeness').textContent = url.pathname.startsWith('/collection')
    ? 'Страница обновляется. Дождитесь полного списка плейлистов, затем запустите их сбор.'
    : url.pathname.startsWith('/playlist/')
      ? 'Страница обновляется. Треки этого плейлиста будут собраны при прокрутке.'
      : 'Страница обновляется. Дождитесь загрузки списка «Любимое» и прокрутите его до конца.';
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
  if (!confirm('Удалить сохранённый локальный список избранного?')) return;
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

$('#exportPlaylistsBtn').addEventListener('click', async () => {
  const state = await send('state');
  const payload = {
    schemaVersion: 1,
    service: 'zvuk',
    collection: { type: 'playlists', name: 'Плейлисты' },
    completeness: {
      catalogPagesSeen: state.playlistPagesSeen,
      catalogCount: state.playlists.length,
      expectedCatalogCount: state.expectedPlaylistCount,
      catalogHasMore: state.playlistListHasMore,
      catalogConfirmed: state.playlistListHasMore === false && state.expectedPlaylistCount === state.playlists.length,
      playlistItemsConfirmed: state.playlists.filter((playlist) => playlist.complete).length,
      playlistItemsTotal: state.playlists.length,
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
