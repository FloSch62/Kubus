import { PassThrough } from 'node:stream';
import { z } from 'zod';
import type { PodInterfaceSnapshot } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { HttpProblem } from '../util/errors.js';

const interfacesSchema = z
  .array(
    z.object({
      ifname: z.string().max(256),
      operstate: z.string().max(64).optional(),
      flags: z.array(z.string().max(64)),
      mtu: z.number().optional(),
      address: z.string().max(256).optional(),
    }),
  )
  .max(4096);

export function parseInterfaces(output: string): PodInterfaceSnapshot['interfaces'] {
  const parsed = interfacesSchema.safeParse(JSON.parse(output));
  if (!parsed.success) throw new HttpProblem(502, 'Container returned unsupported interface data');
  return parsed.data.map((i) => ({
    name: i.ifname,
    operState: i.operstate ?? 'UNKNOWN',
    adminUp: i.flags.includes('UP'),
    carrier: i.flags.includes('LOWER_UP') ? true : i.flags.includes('NO-CARRIER') || i.operstate === 'DOWN' ? false : null,
    mtu: i.mtu,
    address: i.address,
  }));
}

/** Fixed read-only argv; plugins cannot supply a command, shell, or interface name. */
export function readPodInterfaces(handle: ClusterHandle, namespace: string, pod: string, container: string, signal: AbortSignal) {
  return new Promise<PodInterfaceSnapshot['interfaces']>((resolve, reject) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let bytes = 0;
    const chunks: Buffer[] = [];
    let diagnostic = '';
    let done = false;
    let socket: { close: () => void } | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      socket?.close();
      stdout.destroy();
      stderr.destroy();
      if (error) reject(error);
      else {
        try {
          resolve(parseInterfaces(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpProblem(502, 'Interface inspection requires iproute2 JSON output in the device container'));
        }
      }
    };
    const aborted = () => finish(new HttpProblem(499, 'Interface inspection cancelled'));
    const timer = setTimeout(() => finish(new HttpProblem(504, 'Interface inspection timed out')), 8000);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) finish(new HttpProblem(502, 'Interface inspection exceeded its output limit'));
      else chunks.push(chunk);
    });
    stderr.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString('utf8').slice(0, Math.max(0, 1024 - diagnostic.length));
    });
    void handle
      .makeExec()
      .exec(namespace, pod, container, ['ip', '-j', 'link', 'show'], stdout, stderr, null, false, (status) => {
        finish(
          status.status === 'Success'
            ? undefined
            : new HttpProblem(422, `Cannot inspect interfaces: ${diagnostic || status.message || 'iproute2 is unavailable'}`),
        );
      })
      .then((ws) => {
        socket = ws;
        ws.on('error', () => finish(new HttpProblem(502, 'Interface inspection connection failed')));
        if (done) {
          ws.close();
          return;
        }
        ws.on('close', () => finish(new HttpProblem(502, 'Interface inspection ended without a result')));
      })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
