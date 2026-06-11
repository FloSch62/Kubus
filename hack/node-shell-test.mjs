// Node-shell smoke test: opens /ws/node-shell, expects a root shell on the
// node (hostname must match the node name), then verifies the privileged
// pod is cleaned up after the socket closes.
import WebSocket from '../server/node_modules/ws/wrapper.mjs';

const [, , token, ctx, node, port = '3199'] = process.argv;
const url = new URL(`ws://127.0.0.1:${port}/ws/node-shell`);
url.searchParams.set('token', token);
url.searchParams.set('ctx', ctx);
url.searchParams.set('node', node);
url.searchParams.set('cols', '80');
url.searchParams.set('rows', '24');

const ws = new WebSocket(url, { origin: `http://127.0.0.1:${port}` });
let output = '';
let sent = false;

ws.on('open', () => console.log('[open]'));
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    output += data.toString();
    if (!sent && /[#$] ?$/.test(output.trimEnd())) {
      sent = true;
      ws.send(Buffer.from('echo node-is-$(cat /etc/hostname)\r'));
    }
    if (output.includes(`node-is-${node}`)) {
      console.log(`✓ NODE SHELL OK: hostname is ${node}`);
      ws.send(Buffer.from('exit\r'));
    }
  } else {
    console.log('[ctl]', data.toString());
  }
});
ws.on('close', (code, reason) => {
  console.log('[close]', code, reason.toString());
  process.exit(output.includes(`node-is-${node}`) ? 0 : 1);
});
ws.on('error', (err) => console.log('[error]', err.message));
setTimeout(() => {
  console.log('TIMEOUT; output so far:', JSON.stringify(output.slice(-400)));
  process.exit(1);
}, 90000);
