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
