// Verify live ADDED/DELETED deltas flow through /ws/watch.
import WebSocket from '../server/node_modules/ws/wrapper.mjs';

const [, , token, ctx = 'kind-c9s-demo'] = process.argv;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/yaml' };
const url = new URL('ws://127.0.0.1:3199/ws/watch');
url.searchParams.set('token', token);
const ws = new WebSocket(url, { origin: 'http://127.0.0.1:3199' });

const seen = [];
ws.on('open', () => ws.send(JSON.stringify({ op: 'sub', id: 'cm', ctx, group: 'core', version: 'v1', plural: 'configmaps', namespace: 'default' })));
ws.on('message', async (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.op === 'snapshot') {
    console.log(`✓ snapshot: ${msg.items.length} configmaps`);
    await fetch(`http://127.0.0.1:3199/api/contexts/${ctx}/resources`, {
      method: 'POST',
      headers,
      body: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: kubus-watch-test\n  namespace: default\ndata:\n  a: b',
    });
  }
  if (msg.op === 'events') {
    for (const ev of msg.events) {
      if (ev.object.metadata.name !== 'kubus-watch-test') continue;
      seen.push(ev.type);
      console.log(`✓ delta: ${ev.type} ${ev.object.metadata.name}`);
      if (ev.type === 'ADDED') {
        await fetch(`http://127.0.0.1:3199/api/contexts/${ctx}/resources/core/v1/configmaps/kubus-watch-test?namespace=default`, { method: 'DELETE', headers });
      }
      if (ev.type === 'DELETED') {
        console.log('WATCH DELTA TEST PASSED');
        process.exit(0);
      }
    }
  }
});
setTimeout(() => {
  console.log('TIMEOUT; seen:', seen);
  process.exit(1);
}, 20000);
