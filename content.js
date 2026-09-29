/**
 * NotebookLM ABC Piano Roll — Extension Content Script Entry Point
 */

(() => {
  console.log('🎹 [ABC Piano Roll] Extension loaded for Google NotebookLM');

  // Start the intelligent debounced DOM watcher
  try {
    const watcher = new NotebookLMWatcher();
    watcher.start();
  } catch (err) {
    console.error('🎹 [ABC Piano Roll] Error initializing watcher:', err);
  }
})();
