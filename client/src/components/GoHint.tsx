import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Fade from '@mui/material/Fade';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import { GO_TARGETS, GO_TIMEOUT_MS } from '../shortcuts.js';
import { useUiStore } from '../state/ui.js';
import { Kbd } from './Kbd.js';

/** Delay before the panel appears — fast typists (g p in one motion) never see it. */
const SHOW_DELAY_MS = 200;

/**
 * Which-key style panel for the `g` go-to sequences: press g, and after a
 * beat every destination shows up with its key. Items are clickable too, so
 * the panel doubles as a mouse launcher. Any outside click, Escape, timeout,
 * or non-matching key dismisses it.
 */
export function GoHint() {
  const pendingSince = useUiStore((s) => s.goPendingSince);
  const clearGoPending = useUiStore((s) => s.clearGoPending);
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const rootRef = useRef<HTMLOutputElement>(null);

  useEffect(() => {
    if (!pendingSince) {
      setShow(false);
      return;
    }
    const showTimer = window.setTimeout(() => setShow(true), SHOW_DELAY_MS);
    const expireTimer = window.setTimeout(clearGoPending, GO_TIMEOUT_MS);
    // A click elsewhere cancels the pending sequence; clicks inside the panel
    // are its own buttons.
    const onPointerDown = (ev: PointerEvent) => {
      if (!(ev.target instanceof Node) || !rootRef.current?.contains(ev.target)) clearGoPending();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(expireTimer);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [pendingSince, clearGoPending]);

  return (
    <Fade in={show && !!pendingSince} unmountOnExit>
      <Paper
        ref={rootRef}
        elevation={8}
        component="output"
        aria-label="Go to destinations"
        sx={{
          position: 'fixed',
          bottom: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: (theme) => theme.zIndex.snackbar,
          p: 1.25,
          borderRadius: 1.5,
          border: 1,
          borderColor: 'divider',
          maxWidth: 'min(760px, calc(100vw - 32px))',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.75, px: 0.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            Go to
          </Typography>
          <Typography variant="caption" color="text.secondary">
            press a key…
          </Typography>
          <Box sx={{ flex: 1, minWidth: 16 }} />
          <Typography variant="caption" color="text.disabled">
            Esc to cancel
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {GO_TARGETS.map((t) => (
            <ButtonBase
              key={t.key}
              onClick={() => {
                clearGoPending();
                void navigate(t.path);
              }}
              sx={{ display: 'flex', gap: 0.75, alignItems: 'center', px: 1, py: 0.5, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
            >
              <Kbd>{t.key.toUpperCase()}</Kbd>
              <Typography variant="body2">{t.label}</Typography>
            </ButtonBase>
          ))}
        </Box>
      </Paper>
    </Fade>
  );
}
