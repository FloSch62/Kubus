// Zero-build protocol example. Bundled TypeScript apps should use connectPlugin
// from @kubus/plugin-sdk for typed requests, errors, timeouts and disposal.
let port;
function render(context) {
  document.documentElement.style.colorScheme = context.theme;
  document.getElementById('context').textContent = JSON.stringify(context, null, 2);
}
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.type !== 'kubus:connect' || event.data.apiVersion !== 1 || !event.ports[0]) return;
  port?.close();
  port = event.ports[0];
  port.onmessage = ({ data }) => { if (data.type === 'kubus:context') render(data.context); };
  port.start();
  port.postMessage({ type: 'kubus:ready' });
  render(event.data.context);
});
window.addEventListener('pagehide', () => port?.close(), { once: true });
