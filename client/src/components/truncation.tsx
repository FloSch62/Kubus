import { cloneElement, memo, useState, type CSSProperties, type MouseEvent, type ReactElement } from 'react';
import Tooltip from '@mui/material/Tooltip';

/**
 * How much of a name's end survives truncation: the last dash-separated part
 * when it is short (a pod's random suffix, `-2gvhg`), otherwise six
 * characters. Short names keep everything.
 */
export function middleEllipsisTail(text: string): number {
  if (text.length <= 12) return 0;
  const dash = text.lastIndexOf('-');
  const part = dash > 0 ? text.length - dash : 0;
  return part >= 3 && part <= 9 ? part : 6;
}

const MIDDLE_ROOT: CSSProperties = { display: 'flex', minWidth: 0, flex: 1, whiteSpace: 'nowrap' };
const MIDDLE_HEAD: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };
const MIDDLE_TAIL: CSSProperties = { flexShrink: 0 };

/**
 * One-line text that, when it doesn't fit, gives up its middle instead of its
 * end: `broken-deploy-6c5…-2gvhg`. The end of a generated name (a pod's
 * suffix) is what tells siblings apart, so it stays visible. Plain CSS: the
 * head ellipsizes, the tail never shrinks. The full text is the title.
 */
export const MiddleEllipsis = memo(function MiddleEllipsis({ text }: { text: string }) {
  const tail = middleEllipsisTail(text);
  if (!tail) return <span style={{ ...MIDDLE_HEAD, whiteSpace: 'nowrap' }} title={text}>{text}</span>;
  return (
    <span style={MIDDLE_ROOT} title={text}>
      <span style={MIDDLE_HEAD}>{text.slice(0, text.length - tail)}</span>
      <span style={MIDDLE_TAIL}>{text.slice(text.length - tail)}</span>
    </span>
  );
});

/**
 * Themed tooltip that reveals the full text of an ellipsized child — but only
 * when the child is actually truncated, measured at hover time so it stays
 * correct across resizes. `disableInteractive` keeps the tooltip purely
 * visual: it can never sit under the cursor or swallow clicks.
 */
export function TruncationTooltip({
  text,
  measureSelector,
  always = false,
  children,
}: {
  text: string;
  /** Descendant that actually ellipsizes, when the hover target is a wrapper. */
  measureSelector?: string;
  /** Show regardless of truncation — for tooltips that carry more than the
   *  visible label (e.g. a subgroup's full API group). */
  always?: boolean;
  children: ReactElement<{ onMouseEnter?: (event: MouseEvent<HTMLElement>) => void }>;
}) {
  const [truncated, setTruncated] = useState(false);
  return (
    <Tooltip
      title={always || truncated ? text : ''}
      placement="bottom-start"
      enterDelay={300}
      enterNextDelay={150}
      disableInteractive
    >
      {cloneElement(children, {
        onMouseEnter: (event: MouseEvent<HTMLElement>) => {
          const root = event.currentTarget;
          const el = (measureSelector ? root.querySelector(measureSelector) : root) ?? root;
          setTruncated(el.scrollWidth > el.clientWidth);
          children.props.onMouseEnter?.(event);
        },
      })}
    </Tooltip>
  );
}
