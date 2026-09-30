/**
 * NotebookLM ABC Piano Roll — Extension Content Script Entry Point
 */

(() => {
  const pageType = (typeof getPageType === 'function') ? getPageType() : 'notebook';
  console.log(`🎹 [ABC Piano Roll v1.1.9] Extension loaded on [${pageType.toUpperCase()}] page:`, window.location.href);

  // Start the intelligent debounced DOM watcher
  try {
    const watcher = new NotebookLMWatcher();
    watcher.start();
  } catch (err) {
    console.error('🎹 [ABC Piano Roll] Error initializing watcher:', err);
  }
})();
