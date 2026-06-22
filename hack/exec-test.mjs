// Focused exec test with verbose output.
import WebSocket from '../server/node_modules/ws/wrapper.mjs';

const [, , token, ctx, namespace, pod, container] = process.argv;
const url = new URL('ws://127.0.0.1:3199/ws/exec');
url.searchParams.set('token', token);
url.searchParams.set('ctx', ctx);
url.searchParams.set('namespace', namespace);
url.searchParams.set('pod', pod);
url.searchParams.set('container', container);
url.searchParams.set('cols', '80');
url.searchParams.set('rows', '24');

const ws = new WebSocket(url, { origin: 'http://127.0.0.1:3199' });
let output = '';
let sent = false;

ws.on('open', () => console.log('[open]'));
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    output += data.toString();
    process.stdout.write(`[bin] ${JSON.stringify(data.toString().slice(0, 100))}\n`);
    if (!sent) {
      sent = true;
      setTimeout(() => ws.send(Buffer.from('echo kubus-$((20+22))\r')), 200);
    }
    if (output.includes('kubus-42')) {
      console.log('✓ EXEC OK: echoed kubus-42');
      ws.send(JSON.stringify({ op: 'resize', cols: 120, rows: 40 }));
      setTimeout(() => ws.send(Buffer.from('exit\r')), 200);
    }
  } else {
    console.log('[ctl]', data.toString());
  }
});
ws.on('close', (code, reason) => {
  console.log('[close]', code, reason.toString());
  process.exit(output.includes('kubus-42') ? 0 : 1);
});
ws.on('error', (err) => console.log('[error]', err.message));
setTimeout(() => {
  console.log('TIMEOUT; output so far:', JSON.stringify(output.slice(-300)));
  process.exit(1);
}, 20000);
