import { Cron } from 'croner';
import cronstrue from 'cronstrue';

/**
 * Cron schedule helpers for CronJob columns. Kubernetes parses schedules with
 * robfig/cron, so this normalizes the robfig extensions (macros, `?`, an
 * optional `TZ=`/`CRON_TZ=` prefix) before handing the five-field expression
 * to croner (next run) / cronstrue (human text).
 */

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface ParsedSchedule {
  expr: string;
  /** Timezone from a TZ=/CRON_TZ= prefix; overrides spec.timeZone, like robfig. */
  tz?: string;
  /** `@every <duration>` schedules fire relative to controller start — the phase is unknowable here. */
  every?: string;
}

function parseSchedule(schedule: string): ParsedSchedule | undefined {
  let expr = schedule.trim();
  let tz: string | undefined;
  const tzMatch = /^(?:CRON_)?TZ=(\S+)\s+(.*)$/.exec(expr);
  if (tzMatch) {
    tz = tzMatch[1];
    expr = (tzMatch[2] ?? '').trim();
  }
  if (expr.startsWith('@every')) return { expr, tz, every: expr.slice(6).trim() };
  expr = MACROS[expr] ?? expr;
  const fields = expr.split(/\s+/);
  // Kubernetes (robfig ParseStandard) takes exactly five fields — croner would
  // happily preview a seconds-first six-field expression the API server rejects.
  if (fields.length !== 5) return undefined;
  // robfig treats `?` as `*`; croner would substitute its startup time instead.
  return { expr: fields.map((field) => (field === '?' ? '*' : field)).join(' '), tz };
}

// Column valueGetters run per row per grid pass — cache the parsed pattern.
const cronCache = new Map<string, Cron | null>();

function cronFor(expr: string, tz: string): Cron | null {
  const key = `${tz}\0${expr}`;
  let cron = cronCache.get(key);
  if (cron === undefined) {
    try {
      cron = new Cron(expr, { timezone: tz });
    } catch {
      cron = null;
    }
    cronCache.set(key, cron);
  }
  return cron;
}

/**
 * Next time a schedule fires. `timeZone` is the CronJob's spec.timeZone;
 * without one the controller evaluates schedules in kube-controller-manager's
 * zone, which is UTC on virtually all clusters — assume that.
 */
export function cronNextRun(schedule: string, timeZone?: string): Date | undefined {
  const parsed = parseSchedule(schedule);
  if (!parsed || parsed.every !== undefined) return undefined;
  try {
    return cronFor(parsed.expr, parsed.tz ?? timeZone ?? 'UTC')?.nextRun() ?? undefined;
  } catch {
    return undefined;
  }
}

/** The next `count` fire times, for schedule previews. Empty when unparseable or `@every`. */
export function cronNextRuns(schedule: string, timeZone: string | undefined, count: number): Date[] {
  const parsed = parseSchedule(schedule);
  if (!parsed || parsed.every !== undefined) return [];
  try {
    return cronFor(parsed.expr, parsed.tz ?? timeZone ?? 'UTC')?.nextRuns(count) ?? [];
  } catch {
    return [];
  }
}

const humanCache = new Map<string, string | undefined>();

/** Human-readable schedule text ("At 04:05, only on Sunday"), or undefined when unparseable. */
export function cronHumanText(schedule: string): string | undefined {
  if (humanCache.has(schedule)) return humanCache.get(schedule);
  const parsed = parseSchedule(schedule);
  let text: string | undefined;
  if (!parsed) {
    text = undefined;
  } else if (parsed.every !== undefined) {
    text = parsed.every ? `Every ${parsed.every}` : undefined;
  } else {
    try {
      text = cronstrue.toString(parsed.expr, { use24HourTimeFormat: true });
    } catch {
      text = undefined;
    }
  }
  humanCache.set(schedule, text);
  return text;
}
