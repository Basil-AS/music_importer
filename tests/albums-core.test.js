const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function load(file) {
  const context = { window: {}, Date, Map, Set, String, Number, Array, Object, Error, JSON, Promise, DOMException, structuredClone, setTimeout, clearTimeout, Math, RegExp, TypeError, Boolean, Symbol };
  vm.runInNewContext(fs.readFileSync(require.resolve(`../demo/${file}`), 'utf8'), context);
  return context.window;
}

const providers = ['spotify', 'apple-music', 'yandex-music', 'zvuk'];

test('album collections keep album refs separate from tracks', () => {
  const { MusicTransferCore: core } = load('transfer-core.js');
  const snapshot = core.createSnapshot({
    provider: 'spotify',
    completeness: { confirmed: true },
    collections: [{
      id: 'albums', type: 'albums', name: 'Альбомы', itemCount: 1, completeness: { confirmed: true },
      items: [{ position: 0, album: { id: 'a1', title: 'Album', artists: ['Artist'], upc: '00 123-4', trackCount: 9 } }],
    }],
  });
  const [item] = snapshot.collections[0].items;
  assert.equal(item.track, undefined);
  assert.deepEqual({ ...item.album, artists: [...item.album.artists] }, {
    provider: 'spotify', providerId: 'a1', upc: '001234', title: 'Album', artists: ['Artist'], trackCount: 9,
    releaseDate: null, artworkUrl: null, collectionType: 'albums', position: 0,
  });
  assert.equal(snapshot.completeness.confirmed, true);
});

for (const source of providers) {
  for (const target of providers) {
    if (source === target) continue;
    test(`${source} to ${target}: albums are written as albums and verified`, async () => {
      const { MusicTransferCore: core } = load('transfer-core.js');
      const { MusicTransferEngine: engine } = load('transfer-engine.js');
      const sourceSnapshot = core.createSnapshot({
        provider: source, completeness: { confirmed: true },
        collections: [{ id: 'albums', type: 'albums', name: 'Альбомы', itemCount: 1, completeness: { confirmed: true },
          items: [{ position: 0, album: { id: 's1', title: 'Album', artists: ['Artist'] } }] }],
      });
      const plan = core.createTransferPlan({
        sourceSnapshot, targetProvider: target, targetCollectionType: 'library', tracks: [],
        albums: [{ id: 's1', title: 'Album', artists: ['Artist'], selected: true, autoMatched: true, matchReason: 'exact_upc', match: { albumId: 't1', title: 'Album', artists: ['Artist'] } }],
      });
      assert.equal(plan.operations.length, 1);
      assert.equal(plan.operations[0].operation, 'add_album');
      const saved = new Set();
      const adapter = {
        id: target,
        async readDestination() { return { complete: true, items: [...saved].map((id) => ({ providerId: id })) }; },
        async writeAlbums(items) { items.forEach((item) => saved.add(item.providerId)); return { writtenCount: items.length }; },
        async readBack() { return { complete: true, items: [...saved].map((id) => ({ providerId: id })) }; },
      };
      const report = await engine.executeTransferPlan(adapter, plan, { confirmed: true });
      assert.equal(report.status, 'complete');
      assert.equal(report.verified, 1);
      assert.deepEqual([...saved], ['t1']);
    });
  }
}
