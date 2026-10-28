import { GoogleAuth } from "google-auth-library";
import { isValidDate, normalizeDate, normalizeTime, slotsForDate } from "./time.js";

/** Locales where Sheets reads a typed 10/12/2026 as month first. */
const MONTH_FIRST_LOCALES = new Set(["en_US", "es_US", "en_PH", "fil_PH"]);

/**
 * One row per booking attempt. The Google Sheet is the owner's view of the
 * diary, so column order is chosen for a human reading it, not for code.
 */
export type BookingStatus =
  | "pending" //   slot held, deposit not yet confirmed
  | "booked" //    deposit confirmed, slot is theirs
  | "released" //  hold dropped (expired, unpaid, lost a race, or link failed)
  | "paid_slot_conflict"; // paid, but the hold expired and someone else took the slot

export interface Booking {
  reference: string;
  status: BookingStatus;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  service: string;
  name: string;
  phone: string;
  amountKobo: number;
  createdAt: string; // ISO
  holdExpiresAt: string; // ISO
  updatedAt: string; // ISO
  paymentUrl: string;
  note: string;
}

export const COLUMNS: (keyof Booking)[] = [
  "reference", "status", "date", "time", "service", "name", "phone",
  "amountKobo", "createdAt", "holdExpiresAt", "updatedAt", "paymentUrl", "note",
];
export const HEADER = [
  "Reference", "Status", "Date", "Time", "Service", "Customer", "Phone",
  "Deposit (kobo)", "Created", "Hold expires", "Updated", "Payment link", "Note",
];

export interface Store {
  /** `maxAgeMs` lets read-only callers accept a recent cached copy; holds and verifies always read fresh. */
  list(opts?: { maxAgeMs?: number }): Promise<Booking[]>;
  append(b: Booking): Promise<void>;
  update(b: Booking): Promise<void>;
}

function toRow(b: Booking): string[] {
  return COLUMNS.map((k) => String(b[k] ?? ""));
}

type Cell = string | number | boolean;

/**
 * Status words an owner might type for a walk-in. A row with a date and time
 * but no status is treated as booked: blocking a slot by mistake is cheaper
 * than double-booking a customer.
 */
const BOOKED_SYNONYMS = new Set(["", "booked", "confirmed", "paid", "walk-in", "walkin", "walk in", "reserved", "taken"]);

export function normalizeStatus(raw: string): BookingStatus {
  const s = raw.trim().toLowerCase();
  return (BOOKED_SYNONYMS.has(s) ? "booked" : s) as BookingStatus;
}

/** Exported for unit tests. Cells come from an unformatted read, so dates and times may be numbers. */
export function fromRow(r: Cell[], now: Date = new Date()): Booking {
  const o: Record<string, string> = {};
  COLUMNS.forEach((k, i) => (o[k] = r[i] === undefined || r[i] === null ? "" : String(r[i])));
  const dateCell = r[COLUMNS.indexOf("date")];
  const timeCell = r[COLUMNS.indexOf("time")];
  return {
    ...(o as unknown as Booking),
    status: normalizeStatus(o.status || ""),
    date: typeof dateCell === "number" ? normalizeDate(dateCell) : normalizeDate(o.date || "", now),
    time: typeof timeCell === "number" ? normalizeTime(timeCell) : normalizeTime(o.time || ""),
    // Tolerate hand-edited amounts like "200,000".
    amountKobo: Number(o.amountKobo.replace(/[^\d.]/g, "") || 0),
  };
}

// ---------------------------------------------------------------- Sheets

export class SheetsStore implements Store {
  private auth: GoogleAuth;
  private base: string;

  constructor(private spreadsheetId: string, private tab: string, serviceAccountJson: string) {
    this.auth = new GoogleAuth({
      credentials: JSON.parse(serviceAccountJson),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values`;
  }

  private async call(method: string, url: string, body?: unknown) {
    // Sheets allows 60 reads/min per service account; a burst of customers hits 429.
    // Back off and retry on 429/5xx (about 15 s worst case) instead of failing the tool call.
    const delays = [1000, 2000, 4000, 8000];
    for (let attempt = 0; ; attempt++) {
      const client = await this.auth.getClient();
      const { token } = await client.getAccessToken();
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return res.json() as Promise<any>;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= delays.length) {
        throw new Error(`Sheets ${method} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      console.warn(`Sheets ${method} ${res.status}, retrying in ${delays[attempt]} ms`);
      await new Promise((r) => setTimeout(r, delays[attempt] + Math.random() * 500));
    }
  }

  private range(r: string) {
    return encodeURIComponent(`${this.tab}!${r}`);
  }

  /** Writes the header row if the sheet is empty, and checks the sheet's locale. Called once at boot. */
  async ensureHeader() {
    const data = await this.call("GET", `${this.base}/${this.range("A1:M1")}`);
    if (!data.values?.length) {
      await this.call("PUT", `${this.base}/${this.range("A1:M1")}?valueInputOption=RAW`, { values: [HEADER] });
    }
    // Sheets parses a typed date with the spreadsheet's locale, before we ever read it:
    // in a US-locale sheet "10/12/2026" is stored as 12 October. Warn, don't fail boot.
    try {
      const meta = await this.call("GET", `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}?fields=properties.locale`);
      const locale: string = meta.properties?.locale ?? "unknown";
      if (MONTH_FIRST_LOCALES.has(locale)) {
        console.warn(`[SHEET] Locale is ${locale}: dates typed like 10/12/2026 are read month-first. Set File > Settings > Locale to Nigeria.`);
      }
    } catch (e) {
      console.warn(`[SHEET] Could not check spreadsheet locale: ${(e as Error).message}`);
    }
  }

  /** Rows already reported, so a bad row is logged once, not on every read. */
  private warned = new Set<string>();

  /** Log hand-typed rows whose date or time doesn't land on a bookable slot: they block nothing. */
  private warnUnreadable(rows: Booking[]) {
    rows.forEach((b, i) => {
      if (!b.date && !b.time) return;
      if (isValidDate(b.date) && slotsForDate(b.date).includes(b.time)) return;
      const key = `${i + 2}|${b.date}|${b.time}`;
      if (this.warned.has(key)) return;
      this.warned.add(key);
      console.warn(`[SHEET] Row ${i + 2} (date "${b.date}", time "${b.time}") isn't a bookable slot, so it blocks nothing.`);
    });
  }

  // Last read of the diary. Availability checks reuse it for a few seconds so a
  // burst of customers doesn't exhaust the Sheets read quota.
  private cache?: { at: number; rows: Promise<Booking[]> };

  async list({ maxAgeMs = 0 } = {}): Promise<Booking[]> {
    if (!this.cache || maxAgeMs <= 0 || Date.now() - this.cache.at > maxAgeMs) {
      // Unformatted read: a date or time the owner typed comes back as a serial number,
      // not in whatever display format the sheet's locale picked (e.g. 10/12/2026).
      const rows = this.call(
        "GET",
        `${this.base}/${this.range("A2:M")}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
      ).then((data) => {
        const all = ((data.values ?? []) as Cell[][]).map((r) => fromRow(r));
        this.warnUnreadable(all);
        // Owner may hand-enter walk-ins: a row only needs a date and time to block a slot.
        return all.filter((b) => b.date && b.time);
      });
      const entry = { at: Date.now(), rows };
      this.cache = entry;
      rows.catch(() => { if (this.cache === entry) this.cache = undefined; });
    }
    return (await this.cache.rows).map((b) => ({ ...b }));
  }

  async append(b: Booking) {
    this.cache = undefined;
    await this.call(
      "POST",
      `${this.base}/${this.range("A:M")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: [toRow(b)] },
    );
  }

  async update(b: Booking) {
    this.cache = undefined;
    // Find the row by reference at write time; rows may have shifted if the owner edited the sheet.
    const data = await this.call("GET", `${this.base}/${this.range("A:A")}`);
    const idx = ((data.values ?? []) as string[][]).findIndex((r) => r[0] === b.reference);
    if (idx < 1) throw new Error(`Booking ${b.reference} not found in sheet`);
    const row = idx + 1;
    await this.call("PUT", `${this.base}/${this.range(`A${row}:M${row}`)}?valueInputOption=RAW`, {
      values: [toRow(b)],
    });
  }
}

// ---------------------------------------------------------------- Memory (local dev / tests)

export class MemoryStore implements Store {
  rows: Booking[] = [];
  async list() {
    return this.rows.map((r) => ({ ...r }));
  }
  async append(b: Booking) {
    this.rows.push({ ...b });
  }
  async update(b: Booking) {
    const i = this.rows.findIndex((r) => r.reference === b.reference);
    if (i < 0) throw new Error(`Booking ${b.reference} not found`);
    this.rows[i] = { ...b };
  }
}

// ---------------------------------------------------------------- Chaos wrapper (demo only)

/**
 * Wraps a store and makes the "mark as booked" write fail. Used to demonstrate
 * failure path 3 (payment succeeded, sheet write failed) on camera.
 * Never enable in a real deployment.
 */
export class ChaosStore implements Store {
  constructor(private inner: Store, private failConfirmWrites: () => boolean) {}
  list(opts?: { maxAgeMs?: number }) {
    return this.inner.list(opts);
  }
  append(b: Booking) {
    return this.inner.append(b);
  }
  update(b: Booking) {
    if (b.status === "booked" && this.failConfirmWrites()) {
      return Promise.reject(new Error("CHAOS: simulated Google Sheets outage on confirm write"));
    }
    return this.inner.update(b);
  }
}
