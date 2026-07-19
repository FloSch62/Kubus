import Button from '@mui/material/Button';
import GitHubIcon from '@mui/icons-material/GitHub';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

function safeWebUrl(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

/** Prefer the chart's code repository, then another source, then its homepage. */
export function preferredChartSource(sources: string[] | undefined, home: string | undefined): string | undefined {
  const safeSources = (sources ?? []).map(safeWebUrl).filter((source): source is string => !!source);
  return safeSources.find((source) => new URL(source).hostname === 'github.com') ?? safeSources[0] ?? safeWebUrl(home);
}

export function ChartSourceLink({ url }: { url: string | undefined }) {
  const safeUrl = safeWebUrl(url);
  if (!safeUrl) return null;
  const github = new URL(safeUrl).hostname === 'github.com';
  return (
    <Button
      component="a"
      href={safeUrl}
      target="_blank"
      rel="noreferrer"
      size="small"
      variant="text"
      startIcon={github ? <GitHubIcon /> : undefined}
      endIcon={<OpenInNewIcon />}
      sx={{ whiteSpace: 'nowrap' }}
    >
      {github ? 'GitHub' : 'Chart source'}
    </Button>
  );
}
