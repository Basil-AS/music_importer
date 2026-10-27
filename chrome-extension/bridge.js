(() => {
  const marker = 'music-importer-zvuk';

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const { type, ...detail } = event.data;
    if (!['favorite-page', 'favorites-scroll-end', 'favorites-scroll-stall', 'collection-count', 'read-error', 'playlist-list-page', 'playlist-metadata', 'playlist-track-page', 'collection-scroll-end', 'collection-scroll-stall', 'playlist-scroll-end'].includes(type)) return;
    chrome.runtime.sendMessage({ type: `zvuk:${type}`, ...detail });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'zvuk:start') window.postMessage({ source: marker, type: 'start' }, location.origin);
    if (message?.type === 'zvuk:stop') window.postMessage({ source: marker, type: 'stop' }, location.origin);
  });

  window.postMessage({ source: marker, type: 'bridge-ready' }, location.origin);
})();
