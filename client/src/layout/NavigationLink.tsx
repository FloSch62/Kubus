import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { NavLink, useLinkClickHandler } from 'react-router';

type NavigationLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  to: string;
  state?: unknown;
};

/** Windows WebView2 previews hrefs in a native status bar Electrobun cannot disable. */
export const NavigationLink = forwardRef<HTMLAnchorElement, NavigationLinkProps>(function NavigationLink(
  { to, state, onClick, onKeyDown, children, ...props },
  ref,
) {
  const navigate = useLinkClickHandler<HTMLAnchorElement>(to, { state });
  if (window.kubusDesktop?.platform !== 'win32') {
    return <NavLink {...props} ref={ref} to={to} state={state} onClick={onClick} onKeyDown={onKeyDown}>{children}</NavLink>;
  }
  // Keep focus and link semantics, with routing and tab modifiers handled in-app.
  return (
    <a
      {...props}
      href={undefined}
      ref={ref}
      // An anchor without href needs an explicit role to remain an accessible link.
      // oxlint-disable-next-line jsx-a11y/no-redundant-roles
      role="link"
      tabIndex={0}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) navigate(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Enter' && !event.defaultPrevented) {
          event.preventDefault();
          event.currentTarget.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
            ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
          }));
        }
      }}
    >
      {children}
    </a>
  );
});
