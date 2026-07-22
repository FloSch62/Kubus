import { describe, expect, it } from 'vitest';
import {
  CORE_GROUP_SENTINEL,
  columnsForKind,
  GENERIC_CLUSTER_COLUMNS,
  GENERIC_COLUMNS,
  groupFromPath,
  groupToPath,
  gvkForKind,
  gvkForResource,
  KIND_COLUMNS,
  pluralLabel,
} from '@kubus/shared';

describe('pluralLabel', () => {
  it('appends s to regular nouns', () => {
    expect(pluralLabel('Pod')).toBe('Pods');
    expect(pluralLabel('Deployment')).toBe('Deployments');
    expect(pluralLabel('Node')).toBe('Nodes');
  });

  it('turns Policy suffixes into Policies', () => {
    expect(pluralLabel('Policy')).toBe('Policies');
    expect(pluralLabel('NetworkPolicy')).toBe('NetworkPolicies');
    expect(pluralLabel('PodSecurityPolicy')).toBe('PodSecurityPolicies');
  });

  it('turns trailing y into ies', () => {
    expect(pluralLabel('Discovery')).toBe('Discoveries');
    expect(pluralLabel('Registry')).toBe('Registries');
  });

  it('appends s after vowel + y', () => {
    expect(pluralLabel('Gateway')).toBe('Gateways');
    expect(pluralLabel('Journey')).toBe('Journeys');
    expect(pluralLabel('Relay')).toBe('Relays');
  });

  it('appends es to ss endings', () => {
    expect(pluralLabel('Ingress')).toBe('Ingresses');
    expect(pluralLabel('StorageClass')).toBe('StorageClasses');
  });

  it('appends es to x, ch, and sh endings', () => {
    expect(pluralLabel('Sandbox')).toBe('Sandboxes');
    expect(pluralLabel('Switch')).toBe('Switches');
    expect(pluralLabel('Mesh')).toBe('Meshes');
  });

  it('leaves kinds with a single trailing s unchanged', () => {
    expect(pluralLabel('Endpoints')).toBe('Endpoints');
    expect(pluralLabel('Redis')).toBe('Redis');
  });

  it('only capitalizes all-lowercase kinds', () => {
    // Lowercase names are treated as already-plural resource names.
    expect(pluralLabel('widgets')).toBe('Widgets');
  });

  it('passes through an empty string', () => {
    expect(pluralLabel('')).toBe('');
  });
});

describe('gvkForKind', () => {
  it('resolves core kinds', () => {
    expect(gvkForKind('Pod')).toEqual({
      group: '',
      version: 'v1',
      plural: 'pods',
      kind: 'Pod',
      namespaced: true,
    });
  });

  it('resolves grouped kinds', () => {
    expect(gvkForKind('Deployment')).toMatchObject({ group: 'apps', version: 'v1', plural: 'deployments', namespaced: true });
    expect(gvkForKind('CronJob')).toMatchObject({ group: 'batch', plural: 'cronjobs' });
  });

  it('resolves cluster-scoped and extra builtin kinds', () => {
    expect(gvkForKind('Node')).toMatchObject({ group: '', plural: 'nodes', namespaced: false });
    expect(gvkForKind('CustomResourceDefinition')).toMatchObject({
      group: 'apiextensions.k8s.io',
      plural: 'customresourcedefinitions',
      namespaced: false,
    });
  });

  it('is case-sensitive and returns undefined for unknown kinds', () => {
    expect(gvkForKind('pod')).toBeUndefined();
    expect(gvkForKind('Widget')).toBeUndefined();
  });
});

describe('gvkForResource', () => {
  it('resolves the same GVK object as the kind lookup', () => {
    expect(gvkForResource('', 'v1', 'pods')).toBe(gvkForKind('Pod'));
    expect(gvkForResource('apps', 'v1', 'statefulsets')).toBe(gvkForKind('StatefulSet'));
  });

  it('resolves long group names', () => {
    expect(gvkForResource('rbac.authorization.k8s.io', 'v1', 'clusterrolebindings')).toMatchObject({
      kind: 'ClusterRoleBinding',
      namespaced: false,
    });
  });

  it('requires group and version to match exactly', () => {
    expect(gvkForResource('apps', 'v2', 'deployments')).toBeUndefined();
    expect(gvkForResource('', 'v1', 'deployments')).toBeUndefined();
    expect(gvkForResource('example.com', 'v1', 'widgets')).toBeUndefined();
  });
});

describe('columnsForKind', () => {
  it('returns the kind preset regardless of scope flag', () => {
    expect(columnsForKind('Pod', true)).toBe(KIND_COLUMNS.Pod);
    expect(columnsForKind('Pod', false)).toBe(KIND_COLUMNS.Pod);
    expect(columnsForKind('PersistentVolume', false)).toBe(KIND_COLUMNS.PersistentVolume);
  });

  it('returns exact preset columns', () => {
    expect(columnsForKind('Namespace', false)).toEqual(['name', 'cluster', 'nsStatus', 'age']);
  });

  it('falls back to generic columns for unknown kinds', () => {
    expect(columnsForKind('Widget', true)).toBe(GENERIC_COLUMNS);
    expect(columnsForKind('Widget', false)).toBe(GENERIC_CLUSTER_COLUMNS);
    expect(GENERIC_COLUMNS).toEqual(['name', 'namespace', 'cluster', 'age']);
    expect(GENERIC_CLUSTER_COLUMNS).toEqual(['name', 'cluster', 'age']);
  });
});

describe('groupToPath / groupFromPath', () => {
  it('maps the core group to the sentinel and back', () => {
    expect(groupToPath('')).toBe(CORE_GROUP_SENTINEL);
    expect(groupToPath('')).toBe('core');
    expect(groupFromPath('core')).toBe('');
  });

  it('passes non-core groups through unchanged', () => {
    expect(groupToPath('apps')).toBe('apps');
    expect(groupFromPath('networking.k8s.io')).toBe('networking.k8s.io');
  });

  it('round-trips every builtin group', () => {
    for (const group of ['', 'apps', 'batch', 'rbac.authorization.k8s.io', 'apiextensions.k8s.io']) {
      expect(groupFromPath(groupToPath(group))).toBe(group);
    }
  });
});
