import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import UndoIcon from '@mui/icons-material/Undo';
import { copyToClipboard } from '../../clipboard.js';
import { statusLikeName } from '../../kube-display.js';
import { showToast } from '../../state/toast.js';
import { RelativeTimeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { ClampedText } from './ClampedText.js';
import { CountPill } from './Section.js';
import {
  ISO_TIMESTAMP_RE,
  QUANTITY_RE,
  collapsedPreview,
  compactType,
  defaultExpanded,
  displayPath,
  dumpManifest,
  editorKindFor,
  emptyValueFor,
  enumValueFor,
  hasNaturalKeys,
  isContainer,
  isPlainObject,
  itemLabel,
  normalizeDescription,
  parseScalarInput,
  pointerOf,
  referenceAt,
  removedItemPointer,
  scalarText,
  suggestedKeys,
  uniqueLabels,
  type ChangeKind,
  type ChangeSet,
  type EditorKind,
  type FilterResult,
  type JsonPath,
  type ResourceLink,
} from './manifest-tree.js';
import { displayType, schemaAt, type JsonSchema, type SchemaDefinitions } from './schema-walk.js';

/** "Expand all" / "Collapse all" request from the section header; `seq` makes repeats observable. */
export interface ExpandCommand {
  kind: 'expand' | 'collapse';
  seq: number;
}

/** Ask the tree to open the inline editor on a row (a field added from the section header). */
export interface EditRequest {
  pointer: string;
  seq: number;
}

export interface ManifestTreeProps {
  /** Value at `rootPath` in the object being shown (the draft while editing). */
  value: unknown;
  /** Value at `rootPath` in the base snapshot; removed keys render as ghost rows. */
  base?: unknown;
  rootPath: JsonPath;
  /** Schema for the value at `rootPath`. */
  schema?: JsonSchema;
  definitions?: SchemaDefinitions;
  readOnly?: boolean;
  /** Why a path can't be edited (undefined when it can). */
  lock?: (path: JsonPath) => string | undefined;
  changes?: ChangeSet;
  /** Pointers whose value just changed on the server — briefly highlighted. */
  flash?: ReadonlySet<string>;
  /** Active filter (pointers are absolute); rows outside the matches hide. */
  filter?: FilterResult;
  expandCommand?: ExpandCommand;
  editRequest?: EditRequest;
  /** Root keys to leave out. */
  hideKeys?: ReadonlySet<string>;
  /** Show each field's schema description under its row. */
  showDocs?: boolean;
  /** Theme color for the section rail (spec blue, status green…). */
  accent?: string;
  /** Section-level schema description shown above the rows. */
  description?: string;
  ownerNamespace?: string;
  onOpenRef?: (ref: ResourceLink) => void;
  /** Whether a detected reference resolves to a kind the cluster serves (unlinkable ones stay plain text). */
  canOpenRef?: (ref: ResourceLink) => boolean;
  onEdit?: (path: JsonPath, value: unknown) => void;
  onDelete?: (path: JsonPath) => void;
  /** Restore a row (and its subtree) to the base snapshot. */
  onReset?: (path: JsonPath) => void;
  /** Bring back a removed row (base coordinates); falls back to onReset. */
  onRestore?: (path: JsonPath) => void;
}

const NO_DEFINITIONS: SchemaDefinitions = {};
const EMPTY_SET: ReadonlySet<string> = new Set();

export const MONO_FONT = '"JetBrains Mono", "Fira Code", monospace';
/** Indent per nesting level, drawn inside the key column so values line up across depths. */
const INDENT = 22;
/**
 * One grid per tree, shared by every row through subgrid: the key column
 * fits the widest visible key (capped so long annotation keys wrap instead
 * of starving the values), values take the rest, the type column fits its
 * labels.
 */
const GRID_COLUMNS = 'fit-content(min(320px, 50%)) minmax(0, 1fr) auto';

/** Value colors by type family: navy strings, green numbers, purple keywords — nothing that reads as a warning. */
function valuePalette(theme: Theme) {
  const dark = theme.palette.mode === 'dark';
  return {
    string: dark ? '#a5d6ff' : '#1f5fb8',
    number: dark ? '#b5cea8' : '#1a9a5e',
    keyword: dark ? '#d2a8ff' : '#8a5cf0',
  };
}

const treeSx = (theme: Theme) => ({
  fontSize: 13,
  py: 0.25,
  '& .kubus-tree-row': {
    borderRadius: 1,
    outline: 'none',
    '&:hover, &:focus-visible': { bgcolor: 'action.hover' },
    '&:focus-visible': { boxShadow: `inset 0 0 0 1px ${theme.palette.primary.main}` },
  },
  // Row actions overlay the right edge on hover so the columns never move.
  '& .kubus-tree-actions': { display: 'none' },
  '& .kubus-tree-row:hover .kubus-tree-actions, & .kubus-tree-row:focus-within .kubus-tree-actions, & .kubus-tree-row[data-menu="open"] .kubus-tree-actions': { display: 'flex' },
  // Nested rows keep the shared columns; the rail sits at the parent's indent.
  '& .kubus-tree-children': {
    display: 'grid',
    gridTemplateColumns: 'subgrid',
    gridColumn: '1 / -1',
    position: 'relative',
    '&::before': { content: '""', position: 'absolute', top: 2, bottom: 2, width: '1px', bgcolor: 'divider', pointerEvents: 'none' },
    // Active trail: every rail above the hovered/focused row lights up.
    '&:hover::before, &:focus-within::before': { bgcolor: alpha(theme.palette.primary.main, 0.6) },
  },
  '& .kubus-tree-flash': { animation: 'kubus-tree-flash 1.2s ease-out' },
  '@keyframes kubus-tree-flash': {
    from: { backgroundColor: alpha(theme.palette.info.main, 0.3) },
    to: { backgroundColor: 'transparent' },
  },
});

interface TreeContext {
  rootPath: JsonPath;
  definitions: SchemaDefinitions;
  readOnly: boolean;
  lock?: (path: JsonPath) => string | undefined;
  changes?: ChangeSet;
  flash: ReadonlySet<string>;
  filter?: FilterResult;
  showDocs: boolean;
  forced?: 'expand' | 'collapse';
  overrides: ReadonlyMap<string, boolean>;
  toggle: (pointer: string, open?: boolean) => void;
  editing?: string;
  setEditing: (pointer: string | undefined) => void;
  ownerNamespace?: string;
  onOpenRef?: (ref: ResourceLink) => void;
  canOpenRef?: (ref: ResourceLink) => boolean;
  onEdit?: (path: JsonPath, value: unknown) => void;
  onDelete?: (path: JsonPath) => void;
  onReset?: (path: JsonPath) => void;
  onRestore?: (path: JsonPath) => void;
}

/**
 * Object browser for one subtree of a manifest: rows with rails and an active
 * trail, typed values, schema descriptions on hover, change marks against a
 * base snapshot, inline editing and resource links. Sections wrap one tree
 * per top-level key.
 */
export function ManifestTree({
  value,
  base,
  rootPath,
  schema,
  definitions = NO_DEFINITIONS,
  readOnly = false,
  lock,
  changes,
  flash = EMPTY_SET,
  filter,
  expandCommand,
  editRequest,
  hideKeys,
  showDocs = false,
  accent,
  description,
  ownerNamespace,
  onOpenRef,
  canOpenRef,
  onEdit,
  onDelete,
  onReset,
  onRestore,
}: ManifestTreeProps) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [forced, setForced] = useState<'expand' | 'collapse'>();
  const [editing, setEditing] = useState<string>();
  const lastCommand = useRef<number>(undefined);
  const lastEditRequest = useRef<number>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const rootPointer = pointerOf(rootPath);

  // Reset when the command's seq changes, without an effect: applying state in
  // render keeps the very next paint consistent.
  if (expandCommand && lastCommand.current !== expandCommand.seq) {
    lastCommand.current = expandCommand.seq;
    setForced(expandCommand.kind);
    setOverrides(new Map());
  }
  if (editRequest && lastEditRequest.current !== editRequest.seq && editRequest.pointer.startsWith(`${rootPointer}/`)) {
    lastEditRequest.current = editRequest.seq;
    setEditing(editRequest.pointer);
  }

  const toggle = useCallback((pointer: string, open?: boolean) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(pointer, open ?? !(prev.get(pointer) ?? false));
      return next;
    });
  }, []);

  const ctx = useMemo<TreeContext>(
    () => ({
      rootPath,
      definitions,
      readOnly: readOnly || !onEdit,
      lock,
      changes,
      flash,
      filter,
      showDocs,
      forced,
      overrides,
      toggle,
      editing,
      setEditing,
      ownerNamespace,
      onOpenRef,
      canOpenRef,
      onEdit,
      onDelete,
      onReset,
      onRestore,
    }),
    [rootPath, definitions, readOnly, lock, changes, flash, filter, showDocs, forced, overrides, toggle, editing, ownerNamespace, onOpenRef, canOpenRef, onEdit, onDelete, onReset, onRestore],
  );

  // Keyboard navigation over the visible rows: arrows move, right/left
  // expand/collapse, Enter edits a scalar or toggles a container.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'treeitem' || e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = [...(containerRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const index = rows.indexOf(target);
    if (index === -1) return;
    const pointer = target.dataset.pointer ?? '';
    const expandable = target.getAttribute('aria-expanded') !== null;
    const expanded = target.getAttribute('aria-expanded') === 'true';
    const focusRow = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        focusRow(index - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(rows.length - 1);
        break;
      case 'ArrowRight':
        if (expandable && !expanded) toggle(pointer, true);
        else focusRow(index + 1);
        break;
      case 'ArrowLeft': {
        if (expandable && expanded) {
          toggle(pointer, false);
          break;
        }
        const level = Number(target.getAttribute('aria-level') ?? '1');
        const parent = rows.slice(0, index).reverse().find((row) => Number(row.getAttribute('aria-level') ?? '1') < level);
        parent?.focus();
        break;
      }
      case 'Enter':
        if (expandable) toggle(pointer);
        else if (target.dataset.editable === 'true') setEditing(pointer);
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const entries = childEntries(value, base, hideKeys, rootPath);
  return (
    <Box
      ref={containerRef}
      role="tree"
      onKeyDown={onKeyDown}
      sx={[treeSx, { display: 'grid', gridTemplateColumns: GRID_COLUMNS, columnGap: 1.5, borderLeft: '2px solid', borderColor: accent ?? 'divider', pl: 1, ml: 0.5 }]}
    >
      {description && showDocs && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ gridColumn: '1 / -1', mx: '18px', mb: 0.5, pb: 1, borderBottom: '1px solid', borderColor: 'divider', maxWidth: '72ch', whiteSpace: 'pre-line', lineHeight: 1.55 }}
        >
          {normalizeDescription(description)}
        </Typography>
      )}
      {entries.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ gridColumn: '1 / -1', py: 0.75, pl: '18px' }}>
          {Array.isArray(value) ? 'Empty list.' : 'No fields.'}
        </Typography>
      )}
      {entries.map((entry, i) => (
        <TreeRow
          key={entry.pointer}
          ctx={ctx}
          path={[...rootPath, entry.segment]}
          pointer={entry.pointer}
          value={entry.value}
          base={entry.base}
          schema={schemaAt(schema, definitions, [entry.segment])}
          depth={0}
          first={i === 0}
          label={entry.label}
          indexLabel={entry.indexLabel}
        />
      ))}
    </Box>
  );
}

interface ChildEntry {
  segment: string | number;
  pointer: string;
  value: unknown;
  base: unknown;
  label: string;
  /** Muted index shown after a natural-key label. */
  indexLabel?: string;
}

/**
 * Rows under a container: draft entries in document order, then keys only
 * the base still has (rendered as removed). Array items are labelled by a
 * natural key (name, type, port…) when every item carries one.
 */
function childEntries(value: unknown, base: unknown, hideKeys?: ReadonlySet<string>, parentPath: JsonPath = []): ChildEntry[] {
  if (Array.isArray(value)) {
    const natural = hasNaturalKeys(value);
    // Keyed lists pair items by label (so a reordered or grown list still
    // compares like with like) and keep removed items as ghost rows.
    const labels = uniqueLabels(value);
    const baseLabels = Array.isArray(base) ? uniqueLabels(base) : undefined;
    const keyed = !!labels && !!baseLabels;
    const positional = !keyed && Array.isArray(base) && base.length === value.length ? base : undefined;
    const entries: ChildEntry[] = value.map((item, i) => ({
      segment: i,
      pointer: pointerOf([...parentPath, i]),
      value: item,
      base: keyed ? (base as unknown[])[baseLabels.indexOf(labels[i]!)] : positional ? positional[i] : item,
      label: natural ? itemLabel(item, i) : String(i),
      indexLabel: natural ? `#${i}` : undefined,
    }));
    if (keyed) {
      (base as unknown[]).forEach((item, baseIndex) => {
        const label = baseLabels[baseIndex]!;
        if (labels.includes(label)) return;
        entries.push({ segment: baseIndex, pointer: removedItemPointer(parentPath, label), value: undefined, base: item, label, indexLabel: `#${baseIndex}` });
      });
    }
    return entries;
  }
  if (!isPlainObject(value)) return [];
  const baseObject = isPlainObject(base) ? base : undefined;
  const entries: ChildEntry[] = Object.entries(value)
    .filter(([key]) => !hideKeys?.has(key))
    .map(([key, item]) => ({
      segment: key,
      pointer: pointerOf([...parentPath, key]),
      value: item,
      base: baseObject ? baseObject[key] : item,
      label: key,
    }));
  if (baseObject) {
    for (const [key, item] of Object.entries(baseObject)) {
      if (Object.hasOwn(value, key) || hideKeys?.has(key)) continue;
      entries.push({ segment: key, pointer: pointerOf([...parentPath, key]), value: undefined, base: item, label: key });
    }
  }
  return entries;
}

interface TreeRowProps {
  ctx: TreeContext;
  path: JsonPath;
  pointer: string;
  value: unknown;
  base: unknown;
  schema: JsonSchema | undefined;
  depth: number;
  first: boolean;
  label: string;
  indexLabel?: string;
}

const TreeRow = memo(function TreeRow({ ctx, path, pointer, value, base, schema, depth, first, label, indexLabel }: TreeRowProps) {
  const removed = value === undefined && base !== undefined;
  const shown = removed ? base : value;
  const container = isContainer(shown);
  const change: ChangeKind | undefined = removed ? 'removed' : ctx.changes?.rows.get(pointer)?.kind;
  const touched = !change && !!ctx.changes?.touched.has(pointer);
  const lockReason = ctx.lock?.(path);
  const editable = !ctx.readOnly && !removed && !lockReason;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);

  const filtered = ctx.filter;
  const inFilter = !filtered || filtered.matches.has(pointer) || filtered.open.has(pointer) || isUnderMatch(pointer, filtered);
  const expanded = container && (filtered && !ctx.overrides.has(pointer) ? filtered.open.has(pointer) : (ctx.overrides.get(pointer) ?? (ctx.forced ? ctx.forced === 'expand' : defaultExpanded(shown, depth))));
  const editing = ctx.editing === pointer;
  const detected = ctx.onOpenRef ? referenceAt(path, shown, ctx.ownerNamespace) : undefined;
  const ref = detected && (!ctx.canOpenRef || ctx.canOpenRef(detected)) ? detected : undefined;
  const description = schema?.description;
  const typeLabel = schema ? displayType(schema, ctx.definitions) : undefined;

  if (!inFilter) return null;

  const toggle = () => ctx.toggle(pointer);
  const copyValue = () => {
    const text = container ? dumpManifest(shown) : scalarText(shown);
    void copyToClipboard(text).then((ok) => showToast(ok ? 'success' : 'error', ok ? `Copied ${label}` : 'Copy to clipboard failed'));
  };
  const copyPath = () => {
    void copyToClipboard(displayPath(path)).then((ok) => showToast(ok ? 'success' : 'error', ok ? 'Copied path' : 'Copy to clipboard failed'));
  };
  const addChild = (key: string | number, childValue: unknown) => {
    const childPath = [...path, key];
    ctx.onEdit?.(childPath, childValue);
    ctx.toggle(pointer, true);
    if (!isContainer(childValue)) ctx.setEditing(pointerOf(childPath));
  };
  const addArrayItem = () => {
    const itemSchema = schema?.items ? schemaAt(schema.items, ctx.definitions, []) : undefined;
    addChild(Array.isArray(shown) ? shown.length : 0, emptyValueFor(itemSchema ?? (Array.isArray(shown) && shown.length ? inferSchema(shown[0]) : undefined)));
  };
  const stop = (e: MouseEvent) => e.stopPropagation();

  const fullType = typeLabel ?? valueTypeLabel(shown);
  const indexOnly = !indexLabel && typeof path[path.length - 1] === 'number';
  const preview = container ? collapsedPreview(shown) : '';
  const keyNode = (
    <Typography
      component="span"
      variant="body2"
      sx={{
        fontWeight: indexOnly ? 500 : 600,
        lineHeight: '20px',
        color: removed ? 'text.disabled' : indexOnly ? 'text.secondary' : 'text.primary',
        fontFamily: indexOnly ? MONO_FONT : undefined,
        textDecoration: removed ? 'line-through' : undefined,
        overflowWrap: 'anywhere',
        ...(description && !ctx.showDocs && { cursor: 'help' }),
      }}
    >
      {indexOnly ? `[${label}]` : label}
    </Typography>
  );

  return (
    <>
      <Box
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={container ? expanded : undefined}
        aria-selected={false}
        tabIndex={first && depth === 0 ? 0 : -1}
        data-pointer={pointer}
        data-editable={editable && !container ? 'true' : undefined}
        data-menu={menuAnchor || addAnchor ? 'open' : undefined}
        className={`kubus-tree-row${ctx.flash.has(pointer) ? ' kubus-tree-flash' : ''}`}
        onClick={container ? toggle : undefined}
        sx={{
          display: 'grid',
          gridTemplateColumns: 'subgrid',
          gridColumn: '1 / -1',
          columnGap: 1.5,
          alignItems: 'start',
          py: '4px',
          pr: 0.5,
          minHeight: 28,
          cursor: container ? 'pointer' : 'default',
          ...(change && {
            boxShadow: (theme: Theme) => `inset 3px 0 0 ${change === 'removed' ? theme.palette.error.main : change === 'added' ? theme.palette.success.main : theme.palette.warning.main}`,
          }),
          ...(removed && { opacity: 0.7 }),
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, minWidth: 0, pl: `${depth * INDENT}px` }}>
          <Box sx={{ width: 18, flexShrink: 0, display: 'flex', justifyContent: 'center', alignSelf: 'flex-start', height: 20 }}>
            {container && (
              <KeyboardArrowRightIcon
                aria-hidden
                sx={{ fontSize: 18, mt: '1px', color: 'text.secondary', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
              />
            )}
          </Box>
          {description && !ctx.showDocs ? <Tooltip title={normalizeDescription(description)} enterDelay={500}>{keyNode}</Tooltip> : keyNode}
          {indexLabel && (
            <Typography component="span" variant="caption" color="text.disabled" sx={{ flexShrink: 0, fontFamily: MONO_FONT }}>
              {indexLabel}
            </Typography>
          )}
          {touched && (
            <Tooltip title="Contains changes">
              <Box component="span" aria-label="Contains changes" sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main', flexShrink: 0, alignSelf: 'center' }} />
            </Tooltip>
          )}
        </Box>
        <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', rowGap: 0.25 }}>
          {container ? (
            <>
              {preview && (
                <Typography component="span" variant="body2" color="text.secondary" noWrap sx={{ minWidth: 0, lineHeight: '20px', fontFamily: MONO_FONT, fontSize: 12.5 }}>
                  {preview}
                </Typography>
              )}
              {ref && ctx.onOpenRef && (
                <Link
                  component="button"
                  variant="body2"
                  underline="hover"
                  onClick={(e: MouseEvent) => {
                    stop(e);
                    ctx.onOpenRef?.(ref);
                  }}
                  sx={{ fontWeight: 600, lineHeight: '20px', verticalAlign: 'baseline' }}
                >
                  Open {ref.kind}
                </Link>
              )}
            </>
          ) : (
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', minHeight: 20 }} onClick={editable && !editing ? () => ctx.setEditing(pointer) : undefined}>
              {editing ? (
                <InlineEditor
                  value={shown}
                  schema={schema}
                  onCommit={(next) => {
                    ctx.setEditing(undefined);
                    if (!Object.is(next, shown)) ctx.onEdit?.(path, next);
                  }}
                  onCancel={() => ctx.setEditing(undefined)}
                />
              ) : (
                <ScalarValue value={shown} label={label} refLink={ref} onOpenRef={ctx.onOpenRef} editable={editable} />
              )}
            </Box>
          )}
          {change && <ChangePill kind={change} />}
        </Box>
        <Box sx={{ position: 'relative', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 0.5, minHeight: 20 }}>
          {lockReason && !ctx.readOnly && (
            <Tooltip title={lockReason}>
              <LockOutlinedIcon aria-label={lockReason} sx={{ fontSize: 13, color: 'text.disabled' }} />
            </Tooltip>
          )}
          <TypeChip label={compactType(fullType)} title={fullType} />
          <Stack
            direction="row"
            className="kubus-tree-actions"
            onClick={stop}
            sx={{
              position: 'absolute',
              right: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              alignItems: 'center',
              px: 0.25,
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              boxShadow: 1,
              zIndex: 1,
            }}
          >
            {(change || touched) && ctx.onReset && !ctx.readOnly && (
              <Tooltip title={removed ? 'Restore' : 'Reset to server value'}>
                <IconButton size="small" aria-label={`${removed ? 'Restore' : 'Reset'} ${label}`} onClick={() => (removed ? (ctx.onRestore ?? ctx.onReset)?.(path) : ctx.onReset?.(path))} sx={{ p: 0.25 }}>
                  <UndoIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            )}
            {!removed && (
              <Tooltip title={container ? 'Copy as YAML' : 'Copy value'}>
                <IconButton size="small" aria-label={`Copy ${label}`} onClick={copyValue} sx={{ p: 0.25 }}>
                  <ContentCopyIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            )}
            {editable && container && (
              <Tooltip title={Array.isArray(shown) ? 'Add item' : 'Add field'}>
                <IconButton
                  size="small"
                  aria-label={`${Array.isArray(shown) ? 'Add item to' : 'Add field to'} ${label}`}
                  onClick={(e) => (Array.isArray(shown) ? addArrayItem() : setAddAnchor(e.currentTarget))}
                  sx={{ p: 0.25 }}
                >
                  <AddIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            {editable && ctx.onDelete && (
              <Tooltip title="Delete">
                <IconButton size="small" aria-label={`Delete ${label}`} onClick={() => ctx.onDelete?.(path)} sx={{ p: 0.25 }}>
                  <DeleteOutlinedIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            )}
            <IconButton size="small" aria-label={`More actions for ${label}`} onClick={(e) => setMenuAnchor(e.currentTarget)} sx={{ p: 0.25 }}>
              <MoreHorizIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Stack>
        </Box>
        {ctx.showDocs && description && (
          <Typography
            variant="caption"
            sx={{
              gridColumn: '2 / -1',
              mt: -0.25,
              mb: 0.25,
              pl: 1,
              maxWidth: '64ch',
              color: 'text.secondary',
              borderLeft: '2px solid',
              borderColor: 'divider',
              whiteSpace: 'pre-line',
              lineHeight: 1.5,
            }}
          >
            {normalizeDescription(description)}
          </Typography>
        )}
      </Box>
      <Menu open={!!menuAnchor} anchorEl={menuAnchor} onClose={() => setMenuAnchor(null)} onClick={stop} disableRestoreFocus>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            copyPath();
          }}
        >
          Copy path
        </MenuItem>
        {!removed && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              copyValue();
            }}
          >
            {container ? 'Copy as YAML' : 'Copy value'}
          </MenuItem>
        )}
        {editable && container && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              setYamlOpen(true);
            }}
          >
            Edit as YAML
          </MenuItem>
        )}
      </Menu>
      {addAnchor && (
        <AddFieldPopover
          anchor={addAnchor}
          schema={schema}
          definitions={ctx.definitions}
          existing={isPlainObject(shown) ? Object.keys(shown) : []}
          onClose={() => setAddAnchor(null)}
          onAdd={(key, childValue) => {
            setAddAnchor(null);
            addChild(key, childValue);
          }}
        />
      )}
      {yamlOpen && (
        <YamlSubtreeDialog
          label={displayPath(path)}
          value={shown}
          onClose={() => setYamlOpen(false)}
          onApply={(next) => {
            setYamlOpen(false);
            ctx.onEdit?.(path, next);
          }}
        />
      )}
      {container && expanded && (
        <Box className="kubus-tree-children" sx={{ '&::before': { left: `${depth * INDENT + 8}px` } }}>
          {childEntries(value, base, undefined, path).map((entry, i) => (
            <TreeRow
              key={entry.pointer}
              ctx={ctx}
              path={[...path, entry.segment]}
              pointer={entry.pointer}
              value={entry.value}
              base={entry.base}
              schema={schemaAt(schema, ctx.definitions, [entry.segment])}
              depth={depth + 1}
              first={i === 0}
              label={entry.label}
              indexLabel={entry.indexLabel}
            />
          ))}
        </Box>
      )}
    </>
  );
});

function isUnderMatch(pointer: string, filter: FilterResult): boolean {
  for (const match of filter.matches) if (pointer.startsWith(`${match}/`)) return true;
  return false;
}

/** Minimal schema guessed from a sibling value, so "Add item" on an unschema'd list gets the right shape. */
function inferSchema(sample: unknown): JsonSchema {
  if (Array.isArray(sample)) return { type: 'array' };
  if (isPlainObject(sample)) return { type: 'object' };
  if (typeof sample === 'number') return { type: 'number' };
  if (typeof sample === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

/** The quiet type label in the right column. */
function TypeChip({ label, title }: { label: string; title?: string }) {
  return (
    <Box
      component="span"
      title={title ?? label}
      sx={{
        fontFamily: MONO_FONT,
        fontSize: 11,
        lineHeight: '18px',
        px: 0.75,
        borderRadius: 0.75,
        color: 'text.secondary',
        bgcolor: 'action.hover',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
      }}
    >
      {label}
    </Box>
  );
}

/** Type label for a row without schema, from the value's shape. */
function valueTypeLabel(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function ChangePill({ kind }: { kind: ChangeKind }) {
  const color = kind === 'removed' ? 'error.main' : kind === 'added' ? 'success.main' : 'warning.main';
  return <CountPill value={kind} sx={{ color, bgcolor: (theme: Theme) => alpha(theme.palette[kind === 'removed' ? 'error' : kind === 'added' ? 'success' : 'warning'].main, 0.12), textTransform: 'none' }} />;
}

/** Href for values that are plain web links; other schemes stay inert. */
function safeHref(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function ScalarValue({
  value,
  label,
  refLink,
  onOpenRef,
  editable,
}: {
  value: unknown;
  label: string;
  refLink?: ResourceLink;
  onOpenRef?: (ref: ResourceLink) => void;
  editable: boolean;
}): ReactNode {
  const theme = useTheme();
  const colors = valuePalette(theme);
  const mono = { fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: '20px', wordBreak: 'break-word' as const, cursor: editable ? 'text' : undefined };
  if (value === null || value === undefined) {
    return (
      <Typography component="span" sx={{ ...mono, color: 'text.disabled', fontStyle: 'italic' }}>
        null
      </Typography>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <Typography component="span" sx={{ ...mono, color: colors.keyword, fontWeight: 600 }}>
        {String(value)}
      </Typography>
    );
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return (
      <Typography component="span" sx={{ ...mono, color: colors.number }}>
        {String(value)}
      </Typography>
    );
  }
  const text = scalarText(value);
  if (refLink && onOpenRef) {
    return (
      <Link
        component="button"
        underline="hover"
        title={`Open ${refLink.kind} ${refLink.name}`}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          onOpenRef(refLink);
        }}
        sx={{ ...mono, cursor: 'pointer', textAlign: 'left', verticalAlign: 'baseline', fontWeight: 500 }}
      >
        {text}
      </Link>
    );
  }
  if (ISO_TIMESTAMP_RE.test(text)) {
    return (
      <Typography component="span" variant="body2" sx={{ lineHeight: '20px' }}>
        <RelativeTimeCell timestamp={text} />{' '}
        <Typography component="span" variant="caption" color="text.secondary" sx={{ fontFamily: MONO_FONT }}>
          {text}
        </Typography>
      </Typography>
    );
  }
  if (statusLikeName(label) && text.length <= 40) return <StatusChip status={text} />;
  const href = safeHref(text);
  if (href) {
    return (
      <Link href={href} target="_blank" rel="noopener noreferrer" underline="hover" onClick={(e: MouseEvent) => e.stopPropagation()} sx={{ ...mono, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
        {text}
        <OpenInNewIcon sx={{ fontSize: 13 }} />
      </Link>
    );
  }
  if (text === '') {
    return (
      <Typography component="span" sx={{ ...mono, color: 'text.disabled' }}>
        ""
      </Typography>
    );
  }
  if (QUANTITY_RE.test(text)) {
    return (
      <Typography component="span" sx={{ ...mono, color: colors.number }}>
        {text}
      </Typography>
    );
  }
  if (text.includes('\n')) {
    // Scripts, certificates, embedded config: a code block instead of a run-on line.
    return (
      <Box sx={{ width: '100%', px: 1, py: 0.5, borderRadius: 1, bgcolor: 'action.hover' }}>
        <ClampedText text={text} lines={8} sx={{ ...mono, fontSize: 12, color: colors.string }} />
      </Box>
    );
  }
  if (text.length > 160) return <ClampedText text={text} lines={3} sx={{ ...mono, color: colors.string }} />;
  return (
    <Typography component="span" sx={{ ...mono, color: colors.string }}>
      {text}
    </Typography>
  );
}

const BOOLEAN_OPTIONS = ['true', 'false'];

function InlineEditor({ value, schema, onCommit, onCancel }: { value: unknown; schema?: JsonSchema; onCommit: (next: unknown) => void; onCancel: () => void }) {
  const kind: EditorKind = editorKindFor(schema, value);
  const initial = scalarText(value === null || value === undefined ? '' : value);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string>();
  const committed = useRef(false);

  const commit = (raw = text) => {
    if (committed.current) return;
    const parsed = parseScalarInput(raw, kind);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    committed.current = true;
    // Enum members keep their declared type: picking 1 commits the number 1.
    onCommit(kind === 'enum' ? enumValueFor(schema, raw) : parsed.value);
  };
  const cancel = () => {
    committed.current = true;
    onCancel();
  };

  const options = kind === 'enum' ? (schema?.enum ?? []).map((v) => String(v)) : kind === 'boolean' ? BOOLEAN_OPTIONS : undefined;
  const multiline = kind === 'string' && (initial.includes('\n') || initial.length > 80);
  return (
    <TextField
      autoFocus
      select={!!options}
      size="small"
      variant="outlined"
      value={text}
      error={!!error}
      helperText={error}
      multiline={multiline}
      minRows={multiline ? 2 : undefined}
      maxRows={12}
      fullWidth
      slotProps={{
        input: { sx: { fontFamily: MONO_FONT, fontSize: 12.5, py: 0 } },
        // Reaches the native input, and the Select's combobox through the input element.
        htmlInput: { 'aria-label': 'Value' },
        select: options ? { open: true, onClose: cancel } : undefined,
      }}
      onChange={(e) => {
        setError(undefined);
        setText(e.target.value);
        if (options) commit(e.target.value);
      }}
      onBlur={() => {
        if (!options) commit();
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        } else if (e.key === 'Enter' && !(multiline && e.shiftKey) && !options) {
          e.preventDefault();
          e.stopPropagation();
          commit();
        }
      }}
      sx={{ my: -0.5, '& .MuiInputBase-root': { minHeight: 30 } }}
    >
      {options?.map((option) => (
        <MenuItem key={option} value={option} sx={{ fontFamily: MONO_FONT, fontSize: 12.5 }}>
          {option}
        </MenuItem>
      ))}
    </TextField>
  );
}

/**
 * Field picker for "Add field": one panel with the search box and the
 * schema's remaining fields under it (required first, descriptions shown),
 * plus a row to add whatever was typed when the schema doesn't know it.
 * Enter adds the highlighted row; clicking a row adds it directly.
 */
export function AddFieldPopover({
  anchor,
  schema,
  definitions,
  existing,
  onClose,
  onAdd,
}: {
  anchor: HTMLElement;
  schema?: JsonSchema;
  definitions: SchemaDefinitions;
  existing: string[];
  onClose: () => void;
  onAdd: (key: string, value: unknown) => void;
}) {
  const suggestions = useMemo(() => suggestedKeys(schema, definitions, existing), [schema, definitions, existing]);
  const [input, setInput] = useState('');
  const [highlight, setHighlight] = useState(0);
  const key = input.trim();
  const needle = key.toLowerCase();
  const filtered = useMemo(() => suggestions.filter((suggestion) => !needle || suggestion.name.toLowerCase().includes(needle)), [suggestions, needle]);
  const exact = suggestions.some((suggestion) => suggestion.name === key);
  const duplicate = existing.includes(key);
  const customRow = !!key && !exact && !duplicate;
  const rowCount = filtered.length + (customRow ? 1 : 0);
  const additional = schema && typeof schema.additionalProperties === 'object' ? schemaAt(schema.additionalProperties, definitions, []) : undefined;

  const addSuggestion = (index: number) => {
    const suggestion = filtered[index];
    if (suggestion) onAdd(suggestion.name, emptyValueFor(suggestion.schema));
    else if (customRow) onAdd(key, emptyValueFor(additional));
  };

  return (
    <Popover
      open
      anchorEl={anchor}
      onClose={onClose}
      // The new row's inline editor takes focus as the popover closes;
      // restoring focus to the + button would blur it and commit early.
      disableRestoreFocus
      onClick={(e) => e.stopPropagation()}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 400, maxWidth: 'calc(100vw - 32px)', overflow: 'hidden' } } }}
    >
      <Box sx={{ p: 1.5, pb: 1 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          placeholder={suggestions.length ? 'Search fields or type a name' : 'Field name'}
          value={input}
          error={duplicate}
          helperText={duplicate ? 'This field already exists.' : undefined}
          onChange={(e) => {
            setInput(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((h) => Math.min(rowCount - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              addSuggestion(highlight);
            }
          }}
          slotProps={{ htmlInput: { 'aria-label': 'Field name', autoComplete: 'off' }, input: { sx: { fontSize: 13 } } }}
        />
      </Box>
      {rowCount > 0 ? (
        <List dense disablePadding aria-label="Fields" sx={{ maxHeight: 320, overflow: 'auto', borderTop: '1px solid', borderColor: 'divider' }}>
          {filtered.map((suggestion, index) => (
            <ListItemButton
              key={suggestion.name}
              selected={index === highlight}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => addSuggestion(index)}
              sx={{ display: 'block', py: 0.75 }}
            >
              <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                <Typography component="span" variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {suggestion.name}
                </Typography>
                <TypeChip label={compactType(displayType(suggestion.schema, definitions))} title={displayType(suggestion.schema, definitions)} />
                {suggestion.required && <CountPill value="required" sx={{ textTransform: 'none' }} />}
              </Stack>
              {suggestion.description && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', mt: 0.25, lineHeight: 1.45 }}
                >
                  {normalizeDescription(suggestion.description)}
                </Typography>
              )}
            </ListItemButton>
          ))}
          {customRow && (
            <ListItemButton
              selected={highlight === filtered.length}
              onMouseEnter={() => setHighlight(filtered.length)}
              onClick={() => addSuggestion(filtered.length)}
              sx={{ display: 'block', py: 0.75, borderTop: filtered.length ? '1px solid' : 0, borderColor: 'divider' }}
            >
              <Typography component="span" variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                Add “{key}”
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {suggestions.length ? 'Not in the schema; added as a plain field.' : 'Added as a plain field.'}
              </Typography>
            </ListItemButton>
          )}
        </List>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, pb: 1.5 }}>
          {duplicate ? 'Pick another name.' : 'Type a field name.'}
        </Typography>
      )}
    </Popover>
  );
}

function YamlSubtreeDialog({ label, value, onClose, onApply }: { label: string; value: unknown; onClose: () => void; onApply: (next: unknown) => void }) {
  const [text, setText] = useState(() => dumpManifest(value));
  const [error, setError] = useState<string>();
  const apply = () => {
    const parsed = parseScalarInput(text, 'yaml');
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    onApply(parsed.value);
  };
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth onClick={(e) => e.stopPropagation()}>
      <DialogTitle sx={{ fontFamily: MONO_FONT, fontSize: 14 }}>{label}</DialogTitle>
      <DialogContent dividers>
        <TextField
          autoFocus
          multiline
          fullWidth
          minRows={8}
          maxRows={24}
          value={text}
          error={!!error}
          helperText={error ?? 'Replace this subtree with the YAML below.'}
          onChange={(e) => {
            setError(undefined);
            setText(e.target.value);
          }}
          slotProps={{ input: { sx: { fontFamily: MONO_FONT, fontSize: 12.5 } }, htmlInput: { 'aria-label': 'Subtree YAML' } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={apply}>
          Replace
        </Button>
      </DialogActions>
    </Dialog>
  );
}
