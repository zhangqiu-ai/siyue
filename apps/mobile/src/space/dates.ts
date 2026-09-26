import type { Locale } from '../i18n/core.ts';

/** Device-local calendar dates.
 * Goal.targetDate and Task.dueLocalDate are plain YYYY-MM-DD calendar dates, so every
 * conversion here works on the local calendar and never on a UTC instant. */

export interface LocalDateParts { year: number; month: number; day: number }

function pad(value: number): string { return value < 10 ? `0${value}` : String(value); }

/** The local calendar date of an instant, or of now. */
export function localDateOf(value: Date = new Date()): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function parseLocalDate(value: string | undefined | null): LocalDateParts | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null;
  const probe = new Date(parts.year, parts.month - 1, parts.day);
  if (probe.getFullYear() !== parts.year || probe.getMonth() !== parts.month - 1 || probe.getDate() !== parts.day) return null;
  return parts;
}

export function shiftLocalDate(value: string, days: number): string {
  const parts = parseLocalDate(value);
  if (!parts) return value;
  return localDateOf(new Date(parts.year, parts.month - 1, parts.day + days));
}

/** Saturday of the week containing the given local date (the local week starts on Sunday). */
export function upcomingSaturday(value: string): string {
  const parts = parseLocalDate(value);
  if (!parts) return value;
  const weekday = new Date(parts.year, parts.month - 1, parts.day).getDay();
  const ahead = (6 - weekday + 7) % 7;
  return shiftLocalDate(value, ahead === 0 ? 7 : ahead);
}

/** Quick picks offered when setting a task date. */
export function dateQuickPicks(today: string): { key: 'today' | 'tomorrow' | 'saturday'; date: string }[] {
  return [
    { key: 'today', date: today },
    { key: 'tomorrow', date: shiftLocalDate(today, 1) },
    { key: 'saturday', date: upcomingSaturday(today) },
  ];
}

/** A compact local date: today, tomorrow, the coming week's weekday, then month and day. */
export function formatLocalDate(locale: Locale, value: string | undefined, today: string): string | null {
  const parts = parseLocalDate(value);
  const base = parseLocalDate(today);
  if (!parts || !base) return null;
  const target = new Date(parts.year, parts.month - 1, parts.day);
  const origin = new Date(base.year, base.month - 1, base.day);
  const days = Math.round((target.getTime() - origin.getTime()) / 86_400_000);
  if (days === 0) return locale === 'en' ? 'Today' : '今天';
  if (days === 1) return locale === 'en' ? 'Tomorrow' : '明天';
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(target);
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(parts.year === base.year ? {} : { year: 'numeric' }) }).format(target);
}

/** Whole minutes left before a draft expires; 0 once it has. */
export function draftMinutesLeft(expiresAt: string, now: number): number {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) return 0;
  return expiry <= now ? 0 : Math.ceil((expiry - now) / 60_000);
}

/** The instant a local calendar date starts, for storage that needs one. */
export function localDateToInstant(value: string): string | null {
  const parts = parseLocalDate(value);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day).toISOString();
}

export interface MonthGrid {
  year: number;
  month: number;
  /** Six weeks of seven cells; a cell is a local date or null for a leading/trailing blank. */
  weeks: (string | null)[][];
}

/** Calendar grid for the date picker, starting on Sunday like the local week. */
export function monthGrid(year: number, month: number): MonthGrid {
  const first = new Date(year, month - 1, 1);
  const offset = first.getDay();
  const days = new Date(year, month, 0).getDate();
  const cells: (string | null)[] = [];
  for (let index = 0; index < offset; index += 1) cells.push(null);
  for (let day = 1; day <= days; day += 1) cells.push(`${year}-${pad(month)}-${pad(day)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return { year, month, weeks };
}

/** Step a month view forward or back, wrapping the year. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** Weekday initials for the picker header, in the locale's week order from Sunday. */
export function weekdayLabels(locale: Locale): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  return [0, 1, 2, 3, 4, 5, 6].map(offset => formatter.format(new Date(2026, 1, 1 + offset)));
}
