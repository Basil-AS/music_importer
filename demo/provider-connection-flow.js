(function attachProviderConnectionFlow(root) {
  const providersForFocusRefresh = (providers, snapshots, statuses, queuedProviders = []) => {
    const queued = new Set(queuedProviders);
    return [...new Set(providers)].filter((provider) => queued.has(provider)
      || !snapshots?.[provider]
      || ['unavailable', 'stale'].includes(statuses?.[provider]?.status));
  };

  const providersForAutomaticRefresh = (providers, queuedProviders = []) => {
    const queued = new Set(queuedProviders);
    return [...new Set(providers)].filter((provider) => provider !== 'spotify' || queued.has(provider));
  };

  const sourceAction = ({ extensionAvailable, snapshot, status, providerName, selected, opening, queued = false }) => {
    if (opening) return { action: 'opening', disabled: true, label: 'Открываем…', title: '' };
    if (queued) return { action: 'queued', disabled: true, label: 'Повтор в очереди', title: status?.message || '' };
    if (status?.status === 'scanning') return { action: 'none', disabled: true, label: 'Сканируем…', title: status.message || '' };
    if (snapshot) return {
      action: 'select',
      disabled: false,
      label: selected ? '✓ Источник' : 'Выбрать источник',
      title: status?.status === 'stale' || status?.status === 'unavailable' ? status.message || 'Аккаунт сейчас не обновлён.' : '',
    };
    if (!extensionAvailable) return { action: 'none', disabled: true, label: 'Нет соединения', title: 'Сначала запустите Music Importer в Chrome.' };
    if (status?.status === 'failed') {
      if (/войд|авторизац|сесси|http\s*(401|403)|\b(401|403)\b/i.test(String(status.message || ''))) {
        return { action: 'login', disabled: false, label: 'Войти / открыть', title: status.message || `Проверьте вход в ${providerName || 'музыкальный сервис'}.` };
      }
      if (providerName === 'Spotify') {
        return {
          action: 'retry',
          disabled: false,
          label: 'Проверить Spotify',
          title: 'Запущу чтение Spotify по нажатию. Если мост расширения устарел, вкладка Spotify перезагрузится.',
        };
      }
      return { action: 'retry', disabled: false, label: 'Повторить сбор', title: status.message || '' };
    }
    return { action: 'login', disabled: false, label: 'Войти / открыть', title: `Откроется страница входа в ${providerName || 'музыкальный сервис'}.` };
  };

  const refreshAction = ({ extensionAvailable, status, queued = false }) => {
    if (!extensionAvailable || status?.status === 'scanning') return { visible: false, disabled: true, label: '', title: '' };
    if (!['failed', 'stale'].includes(status?.status)) return { visible: false, disabled: true, label: '', title: '' };
    return {
      visible: true,
      disabled: queued,
      label: queued ? 'Повтор в очереди' : status.status === 'stale' ? 'Обновить сейчас' : 'Повторить чтение',
      title: status.message || '',
    };
  };

  root.MusicProviderConnectionFlow = Object.freeze({ providersForAutomaticRefresh, providersForFocusRefresh, refreshAction, sourceAction });
})(globalThis);
