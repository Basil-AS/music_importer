(() => {
  const preferenceKey = 'music-importer-theme';
  const media = window.matchMedia('(prefers-color-scheme: light)');
  let preference = 'system';

  try {
    const stored = window.localStorage.getItem(preferenceKey);
    if (['system', 'light', 'dark'].includes(stored)) preference = stored;
  } catch {
    // The system theme still works when local storage is unavailable.
  }

  const applyTheme = () => {
    const theme = preference === 'system' ? (media.matches ? 'light' : 'dark') : preference;
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === 'light' ? '#f5f5f7' : '#101114';
    const toggle = document.querySelector('#themeToggle');
    if (toggle) {
      const label = preference === 'system'
        ? `Переключить на ${theme === 'light' ? 'тёмную' : 'светлую'} тему`
        : `Вернуться к системной теме (сейчас ${theme === 'light' ? 'светлая' : 'тёмная'})`;
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    }
  };

  applyTheme();
  media.addEventListener?.('change', () => {
    if (preference === 'system') applyTheme();
  });

  window.addEventListener('DOMContentLoaded', () => {
    const toggle = document.querySelector('#themeToggle');
    if (!toggle) return;
    applyTheme();
    toggle.addEventListener('click', () => {
      const activeTheme = document.documentElement.dataset.theme;
      preference = preference === 'system'
        ? (activeTheme === 'light' ? 'dark' : 'light')
        : 'system';
      try {
        window.localStorage.setItem(preferenceKey, preference);
      } catch {
        // Keep the selected theme for this page even when persistence is unavailable.
      }
      applyTheme();
    });
  }, { once: true });
})();
