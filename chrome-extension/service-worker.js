const STORAGE_KEY = 'zvukFavoriteCapture';
const PROVIDER_STORAGE_KEY = 'providerLibraryBridge';
const APP_TAB_URLS = [
  'http://127.0.0.1:8000/*', 'http://127.0.0.1:8001/*',
  'http://localhost:8000/*', 'http://localhost:8001/*',
  'https://basil-as.github.io/music_importer/*',
];
const APP_ORIGINS = new Set([
  'http://127.0.0.1:8000', 'http://127.0.0.1:8001',
  'http://localhost:8000', 'http://localhost:8001',
  'https://basil-as.github.io',
]);

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
    favoritesScanFinished: false,
    collectionScrollFinished: false,
    scan: { active: false, phase: 'idle', tabId: null, startedAt: null },
    automation: { active: false, tabId: null, currentPlaylistId: null, startedAt: null },
    captureEnabled: false,
    updatedAt: null,
    error: null,
    ...(stored[STORAGE_KEY] || {}),
    tracks: Array.isArray(stored[STORAGE_KEY]?.tracks) ? stored[STORAGE_KEY].tracks : [],
    playlists: Array.isArray(stored[STORAGE_KEY]?.playlists) ? stored[STORAGE_KEY].playlists : [],
  };
}

function createLibraryPayload(state) {
  const favoritesConfirmed = state.favoritesScanFinished && state.hasMore === false
    && Number.isInteger(state.expectedCount) && state.expectedCount === state.tracks.length;
  const catalogConfirmed = state.playlistListHasMore === false
    && Number.isInteger(state.expectedPlaylistCount) && state.expectedPlaylistCount === state.playlists.length;
  const playlistItemsConfirmed = state.playlists.every((playlist) => playlist.complete === true);
  return {
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
}

async function advancePlaylistAutomation(state) {
  const automation = state.automation;
  if (!automation?.active || !Number.isInteger(automation.tabId)) return;
  const next = state.playlists.find((playlist) => !playlist.complete && !playlist.itemsScanFinished);
  if (!next) {
    state.automation = { ...automation, active: false, currentPlaylistId: null, finishedAt: new Date().toISOString() };
    state.captureEnabled = false;
    const favoritesConfirmed = state.favoritesScanFinished && state.hasMore === false
      && Number.isInteger(state.expectedCount) && state.expectedCount === state.tracks.length;
    const playlistCatalogConfirmed = state.playlistListHasMore === false
      && Number.isInteger(state.expectedPlaylistCount) && state.expectedPlaylistCount === state.playlists.length;
    const playlistsConfirmed = state.playlists.every((playlist) => playlist.complete);
    if (state.scan?.active) {
      state.scan = {
        ...state.scan,
        active: false,
        phase: favoritesConfirmed && playlistCatalogConfirmed && playlistsConfirmed ? 'complete' : 'needs_review',
        finishedAt: new Date().toISOString(),
      };
      if (state.scan.phase === 'complete') state.previousCompleteSnapshot = null;
    }
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

async function advanceAccountScan(state) {
  if (!state.scan?.active) return;
  if (state.scan.phase === 'favorites' && state.favoritesScanFinished) {
    const favoritesConfirmed = state.hasMore === false
      && Number.isInteger(state.expectedCount) && state.expectedCount === state.tracks.length;
    if (!favoritesConfirmed) {
      state.scan = { ...state.scan, active: false, phase: 'needs_review', error: 'Число избранных не совпало с независимым списком ID.' };
      state.captureEnabled = false;
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      return;
    }
    state.scan = { ...state.scan, phase: 'playlists' };
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    await chrome.tabs.update(state.scan.tabId, { url: 'https://zvuk.com/collection?music_importer_capture=1' });
    return;
  }
  if (state.scan.phase === 'playlists' && state.collectionScrollFinished && state.playlistListHasMore === false) {
    const catalogConfirmed = Number.isInteger(state.expectedPlaylistCount)
      && state.expectedPlaylistCount === state.playlists.length;
    if (!catalogConfirmed) {
      state.scan = { ...state.scan, active: false, phase: 'needs_review', error: 'Число найденных плейлистов не совпало с независимым списком ID.' };
      state.captureEnabled = false;
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      return;
    }
    const tab = await chrome.tabs.get(state.scan.tabId).catch(() => null);
    if (!tab || pageKind(tab.url) !== 'collection') {
      state.scan = { ...state.scan, active: false, phase: 'needs_review', error: 'Не удалось открыть список плейлистов в Звуке.' };
      await writeState(state);
      return;
    }
    state.scan = { ...state.scan, phase: 'playlists_items' };
    state.automation = { active: true, tabId: state.scan.tabId, currentPlaylistId: null, startedAt: new Date().toISOString() };
    state.playlists.forEach((playlist) => { playlist.itemsScanFinished = Boolean(playlist.complete); });
    await writeState(state);
    await advancePlaylistAutomation(state);
  }
}

async function startAccountScan(tabId, { forceRefresh = false } = {}) {
  const numericTabId = Number(tabId);
  const tab = Number.isInteger(numericTabId) ? await chrome.tabs.get(numericTabId).catch(() => null) : null;
  let origin = '';
  try { origin = new URL(tab?.url || '').origin; } catch { /* Invalid or unavailable tab URL. */ }
  if (!tab || origin !== 'https://zvuk.com') return { ok: false, error: 'Войдите в Звук в этой вкладке и повторите запуск.' };
  const state = await readState();
  if (state.scan?.active) return { ok: false, error: 'Сбор библиотеки Звука уже выполняется.' };
  if ((state.tracks.length || state.playlists.length) && !forceRefresh) return { ok: false, error: 'Сначала экспортируйте или очистите предыдущий локальный сбор.' };
  const currentSnapshot = createLibraryPayload(state);
  if (currentSnapshot.completeness.confirmed) state.previousCompleteSnapshot = currentSnapshot;
  state.tracks = [];
  state.playlists = [];
  state.pagesSeen = 0;
  state.receivedCount = 0;
  state.expectedCount = null;
  state.hasMore = null;
  state.playlistPagesSeen = 0;
  state.expectedPlaylistCount = null;
  state.playlistListHasMore = null;
  state.favoritesScanFinished = false;
  state.collectionScrollFinished = false;
  state.automation = { active: false, tabId: null, currentPlaylistId: null, startedAt: null };
  state.captureEnabled = true;
  state.scan = { active: true, phase: 'favorites', tabId: numericTabId, startedAt: new Date().toISOString() };
  state.updatedAt = new Date().toISOString();
  state.error = null;
  await writeState(state);
  await chrome.tabs.update(numericTabId, { url: 'https://zvuk.com/favorites?music_importer_capture=1' });
  return { ok: true };
}

async function beginPlaylistScan(state, tabId) {
  const numericTabId = Number(tabId);
  const tab = Number.isInteger(numericTabId) ? await chrome.tabs.get(numericTabId).catch(() => null) : null;
  const catalogConfirmed = state.playlistPagesSeen > 0
    && state.playlistListHasMore === false
    && Number.isInteger(state.expectedPlaylistCount)
    && state.expectedPlaylistCount === state.playlists.length;
  if (!tab || pageKind(tab.url) !== 'collection' || !catalogConfirmed || !state.playlists.length) {
    return { ok: false, error: 'Сначала завершите и подтвердите сбор списка плейлистов.' };
  }
  state.captureEnabled = true;
  state.automation = { active: true, tabId: numericTabId, currentPlaylistId: null, startedAt: new Date().toISOString() };
  state.playlists.forEach((playlist) => { playlist.itemsScanFinished = Boolean(playlist.complete); });
  await writeState(state);
  await advancePlaylistAutomation(state);
  return { ok: true };
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function readProviderState() {
  const stored = await chrome.storage.local.get(PROVIDER_STORAGE_KEY);
  return {
    snapshots: stored[PROVIDER_STORAGE_KEY]?.snapshots || {},
    scans: stored[PROVIDER_STORAGE_KEY]?.scans || {},
    previousSnapshots: stored[PROVIDER_STORAGE_KEY]?.previousSnapshots || {},
  };
}

async function writeProviderState(state) {
  await chrome.storage.local.set({ [PROVIDER_STORAGE_KEY]: state });
}

async function requestProviderLibrary(provider, refresh) {
  const providers = {
    spotify: { tabPattern: 'https://open.spotify.com/*', origin: 'https://open.spotify.com', startMessage: 'spotify:start-library-scan' },
    'yandex-music': { tabPattern: 'https://music.yandex.ru/*', origin: 'https://music.yandex.ru', startMessage: 'yandex:start-library-scan' },
    'apple-music': { tabPattern: 'https://music.apple.com/*', origin: 'https://music.apple.com', startMessage: 'apple:start-library-scan' },
  };
  const providerConfig = providers[provider];
  if (!providerConfig) return { error: `Для ${provider || 'этого сервиса'} пока нет сборщика библиотеки.` };
  const state = await readProviderState();
  let scan = state.scans[provider];
  const lastUpdate = Date.parse(scan?.updatedAt || scan?.startedAt || '');
  if (scan?.status === 'reading' && Number.isFinite(lastUpdate) && Date.now() - lastUpdate > 45 * 60 * 1000) {
    scan = { status: 'failed', message: 'Предыдущий сбор остановился без ответа. Запустите его повторно.' };
    state.scans[provider] = scan;
    await writeProviderState(state);
  }
  const lastGoodSnapshot = [state.snapshots[provider], state.previousSnapshots[provider]]
    .find((snapshot) => snapshot?.completeness?.confirmed === true);
  if (refresh && scan?.status !== 'reading') {
    const [tab] = await chrome.tabs.query({ url: providerConfig.tabPattern });
    const providerName = provider === 'spotify' ? 'Spotify Web Player' : provider === 'apple-music' ? 'Apple Music' : 'Яндекс Музыку';
    if (!tab?.id) {
      if (lastGoodSnapshot) return { payload: lastGoodSnapshot, cached: true, stale: true, message: `Откройте ${providerName}, чтобы обновить сохранённый снимок.` };
      return { error: `Откройте ${providerName}, войдите и дождитесь загрузки библиотеки, затем повторите.` };
    }
    state.previousSnapshots[provider] = lastGoodSnapshot || null;
    state.snapshots[provider] = null;
    state.scans[provider] = { status: 'reading', message: `Запускаем чтение ${providerName}…`, startedAt: new Date().toISOString() };
    await writeProviderState(state);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: providerConfig.startMessage });
    } catch {
      state.scans[provider] = { status: 'failed', message: `Расширение не подключено к ${providerName}. Перезагрузите вкладку сервиса и повторите.` };
      await writeProviderState(state);
      if (lastGoodSnapshot) return { payload: lastGoodSnapshot, cached: true, stale: true, message: state.scans[provider].message };
      return { error: state.scans[provider].message };
    }
    return { pending: true, progress: state.scans[provider].message, payload: lastGoodSnapshot, cached: Boolean(lastGoodSnapshot), stale: Boolean(lastGoodSnapshot) };
  }
  if (scan?.status === 'reading') return { pending: true, progress: scan.message || `Читаем ${provider}…`, payload: lastGoodSnapshot, cached: Boolean(lastGoodSnapshot), stale: Boolean(lastGoodSnapshot) };
  if (scan?.status === 'failed') {
    if (lastGoodSnapshot) return { payload: lastGoodSnapshot, cached: true, stale: true, message: scan.message || `Обновление ${provider} не завершилось.` };
    return { error: scan.message || `Не удалось прочитать ${provider}.` };
  }
  const payload = state.snapshots[provider];
  if (payload?.completeness?.confirmed === true) return { payload, stale: false };
  if (lastGoodSnapshot) return { payload: lastGoodSnapshot, cached: true, stale: true, message: `Сохранён последний полный снимок ${provider}.` };
  return { error: 'Сбор Spotify не запускался. Повторите импорт из расширения.' };
}

async function requestZvukLibrary(refresh) {
  const state = await readState();
  const payload = createLibraryPayload(state);
  const lastGoodSnapshot = payload.completeness.confirmed ? payload : state.previousCompleteSnapshot;
  if (payload.completeness.confirmed && !refresh) return { payload, stale: false };
  if (state.scan?.active) return {
    pending: true,
    progress: `Звук: ${state.scan.phase || 'сбор библиотеки'}.`,
    payload: state.previousCompleteSnapshot || null,
    cached: Boolean(state.previousCompleteSnapshot),
    stale: Boolean(state.previousCompleteSnapshot),
  };
  if (!refresh && lastGoodSnapshot?.completeness?.confirmed === true) {
    return { payload: lastGoodSnapshot, cached: true, stale: true, message: state.scan?.error || 'Сохранён последний полный снимок Звука.' };
  }
  if (!refresh) return { error: state.error || 'Сбор библиотеки Звука не запускался.' };
  const tabs = await chrome.tabs.query({ url: ['https://zvuk.com/favorites*', 'https://zvuk.com/collection*', 'https://zvuk.com/playlist/*'] });
  const tab = tabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
  if (!tab?.id) {
    if (lastGoodSnapshot?.completeness?.confirmed === true) return { payload: lastGoodSnapshot, cached: true, stale: true, message: 'Откройте Звук, чтобы обновить сохранённый снимок.' };
    return { error: 'Откройте Звук в Chrome и войдите в аккаунт.' };
  }
  const result = await startAccountScan(tab.id, { forceRefresh: true });
  if (!result?.ok) {
    if (lastGoodSnapshot?.completeness?.confirmed === true) return { payload: lastGoodSnapshot, cached: true, stale: true, message: result?.error || 'Не удалось обновить Звук; сохранён последний полный снимок.' };
    return { error: result?.error || 'Не удалось запустить сбор библиотеки Звука.' };
  }
  return {
    pending: true,
    progress: 'Звук: собираем лайки, каталог и содержимое плейлистов.',
    payload: lastGoodSnapshot?.completeness?.confirmed === true ? lastGoodSnapshot : null,
    cached: Boolean(lastGoodSnapshot?.completeness?.confirmed === true),
    stale: Boolean(lastGoodSnapshot?.completeness?.confirmed === true),
  };
}

async function requestAllLibraries(refresh) {
  const providers = ['zvuk', 'spotify', 'yandex-music', 'apple-music'];
  const outcomes = await Promise.all(providers.map(async (provider) => {
    const result = provider === 'zvuk'
      ? await requestZvukLibrary(refresh)
      : await requestProviderLibrary(provider, refresh);
    return [provider, result || { error: 'Сервис не вернул состояние.' }];
  }));
  const libraries = {};
  const statuses = {};
  let pending = false;
  for (const [provider, result] of outcomes) {
    if (result.pending) {
      pending = true;
      if (result.payload?.completeness?.confirmed === true && result.payload.service === provider) libraries[provider] = result.payload;
      statuses[provider] = {
        status: 'scanning',
        message: String(result.progress || `Сканируем ${provider}…`),
        cached: result.cached === true,
      };
    } else if (result.payload?.completeness?.confirmed === true && result.payload.service === provider) {
      libraries[provider] = result.payload;
      statuses[provider] = {
        status: result.stale ? 'stale' : 'ready',
        trackCount: result.payload.tracks.length,
        playlistCount: result.payload.playlists.length,
        cached: result.cached === true,
        message: result.message || '',
      };
    } else {
      statuses[provider] = { status: 'unavailable', message: String(result.error || 'Полная библиотека пока недоступна.') };
    }
  }
  return { libraries, statuses, pending };
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
  if (type === 'zvuk:favorites-scroll-end' || type === 'zvuk:favorites-scroll-stall') return kind === 'favorites';
  if (type === 'zvuk:playlist-list-page') return kind === 'collection';
  if (type === 'zvuk:playlist-metadata') return kind === 'collection' || kind === 'playlist';
  if (type === 'zvuk:playlist-track-page') return kind === 'playlist';
  if (type === 'zvuk:collection-scroll-end') return kind === 'collection';
  if (type === 'zvuk:collection-scroll-stall') return kind === 'collection';
  if (type === 'zvuk:playlist-scroll-end') return kind === 'playlist';
  return type === 'zvuk:collection-count' || type === 'zvuk:read-error';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'zvuk:transfer-progress') {
      let origin = '';
      try { origin = new URL(sender.tab?.url || sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || origin !== 'https://zvuk.com') {
        sendResponse({ ok: false });
        return;
      }
      const appTabs = await chrome.tabs.query({ url: APP_TAB_URLS });
      await Promise.all(appTabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, {
        type: 'music-importer:zvuk-progress',
        requestId: String(message.requestId || ''),
        progress: message.progress || null,
      }).catch(() => null)));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'music-importer:zvuk-command') {
      let origin = '';
      try { origin = new URL(sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || !APP_ORIGINS.has(origin)) {
        sendResponse({ ok: false, error: 'Команда доступна только локальному приложению.' });
        return;
      }
      if (!/^[a-z0-9-]{16,80}$/i.test(String(message.requestId || '')) || !['search-tracks', 'execute-transfer'].includes(message.action)) {
        sendResponse({ ok: false, error: 'Некорректная команда Звука.' });
        return;
      }
      if (message.action === 'execute-transfer') {
        const plan = message.plan;
        if (plan?.type !== 'music-transfer-plan' || plan?.target?.provider !== 'zvuk'
          || !Array.isArray(plan.operations)
          || plan.operations.some((operation) => operation?.target?.provider !== 'zvuk' || !operation?.target?.providerId)
          || !Array.isArray(plan.completeness?.source) || !plan.completeness.source.length
          || plan.completeness.source.some((status) => status?.confirmed !== true)) {
          sendResponse({ ok: false, error: 'План Звука неполный или содержит другую цель.' });
          return;
        }
      }
      const tabs = await chrome.tabs.query({ url: ['https://zvuk.com/favorites*', 'https://zvuk.com/collection*', 'https://zvuk.com/playlist/*'] });
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs.find((candidate) => candidate.id === activeTab?.id)
        || tabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'Откройте вкладку Звука и войдите в аккаунт, затем повторите.' });
        return;
      }
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'zvuk:command',
          requestId: String(message.requestId),
          action: message.action,
          query: String(message.query || '').slice(0, 400),
          plan: message.action === 'execute-transfer' ? message.plan : undefined,
        });
        sendResponse(response || { ok: false, error: 'Звук не вернул результат.' });
      } catch {
        sendResponse({ ok: false, error: 'Расширение не подключено к вкладке Звука. Перезагрузите её и повторите.' });
      }
      return;
    }

    if (message?.type === 'spotify:transfer-progress') {
      let origin = '';
      try { origin = new URL(sender.tab?.url || sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || origin !== 'https://open.spotify.com') {
        sendResponse({ ok: false });
        return;
      }
      const appTabs = await chrome.tabs.query({ url: APP_TAB_URLS });
      await Promise.all(appTabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, {
        type: 'music-importer:spotify-progress',
        requestId: String(message.requestId || ''),
        progress: message.progress || null,
      }).catch(() => null)));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'music-importer:spotify-command') {
      let origin = '';
      try { origin = new URL(sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || !APP_ORIGINS.has(origin)) {
        sendResponse({ ok: false, error: 'Команда доступна только локальному приложению.' });
        return;
      }
      const requestId = String(message.requestId || '');
      if (!/^[a-z0-9-]{16,80}$/i.test(requestId) || !['search-tracks', 'execute-transfer'].includes(message.action)) {
        sendResponse({ ok: false, error: 'Некорректная команда Spotify.' });
        return;
      }
      if (message.action === 'execute-transfer') {
        const plan = message.plan;
        if (plan?.type !== 'music-transfer-plan' || plan?.target?.provider !== 'spotify'
          || !Array.isArray(plan.operations)
          || plan.operations.some((operation) => operation?.target?.provider !== 'spotify' || !operation?.target?.providerId)
          || !Array.isArray(plan.completeness?.source) || !plan.completeness.source.length
          || plan.completeness.source.some((status) => status?.confirmed !== true)) {
          sendResponse({ ok: false, error: 'План Spotify неполный или содержит другую цель.' });
          return;
        }
      }
      const tabs = await chrome.tabs.query({ url: 'https://open.spotify.com/*' });
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs.find((candidate) => candidate.id === activeTab?.id)
        || tabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'Откройте Spotify Web Player, войдите в аккаунт и повторите.' });
        return;
      }
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'spotify:command', requestId, action: message.action,
          query: String(message.query || '').slice(0, 400),
          plan: message.action === 'execute-transfer' ? message.plan : undefined,
        });
        sendResponse(response || { ok: false, error: 'Spotify не вернул результат.' });
      } catch {
        sendResponse({ ok: false, error: 'Расширение не подключено к вкладке Spotify. Перезагрузите её и повторите.' });
      }
      return;
    }

    if (message?.type === 'apple:transfer-progress') {
      let origin = '';
      try { origin = new URL(sender.tab?.url || sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || origin !== 'https://music.apple.com') {
        sendResponse({ ok: false });
        return;
      }
      const appTabs = await chrome.tabs.query({ url: APP_TAB_URLS });
      await Promise.all(appTabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, {
        type: 'music-importer:apple-progress',
        requestId: String(message.requestId || ''),
        progress: message.progress,
      }).catch(() => null)));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'music-importer:apple-command') {
      let origin = '';
      try { origin = new URL(sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || !APP_ORIGINS.has(origin)) {
        sendResponse({ ok: false, error: 'Команда доступна только локальному приложению.' });
        return;
      }
      const requestId = String(message.requestId || '');
      if (!/^[a-z0-9-]{16,80}$/i.test(requestId) || !['search-tracks', 'execute-transfer'].includes(message.action)) {
        sendResponse({ ok: false, error: 'Некорректная команда Apple Music.' });
        return;
      }
      if (message.action === 'execute-transfer'
        && (message.plan?.type !== 'music-transfer-plan' || message.plan?.target?.provider !== 'apple-music')) {
        sendResponse({ ok: false, error: 'План не предназначен для Apple Music.' });
        return;
      }
      const tabs = await chrome.tabs.query({ url: 'https://music.apple.com/*' });
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs.find((candidate) => candidate.id === activeTab?.id)
        || tabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'Откройте Apple Music, войдите в аккаунт и дождитесь загрузки библиотеки.' });
        return;
      }
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'apple:command',
          requestId,
          action: message.action,
          query: String(message.query || '').slice(0, 400),
          storefront: String(message.storefront || '').slice(0, 2),
          plan: message.action === 'execute-transfer' ? message.plan : undefined,
        });
        sendResponse(response || { ok: false, error: 'Apple Music не вернул результат.' });
      } catch {
        sendResponse({ ok: false, error: 'Расширение не подключено к вкладке Apple Music. Перезагрузите её и повторите.' });
      }
      return;
    }

    if (message?.type === 'yandex:transfer-progress') {
      let origin = '';
      try { origin = new URL(sender.tab?.url || sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || origin !== 'https://music.yandex.ru') {
        sendResponse({ ok: false });
        return;
      }
      const appTabs = await chrome.tabs.query({ url: APP_TAB_URLS });
      await Promise.all(appTabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, {
        type: 'music-importer:yandex-progress',
        requestId: String(message.requestId || ''),
        progress: message.progress,
      }).catch(() => null)));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'music-importer:yandex-command') {
      let origin = '';
      try { origin = new URL(sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || !APP_ORIGINS.has(origin)) {
        sendResponse({ ok: false, error: 'Команда доступна только локальному приложению.' });
        return;
      }
      if (!['search-tracks', 'execute-transfer'].includes(message.action)) {
        sendResponse({ ok: false, error: 'Неизвестная команда Яндекс Музыки.' });
        return;
      }
      const tabs = await chrome.tabs.query({ url: 'https://music.yandex.ru/*' });
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs.find((candidate) => candidate.id === activeTab?.id)
        || tabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'Откройте Яндекс Музыку и войдите в аккаунт, затем повторите.' });
        return;
      }
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'yandex:command',
          action: message.action,
          requestId: String(message.requestId || ''),
          query: message.query,
          plan: message.plan,
        });
        sendResponse(response || { ok: false, error: 'Расширение Яндекс Музыки не вернуло результат.' });
      } catch {
        sendResponse({ ok: false, error: 'Расширение не подключено к вкладке Яндекс Музыки. Перезагрузите её.' });
      }
      return;
    }

    if (message?.type === 'music-importer:get-library') {
      if (message.provider && message.provider !== 'zvuk') {
        sendResponse(await requestProviderLibrary(message.provider, message.refresh === true));
        return;
      }
      const state = await readState();
      const payload = createLibraryPayload(state);
      if (!payload.completeness.confirmed) {
        sendResponse({ error: 'Сначала завершите полный сбор Звука и дождитесь подтверждения лайков и всех плейлистов.' });
        return;
      }
      sendResponse({ payload });
      return;
    }

    if (message?.type === 'music-importer:get-all-libraries') {
      let origin = '';
      try { origin = new URL(sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || !APP_ORIGINS.has(origin)) {
        sendResponse({ error: 'Команда доступна только локальному приложению.' });
        return;
      }
      sendResponse(await requestAllLibraries(message.refresh === true));
      return;
    }

    const providerMessage = /^(spotify|yandex|apple):(?:scan-progress|library-snapshot|scan-error)$/.exec(String(message?.type || ''));
    if (providerMessage) {
      const provider = providerMessage[1] === 'yandex' ? 'yandex-music' : providerMessage[1] === 'apple' ? 'apple-music' : 'spotify';
      const expectedOrigin = provider === 'spotify' ? 'https://open.spotify.com' : provider === 'apple-music' ? 'https://music.apple.com' : 'https://music.yandex.ru';
      let origin = '';
      try { origin = new URL(sender.tab?.url || sender.url || '').origin; } catch { /* Invalid sender URL. */ }
      if (sender.id !== chrome.runtime.id || origin !== expectedOrigin) {
        sendResponse({ ok: false });
        return;
      }
      const state = await readProviderState();
      if (message.type.endsWith(':scan-progress')) {
        state.scans[provider] = { status: 'reading', message: String(message.message || `Читаем ${provider}…`).slice(0, 240), updatedAt: new Date().toISOString() };
      } else if (message.type.endsWith(':scan-error')) {
        state.scans[provider] = { status: 'failed', message: String(message.error || `Не удалось прочитать ${provider}.`).slice(0, 500), updatedAt: new Date().toISOString() };
      } else {
        const payload = message.payload;
        const valid = payload?.service === provider
          && payload?.collection?.type === 'library'
          && payload?.completeness?.confirmed === true
          && payload?.completeness?.favoritesConfirmed === true
          && payload?.completeness?.catalogConfirmed === true
          && (provider !== 'apple-music' || payload?.completeness?.librarySongsConfirmed === true)
          && (provider !== 'yandex-music' || payload?.completeness?.playlistCatalogKindsConfirmed === true)
          && payload?.completeness?.playlistItemsConfirmed === true
          && Array.isArray(payload?.tracks)
          && payload?.completeness?.favoritesCount === payload.tracks.length
          && Array.isArray(payload?.playlists)
          && payload?.completeness?.playlistItemsTotal === payload.playlists.length
          && payload.playlists.every((playlist) => playlist.complete === true && Array.isArray(playlist.tracks)
            && playlist.trackCount === playlist.tracks.length
            && playlist.tracks.every((track, position) => String(track.id || track.providerId || '') !== ''
              && (track.position === undefined || track.position === position)));
        if (!valid) {
          state.scans[provider] = { status: 'failed', message: `${provider} не подтвердил полноту каталога, лайков и плейлистов.`, updatedAt: new Date().toISOString() };
        } else {
          state.snapshots[provider] = payload;
          delete state.previousSnapshots[provider];
          state.scans[provider] = { status: 'complete', message: `Собрано ${payload.tracks.length} лайков и ${payload.playlists.length} плейлистов.`, updatedAt: new Date().toISOString() };
        }
      }
      await writeProviderState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:state') {
      sendResponse(await readState());
      return;
    }

    if (message?.type === 'zvuk:start-library') {
      sendResponse(await startAccountScan(message.tabId));
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
      state.scan = { ...state.scan, active: false, phase: 'stopped', finishedAt: new Date().toISOString() };
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:clear') {
      const state = await readState();
      state.tracks = [];
      state.previousCompleteSnapshot = null;
      state.pagesSeen = 0;
      state.receivedCount = 0;
      state.expectedCount = null;
      state.hasMore = null;
      state.playlists = [];
      state.playlistPagesSeen = 0;
      state.expectedPlaylistCount = null;
      state.playlistListHasMore = null;
      state.favoritesScanFinished = false;
      state.collectionScrollFinished = false;
      state.scan = { active: false, phase: 'idle', tabId: null, startedAt: null };
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
      sendResponse(await beginPlaylistScan(state, message.tabId));
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
      await advanceAccountScan(state);
      return;
    }

    if (message?.type === 'zvuk:favorites-scroll-end') {
      state.favoritesScanFinished = true;
      state.hasMore = false;
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      await advanceAccountScan(state);
      return;
    }

    if (message?.type === 'zvuk:favorites-scroll-stall') {
      state.scan = { ...state.scan, active: false, phase: 'needs_review', error: 'Загрузка избранного остановилась до последней страницы.' };
      state.captureEnabled = false;
      state.error = state.scan.error;
      state.updatedAt = new Date().toISOString();
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
      await advanceAccountScan(state);
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
      await advanceAccountScan(state);
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
      await advanceAccountScan(state);
      return;
    }

    if (message?.type === 'zvuk:collection-scroll-stall') {
      state.scan = { ...state.scan, active: false, phase: 'needs_review', error: 'Каталог плейлистов не загрузился; проверьте вход и повторите сбор.' };
      state.captureEnabled = false;
      state.error = state.scan.error;
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'zvuk:read-error') {
      state.error = 'Звук вернул ошибку при чтении страницы.';
      const current = state.playlists.find((playlist) => playlist.id === state.automation?.currentPlaylistId);
      const atAutomationPlaylist = state.automation?.active && state.automation.tabId === sender.tab?.id;
      if (state.scan?.active && state.scan.tabId === sender.tab?.id && state.scan.phase !== 'playlists_items') {
        state.scan = { ...state.scan, active: false, phase: 'needs_review', error: state.error };
        state.captureEnabled = false;
      }
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
