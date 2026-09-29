import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha, type SxProps, type Theme } from '@mui/material/styles';

interface Props {
  title: string;
  icon?: React.ReactElement;
  /** Size of what the page lists, shown as a pill right after the title. */
  count?: React.ReactNode;
  /** Quiet context after the count, e.g. the resource's group/version/kind. */
  subtitle?: React.ReactNode;
  /** Page actions, pushed to the right edge (the primary one last). */
  actions?: React.ReactNode;
  /** Extra elements rendered to the right of the title (chips, actions…). */
  children?: React.ReactNode;
  sx?: SxProps<Theme>;
}

/** The count pill next to a page title. Numbers get thousands separators. */
export function PageCount({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <Box
      component="span"
      aria-label={label}
      sx={(theme) => ({
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        px: 0.875,
        borderRadius: 999,
        bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.08 : 0.05),
        color: 'text.secondary',
        fontSize: 12,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      })}
    >
      {typeof children === 'number' ? children.toLocaleString() : children}
    </Box>
  );
}

export function PageHeader({ title, icon, count, subtitle, actions, children, sx }: Props) {
  return (
    <Stack
      direction="row"
      useFlexGap
      sx={[{ mb: 1.5, flexWrap: 'wrap', columnGap: 1.25, rowGap: 1, alignItems: 'center', minWidth: 0 }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    >
      {icon && (
        <Box
          sx={(theme) => ({
            width: 32,
            height: 32,
            borderRadius: 1.5,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            color: 'primary.main',
            bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.08),
            '& svg': { fontSize: 19 },
          })}
        >
          {icon}
        </Box>
      )}
      <Typography variant="h6" sx={{ whiteSpace: 'nowrap' }}>
        {title}
      </Typography>
      {count !== undefined && count !== null && <PageCount>{count}</PageCount>}
      {subtitle}
      {children}
      {actions && (
        <Stack direction="row" useFlexGap sx={{ ml: 'auto', gap: 1, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
