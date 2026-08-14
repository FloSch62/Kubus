import { useCallback, useEffect, useRef } from 'react';
import Editor, { type EditorProps, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

type MonacoEditorProps = Omit<EditorProps, 'keepCurrentModel'>;

/**
 * Monaco's React wrapper disposes the text model before the editor widget.
 * Monaco 0.55 can still consult editor-scoped services while reacting to that
 * model disposal, after those services have begun shutting down. Keep the
 * model through the child cleanup, then release it once the widget is gone.
 */
export function MonacoEditor({ onMount, ...props }: MonacoEditorProps) {
  const model = useRef<editor.ITextModel | undefined>(undefined);
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  const handleMount = useCallback<OnMount>((mountedEditor, monaco) => {
    model.current = mountedEditor.getModel() ?? undefined;
    onMountRef.current?.(mountedEditor, monaco);
  }, []);

  useEffect(
    () => () => {
      const current = model.current;
      model.current = undefined;
      // Parent effect cleanup runs before the wrapped editor's cleanup. Defer
      // model disposal until the child has synchronously disposed its widget.
      queueMicrotask(() => {
        if (!current?.isDisposed()) current?.dispose();
      });
    },
    [],
  );

  return <Editor {...props} keepCurrentModel onMount={handleMount} />;
}
