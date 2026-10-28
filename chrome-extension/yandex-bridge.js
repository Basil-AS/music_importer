(() => {
  const marker = 'music-importer-yandex';
  const accepted = new Set(['scan-progress', 'library-snapshot', 'scan-error', 'command-response', 'transfer-progress']);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const { type, ...detail } = event.data;
    if (!accepted.has(type)) return;
    chrome.runtime.sendMessage({ type: `yandex:${type}`, ...detail }).then((response) => {
      if (type === 'transfer-progress' && detail.progress?.checkpointId) window.postMessage({
        source: marker, type: 'transfer-progress-ack', checkpointId: detail.progress.checkpointId, ok: response?.ok === true,
      }, location.origin);
    }).catch(() => {
      if (type === 'transfer-progress' && detail.progress?.checkpointId) window.postMessage({
        source: marker, type: 'transfer-progress-ack', checkpointId: detail.progress.checkpointId, ok: false,
      }, location.origin);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'yandex:start-library-scan') {
      window.postMessage({ source: marker, type: 'start-library-scan' }, location.origin);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'yandex:command' || !['search-tracks', 'search-album-tracks', 'execute-transfer'].includes(message.action)) return false;
    const requestId = String(message.requestId || '');
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onResponse);
      sendResponse({ ok: false, error: 'Яндекс Музыка не ответила на запрос. Проверьте вход и повторите.' });
    }, message.action === 'execute-transfer' ? 30 * 60 * 1000 : 45000);
    const onResponse = (event) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker
        || event.data?.type !== 'command-response' || event.data?.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener('message', onResponse);
      sendResponse(event.data);
    };
    window.addEventListener('message', onResponse);
    window.postMessage({ source: marker, type: message.action, requestId, query: message.query, album: message.album, artist: message.artist, plan: message.plan }, location.origin);
    return true;
  });
})();
