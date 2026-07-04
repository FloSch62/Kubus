import { useMemo, useState, type MouseEvent, type RefObject } from 'react';
import { Autocomplete, Box, Divider, IconButton, InputAdornment, Popover, TextField, Tooltip, Typography } from '@mui/material';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlined';
import type { ClusterRow } from '../api/queries.js';
import { smartFilterSuggestions, type FilterSuggestion } from '../smart-filter.js';
import { podSummary } from '../kube-display.js';

const HELP_PANEL_ID = 'smart-filter-help';

const HELP_SECTIONS = [
  {
    title: 'Match resources',
    items: [
      ['/name:api', 'Resource name contains api'],
      ['/ns:prod cluster:staging', 'Namespace contains prod and cluster contains staging'],
      ['/label:app=nginx', 'Label app is nginx. Use * as a wildcard in values.'],
      ['/label:app', 'Resource has a label key containing app'],
    ],
  },
  {
    title: 'State and metrics',
    items: [
      ['/status:crash', 'CrashLoopBackOff status alias'],
      ['/status:oom,error', 'OOMKilled or error/backoff status aliases'],
      ['/ready:false', 'Pods, nodes, or workloads that are not ready'],
      ['/restarts>5', 'Pods with more than 5 restarts'],
      ['/cpu>100m mem>50%', 'CPU and memory comparisons. Percent uses capacity.'],
    ],
  },
  {
    title: 'Operators',
    items: [
      ['/age>2d age<1w', 'Older than two days and younger than one week'],
      ['/!node:worker-1', 'Exclude resources on a matching node'],
      ['/name:"foo bar"', 'Quotes keep spaces inside one value'],
      ['/status:crash,oom', 'Comma values are OR within one clause'],
    ],
  },
] as const;

interface Props {
  value: string;
  onChange: (value: string) => void;
  kind: string;
  rows: ClusterRow[];
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * Table search box. Plain text by default; a leading `/` switches to
 * smart-filter syntax with token autocomplete.
 */
export function SmartFilterInput({ value, onChange, kind, rows, inputRef }: Props) {
  const [focused, setFocused] = useState(false);
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const helpOpen = Boolean(helpAnchor);

  const toggleHelp = (event: MouseEvent<HTMLElement>) => {
    setHelpAnchor((current) => (current ? null : event.currentTarget));
  };

  // Cached per rows/kind so typing doesn't rescan all rows on each keystroke.
  const dynamicValues = useMemo(() => {
    const cache = new Map<string, string[]>();
    const compute = (key: string): string[] => {
      const collect = (get: (row: ClusterRow) => string | undefined): string[] => {
        const seen = new Set<string>();
        for (const row of rows) {
          const v = get(row);
          if (v) seen.add(v);
          if (seen.size >= 50) break;
        }
        return [...seen].sort();
      };
      switch (key) {
        case 'ns':
        case 'namespace':
          return collect((r) => r.obj.metadata.namespace);
        case 'cluster':
        case 'ctx':
          return collect((r) => r.ctx);
        case 'node':
          return kind === 'Pod' ? collect((r) => podSummary(r.obj).node) : [];
        case 'label':
          return [...new Set(rows.flatMap((r) => Object.keys(r.obj.metadata.labels ?? {})))].sort().slice(0, 50);
        default:
          return [];
      }
    };
    return (key: string): string[] => {
      let values = cache.get(key);
      if (!values) {
        values = compute(key);
        cache.set(key, values);
      }
      return values;
    };
  }, [rows, kind]);

  // Suggestions only exist in smart mode (leading `/`); the slash is stripped
  // for the suggester and re-attached to the completions it returns.
  const options = useMemo(
    () =>
      focused && value.startsWith('/')
        ? smartFilterSuggestions(value.slice(1), kind, dynamicValues).map((s) => ({ ...s, completion: `/${s.completion}` }))
        : [],
    [focused, value, kind, dynamicValues],
  );

  return (
    <Autocomplete<FilterSuggestion, false, true, true>
      freeSolo
      disableClearable
      options={options}
      filterOptions={(x) => x}
      getOptionLabel={(o) => (typeof o === 'string' ? o : o.completion)}
      inputValue={value}
      onInputChange={(_e, newValue, reason) => {
        // `reset` fires when MUI syncs inputValue after selection — the
        // onChange handler below already applied the completion.
        if (reason !== 'reset') onChange(newValue);
      }}
      onChange={(_e, selected) => {
        if (typeof selected === 'string') return;
        if (selected) onChange(/[:><=]$/.test(selected.completion) ? selected.completion : `${selected.completion} `);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      sx={{ width: 320 }}
      renderOption={(props, option) => (
        <Box component="li" {...props} key={option.completion} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {option.completion.slice(option.completion.lastIndexOf(' ') + 1)}
          </Typography>
          {option.hint && (
            <Typography variant="caption" color="text.secondary" noWrap>
              {option.hint}
            </Typography>
          )}
        </Box>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          placeholder="Search… type / for smart filter"
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                    {value && (
                      <IconButton
                        aria-label="Clear table search"
                        size="small"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onChange('')}
                      >
                        <ClearIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    )}
                    <Tooltip title="Filter syntax">
                      <IconButton
                        aria-label="Show filter syntax help"
                        aria-controls={helpOpen ? HELP_PANEL_ID : undefined}
                        aria-expanded={helpOpen ? 'true' : undefined}
                        size="small"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={toggleHelp}
                      >
                        <HelpOutlineIcon sx={{ fontSize: 16, color: helpOpen ? 'primary.main' : 'text.disabled' }} />
                      </IconButton>
                    </Tooltip>
                    <Popover
                      id={HELP_PANEL_ID}
                      open={helpOpen}
                      anchorEl={helpAnchor}
                      onClose={() => setHelpAnchor(null)}
                      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                      disableRestoreFocus
                      slotProps={{
                        paper: {
                          sx: {
                            mt: 0.75,
                            width: 480,
                            maxWidth: 'calc(100vw - 24px)',
                            border: '1px solid',
                            borderColor: 'divider',
                            boxShadow: (theme) =>
                              theme.palette.mode === 'dark' ? '0 16px 48px rgba(0, 0, 0, 0.55)' : '0 16px 40px rgba(20, 20, 30, 0.16)',
                          },
                        },
                      }}
                    >
                      <FilterHelpPanel />
                    </Popover>
                  </Box>
                </InputAdornment>
              ),
            },
          }}
        />
      )}
    />
  );
}

function FilterHelpPanel() {
  return (
    <Box sx={{ p: 1.5 }}>
      <Box sx={{ mb: 1 }}>
        <Typography variant="subtitle2">Smart filter syntax</Typography>
        <Typography variant="caption" color="text.secondary">
          Start with / to use smart clauses; anything else is plain text search. Spaces combine clauses with AND, commas inside a value mean OR.
        </Typography>
      </Box>
      <Divider sx={{ mb: 1.25 }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        {HELP_SECTIONS.map((section) => (
          <Box key={section.title}>
            <Typography variant="caption" sx={{ display: 'block', mb: 0.5, fontWeight: 650, color: 'text.primary' }}>
              {section.title}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: 'max-content minmax(0, 1fr)' },
                columnGap: 1.25,
                rowGap: 0.65,
                alignItems: 'baseline',
              }}
            >
              {section.items.map(([example, hint]) => (
                <Box key={example} sx={{ display: 'contents' }}>
                  <Typography
                    component="code"
                    variant="caption"
                    sx={{
                      justifySelf: 'start',
                      px: 0.75,
                      py: 0.25,
                      borderRadius: 1,
                      bgcolor: 'action.hover',
                      color: 'text.primary',
                      fontFamily: 'monospace',
                      lineHeight: 1.65,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {example}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                    {hint}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
