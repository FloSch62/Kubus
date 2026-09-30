import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/**
 * The layout language every Settings tab shares: a page heading, then groups
 * (a small uppercase label above a bordered card) holding rows with the label
 * and its explanation on the left and the control on the right.
 */
export function SettingsPage({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography variant="h6" component="h2" sx={{ fontSize: 18, fontWeight: 650, lineHeight: 1.3 }}>
          {title}
        </Typography>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 620 }}>
            {description}
          </Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

export function SettingsGroup({
  title,
  description,
  action,
  flush = false,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  /** Sits at the end of the label line, e.g. an Add button. */
  action?: React.ReactNode;
  /** No inner padding: the children bring their own (lists). */
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box component="section">
      {(title || action) && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 28, mb: 0.75 }}>
          {title && (
            <Typography
              variant="caption"
              component="h3"
              sx={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary' }}
            >
              {title}
            </Typography>
          )}
          {action && <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>{action}</Box>}
        </Box>
      )}
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25, maxWidth: 640 }}>
          {description}
        </Typography>
      )}
      <Box
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          bgcolor: 'background.paper',
          overflow: 'hidden',
          ...(flush ? {} : { '& > .settings-row + .settings-row': { borderTop: 1, borderColor: 'divider' } }),
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/**
 * One setting: label and explanation on the left, the control on the right.
 * `stacked` puts a wide control (a path field, a form) under the text.
 * `labelFor` ties the label to its input for screen readers.
 */
export function SettingRow({
  label,
  description,
  control,
  stacked = false,
  labelFor,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  stacked?: boolean;
  labelFor?: string;
  /** Extra content under the row (a hint, an alert). */
  children?: React.ReactNode;
}) {
  return (
    <Box className="settings-row" sx={{ px: 2, py: 1.5 }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: stacked ? 'column' : 'row',
          alignItems: stacked ? 'stretch' : 'center',
          flexWrap: 'wrap',
          gap: stacked ? 1.25 : 2,
          rowGap: 1,
        }}
      >
        <Box sx={{ flex: stacked ? 'none' : '1 1 240px', minWidth: 0 }}>
          <Typography variant="body2" component={labelFor ? 'label' : 'div'} htmlFor={labelFor} sx={{ fontWeight: 600, display: 'block' }}>
            {label}
          </Typography>
          {description && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25, lineHeight: 1.5 }}>
              {description}
            </Typography>
          )}
        </Box>
        {control && <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1, maxWidth: '100%', ...(stacked ? {} : { ml: 'auto' }) }}>{control}</Box>}
      </Box>
      {children}
    </Box>
  );
}
