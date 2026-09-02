import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ClearIcon from '@mui/icons-material/Clear';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import NotesIcon from '@mui/icons-material/Notes';
import SearchIcon from '@mui/icons-material/Search';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import { gvkForKind, type KubeObject } from '@kubus/shared';
import { useApiResources, useResourceSchema } from '../../api/queries.js';
import { withoutManagedFields } from '../../kube-display.js';
import { useDetailStore, type ManifestDraft } from '../../state/detail.js';
import { showToast } from '../../state/toast.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { AddFieldPopover, ManifestTree, type EditRequest, type ExpandCommand } from './ManifestTree.js';
import { ReviewApplyDialog, type ReviewTarget } from './ReviewApplyDialog.js';
import { CountPill, Section } from './Section.js';
import {
  deleteAt,
  diffChanges,
  dumpManifest,
  emptyValueFor,
  filterTree,
  getAt,
  hasAt,
  isContainer,
  lockReason,
  manifestGroups,
  pointerOf,
  rebaseEdits,
  setAt,
  splitApiVersion,
  type FilterResult,
  type JsonPath,
  type ResourceLink,
} from './manifest-tree.js';
import { schemaAt, schemaDefinitions, type JsonSchema } from './schema-walk.js';

const EMPTY_FLASH: ReadonlySet<string> = new Set();

/**
 * Pointers whose value just changed between two snapshots of a live object,
 * held for a moment so the rows can flash. Collapsed parents flash too.
 */
export function useFlash(value: unknown, enabled: boolean): ReadonlySet<string> {
  const prev = useRef(value);
  const [flash, setFlash] = useState<ReadonlySet<string>>(EMPTY_FLASH);
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (!enabled || before === value) return;
    const changes = diffChanges(before, value);
    if (changes.rows.size === 0) return;
    setFlash(new Set([...changes.rows.keys(), ...changes.touched]));
    const timer = window.setTimeout(() => setFlash(EMPTY_FLASH), 1500);
    return () => window.clearTimeout(timer);
  }, [value, enabled]);
  return flash;
}

/**
 * Turn a detected reference into a drawer navigation: builtin kinds resolve
 * statically, custom kinds through the cluster's discovery list. Kinds the
 * cluster doesn't serve (RBAC users and groups) don't get a link.
 */
export function useOpenReference(ctx: string): { open: (ref: ResourceLink) => void; canOpen: (ref: ResourceLink) => boolean } {
  const push = useDetailStore((s) => s.push);
  const { data: apiResources } = useApiResources(ctx);
  const resolve = useCallback(
    (ref: ResourceLink) => {
      const { group } = splitApiVersion(ref.apiVersion);
      const served = apiResources?.filter((r) => r.kind === ref.kind) ?? [];
      const info = (ref.apiVersion ? served.find((r) => r.group === group) : undefined) ?? served[0];
      if (info) return { group: info.group, version: info.version, plural: info.plural, namespaced: info.namespaced, custom: info.custom };
      const builtin = gvkForKind(ref.kind);
      return builtin ? { group: builtin.group, version: builtin.version, plural: builtin.plural, namespaced: builtin.namespaced, custom: false } : undefined;
    },
    [apiResources],
  );
  const open = useCallback(
    (ref: ResourceLink) => {
      const target = resolve(ref);
      if (!target) return;
      push({ ctx, group: target.group, version: target.version, plural: target.plural, kind: ref.kind, name: ref.name, namespace: target.namespaced ? ref.namespace : undefined, custom: target.custom });
    },
    [ctx, push, resolve],
  );
  const canOpen = useCallback((ref: ResourceLink) => !!resolve(ref), [resolve]);
  return useMemo(() => ({ open, canOpen }), [open, canOpen]);
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(obj, key)) out[key] = obj[key];
  return out;
}

/** Section rail colors, matching the schema browser: spec blue, status green. */
function accentFor(key: string): string {
  switch (key) {
    case 'spec':
      return 'primary.main';
    case 'status':
      return 'success.main';
    case 'metadata':
      return 'text.disabled';
    default:
      return 'secondary.main';
  }
}

function containerSize(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (isContainer(value)) return Object.keys(value as object).length;
  return undefined;
}

function hasMatchUnder(filter: FilterResult, key: string): boolean {
  const prefix = `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  for (const pointer of filter.matches) if (pointer === prefix || pointer.startsWith(`${prefix}/`)) return true;
  return false;
}

export interface ManifestViewProps {
  sel: ReviewTarget;
  /** The live object (watched); the tree shows the draft over it while editing. */
  live: KubeObject;
  draft?: ManifestDraft;
  /** Stage `obj` as the draft (undefined discards); `base` is the snapshot it applies to. */
  onDraftChange: (obj: KubeObject | undefined, base: KubeObject) => void;
  readOnly?: boolean;
  /** Secret data is redacted, so its rows stay locked. */
  secretRedacted?: boolean;
  /** Extra toolbar content (e.g. the reveal-secrets toggle). */
  toolbar?: ReactNode;
  onApplied: (updated: KubeObject) => void;
  /** The apply hit a 409; the caller refreshes the live object. */
  onConflict: () => void;
}

/**
 * The Manifest tab: the object as sectioned trees (metadata, spec, status,
 * everything else) with filtering, inline editing against a draft shared
 * with the YAML tab, and a diff + dry-run review before the apply.
 */
export function ManifestView({ sel, live, draft, onDraftChange, readOnly = false, secretRedacted = false, toolbar, onApplied, onConflict }: ManifestViewProps) {
  const liveBase = useMemo(() => withoutManagedFields(live), [live]);
  const base = draft?.base ?? liveBase;
  const current = draft?.obj ?? liveBase;
  const changes = useMemo(() => (draft ? diffChanges(base, current) : undefined), [draft, base, current]);
  const changeCount = changes?.rows.size ?? 0;

  const { data: schemaDoc } = useResourceSchema({ ctx: sel.ctx, group: sel.group, version: sel.version, kind: sel.kind });
  const rootSchema = schemaDoc as JsonSchema | undefined;
  const definitions = useMemo(() => schemaDefinitions(schemaDoc), [schemaDoc]);

  const [query, setQuery] = useState('');
  const filter = useMemo(() => filterTree(current, [], query), [current, query]);
  const [expandCommand, setExpandCommand] = useState<ExpandCommand>();
  const [showDocs, setShowDocs] = useState(false);
  const [sectionAdd, setSectionAdd] = useState<{ key: string; anchor: HTMLElement }>();
  const [editRequest, setEditRequest] = useState<EditRequest>();
  const [forcedOpen, setForcedOpen] = useState<Record<string, number>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [review, setReview] = useState(false);
  const [rebaseOnRefresh, setRebaseOnRefresh] = useState(false);
  const flash = useFlash(current, !draft);
  const reference = useOpenReference(sel.ctx);
  const lock = useCallback((path: JsonPath) => lockReason(path, { secretRedacted }), [secretRedacted]);

  const update = useCallback((next: KubeObject) => onDraftChange(next, base), [onDraftChange, base]);
  const onEdit = useCallback((path: JsonPath, value: unknown) => update(setAt(current, path, value)), [update, current]);
  const onDelete = useCallback((path: JsonPath) => update(deleteAt(current, path)), [update, current]);
  const onReset = useCallback(
    (path: JsonPath) => update(hasAt(base, path) ? setAt(current, path, getAt(base, path)) : deleteAt(current, path)),
    [update, current, base],
  );

  // The server moved on while a draft is open: offer to replay the edits onto
  // the latest snapshot (automatically after a 409 refreshed it).
  const serverMoved = !!draft && live.metadata.resourceVersion !== draft.base.metadata.resourceVersion;
  const rebase = useCallback(() => {
    if (!draft) return;
    onDraftChange(rebaseEdits(draft.base, draft.obj, liveBase), liveBase);
  }, [draft, liveBase, onDraftChange]);
  useEffect(() => {
    if (!rebaseOnRefresh || !serverMoved) return;
    setRebaseOnRefresh(false);
    rebase();
    showToast('info', 'Your edits were replayed onto the latest version — review and apply again.');
  }, [rebaseOnRefresh, serverMoved, rebase]);

  const groups = useMemo(() => manifestGroups(current), [current]);
  const sections = groups.filter((group) => isContainer(current[group.key]));
  const scalarKeys = groups.filter((group) => !isContainer(current[group.key])).map((group) => group.key);
  const scalars = useMemo(() => pick(current, scalarKeys), [current, scalarKeys.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the joined key list
  const scalarBase = useMemo(() => pick(base, scalarKeys), [base, scalarKeys.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the joined key list
  const showScalars = scalarKeys.length > 0 && (!filter || scalarKeys.some((key) => hasMatchUnder(filter, key)));
  const yamlBody = useMemo(() => (draft ? dumpManifest(current) : ''), [draft, current]);

  // Adding under a section root: lists append an item straight away, objects
  // open the field picker; a new scalar goes straight into its inline editor.
  const addUnderSection = (key: string, name: string | number, value: unknown) => {
    const path = [key, name];
    onEdit(path, value);
    setForcedOpen((prev) => ({ ...prev, [key]: Date.now() }));
    if (!isContainer(value)) setEditRequest({ pointer: pointerOf(path), seq: Date.now() });
  };
  const sectionAddSchema = sectionAdd ? schemaAt(rootSchema, definitions, [sectionAdd.key]) : undefined;

  const treeProps = {
    definitions,
    readOnly,
    lock,
    changes,
    flash,
    filter,
    expandCommand,
    editRequest,
    showDocs,
    ownerNamespace: live.metadata.namespace,
    onOpenRef: reference.open,
    canOpenRef: reference.canOpen,
    onEdit: readOnly ? undefined : onEdit,
    onDelete: readOnly ? undefined : onDelete,
    onReset: readOnly ? undefined : onReset,
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ p: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', rowGap: 0.5 }}>
        {toolbar}
        <TextField
          size="small"
          placeholder="Filter fields and values"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
          slotProps={{
            input: {
              'aria-label': 'Filter manifest',
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  <IconButton size="small" aria-label="Clear filter" onClick={() => setQuery('')} sx={{ p: 0.25 }}>
                    <ClearIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
              sx: { fontSize: 13 },
            },
          }}
          sx={{ flex: 1, minWidth: 180, maxWidth: 360 }}
        />
        <Tooltip title="Expand all">
          <IconButton size="small" aria-label="Expand all" onClick={() => setExpandCommand({ kind: 'expand', seq: Date.now() })}>
            <UnfoldMoreIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Collapse all">
          <IconButton size="small" aria-label="Collapse all" onClick={() => setExpandCommand({ kind: 'collapse', seq: Date.now() })}>
            <UnfoldLessIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={showDocs ? 'Hide field descriptions' : 'Show field descriptions'}>
          <ToggleButton
            value="docs"
            size="small"
            selected={showDocs}
            aria-label="Show descriptions"
            onChange={() => setShowDocs((v) => !v)}
            sx={{ p: 0.5, border: 0, borderRadius: '50%' }}
          >
            <NotesIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        {!readOnly && (
          <>
            {changeCount > 0 && <CountPill value={`${changeCount} ${changeCount === 1 ? 'change' : 'changes'}`} sx={{ color: 'warning.main' }} />}
            <Button disabled={!draft} onClick={() => setConfirmReset(true)}>
              Reset
            </Button>
            <Button variant="contained" disabled={!draft} onClick={() => setReview(true)}>
              Review & apply
            </Button>
          </>
        )}
      </Stack>
      {serverMoved && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0, flexShrink: 0 }}
          action={
            <Button color="inherit" size="small" onClick={rebase}>
              Rebase edits
            </Button>
          }
        >
          This object changed on the server while you were editing. Rebase replays your edits onto the latest version.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Stack spacing={1.5} sx={{ p: 2 }}>
          {sections.map((group) => {
            if (filter && !hasMatchUnder(filter, group.key)) return null;
            const value = current[group.key];
            const locked = readOnly ? undefined : lock([group.key]);
            const groupSchema = schemaAt(rootSchema, definitions, [group.key]);
            const isList = Array.isArray(value);
            const addLabel = `${isList ? 'Add item to' : 'Add field to'} ${group.title}`;
            return (
              <Section
                key={group.key}
                title={group.title}
                count={containerSize(value)}
                description={group.key === 'metadata' ? `${live.apiVersion ?? ''} ${live.kind ?? ''}`.trim() : undefined}
                defaultOpen={group.key !== 'metadata' || !!filter || !!forcedOpen[group.key]}
                flush
                actions={
                  locked ? (
                    <Tooltip title={locked}>
                      <LockOutlinedIcon aria-label={locked} sx={{ fontSize: 15, color: 'text.disabled' }} />
                    </Tooltip>
                  ) : readOnly ? undefined : (
                    <Tooltip title={addLabel}>
                      <IconButton
                        size="small"
                        aria-label={addLabel}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isList) addUnderSection(group.key, value.length, emptyValueFor(groupSchema?.items ? schemaAt(groupSchema.items, definitions, []) : undefined));
                          else setSectionAdd({ key: group.key, anchor: e.currentTarget });
                        }}
                        sx={{ p: 0.5 }}
                      >
                        <AddIcon sx={{ fontSize: 18 }} />
                      </IconButton>
                    </Tooltip>
                  )
                }
              >
                <Box sx={{ px: 1, py: 0.75 }}>
                  <ManifestTree
                    {...treeProps}
                    value={value}
                    base={base[group.key]}
                    rootPath={[group.key]}
                    schema={groupSchema}
                    accent={accentFor(group.key)}
                    description={group.key === 'metadata' ? undefined : groupSchema?.description}
                  />
                </Box>
              </Section>
            );
          })}
          {showScalars && (
            <Section title="Fields" count={scalarKeys.length} flush>
              <Box sx={{ px: 1, py: 0.75 }}>
                <ManifestTree {...treeProps} value={scalars} base={scalarBase} rootPath={[]} schema={rootSchema} accent="secondary.main" />
              </Box>
            </Section>
          )}
          {sections.length === 0 && !showScalars && (
            <Typography variant="body2" color="text.secondary">
              {filter ? 'No fields match the filter.' : 'This object has no fields besides its identity.'}
            </Typography>
          )}
        </Stack>
      </Box>
      {sectionAdd && (
        <AddFieldPopover
          anchor={sectionAdd.anchor}
          schema={sectionAddSchema}
          definitions={definitions}
          existing={isContainer(current[sectionAdd.key]) ? Object.keys(current[sectionAdd.key] as object) : []}
          onClose={() => setSectionAdd(undefined)}
          onAdd={(name, value) => {
            setSectionAdd(undefined);
            addUnderSection(sectionAdd.key, name, value);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmReset}
        title="Discard changes?"
        message="All staged edits will be discarded and the tree reloaded from the cluster."
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          setConfirmReset(false);
          onDraftChange(undefined, base);
        }}
        onClose={() => setConfirmReset(false)}
      />
      {review && draft && (
        <ReviewApplyDialog
          sel={sel}
          yamlBody={yamlBody}
          left={draft.baseText}
          right={yamlBody}
          onClose={() => setReview(false)}
          onApplied={(updated) => {
            setReview(false);
            onApplied(updated);
          }}
          onConflict={() => {
            setRebaseOnRefresh(true);
            onConflict();
          }}
        />
      )}
    </Box>
  );
}
