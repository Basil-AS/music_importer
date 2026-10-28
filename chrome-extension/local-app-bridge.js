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

  const commandActions = {
    yandex: new Set(['search-tracks', 'search-album-tracks', 'search-albums', 'read-albums', 'execute-transfer']),
    apple: new Set(['search-tracks', 'search-album-tracks', 'search-albums', 'read-library-albums', 'execute-transfer']),
    spotify: new Set(['search-tracks', 'search-album-tracks', 'search-albums', 'read-albums', 'write-albums', 'execute-transfer']),
    zvuk: new Set(['search-tracks', 'search-album-tracks', 'search-albums', 'execute-transfer']),
  };

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
      checkpointAckId: String(message.checkpointAckId || ''),
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

    if (event.data.type === 'transfer-progress-ack') {
      const checkpointAckId = String(event.data.checkpointAckId || '');
      if (!/^[a-z0-9:_-]{16,120}$/i.test(checkpointAckId)) return;
      void chrome.runtime.sendMessage({
        type: 'music-importer:progress-ack', checkpointAckId, ok: event.data.ok === true,
      }).catch(() => {});
      return;
    }

    const commandProvider = { 'yandex-command': 'yandex', 'apple-command': 'apple', 'spotify-command': 'spotify', 'zvuk-command': 'zvuk' }[event.data.type];
    if (commandProvider) {
      const action = String(event.data.action || '');
      if (!commandActions[commandProvider].has(action)) return;
      const failureText = { yandex: 'Не удалось связаться с расширением.', apple: 'Не удалось связаться с расширением Apple Music.', spotify: 'Не удалось связаться с расширением Spotify.', zvuk: 'Не удалось связаться с расширением Звука.' }[commandProvider];
      try {
        const response = await chrome.runtime.sendMessage({
          type: `music-importer:${commandProvider}-command`,
          requestId,
          action,
          query: String(event.data.query || '').slice(0, 400),
          album: String(event.data.album || '').slice(0, 200),
          artist: String(event.data.artist || '').slice(0, 200),
          upc: String(event.data.upc || '').replace(/[^0-9]/g, '').slice(0, 20),
          storefront: String(event.data.storefront || '').slice(0, 2),
          ids: Array.isArray(event.data.ids) ? event.data.ids.slice(0, 500).map((id) => String(id).slice(0, 80)) : undefined,
          targets: action === 'write-albums' && Array.isArray(event.data.targets) ? event.data.targets.slice(0, 500) : undefined,
          plan: action === 'execute-transfer' ? event.data.plan : undefined,
        });
        window.postMessage({
          source: marker,
          type: `${commandProvider}-command-response`,
          requestId,
          ok: response?.ok === true,
          error: response?.error || null,
          status: response?.status || null,
          retryAfter: response?.retryAfter || null,
          results: response?.results || null,
          report: response?.report || null,
        }, location.origin);
      } catch {
        window.postMessage({ source: marker, type: `${commandProvider}-command-response`, requestId, ok: false, error: failureText }, location.origin);
      }
      return;
    }

    if (event.data.type === 'get-all-libraries') {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'music-importer:get-all-libraries',
          refresh: event.data.refresh === true,
          refreshProviders: event.data.refreshProviders,
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

    if (event.data.type === 'open-provider-tabs') {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'music-importer:open-provider-tabs',
          providerIds: Array.isArray(event.data.providerIds) ? event.data.providerIds : null,
          ...(typeof event.data.focusProviderId === 'string' ? { focusProviderId: event.data.focusProviderId } : {}),
        });
        window.postMessage({
          source: marker,
          type: 'provider-tabs-response',
          requestId,
          ok: response?.ok === true,
          opened: response?.opened || [],
          alreadyOpen: response?.alreadyOpen || [],
          error: response?.error || null,
        }, location.origin);
      } catch {
        window.postMessage({
          source: marker,
          type: 'provider-tabs-response',
          requestId,
          ok: false,
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
