import { createContext, useContext, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  markdown: string;
  /** Chart source repository used to make relative README links useful. */
  sourceUrl?: string;
}

function isAbsoluteUrl(value: string): boolean {
  return /^(?:https?:|mailto:)/i.test(value);
}

function resolveRelative(value: string | undefined, sourceUrl: string | undefined, raw = false): string | undefined {
  if (!value || value.startsWith('#') || isAbsoluteUrl(value)) return value;
  // Reject non-web schemes before URL resolution. React Markdown also
  // sanitizes URLs, but keeping this resolver independently safe prevents a
  // chart README from turning javascript:/data: links into clickable URLs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  if (!sourceUrl) return undefined;
  const source = sourceUrl.replace(/\/+$/, '');
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(source)) {
    const path = value.replace(/^\.?\//, '');
    return `${source}/${raw ? 'raw' : 'blob'}/HEAD/${path}`;
  }
  try {
    return new URL(value, `${source}/`).toString();
  } catch {
    return undefined;
  }
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const external = !!href && !href.startsWith('#');
  return (
    <Link href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
      {children}
      {external ? <OpenInNewIcon sx={{ ml: 0.35, fontSize: '0.8em', verticalAlign: '-0.08em' }} /> : null}
    </Link>
  );
}

const MarkdownSourceContext = createContext<string | undefined>(undefined);

function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const sourceUrl = useContext(MarkdownSourceContext);
  return <MarkdownLink href={resolveRelative(href, sourceUrl)}>{children}</MarkdownLink>;
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const sourceUrl = useContext(MarkdownSourceContext);
  const resolved = resolveRelative(typeof src === 'string' ? src : undefined, sourceUrl, true);
  return resolved ? <img src={resolved} alt={alt ?? ''} loading="lazy" /> : <span>{alt ?? 'README image'}</span>;
}

const markdownComponents: Components = {
  a: MarkdownAnchor,
  img: MarkdownImage,
};

/** Safe CommonMark/GFM renderer for chart README files. Raw HTML is not enabled. */
export function ChartMarkdown({ markdown, sourceUrl }: Props) {
  return (
    <Box
      sx={{
        height: '100%',
        overflowY: 'auto',
        px: 2.5,
        py: 1.5,
        color: 'text.primary',
        fontSize: 14,
        lineHeight: 1.6,
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& h1': { typography: 'h5', mt: 2.5, mb: 1 },
        '& h2': { typography: 'h6', mt: 2.5, mb: 1, pb: 0.5, borderBottom: 1, borderColor: 'divider' },
        '& h3': { typography: 'subtitle1', fontWeight: 700, mt: 2, mb: 0.75 },
        '& h4, & h5, & h6': { typography: 'subtitle2', fontWeight: 700, mt: 1.75, mb: 0.5 },
        '& p': { my: 1 },
        '& ul, & ol': { my: 1, pl: 3.5 },
        '& li': { my: 0.25 },
        '& blockquote': { mx: 0, my: 1.5, px: 1.5, py: 0.25, borderLeft: 4, borderColor: 'info.main', bgcolor: 'action.hover' },
        '& code': { px: 0.45, py: 0.1, borderRadius: 0.5, bgcolor: 'action.hover', fontFamily: 'monospace', fontSize: '0.9em' },
        '& pre': { overflowX: 'auto', p: 1.5, borderRadius: 1, bgcolor: 'action.hover' },
        '& pre code': { p: 0, bgcolor: 'transparent' },
        '& table': { width: '100%', my: 1.5, borderCollapse: 'collapse' },
        '& th, & td': { px: 1, py: 0.65, border: 1, borderColor: 'divider', textAlign: 'left', verticalAlign: 'top' },
        '& th': { bgcolor: 'action.hover', fontWeight: 700 },
        '& img': { maxWidth: '100%', height: 'auto' },
        '& input[type="checkbox"]': { mr: 0.75 },
        '& hr': { my: 2, border: 0, borderTop: 1, borderColor: 'divider' },
      }}
    >
      <MarkdownSourceContext.Provider value={sourceUrl}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {markdown}
        </ReactMarkdown>
      </MarkdownSourceContext.Provider>
    </Box>
  );
}
