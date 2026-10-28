import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { BUSINESS, DEPOSIT_NGN, HOLD_MINUTES, MAX_DAYS_AHEAD } from "./config.js";
import type { Booking, Store } from "./store.js";
import type { Payments } from "./paystack.js";
import {
  addDays, isInPast, isValidDate, isValidTime, lagosDate, lagosTime, slotsForDate, weekday,
} from "./time.js";

/**
 * Booking logic behind the three MCP tools. Every function returns a plain
 * object with `ok` and a machine-readable `code` so the skill can branch on
 * outcomes without parsing prose.
 */

const RECON_LOG = process.env.RECON_LOG_PATH ?? "./data/reconciliation.jsonl";
const PLACEHOLDER_EMAIL_DOMAIN = process.env.PLACEHOLDER_EMAIL_DOMAIN ?? "example.com";
const MAX_ALTERNATIVES = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- helpers

/** Per-slot in-process lock. Serialises holds on one instance; see README for the multi-instance caveat. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * 3 ** i));
    }
  }
  throw last;
}

/** Durable record of anything a human must fix. Survives a Sheets outage. */
async function reconcile(entry: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.error(`[RECONCILE] ${line}`);
  try {
    await appendFile(RECON_LOG, line + "\n");
  } catch (e) {
    console.error(`[RECONCILE] could not write ${RECON_LOG}: ${(e as Error).message}`);
  }
}

function isActive(b: Booking, now = new Date()): boolean {
  if (b.status === "booked") return true;
  if (b.status === "pending") return !b.holdExpiresAt || new Date(b.holdExpiresAt) > now;
  return false;
}

function taken(rows: Booking[], date: string, time: string, excludeRef?: string): number {
  return rows.filter((b) => b.date === date && b.time === time && b.reference !== excludeRef && isActive(b)).length;
}

function freeSlots(rows: Booking[], date: string, now = new Date()): string[] {
  return slotsForDate(date).filter((t) => !isInPast(date, t, now) && taken(rows, date, t) < BUSINESS.chairs);
}

function lastBookableDate(now = new Date()) {
  return addDays(lagosDate(now), MAX_DAYS_AHEAD);
}

/** Next free slots at or after the requested one, scanning up to 7 days ahead. */
function alternatives(rows: Booking[], date: string, time: string, now = new Date()) {
  const out: { date: string; time: string }[] = [];
  // Never suggest a past day or one beyond the booking horizon.
  const today = lagosDate(now);
  if (date < today) [date, time] = [today, "00:00"];
  for (let d = 0; d < 7 && out.length < MAX_ALTERNATIVES; d++) {
    const day = addDays(date, d);
    if (day > lastBookableDate(now)) break;
    for (const t of freeSlots(rows, day, now)) {
      if (d === 0 && t <= time) continue;
      out.push({ date: day, time: t });
      if (out.length >= MAX_ALTERNATIVES) break;
    }
  }
  // If nothing later, offer earlier the same day.
  if (out.length === 0) {
    for (const t of freeSlots(rows, date, now)) if (t < time) out.push({ date, time: t });
  }
  return out.slice(0, MAX_ALTERNATIVES);
}

function resolveService(input: string) {
  const key = input.trim().toLowerCase();
  if (BUSINESS.services[key]) return { key, ...BUSINESS.services[key] };
  for (const [k, v] of Object.entries(BUSINESS.services)) {
    if (v.label.toLowerCase() === key) return { key: k, ...v };
  }
  return null;
}

function newReference(date: string) {
  return `FF-${date.replace(/-/g, "").slice(2)}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function dateProblem(date: string, now = new Date()) {
  if (!isValidDate(date)) return { code: "invalid_date", message: "Date must be YYYY-MM-DD." };
  if (date < lagosDate(now)) return { code: "in_past", message: "That date has already passed." };
  if (date > lastBookableDate(now))
    return { code: "too_far_ahead", message: `Bookings open up to ${MAX_DAYS_AHEAD} days ahead.`, lastBookableDate: lastBookableDate(now) };
  return null;
}

function slotProblem(date: string, time: string, now = new Date()) {
  const problem = dateProblem(date, now);
  if (problem) return problem;
  if (!isValidTime(time)) return { code: "invalid_time", message: "Time must be HH:MM, 24-hour." };
  if (!BUSINESS.hours[weekday(date)])
    return { code: "closed", message: `${BUSINESS.name} is closed on that day.` };
  if (!slotsForDate(date).includes(time))
    return { code: "outside_hours", message: "That time is outside opening hours or not on a slot boundary.", validTimes: slotsForDate(date) };
  if (isInPast(date, time, now)) return { code: "in_past", message: "That slot has already started or passed." };
  return null;
}

// ---------------------------------------------------------------- tool 1

export async function checkAvailability(store: Store, args: { date?: string; time?: string }) {
  const now = new Date();
  const base = { today: lagosDate(now), nowLagos: lagosTime(now), timezone: "Africa/Lagos" };
  const date = args.date ?? base.today;
  const problem = dateProblem(date, now);
  if (problem?.code === "invalid_date" || problem?.code === "too_far_ahead") return { ok: false, ...problem, ...base };

  // A few seconds stale is fine here: holds re-check under the lock with a fresh read.
  const rows = await store.list({ maxAgeMs: 5000 });

  if (problem) return { ok: false, ...problem, ...base, alternatives: alternatives(rows, date, "00:00", now) };

  if (!args.time) {
    const free = freeSlots(rows, date, now);
    const open = !!BUSINESS.hours[weekday(date)];
    // Only say "fully booked" when there were future slots and they're all taken.
    const code = free.length ? "slots_listed"
      : !open ? "closed"
      : slotsForDate(date).every((t) => isInPast(date, t, now)) ? "day_over"
      : "fully_booked";
    return {
      ok: true, code, ...base, date, open,
      freeSlots: free,
      nextAvailable: free.length ? undefined : alternatives(rows, date, "00:00", now),
    };
  }

  const slot = slotProblem(date, args.time, now);
  if (slot) return { ok: false, ...slot, ...base, alternatives: alternatives(rows, date, args.time, now) };

  const available = taken(rows, date, args.time) < BUSINESS.chairs;
  return {
    ok: true, code: available ? "available" : "slot_taken", ...base, date, time: args.time, available,
    alternatives: available ? undefined : alternatives(rows, date, args.time, now),
  };
}

// ---------------------------------------------------------------- tool 2

export async function holdSlotAndCreateDeposit(
  store: Store,
  payments: Payments,
  args: { name: string; service: string; date: string; time: string; phone?: string; email?: string },
) {
  const now = new Date();
  const service = resolveService(args.service);
  if (!service) {
    return {
      ok: false, code: "unknown_service", message: "Service not offered.",
      services: Object.entries(BUSINESS.services).map(([k, v]) => ({ key: k, label: v.label, priceNgn: v.priceNgn })),
    };
  }
  const problem = slotProblem(args.date, args.time, now);
  if (problem) return { ok: false, ...problem };

  return withLock(`${args.date} ${args.time}`, async () => {
    // 1. Re-check under the lock. The customer may have been told "free" minutes ago.
    let rows = await store.list();
    if (taken(rows, args.date, args.time) >= BUSINESS.chairs) {
      return {
        ok: false, code: "slot_taken",
        message: "That slot was taken since availability was checked.",
        alternatives: alternatives(rows, args.date, args.time, now),
      };
    }

    // 2. Write the hold.
    const reference = newReference(args.date);
    const amountKobo = DEPOSIT_NGN * 100;
    const booking: Booking = {
      reference, status: "pending", date: args.date, time: args.time,
      service: service.label, name: args.name.trim(), phone: args.phone?.trim() ?? "",
      amountKobo, createdAt: now.toISOString(),
      holdExpiresAt: new Date(now.getTime() + HOLD_MINUTES * 60_000).toISOString(),
      updatedAt: now.toISOString(), paymentUrl: "", note: "",
    };
    await store.append(booking);

    // 3. Read back. The lock only covers this process; a second instance or a
    //    hand-entered walk-in could have landed in the same slot. Earliest wins.
    rows = await store.list();
    const contenders = rows
      .filter((b) => b.date === args.date && b.time === args.time && isActive(b, now))
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    const position = contenders.findIndex((b) => b.reference === reference);
    if (position >= BUSINESS.chairs) {
      await store.update({ ...booking, status: "released", updatedAt: new Date().toISOString(), note: "lost race on hold" })
        .catch((e) => reconcile({ kind: "release_failed", reference, error: String(e) }));
      return {
        ok: false, code: "slot_taken", message: "Another customer secured that slot a moment earlier.",
        alternatives: alternatives(rows, args.date, args.time, now),
      };
    }

    // 4. Create the deposit link. If Paystack fails, give the slot back.
    try {
      const init = await payments.initialize({
        reference, amountKobo,
        // Paystack rejects malformed emails; a typo shouldn't cost the customer their hold.
        email: EMAIL_RE.test(args.email?.trim() ?? "") ? args.email!.trim() : `booking+${reference.toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`,
        metadata: { name: booking.name, phone: booking.phone, service: service.label, date: args.date, time: args.time },
      });
      booking.paymentUrl = init.authorizationUrl;
      booking.updatedAt = new Date().toISOString();
      await store.update(booking).catch((e) => console.error(`could not store payment link for ${reference}: ${e}`));
      return {
        ok: true, code: "held",
        reference, paymentUrl: init.authorizationUrl,
        depositNgn: DEPOSIT_NGN, servicePriceNgn: service.priceNgn, balanceDueAtSalonNgn: service.priceNgn - DEPOSIT_NGN,
        service: service.label, date: args.date, time: args.time,
        holdExpiresAt: booking.holdExpiresAt, holdMinutes: HOLD_MINUTES,
      };
    } catch (e) {
      console.error(`payment link failed for ${reference}: ${(e as Error).message}`);
      await store.update({ ...booking, status: "released", updatedAt: new Date().toISOString(), note: `payment link failed: ${(e as Error).message}` })
        .catch((err) => reconcile({ kind: "release_failed", reference, error: String(err) }));
      return { ok: false, code: "payment_link_failed", message: "Could not create a payment link. The slot was not held." };
    }
  });
}

// ---------------------------------------------------------------- tool 3

export async function verifyPayment(store: Store, payments: Payments, args: { reference: string }) {
  const reference = args.reference.trim().toUpperCase();
  const now = new Date();

  // Ask Paystack first: if the sheet is unreachable we still want to know whether money moved.
  const pay = await retry(() => payments.verify(reference));

  let rows: Booking[];
  try {
    rows = await retry(() => store.list());
  } catch (e) {
    if (pay.status === "success") {
      await reconcile({ kind: "paid_sheet_unreachable", reference, amountKobo: pay.amountKobo, paidAt: pay.paidAt, error: String(e) });
      return {
        ok: true, code: "paid_needs_manual_record", reference,
        message: "Deposit received, but the booking diary could not be updated. The owner has been flagged to confirm manually.",
      };
    }
    throw e;
  }

  const booking = rows.find((b) => b.reference === reference);
  if (!booking) {
    if (pay.status === "success") {
      // Usually the owner deleted the row. Money moved, so flag it, but never tell the customer the slot is theirs.
      await reconcile({ kind: "paid_unknown_reference", reference, amountKobo: pay.amountKobo, paidAt: pay.paidAt });
      return {
        ok: true, code: "paid_booking_missing", reference,
        message: "Deposit found, but there is no matching booking in the diary. The owner has been flagged to contact the customer.",
      };
    }
    return { ok: false, code: "unknown_reference", message: "No booking with that reference." };
  }

  const summary = { reference, service: booking.service, date: booking.date, time: booking.time, name: booking.name };

  if (booking.status === "booked") return { ok: true, code: "already_booked", ...summary };

  // The owner cancelled it in the Sheet. Final: a later payment or a returning customer
  // must not quietly re-book it. Deposit handling is the owner's call.
  if (booking.status === "cancelled") {
    return { ok: true, code: "cancelled", ...summary, depositPaid: pay.status === "success" };
  }

  // ---- Not paid (yet)
  if (pay.status !== "success") {
    const inFlight = ["ongoing", "pending", "processing", "queued"].includes(pay.status);
    // A non-pending row (released by us or by the owner) has no live hold, whatever its expiry says.
    const expired = booking.status !== "pending" || new Date(booking.holdExpiresAt) <= now;
    if (!expired || inFlight) {
      const minutesLeft = Math.max(0, Math.ceil((new Date(booking.holdExpiresAt).getTime() - now.getTime()) / 60_000));
      // A declined card is not "still waiting": tell the customer to retry, the hold stands.
      // The same Paystack link accepts another attempt.
      const code = inFlight ? "payment_processing" : pay.status === "failed" ? "payment_failed" : "awaiting_payment";
      return {
        ok: true, code, ...summary,
        paystackStatus: pay.status, paymentUrl: booking.paymentUrl || undefined, holdMinutesLeft: minutesLeft,
      };
    }
    if (booking.status === "pending") {
      await retry(() => store.update({ ...booking, status: "released", updatedAt: now.toISOString(), note: `hold expired unpaid (paystack: ${pay.status})` }))
        .catch((e) => reconcile({ kind: "release_failed", reference, error: String(e) }));
    }
    return {
      ok: true, code: "released_unpaid", ...summary, paystackStatus: pay.status,
      alternatives: alternatives(rows, booking.date, booking.time, now),
    };
  }

  // ---- Paid. Guard against a tampered or partial amount.
  if (pay.currency !== "NGN" || pay.amountKobo < booking.amountKobo) {
    await reconcile({ kind: "amount_mismatch", reference, expected: booking.amountKobo, got: pay.amountKobo, currency: pay.currency });
    return { ok: false, code: "amount_mismatch", ...summary, message: "Payment amount does not match the deposit. Owner flagged." };
  }

  // Already flagged on an earlier verify: the owner is moving it. Don't re-flag or auto-book.
  if (booking.status === "paid_slot_conflict") {
    return {
      ok: true, code: "paid_slot_conflict", ...summary,
      message: "Deposit received but the slot was filled after the hold expired. The owner has been flagged to move the booking.",
      alternatives: alternatives(rows, booking.date, booking.time, now),
    };
  }

  // Take the same slot lock as holds, so a new hold can't land between the
  // conflict check and the "booked" write.
  return withLock(`${booking.date} ${booking.time}`, async () => {
    const manualRecord = async (kind: string, e: unknown) => {
      await reconcile({ kind, ...summary, phone: booking.phone, amountKobo: pay.amountKobo, paidAt: pay.paidAt, error: String(e) });
      return {
        ok: true, code: "paid_needs_manual_record", ...summary,
        message: "Deposit received and logged, but the booking diary could not be updated. The owner has been flagged to confirm manually.",
      };
    };

    // Re-read under the lock: the rows above may be stale.
    let fresh: Booking[];
    try {
      fresh = await retry(() => store.list());
    } catch (e) {
      return manualRecord("paid_sheet_unreachable", e);
    }
    const current = fresh.find((b) => b.reference === reference) ?? booking;
    if (current.status === "booked") return { ok: true, code: "already_booked", ...summary };

    // Paid, but did the customer keep the slot? Only a problem if the hold lapsed and someone else filled it.
    if (taken(fresh, booking.date, booking.time, reference) >= BUSINESS.chairs) {
      const conflict = { ...current, status: "paid_slot_conflict" as const, updatedAt: now.toISOString(), note: "paid after hold expired; slot taken" };
      await retry(() => store.update(conflict)).catch(() => {});
      await reconcile({ kind: "paid_slot_conflict", reference, amountKobo: pay.amountKobo, date: booking.date, time: booking.time });
      return {
        ok: true, code: "paid_slot_conflict", ...summary,
        message: "Deposit received but the slot was filled after the hold expired. Offer an alternative; the deposit carries over.",
        alternatives: alternatives(fresh, booking.date, booking.time, now),
      };
    }

    // Happy path: mark booked. Retry, then fall back to the reconciliation log.
    const confirmed: Booking = { ...current, status: "booked", updatedAt: now.toISOString(), note: pay.paidAt ? `paid ${pay.paidAt}` : "paid" };
    try {
      await retry(() => store.update(confirmed));
    } catch (e) {
      return manualRecord("paid_sheet_write_failed", e);
    }
    return { ok: true, code: "booked", ...summary, depositNgn: pay.amountKobo / 100 };
  });
}
