(() => {
  const marker = 'music-importer-local-app';
  const allowedOrigins = new Set(['http://127.0.0.1:8000', 'http://127.0.0.1:8001', 'http://localhost:8000', 'http://localhost:8001']);

  if (!allowedOrigins.has(location.origin) || location.pathname !== '/') return;

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker || event.data?.type !== 'get-library') return;
    const requestId = String(event.data.requestId || '');
    if (!/^[a-z0-9-]{16,80}$/i.test(requestId)) return;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'music-importer:get-library' });
      window.postMessage({
        source: marker,
        type: 'library-response',
        requestId,
        payload: response?.payload || null,
        error: response?.error || null,
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
