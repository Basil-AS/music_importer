const STORAGE_KEY = 'zvukFavoriteCapture';

async function readState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || {
    service: 'zvuk',
    collection: 'favorites',
    tracks: [],
    pagesSeen: 0,
    receivedCount: 0,
    expectedCount: null,
    hasMore: null,
    captureEnabled: false,
    updatedAt: null,
    error: null,
  };
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function isFavoritesPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://zvuk.com' && parsed.pathname === '/favorites';
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'zvuk:state') {
      sendResponse(await readState());
      return;
    }

    if (message?.type === 'zvuk:start') {
      const state = await readState();
      state.captureEnabled = true;
      state.error = null;
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:stop') {
      const state = await readState();
      state.captureEnabled = false;
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:clear') {
      const state = await readState();
      state.tracks = [];
      state.pagesSeen = 0;
      state.receivedCount = 0;
      state.expectedCount = null;
      state.hasMore = null;
      state.updatedAt = null;
      state.error = null;
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (sender.id !== chrome.runtime.id || !isFavoritesPage(sender.url)) {
      sendResponse({ ok: false });
      return;
    }
    const state = await readState();
    if (!state.captureEnabled) {
      sendResponse({ ok: false });
      return;
    }

    if (message?.type === 'zvuk:favorite-page') {
      const byId = new Map(state.tracks.map((track) => [track.id, track]));
      for (const track of message.tracks || []) {
        if (track?.id && track?.title) byId.set(String(track.id), track);
      }
      state.tracks = [...byId.values()];
      state.pagesSeen += 1;
      state.receivedCount += (message.tracks || []).length;
      state.hasMore = Boolean(message.hasMore);
      state.updatedAt = new Date().toISOString();
      state.error = null;
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:collection-count') {
      state.expectedCount = Number.isInteger(message.uniqueTrackCount) ? message.uniqueTrackCount : null;
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:read-error') {
      state.error = 'Звук вернул ошибку при чтении страницы избранного.';
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false });
  })().catch(() => sendResponse({ ok: false, error: 'Не удалось обновить локальное состояние.' }));
  return true;
});
