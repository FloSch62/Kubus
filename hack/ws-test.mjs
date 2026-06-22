// End-to-end WebSocket smoke test: watch, logs, exec against a live cluster.
import WebSocket from '../server/node_modules/ws/wrapper.mjs';

const [, , token, ctx = 'kind-c9s-demo'] = process.argv;
const base = `ws://127.0.0.1:3199`;

function connect(path, params) {
  const url = new URL(base + path);
  url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new WebSocket(url, { origin: 'http://127.0.0.1:3199' });
}

async function testWatch() {
  return new Promise((resolve, reject) => {
    const ws = connect('/ws/watch', {});
    const timer = setTimeout(() => reject(new Error('watch: timeout')), 15000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'sub', id: 's1', ctx, group: 'core', version: 'v1', plural: 'pods' }));
    });
    let snapshotItems = -1;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.op === 'snapshot' && msg.id === 's1') {
        snapshotItems = msg.items.length;
        console.log(`✓ watch snapshot: ${snapshotItems} pods, rv=${msg.resourceVersion}`);
      }
      if (msg.op === 'status' && msg.state === 'live') {
        console.log('✓ watch status: live');
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

async function testLogs(pod, namespace, container) {
  return new Promise((resolve, reject) => {
    const ws = connect('/ws/logs', { ctx, namespace, pods: pod, container, follow: 'false', tailLines: '5' });
    const timer = setTimeout(() => reject(new Error('logs: timeout')), 15000);
    let lines = 0;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.op === 'line') {
        lines++;
        if (lines === 1) console.log(`✓ logs first line [${msg.pod}/${msg.container}]: ${msg.line.slice(0, 80)}`);
      }
      if (msg.op === 'pod-status' && msg.state === 'ended') {
        console.log(`✓ logs ended after ${lines} lines`);
        clearTimeout(timer);
        ws.close();
        resolve();
      }
      if (msg.op === 'pod-status' && msg.state === 'error') {
        clearTimeout(timer);
        reject(new Error(`logs error: ${msg.message}`));
      }
    });
    ws.on('error', reject);
  });
}

async function testExec(pod, namespace, container) {
  return new Promise((resolve, reject) => {
    const ws = connect('/ws/exec', { ctx, namespace, pod, container, cols: 80, rows: 24 });
    const timer = setTimeout(() => reject(new Error('exec: timeout')), 20000);
    let output = '';
    let sent = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary || data instanceof Buffer) {
        output += data.toString();
        if (!sent && output.length > 0) {
          sent = true;
          ws.send(Buffer.from('echo kubus-$((20+22))\n'));
        }
        if (output.includes('kubus-42')) {
          console.log('✓ exec: interactive shell echoed kubus-42');
          ws.send(JSON.stringify({ op: 'resize', cols: 120, rows: 40 }));
          setTimeout(() => {
            ws.send(Buffer.from('exit\n'));
          }, 300);
        }
      } else {
        const ctl = JSON.parse(data.toString());
        if (ctl.op === 'exit') {
          console.log(`✓ exec exit (code=${ctl.code ?? 'n/a'})`);
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', reject);
  });
}

const headers = { authorization: `Bearer ${token}` };
const pods = await fetch(`http://127.0.0.1:3199/api/contexts/${ctx}/resources/core/v1/pods?namespace=kube-system`, { headers }).then((r) => r.json());
const coredns = pods.items.find((p) => p.metadata.name.startsWith('coredns'));
const etcd = pods.items.find((p) => p.metadata.name.startsWith('etcd'));
console.log(`targets: logs=${coredns?.metadata.name} exec=${etcd?.metadata.name}`);

await testWatch();
await testLogs(coredns.metadata.name, 'kube-system', 'coredns');
await testExec(etcd.metadata.name, 'kube-system', 'etcd');
console.log('ALL WS TESTS PASSED');
process.exit(0);
