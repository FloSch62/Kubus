import { createContext, useContext, type ReactNode } from 'react';
import Box from '@mui/material/Box';

const PaneActiveContext = createContext(true);
export const usePaneActive = () => useContext(PaneActiveContext);

/** Preserve table state and layout on tab switches, including virtualized scroll positions. */
export function ViewPane({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = usePaneActive();
  return (
    <Box
      aria-hidden={active ? undefined : true}
      inert={!active}
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        visibility: active ? 'visible' : 'hidden',
        // Sorted DataGrid headers explicitly set visibility on their icons.
        ...(active ? null : { '& *': { visibility: 'hidden !important' } }),
      }}
    >
      <PaneActiveContext.Provider value={active && parentActive}>{children}</PaneActiveContext.Provider>
    </Box>
  );
}
