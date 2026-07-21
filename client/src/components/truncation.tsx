import { cloneElement, useState, type MouseEvent, type ReactElement } from 'react';
import Tooltip from '@mui/material/Tooltip';

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
