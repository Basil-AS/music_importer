/* Keep the user from closing the app tab during a confirmed account write. */
(() => {
  function installBeforeUnloadGuard(isTransferInProgress, targetWindow = window) {
    if (typeof isTransferInProgress !== 'function' || typeof targetWindow?.addEventListener !== 'function') return false;
    targetWindow.addEventListener('beforeunload', (event) => {
      if (!isTransferInProgress()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    return true;
  }

  window.MusicTransferSafety = Object.freeze({ installBeforeUnloadGuard });
})();
