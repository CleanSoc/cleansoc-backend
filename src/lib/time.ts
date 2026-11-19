export function nowIso(): string {
  return new Date().toISOString();
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function toEpochMs(value: string | number | Date | undefined | null): number {
  if (value === undefined || value === null || value === '') return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * X archive timestamps look like: "Wed Oct 12 20:00:38 +0000 2016".
 * JavaScript's parser handles this in V8, but be defensive.
 */
export function parseArchiveDate(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const match = value.match(/^(\w{3}) (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}) (\d{4})$/);
  if (!match) return Date.now();
  const [, , month, day, time, offset, year] = match;
  const iso = `${year}-${monthNameToNumber(month)}-${day}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`;
  const fallback = Date.parse(iso);
  return Number.isFinite(fallback) ? fallback : Date.now();
}

function monthNameToNumber(name: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = months.indexOf(name);
  return String(idx + 1).padStart(2, '0');
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return 'less than a second';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr`;
}

