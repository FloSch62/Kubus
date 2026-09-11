import { memo, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { GridRowCheckbox } from './GridRowCheckbox.js';
import { useForkRef } from '@mui/material/utils';
import { useGridApiContext, useGridSelector, gridFocusCellSelector, gridTabIndexCellSelector, type GridCellProps, type GridValidRowModel, type GridTreeNodeWithRender } from '@mui/x-data-grid';

function focusState(api: ReturnType<typeof useGridApiContext>, { id, field }: { id: GridCellProps['rowId']; field: string }) {
  const focus = gridFocusCellSelector(api);
  const tab = gridTabIndexCellSelector(api);
  return (focus?.id === id && focus.field === field ? 1 : 0) | (tab?.id === id && tab.field === field ? 2 : 0);
}

/** Resource tables edit in the detail panel. Their read-only cells need one
 * focus subscription, rather than per-cell editing, aggregation, row spanning,
 * range selection and pinned-column subscriptions. The grid still owns row
 * virtualization, selection, sorting, sizing and keyboard navigation. */
export const ResourceGridCell = memo(function ResourceGridCell(props: GridCellProps & { ref?: React.Ref<HTMLDivElement> }) {
  const { column, rowId, colIndex, width, align, className, style, colSpan, isNotVisible, showLeftBorder, showRightBorder } = props;
  const api = useGridApiContext();
  const focus = useGridSelector(api, focusState, { id: rowId, field: column.field });
  const element = useRef<HTMLDivElement>(null);
  const ref = useForkRef(element, props.ref);
  const hasFocus = !!(focus & 1);
  const tabIndex: -1 | 0 = focus & 2 ? 0 : -1;
  const params = { ...api.current.getCellParams<GridValidRowModel, unknown, unknown, GridTreeNodeWithRender>(rowId, column.field), hasFocus, tabIndex, api: api.current };
  const formattedValue = params.formattedValue ?? params.value;
  const customClass = typeof column.cellClassName === 'function' ? column.cellClassName(params) : column.cellClassName;
  useLayoutEffect(() => {
    const cell = element.current;
    if (hasFocus && cell && !cell.contains(document.activeElement)) {
      (cell.querySelector<HTMLElement>('[tabindex="0"]') ?? cell).focus({ preventScroll: true });
    }
  }, [hasFocus]);
  const publish = (name: 'cellClick' | 'cellDoubleClick' | 'cellMouseOver' | 'cellMouseDown' | 'cellMouseUp', event: MouseEvent<HTMLDivElement>) => {
    if (api.current.getRow(rowId)) api.current.publishEvent(name, api.current.getCellParams(rowId, column.field), event);
  };
  const publishKey = (name: 'cellKeyDown' | 'cellKeyUp', event: KeyboardEvent<HTMLDivElement>) => {
    if (api.current.getRow(rowId)) api.current.publishEvent(name, api.current.getCellParams(rowId, column.field), event);
  };
  const content = column.renderCell?.(params);
  const text = formattedValue?.toString();
  // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- both dynamic roles below are interactive grid cells
  return <div
    ref={ref}
    className={[
      'MuiDataGrid-cell', `MuiDataGrid-cell--text${align[0]!.toUpperCase()}${align.slice(1)}`,
      column.display === 'flex' && 'MuiDataGrid-cell--flex',
      showLeftBorder && 'MuiDataGrid-cell--withLeftBorder', showRightBorder && 'MuiDataGrid-cell--withRightBorder',
      customClass, className,
    ].filter(Boolean).join(' ')}
    role={column.rowHeader ? 'rowheader' : 'gridcell'}
    data-field={column.field}
    data-colindex={colIndex}
    aria-colindex={colIndex + 1}
    aria-colspan={colSpan}
    style={isNotVisible ? { padding: 0, opacity: 0, width: 0, height: 0, border: 0 } : { '--width': `${width}px`, ...style } as CSSProperties}
    title={content === undefined ? text : undefined}
    tabIndex={column.type === 'actions' ? -1 : tabIndex}
    onClick={event => { publish('cellClick', event); props.onClick?.(event); }}
    onDoubleClick={event => { publish('cellDoubleClick', event); props.onDoubleClick?.(event); }}
    onMouseOver={event => { publish('cellMouseOver', event); props.onMouseOver?.(event); }}
    onMouseDown={event => { publish('cellMouseDown', event); props.onMouseDown?.(event); }}
    onMouseUp={event => { publish('cellMouseUp', event); props.onMouseUp?.(event); }}
    onKeyDown={event => { publishKey('cellKeyDown', event); props.onKeyDown?.(event); }}
    onKeyUp={event => { publishKey('cellKeyUp', event); props.onKeyUp?.(event); }}
    onFocus={props.onFocus}
    onMouseEnter={props.onMouseEnter}
    onMouseLeave={props.onMouseLeave}
  >{content === undefined ? text : content}</div>;
});

export const READ_ONLY_GRID_SLOTS = { cell: ResourceGridCell, rowCheckbox: GridRowCheckbox };
