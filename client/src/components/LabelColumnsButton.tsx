import { useMemo, useState } from 'react';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ViewWeekOutlinedIcon from '@mui/icons-material/ViewWeekOutlined';
import type { LabelColumnSpec } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { labelColumnField, labelKeyCounts, sameLabelColumn } from './label-columns.js';

const EMPTY: LabelColumnSpec[] = [];
const keyFilterOptions = createFilterOptions<{ key: string; count: number }>({ limit: 100, stringify: (o) => o.key });

/**
 * Toolbar button for per-table label and annotation columns: pick a key
 * (suggested from the keys present in the list, with how many rows carry
 * it) and it becomes a column, stored with the table's other column prefs.
 */
export function LabelColumnsButton({ tableId, rows }: { tableId: string; rows: ClusterRow[] }) {
  const columns = useUiPrefsStore((s) => s.labelColumns[tableId] ?? EMPTY);
  const setLabelColumns = useUiPrefsStore((s) => s.setLabelColumns);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [source, setSource] = useState<LabelColumnSpec['source']>('label');
  const [input, setInput] = useState('');
  const open = !!anchor;

  // Only scan the rows while the picker is open.
  const counts = useMemo(() => (open ? { label: labelKeyCounts(rows, 'label'), annotation: labelKeyCounts(rows, 'annotation') } : undefined), [open, rows]);
  const coverage = (spec: LabelColumnSpec) => counts?.[spec.source].find((c) => c.key === spec.key)?.count ?? 0;
  const options = (counts?.[source] ?? []).filter((o) => !columns.some((c) => sameLabelColumn(c, { source, key: o.key })));
  const key = input.trim();
  const duplicate = !!key && columns.some((c) => sameLabelColumn(c, { source, key }));

  const add = (value: string) => {
    const spec = { source, key: value.trim() };
    if (!spec.key || columns.some((c) => sameLabelColumn(c, spec))) return;
    setLabelColumns(tableId, [...columns, spec]);
    // A column hidden from the grid's menu before it was removed comes back visible.
    const { columnVisibility, setColumnVisibility } = useUiPrefsStore.getState();
    const field = labelColumnField(spec);
    if (columnVisibility[tableId]?.[field] === false) setColumnVisibility(tableId, { ...columnVisibility[tableId], [field]: true });
    setInput('');
  };

  return (
    <>
      <Tooltip title="Add a column for any label or annotation key">
        <Button
          variant="outlined"
          startIcon={<ViewWeekOutlinedIcon />}
          aria-haspopup="dialog"
          aria-expanded={open ? 'true' : undefined}
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          Columns{columns.length ? ` (${columns.length})` : ''}
        </Button>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { mt: 0.75, width: 400, maxWidth: 'calc(100vw - 24px)', border: '1px solid', borderColor: 'divider' } } }}
      >
        <Box sx={{ p: 1.5 }}>
          <Typography variant="subtitle2">Label and annotation columns</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.25 }}>
            Show a label or annotation value as its own column. Sort and filter it like any other column; this list keeps it.
          </Typography>
          <Stack spacing={1}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={source}
              onChange={(_e, v: LabelColumnSpec['source'] | null) => v && setSource(v)}
              aria-label="Column source"
              sx={{ alignSelf: 'flex-start' }}
            >
              <ToggleButton value="label">Label</ToggleButton>
              <ToggleButton value="annotation">Annotation</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete<{ key: string; count: number }, false, false, true>
              freeSolo
              size="small"
              fullWidth
              options={options}
              value={null}
              filterOptions={keyFilterOptions}
              getOptionLabel={(o) => (typeof o === 'string' ? o : o.key)}
              inputValue={input}
              onInputChange={(_e, value, reason) => {
                if (reason !== 'reset') setInput(value);
              }}
              onChange={(_e, value) => {
                if (value) add(typeof value === 'string' ? value : value.key);
              }}
              renderOption={({ key: optionKey, ...props }, option) => (
                <Box component="li" key={optionKey} {...props} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12.5, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    {option.key}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {option.count} of {rows.length}
                  </Typography>
                </Box>
              )}
              noOptionsText={key ? `No row has this ${source}; press Enter to add it anyway` : `No ${source}s in this list`}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder={`Pick or type a${source === 'label' ? ' label' : 'n annotation'} key`}
                  slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, 'aria-label': `${source === 'label' ? 'Label' : 'Annotation'} key` } }}
                  error={duplicate}
                  helperText={duplicate ? 'Already a column' : undefined}
                />
              )}
            />
          </Stack>
          <Divider sx={{ my: 1.25 }} />
          {columns.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No label or annotation columns yet.
            </Typography>
          ) : (
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
              {columns.map((spec) => (
                <Box component="li" key={`${spec.source}:${spec.key}`} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ width: 68, flexShrink: 0 }}>
                    {spec.source}
                  </Typography>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12.5, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    {spec.key}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {coverage(spec)} of {rows.length}
                  </Typography>
                  <Tooltip title="Remove column">
                    <IconButton
                      size="small"
                      aria-label={`Remove column ${spec.key}`}
                      onClick={() => setLabelColumns(tableId, columns.filter((c) => !sameLabelColumn(c, spec)))}
                    >
                      <CloseIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Popover>
    </>
  );
}
