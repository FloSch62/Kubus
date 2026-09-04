import type { RefObject } from 'react';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';

/**
 * Compact filter box for the child tables inside a detail drawer (pods of a
 * Deployment, resources of a Helm release, everything that uses a Secret).
 * Sits in a Section header, so it stops clicks from toggling the section.
 */
export function MiniFilterInput({
  value,
  onChange,
  placeholder = 'Filter',
  inputRef,
  width = 180,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  width?: number;
}) {
  return (
    <TextField
      size="small"
      value={value}
      inputRef={inputRef}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (value) onChange('');
        else (e.target as HTMLElement).blur();
      }}
      sx={{ width, '& .MuiOutlinedInput-root': { height: 28, fontSize: 12.5, pr: 0.5 }, '& input': { py: 0, px: 0.75 } }}
      slotProps={{
        htmlInput: { 'aria-label': placeholder },
        input: {
          startAdornment: (
            <InputAdornment position="start" sx={{ ml: 0.75, mr: 0 }}>
              <SearchIcon sx={{ fontSize: 15, color: 'text.disabled' }} />
            </InputAdornment>
          ),
          endAdornment: value ? (
            <InputAdornment position="end">
              <IconButton aria-label="Clear filter" size="small" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange('')} sx={{ p: 0.25 }}>
                <ClearIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </InputAdornment>
          ) : undefined,
        },
      }}
    />
  );
}

/** Every space-separated word of the query must appear in one of the fields (case-insensitive). */
export function matchesMiniFilter(query: string, fields: string[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fields.join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}
