import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
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
      renderOption={({ key, ...props }, option, { selected: isSelected }) => (
        <Box component="li" key={key} {...props} sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
          <Checkbox size="small" checked={isSelected} disableRipple sx={{ p: 0, mr: 0.25 }} />
          <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {option}
          </Typography>
        </Box>
      )}
      renderValue={(value, getItemProps) =>
        value.map((option, index) => <Chip {...getItemProps({ index })} key={option} label={option} size="small" />)
      }
      renderInput={(params) => <TextField {...params} placeholder={namespaces.length ? '' : 'All namespaces'} variant="outlined" />}
      sx={{ minWidth: 260, maxWidth: 480 }}
    />
  );
}
