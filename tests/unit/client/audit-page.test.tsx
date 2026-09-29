import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditFinding, AuditSeverity } from '@kubus/shared';

vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for('kubus.test.query-harness'), {
    queryConfigs: [],
    mutationConfigs: [],
    multiQueryConfigs: [],
    queryResults: new Map(),
    queryClient: { invalidateQueries: () => Promise.resolve() },
  });
});

const fixtures = vi.hoisted(() => ({ findings: [] as unknown[] }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useAudit: () => ({
    data: [{ ctx: 'kind-a', report: { findings: fixtures.findings, stats: { resourcesScanned: 10, checksRun: 3 }, errors: [], truncated: false } }],
    isLoading: false,
    isFetching: false,
  }),
}));

import { AuditPage } from '../../../client/src/pages/AuditPage';
import { useAuditPrefsStore } from '../../../client/src/state/audit';
import { useClustersStore } from '../../../client/src/state/clusters';

function finding(checkId: string, severity: AuditSeverity, title: string): AuditFinding {
  return {
    checkId,
    severity,
    category: 'pod-security',
    title,
    remediation: 'Fix it.',
    message: 'container "app"',
    resource: { ctx: 'kind-a', group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: 'web', namespace: 'demo' },
  } as AuditFinding;
}

beforeEach(() => {
  useClustersStore.setState({ selected: ['kind-a'] });
  useAuditPrefsStore.setState({ dismissedChecks: [] });
  fixtures.findings = [finding('privileged', 'critical', 'Privileged container'), finding('host-net', 'high', 'Pod uses the host network')];
});

describe('AuditPage', () => {
  it('filters with severity toggles that show their state and counts', () => {
    render(<AuditPage />);
    const high = screen.getByRole('button', { name: /high\s*1/i });
    expect(high).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(high);
    expect(high).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Privileged container')).not.toBeInTheDocument();
    expect(screen.getByText('Pod uses the host network')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All severities' }));
    expect(screen.getByText('Privileged container')).toBeInTheDocument();
  });

  it('labels the ignore action and lists ignored checks for restoring', () => {
    render(<AuditPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Ignore check host-net' }));

    expect(screen.queryByText('Pod uses the host network')).not.toBeInTheDocument();
    expect(screen.getByText('Ignored checks')).toBeInTheDocument();
    expect(screen.getByText('host-net (1)')).toBeInTheDocument();
  });
});
