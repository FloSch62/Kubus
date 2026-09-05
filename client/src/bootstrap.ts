// Electrobun's preload establishes this promise before page scripts execute.
// A regular browser has no desktop bridge and can load immediately.
try {
  await window.kubusDesktopReady;
  await import('./main.js');
} catch (error) {
  console.error('Kubus startup failed', error);
  document.getElementById('root')!.textContent = 'Kubus could not start. Close this window and try again.';
}
export {};
