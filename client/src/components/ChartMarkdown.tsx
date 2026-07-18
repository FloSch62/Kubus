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

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

const GITHUB_ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\n?[ \t]*)?/i;
const GITHUB_ALERT_TITLES: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

/** Convert GitHub's > [!TIP] blockquote convention into styled alert nodes. */
function remarkGithubAlerts() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'blockquote') {
        const firstParagraph = node.children?.[0];
        const firstText = firstParagraph?.type === 'paragraph' ? firstParagraph.children?.[0] : undefined;
        const match = firstText?.type === 'text' ? GITHUB_ALERT_RE.exec(firstText.value ?? '') : undefined;
        if (match && firstParagraph && firstText) {
          const kind = match[1]!.toLowerCase();
          firstText.value = (firstText.value ?? '').slice(match[0].length);
          if (!firstText.value) firstParagraph.children?.shift();
          if (!firstParagraph.children?.length) node.children?.shift();
          node.data = {
            ...node.data,
            hName: 'div',
            hProperties: { ...node.data?.hProperties, className: [`markdown-alert`, `markdown-alert-${kind}`] },
          };
          node.children?.unshift({
            type: 'paragraph',
            data: { hName: 'div', hProperties: { className: ['markdown-alert-title'] } },
            children: [{ type: 'text', value: GITHUB_ALERT_TITLES[kind] ?? kind }],
          });
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

const markdownPlugins = [remarkGfm, remarkGithubAlerts];

function githubRelativeUrl(value: string, sourceUrl: string, raw: boolean): string | undefined {
  try {
    const source = new URL(sourceUrl);
    if (source.hostname !== 'github.com') return undefined;
    const segments = source.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return undefined;
    const [owner, repository] = segments;
    const mode = segments[2];
    const revision = mode === 'tree' || mode === 'blob' ? segments[3] : 'HEAD';
    if (!owner || !repository || !revision) return undefined;
    const directorySegments = mode === 'tree' ? segments.slice(4) : mode === 'blob' ? segments.slice(4, -1) : [];
    const directory = directorySegments.join('/');
    const base = raw
      ? `https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${directory ? `${directory}/` : ''}`
      : `https://github.com/${owner}/${repository}/blob/${revision}/${directory ? `${directory}/` : ''}`;
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

function resolveRelative(value: string | undefined, sourceUrl: string | undefined, raw = false): string | undefined {
  if (!value || value.startsWith('#') || isAbsoluteUrl(value)) return value;
  // Reject non-web schemes before URL resolution. React Markdown also
  // sanitizes URLs, but keeping this resolver independently safe prevents a
  // chart README from turning javascript:/data: links into clickable URLs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  if (!sourceUrl) return undefined;
  const githubUrl = githubRelativeUrl(value, sourceUrl, raw);
  if (githubUrl) return githubUrl;
  try {
    return new URL(value, `${sourceUrl.replace(/\/+$/, '')}/`).toString();
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
        '& blockquote': {
          mx: 0,
          my: 1.5,
          px: 1.5,
          py: 0.25,
          borderLeft: 4,
          borderColor: 'info.main',
          bgcolor: 'action.hover',
        },
        '& .markdown-alert': { my: 1.5, px: 1.5, py: 1, borderLeft: 4, borderRadius: 0.75, bgcolor: 'action.hover' },
        '& .markdown-alert > :last-child': { mb: 0 },
        '& .markdown-alert-title': { mb: 0.5, fontWeight: 700 },
        '& .markdown-alert-note': { borderColor: 'info.main' },
        '& .markdown-alert-note .markdown-alert-title': { color: 'info.main' },
        '& .markdown-alert-tip': { borderColor: 'success.main' },
        '& .markdown-alert-tip .markdown-alert-title': { color: 'success.main' },
        '& .markdown-alert-important': { borderColor: 'secondary.main' },
        '& .markdown-alert-important .markdown-alert-title': { color: 'secondary.main' },
        '& .markdown-alert-warning': { borderColor: 'warning.main' },
        '& .markdown-alert-warning .markdown-alert-title': { color: 'warning.main' },
        '& .markdown-alert-caution': { borderColor: 'error.main' },
        '& .markdown-alert-caution .markdown-alert-title': { color: 'error.main' },
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
        <ReactMarkdown skipHtml remarkPlugins={markdownPlugins} components={markdownComponents}>
          {markdown}
        </ReactMarkdown>
      </MarkdownSourceContext.Provider>
    </Box>
  );
}
