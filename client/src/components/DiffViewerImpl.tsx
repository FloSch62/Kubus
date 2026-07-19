import '../monaco-setup.js';
import { useCallback, useEffect, useRef } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useTheme } from '@mui/material/styles';
import { useUiPrefsStore } from '../state/prefs.js';

export default function DiffViewerImpl({ left, right }: { left: string; right: string }) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const models = useRef<editor.IDiffEditorModel | undefined>(undefined);
  const handleMount = useCallback<DiffOnMount>((diffEditor) => {
    models.current = diffEditor.getModel() ?? undefined;
  }, []);

  useEffect(
    () => () => {
      const current = models.current;
      // @monaco-editor/react otherwise disposes the models before the diff
      // widget, which makes newer Monaco versions throw during dialog close.
      // Let the child dispose its widget first, then release both kept models.
      queueMicrotask(() => {
        if (!current?.original.isDisposed()) current?.original.dispose();
        if (!current?.modified.isDisposed()) current?.modified.dispose();
      });
    },
    [],
  );

  return (
    <DiffEditor
      language="yaml"
      original={left}
      modified={right}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={handleMount}
      theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
      options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: monoFontSize }}
    />
  );
}
