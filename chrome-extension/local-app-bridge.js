(() => {
  const marker = 'music-importer-local-app';
  const allowedOrigins = new Set(['http://127.0.0.1:8000', 'http://127.0.0.1:8001', 'http://localhost:8000', 'http://localhost:8001']);

  if (!allowedOrigins.has(location.origin) || location.pathname !== '/') return;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'music-importer:yandex-progress') return false;
    window.postMessage({
      source: marker,
      type: 'yandex-progress',
      requestId: String(message.requestId || ''),
      progress: message.progress || null,
    }, location.origin);
    return false;
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const requestId = String(event.data.requestId || '');
    if (!/^[a-z0-9-]{16,80}$/i.test(requestId)) return;

    if (event.data.type === 'yandex-command') {
      const action = String(event.data.action || '');
      if (!['search-tracks', 'execute-transfer'].includes(action)) return;
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'music-importer:yandex-command',
          requestId,
          action,
          query: String(event.data.query || '').slice(0, 400),
          plan: action === 'execute-transfer' ? event.data.plan : undefined,
        });
        window.postMessage({
          source: marker,
          type: 'yandex-command-response',
          requestId,
          ok: response?.ok === true,
          error: response?.error || null,
          results: response?.results || null,
          report: response?.report || null,
        }, location.origin);
      } catch {
        window.postMessage({ source: marker, type: 'yandex-command-response', requestId, ok: false, error: 'Не удалось связаться с расширением.' }, location.origin);
      }
      return;
    }

    if (event.data.type !== 'get-library') return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'music-importer:get-library',
        provider: String(event.data.provider || 'zvuk'),
        refresh: event.data.refresh === true,
      });
      window.postMessage({
        source: marker,
        type: 'library-response',
        requestId,
        payload: response?.payload || null,
        error: response?.error || null,
        pending: response?.pending === true,
        progress: response?.progress || null,
      }, location.origin);
    } catch {
      window.postMessage({
        source: marker,
        type: 'library-response',
        requestId,
        payload: null,
        error: 'Расширение недоступно. Перезагрузите локальную страницу и попробуйте снова.',
      }, location.origin);
    }
  });
})();
