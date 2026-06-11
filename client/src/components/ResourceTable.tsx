import { useEffect, useMemo, useState } from 'react';
import { Box, Chip, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { DataGrid, type GridColDef, type GridColumnVisibilityModel, type GridRowParams } from '@mui/x-data-grid';
import type { ClusterRow } from '../api/queries.js';

interface Props {
  rows: ClusterRow[];
  columns: GridColDef<ClusterRow>[];
  loading?: boolean;
  statusText?: string;
  filter?: string;
  labelSelector?: string;
  fieldSelector?: string;
  onFilterChange?: (value: string) => void;
  onLabelSelectorChange?: (value: string) => void;
  onFieldSelectorChange?: (value: string) => void;
  onRowClick?: (row: ClusterRow) => void;
  /** Extra toolbar elements (e.g. create button). */
  toolbar?: React.ReactNode;
  /** Enable checkbox selection; returns selected rows. */
  onSelectionChange?: (rows: ClusterRow[]) => void;
  checkboxSelection?: boolean;
  /** Column fields hidden by default (user can re-enable via the column menu). */
  hiddenFields?: string[];
}

export function ResourceTable({
  rows,
  columns,
  loading,
  statusText,
  filter,
  labelSelector,
  fieldSelector,
  onFilterChange,
  onLabelSelectorChange,
  onFieldSelectorChange,
  onRowClick,
  toolbar,
  checkboxSelection,
  onSelectionChange,
  hiddenFields,
}: Props) {
  const [localFilter, setLocalFilter] = useState('');
  const activeFilter = filter ?? localFilter;

  const hiddenKey = (hiddenFields ?? []).join(',');
  const [visibility, setVisibility] = useState<GridColumnVisibilityModel>({});
  useEffect(() => {
    setVisibility(Object.fromEntries(hiddenKey ? hiddenKey.split(',').map((f) => [f, false]) : []));
  }, [hiddenKey]);

  const filtered = useMemo(() => {
    if (!activeFilter) return rows;
    const f = activeFilter.toLowerCase();
    return rows.filter(
      (r) =>
        r.obj.metadata.name.toLowerCase().includes(f) ||
        (r.obj.metadata.namespace ?? '').toLowerCase().includes(f) ||
        r.ctx.toLowerCase().includes(f),
    );
  }, [rows, activeFilter]);

  const setTextFilter = (value: string) => {
    if (onFilterChange) onFilterChange(value);
    else setLocalFilter(value);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, py: 1, flexShrink: 0 }}>
        <TextField
          placeholder="Search…"
          value={activeFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          sx={{ width: 240 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
            },
          }}
        />
        {onLabelSelectorChange && (
          <TextField
            placeholder="Label selector"
            value={labelSelector ?? ''}
            onChange={(e) => onLabelSelectorChange(e.target.value)}
            sx={{ width: 220 }}
          />
        )}
        {onFieldSelectorChange && (
          <TextField
            placeholder="Field selector"
            value={fieldSelector ?? ''}
            onChange={(e) => onFieldSelectorChange(e.target.value)}
            sx={{ width: 220 }}
          />
        )}
        <Chip label={`${filtered.length} items`} variant="outlined" />
        {statusText && (
          <Typography variant="caption" color="warning.main">
            {statusText}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {toolbar}
      </Stack>
      <DataGrid
        rows={filtered}
        columns={columns}
        loading={loading}
        getRowId={(r) => r.obj.metadata.uid}
        density="compact"
        checkboxSelection={checkboxSelection}
        onRowSelectionModelChange={
          onSelectionChange
            ? (model) => {
                const ids = model.ids instanceof Set ? model.ids : new Set();
                onSelectionChange(filtered.filter((r) => ids.has(r.obj.metadata.uid)));
              }
            : undefined
        }
        disableRowSelectionOnClick={!!checkboxSelection}
        onRowClick={onRowClick ? (params: GridRowParams<ClusterRow>) => onRowClick(params.row) : undefined}
        columnVisibilityModel={visibility}
        onColumnVisibilityModelChange={setVisibility}
        initialState={{ sorting: { sortModel: [{ field: 'name', sort: 'asc' }] } }}
        sx={{
          border: 0,
          flex: 1,
          minHeight: 0,
          '& .MuiDataGrid-row': { cursor: onRowClick ? 'pointer' : 'default' },
          '& .MuiDataGrid-cell:focus, & .MuiDataGrid-columnHeader:focus': { outline: 'none' },
        }}
      />
    </Box>
  );
}
