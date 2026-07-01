import { Autocomplete, Chip, TextField } from '@mui/material';
import { useNamespaces } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';

export function NamespaceFilter() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const setNamespaces = useClustersStore((s) => s.setNamespaces);
  const { data: options } = useNamespaces(selected);

  if (selected.length === 0) return null;

  return (
    <Autocomplete
      multiple
      size="small"
      options={options ?? []}
      value={namespaces}
      onChange={(_e, value) => setNamespaces(value)}
      limitTags={2}
      disableCloseOnSelect
      renderValue={(value, getItemProps) =>
        value.map((option, index) => <Chip {...getItemProps({ index })} key={option} label={option} size="small" />)
      }
      renderInput={(params) => <TextField {...params} placeholder={namespaces.length ? '' : 'All namespaces'} variant="outlined" />}
      sx={{ minWidth: 260, maxWidth: 480 }}
    />
  );
}
