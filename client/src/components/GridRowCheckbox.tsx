import { useLayoutEffect, useRef } from 'react';
import { useForkRef } from '@mui/material/utils';
import { useGridRootProps, type GridRowCheckboxProps } from '@mui/x-data-grid';

/** Native input semantics with the table's styling. A recycled row doesn't
 * need Material's ButtonBase, ripple controller and SVG icon component tree. */
export function GridRowCheckbox({ ref, rowId, checked, indeterminate, disabled, tabIndex, inputRef, slotProps, onChange, onClick, onMouseDown, onKeyDown, className, style }: GridRowCheckboxProps) {
  // The controlled model is the source of truth. MUI copies it into its
  // selection store in a passive effect; reading that older copy can make
  // React restore an unchecked input after the user's click.
  const { rowSelectionModel: model, rowSelection } = useGridRootProps();
  const isChecked = model && rowSelection !== false ? (model.type === 'include') === model.ids.has(rowId) && !indeterminate : checked;
  const localRef = useRef<HTMLInputElement>(null);
  const handleRef = useForkRef(localRef, inputRef, slotProps?.htmlInput?.ref);
  useLayoutEffect(() => {
    if (localRef.current) localRef.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <span ref={ref} className={className} style={style}>
      <input {...slotProps?.htmlInput} ref={handleRef} className="kubus-grid-checkbox" type="checkbox" checked={isChecked} disabled={disabled} tabIndex={tabIndex} onClick={onClick} onMouseDown={onMouseDown} onKeyDown={onKeyDown} onChange={onChange} />
    </span>
  );
}
