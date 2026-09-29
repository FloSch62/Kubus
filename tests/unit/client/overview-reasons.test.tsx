import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OverviewKindHealth, OverviewWorkloadIssue } from '@kubus/shared';
import { WorkloadHealthSection } from '../../../client/src/components/overview/WorkloadHealthSection';
import { describeCause, describeIssue, failingPodBreakdown, pullFailure, quotaRefusal } from '../../../client/src/components/overview/issue-cause';
import { useClustersStore } from '../../../client/src/state/clusters';

describe('overview reasons', () => {
  it('turns pull errors into the part a person acts on', () => {
    expect(pullFailure('dial tcp: lookup registry.invalid on 172.19.0.1:53: no such host')).toBe('registry host not found');
    expect(pullFailure('rpc error: manifest unknown')).toBe('image not found');
    expect(pullFailure('pull access denied, repository does not exist or may require authorization')).toBe('access denied');
    expect(describeCause({ reason: 'ImagePullBackOff', image: 'nope:1', message: 'no such host' })).toEqual({
      status: 'ImagePullBackOff',
      detail: 'nope:1: registry host not found',
      full: 'no such host',
    });
  });

  it('reads quota refusals', () => {
    const message =
      'pods "gpu-worker-0" is forbidden: exceeded quota: gpu-quota, requested: requests.nvidia.com/gpu=1, used: requests.nvidia.com/gpu=0, limited: requests.nvidia.com/gpu=0';
    expect(quotaRefusal(message)).toBe('quota gpu-quota caps requests.nvidia.com/gpu at 0, the pod asks for 1');
    expect(describeCause({ reason: 'FailedCreate', message }).detail).toBe('quota gpu-quota caps requests.nvidia.com/gpu at 0, the pod asks for 1');
  });

  it('names crash loops, scheduling refusals and missing storage classes', () => {
    expect(describeCause({ reason: 'CrashLoopBackOff', source: { kind: 'Pod', name: 'flaky-1' }, restarts: 56, exitCode: 1, pods: 1 }).detail).toBe(
      'flaky-1 exits with code 1, 56 restarts',
    );
    expect(describeCause({ reason: 'CrashLoopBackOff', pods: 3, exitCode: 2 }).detail).toBe('3 pods exit with code 2');
    expect(describeCause({ reason: 'Unschedulable', message: '0/3 nodes are available: 3 Insufficient cpu. preemption: 0/3 nodes are available.' })).toMatchObject({
      status: 'Pending',
      detail: '0/3 nodes available, Insufficient cpu',
    });
    expect(describeCause({ reason: 'ProvisioningFailed', message: 'storageclass.storage.k8s.io "fast" not found' }).detail).toBe('StorageClass fast does not exist');
  });

  it("keeps a Job's own reason as the headline and adds its pod's exit", () => {
    const job: OverviewWorkloadIssue = {
      kind: 'Job',
      namespace: 'ns',
      name: 'migrate',
      reason: 'BackoffLimitExceeded',
      message: 'Job has reached the specified backoff limit',
      cause: { reason: 'Error', exitCode: 1, source: { kind: 'Pod', name: 'migrate-x' } },
    };
    expect(describeIssue(job)).toMatchObject({ status: 'BackoffLimitExceeded', detail: 'migrate-x exited with code 1' });
    expect(describeIssue({ kind: 'ResourceQuota', namespace: 'ns', name: 'q', reason: 'AtQuota', message: 'pods 3/3' })).toMatchObject({ status: 'AtQuota', detail: 'pods 3/3' });
  });

  it('groups failing pods by reason family', () => {
    expect(failingPodBreakdown(['ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff', 'Pending', 'CrashLoopBackOff', 'ImagePullBackOff'])).toBe(
      '3 ImagePull · 2 CrashLoop · 1 Pending',
    );
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

const health: OverviewKindHealth[] = [
  { kind: 'Deployment', group: 'apps', version: 'v1', plural: 'deployments', total: 18, unhealthy: 1 },
  { kind: 'StatefulSet', group: 'apps', version: 'v1', plural: 'statefulsets', total: 4, unhealthy: 1 },
  { kind: 'PodDisruptionBudget', group: 'policy', version: 'v1', plural: 'poddisruptionbudgets', total: 0, unhealthy: 0 },
];

describe('WorkloadHealthSection', () => {
  beforeEach(() => useClustersStore.setState({ selected: ['dev'] }));

  it('shows each unhealthy workload with its reason, and nothing when all are healthy', () => {
    const issues: OverviewWorkloadIssue[] = [
      {
        kind: 'Deployment',
        namespace: 'chaos',
        name: 'broken',
        ready: 0,
        desired: 2,
        reason: 'Unavailable',
        cause: { reason: 'ImagePullBackOff', image: 'registry.invalid/broken:latest', message: 'no such host', pods: 2 },
      },
      { kind: 'StatefulSet', namespace: 'gap', name: 'gpu', ready: 0, desired: 1, reason: 'Unavailable', cause: { reason: 'FailedCreate', message: 'exceeded quota: q' } },
    ];
    render(
      <MemoryRouter>
        <WorkloadHealthSection ctx="dev" health={health} issues={issues} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Unhealthy workloads' })).toBeInTheDocument();
    expect(screen.getByText('registry.invalid/broken:latest: registry host not found', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('quota q exceeded', { exact: false })).toBeInTheDocument();
    // Kinds with nothing wrong stay out of the header summary.
    expect(screen.queryByText(/PodDisruptionBudgets/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Deployments 1/18' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/r/apps/v1/deployments?q=${encodeURIComponent('/status:unhealthy')}`);
    fireEvent.click(screen.getByRole('link', { name: 'broken' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/r/apps/v1/deployments?sel=dev%7Cchaos%7Cbroken');
  });

  it('renders nothing without issues', () => {
    const { container } = render(
      <MemoryRouter>
        <WorkloadHealthSection ctx="dev" health={health} issues={[]} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
