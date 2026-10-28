const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadMatcher() {
  const context = { window: {}, String, Set, Map, Array, Number, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/matcher.js'), 'utf8'), context);
  return context.window.MusicMatcher;
}

test('catalog query includes album context and keeps a broader fallback', () => {
  const matcher = loadMatcher();
  assert.deepEqual(
    JSON.parse(JSON.stringify(matcher.buildSearchQueries({ title: 'Song', artist: 'Artist', album: 'Album' }))),
    { primary: 'Song Artist Album', fallback: 'Song Artist' },
  );
});

test('catalog query has no duplicate fallback and respects edited search text', () => {
  const matcher = loadMatcher();
  assert.deepEqual(
    JSON.parse(JSON.stringify(matcher.buildSearchQueries({ title: 'Song', artist: 'Artist' }))),
    { primary: 'Song Artist', fallback: '' },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(matcher.buildSearchQueries({ title: 'Song', artist: 'Artist', album: 'Album', query: 'custom query', manualQuery: true }))),
    { primary: 'custom query', fallback: '' },
  );
});

test('catalog query normalizes artist objects from provider snapshots', () => {
  const matcher = loadMatcher();
  assert.deepEqual(
    JSON.parse(JSON.stringify(matcher.buildSearchQueries({ title: 'Song', artists: [{ name: 'Artist A' }, { title: 'Artist B' }], album: 'Album' }))),
    { primary: 'Song Artist A, Artist B Album', fallback: 'Song Artist A, Artist B' },
  );
});

test('matching handles Cyrillic-to-Latin transliteration without relaxing confidence', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Время', artist: 'Моя Мишель', durationMs: 210000 },
    [{ trackId: 'latin-1', trackName: 'Vremya', artistName: 'Moya Mishel', trackTimeMillis: 210500 }],
  );
  assert.equal(result.automatic, true);
  assert.equal(result.best.trackId, 'latin-1');
  assert.equal(result.confidence, 0.98);
});

test('matching ignores featured-title decoration but keeps recording-version checks', () => {
  const matcher = loadMatcher();
  const sameRecording = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Main Artist', durationMs: 180000 },
    [{ trackId: 'feat-1', trackName: 'Song (feat. Guest Artist)', artistName: 'Main Artist, Guest Artist', trackTimeMillis: 180200 }],
  );
  assert.equal(sameRecording.automatic, true);
  const differentVersion = matcher.suggestBestMatch(
    { title: 'Song (Live)', artist: 'Main Artist', durationMs: 180000 },
    [{ trackId: 'studio-1', trackName: 'Song', artistName: 'Main Artist', trackTimeMillis: 180000 }],
  );
  assert.equal(differentVersion.automatic, false);
});

test('matching auto-selects tied catalog editions only when they share the same ISRC', () => {
  const matcher = loadMatcher();
  const sameRecording = matcher.suggestBestMatch(
    { title: 'Blinding Lights', artist: 'The Weeknd' },
    [
      { trackId: 'standard', trackName: 'Blinding Lights', artistName: 'The Weeknd', collectionName: 'After Hours', isrc: 'USUG11904206' },
      { trackId: 'deluxe', trackName: 'Blinding Lights', artistName: 'The Weeknd', collectionName: 'After Hours (Deluxe)', isrc: 'USUG11904206' },
    ],
  );
  assert.equal(sameRecording.automatic, true);
  assert.equal(sameRecording.reason, 'catalog_duplicates_same_isrc');

  const distinctRecordings = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist' },
    [
      { trackId: 'recording-a', trackName: 'Song', artistName: 'Artist', isrc: 'USAAA0000001' },
      { trackId: 'recording-b', trackName: 'Song', artistName: 'Artist', isrc: 'USAAA0000002' },
    ],
  );
  assert.equal(distinctRecordings.automatic, false);
});

test('source recording identity groups repeated library items by ISRC or stable provider ID', () => {
  const matcher = loadMatcher();
  assert.equal(matcher.sourceRecordingKey({ isrc: 'US-ABC-12-34567', sourceId: 'one' }, 'spotify'), 'spotify:isrc:USABC1234567');
  assert.equal(matcher.sourceRecordingKey({ sourceId: 'same-track' }, 'spotify'), 'spotify:id:same-track');
  assert.notEqual(matcher.sourceRecordingKey({ sourceId: 'same-track' }, 'spotify'), matcher.sourceRecordingKey({ sourceId: 'same-track' }, 'apple-music'));
  assert.equal(matcher.sourceRecordingKey({ title: 'Song', artist: 'Artist' }, 'spotify'), '');
});

test('bulk catalog search groups repeated source recordings and keeps edited queries separate', () => {
  const matcher = loadMatcher();
  const source = { sourceId: 'track-1', title: 'Song', artist: 'Artist' };
  const duplicateWithDifferentMetadata = { sourceId: 'track-1', title: 'Song (Remastered)', artist: 'Artist' };
  assert.equal(matcher.sourceSearchGroupKey(source, 'spotify'), matcher.sourceSearchGroupKey(duplicateWithDifferentMetadata, 'spotify'));
  assert.equal(matcher.sourceSearchGroupKey(source, 'spotify'), 'spotify:id:track-1');
  assert.equal(matcher.sourceSearchGroupKey({ ...source, manualQuery: true, query: 'edited search' }, 'spotify'), '');
  assert.notEqual(matcher.sourceSearchGroupKey(source, 'spotify'), matcher.sourceSearchGroupKey(source, 'apple-music'));
  assert.equal(matcher.catalogSearchGroupKey(source, 'spotify', 'zvuk', '', 'Song Artist Album'), 'zvuk:source:spotify:id:track-1');
  assert.equal(matcher.catalogSearchGroupKey(duplicateWithDifferentMetadata, 'spotify', 'zvuk', '', 'other query'), 'zvuk:source:spotify:id:track-1');
  assert.equal(matcher.catalogSearchGroupKey({ ...source, manualQuery: true }, 'spotify', 'apple-music', 'us', 'Edited query'), 'apple-music:US:query:edited query');
  assert.notEqual(matcher.catalogSearchGroupKey(source, 'spotify', 'apple-music', 'us', 'Song'), matcher.catalogSearchGroupKey(source, 'spotify', 'apple-music', 'gb', 'Song'));
});

test('a resolved recording match propagates without replacing playlist occurrence metadata', () => {
  const matcher = loadMatcher();
  const chosen = { sourceId: 'same-track', sourceCollectionId: 'likes', sourcePosition: 2, matches: [{ trackId: 'target' }], match: { trackId: 'target' }, matchConfidence: 0.98, selected: true };
  const duplicate = { sourceId: 'same-track', sourceCollectionId: 'playlist-7', sourcePosition: 4, matches: [], selected: false };
  const unrelated = { sourceId: 'different-track', sourceCollectionId: 'playlist-7', sourcePosition: 5, matches: [], selected: false };
  const affected = matcher.propagateSourceMatch([chosen, duplicate, unrelated], chosen, 'spotify');
  assert.equal(affected.length, 2);
  assert.equal(duplicate.match.trackId, 'target');
  assert.equal(duplicate.selected, true);
  assert.equal(duplicate.sourceCollectionId, 'playlist-7');
  assert.equal(duplicate.sourcePosition, 4);
  assert.equal(unrelated.match, undefined);
  assert.equal(unrelated.selected, false);
});
