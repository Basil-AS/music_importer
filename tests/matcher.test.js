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

test('matching keeps title-and-artist-only candidates for review without recording evidence', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist' },
    [{ trackId: 'unknown-edition', trackName: 'Song', artistName: 'Artist' }],
  );
  assert.equal(result.confidence, 0.98);
  assert.equal(result.automatic, false);
  assert.equal(result.reason, 'manual_review');
});

test('matching can auto-select title-and-artist candidates corroborated by album metadata', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist', album: 'Album' },
    [{ trackId: 'album-confirmed', trackName: 'Song', artistName: 'Artist', collectionName: 'Album' }],
  );
  assert.equal(result.automatic, true);
  assert.equal(result.reason, 'high_confidence_metadata');
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

test('matching keeps explicitly different featured artists in the manual-review queue', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Song (feat. Guest Artist)', artist: 'Main Artist', album: 'Album', durationMs: 180000 },
    [{
      trackId: 'other-feature',
      trackName: 'Song (feat. Different Guest)',
      artistName: 'Main Artist',
      collectionName: 'Album',
      trackTimeMillis: 180000,
    }],
  );

  assert.equal(result.ranked[0].featuredConflict, true);
  assert.equal(result.automatic, false);
  assert.equal(result.reason, 'manual_review');

  const partialCredit = matcher.suggestBestMatch(
    { title: 'Song (feat. Guest Artist & Second Guest)', artist: 'Main Artist', album: 'Album', durationMs: 180000 },
    [{
      trackId: 'partial-feature-list',
      trackName: 'Song (feat. Guest Artist)',
      artistName: 'Main Artist',
      collectionName: 'Album',
      trackTimeMillis: 180000,
    }],
  );
  assert.equal(partialCredit.ranked[0].featuredConflict, true);
  assert.equal(partialCredit.automatic, false);
});

test('an exact ISRC does not auto-select a conflicting recording version', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Song (Live)', artist: 'Artist', isrc: 'USAAA0000001' },
    [{ trackId: 'studio', trackName: 'Song', artistName: 'Artist', isrc: 'USAAA0000001' }],
  );
  assert.equal(result.best.trackId, 'studio');
  assert.equal(result.ranked[0].exactISRC, true);
  assert.equal(result.ranked[0].versionConflict, true);
  assert.equal(result.automatic, false);
  assert.equal(result.reason, 'manual_review');
});

test('a safe exact-ISRC result outranks conflicting catalog duplicates', () => {
  const matcher = loadMatcher();
  const source = { title: 'Song', artist: 'Artist', album: 'Studio', durationMs: 180000, isrc: 'USABC1234567' };
  const suggestion = matcher.suggestBestMatch(source, [
    { trackId: 'conflicting-live', trackName: 'Song (Live)', artistName: 'Artist', collectionName: 'Live Album', trackTimeMillis: 190000, isrc: 'USABC1234567' },
    { trackId: 'correct-studio', trackName: 'Song', artistName: 'Artist', collectionName: 'Studio', trackTimeMillis: 180000, isrc: 'USABC1234567' },
  ]);
  assert.equal(suggestion.best.trackId, 'correct-studio');
  assert.equal(suggestion.automatic, true);
});

test('exact ISRC with strongly conflicting title, artist, or duration stays in manual review', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Our Song', artist: 'Our Artist', album: 'Our Album', durationMs: 180000, isrc: 'USABC1234567' },
    [{
      trackId: 'reused-isrc', trackName: 'Completely Different', artistName: 'Another Artist',
      collectionName: 'Another Album', trackTimeMillis: 230000, isrc: 'USABC1234567',
    }],
  );
  assert.equal(result.best.trackId, 'reused-isrc', 'keep the exact-code candidate available for deliberate review');
  assert.equal(result.ranked[0].exactISRC, true);
  assert.equal(result.ranked[0].isrcMetadataConflict, true);
  assert.equal(result.automatic, false);
  assert.equal(result.reason, 'isrc_metadata_conflict');
});

test('exact ISRC tolerates harmless title credit and album differences', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist', album: 'Original Album', durationMs: 180000, isrc: 'USABC1234567' },
    [{
      trackId: 'same-recording', trackName: 'Song (feat. Guest Artist)', artistName: 'Artist, Guest Artist',
      collectionName: 'Compilation', trackTimeMillis: 180400, isrc: 'USABC1234567',
    }],
  );
  assert.equal(result.ranked[0].isrcMetadataConflict, false);
  assert.equal(result.automatic, true);
  assert.equal(result.reason, 'exact_isrc');
});

test('matching never auto-selects an exact metadata candidate with a conflicting ISRC', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist', album: 'Album', durationMs: 180000, isrc: 'USAAA0000001' },
    [{ trackId: 'different-recording', trackName: 'Song', artistName: 'Artist', collectionName: 'Album', trackTimeMillis: 180000, isrc: 'USBBB0000002' }],
  );
  assert.equal(result.best.trackId, 'different-recording', 'keep the candidate visible for a deliberate manual decision');
  assert.equal(result.ranked[0].isrcConflict, true);
  assert.equal(result.automatic, false);
  assert.equal(result.reason, 'manual_review');
});

test('matching auto-selects tied catalog editions only when ISRC or metadata confirms the same recording', () => {
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

test('matching auto-selects duplicate no-ISRC editions with exact title, artist, album, and duration', () => {
  const matcher = loadMatcher();
  const result = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist', album: 'Album', durationMs: 180000 },
    [
      { trackId: 'edition-a', trackName: 'Song', artistName: 'Artist', collectionName: 'Album', trackTimeMillis: 180000 },
      { trackId: 'edition-b', trackName: 'Song', artistName: 'Artist', collectionName: 'Album', trackTimeMillis: 180100 },
    ],
  );
  assert.equal(result.automatic, true);
  assert.equal(result.reason, 'catalog_duplicates_same_metadata');
});

test('matching keeps no-ISRC duplicates for review when duration or ISRCs conflict', () => {
  const matcher = loadMatcher();
  const durationConflict = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist', album: 'Album', durationMs: 180000 },
    [
      { trackId: 'edition-a', trackName: 'Song', artistName: 'Artist', collectionName: 'Album', trackTimeMillis: 185000 },
      { trackId: 'edition-b', trackName: 'Song', artistName: 'Artist', collectionName: 'Album', trackTimeMillis: 185100 },
    ],
  );
  assert.equal(durationConflict.automatic, false);

  const isrcConflict = matcher.suggestBestMatch(
    { title: 'Song', artist: 'Artist', album: 'Album', durationMs: 180000 },
    [
      { trackId: 'recording-a', trackName: 'Song', artistName: 'Artist', collectionName: 'Album', trackTimeMillis: 180000, isrc: 'USAAA0000001' },
      { trackId: 'recording-b', trackName: 'Song', artistName: 'Artist', collectionName: 'Album', trackTimeMillis: 180000, isrc: 'USAAA0000002' },
    ],
  );
  assert.equal(isrcConflict.automatic, false);
});

test('source recording identity groups repeated library items by ISRC or stable provider ID', () => {
  const matcher = loadMatcher();
  assert.equal(matcher.sourceRecordingKey({ isrc: 'US-ABC-12-34567', sourceId: 'one' }, 'spotify'), 'spotify:isrc:USABC1234567');
  assert.notEqual(
    matcher.sourceRecordingKey({ isrc: 'USABC1234567', title: 'Song (Live)' }, 'spotify'),
    matcher.sourceRecordingKey({ isrc: 'USABC1234567', title: 'Song' }, 'spotify'),
    'same ISRC must not merge library entries with conflicting recording versions',
  );
  assert.equal(
    matcher.sourceRecordingKey({ isrc: 'USABC1234567', title: 'Song (Live)' }, 'spotify'),
    matcher.sourceRecordingKey({ isrc: 'USABC1234567', title: 'Song (Live)', album: 'Deluxe' }, 'spotify'),
    'edition labels without a recording-version marker should still share an ISRC group',
  );
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

test('a match does not propagate between same-ISRC source tracks with conflicting versions', () => {
  const matcher = loadMatcher();
  const live = { sourceId: 'source-live', isrc: 'USABC1234567', title: 'Song (Live)', match: { trackId: 'target-live' }, selected: true };
  const studio = { sourceId: 'source-studio', isrc: 'USABC1234567', title: 'Song', match: null, selected: false };
  const affected = matcher.propagateSourceMatch([live, studio], live, 'spotify');
  assert.deepEqual(affected, [live]);
  assert.equal(studio.match, null);
  assert.equal(studio.selected, false);
});
