import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MonacoEditor } from '../../../client/src/components/MonacoEditor.js';

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  keepCurrentModel: false,
  model: {
    disposed: false,
    isDisposed() {
      return this.disposed;
    },
    dispose() {
      this.disposed = true;
      lifecycle.events.push('model');
    },
  },
}));

vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor({
    keepCurrentModel,
    onMount,
  }: {
    keepCurrentModel?: boolean;
    onMount?: (editor: { getModel: () => typeof lifecycle.model }, monaco: object) => void;
  }) {
    useEffect(() => {
      lifecycle.keepCurrentModel = !!keepCurrentModel;
      onMount?.({ getModel: () => lifecycle.model }, {});
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
    lifecycle.model.disposed = false;
    const view = render(<MonacoEditor value="kind: Pod\n" />);

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    expect(lifecycle.keepCurrentModel).toBe(true);
    expect(lifecycle.events).toEqual(['editor', 'model']);
  });
});
