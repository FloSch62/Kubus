import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import Tooltip, { type TooltipProps } from '@mui/material/Tooltip';

type Entry = { element: HTMLElement; props: TooltipProps };
type Registry = {
  entries: WeakMap<HTMLElement, () => TooltipProps>;
  refresh: (element: HTMLElement, props: TooltipProps) => void;
  detach: (element: HTMLElement) => void;
};
const RegistryContext = createContext<Registry | null>(null);

/** A table owns one tooltip. Recycling rows only mounts the content and a
 * registration span, not hundreds of Tooltip/Popper hooks and effects. Outside
 * a table the same cell keeps the ordinary Material tooltip. */
export function CellTooltip(props: TooltipProps) {
  const registry = useContext(RegistryContext);
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const register = useCallback((element: HTMLSpanElement | null) => {
    elementRef.current = element;
    if (!element || !registry) return;
    registry.entries.set(element, () => propsRef.current);
    return () => { registry.entries.delete(element); registry.detach(element); };
  }, [registry]);
  useLayoutEffect(() => {
    if (elementRef.current) registry?.refresh(elementRef.current, props);
  }, [registry, props]);
  if (!registry) return <Tooltip {...props} />;
  return <span ref={register} data-kubus-tooltip="" style={{ display: 'contents' }}>{props.children}</span>;
}

export function GridTooltips({ rootRef, children }: { rootRef: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [active, setActive] = useState<Entry | null>(null);
  const activeRef = useRef<Entry | null>(null);
  activeRef.current = active;
  const tooltipId = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const current = useRef<HTMLElement | null>(null);
  const cancelTimer = useCallback(() => clearTimeout(dismissTimer.current), []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    clearTimeout(dismissTimer.current);
    current.current = null;
    activeRef.current = null;
    setActive(null);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(dismissTimer.current);
    if (!activeRef.current) { hide(); return; }
    dismissTimer.current = setTimeout(hide, 100);
  }, [hide]);
  const registry = useMemo<Registry>(() => ({
    entries: new WeakMap(),
    refresh: (element, props) => {
      if (activeRef.current?.element === element && activeRef.current.props !== props) setActive({ element, props });
    },
    detach: element => { if (current.current === element) hide(); },
  }), [hide]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let scrollTimer: ReturnType<typeof setTimeout>;
    const scroll = () => {
      hide();
      root.classList.add('kubus-scrolling');
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => root.classList.remove('kubus-scrolling'), 120);
    };
    const show = (event: Event) => {
      if (event.type === 'pointerover' && root.classList.contains('kubus-scrolling')) return;
      const target = event.target instanceof Element ? event.target : null;
      const element = target?.closest<HTMLElement>('[data-kubus-tooltip]');
      if (!element || !root.contains(element)) { leave(); return; }
      const props = registry.entries.get(element)?.();
      if (!props?.title || props.disableHoverListener && event.type === 'pointerover' || props.disableFocusListener && event.type === 'focusin') { hide(); return; }
      if (current.current === element) { cancelTimer(); return; }
      hide();
      current.current = element;
      timer.current = setTimeout(() => {
        if (element.isConnected) setActive({ element, props: registry.entries.get(element)?.() ?? props });
      }, event.type === 'focusin' ? 0 : props.enterDelay ?? 300);
    };
    root.addEventListener('pointerover', show);
    root.addEventListener('pointerleave', leave);
    root.addEventListener('wheel', scroll, { passive: true });
    root.addEventListener('focusin', show);
    root.addEventListener('focusout', leave);
    root.addEventListener('scroll', scroll, { capture: true, passive: true });
    return () => {
      clearTimeout(timer.current);
      clearTimeout(dismissTimer.current);
      clearTimeout(scrollTimer);
      root.classList.remove('kubus-scrolling');
      root.removeEventListener('pointerover', show);
      root.removeEventListener('pointerleave', leave);
      root.removeEventListener('wheel', scroll);
      root.removeEventListener('focusin', show);
      root.removeEventListener('focusout', leave);
      root.removeEventListener('scroll', scroll, true);
    };
  }, [rootRef, registry, hide, leave, cancelTimer]);
  const anchor = active?.element.firstElementChild ?? active?.element;
  useEffect(() => {
    if (!anchor) return;
    const previous = anchor.getAttribute('aria-describedby');
    anchor.setAttribute('aria-describedby', [previous, tooltipId].filter(Boolean).join(' '));
    return () => { if (previous === null) anchor.removeAttribute('aria-describedby'); else anchor.setAttribute('aria-describedby', previous); };
  }, [anchor, tooltipId]);
  return (
    <RegistryContext value={registry}>
      {children}
      {active && anchor?.isConnected && <Tooltip
        {...active.props}
        open
        id={tooltipId}
        disableFocusListener
        disableHoverListener
        disableTouchListener
        onClose={hide}
        slotProps={{
          ...active.props.slotProps,
          popper: { anchorEl: anchor, onPointerEnter: cancelTimer, onPointerLeave: leave },
        }}
      ><span /></Tooltip>}
    </RegistryContext>
  );
}
