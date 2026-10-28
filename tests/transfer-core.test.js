const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const providers = ['spotify', 'apple-music', 'yandex-music', 'zvuk'];

function loadCore() {
  const context = { window: {}, Date, Map, Set, String, Number, Array, Object, Error };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/transfer-core.js'), 'utf8'), context);
  return context.window.MusicTransferCore;
}

for (const source of providers) {
  for (const target of providers) {
    if (source === target) continue;
    test(`transfer plan maps favorites and playlist items from ${source} to ${target}`, () => {
      const core = loadCore();
      const sourceSnapshot = {
        provider: source,
        completeness: { confirmed: true },
        collections: [
          {
            id: 'favorites', type: 'favorites', name: 'Liked', itemCount: 1,
            completeness: { confirmed: true },
            items: [{ position: 0, track: { providerId: 'source-like', title: 'Liked track', artist: 'Artist' } }],
          },
          {
            id: 'playlist-1', type: 'playlists', name: 'Road', itemCount: 1,
            completeness: { confirmed: true },
            items: [{ position: 0, track: { providerId: 'source-playlist-track', title: 'Playlist track', artist: 'Artist', collectionId: 'playlist-1', collectionName: 'Road' } }],
          },
        ],
      };
      const plan = core.createTransferPlan({
        sourceSnapshot,
        targetProvider: target,
        targetCollectionType: 'library',
        tracks: [
          {
            title: 'Liked track', artist: 'Artist', sourceCollectionType: 'favorites',
            selected: true, match: { trackId: `${target}:liked` }, matchReason: 'exact_isrc', matchConfidence: 1, autoMatched: true,
          },
          {
            title: 'Playlist track', artist: 'Artist', sourceCollectionType: 'playlists',
            sourceCollectionId: 'playlist-1', sourceCollectionName: 'Road', sourcePosition: 0,
            selected: true, match: { trackId: `${target}:playlist` }, matchReason: 'exact_isrc', matchConfidence: 1, autoMatched: true,
          },
        ],
      });

      assert.equal(plan.source.provider, source);
      assert.equal(plan.target.provider, target);
      assert.deepEqual(Array.from(plan.operations, (operation) => operation.operation), ['add_to_favorites', 'add_to_playlist']);
      assert.deepEqual(Array.from(plan.operations, (operation) => operation.target.providerId), [`${target}:liked`, `${target}:playlist`]);
      assert.equal(plan.collectionMappings[0].targetName, 'Road');
      assert.equal(plan.execution.writesPerformed, 0);
    });
  }
}

test('transfer plan rejects selecting the source service as its own destination', () => {
  const core = loadCore();
  assert.throws(() => core.createTransferPlan({
    sourceSnapshot: { provider: 'zvuk' },
    targetProvider: 'zvuk',
    targetCollectionType: 'favorites',
    tracks: [],
  }), /Источник и цель должны быть разными/);
});
