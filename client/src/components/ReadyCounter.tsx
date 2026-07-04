import Box from '@mui/material/Box';

const READY_RE = /^(\d+)\/(\d+)$/;

function isNotReady(value: string): boolean {
  const match = READY_RE.exec(value.trim());
  if (!match) return false;
  return Number(match[1]) < Number(match[2]);
}

export function ReadyCounter({ value }: { value: string }) {
  return (
    <Box component="span" sx={{ color: isNotReady(value) ? 'warning.main' : 'inherit' }}>
      {value}
    </Box>
  );
}
