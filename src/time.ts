import { BUSINESS, TIMEZONE_OFFSET } from "./config.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00${TIMEZONE_OFFSET}`);
  return !Number.isNaN(t.getTime()) && lagosDate(t) === d;
}

export function isValidTime(t: string): boolean {
  return TIME_RE.test(t);
}

/** YYYY-MM-DD in Lagos for an instant. */
export function lagosDate(at: Date = new Date()): string {
  return new Date(at.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** HH:MM in Lagos for an instant. */
export function lagosTime(at: Date = new Date()): string {
  return new Date(at.getTime() + 60 * 60 * 1000).toISOString().slice(11, 16);
}

/**
 * Coerce a time read from the sheet to HH:MM. A hand-typed "14:00" may come
 * back from Sheets as "14:00:00" or "2:00 PM" depending on cell format.
 * Unrecognised input is returned trimmed, unchanged.
 */
export function normalizeTime(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/);
  if (!m) return raw.trim();
  let h = Number(m[1]);
  const meridiem = m[3]?.[0].toLowerCase();
  if (meridiem === "p" && h < 12) h += 12;
  if (meridiem === "a" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

export function slotStart(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${TIMEZONE_OFFSET}`);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function weekday(date: string): number {
  return slotStart(date, "12:00").getUTCDay();
}

/** All bookable slot start times for a date, ignoring existing bookings. */
export function slotsForDate(date: string): string[] {
  const hours = BUSINESS.hours[weekday(date)];
  if (!hours) return [];
  const out: string[] = [];
  for (let m = toMinutes(hours.open); m + BUSINESS.slotMinutes <= toMinutes(hours.close); m += BUSINESS.slotMinutes) {
    out.push(fromMinutes(m));
  }
  return out;
}

export function addDays(date: string, n: number): string {
  const d = slotStart(date, "12:00");
  d.setUTCDate(d.getUTCDate() + n);
  return lagosDate(d);
}

export function isInPast(date: string, time: string, now = new Date()): boolean {
  return slotStart(date, time).getTime() <= now.getTime();
}
