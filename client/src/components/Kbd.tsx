import Box from '@mui/material/Box';

/** Keycap chip shared by the shortcut cheatsheet and the go-to panel. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="kbd"
      sx={{
        fontFamily: 'monospace',
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: 1,
        px: 0.75,
        py: 0.5,
        minWidth: 22,
        textAlign: 'center',
        display: 'inline-block',
        border: 1,
        borderColor: 'divider',
        borderBottomWidth: 2,
        borderRadius: 1,
        bgcolor: 'action.hover',
        color: 'text.primary',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  );
}
