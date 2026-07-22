import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { load } from 'js-yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchCreateDialog } from '../../../client/src/components/BatchCreateDialog';

type Finding = {
  severity: 'info' | 'warning' | 'error';
  message: string;
  field?: string;
};

const queries = vi.hoisted(() => ({
  namespaces: ['default', 'team-a'],
  createPending: false,
  createMode: 'success' as 'success' | 'error' | 'string',
  createName: 'created-workload',
  createMutate: vi.fn(),
  createMutateAsync: vi.fn(),
  dryRunPending: false,
  dryRunMode: 'success' as 'success' | 'error' | 'string',
  dryRunResult: { ok: true, findings: [] } as { ok: boolean; findings: Finding[] },
  dryRunMutate: vi.fn(),
  dryRunMutateAsync: vi.fn(),
}));

const effects = vi.hoisted(() => ({
  toast: vi.fn(),
  yamlText: '',
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useResourceList: () => ({
    data: { items: queries.namespaces.map((name) => ({ metadata: { name } })) },
  }),
  useCreateResource: () => ({
    isPending: queries.createPending,
    mutate: queries.createMutate,
    mutateAsync: queries.createMutateAsync,
  }),
  useDryRunResource: () => ({
    isPending: queries.dryRunPending,
    mutate: queries.dryRunMutate,
    mutateAsync: queries.dryRunMutateAsync,
  }),
}));

vi.mock('../../../client/src/state/toast.js', () => ({ showToast: effects.toast }));
vi.mock('../../../client/src/cron.js', () => ({
  cronHumanText: (schedule: string) => (schedule === 'bad schedule' ? undefined : `Human: ${schedule}`),
  cronNextRuns: (schedule: string) =>
    schedule === 'bad schedule' ? [] : [new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T01:00:00Z')],
}));
vi.mock('../../../client/src/components/AgeCell.js', () => ({
  formatRelative: (timestamp: string) => `relative ${timestamp}`,
}));
vi.mock('../../../client/src/components/YamlEditor.js', () => ({
  YamlEditor: ({
    value,
    onChange,
    onDryRun,
    onApply,
    schema,
    applyLabel,
  }: {
    value: string;
    onChange: (text: string) => void;
    onDryRun?: (text: string) => Promise<unknown>;
    onApply?: (text: string) => Promise<void>;
    schema: { ctx: string; group: string; version: string; kind: string };
    applyLabel?: string;
  }) => (
    <div>
      <textarea
        aria-label="Batch YAML"
        defaultValue={value}
        onChange={(event) => {
          effects.yamlText = event.target.value;
          onChange(event.target.value);
        }}
      />
      <div data-testid="yaml-schema">{`${schema.ctx}/${schema.group}/${schema.version}/${schema.kind}`}</div>
      <button onClick={() => void onDryRun?.(effects.yamlText || value)}>YAML dry run</button>
      <button onClick={() => void onApply?.(effects.yamlText || value)}>{applyLabel ?? 'Apply'}</button>
    </div>
  ),
}));

beforeEach(() => {
  queries.namespaces = ['default', 'team-a'];
  queries.createPending = false;
  queries.createMode = 'success';
  queries.createName = 'created-workload';
  queries.createMutate.mockReset();
  queries.createMutate.mockImplementation(
    (_vars: unknown, options: { onSuccess: (value: { metadata: { name: string } }) => void; onError: (error: unknown) => void }) => {
      if (queries.createMode === 'error') options.onError(new Error('create denied'));
      else if (queries.createMode === 'string') options.onError('create rejected');
      else options.onSuccess({ metadata: { name: queries.createName } });
    },
  );
  queries.createMutateAsync.mockReset();
  queries.createMutateAsync.mockImplementation(async () => {
    if (queries.createMode === 'error') throw new Error('create denied');
    if (queries.createMode === 'string') throw 'create rejected';
    return { metadata: { name: queries.createName } };
  });
  queries.dryRunPending = false;
  queries.dryRunMode = 'success';
  queries.dryRunResult = { ok: true, findings: [] };
  queries.dryRunMutate.mockReset();
  queries.dryRunMutate.mockImplementation(
    (_vars: unknown, options: { onSuccess: (value: typeof queries.dryRunResult) => void; onError: (error: unknown) => void }) => {
      if (queries.dryRunMode === 'error') options.onError(new Error('validation denied'));
      else if (queries.dryRunMode === 'string') options.onError('validation rejected');
      else options.onSuccess(queries.dryRunResult);
    },
  );
  queries.dryRunMutateAsync.mockReset();
  queries.dryRunMutateAsync.mockImplementation(async () => queries.dryRunResult);
  effects.toast.mockClear();
  effects.yamlText = '';
});

function renderDialog(kind: 'Job' | 'CronJob', onClose = vi.fn(), defaultNamespace?: string) {
  return {
    onClose,
    ...render(
      <BatchCreateDialog
        ctx="dev"
        kind={kind}
        group="batch"
        version="v1"
        defaultNamespace={defaultNamespace}
        onClose={onClose}
      />,
    ),
  };
}

function fillRequired(name = 'nightly-task', image = 'busybox:1.36') {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Image'), { target: { value: image } });
}

function latestYaml(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mock.mock.calls.at(-1) as [{ ctx: string; yamlBody: string }, unknown?];
  return load(call[0].yamlBody) as Record<string, unknown>;
}

describe('BatchCreateDialog', () => {
  it('builds a Job, validates it, and reports dry-run and create outcomes', () => {
    const { onClose } = renderDialog('Job', undefined, 'team-a');
    const createButton = screen.getByRole('button', { name: 'Create' });
    const dryRunButton = screen.getByRole('button', { name: 'Dry run' });

    expect(screen.getByLabelText('Namespace')).toHaveValue('team-a');
    expect(createButton).toBeDisabled();
    expect(dryRunButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad_Name' } });
    expect(screen.getByText('Lowercase DNS name, at most 63 characters')).toBeInTheDocument();
    fillRequired();
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Command (optional)'), { target: { value: 'echo ready' } });

    fireEvent.mouseDown(screen.getByLabelText('Restart policy'));
    fireEvent.click(screen.getByRole('option', { name: 'OnFailure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.change(screen.getByLabelText('Completions'), { target: { value: '-2' } });
    expect(screen.getByLabelText('Completions')).toHaveValue(0);
    fireEvent.change(screen.getByLabelText('Completions'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Parallelism'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Active deadline (s)'), { target: { value: '120' } });

    fireEvent.click(dryRunButton);
    expect(screen.getByText('Server dry-run accepted this Job.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validated' })).toBeInTheDocument();
    expect(latestYaml(queries.dryRunMutate)).toMatchObject({
      metadata: { name: 'nightly-task', namespace: 'other' },
      spec: {
        parallelism: 2,
        activeDeadlineSeconds: 120,
        template: {
          spec: {
            restartPolicy: 'OnFailure',
            containers: [{ image: 'busybox:1.36', command: ['sh', '-c', 'echo ready'] }],
          },
        },
      },
    });
    expect((latestYaml(queries.dryRunMutate).spec as Record<string, unknown>).completions).toBeUndefined();

    queries.dryRunResult = {
      ok: false,
      findings: [
        { severity: 'error', field: 'spec.template', message: 'template rejected' },
        { severity: 'warning', message: 'image uses latest tag' },
        { severity: 'info', message: 'policy defaulted' },
      ],
    };
    fireEvent.change(screen.getByLabelText('Command (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(screen.getByText('spec.template: template rejected')).toBeInTheDocument();
    expect(screen.getByText('image uses latest tag')).toBeInTheDocument();
    expect(screen.getByText('policy defaulted')).toBeInTheDocument();

    queries.dryRunMode = 'error';
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'alpine:3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(screen.getByText('validation denied')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alert')).getByTitle('Close'));

    queries.createMode = 'string';
    fireEvent.click(createButton);
    expect(screen.getByText('create rejected')).toBeInTheDocument();
    queries.createMode = 'success';
    queries.createName = 'nightly-task';
    fireEvent.change(screen.getByLabelText('Parallelism'), { target: { value: '3' } });
    fireEvent.click(createButton);
    expect(effects.toast).toHaveBeenCalledWith('success', 'Created Job nightly-task');
    expect(onClose).toHaveBeenCalledOnce();
  }, 15_000);

  it('handles CronJob scheduling, advanced options, and pending mutations', () => {
    const view = renderDialog('CronJob');
    expect(screen.getByLabelText('Namespace')).toHaveValue('default');
    expect(screen.getByText('Human: 0 * * * * (UTC)')).toBeInTheDocument();
    expect(screen.getByText(/Next runs: relative 2030-01-01T00:00:00.000Z/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'a'.repeat(53) } });
    expect(screen.getByText('Lowercase DNS name, at most 52 characters')).toBeInTheDocument();
    fillRequired('hourly-report', 'registry.example/report:v2');
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'bad schedule' } });
    expect(screen.getByText('Unrecognized cron expression')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.click(screen.getByText('Hourly'));
    expect(screen.getByLabelText('Schedule')).toHaveValue('0 * * * *');
    fireEvent.change(screen.getByLabelText('Time zone (optional)'), { target: { value: 'Europe/Berlin' } });
    expect(screen.getByText('Human: 0 * * * * (Europe/Berlin)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.mouseDown(screen.getByLabelText('Concurrency'));
    fireEvent.click(screen.getByRole('option', { name: 'Replace' }));
    fireEvent.change(screen.getByLabelText('Keep successful Jobs'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Keep failed Jobs'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Starting deadline (s)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Start suspended' }));

    queries.dryRunPending = true;
    queries.createPending = true;
    view.rerender(
      <BatchCreateDialog ctx="dev" kind="CronJob" group="batch" version="v1" onClose={view.onClose} />,
    );
    expect(screen.getByRole('button', { name: 'Validating…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();

    queries.dryRunPending = false;
    queries.createPending = false;
    view.rerender(
      <BatchCreateDialog ctx="dev" kind="CronJob" group="batch" version="v1" onClose={view.onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(latestYaml(queries.createMutate)).toMatchObject({
      kind: 'CronJob',
      metadata: { name: 'hourly-report', namespace: 'default' },
      spec: {
        schedule: '0 * * * *',
        timeZone: 'Europe/Berlin',
        concurrencyPolicy: 'Replace',
        successfulJobsHistoryLimit: 5,
        failedJobsHistoryLimit: 2,
        startingDeadlineSeconds: 60,
        suspend: true,
        jobTemplate: { spec: { template: { spec: { containers: [{ image: 'registry.example/report:v2' }] } } } },
      },
    });
    expect(effects.toast).toHaveBeenCalledWith('success', 'Created CronJob created-workload');
  }, 15_000);

  it('blocks malformed YAML, round-trips valid edits, and creates from YAML mode', async () => {
    const { onClose } = renderDialog('Job');
    fillRequired('form-job', 'busybox');
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));

    expect(screen.getByTestId('yaml-schema')).toHaveTextContent('dev/batch/v1/Job');
    const editor = screen.getByLabelText('Batch YAML');
    expect((editor as HTMLTextAreaElement).value).toContain('name: form-job');

    fireEvent.change(editor, { target: { value: '[' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByText(/Fix the YAML before returning to the form:/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alert')).getByTitle('Close'));

    fireEvent.change(editor, { target: { value: '- list item' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByText(/not a YAML mapping/)).toBeInTheDocument();

    const genericCommandYaml = `apiVersion: batch/v1
kind: Job
metadata:
  name: yaml-job
  namespace: team-a
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: main
          image: alpine:3
          command: [echo, hello]
`;
    fireEvent.change(editor, { target: { value: genericCommandYaml } });
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByLabelText('Name')).toHaveValue('yaml-job');
    expect(screen.getByLabelText('Command (optional)')).toHaveValue('echo hello');

    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    const shellCommandYaml = genericCommandYaml.replace('command: [echo, hello]', "command: [sh, -c, 'echo shell']");
    fireEvent.change(screen.getByLabelText('Batch YAML'), { target: { value: shellCommandYaml } });
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByLabelText('Command (optional)')).toHaveValue('echo shell');

    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    fireEvent.click(screen.getByRole('button', { name: 'YAML dry run' }));
    await waitFor(() => expect(queries.dryRunMutateAsync).toHaveBeenCalledWith({ ctx: 'dev', yamlBody: expect.any(String) }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(queries.createMutateAsync).toHaveBeenCalledWith({ ctx: 'dev', yamlBody: expect.any(String) }));
    await waitFor(() => expect(effects.toast).toHaveBeenCalledWith('success', 'Created Job created-workload'));
    expect(onClose).toHaveBeenCalledOnce();
  }, 15_000);
});
