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
  const editorRef = useRef<editor.IStandaloneCodeEditor | undefined>(undefined);
  const models = useRef(new Set<editor.ITextModel>());
  const modelListener = useRef<{ dispose: () => void } | undefined>(undefined);
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  const handleMount = useCallback<OnMount>((mountedEditor, monaco) => {
    editorRef.current = mountedEditor;
    const trackModel = () => {
      const current = mountedEditor.getModel();
      if (current) models.current.add(current);
    };
    trackModel();
    modelListener.current = mountedEditor.onDidChangeModel(trackModel);
    onMountRef.current?.(mountedEditor, monaco);
  }, []);

  useEffect(
    () => () => {
      modelListener.current?.dispose();
      modelListener.current = undefined;
      // onMount only runs once, but changing `path` swaps the editor's model.
      // Include the live model as a final guard in case teardown overlaps a
      // switch before Monaco's model-change event has been delivered.
      const current = editorRef.current?.getModel() ?? undefined;
      if (current) models.current.add(current);
      const ownedModels = [...models.current];
      models.current.clear();
      editorRef.current = undefined;
      // Parent effect cleanup runs before the wrapped editor's cleanup. Defer
      // model disposal until the child has synchronously disposed its widget.
      queueMicrotask(() => {
        for (const model of ownedModels) {
          if (!model.isDisposed()) model.dispose();
        }
      });
    },
    [],
  );

  return <Editor {...props} keepCurrentModel onMount={handleMount} />;
}
