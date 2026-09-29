import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import YamlEditorImpl from '../../../client/src/components/YamlEditorImpl';

vi.mock('../../../client/src/monaco-setup.js', () => ({ newYamlModelPath: () => 'kubus-test.yaml', registerYamlSchema: vi.fn() }));
vi.mock('../../../client/src/api/queries.js', () => ({ useResourceSchema: () => ({ data: undefined }) }));

const editor = () => screen.getByLabelText(/YAML editor/);
const chord = (target: Element, key: string) => fireEvent.keyDown(target, { key, ctrlKey: true });

describe('YamlEditor keyboard chords', () => {
  it('reviews edits with Mod+S in place of Dry run and Apply', () => {
    const onReview = vi.fn();
    render(<YamlEditorImpl value={'a: 1\n'} readOnly={false} onReview={onReview} notice={<p>Server moved</p>} />);
    expect(screen.getByText('Server moved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dry run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    const review = screen.getByRole('button', { name: 'Review & apply' });
    expect(review).toBeDisabled();

    // Nothing to review yet: the chord is swallowed (no browser save dialog) but does nothing.
    const early = chord(screen.getByRole('button', { name: 'Copy' }), 's');
    expect(early).toBe(false);
    expect(onReview).not.toHaveBeenCalled();

    fireEvent.change(editor(), { target: { value: 'a: 2\n' } });
    expect(review).toBeEnabled();
    chord(screen.getByRole('button', { name: 'Copy' }), 's');
    expect(onReview).toHaveBeenCalledWith('a: 2\n');
    fireEvent.click(review);
    expect(onReview).toHaveBeenCalledTimes(2);
  });

  it('creates with Mod+Enter, running the required dry-run first and stopping on findings', async () => {
    const onApply = vi.fn(async () => undefined);
    const onDryRun = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, findings: [{ severity: 'warning', message: 'no limits set' }] })
      .mockResolvedValue({ ok: true, findings: [] });
    render(<YamlEditorImpl value={'kind: Job\n'} applyLabel="Create" applyUnchanged onApply={onApply} onDryRun={onDryRun} />);

    // An untouched generated manifest goes straight through.
    chord(editor(), 'Enter');
    await waitFor(() => expect(onApply).toHaveBeenCalledWith('kind: Job\n'));
    expect(onDryRun).not.toHaveBeenCalled();

    // Edits need a dry-run; findings stop the first chord so they get read.
    fireEvent.change(editor(), { target: { value: 'kind: Job\nspec: {}\n' } });
    chord(editor(), 'Enter');
    await waitFor(() => expect(screen.getByText('no limits set')).toBeInTheDocument());
    expect(onApply).toHaveBeenCalledOnce();
    chord(editor(), 'Enter');
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
    expect(onApply).toHaveBeenLastCalledWith('kind: Job\nspec: {}\n');
    expect(onDryRun).toHaveBeenCalledOnce();

    // A clean dry-run applies in one go.
    fireEvent.change(editor(), { target: { value: 'kind: Job\nspec: { parallelism: 1 }\n' } });
    chord(editor(), 'Enter');
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(3));
    expect(onDryRun).toHaveBeenCalledTimes(2);
  });

  it('leaves the chords alone in a read-only viewer', () => {
    render(<YamlEditorImpl value={'a: 1\n'} />);
    expect(chord(editor(), 's')).toBe(true);
    expect(chord(editor(), 'Enter')).toBe(true);
  });
});
