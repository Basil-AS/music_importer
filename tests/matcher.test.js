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
