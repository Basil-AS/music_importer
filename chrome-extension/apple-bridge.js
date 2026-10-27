(() => {
  const marker = 'music-importer-apple';
  const accepted = new Set(['scan-progress', 'library-snapshot', 'scan-error']);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const { type, ...detail } = event.data;
    if (!accepted.has(type)) return;
    chrome.runtime.sendMessage({ type: `apple:${type}`, ...detail });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'apple:start-library-scan') {
      window.postMessage({ source: marker, type: 'start-library-scan' }, location.origin);
    }
  });
})();
