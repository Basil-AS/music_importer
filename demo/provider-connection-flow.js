(function attachProviderConnectionFlow(root) {
  const providersForFocusRefresh = (providers, snapshots, statuses, queuedProviders = []) => {
    const queued = new Set(queuedProviders);
    return [...new Set(providers)].filter((provider) => queued.has(provider)
      || !snapshots?.[provider]
      || ['unavailable', 'stale'].includes(statuses?.[provider]?.status));
  };

  const sourceAction = ({ extensionAvailable, snapshot, status, providerName, selected, opening }) => {
    if (opening) return { disabled: true, label: 'Открываем…', title: '' };
    if (status?.status === 'scanning') return { disabled: true, label: 'Сканируем…', title: status.message || '' };
    if (snapshot) return {
      disabled: false,
      label: selected ? '✓ Источник' : 'Выбрать источник',
      title: status?.status === 'stale' || status?.status === 'unavailable' ? status.message || 'Аккаунт сейчас не обновлён.' : '',
    };
    if (!extensionAvailable) return { disabled: true, label: 'Нет соединения', title: 'Сначала запустите Music Importer в Chrome.' };
    if (status?.status === 'failed') return { disabled: false, label: 'Повторить сбор', title: status.message || '' };
    return { disabled: false, label: 'Войти / открыть', title: `Откроется страница входа в ${providerName || 'музыкальный сервис'}.` };
  };

  root.MusicProviderConnectionFlow = Object.freeze({ providersForFocusRefresh, sourceAction });
})(globalThis);
