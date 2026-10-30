(() => {
  const marker = 'music-importer-yandex';
  const accepted = new Set(['scan-progress', 'library-snapshot', 'scan-error', 'command-response', 'transfer-progress']);
  let reloadScheduled = false;

  function scheduleReloadAfterInvalidation() {
    if (reloadScheduled) return;
    reloadScheduled = true;
    setTimeout(() => {
      try { location.reload(); } catch { reloadScheduled = false; }
    }, 0);
  }

  function isInvalidatedContext(error) {
    return String(error?.message || error || '').toLowerCase().includes('extension context invalidated');
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'music-importer:bridge-health-check') return false;
    sendResponse({ ok: true, provider: 'yandex-music', bridgeProtocol: 3 });
    return false;
  });

  function sendRuntimeMessage(message) {
    try {
      if (!chrome?.runtime?.id) {
        scheduleReloadAfterInvalidation();
        return Promise.resolve(null);
      }
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch((error) => {
        if (isInvalidatedContext(error)) scheduleReloadAfterInvalidation();
        return null;
      });
    } catch (error) {
      // A provider tab can outlive an extension reload and retain an invalid context.
      if (isInvalidatedContext(error)) scheduleReloadAfterInvalidation();
      return Promise.resolve(null);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const { type, ...detail } = event.data;
    if (!accepted.has(type)) return;
    sendRuntimeMessage({ type: `yandex:${type}`, ...detail }).then((response) => {
      if (type === 'transfer-progress' && detail.progress?.checkpointId) window.postMessage({
        source: marker, type: 'transfer-progress-ack', checkpointId: detail.progress.checkpointId, ok: response?.ok === true,
      }, location.origin);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'yandex:start-library-scan') {
      window.postMessage({ source: marker, type: 'start-library-scan' }, location.origin);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'yandex:command' || !['search-tracks', 'search-album-tracks', 'search-albums', 'read-albums', 'execute-transfer'].includes(message.action)) return false;
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
