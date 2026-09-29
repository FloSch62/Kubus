/**
 * Shared chart tokens so every metrics surface draws from the same series
 * palette and time axis language.
 *
 * Categorical palette from the validated dataviz reference set (adjacent-pair
 * CVD-safe in this order — do not re-order or cycle past 8 series).
 */
export const SERIES_LIGHT = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7', '#e34948'];
export const SERIES_DARK = ['#3987e5', '#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9', '#e66767'];

/**
 * Fixed hues for the two usage metrics (and the two traffic directions).
 * Green, amber and red stay reserved for health, so memory is violet.
 */
export const METRIC_COLORS = {
  light: { cpu: '#2a78d6', memory: '#7457d9', sent: '#2a78d6', received: '#7457d9' },
  dark: { cpu: '#3987e5', memory: '#9f8cf0', sent: '#3987e5', received: '#9f8cf0' },
} as const;

export function metricColors(mode: 'light' | 'dark') {
  return METRIC_COLORS[mode];
}

const minuteTicks = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const secondTicks = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Round time-axis steps, smallest first. */
const TIME_STEPS = [10 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];

/**
 * Time-axis ticks on round steps (…:15:00, …:15:30, …:16:00) in 24 h time,
 * at most `maxTicks` of them. Seconds only show for steps under a minute,
 * which only happens on windows shorter than about five minutes.
 */
export function timeAxisTicks(times: Array<Date | number>, maxTicks = 5): { tickInterval: Date[]; valueFormatter: (d: Date) => string } {
  const first = times.length ? Number(times[0]) : 0;
  const last = times.length ? Number(times[times.length - 1]) : 0;
  const span = Math.max(0, last - first);
  const step = TIME_STEPS.find((s) => span / s <= maxTicks) ?? TIME_STEPS.at(-1)!;
  const formatter = step < MINUTE ? secondTicks : minuteTicks;
  const ticks: Date[] = [];
  if (times.length) {
    // Align to local wall-clock multiples of the step (hours in time zones
    // with half-hour offsets included).
    const offset = new Date(first).getTimezoneOffset() * MINUTE;
    let t = Math.ceil((first - offset) / step) * step + offset;
    for (; t <= last && ticks.length < 50; t += step) ticks.push(new Date(t));
  }
  return {
    tickInterval: ticks,
    valueFormatter: (d: Date) => (Number.isNaN(d.getTime()) ? 'Invalid Date' : formatter.format(d)),
  };
}

/**
 * Time-axis tick label formatter, 24 h. Short spans include seconds so
 * neighbouring labels don't repeat.
 */
export function timeTickFormatter(times: Array<Date | number>): (d: Date) => string {
  const first = times.length ? Number(times[0]) : 0;
  const last = times.length ? Number(times[times.length - 1]) : 0;
  const formatter = last - first < 5 * MINUTE ? secondTicks : minuteTicks;
  return (d: Date) => (Number.isNaN(d.getTime()) ? 'Invalid Date' : formatter.format(d));
}

export type ValueUnit = 'cpu' | 'bytes' | 'rate';

const KI = 1024;
const BYTE_UNITS: Array<[number, string]> = [
  [KI ** 4, 'Ti'],
  [KI ** 3, 'Gi'],
  [KI ** 2, 'Mi'],
  [KI, 'Ki'],
  [1, 'B'],
];
/** Power-of-two steps per binary unit, so ticks read 512Mi, 1Gi, 1.5Gi. */
const BYTE_STEPS = BYTE_UNITS.slice()
  .reverse()
  .flatMap(([unit]) => [1, 2, 4, 8, 16, 32, 64, 128, 256, 512].map((m) => m * unit));
/** 1-2-5 steps in millicores. */
const CPU_STEPS = [0, 1, 2, 3, 4, 5, 6].flatMap((exp) => [1, 2, 5].map((m) => m * 10 ** exp));

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '');
}

/** Axis label for bytes: whole numbers where possible (1Gi, 1.5Gi, 512Mi). */
export function formatAxisBytes(bytes: number): string {
  if (bytes === 0) return '0';
  for (const [unit, label] of BYTE_UNITS) {
    if (bytes >= unit) return `${trimNumber(bytes / unit)}${label}`;
  }
  return `${trimNumber(bytes)}B`;
}

/** Axis label for millicores: 250m below a core, 1.5 cores above. */
export function formatAxisCpu(milli: number): string {
  if (milli === 0) return '0';
  if (milli < 1000) return `${trimNumber(milli)}m`;
  const cores = milli / 1000;
  return `${trimNumber(cores)} ${cores === 1 ? 'core' : 'cores'}`;
}

export function formatAxisValue(unit: ValueUnit, v: number): string {
  if (unit === 'cpu') return formatAxisCpu(v);
  if (unit === 'rate') return v === 0 ? '0' : `${formatAxisBytes(v)}/s`;
  return formatAxisBytes(v);
}

/**
 * A round axis maximum and the ticks up to it: at most `maxIntervals` equal
 * steps from 0, each a "nice" number for the unit (0/100m/200m/300m,
 * 0/512Mi/1Gi/1.5Gi/2Gi).
 */
export function niceValueTicks(maxValue: number, unit: ValueUnit, maxIntervals = 4): { max: number; tickInterval: number[] } {
  const steps = unit === 'cpu' ? CPU_STEPS : BYTE_STEPS;
  const target = Math.max(0, maxValue);
  const step = target > 0 ? (steps.find((s) => Math.ceil(target / s) <= maxIntervals) ?? steps.at(-1)!) : steps[unit === 'cpu' ? 3 : 10]!;
  const count = Math.max(1, Math.ceil(target / step));
  const tickInterval = Array.from({ length: count + 1 }, (_, i) => i * step);
  return { max: count * step, tickInterval };
}
