import '../monaco-setup.js';
import { useCallback, useEffect, useRef } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useTheme } from '@mui/material/styles';
import { useUiPrefsStore } from '../state/prefs.js';
import type { DiffViewerProps } from './DiffViewer.js';

export default function DiffViewerImpl({ left, right, hideUnchanged = false, onChangeCount }: DiffViewerProps) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const models = useRef<editor.IDiffEditorModel | undefined>(undefined);
  const changeCountRef = useRef(onChangeCount);
  changeCountRef.current = onChangeCount;
  const handleMount = useCallback<DiffOnMount>((diffEditor) => {
    models.current = diffEditor.getModel() ?? undefined;
    // Changed blocks, recounted whenever Monaco finishes a diff pass.
    diffEditor.onDidUpdateDiff(() => changeCountRef.current?.(diffEditor.getLineChanges()?.length ?? 0));
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
      options={{
        readOnly: true,
        // The hunk toolbar is for editable diffs, and its menu keeps listening
        // to context keys after the widget is disposed: closing a review while
        // another editor takes focus threw "AbstractContextKeyService has been
        // disposed".
        renderGutterMenu: false,
        renderSideBySide: true,
        minimap: { enabled: false },
        fontSize: monoFontSize,
        hideUnchangedRegions: { enabled: hideUnchanged, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
      }}
    />
  );
}
