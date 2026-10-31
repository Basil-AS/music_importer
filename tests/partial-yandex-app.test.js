const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppHarness } = require('./helpers/app-fixture');

test('app offers only confirmed Yandex likes when playlist discovery failed', async () => {
  const partial = {
    service: 'yandex-music',
    partialScope: 'favorites',
    snapshotCachedAt: new Date().toISOString(),
    collection: { type: 'library', name: 'Только лайки' },
    completeness: {
      confirmed: false, favoritesConfirmed: true, favoritesCount: 2, favoritesRevision: 7,
      catalogConfirmed: false, playlistCatalogKindsConfirmed: false,
      playlistItemsConfirmed: false, playlistItemsTotal: null,
    },
    tracks: [
      { id: 'liked-1', title: 'First', artists: ['Artist'], collectionType: 'favorites', position: 0 },
      { id: 'liked-2', title: 'Second', artists: ['Artist'], collectionType: 'favorites', position: 1 },
    ],
    playlists: [],
  };
  const harness = createAppHarness({
    libraries: {},
    partialLibraries: { 'yandex-music': partial },
    statuses: { 'yandex-music': { status: 'failed', message: 'Не удалось прочитать один плейлист.' } },
  });
  await harness.waitFor(() => harness.$('#matchCount').textContent === '2 треков', 'partial Yandex likes loaded');

  const sourceCard = harness.cards.find((card) => card.dataset.provider === 'yandex-music');
  assert.match(sourceCard.querySelector('.source-status').textContent, /Подтверждены только лайки/);
  assert.equal(sourceCard.querySelector('.source-status').classList.contains('partial'), true);
  assert.equal(sourceCard.querySelector('.source-status').classList.contains('connected'), false);
  assert.match(sourceCard.querySelector('.source-collections').textContent, /Плейлисты: не подтверждены/);
  assert.equal(harness.$('#sourceCollectionSelect').value, 'favorites');
  assert.equal(harness.$('#sourceCollectionSelect').disabled, true);
  assert.deepEqual(harness.$('#sourceCollectionSelect').options.map((option) => option.value), ['favorites']);
  assert.match(harness.$('#reviewSub').textContent, /только лайки, плейлисты не подтверждены/);
});

test('each provider card exposes its own numeric scan progress when the service reports counts', async () => {
  const harness = createAppHarness({
    libraries: {},
    statuses: {
      spotify: { status: 'scanning', phase: 'favorites', message: 'Собираем Spotify Liked Songs: 1000 из 1430.' },
      'yandex-music': { status: 'scanning', phase: 'favorites', message: 'Лайки: загружено 1275 из 4979.' },
      'apple-music': { status: 'scanning', phase: 'playlist-items', message: 'Плейлист 1 из 12: 400 из 1320.' },
    },
    handler: async () => ({ ok: true }),
  });
  const spotify = harness.cards.find((card) => card.dataset.provider === 'spotify').progress;
  const yandex = harness.cards.find((card) => card.dataset.provider === 'yandex-music').progress;
  const apple = harness.cards.find((card) => card.dataset.provider === 'apple-music').progress;
  await harness.waitFor(() => spotify.getAttribute('value') !== null && yandex.getAttribute('value') !== null && apple.getAttribute('value') !== null, 'numeric per-provider progress');

  assert.equal(spotify.getAttribute('max'), '1430');
  assert.equal(spotify.getAttribute('value'), '1000');
  assert.equal(spotify.getAttribute('aria-valuetext'), '1000 из 1430');
  assert.equal(yandex.getAttribute('max'), '4979');
  assert.equal(yandex.getAttribute('value'), '1275');
  assert.equal(yandex.getAttribute('aria-valuetext'), '1275 из 4979');
  assert.equal(apple.getAttribute('max'), '1320');
  assert.equal(apple.getAttribute('value'), '400');
  assert.equal(apple.getAttribute('aria-valuetext'), '400 из 1320');
});

test('legacy watchdog text is shown as a concise provider status', async () => {
  const harness = createAppHarness({
    libraries: {},
    statuses: {
      spotify: {
        status: 'failed',
        message: 'Сбор не сообщал о прогрессе 2 минуты. Неполный снимок не сохранён; нажмите «Обновить открытые аккаунты», чтобы повторить.',
      },
    },
    handler: async () => ({ ok: true }),
  });
  const spotify = harness.cards.find((card) => card.dataset.provider === 'spotify');
  await harness.waitFor(() => /нет прогресса 2 минуты/.test(spotify.status.textContent), 'concise watchdog status');

  assert.equal(spotify.status.textContent, 'Spotify: нет прогресса 2 минуты. Снимок не сохранён.');
});

test('provider watchdog status keeps the last confirmed phase for diagnosis', async () => {
  const harness = createAppHarness({
    libraries: {},
    statuses: {
      spotify: {
        status: 'failed',
        phase: 'favorites',
        message: 'Spotify: нет прогресса 2 минуты. Последний этап — чтение лайков. Снимок не сохранён.',
      },
    },
    handler: async () => ({ ok: true }),
  });
  const spotify = harness.cards.find((card) => card.dataset.provider === 'spotify');
  await harness.waitFor(() => /Последний этап/.test(spotify.status.textContent), 'watchdog last phase');
  assert.equal(spotify.status.textContent, 'Spotify: нет прогресса 2 минуты. Последний этап — чтение лайков. Снимок не сохранён.');
});

test('active library progress is shown on each provider card without a shared toolbar status', async () => {
  let pendingRequests = 0;
  const snapshot = {
    service: 'spotify',
    snapshotCachedAt: new Date().toISOString(),
    collection: { type: 'library', name: 'Library' },
    completeness: {
      confirmed: true, favoritesConfirmed: true, favoritesCount: 1,
      catalogConfirmed: true, playlistItemsConfirmed: true, playlistItemsTotal: 0,
    },
    tracks: [{ id: 'spotify:track:one', title: 'One', artists: ['Artist'] }],
    playlists: [],
  };
  const harness = createAppHarness({
    libraries: { spotify: snapshot },
    statuses: {
      zvuk: { status: 'scanning', phase: 'favorites', message: 'Сбер.Звук: страница 1.' },
      spotify: { status: 'scanning', phase: 'favorites', message: 'Собираем Spotify Liked Songs: 1 из 3.' },
      'yandex-music': { status: 'scanning', phase: 'favorites', message: 'Лайки: загружено 2 из 5.' },
      'apple-music': { status: 'scanning', phase: 'playlist-items', message: 'Плейлист 1 из 2.' },
    },
    pending: () => pendingRequests++ === 0,
    handler: async () => ({ ok: true }),
  });
  const spotify = harness.cards.find((card) => card.dataset.provider === 'spotify');
  const yandex = harness.cards.find((card) => card.dataset.provider === 'yandex-music');
  await harness.waitFor(() => (
    spotify.progress.getAttribute('value') === '1'
    && yandex.progress.getAttribute('value') === '2'
    && harness.$('#extensionStatus').textContent === ''
  ), 'independent progress without a shared status');

  assert.match(spotify.status.textContent, /Spotify Liked Songs: 1 из 3/);
  assert.match(yandex.status.textContent, /Лайки: загружено 2 из 5/);
  assert.equal(spotify.progress.getAttribute('max'), '3');
  assert.equal(yandex.progress.getAttribute('max'), '5');
});

test('completed scans keep each provider result in its card without an aggregate status or toast', async () => {
  const snapshot = {
    service: 'spotify',
    snapshotCachedAt: new Date().toISOString(),
    collection: { type: 'library', name: 'Library' },
    completeness: { confirmed: true, favoritesConfirmed: true, favoritesCount: 1, catalogConfirmed: true, playlistItemsConfirmed: true, playlistItemsTotal: 0 },
    tracks: [{ id: 'spotify:track:one', title: 'One', artists: ['Artist'] }],
    playlists: [],
  };
  const harness = createAppHarness({
    libraries: { spotify: snapshot },
    statuses: {
      spotify: { status: 'ready', message: 'Библиотека Spotify загружена.' },
      zvuk: { status: 'failed', message: 'Ошибка чтения коллекции.' },
      'yandex-music': { status: 'unavailable', message: 'Войдите в аккаунт Яндекс.Музыки.' },
      'apple-music': { status: 'failed', message: 'Не удалось прочитать плейлист.' },
    },
    handler: async () => ({ ok: true }),
  });

  await harness.waitFor(() => (
    harness.sent.some((message) => message.type === 'music-importer:get-all-libraries')
    && !harness.$('#extensionImportBtn').disabled
  ), 'provider scan completion');

  assert.equal(harness.$('#extensionStatus').textContent, '');
  assert.equal(harness.$('#toast').textContent, '');
  assert.match(harness.cards.find((card) => card.dataset.provider === 'zvuk').status.textContent, /Ошибка чтения коллекции/);
  assert.match(harness.cards.find((card) => card.dataset.provider === 'yandex-music').status.textContent, /Войдите в аккаунт/);
  assert.match(harness.cards.find((card) => card.dataset.provider === 'apple-music').status.textContent, /Не удалось прочитать плейлист/);
});
