import { useEffect, useState } from 'react';
import { LOG_SOCKET_NO_STREAMS_CODE, type LogServerMessage } from '@kubus/shared';
import { wsUrl } from '../../api/http.js';
import { stripAnsi } from '../log-format.js';

export interface LastOutputState {
  status: 'loading' | 'done' | 'error';
  lines: string[];
  error?: string;
}

const TIMEOUT_MS = 10_000;

/**
 * The last few lines a container wrote before it stopped — the crashed
 * instance (`previous`) of a crash-looping container, or the stopped one of
 * a container that exited. A one-shot, non-following read over the log
 * socket; `refreshKey` (restart count, finish time) re-reads after the next
 * crash.
 */
export function useLastOutput(
  sel: { ctx: string; namespace: string; pod: string; container: string; previous: boolean; lines?: number } | undefined,
  refreshKey?: string | number,
): LastOutputState | undefined {
  const [state, setState] = useState<LastOutputState>();
  const enabled = !!sel;
  const { ctx = '', namespace = '', pod = '', container = '', previous = false, lines: tail = 5 } = sel ?? {};

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') {
      setState(undefined);
      return;
    }
    let settled = false;
    const lines: string[] = [];
    setState({ status: 'loading', lines: [] });
    const socket = new WebSocket(wsUrl('/ws/logs', { ctx, namespace, pods: pod, containers: container, previous, follow: false, tailLines: tail }));
    const finish = (next: LastOutputState) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      setState(next);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    };
    const timer = window.setTimeout(() => finish({ status: 'error', lines, error: 'The log request timed out.' }), TIMEOUT_MS);
    socket.onmessage = (event) => {
      let msg: LogServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as LogServerMessage;
      } catch {
        return;
      }
      if (msg.op === 'line') lines.push(stripAnsi(msg.line));
      else if (msg.op === 'pod-status' && msg.state === 'error') finish({ status: lines.length ? 'done' : 'error', lines, error: msg.message ?? 'The logs could not be read.' });
      else if (msg.op === 'pod-status' && msg.state === 'ended') finish({ status: 'done', lines });
    };
    socket.onclose = (event) =>
      finish(
        event.code === LOG_SOCKET_NO_STREAMS_CODE && !lines.length
          ? { status: 'error', lines, error: event.reason || 'No log stream was available.' }
          : { status: 'done', lines },
      );
    socket.onerror = () => finish({ status: lines.length ? 'done' : 'error', lines, error: 'The log stream could not be opened.' });
    return () => {
      settled = true;
      window.clearTimeout(timer);
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    };
  }, [enabled, ctx, namespace, pod, container, previous, tail, refreshKey]);

  return sel ? state : undefined;
}
