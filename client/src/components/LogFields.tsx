import { memo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { copyToClipboard } from '../clipboard.js';
import { showToast } from '../state/toast.js';
import type { LogField, LogFields as ParsedLogFields } from './log-format.js';

/** Value colours on the always-dark log body, matching the inline highlighter. */
const VALUE_COLORS: Record<LogField['kind'], string> = {
  str: '#d4d4da',
  num: '#e0af68',
  bool: '#bb9af7',
  null: '#6b7089',
  json: '#7dcfff',
};

async function copyWithFeedback(text: string, what: string): Promise<void> {
  if (await copyToClipboard(text)) showToast('success', `Copied ${what}`);
  else showToast('error', 'Could not copy to the clipboard');
}

function prettyJson(line: string): string {
  try {
    return JSON.stringify(JSON.parse(line), null, 2);
  } catch {
    return line;
  }
}

interface LogFieldsProps {
  parsed: ParsedLogFields;
  /** The ANSI-stripped line the fields came from. */
  line: string;
}

/** A structured log line (JSON or logfmt) expanded into a key/value table. */
export const LogFieldsTable = memo(function LogFieldsTable({ parsed, line }: LogFieldsProps) {
  const copyAll = () =>
    void copyWithFeedback(
      parsed.format === 'json' ? prettyJson(line) : parsed.fields.map((field) => `${field.key}=${field.value}`).join('\n'),
      parsed.format === 'json' ? 'the line as formatted JSON' : 'the fields',
    );
  return (
    <Box
      sx={{
        ml: 2.5,
        mr: 1,
        border: '1px solid rgba(122,162,247,0.28)',
        borderLeftWidth: 3,
        borderRadius: 1,
        bgcolor: '#1b1c22',
        whiteSpace: 'normal',
        cursor: 'auto',
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.25, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Box component="span" sx={{ color: '#9aa0b5', fontSize: '0.92em' }}>
          {parsed.format === 'json' ? 'JSON' : 'logfmt'} · {parsed.fields.length} {parsed.fields.length === 1 ? 'field' : 'fields'}
        </Box>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={<ContentCopyIcon sx={{ fontSize: '14px !important' }} />}
          onClick={copyAll}
          sx={{ color: '#9aa0b5', fontSize: 11, py: 0, minHeight: 0, textTransform: 'none' }}
        >
          {parsed.format === 'json' ? 'Copy formatted JSON' : 'Copy fields'}
        </Button>
      </Box>
      <Box component="table" aria-label="Log line fields" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95em' }}>
        <tbody>
          {parsed.text ? (
            <Box component="tr" sx={{ verticalAlign: 'top' }}>
              <Box component="th" scope="row" sx={{ textAlign: 'left', fontWeight: 400, fontStyle: 'italic', color: '#6b7089', px: 1, py: 0.25, whiteSpace: 'nowrap' }}>
                text
              </Box>
              <Box component="td" colSpan={2} sx={{ color: '#d4d4da', px: 1, py: 0.25, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {parsed.text}
              </Box>
            </Box>
          ) : null}
          {parsed.fields.map((field, index) => (
            <Box
              component="tr"
              key={`${field.key}-${index}`}
              sx={{ verticalAlign: 'top', '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' }, '&:hover .kubus-field-copy, &:focus-within .kubus-field-copy': { opacity: 1 } }}
            >
              <Box
                component="th"
                scope="row"
                sx={{ textAlign: 'left', fontWeight: 400, color: '#7aa2f7', px: 1, py: 0.25, width: '1%', whiteSpace: 'nowrap', maxWidth: 320, overflowWrap: 'anywhere' }}
              >
                {field.key}
              </Box>
              <Box component="td" sx={{ color: VALUE_COLORS[field.kind], px: 1, py: 0.25, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {field.value === '' ? <Box component="span" sx={{ color: '#6b7089', fontStyle: 'italic' }}>empty</Box> : field.value}
              </Box>
              <Box component="td" sx={{ width: 28, pr: 0.5 }}>
                <Tooltip title={`Copy ${field.key}`}>
                  <IconButton
                    className="kubus-field-copy"
                    size="small"
                    aria-label={`Copy value of ${field.key}`}
                    onClick={() => void copyWithFeedback(field.value, field.key)}
                    sx={{ p: 0.25, color: '#9aa0b5', opacity: 0, '&:focus-visible': { opacity: 1 } }}
                  >
                    <ContentCopyIcon sx={{ fontSize: 13 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          ))}
        </tbody>
      </Box>
    </Box>
  );
});
