import { Box, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';

interface Props {
  title: string;
  icon?: React.ReactElement;
  /** Extra elements rendered to the right of the title (chips, actions…). */
  children?: React.ReactNode;
}

export function PageHeader({ title, icon, children }: Props) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ mb: 1.5, flexWrap: 'wrap', rowGap: 1, alignItems: 'center' }}>
      {icon && (
        <Box
          sx={(theme) => ({
            width: 32,
            height: 32,
            borderRadius: 2,
            display: 'grid',
            placeItems: 'center',
            color: 'primary.main',
            bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.08),
            '& svg': { fontSize: 19 },
          })}
        >
          {icon}
        </Box>
      )}
      <Typography variant="h6">{title}</Typography>
      {children}
    </Stack>
  );
}
