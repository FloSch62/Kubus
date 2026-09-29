import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { rowKeyActionsFor } from '../../../client/src/components/row-key-actions';
import { rebaseYamlDraft } from '../../../client/src/components/detail/yaml-live';
import { dumpManifest } from '../../../client/src/components/detail/manifest-tree';
import { isSaveChord, isSubmitChord } from '../../../client/src/editor-keys';
import { ROW_KEYS, rowCursorStep, rowKeyDef, rowKeyForEvent } from '../../../client/src/row-keys';
import { SHORTCUT_SECTIONS } from '../../../client/src/shortcuts';
import { isTextEntryTargetWithin } from '../../../client/src/text-entry';
import type { ManifestDraft } from '../../../client/src/state/detail';

const key = (value: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('row keys', () => {
  it('maps single keys to row actions and leaves chords alone', () => {
    expect(rowKeyForEvent(key('l'))).toBe('logs');
    expect(rowKeyForEvent(key('L', { shiftKey: true }))).toBe('logs');
    expect(rowKeyForEvent(key('x'))).toBe('shell');
    expect(rowKeyForEvent(key('f'))).toBe('forward');
    expect(rowKeyForEvent(key('s'))).toBe('scale');
    expect(rowKeyForEvent(key('r'))).toBe('restart');
    expect(rowKeyForEvent(key('e'))).toBe('manifest');
    expect(rowKeyForEvent(key('Delete'))).toBe('delete');
    expect(rowKeyForEvent(key('Backspace'))).toBe('delete');
    expect(rowKeyForEvent(key('l', { ctrlKey: true }))).toBeUndefined();
    expect(rowKeyForEvent(key('r', { metaKey: true }))).toBeUndefined();
    expect(rowKeyForEvent(key('f', { altKey: true }))).toBeUndefined();
    expect(rowKeyForEvent(key('q'))).toBeUndefined();
  });

  it('moves the row cursor with j and k only', () => {
    expect(rowCursorStep(key('j'))).toBe(1);
    expect(rowCursorStep(key('k'))).toBe(-1);
    expect(rowCursorStep(key('J', { shiftKey: true }))).toBeUndefined();
    expect(rowCursorStep(key('j', { ctrlKey: true }))).toBeUndefined();
    expect(rowCursorStep(key('l'))).toBeUndefined();
  });

  it('defines each key once and lists every one in the help dialog', () => {
    const keys = ROW_KEYS.flatMap((def) => def.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(ROW_KEYS.map((def) => def.action)).size).toBe(ROW_KEYS.length);
    const section = SHORTCUT_SECTIONS.find((s) => s.title === 'Focused list row');
    expect(section?.shortcuts.map((row) => row.combos[0]?.[0])).toEqual(['J', ...ROW_KEYS.map((def) => def.label)]);
    expect(rowKeyDef('manifest').label).toBe('E');
  });
});

describe('row key availability', () => {
  const target = (kind: string, group: string, plural: string, obj: Partial<KubeObject> = {}) => ({
    ctx: 'dev',
    group,
    version: 'v1',
    plural,
    kind,
    obj: { apiVersion: 'v1', kind, metadata: { name: 'x', namespace: 'ns', uid: 'u' }, ...obj } as KubeObject,
  });
  const sorted = (set: Set<string>) => [...set].sort();

  it('offers each key only where the row menu has the action', () => {
    const running = { spec: { containers: [{ name: 'app' }] }, status: { containerStatuses: [{ name: 'app', state: { running: {} } }] } };
    const finished = { spec: { containers: [{ name: 'app' }] }, status: { phase: 'Succeeded', containerStatuses: [{ name: 'app', state: { terminated: {} } }] } };
    expect(sorted(rowKeyActionsFor(target('Pod', '', 'pods', running)))).toEqual(['delete', 'forward', 'logs', 'manifest', 'shell']);
    expect(sorted(rowKeyActionsFor(target('Pod', '', 'pods', finished)))).toEqual(['delete', 'forward', 'logs', 'manifest']);
    expect(sorted(rowKeyActionsFor(target('Deployment', 'apps', 'deployments')))).toEqual(['delete', 'forward', 'logs', 'manifest', 'restart', 'scale']);
    expect(sorted(rowKeyActionsFor(target('DaemonSet', 'apps', 'daemonsets')))).toEqual(['delete', 'forward', 'logs', 'manifest', 'restart']);
    expect(sorted(rowKeyActionsFor(target('Node', '', 'nodes')))).toEqual(['delete', 'manifest', 'shell']);
    expect(sorted(rowKeyActionsFor(target('ConfigMap', '', 'configmaps')))).toEqual(['delete', 'manifest']);
    // A custom kind borrowing a builtin name gets the generic actions only.
    expect(sorted(rowKeyActionsFor(target('Deployment', 'example.io', 'deployments')))).toEqual(['delete', 'manifest']);
  });
});

describe('typing guards and editor chords', () => {
  it('ignores the handling surface itself but not typing targets or nested surfaces', () => {
    document.body.innerHTML = `
      <div id="paper" role="dialog">
        <button id="tab">Overview</button>
        <input id="text" />
        <input id="check" type="checkbox" />
        <div class="monaco-editor"><span id="code"></span></div>
        <div role="menu"><div id="item" role="menuitem"></div></div>
      </div>`;
    const paper = document.getElementById('paper')!;
    const at = (id: string) => document.getElementById(id);
    expect(isTextEntryTargetWithin(at('tab'), paper)).toBe(false);
    expect(isTextEntryTargetWithin(at('check'), paper)).toBe(false);
    expect(isTextEntryTargetWithin(paper, paper)).toBe(false);
    expect(isTextEntryTargetWithin(at('text'), paper)).toBe(true);
    expect(isTextEntryTargetWithin(at('code'), paper)).toBe(true);
    expect(isTextEntryTargetWithin(at('item'), paper)).toBe(true);
    expect(isTextEntryTargetWithin(at('tab'), document.body)).toBe(true);
  });

  it('recognizes Mod+S and Mod+Enter on either modifier, without extra modifiers', () => {
    expect(isSaveChord(key('s', { ctrlKey: true }))).toBe(true);
    expect(isSaveChord(key('S', { metaKey: true }))).toBe(true);
    expect(isSaveChord(key('s', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveChord(key('s'))).toBe(false);
    expect(isSubmitChord(key('Enter', { metaKey: true }))).toBe(true);
    expect(isSubmitChord(key('Enter', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSubmitChord(key('Enter'))).toBe(false);
  });
});

describe('YAML rebase', () => {
  const base = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm', uid: 'cm', resourceVersion: '1' }, data: { a: '1', b: '2' } } as KubeObject;
  const draft = (text: string): ManifestDraft => ({ selKey: 'k', base, baseText: dumpManifest(base), obj: base, text, mode: 'yaml' });

  it('replays the text edits onto the latest object', () => {
    const latest = { ...base, metadata: { name: 'cm', uid: 'cm', resourceVersion: '2' }, data: { a: '1', b: '2', c: '3' } } as KubeObject;
    const edited = dumpManifest({ ...base, data: { a: 'edited', b: '2' } });
    const result = rebaseYamlDraft(draft(edited), latest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.base).toBe(latest);
    expect(result.draft.obj.data).toEqual({ a: 'edited', b: '2', c: '3' });
    expect(result.draft.text).toContain("resourceVersion: '2'");
    expect(result.draft.baseText).toBe(dumpManifest(latest));
    expect(result.draft.mode).toBe('yaml');
  });

  it('refuses text that does not parse', () => {
    const result = rebaseYamlDraft(draft('data: ['), base);
    expect(result.ok).toBe(false);
  });
});
