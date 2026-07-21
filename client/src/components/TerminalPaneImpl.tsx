import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ExecServerControl } from '@kubus/shared';
import { wsUrl } from '../api/http.js';
import { copyToClipboard, readFromClipboard } from '../clipboard.js';
import type { NodeShellTab, TerminalTab } from '../state/dock.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';

export default function TerminalPaneImpl({ tab, active }: { tab: TerminalTab | NodeShellTab; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const theme = useTheme();

  // Right-click copies the selection when there is one, otherwise pastes —
  // the common terminal-emulator convention. Paste goes through term.paste()
  // so bracketed-paste mode reaches the remote shell intact.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) {
      void copyToClipboard(selection).then((ok) => {
        if (ok) term.clearSelection();
      });
      return;
    }
    void readFromClipboard().then((text) => {
      if (text === null) {
        showToast('warning', 'Clipboard read unavailable or denied — allow clipboard access, or paste with the keyboard.');
        return;
      }
      if (text) term.paste(text);
    });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const { monoFontSize, defaultShell } = useUiPrefsStore.getState();
    const term = new Terminal({
      fontSize: monoFontSize + 1,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      cursorBlink: true,
      theme: { background: '#16161e' },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    termRef.current = term;
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const ws = new WebSocket(
      tab.kind === 'node-shell'
        ? wsUrl('/ws/node-shell', { ctx: tab.ctx, node: tab.node, cols: term.cols, rows: term.rows })
        : wsUrl('/ws/exec', {
            ctx: tab.ctx,
            namespace: tab.namespace,
            pod: tab.pod,
            container: tab.container,
            shell: defaultShell !== 'auto' && defaultShell.trim() ? defaultShell.trim() : undefined,
            cols: term.cols,
            rows: term.rows,
          }),
    );
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
      } else if (typeof ev.data === 'string') {
        try {
          const ctl = JSON.parse(ev.data) as ExecServerControl;
          if (ctl.op === 'exit') {
            term.write(`\r\n\x1b[33m[session ended${ctl.message ? `: ${ctl.message}` : ''}]\x1b[0m\r\n`);
          }
        } catch {
          term.write(ev.data);
        }
      }
    };
    ws.onclose = () => term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');

    const encoder = new TextEncoder();
    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'resize', cols, rows }));
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Refit when this tab becomes visible (display:none panes have zero size).
  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);

  return (
    <Box sx={{ height: '100%', p: 1, pt: 0.75 }}>
      <Box
        ref={containerRef}
        onContextMenu={onContextMenu}
        sx={{
          height: '100%',
          bgcolor: '#16161e',
          border: 1,
          borderColor: theme.palette.mode === 'dark' ? 'transparent' : theme.palette.divider,
          borderRadius: 1,
          overflow: 'hidden',
          '& .xterm': { height: '100%', p: theme.spacing(0.5) },
          // xterm.css defaults the viewport to #000, which shows through the
          // .xterm padding as a black ring around the canvas.
          '& .xterm .xterm-viewport': { backgroundColor: 'transparent' },
        }}
      />
    </Box>
  );
}
