import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  approxRunTime,
  commandSummary,
  configFailureCause,
  diagnoseContainer,
  diagnosePod,
  diagnoseScheduling,
  parseGoDuration,
  pullFailureCause,
  spokenDuration,
  startFailureCause,
} from '../../../client/src/components/detail/pod-diagnosis';

const crashLoop = (last: Record<string, unknown>, restartCount = 70, message = 'back-off 5m0s restarting failed container=crash pod=crashloop_chaos(uid)') => ({
  name: 'crash',
  restartCount,
  state: { waiting: { reason: 'CrashLoopBackOff', message } },
  lastState: { terminated: last },
});

describe('pod diagnosis wording helpers', () => {
  it('reads Go durations and says them as words', () => {
    expect(parseGoDuration('5m0s')).toBe(300);
    expect(parseGoDuration('40s')).toBe(40);
    expect(parseGoDuration('1h2m3s')).toBe(3723);
    expect(parseGoDuration('soon')).toBeUndefined();
    expect(spokenDuration(300)).toBe('5 minutes');
    expect(spokenDuration(1)).toBe('1 second');
    expect(spokenDuration(150)).toBe('2 minutes 30 seconds');
    expect(spokenDuration(7200)).toBe('2 hours');
  });

  it('rounds run times for a sentence', () => {
    expect(approxRunTime('2026-07-22T10:00:00Z', '2026-07-22T10:00:05Z')?.text).toBe('about 5 s');
    expect(approxRunTime('2026-07-22T10:00:00Z', '2026-07-22T10:00:00.2Z')?.text).toBe('less than a second');
    expect(approxRunTime('2026-07-22T10:00:00Z', '2026-07-22T10:03:00Z')?.text).toBe('about 3 min');
    expect(approxRunTime(undefined, '2026-07-22T10:00:00Z')).toBeUndefined();
  });

  it('names why an image cannot be pulled', () => {
    expect(pullFailureCause('dial tcp: lookup registry.invalid on 172.19.0.1:53: no such host')).toBe('registry host not found');
    expect(pullFailureCause('failed to resolve reference "docker.io/library/nginx:nope": docker.io/library/nginx:nope: not found')).toBe('image or tag not found');
    expect(pullFailureCause('pull access denied, repository does not exist or may require authorization')).toBe('access denied (missing or wrong pull credentials)');
    expect(pullFailureCause('x509: certificate signed by unknown authority')).toBe('the registry’s TLS certificate is not trusted');
    expect(pullFailureCause('toomanyrequests: You have reached your pull rate limit')).toBe('the registry’s pull rate limit was hit');
    expect(pullFailureCause('dial tcp 10.0.0.1:443: i/o timeout')).toBe('the registry did not respond');
    expect(pullFailureCause(undefined, 'InvalidImageName')).toBe('the image name is not valid');
    expect(pullFailureCause('Back-off pulling image "app:1"')).toBeUndefined();
  });

  it('names the missing configuration and the unstartable command', () => {
    expect(configFailureCause('configmap "app-config" not found')).toBe('ConfigMap app-config does not exist');
    expect(configFailureCause('secret "db-creds" not found')).toBe('Secret db-creds does not exist');
    expect(configFailureCause("couldn't find key PASSWORD in Secret team-a/db-creds")).toBe('key PASSWORD is missing from Secret db-creds');
    expect(startFailureCause('failed to create containerd task: exec: "app": executable file not found in $PATH')).toBe('command app is not in the image');
  });

  it('quotes command lines readably', () => {
    expect(commandSummary(['sh', '-c'], ['echo "I crash in 5s"; sleep 5; exit 1'])).toBe(`sh -c 'echo "I crash in 5s"; sleep 5; exit 1'`);
    expect(commandSummary(['/bin/app'], ['--serve'])).toBe('/bin/app --serve');
    expect(commandSummary(undefined, undefined)).toBeUndefined();
    expect(commandSummary(['x'.repeat(100)], undefined, 20)).toHaveLength(20);
  });
});

describe('diagnoseContainer', () => {
  it('explains a crash loop from the last run: exit code, run time, restarts and back-off', () => {
    const d = diagnoseContainer(crashLoop({ reason: 'Error', exitCode: 1, startedAt: '2026-07-22T10:00:00Z', finishedAt: '2026-07-22T10:00:05Z' }));
    expect(d).toMatchObject({
      kind: 'crashloop',
      headline: 'Container crash exits with code 1 about 5 s after starting',
      detail: 'It has restarted 70 times. Kubernetes now waits up to 5 minutes between attempts (CrashLoopBackOff).',
      logs: 'previous',
      exitCode: 1,
      severity: 'error',
    });
    expect(d?.raw).toContain('back-off 5m0s');
  });

  it('calls out out-of-memory kills, signals and clean exits', () => {
    expect(diagnoseContainer(crashLoop({ reason: 'OOMKilled', exitCode: 137, startedAt: '2026-07-22T10:00:00Z', finishedAt: '2026-07-22T10:00:30Z' }))).toMatchObject({
      headline: 'Container crash runs out of memory and is killed about 30 s after starting',
      detail: expect.stringContaining('more memory than its limit allows'),
    });
    expect(diagnoseContainer(crashLoop({ reason: 'Error', exitCode: 137 }))?.headline).toBe('Container crash is killed (exit 137, SIGKILL)');
    expect(diagnoseContainer(crashLoop({ reason: 'Completed', exitCode: 0 }, 1))).toMatchObject({
      headline: 'Container crash stops with exit code 0 and is restarted',
      detail: expect.stringContaining('It has restarted once.'),
    });
    expect(diagnoseContainer({ name: 'crash', state: { waiting: { reason: 'CrashLoopBackOff' } } })?.headline).toBe('Container crash keeps crashing');
  });

  it('explains image pulls, using an event message when the waiting message has no cause', () => {
    const waiting = { name: 'web', state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "registry.invalid/web:1"' } } };
    expect(diagnoseContainer(waiting)).toMatchObject({ kind: 'image', headline: 'Image registry.invalid/web:1 cannot be pulled' });
    expect(diagnoseContainer(waiting, { hint: 'Failed to pull image "registry.invalid/web:1": lookup registry.invalid: no such host' })).toMatchObject({
      headline: 'Image registry.invalid/web:1 cannot be pulled: registry host not found',
      detail: 'Container web cannot start. Kubernetes keeps retrying the pull with a growing delay (ImagePullBackOff).',
    });
  });

  it('explains configuration and start failures', () => {
    expect(diagnoseContainer({ name: 'api', state: { waiting: { reason: 'CreateContainerConfigError', message: 'configmap "api-config" not found' } } })).toMatchObject({
      kind: 'config',
      headline: 'Container api cannot start: ConfigMap api-config does not exist',
    });
    expect(diagnoseContainer({ name: 'api', state: { waiting: { reason: 'RunContainerError', message: 'exec: "server": executable file not found in $PATH' } } })).toMatchObject({
      kind: 'start',
      headline: 'Container api could not be started: command server is not in the image',
    });
  });

  it('explains a stopped container in the past tense and reads its current logs', () => {
    const d = diagnoseContainer(
      { name: 'migrate', state: { terminated: { reason: 'Error', exitCode: 1, startedAt: '2026-07-22T10:00:00Z', finishedAt: '2026-07-22T10:00:00.1Z' } } },
      { restartPolicy: 'Never' },
    );
    expect(d).toMatchObject({
      kind: 'exited',
      headline: 'Container migrate exited with code 1 right after starting',
      detail: 'The pod’s restart policy is Never, so it stays stopped.',
      logs: 'current',
    });
  });

  it('reads a restarting container caught between attempts as the same crash loop', () => {
    const d = diagnoseContainer(
      { name: 'crash', restartCount: 85, state: { terminated: { reason: 'Error', exitCode: 1, startedAt: '2026-07-22T10:00:00Z', finishedAt: '2026-07-22T10:00:05Z' } } },
      { restartPolicy: 'Always' },
    );
    expect(d).toMatchObject({
      kind: 'crashloop',
      headline: 'Container crash exits with code 1 about 5 s after starting',
      detail: 'It has restarted 85 times. Kubernetes restarts it after a growing delay (CrashLoopBackOff).',
      logs: 'current',
    });
  });

  it('leaves healthy and in-progress states alone', () => {
    expect(diagnoseContainer({ name: 'a', state: { running: {} } })).toBeUndefined();
    expect(diagnoseContainer({ name: 'a', state: { waiting: { reason: 'ContainerCreating' } } })).toBeUndefined();
    expect(diagnoseContainer({ name: 'a', state: { terminated: { reason: 'Completed', exitCode: 0 } } })).toBeUndefined();
  });
});

describe('diagnoseScheduling and diagnosePod', () => {
  const pending = (message: string, cpu = '64'): KubeObject =>
    ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'big', uid: 'u' },
      spec: { containers: [{ name: 'app', resources: { requests: { cpu } } }] },
      status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message }] },
    }) as KubeObject;

  it('says why no node takes the pod and what it asks for', () => {
    const d = diagnoseScheduling(pending('0/1 nodes are available: 1 Insufficient cpu. preemption: 0/1 nodes are available: 1 Preemption is not helpful for scheduling.'));
    expect(d).toMatchObject({
      kind: 'unschedulable',
      headline: 'No node can run this pod: Insufficient cpu',
      detail: '0 of 1 node can take it. The pod requests 64.00 cores of CPU.',
      rawLabel: 'Scheduler message',
      severity: 'warning',
    });
  });

  it('skips gated and scheduled pods', () => {
    const gated = pending('waiting');
    (gated.status as { conditions: Array<{ reason: string }> }).conditions[0]!.reason = 'SchedulingGated';
    expect(diagnoseScheduling(gated)).toBeUndefined();
    expect(diagnoseScheduling({ ...pending('x'), status: { phase: 'Running' } } as KubeObject)).toBeUndefined();
  });

  it('diagnoses init containers first and passes the pull hint per container', () => {
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'p', uid: 'u' },
      spec: { containers: [{ name: 'app', image: 'app:1' }], initContainers: [{ name: 'init', image: 'init:1' }] },
      status: {
        phase: 'Pending',
        initContainerStatuses: [{ name: 'init', state: { terminated: { reason: 'Error', exitCode: 3 } } }],
        containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ErrImagePull', message: 'rpc error: manifest unknown' } } }],
      },
    } as unknown as KubeObject;
    const diagnoses = diagnosePod(pod);
    expect(diagnoses.map((d) => [d.container, d.init, d.kind])).toEqual([
      ['init', true, 'exited'],
      ['app', false, 'image'],
    ]);
    expect(diagnoses[1]!.headline).toBe('Image app:1 cannot be pulled: image or tag not found');
    expect(diagnosePod({ ...pod, status: { phase: 'Succeeded' } } as KubeObject)).toEqual([]);
  });
});
