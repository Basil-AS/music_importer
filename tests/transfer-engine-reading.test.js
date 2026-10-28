const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadEngine() {
  const context = { window: {}, Date, Map, Set, String, Number, Array, Object, Error, DOMException };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/transfer-engine.js'), 'utf8'), context, {
    filename: 'transfer-engine.js',
  });
  return context.window.MusicTransferEngine;
}

test('a completed playlist checkpoint returns its saved items without reading pages again', async () => {
  const engine = loadEngine();
  const checkpoints = [];
  let readCalls = 0;
  const adapter = {
    id: 'spotify',
    async readCollectionPage({ cursor }) {
      readCalls += 1;
      if (cursor === null) return {
        items: [{ providerId: 'track-1', title: 'One', position: 0 }],
        nextCursor: 'page-2', hasMore: true, totalCount: 2, offset: 0,
      };
      return {
        items: [{ providerId: 'track-2', title: 'Two', position: 1 }],
        nextCursor: null, hasMore: false, totalCount: 2, offset: 1,
      };
    },
  };
  const collection = { id: 'playlist-1', type: 'playlists', name: 'Road' };
  const first = await engine.readCompleteCollection(adapter, collection, {
    pageSize: 1,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });

  assert.equal(first.collections[0].items.length, 2);
  assert.equal(first.collections[0].completeness.confirmed, true);
  assert.equal(checkpoints.at(-1).completed, true);
  assert.equal(readCalls, 2);

  const resumed = await engine.readCompleteCollection(adapter, collection, { checkpoint: checkpoints.at(-1) });
  assert.equal(readCalls, 2);
  assert.equal(resumed.collections[0].items.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.collections[0].items.map((item) => item.track.providerId))), ['track-1', 'track-2']);
  assert.equal(resumed.collections[0].completeness.confirmed, true);
});

test('a completed collection-discovery checkpoint does not refetch the catalog', async () => {
  const engine = loadEngine();
  const checkpoints = [];
  let readCalls = 0;
  const adapter = {
    id: 'apple-music',
    async discoverCollectionPage() {
      readCalls += 1;
      return { collections: [{ id: 'playlist-1', type: 'playlists', name: 'Road' }], nextCursor: null, hasMore: false, totalCount: 1 };
    },
  };
  const first = await engine.discoverAllCollections(adapter, { onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) });
  assert.equal(first.collections.length, 1);
  assert.equal(checkpoints.at(-1).completed, true);
  assert.equal(readCalls, 1);

  const resumed = await engine.discoverAllCollections(adapter, { checkpoint: checkpoints.at(-1) });
  assert.equal(readCalls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.collections.map((collection) => collection.id))), ['playlist-1']);
  assert.equal(resumed.completeness.confirmed, true);
});
