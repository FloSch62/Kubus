import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DifferenceOutlinedIcon from '@mui/icons-material/DifferenceOutlined';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { dump as dumpYaml } from 'js-yaml';
import { groupToPath, gvkForResource, type KubeObject, type ResourceKindInfo, type ResourceNamesResponse } from '@kubus/shared';
import { apiFetch } from '../api/http.js';
import { isResourceGone, resourceUrl, useApiResources, useContexts, useNamespaces } from '../api/queries.js';
import { DiffViewer } from '../components/DiffViewer.js';
import { PageHeader } from '../components/PageHeader.js';
import { usePaneActive } from '../layout/pane-context.js';
import { kindListPath } from '../resource-links.js';
import { useClustersStore } from '../state/clusters.js';
import { useTabsStore } from '../state/tabs.js';
import { statusTextColor } from '../theme.js';
import {
  defaultRightSide,
  diffSearchParams,
  diffView,
  readDiffState,
  sideComplete,
  sideLabel,
  type DiffOptions,
  type DiffSide,
  type DiffState,
} from '../diff-state.js';

interface SideKind {
  kind: string;
  namespaced: boolean;
}

/** Kind name and scope for a side: discovery first, the builtin table while it loads. */
function useSideKind(side: DiffSide): { info?: SideKind; kinds?: ResourceKindInfo[]; unserved: boolean } {
  const { data: kinds } = useApiResources(side.ctx);
  if (!side.plural) return { kinds, unserved: false };
  const found = kinds?.find((k) => k.group === (side.group ?? '') && k.version === side.version && k.plural === side.plural);
  const builtin = gvkForResource(side.group ?? '', side.version ?? '', side.plural);
  const info = found ?? builtin;
  return { info: info && { kind: info.kind, namespaced: info.namespaced }, kinds, unserved: !!kinds && !found };
}

function isSecretSide(side: DiffSide): boolean {
  return !side.group && side.plural === 'secrets';
}

function useSideObject(side: DiffSide, namespaced: boolean | undefined) {
  const enabled = sideComplete(side, namespaced);
  return useQuery({
    queryKey: ['diff-object', side.ctx, side.group, side.version, side.plural, side.namespace, side.name],
    // Secrets come back as keyed fingerprints: a changed value shows as a
    // changed line without either value reaching the page.
    queryFn: () =>
      apiFetch<KubeObject>(
        resourceUrl(side.ctx!, side.group ?? '', side.version!, side.plural!, side.name!, side.namespace, isSecretSide(side) ? { reveal: 'digest' } : undefined),
      ),
    enabled,
    // A missing object is an answer, not a hiccup worth retrying.
    retry: (count, error) => !isResourceGone(error) && count < 1,
  });
}

/** Identity of the name list a side's picker would show. */
function namesKey(side: DiffSide, namespaced: boolean | undefined): string | undefined {
  if (!side.ctx || !side.plural || namespaced === undefined || (namespaced && !side.namespace)) return undefined;
  return [side.ctx, side.group ?? '', side.version, side.plural, namespaced ? side.namespace : ''].join('|');
}

/**
 * Names for a side's picker, fetched only once the picker is opened: a
 * compare usually arrives with both sides filled in, and the names are only
 * for choosing another object. The server sends names alone, never objects.
 */
function useNames(side: DiffSide, namespaced: boolean | undefined, wanted: boolean) {
  return useQuery({
    queryKey: ['diff-names', side.ctx, side.group, side.version, side.plural, namespaced ? side.namespace : undefined],
    queryFn: () => {
      const params = namespaced && side.namespace ? `?namespace=${encodeURIComponent(side.namespace)}` : '';
      return apiFetch<ResourceNamesResponse>(`/api/contexts/${encodeURIComponent(side.ctx!)}/resource-names/${groupToPath(side.group ?? '')}/${side.version}/${side.plural}${params}`);
    },
    enabled: wanted && namesKey(side, namespaced) !== undefined,
    staleTime: 30_000,
  });
}

function toYaml(obj: KubeObject | undefined, options: DiffOptions): string {
  if (!obj) return '';
  return dumpYaml(diffView(obj, options), { noRefs: true, sortKeys: true, lineWidth: 120 });
}

export function DiffPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => readDiffState(searchParams), [searchParams]);
  const { left, right, options } = state;
  const update = useCallback(
    (patch: Partial<DiffState>) => {
      setSearchParams(diffSearchParams({ ...state, ...patch, options: { ...state.options, ...patch.options } }), { replace: true });
    },
    [state, setSearchParams],
  );

  const leftKind = useSideKind(left);
  const rightKind = useSideKind(right);
  const leftObj = useSideObject(left, leftKind.info?.namespaced);
  const rightObj = useSideObject(right, rightKind.info?.namespaced);
  const leftText = useMemo(() => toYaml(leftObj.data, options), [leftObj.data, options]);
  const rightText = useMemo(() => toYaml(rightObj.data, options), [rightObj.data, options]);
  const [changes, setChanges] = useState<number>();

  // "Compare with…" opens with only the left side: propose the same object
  // in another cluster, once, and write it into the URL like any pick.
  const { data: contexts } = useContexts({ poll: false });
  const selectedClusters = useClustersStore((s) => s.selected);
  const proposed = useRef(false);
  useEffect(() => {
    if (proposed.current || !contexts) return;
    proposed.current = true;
    if (!left.ctx || right.ctx) return;
    update({ right: defaultRightSide(left, { selected: selectedClusters, active: contexts.filter((c) => c.active).map((c) => c.name) }) });
  }, [contexts, left, right.ctx, selectedClusters, update]);

  // Then hand the right side's name picker to the user whenever the
  // proposal cannot stand: no name to reuse, or no such object there.
  const paneActive = usePaneActive();
  const rightNameRef = useRef<HTMLInputElement>(null);
  const leftReady = sideComplete(left, leftKind.info?.namespaced);
  const rightMissing = isResourceGone(rightObj.error);
  const needsRightPick = leftReady && !!right.ctx && !!right.plural && (!right.name || rightMissing);
  const focused = useRef(false);
  useEffect(() => {
    if (!needsRightPick || !paneActive || focused.current) return;
    focused.current = true;
    rightNameRef.current?.focus();
  }, [needsRightPick, paneActive]);

  const ready = !!leftText && !!rightText;
  const identical = ready && leftText === rightText;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5 }}>
      <PageHeader title="Resource Diff" icon={<DifferenceOutlinedIcon />}>
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={options.specOnly ? 'spec' : 'all'}
            onChange={(_e, next: string | null) => next && update({ options: { ...options, specOnly: next === 'spec' } })}
            aria-label="Compare scope"
            sx={{ '& .MuiToggleButton-root': { px: 1.25, py: 0.25, textTransform: 'none', fontSize: 12.5, lineHeight: 1.7 } }}
          >
            <ToggleButton value="all">Whole object</ToggleButton>
            <ToggleButton value="spec">Spec/data only</ToggleButton>
          </ToggleButtonGroup>
          <Tooltip describeChild title={options.specOnly ? 'Spec/data only already leaves out metadata and status.' : ''}>
            <FormControlLabel
              disabled={options.specOnly}
              control={<Switch size="small" checked={options.normalize || options.specOnly} onChange={(e) => update({ options: { ...options, normalize: e.target.checked } })} />}
              label={<Typography variant="body2">Ignore status & server-set metadata</Typography>}
            />
          </Tooltip>
          <FormControlLabel
            control={<Switch size="small" checked={options.onlyChanges} onChange={(e) => update({ options: { ...options, onlyChanges: e.target.checked } })} />}
            label={<Typography variant="body2">Only changes</Typography>}
          />
          <Tooltip title="Swap sides">
            <span>
              <IconButton size="small" aria-label="Swap sides" disabled={!left.ctx && !right.ctx} onClick={() => update({ left: right, right: left })}>
                <SwapHorizIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </PageHeader>
      <Grid container spacing={2} sx={{ mb: 1 }}>
        <Grid size={6}>
          <SidePicker label="Left" side={left} onChange={(next) => update({ left: next })} missing={isResourceGone(leftObj.error)} />
        </Grid>
        <Grid size={6}>
          <SidePicker label="Right" side={right} onChange={(next) => update({ right: next })} missing={rightMissing} nameInputRef={rightNameRef} />
        </Grid>
      </Grid>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', border: 1, borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden' }}>
        {(left.ctx || right.ctx) && (
          <Grid container sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover', flexShrink: 0 }}>
            <Grid size={6} sx={{ px: 1.5, py: 0.75, minWidth: 0, borderRight: 1, borderColor: 'divider' }}>
              <SideTitle side={left} kind={leftKind.info} query={leftObj} />
            </Grid>
            <Grid size={6} sx={{ px: 1.5, py: 0.75, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 1 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <SideTitle side={right} kind={rightKind.info} query={rightObj} />
              </Box>
              {ready && (
                <Typography variant="caption" sx={{ flexShrink: 0, fontWeight: 600, color: identical ? statusTextColor('success') : 'text.secondary' }}>
                  {identical ? 'Identical' : changes === undefined ? '' : `${changes} ${changes === 1 ? 'change' : 'changes'}`}
                </Typography>
              )}
            </Grid>
          </Grid>
        )}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          {ready ? (
            // A new pair or scope starts a fresh editor: Monaco carries the
            // expanded/collapsed state of unchanged regions across content
            // swaps, which leaves "Only changes" half applied.
            <DiffViewer
              key={`${searchParams.get('left')}|${searchParams.get('right')}|${options.specOnly}|${options.normalize}`}
              left={leftText}
              right={rightText}
              hideUnchanged={options.onlyChanges}
              onChangeCount={setChanges}
            />
          ) : (
            <EmptyState left={left} right={right} leftKind={leftKind} rightKind={rightKind} leftObj={leftObj} rightObj={rightObj} />
          )}
        </Box>
      </Box>
    </Box>
  );
}

type SideQuery = ReturnType<typeof useSideObject>;

/** "kind-kubus-a · Deployment gap-ns/web" linking back to the object, plus its fetch state. */
function SideTitle({ side, kind, query }: { side: DiffSide; kind?: SideKind; query: SideQuery }) {
  const navigate = useNavigate();
  const openTab = useTabsStore((s) => s.openTab);
  if (!side.ctx) {
    return (
      <Typography variant="body2" color="text.disabled">
        Nothing picked
      </Typography>
    );
  }
  const label = sideLabel(side, kind?.kind);
  const found = !!query.data;
  const path =
    side.plural && side.version && side.name
      ? kindListPath({ group: side.group ?? '', version: side.version, plural: side.plural }, { sel: { ctx: side.ctx, namespace: side.namespace, name: side.name } })
      : undefined;
  return (
    <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1, minWidth: 0 }}>
      {found && path ? (
        <Link
          component="button"
          variant="body2"
          underline="hover"
          title={`Open ${label}`}
          // Like nav links: Ctrl/Cmd+click or middle-click keeps the compare
          // open and shows the object in a new tab.
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey) openTab(path, { afterActive: true, activate: e.shiftKey });
            else void navigate(path);
          }}
          onAuxClick={(e) => {
            if (e.button === 1) openTab(path, { afterActive: true, activate: false });
          }}
          sx={{ fontWeight: 600, textAlign: 'left', overflowWrap: 'anywhere', minWidth: 0 }}
        >
          {label}
        </Link>
      ) : (
        <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>
          {label}
        </Typography>
      )}
      {query.isFetching && !found && <CircularProgress size={12} sx={{ flexShrink: 0, alignSelf: 'center' }} />}
      {isResourceGone(query.error) && (
        <Typography variant="caption" sx={{ flexShrink: 0, fontWeight: 600, color: statusTextColor('warning') }}>
          not found
        </Typography>
      )}
    </Stack>
  );
}

function EmptyState({
  left,
  right,
  leftKind,
  rightKind,
  leftObj,
  rightObj,
}: {
  left: DiffSide;
  right: DiffSide;
  leftKind: ReturnType<typeof useSideKind>;
  rightKind: ReturnType<typeof useSideKind>;
  leftObj: SideQuery;
  rightObj: SideQuery;
}) {
  const problems: Array<{ severity: 'warning' | 'error'; text: string }> = [];
  for (const [label, side, kind, query] of [
    ['left', left, leftKind, leftObj],
    ['right', right, rightKind, rightObj],
  ] as const) {
    if (side.ctx && side.plural && kind.unserved) {
      problems.push({ severity: 'warning', text: `${side.ctx} does not serve ${kind.info?.kind ?? side.plural}. Pick another cluster or kind on the ${label}.` });
    } else if (isResourceGone(query.error)) {
      problems.push({ severity: 'warning', text: `${sideLabel(side, kind.info?.kind)} does not exist. Pick another object on the ${label}.` });
    } else if (query.error) {
      problems.push({ severity: 'error', text: `${sideLabel(side, kind.info?.kind)}: ${query.error.message}` });
    }
  }
  const loading = leftObj.isFetching || rightObj.isFetching;
  const leftReady = sideComplete(left, leftKind.info?.namespaced);
  const hint = !left.ctx && !right.ctx
    ? 'Pick a resource on each side to compare, for example the same ConfigMap in two clusters. You can also start from any list: Compare with… in a row menu, or check two rows and press Compare 2.'
    : leftReady && !sideComplete(right, rightKind.info?.namespaced)
      ? `Pick what to compare ${sideLabel(left, leftKind.info?.kind)} with on the right.`
      : 'Pick the object on each side.';
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1.5, px: 3 }}>
      {problems.map((p) => (
        <Alert key={p.text} severity={p.severity} sx={{ maxWidth: 720 }}>
          {p.text}
        </Alert>
      ))}
      {loading && !problems.length ? (
        <CircularProgress size={24} />
      ) : (
        !problems.length && (
          <Typography color="text.secondary" sx={{ maxWidth: 640, textAlign: 'center' }}>
            {hint}
          </Typography>
        )
      )}
    </Box>
  );
}

function SidePicker({
  label,
  side,
  onChange,
  missing,
  nameInputRef,
}: {
  label: string;
  side: DiffSide;
  onChange: (s: DiffSide) => void;
  /** The picked object does not exist (its GET answered 404). */
  missing?: boolean;
  nameInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const { data: contexts } = useContexts({ poll: false });
  const activeContexts = (contexts ?? []).filter((c) => c.active).map((c) => c.name);
  const { info, kinds, unserved } = useSideKind(side);
  const { data: namespaces } = useNamespaces(side.ctx ? [side.ctx] : []);
  // The list the user last opened the picker for; another cluster, kind or
  // namespace waits for its own open.
  const listKey = namesKey(side, info?.namespaced);
  const [wantedKey, setWantedKey] = useState<string>();
  const namesQuery = useNames(side, info?.namespaced, !!listKey && wantedKey === listKey);
  const names = namesQuery.data?.names;

  const listableKinds = useMemo(() => (kinds ?? []).filter((k) => k.verbs.includes('get')).sort((a, b) => a.kind.localeCompare(b.kind) || a.group.localeCompare(b.group)), [kinds]);
  const kindValue = listableKinds.find((k) => k.group === (side.group ?? '') && k.version === side.version && k.plural === side.plural) ?? null;
  const contextOptions = side.ctx && !activeContexts.includes(side.ctx) ? [...activeContexts, side.ctx] : activeContexts;
  const namespaceOptions = side.namespace && !(namespaces ?? []).includes(side.namespace) ? [...(namespaces ?? []), side.namespace] : (namespaces ?? []);
  // A name carried over from the other side may not exist here; keep it
  // selectable so the picker shows what was asked for.
  const nameOptions = side.name && !(names ?? []).includes(side.name) ? [...(names ?? []), side.name] : (names ?? []);
  const namespaced = info?.namespaced ?? !!side.namespace;

  return (
    // Flexible widths + wrapping: once the namespace picker appears, four
    // fixed-width controls per side would ellipsize every selected value.
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Autocomplete
        size="small"
        sx={{ flex: '1 1 150px', minWidth: 150 }}
        options={contextOptions}
        value={side.ctx ?? null}
        // Switching clusters keeps the kind and object, so flipping between
        // clusters compares the same thing.
        onChange={(_e, ctx) => onChange(ctx ? { ...side, ctx } : {})}
        renderInput={(p) => <TextField {...p} label={`${label} cluster`} />}
      />
      <Autocomplete
        size="small"
        sx={{ flex: '1 1 170px', minWidth: 170 }}
        options={listableKinds}
        getOptionLabel={(k) => (k.group ? `${k.kind} (${k.group})` : k.kind)}
        value={kindValue}
        isOptionEqualToValue={(a, b) => a.group === b.group && a.version === b.version && a.plural === b.plural}
        onChange={(_e, kind) =>
          onChange(
            kind
              ? { ctx: side.ctx, group: kind.group, version: kind.version, plural: kind.plural, namespace: kind.namespaced ? side.namespace : undefined }
              : { ctx: side.ctx },
          )
        }
        renderInput={(p) => (
          <TextField
            {...p}
            label="Kind"
            error={unserved}
            helperText={unserved ? `Not served here: ${info?.kind ?? side.plural}` : undefined}
          />
        )}
        disabled={!side.ctx}
      />
      {namespaced && (
        <Autocomplete
          size="small"
          sx={{ flex: '1 1 150px', minWidth: 150 }}
          options={namespaceOptions}
          value={side.namespace ?? null}
          onChange={(_e, namespace) => onChange({ ...side, namespace: namespace ?? undefined, name: undefined })}
          renderInput={(p) => <TextField {...p} label="Namespace" />}
        />
      )}
      <Autocomplete
        size="small"
        sx={{ flex: '2 1 180px', minWidth: 180 }}
        options={nameOptions}
        value={side.name ?? null}
        openOnFocus
        onOpen={() => setWantedKey(listKey)}
        loading={namesQuery.isFetching && !names}
        loadingText="Loading names…"
        onChange={(_e, name) => onChange({ ...side, name: name ?? undefined })}
        renderOption={({ key, ...props }, option) => (
          <li key={key} {...props}>
            {option}
            {missing && option === side.name && (
              <>
                {' '}
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  not found here
                </Typography>
              </>
            )}
          </li>
        )}
        renderInput={(p) => (
          <TextField
            {...p}
            label="Name"
            inputRef={nameInputRef}
            helperText={namesQuery.data?.truncated ? `Showing the first ${names?.length ?? 0} names` : undefined}
          />
        )}
        disabled={!side.plural || (namespaced && !side.namespace)}
      />
    </Stack>
  );
}
