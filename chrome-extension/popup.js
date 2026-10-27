const $ = (selector) => document.querySelector(selector);
const send = (type) => chrome.runtime.sendMessage({ type: `zvuk:${type}` });

function isFavoritesUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://zvuk.com' && url.pathname === '/favorites';
  } catch {
    return false;
  }
}

function getCompleteness(state) {
  if (!state.tracks.length) return 'Пока нет пойманных страниц.';
  if (state.hasMore === false && state.expectedCount === state.tracks.length) return `Полный список подтверждён: ${state.tracks.length} из ${state.expectedCount}.`;
  if (state.hasMore === false && state.expectedCount !== null) return `Нужна сверка: поймано ${state.tracks.length}, ID коллекции ${state.expectedCount}.`;
  if (state.hasMore === true) return 'Есть следующая страница. Прокрутите «Любимое» дальше.';
  return 'Полнота пока не подтверждена: прокрутите «Любимое» до конца.';
}

async function render() {
  const state = await send('state');
  $('#trackCount').textContent = String(state.tracks.length);
  $('#pageCount').textContent = String(state.pagesSeen);
  $('#completeness').textContent = getCompleteness(state);
  $('#exportBtn').disabled = state.tracks.length === 0;
  $('#clearBtn').disabled = state.tracks.length === 0;
  $('#error').hidden = !state.error;
  $('#error').textContent = state.error || '';
}

$('#startBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isFavoritesUrl(tab.url)) {
    $('#completeness').textContent = 'Сначала откройте страницу https://zvuk.com/favorites.';
    return;
  }
  await send('start');
  const url = new URL(tab.url);
  url.searchParams.set('music_importer_capture', '1');
  await chrome.tabs.update(tab.id, { url: url.href });
  $('#completeness').textContent = 'Страница обновляется. Прокрутите «Любимое» до конца.';
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

$('#exportBtn').addEventListener('click', async () => {
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
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'zvuk-favorites.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.zvukFavoriteCapture) render();
});
render();
