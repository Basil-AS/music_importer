(() => {
  const marker = 'music-importer-zvuk';

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'music-importer:bridge-health-check') return false;
    sendResponse({ ok: true, provider: 'zvuk' });
    return false;
  });

  function sendRuntimeMessage(message) {
    try {
      if (!chrome?.runtime?.id) return Promise.resolve(null);
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch {
      // The tab can outlive an extension reload; its old content script then has no runtime.
      return Promise.resolve(null);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source === 'music-importer-zvuk-target' && event.data?.type === 'transfer-progress') {
      sendRuntimeMessage({
        type: 'zvuk:transfer-progress',
        requestId: String(event.data.requestId || ''),
        progress: event.data.progress || null,
      }).then((response) => {
        if (event.data.progress?.checkpointId) window.postMessage({
          source: 'music-importer-zvuk-target', type: 'transfer-progress-ack',
          checkpointId: event.data.progress.checkpointId, ok: response?.ok === true,
        }, location.origin);
      });
      return;
    }
    if (event.data?.source !== marker) return;
    const { type, ...detail } = event.data;
    if (!['favorite-page', 'favorites-scroll-end', 'favorites-scroll-stall', 'scan-progress', 'collection-count', 'read-error', 'playlist-list-page', 'playlist-metadata', 'playlist-track-page', 'collection-scroll-end', 'collection-scroll-stall', 'playlist-scroll-end'].includes(type)) return;
    sendRuntimeMessage({ type: `zvuk:${type}`, ...detail }).then((response) => {
      if (detail.captureAckId) window.postMessage({
        source: marker, type: 'capture-ack', captureAckId: detail.captureAckId, ok: response?.ok === true,
      }, location.origin);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'zvuk:start') window.postMessage({ source: marker, type: 'start' }, location.origin);
    if (message?.type === 'zvuk:stop') window.postMessage({ source: marker, type: 'stop' }, location.origin);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'zvuk:command' || !['search-tracks', 'execute-transfer'].includes(message.action)) return false;
    const requestId = String(message.requestId || '');
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onResponse);
      sendResponse({ ok: false, error: 'Звук не ответил на запрос. Проверьте вход и повторите.' });
    }, message.action === 'execute-transfer' ? 30 * 60 * 1000 : 45000);
    const onResponse = (event) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'music-importer-zvuk-target'
        || event.data?.type !== 'command-response' || event.data?.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener('message', onResponse);
      sendResponse(event.data);
    };
    window.addEventListener('message', onResponse);
    window.postMessage({
      source: 'music-importer-zvuk-target',
      type: message.action,
      requestId,
      query: message.query,
      plan: message.plan,
    }, location.origin);
    return true;
  });

  window.postMessage({ source: marker, type: 'bridge-ready' }, location.origin);
})();
