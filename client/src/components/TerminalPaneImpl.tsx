import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useTheme } from '@mui/material/styles';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { EXEC_SESSION_CLOSE_REASON, type ExecServerControl } from '@kubus/shared';
import { wsUrl } from '../api/http.js';
import { copyToClipboard, readFromClipboard } from '../clipboard.js';
import type { ShellTab } from '../state/dock.js';
import { useDockStore } from '../state/dock.js';
import { useClustersStore } from '../state/clusters.js';
import { LocalShellHeader } from './LocalShellHeader.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { selectedTerminalText } from '../terminal-selection.js';
import { terminalRightClickIntent, xtermRightClickSelectsWord } from '../terminal-right-click.js';
import { registerTerminal } from '../terminal-registry.js';
import { cancelTabTransfer, completeTabTransfer } from '../tab-transfer.js';

const TRANSFER_PREPARE_TIMEOUT_MS = 5_000;

export default function TerminalPaneImpl({
  tab,
  active,
  focusRequest,
  reconnectRequest,
}: {
  tab: ShellTab;
  active: boolean;
  focusRequest: number;
  reconnectRequest: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isLocal = tab.kind === 'local-shell';
  // Local shells: the command waiting to be typed, and whether the shell has
  // produced its first output (a prompt) so typing into it is safe.
  const pendingCommandRef = useRef<string | undefined>(tab.kind === 'local-shell' ? tab.pendingCommand : undefined);
  const shellReadyRef = useRef(false);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const transferPreparationRef = useRef<{
    resolve: (prepared: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const initialSnapshotRef = useRef(tab.snapshot);
  const rightClickSelectsWordDefaultRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ top: number; left: number; selection: string } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const theme = useTheme();

  const pasteFromClipboard = () => {
    const term = termRef.current;
    if (!term) return;
    void readFromClipboard().then((text) => {
      if (text === null) {
        showToast('warning', 'Clipboard read unavailable or denied — allow clipboard access, or paste with the keyboard.');
        return;
      }
      if (text) term.paste(text);
    });
  };

  const prepareRightClick = () => {
    const term = termRef.current;
    if (!term) return;
    term.options.rightClickSelectsWord = xtermRightClickSelectsWord(
      rightClickSelectsWordDefaultRef.current,
      useUiPrefsStore.getState().rightClickAction,
      term.hasSelection(),
    );
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const intent = terminalRightClickIntent(useUiPrefsStore.getState().rightClickAction, term.getSelection());
    if (intent.kind === 'menu') {
      setContextMenu({ top: e.clientY, left: e.clientX, selection: intent.selection });
      return;
    }
    if (intent.kind === 'copy') {
      void copyToClipboard(intent.selection).then((ok) => {
        if (ok) term.clearSelection();
      });
      return;
    }
    pasteFromClipboard();
  };

  const closeContextMenu = () => {
    setContextMenu(null);
    termRef.current?.focus();
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const { monoFontSize } = useUiPrefsStore.getState();
    const term = new Terminal({
      fontSize: monoFontSize + 1,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      cursorBlink: true,
      theme: { background: '#16161e' },
    });
    rightClickSelectsWordDefaultRef.current = term.options.rightClickSelectsWord ?? false;
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    fitRef.current = fit;
    termRef.current = term;
    serializeRef.current = serialize;
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.open(el);
    fit.fit();
    if (initialSnapshotRef.current) term.write(initialSnapshotRef.current);

    const settleTransfer = (prepared: boolean) => {
      const pending = transferPreparationRef.current;
      if (!pending) return;
      transferPreparationRef.current = null;
      clearTimeout(pending.timer);
      pending.resolve(prepared);
    };
    const unregister = registerTerminal(tab.id, {
      prepareTransfer: () => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN || transferPreparationRef.current) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            if (transferPreparationRef.current?.resolve !== resolve) return;
            transferPreparationRef.current = null;
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'cancel-transfer' }));
            resolve(false);
          }, TRANSFER_PREPARE_TIMEOUT_MS);
          transferPreparationRef.current = { resolve, timer };
          ws.send(JSON.stringify({ op: 'prepare-transfer' }));
        });
      },
      cancelTransfer: () => {
        settleTransfer(false);
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'cancel-transfer' }));
      },
      snapshot: () => serialize.serialize(),
    });

    const onSelection = term.onSelectionChange(() => {
      const selection = selectedTerminalText(term, useUiPrefsStore.getState().copyOnSelect);
      if (selection !== null) void copyToClipboard(selection);
    });

    // Inactive tabs and a collapsed dock have zero height. Ignore those
    // resize notifications so the remote PTY keeps its last usable size.
    const observer = new ResizeObserver(() => {
      if (activeRef.current) fit.fit();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      unregister();
      settleTransfer(false);
      onSelection.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      serializeRef.current = null;
    };
  }, [tab.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (reconnectRequest > 0) term.write('\r\n\x1b[90m[reconnecting]\x1b[0m\r\n');
    const { defaultShell, localShell } = useUiPrefsStore.getState();
    const currentTab = useDockStore.getState().tabs.find((candidate) => candidate.id === tab.id);
    const terminalId =
      reconnectRequest === 0 && (currentTab?.kind === 'terminal' || currentTab?.kind === 'node-shell' || currentTab?.kind === 'local-shell')
        ? currentTab.terminalId
        : undefined;
    shellReadyRef.current = false;
    // Reconnect is intentionally a fresh shell. Retaining the old id would race
    // the old socket's explicit close and briefly attach to a session being torn
    // down, producing a second close instead of a usable replacement.
    if (reconnectRequest > 0) useDockStore.getState().setTerminalSession(tab.id, undefined);
    const ws = new WebSocket(
      tab.kind === 'local-shell'
        ? wsUrl('/ws/local-shell', {
            ctx: tab.ctx,
            namespace: tab.namespace,
            shell: localShell !== 'auto' && localShell.trim() ? localShell.trim() : undefined,
            cols: term.cols,
            rows: term.rows,
            terminalId,
          })
        : tab.kind === 'node-shell'
        ? wsUrl('/ws/node-shell', { ctx: tab.ctx, node: tab.node, cols: term.cols, rows: term.rows, terminalId })
        : wsUrl('/ws/exec', {
            ctx: tab.ctx,
            namespace: tab.namespace,
            pod: tab.pod,
            container: tab.container,
            shell: defaultShell !== 'auto' && defaultShell.trim() ? defaultShell.trim() : undefined,
            cols: term.cols,
            rows: term.rows,
            terminalId,
          }),
    );
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'resize', cols: term.cols, rows: term.rows }));
    };
    const encoder = new TextEncoder();
    // Type the queued command once the shell has shown a prompt; a short
    // settle keeps it after any login banner.
    const flushPendingCommand = () => {
      const command = pendingCommandRef.current;
      if (!command || !shellReadyRef.current || ws.readyState !== WebSocket.OPEN) return;
      pendingCommandRef.current = undefined;
      window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(`${command}\r`));
      }, 150);
      useDockStore.getState().setLocalShell(tab.id, { pendingCommand: undefined });
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        if (isLocal && !shellReadyRef.current) {
          shellReadyRef.current = true;
          flushPendingCommand();
        }
      } else if (typeof ev.data === 'string') {
        try {
          const ctl = JSON.parse(ev.data) as ExecServerControl;
          if (ctl.op === 'context') {
            useDockStore.getState().setLocalShell(tab.id, { ctx: ctl.ctx, namespace: ctl.namespace, pty: ctl.pty });
          } else if (ctl.op === 'session') {
            useDockStore.getState().setTerminalSession(tab.id, ctl.terminalId);
            const current = useDockStore.getState().tabs.find((candidate) => candidate.id === tab.id);
            if (current && (current.kind === 'terminal' || current.kind === 'node-shell' || current.kind === 'local-shell') && current.transferId) {
              completeTabTransfer(current.transferId);
              useDockStore.getState().clearTransfer(tab.id);
            }
          } else if (ctl.op === 'transfer-ready') {
            const pending = transferPreparationRef.current;
            if (pending) term.write('', () => {
              if (transferPreparationRef.current === pending) {
                transferPreparationRef.current = null;
                clearTimeout(pending.timer);
                pending.resolve(true);
              }
            });
          } else if (ctl.op === 'exit') {
            useDockStore.getState().setTerminalSession(tab.id, undefined);
            term.write(`\r\n\x1b[33m[session ended${ctl.message ? `: ${ctl.message}` : ''}]\x1b[0m\r\n`);
          }
        } catch {
          term.write(ev.data);
        }
      }
    };
    ws.onclose = () => {
      const current = useDockStore.getState().tabs.find((candidate) => candidate.id === tab.id);
      if (current && (current.kind === 'terminal' || current.kind === 'node-shell' || current.kind === 'local-shell') && current.transferId) {
        cancelTabTransfer(current.transferId);
        useDockStore.getState().clearTransfer(tab.id);
      }
      term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    // A command handed to an already-open tab ("run in terminal").
    const unsubscribePending = isLocal
      ? useDockStore.subscribe((state) => {
          const current = state.tabs.find((candidate) => candidate.id === tab.id);
          if (current?.kind !== 'local-shell' || !current.pendingCommand) return;
          pendingCommandRef.current = current.pendingCommand;
          flushPendingCommand();
        })
      : undefined;
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'resize', cols, rows }));
    });
    return () => {
      unsubscribePending?.();
      onData.dispose();
      onResize.dispose();
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      if (wsRef.current === ws) wsRef.current = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, EXEC_SESSION_CLOSE_REASON);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectRequest, tab.id]);

  // Local shells: point the session at another context/namespace. The server
  // rewrites the tab's kubeconfig and confirms with a `context` frame, which
  // updates the tab title; kubectl reads the file fresh on its next run.
  const switchContext = (ctx: string, namespace: string | undefined) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      useDockStore.getState().setLocalShell(tab.id, { ctx, namespace });
      return;
    }
    ws.send(JSON.stringify({ op: 'context', ctx, namespace }));
  };

  // Follow mode: the terminal tracks the cluster switcher and namespace filter.
  const follow = tab.kind === 'local-shell' && !!tab.follow;
  const followCtx = useClustersStore((s) => (follow ? s.selected[0] : undefined));
  const followNamespace = useClustersStore((s) => (follow && followCtx ? s.namespacesByContext[followCtx]?.[0] : undefined));
  const tabCtx = tab.ctx;
  const tabNamespace = tab.kind === 'local-shell' ? tab.namespace : undefined;
  useEffect(() => {
    if (!follow || !followCtx) return;
    if (followCtx === tabCtx && (followNamespace ?? undefined) === (tabNamespace ?? undefined)) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'context', ctx: followCtx, namespace: followNamespace }));
    else useDockStore.getState().setLocalShell(tab.id, { ctx: followCtx, namespace: followNamespace });
  }, [follow, followCtx, followNamespace, tabCtx, tabNamespace, tab.id]);

  // Refit when this tab becomes visible (display:none panes have zero size).
  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);

  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const dock = useDockStore.getState();
      if (dock.open && dock.activeId === tab.id) {
        fitRef.current?.fit();
        termRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, tab.id]);

  return (
    <Box sx={{ height: '100%', p: 1, pt: 0.75, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {tab.kind === 'local-shell' && (
        <LocalShellHeader
          tab={tab}
          onChangeContext={(ctx, namespace) => {
            useDockStore.getState().setLocalShell(tab.id, { follow: false });
            switchContext(ctx, namespace);
          }}
          onToggleFollow={(next) => useDockStore.getState().setLocalShell(tab.id, { follow: next })}
        />
      )}
      <Box
        ref={containerRef}
        onMouseDownCapture={(event) => {
          if (event.button === 2) prepareRightClick();
        }}
        onContextMenuCapture={prepareRightClick}
        onContextMenu={onContextMenu}
        sx={{
          flex: 1,
          minHeight: 0,
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
      <Menu
        open={contextMenu !== null}
        onClose={closeContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ?? undefined}
      >
        <MenuItem
          disabled={!contextMenu?.selection}
          onClick={() => {
            const selection = contextMenu?.selection;
            const term = termRef.current;
            if (selection && term) {
              void copyToClipboard(selection).then((ok) => {
                if (ok) term.clearSelection();
              });
            }
            closeContextMenu();
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeContextMenu();
            pasteFromClipboard();
          }}
        >
          <ListItemIcon>
            <ContentPasteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Paste</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            termRef.current?.selectAll();
            closeContextMenu();
          }}
        >
          <ListItemIcon>
            <SelectAllIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Select all</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}
