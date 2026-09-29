/**
 * Condition lists that sit one level down in a custom resource's status,
 * one list per item: `status.parents[].conditions` on a Gateway API route
 * (one per parent Gateway), `status.listeners[].conditions` on a Gateway.
 * The generic overview shows each item's list as its own block, labelled by
 * whatever identifies the item.
 */

export interface DetailCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface ConditionOwner {
  /** What the block belongs to, e.g. "Gateway web · http". */
  label: string;
  /** Secondary line, e.g. the controller that wrote this status. */
  detail?: string;
  conditions: DetailCondition[];
  /** Opens the object the label names (a parent Gateway), when it is one. */
  onOpen?: () => void;
  /** A line under the header, e.g. that no controller has reported yet. */
  note?: string;
}

export interface NestedConditionGroup {
  /** The status field holding the list, e.g. `parents`. */
  field: string;
  /** Section title, e.g. "Parent conditions". */
  title: string;
  owners: ConditionOwner[];
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined);

/** A `conditions` array in the usual metav1.Condition shape, or undefined. */
export function conditionList(value: unknown): DetailCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: DetailCondition[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;
    out.push({
      type: item.type,
      status: text(item.status) ?? 'Unknown',
      reason: text(item.reason),
      message: text(item.message),
      lastTransitionTime: text(item.lastTransitionTime),
    });
  }
  return out.length ? out : undefined;
}

/** "Gateway web · http :443", namespaced when the parent lives elsewhere. */
export function parentRefLabel(ref: UnknownRecord, ownNamespace?: string): string {
  const kind = text(ref.kind) ?? 'Gateway';
  const namespace = text(ref.namespace);
  const name = text(ref.name) ?? '?';
  const section = text(ref.sectionName);
  const port = text(ref.port);
  const where = namespace && namespace !== ownNamespace ? `${namespace}/${name}` : name;
  return [`${kind} ${where}`, section && `· ${section}`, port && `:${port}`].filter(Boolean).join(' ');
}

/** Words that name an item of a status list, in order of preference. */
const IDENTITY_KEYS = ['name', 'type', 'kind', 'id', 'key'];

function ownerLabel(item: UnknownRecord, index: number, ownNamespace?: string): { label: string; detail?: string } {
  const detail = text(item.controllerName) ?? text(item.controller);
  if (isRecord(item.parentRef)) return { label: parentRefLabel(item.parentRef, ownNamespace), detail };
  for (const key of IDENTITY_KEYS) {
    const value = text(item[key]);
    if (value) return { label: value, detail };
  }
  return { label: `#${index + 1}`, detail };
}

/** "parents" → "Parent conditions", "attachedListeners" → "Attached listener conditions". */
export function conditionGroupTitle(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
  const last = words.pop() ?? field;
  const singular = last.endsWith('ies') ? `${last.slice(0, -3)}y` : last.endsWith('s') && !last.endsWith('ss') ? last.slice(0, -1) : last;
  const phrase = [...words, singular].join(' ');
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} conditions`;
}

/** Every `status.<field>[]` whose items carry their own conditions, in status field order. */
export function nestedConditionGroups(status: unknown, ownNamespace?: string): NestedConditionGroup[] {
  if (!isRecord(status)) return [];
  const groups: NestedConditionGroup[] = [];
  for (const [field, value] of Object.entries(status)) {
    if (field === 'conditions' || !Array.isArray(value)) continue;
    const owners: ConditionOwner[] = [];
    value.forEach((item, index) => {
      if (!isRecord(item)) return;
      const conditions = conditionList(item.conditions);
      if (conditions) owners.push({ ...ownerLabel(item, index, ownNamespace), conditions });
    });
    if (owners.length) groups.push({ field, title: conditionGroupTitle(field), owners });
  }
  return groups;
}

/** Whether a condition deviates from its healthy status (Unknown counts as not yet healthy). */
export function conditionHealthy(condition: DetailCondition, goodWhen?: (type: string) => 'True' | 'False'): boolean {
  return condition.status === (goodWhen?.(condition.type) ?? 'True');
}
