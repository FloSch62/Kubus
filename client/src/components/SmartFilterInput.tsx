import { useMemo, useState, type MouseEvent, type RefObject } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import CancelIcon from '@mui/icons-material/Cancel';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlined';
import type { ClusterRow } from '../api/queries.js';
import { smartFilterSuggestions, type FilterSuggestion } from '../smart-filter.js';
import { podSummary } from '../kube-display.js';
import { collectLabelPairs, labelTermFromInput, labelTermSuggestions } from '../label-selector.js';

/** A suggestion row: a smart-filter completion, or a label term to add as a token. */
type Suggestion = FilterSuggestion & { labelTerm?: string };

/** Label tokens shown inside the field; the rest collapse into a +N chip. */
const VISIBLE_LABEL_TOKENS = 3;

const NO_TERMS: string[] = [];

const HELP_PANEL_ID = 'smart-filter-help';

const HELP_SECTIONS = [
  {
    title: 'Match resources',
    items: [
      ['/name:api', 'Resource name contains api'],
      ['/ns:prod cluster:staging', 'Namespace contains prod and cluster contains staging'],
      ['/label:app=nginx', 'Label app is nginx. Use * as a wildcard in values.'],
      ['/label:app', 'Resource has a label key containing app'],
      ['/uid:3f2a9c1e', 'Object UID contains 3f2a9c1e. Events also match on the object they are about.'],
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

const filterHelpPanel = <FilterHelpPanel />;
const filterHelpPanelWithLabels = <FilterHelpPanel labels />;

interface Props {
  value: string;
  onChange: (value: string) => void;
  kind: string;
  rows: ClusterRow[];
  inputRef?: RefObject<HTMLInputElement | null>;
  /**
   * Label selector terms (server-side), shown as removable tokens inside the
   * field. Picking a label suggestion, or typing `label:app=web` and Enter,
   * adds one; Backspace in an empty field removes the last.
   */
  labelTerms?: string[];
  onLabelTermsChange?: (terms: string[]) => void;
  /** Root sizing; defaults to a fixed 320px field. */
  sx?: SxProps<Theme>;
}

const DEFAULT_SX = { width: 320 };

/**
 * Table search box. Plain text by default; a leading `/` switches to
 * smart-filter syntax with token autocomplete. With `onLabelTermsChange` it
 * also holds the list's label selector as tokens.
 */
export function SmartFilterInput({ value, onChange, kind, rows, inputRef, labelTerms, onLabelTermsChange, sx }: Props) {
  const [focused, setFocused] = useState(false);
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const helpOpen = Boolean(helpAnchor);
  const terms = labelTerms ?? NO_TERMS;
  const labelsEnabled = !!onLabelTermsChange;

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

  // The label index is only built while the field has focus.
  const labelPairs = useMemo(
    () => (labelsEnabled && focused ? collectLabelPairs(rows.map((r) => r.obj.metadata.labels)) : undefined),
    [labelsEnabled, focused, rows],
  );

  // Smart mode (leading `/`) completes clauses; the slash is stripped for the
  // suggester and re-attached to the completions it returns. Plain text
  // offers matching labels once two characters are typed (or after `label:`).
  const options = useMemo<Suggestion[]>(() => {
    if (!focused) return [];
    if (value.startsWith('/')) return smartFilterSuggestions(value.slice(1), kind, dynamicValues).map((s) => ({ ...s, completion: `/${s.completion}` }));
    if (!labelPairs) return [];
    const explicit = /^label:/i.test(value.trim());
    if (!explicit && value.trim().length < 2) return [];
    return labelTermSuggestions(labelPairs, value, terms).map((s) => ({
      completion: '',
      labelTerm: s.term,
      hint: s.kind === 'key' ? 'has label' : s.kind === 'selector' ? 'label selector' : 'label',
    }));
  }, [focused, value, kind, dynamicValues, labelPairs, terms]);

  const addLabelTerm = (term: string) => {
    if (!onLabelTermsChange) return;
    if (!terms.includes(term)) onLabelTermsChange([...terms, term]);
    onChange('');
  };

  const visibleTerms = terms.slice(0, VISIBLE_LABEL_TOKENS);
  const hiddenTerms = terms.slice(VISIBLE_LABEL_TOKENS);

  return (
    <Autocomplete<Suggestion, false, true, true>
      freeSolo
      disableClearable
      options={options}
      filterOptions={(x) => x}
      getOptionLabel={(o) => (typeof o === 'string' ? o : o.labelTerm ? value : o.completion)}
      inputValue={value}
      onInputChange={(_e, newValue, reason) => {
        // `reset` fires when MUI syncs inputValue after selection — the
        // onChange handler below already applied the completion.
        if (reason !== 'reset') onChange(newValue);
      }}
      onChange={(_e, selected) => {
        if (typeof selected === 'string') {
          // Enter on `label:app=web` (no suggestion highlighted) adds the term.
          const typed = labelsEnabled ? labelTermFromInput(selected) : undefined;
          if (typed) addLabelTerm(typed);
          return;
        }
        if (!selected) return;
        if (selected.labelTerm) {
          addLabelTerm(selected.labelTerm);
          return;
        }
        onChange(/[:><=]$/.test(selected.completion) ? selected.completion : `${selected.completion} `);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      sx={sx ?? DEFAULT_SX}
      renderOption={(props, option) => (
        <Box component="li" {...props} key={option.labelTerm ? `label:${option.labelTerm}` : option.completion} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 0, overflowWrap: 'anywhere' }}>
            {option.labelTerm ?? option.completion.slice(option.completion.lastIndexOf(' ') + 1)}
          </Typography>
          {option.hint && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: option.labelTerm ? 'auto' : undefined, flexShrink: 0 }}>
              {option.hint}
            </Typography>
          )}
        </Box>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          placeholder={terms.length ? undefined : 'Search… type / for filters'}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && labelsEnabled && terms.length && !value) {
              const input = e.target as HTMLInputElement;
              if (input.selectionStart === 0 && input.selectionEnd === 0) {
                e.preventDefault();
                onLabelTermsChange?.(terms.slice(0, -1));
              }
              return;
            }
            if (e.key !== 'Escape') return;
            const input = e.target as HTMLElement;
            // With the suggestion popup open, Escape only closes it (MUI).
            if (input.getAttribute('aria-expanded') === 'true') return;
            e.stopPropagation();
            if (value) {
              onChange('');
              return;
            }
            // Empty already: leave the input and hand focus to the grid.
            input.blur();
            input
              .closest('.kubus-table')
              ?.querySelector<HTMLElement>('.MuiDataGrid-cell[tabindex="0"], .MuiDataGrid-columnHeader[tabindex="0"], .MuiDataGrid-cell')
              ?.focus();
          }}
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              startAdornment: (
                <InputAdornment position="start" sx={{ gap: 0.5, maxWidth: '62%', overflow: 'hidden', flexShrink: 0 }}>
                  <SearchIcon sx={{ fontSize: 18, flexShrink: 0 }} />
                  {visibleTerms.map((term) => (
                    <Chip
                      key={term}
                      size="small"
                      label={term}
                      title={`Label selector: ${term}`}
                      onDelete={() => onLabelTermsChange?.(terms.filter((t) => t !== term))}
                      onMouseDown={(e) => e.preventDefault()}
                      sx={{ height: 22, fontSize: 12, fontFamily: 'monospace', maxWidth: 220, flexShrink: 1, minWidth: 0 }}
                      deleteIcon={<CancelIcon aria-label={`Remove label filter ${term}`} />}
                    />
                  ))}
                  {hiddenTerms.length > 0 && (
                    <Tooltip title={hiddenTerms.join(', ')}>
                      <Chip size="small" label={`+${hiddenTerms.length}`} sx={{ height: 22, fontSize: 12, flexShrink: 0 }} />
                    </Tooltip>
                  )}
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                    {(value || terms.length > 0) && (
                      <IconButton
                        aria-label={value ? 'Clear table search' : 'Clear label filters'}
                        size="small"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => (value ? onChange('') : onLabelTermsChange?.([]))}
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
                            // Same shadow as the Menu/Autocomplete theme token
                            // so adjacent dropdowns cast identical shadows.
                            boxShadow: (theme) =>
                              theme.palette.mode === 'dark' ? '0 8px 28px rgba(0, 0, 0, 0.5)' : '0 8px 28px rgba(0, 0, 0, 0.12)',
                          },
                        },
                      }}
                    >
                      {labelsEnabled ? filterHelpPanelWithLabels : filterHelpPanel}
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

const LABEL_HELP = {
  title: 'Label selector (filters on the server)',
  items: [
    ['app=web', 'Type part of a label and pick a suggestion to add it as a token'],
    ['label:env!=prod', 'Or type any selector after label: and press Enter'],
    ['Backspace', 'In an empty field, removes the last label token'],
  ],
} as const;

function FilterHelpPanel({ labels = false }: { labels?: boolean }) {
  const sections = labels ? [...HELP_SECTIONS, LABEL_HELP] : HELP_SECTIONS;
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
        {sections.map((section) => (
          <Box key={section.title}>
            <Typography variant="caption" sx={{ display: 'block', mb: 0.5, fontWeight: 600, color: 'text.primary' }}>
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
