import { groupFromPath, groupToPath, type KubeObject } from '@kubus/shared';
import { normalizeForDiff } from './kube-display.js';

/**
 * The Diff page's state, kept in its URL so a compare can be reopened,
 * shared and restored with its tab. Each side is one `ctx|group/version/plural|namespace|name`
 * parameter (core group as `core`, like list paths); options only appear
 * when they differ from the defaults.
 */

export interface DiffSide {
  ctx?: string;
  /** API group, '' for core. Set together with version and plural. */
  group?: string;
  version?: string;
  plural?: string;
  /** Only for namespaced kinds. */
  namespace?: string;
  name?: string;
}

export interface DiffOptions {
  /** Drop status and server-set metadata (on by default). */
  normalize: boolean;
  /** Compare only the payload: spec, data, rules… without apiVersion, kind, metadata and status. */
  specOnly: boolean;
  /** Collapse unchanged regions in the diff view. */
  onlyChanges: boolean;
  /** Picking a kind on one side picks it on the other too (on by default). */
  syncKind: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = { normalize: true, specOnly: false, onlyChanges: false, syncKind: true };

export interface DiffState {
  left: DiffSide;
  right: DiffSide;
  options: DiffOptions;
}

export function encodeSide(side: DiffSide): string | undefined {
  if (!side.ctx) return undefined;
  const gvr = side.plural && side.version !== undefined ? `${groupToPath(side.group ?? '')}/${side.version}/${side.plural}` : '';
  return [side.ctx, gvr, side.namespace ?? '', side.name ?? ''].join('|');
}

export function parseSide(value: string | null): DiffSide {
  if (!value) return {};
  const parts = value.split('|');
  if (parts.length < 4) return {};
  // Context names may in theory contain a `|`; the last three fields cannot.
  const [gvr = '', namespace = '', name = ''] = parts.slice(-3);
  const ctx = parts.slice(0, -3).join('|');
  if (!ctx) return {};
  const side: DiffSide = { ctx };
  const [groupPath, version, plural] = gvr.split('/');
  if (groupPath && version && plural) Object.assign(side, { group: groupFromPath(groupPath), version, plural });
  if (namespace) side.namespace = namespace;
  if (name) side.name = name;
  return side;
}

export function readDiffState(params: URLSearchParams): DiffState {
  return {
    left: parseSide(params.get('left')),
    right: parseSide(params.get('right')),
    options: {
      normalize: params.get('raw') !== '1',
      specOnly: params.get('scope') === 'spec',
      onlyChanges: params.get('changes') === 'only',
      syncKind: params.get('kinds') !== 'separate',
    },
  };
}

export function diffSearchParams(state: Partial<DiffState>): URLSearchParams {
  const params = new URLSearchParams();
  const left = state.left && encodeSide(state.left);
  const right = state.right && encodeSide(state.right);
  if (left) params.set('left', left);
  if (right) params.set('right', right);
  const options = { ...DEFAULT_DIFF_OPTIONS, ...state.options };
  if (!options.normalize) params.set('raw', '1');
  if (options.specOnly) params.set('scope', 'spec');
  if (options.onlyChanges) params.set('changes', 'only');
  if (!options.syncKind) params.set('kinds', 'separate');
  return params;
}

export function diffPath(state: Partial<DiffState>): string {
  const q = diffSearchParams(state).toString();
  return `/diff${q ? `?${q}` : ''}`;
}

/** A side names one object: cluster, kind, name (and namespace for namespaced kinds). */
export function sideComplete(side: DiffSide, namespaced: boolean | undefined): boolean {
  return !!side.ctx && !!side.plural && !!side.name && (namespaced === false || !!side.namespace);
}

/**
 * Where "Compare with…" points the right side: the same kind, namespace and
 * name in another cluster, preferring the ones selected in the switcher over
 * merely connected ones. With no other cluster the right side stays in the
 * same cluster and kind, and the name is left for the user to pick.
 */
export function defaultRightSide(left: DiffSide, clusters: { selected: readonly string[]; active: readonly string[] }): DiffSide {
  const other = clusters.selected.find((c) => c !== left.ctx) ?? clusters.active.find((c) => c !== left.ctx);
  if (other) return { ...left, ctx: other };
  const { name: _name, ...rest } = left;
  return rest;
}

/**
 * Where a compare opened from the nav or the palette starts: the first
 * selected cluster on the left and the second (or the same one) on the right,
 * each in its namespace filter when that names one namespace. Kind and name
 * are left to pick.
 */
export function defaultSides(
  selected: readonly string[],
  namespacesByContext: Readonly<Record<string, readonly string[] | undefined>>,
): Pick<DiffState, 'left' | 'right'> | undefined {
  const [first, second = first] = selected;
  if (!first || !second) return undefined;
  const side = (ctx: string): DiffSide => {
    const namespaces = namespacesByContext[ctx];
    return namespaces?.length === 1 ? { ctx, namespace: namespaces[0] } : { ctx };
  };
  return { left: side(first), right: side(second) };
}

/** A kind picked for a side, with the scope that decides whether it keeps a namespace. */
export interface KindChoice {
  group: string;
  version: string;
  plural: string;
  namespaced: boolean;
}

export function sameKind(a: DiffSide, b: DiffSide): boolean {
  return !!a.plural && (a.group ?? '') === (b.group ?? '') && a.version === b.version && a.plural === b.plural;
}

/** One side switched to `kind`: its name belonged to the old kind, and only namespaced kinds keep the namespace. */
export function withKind(side: DiffSide, kind: KindChoice | null): DiffSide {
  if (!kind) return side.ctx ? { ctx: side.ctx } : {};
  return { ctx: side.ctx, group: kind.group, version: kind.version, plural: kind.plural, namespace: kind.namespaced ? side.namespace : undefined };
}

/**
 * A kind picked on one side. With the kinds synced the other side follows,
 * keeping its own cluster and namespace (comparing two namespaces, or two
 * clusters, is then one kind pick); a side that already shows that kind
 * keeps its object.
 */
export function pickKind(state: Pick<DiffState, 'left' | 'right' | 'options'>, which: 'left' | 'right', kind: KindChoice | null): Pick<DiffState, 'left' | 'right'> {
  const picked = withKind(state[which], kind);
  const otherKey = which === 'left' ? 'right' : 'left';
  const other = state[otherKey];
  const follow = state.options.syncKind && !!other.ctx && !(kind && sameKind(other, picked));
  return { [which]: picked, [otherKey]: follow ? withKind(other, kind) : other } as Pick<DiffState, 'left' | 'right'>;
}

/**
 * A side picked a cluster before any kind: with the kinds synced it starts on
 * the other side's kind and namespace, so only the name is left to choose.
 */
export function adoptKind(side: DiffSide, other: DiffSide, syncKind: boolean): DiffSide {
  if (!syncKind || !side.ctx || side.plural || !other.plural) return side;
  return { ctx: side.ctx, group: other.group, version: other.version, plural: other.plural, namespace: other.namespace };
}

/** The object as the diff shows it, under the current options. */
export function diffView(obj: KubeObject, options: Pick<DiffOptions, 'normalize' | 'specOnly'>): unknown {
  if (options.specOnly) {
    const { apiVersion: _apiVersion, kind: _kind, metadata: _metadata, status: _status, ...payload } = obj as KubeObject & Record<string, unknown>;
    return payload;
  }
  return options.normalize ? normalizeForDiff(obj) : obj;
}

/** "ctx · Kind namespace/name" for side titles and tab labels. */
export function sideLabel(side: DiffSide, kind?: string): string {
  const object = side.name ? `${side.namespace ? `${side.namespace}/` : ''}${side.name}` : '';
  return [side.ctx, [kind, object].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}
