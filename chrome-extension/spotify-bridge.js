(() => {
  const marker = 'music-importer-spotify';
  const accepted = new Set(['scan-progress', 'library-snapshot', 'scan-error']);
  const pendingCommands = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const { type, ...detail } = event.data;
    if (type === 'command-result') {
      const respond = pendingCommands.get(String(detail.requestId || ''));
      if (!respond) return;
      pendingCommands.delete(String(detail.requestId));
      respond({
        ok: detail.ok === true,
        error: detail.error || null,
        status: detail.status || null,
        retryAfter: detail.retryAfter || null,
        results: Array.isArray(detail.result) ? detail.result : null,
        report: Array.isArray(detail.result) ? null : detail.result || detail.report || null,
      });
      return;
    }
    if (type === 'transfer-progress') {
      chrome.runtime.sendMessage({ type: 'spotify:transfer-progress', ...detail }).then((response) => {
        if (detail.progress?.checkpointId) window.postMessage({
          source: marker, type: 'transfer-progress-ack', checkpointId: detail.progress.checkpointId, ok: response?.ok === true,
        }, location.origin);
      }).catch(() => {
        if (detail.progress?.checkpointId) window.postMessage({
          source: marker, type: 'transfer-progress-ack', checkpointId: detail.progress.checkpointId, ok: false,
        }, location.origin);
      });
      return;
    }
    if (!accepted.has(type)) return;
    chrome.runtime.sendMessage({ type: `spotify:${type}`, ...detail });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'spotify:start-library-scan') {
      window.postMessage({ source: marker, type: 'start-library-scan' }, location.origin);
      return false;
    }
    if (message?.type !== 'spotify:command' || !/^[a-z0-9-]{16,80}$/i.test(String(message.requestId || ''))
      || !['search-tracks', 'execute-transfer'].includes(message.action)) return false;
    const requestId = String(message.requestId);
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      sendResponse({ ok: false, error: 'Spotify не ответил на команду. Перезагрузите вкладку сервиса.' });
    }, message.action === 'execute-transfer' ? 30 * 60 * 1000 : 45000);
    pendingCommands.set(requestId, (response) => { clearTimeout(timer); sendResponse(response); });
    window.postMessage({
      source: marker,
      type: 'command',
      requestId,
      action: message.action,
      query: String(message.query || '').slice(0, 400),
      plan: message.action === 'execute-transfer' ? message.plan : undefined,
    }, location.origin);
    return true;
  });
})();
