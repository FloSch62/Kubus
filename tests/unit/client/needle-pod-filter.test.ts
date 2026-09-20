import { describe, expect, it } from 'vitest';
import { readPodFilterSuggestion } from '../../../client/src/needle/pod-filter';
import { matchesSmartFilter, parseSmartFilter } from '../../../client/src/smart-filter';

const response = (args: Record<string, unknown>) => ({
  success: true, confidence: 0.9, function_calls: [{ name: 'filter_pods', arguments: args }], suppressed_calls: [],
});

describe('Needle pod filter boundary', () => {
  it('ignores uncalibrated fine-tuned scores while preserving argument validation', () => {
    const reply = { ...response({ status: 'crash' }), confidence: null };
    expect(readPodFilterSuggestion(reply, 'Show crashing pods', false)).toMatchObject({ filter: '/status:crash', confidence: null });
    expect(() => readPodFilterSuggestion(reply, 'Show crashing pods')).toThrow();
    expect(() => readPodFilterSuggestion(response({ namespace: 'invented' }), 'Show crashing pods', false)).toThrow();
  });
  it('uses existing smart-filter semantics for a combined namespace and health request', () => {
    const result = readPodFilterSuggestion(response({ namespace: 'production', status: 'unhealthy' }), 'Show unhealthy pods in production');
    expect(result.filter).toBe('/ns:production status:unhealthy');
    const clauses = parseSmartFilter(result.filter.slice(1));
    const obj = {
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'api', namespace: 'production', uid: 'pod1' },
      spec: { containers: [{ name: 'api' }] },
      status: { phase: 'Pending' },
    };
    const context = { kind: 'Pod', nowMs: Date.now() };
    expect(matchesSmartFilter({ ctx: 'local', obj }, clauses, context)).toBe(true);
    expect(matchesSmartFilter({ ctx: 'local', obj: { ...obj, metadata: { ...obj.metadata, namespace: 'staging' } } }, clauses, context)).toBe(false);
  });

  it.each([
    { namespace: 'prod status:healthy' }, { namespace: 'prod,staging' }, { namespace: '!prod' },
    { namespace: 'prod"' }, { namespace: 'not-in-prompt' }, { namespace: '' },
    { status: 'deleted' }, { status: '__proto__' }, { status: 1 }, { restarts: 3 }, {},
  ])('rejects unsupported or ungrounded arguments: %j', (args) => {
    expect(() => readPodFilterSuggestion(response(args), 'Show pods in prod')).toThrow();
  });

  it('rejects a high-confidence namespace invented from the resource noun', () => {
    expect(() => readPodFilterSuggestion(response({ namespace: 'pods', status: 'unhealthy' }), 'Show unhealthy pods')).toThrow();
    expect(readPodFilterSuggestion(response({ namespace: 'pods' }), 'Show pods in namespace pods').filter).toBe('/ns:pods');
  });

  it.each([
    { success: false }, { confidence: NaN }, { confidence: 0.2 }, { confidence: null },
    { function_calls: [] }, { function_calls: [{ name: 'delete_pods', arguments: {} }] },
    { suppressed_calls: [{ name: 'filter_pods', arguments: { status: 'running' } }] },
    { validation: { negation: true } }, { validation: { ungrounded: ['filter_pods.namespace'] } },
  ])('refuses failures, low confidence, suppressed calls and unsupported actions: %j', (patch) => {
    expect(() => readPodFilterSuggestion({ ...response({ status: 'crash' }), ...patch }, 'Show crashing pods')).toThrow();
  });
});
