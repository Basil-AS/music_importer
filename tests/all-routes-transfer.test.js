const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const providers = ['spotify', 'apple-music', 'yandex-music', 'zvuk'];

function loadTransferModules() {
  const context = {
    window: {}, Date, Map, Set, String, Number, Array, Object, Error,
    structuredClone, DOMException,
  };
  for (const file of ['transfer-core.js', 'transfer-engine.js']) {
    vm.runInNewContext(fs.readFileSync(require.resolve(`../demo/${file}`), 'utf8'), context, { filename: file });
  }
  return { core: context.window.MusicTransferCore, engine: context.window.MusicTransferEngine };
}

function makeCompleteSource(provider) {
  return {
    provider,
    completeness: { confirmed: true },
    collections: [
      {
        id: 'favorites', type: 'favorites', name: 'Liked', itemCount: 1,
        completeness: { confirmed: true },
        items: [{ position: 0, track: { providerId: `${provider}:like`, title: 'Liked track', artist: 'Artist' } }],
      },
      {
        id: 'playlist-road', type: 'playlists', name: 'Road', itemCount: 1,
        completeness: { confirmed: true },
        items: [{ position: 0, track: { providerId: `${provider}:road`, title: 'Road track', artist: 'Artist', collectionId: 'playlist-road', collectionName: 'Road' } }],
      },
      {
        id: 'playlist-empty', type: 'playlists', name: 'Empty', itemCount: 0,
        completeness: { confirmed: true },
        items: [],
      },
    ],
  };
}

function makeMemoryTarget(provider) {
  const favorites = new Map();
  const playlists = new Map();
  let playlistSequence = 0;
  return {
    id: provider,
    async readDestination({ collectionType }) {
      return { complete: true, items: collectionType === 'favorites' ? [...favorites.values()] : [...playlists.values()] };
    },
    async writeFavorites(items) {
      for (const item of items) favorites.set(String(item.providerId), item);
      return { writtenCount: items.length };
    },
    async createPlaylist({ name }) {
      const playlist = { id: `${provider}:playlist:${++playlistSequence}`, name, items: [] };
      playlists.set(playlist.id, playlist);
      return playlist;
    },
    async writePlaylistItems(playlistId, items) {
      const playlist = playlists.get(playlistId);
      assert.ok(playlist, `Target playlist ${playlistId} must exist`);
      playlist.items.push(...items);
      return { writtenCount: items.length };
    },
    async readBack({ type, playlistId, operations }) {
      if (type === 'favorites') return { complete: true, items: [...favorites.values()] };
      const playlist = playlists.get(playlistId);
      return {
        complete: true,
        collectionPresent: Boolean(playlist),
        verifiedCount: playlist?.items.length || 0,
        items: playlist?.items || [],
        expectedCount: operations.length,
      };
    },
    result() { return { favorites: [...favorites.values()], playlists: [...playlists.values()] }; },
  };
}

for (const source of providers) {
  for (const target of providers) {
    if (source === target) continue;
    test(`executes likes and playlists from ${source} to ${target}`, async () => {
      const { core, engine } = loadTransferModules();
      const sourceSnapshot = makeCompleteSource(source);
      const plan = core.createTransferPlan({
        sourceSnapshot,
        targetProvider: target,
        targetCollectionType: 'library',
        tracks: [
          {
            title: 'Liked track', artist: 'Artist', sourceCollectionType: 'favorites', selected: true,
            match: { trackId: `${target}:like` }, matchReason: 'exact_isrc', matchConfidence: 1, autoMatched: true,
          },
          {
            title: 'Road track', artist: 'Artist', sourceCollectionType: 'playlists',
            sourceCollectionId: 'playlist-road', sourceCollectionName: 'Road', sourcePosition: 0,
            selected: true, match: { trackId: `${target}:road` }, matchReason: 'exact_isrc', matchConfidence: 1, autoMatched: true,
          },
        ],
      });
      const adapter = makeMemoryTarget(target);
      const report = await engine.executeTransferPlan(adapter, plan, { confirmed: true });
      const result = adapter.result();

      assert.equal(report.status, 'complete');
      assert.equal(report.writesPerformed, 2);
      assert.equal(report.verified, 2);
      assert.equal(report.collectionsExpected, 2);
      assert.equal(report.collectionsVerified, 2);
      assert.deepEqual(result.favorites.map((track) => track.providerId), [`${target}:like`]);
      assert.deepEqual(result.playlists.map((playlist) => playlist.name), ['Road', 'Empty']);
      assert.deepEqual(result.playlists.map((playlist) => playlist.items.map((track) => track.providerId)), [[`${target}:road`], []]);
    });
  }
}
