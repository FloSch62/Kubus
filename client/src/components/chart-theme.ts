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
 * Time-axis tick formatter. Minute precision produces duplicate neighboring
 * tick labels on ranges shorter than the tick spacing allows, so short spans
 * include seconds.
 */
const minuteTicks = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const secondTicks = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function timeTickFormatter(times: Array<Date | number>): (d: Date) => string {
  const first = times.length ? Number(times[0]) : 0;
  const last = times.length ? Number(times[times.length - 1]) : 0;
  const withSeconds = last - first < 15 * 60_000;
  const formatter = withSeconds ? secondTicks : minuteTicks;
  return (d: Date) => Number.isNaN(d.getTime()) ? 'Invalid Date' : formatter.format(d);
}
