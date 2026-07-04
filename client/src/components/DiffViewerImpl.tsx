import '../monaco-setup.js';
import { DiffEditor } from '@monaco-editor/react';
import { useTheme } from '@mui/material/styles';
import { useUiPrefsStore } from '../state/prefs.js';

export default function DiffViewerImpl({ left, right }: { left: string; right: string }) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  return (
    <DiffEditor
      language="yaml"
      original={left}
      modified={right}
      theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
      options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: monoFontSize }}
    />
  );
}
