import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MonacoEditor } from '../../../client/src/components/MonacoEditor.js';

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  keepCurrentModel: false,
  modelChangeListener: undefined as (() => void) | undefined,
  notifyModelChange() {
    this.modelChangeListener?.();
  },
  currentModel: undefined as
    | {
        name: string;
        disposed: boolean;
        isDisposed: () => boolean;
        dispose: () => void;
      }
    | undefined,
  firstModel: {
    name: 'first',
    disposed: false,
    isDisposed() {
      return this.disposed;
    },
    dispose() {
      this.disposed = true;
      lifecycle.events.push('first model');
    },
  },
  secondModel: {
    name: 'second',
    disposed: false,
    isDisposed() {
      return this.disposed;
    },
    dispose() {
      this.disposed = true;
      lifecycle.events.push('second model');
    },
  },
}));

vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor({
    keepCurrentModel,
    onMount,
  }: {
    keepCurrentModel?: boolean;
    onMount?: (
      editor: {
        getModel: () => typeof lifecycle.currentModel;
        onDidChangeModel: (listener: () => void) => { dispose: () => void };
      },
      monaco: object,
    ) => void;
  }) {
    useEffect(() => {
      lifecycle.keepCurrentModel = !!keepCurrentModel;
      onMount?.(
        {
          getModel: () => lifecycle.currentModel,
          onDidChangeModel: (listener) => {
            lifecycle.modelChangeListener = listener;
            return {
              dispose: () => {
                if (lifecycle.modelChangeListener === listener) lifecycle.modelChangeListener = undefined;
              },
            };
          },
        },
        {},
      );
      return () => {
        lifecycle.events.push('editor');
      };
    }, [keepCurrentModel, onMount]);
    return <textarea aria-label="Monaco mock" />;
  },
}));

describe('MonacoEditor', () => {
  it('disposes the model only after the editor widget has been disposed', async () => {
    lifecycle.events = [];
    lifecycle.keepCurrentModel = false;
    lifecycle.modelChangeListener = undefined;
    lifecycle.firstModel.disposed = false;
    lifecycle.currentModel = lifecycle.firstModel;
    const view = render(<MonacoEditor value="kind: Pod\n" />);

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    expect(lifecycle.keepCurrentModel).toBe(true);
    expect(lifecycle.events).toEqual(['editor', 'first model']);
  });

  it('disposes the current model after the editor switches paths', async () => {
    lifecycle.events = [];
    lifecycle.modelChangeListener = undefined;
    lifecycle.firstModel.disposed = false;
    lifecycle.secondModel.disposed = false;
    lifecycle.currentModel = lifecycle.firstModel;
    const view = render(<MonacoEditor path="first.yaml" value="kind: Pod\n" />);

    lifecycle.currentModel = lifecycle.secondModel;
    lifecycle.notifyModelChange();
    view.rerender(<MonacoEditor path="second.yaml" value="kind: Service\n" />);
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    expect(lifecycle.firstModel.disposed).toBe(true);
    expect(lifecycle.secondModel.disposed).toBe(true);
    expect(lifecycle.events).toEqual(['editor', 'first model', 'second model']);
  });
});
