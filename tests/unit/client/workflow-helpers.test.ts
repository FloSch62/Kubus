import { load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  LOCAL_ERROR_HANDLING_META,
  isMutationErrorHandledLocally,
} from '../../../client/src/api/mutation-errors.js';
import { normalizePemInput } from '../../../client/src/components/settings/pem.js';
import { manualJobYaml } from '../../../client/src/manual-job.js';

interface ParsedJob {
  metadata: {
    name: string;
    namespace?: string;
    ownerReferences?: unknown;
    [key: string]: unknown;
  };
  spec?: unknown;
  [key: string]: unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mutation error metadata', () => {
  it('marks only explicitly local error handling', () => {
    expect(isMutationErrorHandledLocally(LOCAL_ERROR_HANDLING_META)).toBe(true);
    expect(isMutationErrorHandledLocally(undefined)).toBe(false);
    expect(isMutationErrorHandledLocally({ errorHandledLocally: false })).toBe(false);
    expect(isMutationErrorHandledLocally({ anotherFlag: true })).toBe(false);
  });
});

describe('normalizePemInput', () => {
  const pem = '-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----';

  it('trims PEM input without changing its content', () => {
    expect(normalizePemInput(`  ${pem}\n`)).toBe(pem);
  });

  it('decodes copied base64 certificate data, including whitespace', () => {
    const encoded = btoa(pem);
    const wrapped = `${encoded.slice(0, 20)}\n${encoded.slice(20)}`;
    expect(normalizePemInput(wrapped)).toBe(pem);
  });

  it('leaves empty, invalid, and non-PEM base64 text alone', () => {
    expect(normalizePemInput('  ')).toBe('');
    expect(normalizePemInput('not base64!!')).toBe('not base64!!');
    expect(normalizePemInput(btoa('ordinary text'))).toBe(btoa('ordinary text'));
  });
});

describe('manualJobYaml', () => {
  it('builds a deterministic Job from the CronJob template', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const cronJob = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'nightly', namespace: 'jobs', uid: 'cron-uid' },
      spec: {
        jobTemplate: {
          metadata: {
            labels: { app: 'worker' },
            annotations: { 'example.test/source': 'schedule' },
          },
          spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'worker', image: 'busybox' }] } } },
        },
      },
    } satisfies KubeObject;

    const job = load(manualJobYaml(cronJob)) as ParsedJob;

    expect(job).toMatchObject({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'nightly-manual-1700000000',
        namespace: 'jobs',
        labels: { app: 'worker' },
        annotations: {
          'example.test/source': 'schedule',
          'cronjob.kubernetes.io/instantiate': 'manual',
        },
        ownerReferences: [
          {
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            name: 'nightly',
            uid: 'cron-uid',
            controller: false,
          },
        ],
      },
      spec: cronJob.spec.jobTemplate.spec,
    });
  });

  it('caps the generated name and omits absent optional fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const cronJob = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'a'.repeat(70), uid: '' },
      spec: {},
    } satisfies KubeObject;

    const job = load(manualJobYaml(cronJob)) as ParsedJob;

    expect(job.metadata.name).toHaveLength(63);
    expect(job.metadata.ownerReferences).toBeUndefined();
    expect(job.metadata.namespace).toBeUndefined();
    expect(job.spec).toBeUndefined();
  });
});
