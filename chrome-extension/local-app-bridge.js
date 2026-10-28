(() => {
  const marker = 'music-importer-local-app';
  const allowedPaths = new Map([
    ['http://127.0.0.1:8000', new Set(['/'])],
    ['http://127.0.0.1:8001', new Set(['/'])],
    ['http://localhost:8000', new Set(['/'])],
    ['http://localhost:8001', new Set(['/'])],
    ['https://basil-as.github.io', new Set(['/music_importer/', '/music_importer/index.html'])],
  ]);

  if (!allowedPaths.get(location.origin)?.has(location.pathname)) return;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'music-importer:bridge-health') {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    }
    if (!['music-importer:yandex-progress', 'music-importer:apple-progress', 'music-importer:zvuk-progress', 'music-importer:spotify-progress'].includes(message?.type)) return false;
    window.postMessage({
      source: marker,
      type: message.type === 'music-importer:apple-progress' ? 'apple-progress' : message.type === 'music-importer:zvuk-progress' ? 'zvuk-progress' : message.type === 'music-importer:spotify-progress' ? 'spotify-progress' : 'yandex-progress',
      requestId: String(message.requestId || ''),
      progress: message.progress || null,
    }, location.origin);
    return false;
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== marker) return;
    const requestId = String(event.data.requestId || '');
    if (!/^[a-z0-9-]{16,80}$/i.test(requestId)) return;

    if (event.data.type === 'extension-ping') {
      window.postMessage({
        source: marker,
        type: 'extension-ready',
        requestId,
        version: chrome.runtime.getManifest().version,
      }, location.origin);
      return;
    }

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

    if (event.data.type === 'apple-command') {
      const action = String(event.data.action || '');
      if (!['search-tracks', 'execute-transfer'].includes(action)) return;
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'music-importer:apple-command',
          requestId,
          action,
          query: String(event.data.query || '').slice(0, 400),
          storefront: String(event.data.storefront || '').slice(0, 2),
          plan: action === 'execute-transfer' ? event.data.plan : undefined,
        });
        window.postMessage({
          source: marker,
          type: 'apple-command-response',
          requestId,
          ok: response?.ok === true,
          error: response?.error || null,
          results: response?.results || null,
          report: response?.report || null,
        }, location.origin);
      } catch {
        window.postMessage({ source: marker, type: 'apple-command-response', requestId, ok: false, error: 'Не удалось связаться с расширением Apple Music.' }, location.origin);
      }
      return;
    }

    if (event.data.type === 'spotify-command') {
      const action = String(event.data.action || '');
      if (!['search-tracks', 'execute-transfer'].includes(action)) return;
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'music-importer:spotify-command',
          requestId,
          action,
          query: String(event.data.query || '').slice(0, 400),
          plan: action === 'execute-transfer' ? event.data.plan : undefined,
        });
        window.postMessage({
          source: marker,
          type: 'spotify-command-response',
          requestId,
          ok: response?.ok === true,
          error: response?.error || null,
          results: response?.results || null,
          report: response?.report || null,
        }, location.origin);
      } catch {
        window.postMessage({ source: marker, type: 'spotify-command-response', requestId, ok: false, error: 'Не удалось связаться с расширением Spotify.' }, location.origin);
      }
      return;
    }

    if (event.data.type === 'zvuk-command') {
      const action = String(event.data.action || '');
      if (!['search-tracks', 'execute-transfer'].includes(action)) return;
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'music-importer:zvuk-command',
          requestId,
          action,
          query: String(event.data.query || '').slice(0, 400),
          plan: action === 'execute-transfer' ? event.data.plan : undefined,
        });
        window.postMessage({
          source: marker,
          type: 'zvuk-command-response',
          requestId,
          ok: response?.ok === true,
          error: response?.error || null,
          results: response?.results || null,
          report: response?.report || null,
        }, location.origin);
      } catch {
        window.postMessage({ source: marker, type: 'zvuk-command-response', requestId, ok: false, error: 'Не удалось связаться с расширением Звука.' }, location.origin);
      }
      return;
    }

    if (event.data.type === 'get-all-libraries') {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'music-importer:get-all-libraries',
          refresh: event.data.refresh === true,
        });
        window.postMessage({
          source: marker,
          type: 'all-libraries-response',
          requestId,
          libraries: response?.libraries || {},
          statuses: response?.statuses || {},
          pending: response?.pending === true,
          error: response?.error || null,
        }, location.origin);
      } catch {
        window.postMessage({
          source: marker,
          type: 'all-libraries-response',
          requestId,
          libraries: {},
          statuses: {},
          pending: false,
          error: 'Не удалось связаться с расширением Chrome.',
        }, location.origin);
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
