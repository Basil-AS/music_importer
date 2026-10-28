(() => {
  const marker = 'music-importer-apple';
  const accepted = new Set(['scan-progress', 'library-snapshot', 'scan-error']);
  const pendingCommands = new Map();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'music-importer:bridge-health-check') return false;
    sendResponse({ ok: true, provider: 'apple-music', bridgeProtocol: 3 });
    return false;
  });

  function sendRuntimeMessage(message) {
    try {
      if (!chrome?.runtime?.id) return Promise.resolve(null);
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch {
      // A provider tab can outlive an extension reload and retain an invalid context.
      return Promise.resolve(null);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const { type, ...detail } = event.data;
    if (type === 'command-result') {
      const resolve = pendingCommands.get(String(detail.requestId || ''));
      if (!resolve) return;
      pendingCommands.delete(String(detail.requestId));
      resolve({
        ok: detail.ok === true,
        error: detail.error || null,
        status: detail.status || null,
        retryAfter: detail.retryAfter || null,
        results: detail.result && Array.isArray(detail.result) ? detail.result : null,
        report: detail.result && !Array.isArray(detail.result) ? detail.result : detail.report || null,
      });
      return;
    }
    if (type === 'transfer-progress') {
      sendRuntimeMessage({ type: 'apple:transfer-progress', ...detail }).then((response) => {
        if (detail.progress?.checkpointId) window.postMessage({
          source: marker, type: 'transfer-progress-ack', checkpointId: detail.progress.checkpointId, ok: response?.ok === true,
        }, location.origin);
      });
      return;
    }
    if (!accepted.has(type)) return;
    void sendRuntimeMessage({ type: `apple:${type}`, ...detail });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'apple:start-library-scan') {
      window.postMessage({ source: marker, type: 'start-library-scan' }, location.origin);
      return false;
    }
    if (message?.type !== 'apple:command' || !/^[a-z0-9-]{16,80}$/i.test(String(message.requestId || ''))) return false;
    if (!['search-tracks', 'search-album-tracks', 'execute-transfer'].includes(message.action)) return false;
    const requestId = String(message.requestId);
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      sendResponse({ ok: false, error: 'Apple Music не ответил на команду. Перезагрузите вкладку сервиса.' });
    }, message.action === 'execute-transfer' ? 30 * 60 * 1000 : 45000);
    pendingCommands.set(requestId, (response) => {
      clearTimeout(timer);
      sendResponse(response);
    });
    window.postMessage({
      source: marker,
      type: 'command',
      requestId,
      action: message.action,
      query: String(message.query || '').slice(0, 400),
      album: String(message.album || '').slice(0, 200),
      artist: String(message.artist || '').slice(0, 200),
      storefront: String(message.storefront || '').slice(0, 2),
      plan: message.action === 'execute-transfer' ? message.plan : undefined,
    }, location.origin);
    return true;
  });
})();
