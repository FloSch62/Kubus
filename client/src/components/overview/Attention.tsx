import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { statusTextColor } from '../../theme.js';

/** Small uppercase label above an overview block ("Needs attention", "Inventory"). */
export function OverviewLabel({ children, end }: { children: React.ReactNode; end?: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.75, minWidth: 0 }}>
      <Typography
        variant="caption"
        component="h3"
        sx={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary', flexShrink: 0 }}
      >
        {children}
      </Typography>
      {end && (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: 'auto', minWidth: 0 }}>
          {end}
        </Typography>
      )}
    </Box>
  );
}

export interface AttentionItem {
  key: string;
  tone: 'error' | 'warning';
  count: number;
  /** "failing pods" — reads after the count. */
  label: string;
  /** One-line breakdown under the headline. */
  detail?: string;
  /** Link text: "Show pods", "Jump to list". */
  action: string;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * The overview's first row: only things that need attention, as soft red
 * or amber tiles with a labelled link to where they are. Tiles with nothing
 * to report are left out; with nothing at all a calm confirmation takes the
 * row. `pending` keeps a placeholder while a slow source is still loading,
 * so "all healthy" is never claimed before every source has answered.
 */
export function AttentionTiles({ items, pending, healthyText }: { items: AttentionItem[]; pending?: boolean; healthyText: string }) {
  const shown = items.filter((item) => item.count > 0);
  if (shown.length === 0 && pending) return <Skeleton variant="rounded" height={64} />;
  if (shown.length === 0) {
    return (
      <Box
        component="output"
        sx={(theme) => ({
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          px: 1.75,
          py: 1.25,
          borderRadius: 1.5,
          bgcolor: alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.12 : 0.07),
        })}
      >
        <CheckCircleOutlineIcon sx={{ fontSize: 20, color: statusTextColor('success') }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Nothing needs attention
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {healthyText}
          </Typography>
        </Box>
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 1 }}>
      {shown.map((item) => (
        <AttentionTile key={item.key} item={item} />
      ))}
    </Box>
  );
}

function AttentionTile({ item }: { item: AttentionItem }) {
  return (
    <ButtonBase
      onClick={item.onClick}
      aria-label={`${item.count} ${item.label}. ${item.action}`}
      sx={(theme) => {
        const main = theme.palette[item.tone].main;
        const dark = theme.palette.mode === 'dark';
        return {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          textAlign: 'left',
          gap: 0.25,
          px: 1.5,
          py: 1.125,
          borderRadius: 1.5,
          bgcolor: alpha(main, dark ? 0.13 : 0.075),
          transition: 'background-color 120ms ease',
          '&:hover': { bgcolor: alpha(main, dark ? 0.2 : 0.12) },
          '&:hover .attention-action': { textDecoration: 'underline' },
          '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
        };
      }}
    >
      <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
        <Typography component="span" sx={{ fontSize: 20, fontWeight: 650, lineHeight: 1.2, color: statusTextColor(item.tone), fontVariantNumeric: 'tabular-nums' }}>
          {item.count}
        </Typography>
        <Typography component="span" variant="body2" sx={{ fontWeight: 600, minWidth: 0 }}>
          {item.label}
        </Typography>
      </Box>
      {item.detail && (
        <Typography component="span" variant="caption" color="text.secondary" sx={{ lineHeight: 1.4, overflowWrap: 'anywhere' }}>
          {item.detail}
        </Typography>
      )}
      <Typography
        component="span"
        variant="caption"
        className="attention-action"
        sx={{ mt: 0.5, alignSelf: 'flex-end', display: 'inline-flex', alignItems: 'center', fontWeight: 600, color: 'primary.main' }}
      >
        {item.action}
        <ChevronRightIcon sx={{ fontSize: 16, mr: -0.5 }} />
      </Typography>
    </ButtonBase>
  );
}

/**
 * A compact inventory entry that opens a list: icon, label, count and a
 * chevron, with a hover surface so it reads as a link. `problem` adds a
 * colored "2 failed" after the count.
 */
export function InventoryButton({
  icon,
  label,
  value,
  sub,
  problem,
  title,
  ariaLabel,
  onClick,
}: {
  icon?: React.ReactElement;
  label: string;
  value?: React.ReactNode;
  /** Muted text right after the value ("/62", "unavailable"). */
  sub?: string;
  problem?: { text: string; tone: 'error' | 'warning' };
  title?: string;
  ariaLabel?: string;
  onClick: () => void;
}) {
  return (
    <ButtonBase
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      sx={(theme) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        height: 34,
        pl: icon ? 1 : 1.25,
        pr: 0.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
        maxWidth: '100%',
        transition: 'background-color 120ms ease, border-color 120ms ease',
        '& .inventory-icon': { fontSize: 16, color: 'primary.main' },
        '&:hover': {
          borderColor: alpha(theme.palette.primary.main, 0.5),
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.12 : 0.06),
        },
        '&:hover .inventory-chevron': { color: 'primary.main' },
        '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 },
      })}
    >
      {icon && (
        <Box component="span" className="inventory-icon" sx={{ display: 'inline-flex', '& svg': { fontSize: 16 } }}>
          {icon}
        </Box>
      )}
      <Typography component="span" variant="body2" noWrap sx={{ minWidth: 0 }}>
        {label}
      </Typography>
      {value !== undefined && (
        <Typography component="span" variant="body2" sx={{ fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
          {value}
          {sub && (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ fontWeight: 400 }}>
              {sub}
            </Typography>
          )}
        </Typography>
      )}
      {problem && (
        <Typography component="span" variant="caption" noWrap sx={{ fontWeight: 600, color: statusTextColor(problem.tone) }}>
          {problem.text}
        </Typography>
      )}
      <ChevronRightIcon className="inventory-chevron" sx={{ fontSize: 16, color: 'text.disabled', transition: 'color 120ms ease' }} />
    </ButtonBase>
  );
}

/** Wrapping row of inventory buttons. */
export function InventoryRow({ children }: { children: React.ReactNode }) {
  return <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>{children}</Box>;
}
