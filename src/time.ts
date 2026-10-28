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
 * Coerce a time read from the sheet to HH:MM. Sheets is read unformatted, so a
 * hand-typed time arrives as a day fraction (0.5833 = 14:00). A cell formatted
 * as plain text can hold "14:00:00", "2:00 PM", "2pm" or "14.00".
 * Unrecognised input is returned trimmed, unchanged (and so never matches a slot).
 */
export function normalizeTime(raw: string | number): string {
  if (typeof raw === "number") {
    // A whole number is a typed "14" or "5", not a time cell: as ambiguous as the text form.
    if (Number.isInteger(raw)) return String(raw);
    const minutes = Math.round((raw - Math.floor(raw)) * 1440) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  const m = raw.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/);
  if (!m || (!m[2] && !m[3])) return raw.trim(); // a bare "14" is too ambiguous
  let h = Number(m[1]);
  const meridiem = m[3]?.[0].toLowerCase();
  if (meridiem === "p" && h < 12) h += 12;
  if (meridiem === "a" && h === 12) h = 0;
  if (h > 23) return raw.trim();
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * Coerce a date read from the sheet to YYYY-MM-DD. Sheets turns a typed date
 * into a serial number (days since 1899-12-30), which is what an unformatted
 * read returns. For cells formatted as plain text, accepts ISO dates, day-first
 * numeric dates (10/12/2026, Nigerian convention) and month names
 * ("10 Dec 2026", "Dec 10", "Thu 10 December"). A missing year means the next
 * occurrence, counting anything up to 30 days back as this year.
 * Unrecognised input is returned trimmed, unchanged (and so never matches a slot).
 */
export function normalizeDate(raw: string | number, now: Date = new Date()): string {
  if (typeof raw === "number") {
    return new Date(SHEETS_EPOCH_MS + Math.floor(raw) * 86_400_000).toISOString().slice(0, 10);
  }
  const s = raw.trim();
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (iso) return build(+iso[1], +iso[2], +iso[3]) ?? s;
  const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (dmy) return build(fullYear(+dmy[3]), +dmy[2], +dmy[1]) ?? s;

  const words = s.toLowerCase().replace(/,/g, " ").replace(/(\d)(st|nd|rd|th)\b/g, "$1").split(/\s+/).filter(Boolean);
  let day: number | undefined, month: number | undefined, year: number | undefined;
  for (const w of words) {
    const mi = MONTHS.indexOf(w.slice(0, 3));
    if (mi >= 0 && /^[a-z]+$/.test(w)) month = mi + 1;
    else if (/^\d{4}$/.test(w)) year = +w;
    else if (/^\d{1,2}$/.test(w) && day === undefined) day = +w;
  }
  if (!day || !month) return s;
  if (year) return build(year, month, day) ?? s;
  const today = lagosDate(now);
  const thisYear = +today.slice(0, 4);
  const candidate = build(thisYear, month, day);
  if (!candidate) return s;
  const cutoff = addDays(today, -30);
  return candidate >= cutoff ? candidate : build(thisYear + 1, month, day) ?? s;
}

function fullYear(y: number) {
  return y < 100 ? 2000 + y : y;
}

function build(y: number, m: number, d: number): string | undefined {
  const out = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidDate(out) ? out : undefined;
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
