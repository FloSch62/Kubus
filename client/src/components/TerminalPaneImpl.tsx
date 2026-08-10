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
import '@xterm/xterm/css/xterm.css';
import type { ExecServerControl } from '@kubus/shared';
import { wsUrl } from '../api/http.js';
import { copyToClipboard, readFromClipboard } from '../clipboard.js';
import type { NodeShellTab, TerminalTab } from '../state/dock.js';
import { useDockStore } from '../state/dock.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { selectedTerminalText } from '../terminal-selection.js';
import { terminalRightClickIntent, xtermRightClickSelectsWord } from '../terminal-right-click.js';

export default function TerminalPaneImpl({ tab, active, focusRequest }: { tab: TerminalTab | NodeShellTab; active: boolean; focusRequest: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
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

    const { monoFontSize, defaultShell } = useUiPrefsStore.getState();
    const term = new Terminal({
      fontSize: monoFontSize + 1,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      cursorBlink: true,
      theme: { background: '#16161e' },
    });
    rightClickSelectsWordDefaultRef.current = term.options.rightClickSelectsWord ?? false;
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
      onData.dispose();
      onResize.dispose();
      onSelection.dispose();
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
    <Box sx={{ height: '100%', p: 1, pt: 0.75 }}>
      <Box
        ref={containerRef}
        onMouseDownCapture={(event) => {
          if (event.button === 2) prepareRightClick();
        }}
        onContextMenuCapture={prepareRightClick}
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
