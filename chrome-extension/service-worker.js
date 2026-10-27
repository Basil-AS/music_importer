const STORAGE_KEY = 'zvukFavoriteCapture';

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

async function readState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return {
    service: 'zvuk',
    collection: 'favorites',
    tracks: [],
    pagesSeen: 0,
    receivedCount: 0,
    expectedCount: null,
    hasMore: null,
    playlists: [],
    playlistPagesSeen: 0,
    expectedPlaylistCount: null,
    playlistListHasMore: null,
    automation: { active: false, tabId: null, currentPlaylistId: null, startedAt: null },
    captureEnabled: false,
    updatedAt: null,
    error: null,
    ...(stored[STORAGE_KEY] || {}),
    tracks: Array.isArray(stored[STORAGE_KEY]?.tracks) ? stored[STORAGE_KEY].tracks : [],
    playlists: Array.isArray(stored[STORAGE_KEY]?.playlists) ? stored[STORAGE_KEY].playlists : [],
  };
}

async function advancePlaylistAutomation(state) {
  const automation = state.automation;
  if (!automation?.active || !Number.isInteger(automation.tabId)) return;
  const next = state.playlists.find((playlist) => !playlist.complete && !playlist.itemsScanFinished);
  if (!next) {
    state.automation = { ...automation, active: false, currentPlaylistId: null, finishedAt: new Date().toISOString() };
    state.captureEnabled = false;
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    return;
  }
  state.automation = { ...automation, currentPlaylistId: next.id };
  await writeState(state);
  await chrome.tabs.update(automation.tabId, {
    url: `https://zvuk.com/playlist/${encodeURIComponent(next.id)}?music_importer_capture=1`,
  });
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function pageKind(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://zvuk.com') return '';
    if (parsed.pathname === '/favorites') return 'favorites';
    if (parsed.pathname === '/collection' || parsed.pathname.startsWith('/collection/')) return 'collection';
    if (/^\/playlist\/[^/]+/.test(parsed.pathname)) return 'playlist';
    return '';
  } catch {
    return '';
  }
}

function messageMatchesPage(type, kind) {
  if (type === 'zvuk:favorite-page') return kind === 'favorites';
  if (type === 'zvuk:playlist-list-page') return kind === 'collection';
  if (type === 'zvuk:playlist-metadata') return kind === 'collection' || kind === 'playlist';
  if (type === 'zvuk:playlist-track-page') return kind === 'playlist';
  if (type === 'zvuk:collection-scroll-end') return kind === 'collection';
  if (type === 'zvuk:playlist-scroll-end') return kind === 'playlist';
  return type === 'zvuk:collection-count' || type === 'zvuk:read-error';
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
      state.automation = { ...state.automation, active: false };
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
      state.playlists = [];
      state.playlistPagesSeen = 0;
      state.expectedPlaylistCount = null;
      state.playlistListHasMore = null;
      state.automation = { active: false, tabId: null, currentPlaylistId: null, startedAt: null };
      state.captureEnabled = false;
      state.updatedAt = null;
      state.error = null;
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:run-playlists') {
      const state = await readState();
      const tabId = Number(message.tabId);
      const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const catalogConfirmed = state.playlistPagesSeen > 0
        && state.playlistListHasMore === false
        && Number.isInteger(state.expectedPlaylistCount)
        && state.expectedPlaylistCount === state.playlists.length;
      if (!tab || pageKind(tab.url) !== 'collection' || !catalogConfirmed || !state.playlists.length) {
        sendResponse({ ok: false, error: 'Сначала завершите и подтвердите сбор списка плейлистов.' });
        return;
      }
      state.captureEnabled = true;
      state.automation = { active: true, tabId, currentPlaylistId: null, startedAt: new Date().toISOString() };
      state.playlists.forEach((playlist) => { playlist.itemsScanFinished = Boolean(playlist.complete); });
      await writeState(state);
      sendResponse({ ok: true });
      await advancePlaylistAutomation(state);
      return;
    }

    const kind = pageKind(sender.url);
    if (sender.id !== chrome.runtime.id || !kind || !messageMatchesPage(message?.type, kind)) {
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
      state.expectedPlaylistCount = Number.isInteger(message.uniquePlaylistCount) ? message.uniquePlaylistCount : state.expectedPlaylistCount;
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:playlist-list-page' || message?.type === 'zvuk:playlist-metadata') {
      const byId = new Map(state.playlists.map((playlist) => [playlist.id, playlist]));
      for (const incoming of message.playlists || []) {
        if (!incoming?.id || !incoming?.title) continue;
        const prior = byId.get(String(incoming.id)) || { id: String(incoming.id), title: String(incoming.title), tracks: [], pagesSeen: 0, offsetsSeen: [] };
        const updated = {
          ...prior,
          title: String(incoming.title),
          trackCount: Number.isInteger(incoming.trackCount) ? incoming.trackCount : prior.trackCount ?? null,
        };
        updated.complete = Number.isInteger(updated.trackCount)
          && updated.tracks.length === updated.trackCount
          && updated.tracks.every((item, position) => item.position === position);
        byId.set(String(incoming.id), updated);
      }
      state.playlists = [...byId.values()];
      if (message.type === 'zvuk:playlist-list-page') {
        state.playlistPagesSeen += 1;
        state.playlistListHasMore = Boolean(message.hasMore);
      }
      state.updatedAt = new Date().toISOString();
      state.error = null;
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:playlist-track-page') {
      const playlistId = String(message.playlistId || '');
      if (!playlistId) { sendResponse({ ok: false }); return; }
      let playlist = state.playlists.find((item) => item.id === playlistId);
      if (!playlist) {
        playlist = { id: playlistId, title: `Плейлист ${playlistId}`, trackCount: null, tracks: [], pagesSeen: 0, offsetsSeen: [] };
        state.playlists.push(playlist);
      }
      const offset = Math.max(0, Number(message.offset) || 0);
      const limit = Math.max(0, Number(message.limit) || 0);
      const pageTracks = Array.isArray(message.tracks) ? message.tracks : [];
      const itemsByPosition = new Map(playlist.tracks.map((item) => [item.position, item]));
      pageTracks.forEach((track, index) => {
        if (track?.id && track?.title) itemsByPosition.set(offset + index, { ...track, position: offset + index });
      });
      playlist.tracks = [...itemsByPosition.values()].sort((left, right) => left.position - right.position);
      playlist.pagesSeen = Number(playlist.pagesSeen || 0) + 1;
      playlist.offsetsSeen = [...new Set([...(playlist.offsetsSeen || []), offset])].sort((left, right) => left - right);
      playlist.lastOffset = offset;
      playlist.lastPageSize = pageTracks.length;
      playlist.lastPageHasMore = playlist.trackCount === null || playlist.trackCount === undefined
        ? (limit > 0 && pageTracks.length >= limit)
        : offset + pageTracks.length < playlist.trackCount;
      playlist.complete = Number.isInteger(playlist.trackCount)
        && playlist.tracks.length === playlist.trackCount
        && playlist.tracks.every((item, position) => item.position === position);
      const atAutomationPlaylist = state.automation?.active
        && state.automation.tabId === sender.tab?.id
        && state.automation.currentPlaylistId === playlistId;
      const pageEnded = playlist.trackCount !== null && playlist.trackCount !== undefined
        ? offset + pageTracks.length >= playlist.trackCount
        : limit > 0 && pageTracks.length < limit;
      if (atAutomationPlaylist && pageEnded) playlist.itemsScanFinished = true;
      if (atAutomationPlaylist && pageEnded && !playlist.complete) playlist.incompleteReason = 'Количество полученных элементов не сошлось с trackCount/порядком страниц.';
      state.updatedAt = new Date().toISOString();
      state.error = null;
      await writeState(state);
      sendResponse({ ok: true });
      if (atAutomationPlaylist && pageEnded) await advancePlaylistAutomation(state);
      return;
    }

    if (message?.type === 'zvuk:playlist-scroll-end') {
      const playlistId = String(message.playlistId || '');
      const playlist = state.playlists.find((item) => item.id === playlistId);
      const atAutomationPlaylist = state.automation?.active
        && state.automation.tabId === sender.tab?.id
        && state.automation.currentPlaylistId === playlistId;
      if (playlist) {
        playlist.itemsScanFinished = true;
        if (!playlist.complete) playlist.incompleteReason = 'Прокрутка страницы остановилась до подтверждения всех элементов.';
      }
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      if (atAutomationPlaylist) await advancePlaylistAutomation(state);
      return;
    }

    if (message?.type === 'zvuk:collection-scroll-end') {
      state.collectionScrollFinished = true;
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:read-error') {
      state.error = 'Звук вернул ошибку при чтении страницы избранного.';
      const current = state.playlists.find((playlist) => playlist.id === state.automation?.currentPlaylistId);
      const atAutomationPlaylist = state.automation?.active && state.automation.tabId === sender.tab?.id;
      if (current && atAutomationPlaylist) {
        current.itemsScanFinished = true;
        current.incompleteReason = 'Сервис вернул ошибку при чтении playlist page.';
      }
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      if (atAutomationPlaylist) await advancePlaylistAutomation(state);
      return;
    }
    sendResponse({ ok: false });
  })().catch(() => sendResponse({ ok: false, error: 'Не удалось обновить локальное состояние.' }));
  return true;
});
