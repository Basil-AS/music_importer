const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadAccountCatalog() {
  const context = { window: {}, String, Number, Array, Map, Set, Object, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/matcher.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/account-catalog.js'), 'utf8'), context);
  return context.window.MusicAccountCatalog;
}

test('complete target snapshots index favorite and playlist tracks by exact ISRC for every provider', () => {
  const accountCatalog = loadAccountCatalog();
  const fixtures = [
    ['apple-music', { catalogId: 'catalog-apple-1', id: 'library-apple-1', title: 'Song', artist: 'Artist', isrc: 'US-ABC-1234567' }],
    ['spotify', { id: 'spotify:track:1', title: 'Song', artists: [{ name: 'Artist' }], isrc: 'USABC1234567' }],
    ['yandex-music', { id: 'yandex-1', title: 'Song', artists: ['Artist'], isrc: 'USABC1234567' }],
    ['zvuk', { id: 'zvuk-1', title: 'Song', artists: [{ title: 'Artist' }], isrc: 'USABC1234567' }],
  ];

  for (const [provider, sourceTrack] of fixtures) {
    const snapshotTrack = provider === 'apple-music'
      ? sourceTrack
      : sourceTrack;
    const index = accountCatalog.buildIndex({
      service: provider,
      completeness: { confirmed: true },
      tracks: [],
      playlists: [{ tracks: [snapshotTrack, snapshotTrack] }],
    }, provider);
    const candidates = accountCatalog.findByISRC(index, { isrc: 'USABC1234567' });
    assert.equal(candidates.length, 1, provider);
    assert.equal(candidates[0].isrc, 'USABC1234567', provider);
    assert.equal(candidates[0].trackId, provider === 'apple-music' ? 'catalog-apple-1' : sourceTrack.id, provider);
    assert.equal(candidates[0].artistName, 'Artist', provider);
  }
});

test('account catalog index refuses incomplete snapshots and never guesses without ISRC', () => {
  const accountCatalog = loadAccountCatalog();
  const snapshot = {
    service: 'spotify',
    completeness: { confirmed: false },
    tracks: [{ id: 'spotify:track:1', title: 'Song', artists: ['Artist'], isrc: 'USABC1234567' }],
    playlists: [],
  };
  const index = accountCatalog.buildIndex(snapshot, 'spotify');
  assert.deepEqual(Array.from(index.keys()), []);
  assert.equal(accountCatalog.findByISRC(index, { title: 'Song', artist: 'Artist' }).length, 0);
});

test('source summary distinguishes favorites from the full Apple Music library', () => {
  const accountCatalog = loadAccountCatalog();
  assert.equal(accountCatalog.snapshotSummary({
    tracks: [],
    playlists: Array.from({ length: 12 }, () => ({})),
    completeness: { librarySongsCount: 4956 },
  }), '0 лайков · 4956 треков в медиатеке · 12 плейлистов');
  assert.equal(accountCatalog.snapshotSummary({
    tracks: [{ id: 'favorite-1' }],
    playlists: [],
    completeness: { librarySongsCount: 1 },
  }), '1 лайк · 0 плейлистов');
  assert.equal(accountCatalog.snapshotSummary({ tracks: [{ id: 'favorite-1' }], playlists: [{}] }), '1 лайк · 1 плейлист');
});

test('full target snapshot resolves a 10,000-track transfer without catalog searches, leaving misses and manual queries queued', () => {
  const accountCatalog = loadAccountCatalog();
  const targetTracks = Array.from({ length: 10_000 }, (_, index) => ({
    id: `target-${index}`,
    title: `Song ${index}`,
    artists: ['Artist'],
    isrc: `USABC${String(index).padStart(7, '0')}`,
  }));
  const snapshot = {
    service: 'spotify',
    completeness: { confirmed: true },
    tracks: targetTracks,
    playlists: [],
  };
  const sourceTracks = targetTracks.map((track) => ({ title: track.title, artist: 'Artist', isrc: track.isrc }));
  sourceTracks.push({ title: 'Unindexed', artist: 'Artist', isrc: 'USABC9999999' });
  sourceTracks.push({ title: 'Manual query', artist: 'Artist', isrc: targetTracks[0].isrc, manualQuery: true });

  const index = accountCatalog.buildIndex(snapshot, 'spotify');
  const resolution = accountCatalog.resolveTracks(sourceTracks, index);
  assert.equal(resolution.matches.size, 10_000);
  assert.equal(resolution.unresolved.length, 2);
  assert.equal(resolution.matches.get(sourceTracks[0])[0].trackId, 'target-0');
  assert.equal(resolution.unresolved[1].manualQuery, true);
});

test('full target snapshots resolve 10,000 no-ISRC metadata matches for every provider', () => {
  const accountCatalog = loadAccountCatalog();
  const providers = ['apple-music', 'spotify', 'yandex-music', 'zvuk'];

  for (const provider of providers) {
    const targetTracks = Array.from({ length: 10_000 }, (_, index) => {
      const title = `Catalogue Song ${index}`;
      const artist = `Artist ${index % 30}`;
      const album = `Album ${index % 200}`;
      const durationMs = 160000 + index;
      const common = { title, durationMs, isrc: '' };
      if (provider === 'apple-music') return { ...common, catalogId: `apple-${index}`, artist, album };
      if (provider === 'spotify') return { ...common, id: `spotify-${index}`, artists: [{ name: artist }], album: { name: album } };
      if (provider === 'yandex-music') return { ...common, id: `yandex-${index}`, artists: [artist], album };
      return { ...common, id: `zvuk-${index}`, artists: [{ title: artist }], release: { title: album } };
    });
    const sourceTracks = targetTracks.map((track) => ({
      title: track.title,
      artist: provider === 'apple-music' ? track.artist : provider === 'spotify' ? track.artists[0].name
        : provider === 'yandex-music' ? track.artists[0] : track.artists[0].title,
      album: provider === 'apple-music' || provider === 'yandex-music' ? track.album
        : provider === 'spotify' ? track.album.name : track.release.title,
      durationMs: track.durationMs,
    }));
    const index = accountCatalog.buildIndex({
      service: provider,
      completeness: { confirmed: true },
      tracks: targetTracks,
      playlists: [],
    }, provider);
    const resolution = accountCatalog.resolveTracks(sourceTracks, index);

    assert.equal(resolution.matches.size, 10_000, provider);
    assert.equal(resolution.unresolved.length, 0, provider);
    assert.equal(resolution.matches.get(sourceTracks[9_999])[0].trackId, `${provider === 'apple-music' ? 'apple' : provider === 'yandex-music' ? 'yandex' : provider}-${9_999}`, provider);
  }
});

test('target account metadata auto-matches exact-title transliterations only above the matcher confidence threshold', () => {
  const accountCatalog = loadAccountCatalog();
  const index = accountCatalog.buildIndex({
    service: 'spotify',
    completeness: { confirmed: true },
    tracks: [
      { id: 'spotify:track:romanized', title: 'Vremya', artists: ['Moya Mishel'], album: 'Zima', isrc: '' },
      { id: 'spotify:track:ambiguous', title: 'Vremya', artists: ['Moya Mishel'], album: 'Vremya (Live)', isrc: '' },
      { id: 'spotify:track:same-a', title: 'Same Name', artists: ['Artist'], album: 'Album A', isrc: '' },
      { id: 'spotify:track:same-b', title: 'Same Name', artists: ['Artist'], album: 'Album B', isrc: '' },
    ],
    playlists: [],
  }, 'spotify');
  const exact = { title: 'Время', artist: 'Моя Мишель', album: 'Зима' };
  const manual = { ...exact, manualQuery: true };
  const unmatched = { title: 'Different track', artist: 'Artist' };
  const ambiguous = { title: 'Same Name', artist: 'Artist' };
  const resolution = accountCatalog.resolveTracks([exact, manual, unmatched, ambiguous], index);

  assert.equal(resolution.matches.has(exact), true);
  assert.equal(resolution.matches.get(exact)[0].trackId, 'spotify:track:romanized');
  assert.equal(resolution.matches.has(manual), false);
  assert.equal(resolution.unresolved.length, 3);
  assert.equal(resolution.unresolved.includes(ambiguous), true);
});

test('target account matching finds equivalent titles when only one service embeds featured artists in the title', () => {
  const accountCatalog = loadAccountCatalog();
  const index = accountCatalog.buildIndex({
    service: 'spotify',
    completeness: { confirmed: true },
    tracks: [{
      id: 'spotify:track:featured',
      title: 'Song',
      artists: ['Main Artist', 'Guest Artist'],
      album: { name: 'Album' },
      durationMs: 180000,
      isrc: '',
    }],
    playlists: [],
  }, 'spotify');
  const source = {
    title: 'Song (feat. Guest Artist)',
    artist: 'Main Artist',
    album: 'Album',
    durationMs: 180200,
  };
  const resolution = accountCatalog.resolveTracks([source], index);

  assert.equal(resolution.matches.get(source)?.[0]?.trackId, 'spotify:track:featured');
  assert.equal(resolution.unresolved.length, 0);
});

test('Zvuk release metadata preserves live-version conflicts in no-ISRC account matching', () => {
  const accountCatalog = loadAccountCatalog();
  const index = accountCatalog.buildIndex({
    service: 'zvuk',
    completeness: { confirmed: true },
    tracks: [{
      id: 'zvuk-live',
      title: 'Song',
      artists: [{ title: 'Artist' }],
      release: { title: 'Song (Live)' },
      isrc: '',
    }],
    playlists: [],
  }, 'zvuk');
  const source = { title: 'Song', artist: 'Artist', album: 'Song' };
  const resolution = accountCatalog.resolveTracks([source], index);

  assert.equal(resolution.matches.has(source), false);
  assert.equal(resolution.unresolved[0], source);
});

test('no-ISRC metadata matches normalize catalog IDs and artist/album fields for all four providers', () => {
  const accountCatalog = loadAccountCatalog();
  const fixtures = [
    ['apple-music', { catalogId: 'apple-catalog-1', title: 'Song', artist: 'Artist', album: 'Album', isrc: '' }],
    ['spotify', { id: 'spotify:track:1', title: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album' }, isrc: '' }],
    ['yandex-music', { id: 'yandex-track-1', title: 'Song', artists: ['Artist'], album: 'Album', isrc: '' }],
    ['zvuk', { id: 'zvuk-track-1', title: 'Song', artists: [{ title: 'Artist' }], release: { title: 'Album' }, isrc: '' }],
  ];

  for (const [provider, targetTrack] of fixtures) {
    const index = accountCatalog.buildIndex({
      service: provider,
      completeness: { confirmed: true },
      tracks: [targetTrack],
      playlists: [],
    }, provider);
    const source = { title: 'Song', artist: 'Artist', album: 'Album' };
    const resolution = accountCatalog.resolveTracks([source], index);
    const expectedTargetId = provider === 'apple-music' ? 'apple-catalog-1' : targetTrack.id;

    assert.equal(resolution.matches.get(source)?.[0]?.trackId, expectedTargetId, provider);
    assert.equal(resolution.unresolved.length, 0, provider);
  }
});
