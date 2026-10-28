// Unit checks for how hand-typed sheet cells are read. Run via `npm test` (uses tsx).
import { normalizeDate, normalizeTime } from "../src/time.ts";
import { fromRow, MemoryStore } from "../src/store.ts";
import { MockPayments } from "../src/paystack.ts";
import { holdSlotAndCreateDeposit, verifyPayment, checkAvailability } from "../src/booking.ts";
import { addDays, lagosDate } from "../src/time.ts";

let failures = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};
const now = new Date("2026-10-28T12:00:00+01:00");

// Dates: what an unformatted Sheets read returns for a typed date, plus plain-text cells.
eq("date serial 46366 (typed 10/12/2026)", normalizeDate(46366), "2026-12-10");
eq("date serial with time part", normalizeDate(46366.75), "2026-12-10");
eq("ISO string unchanged", normalizeDate("2026-12-10", now), "2026-12-10");
eq("ISO unpadded", normalizeDate("2026-12-1", now), "2026-12-01");
eq("day-first slashes", normalizeDate("10/12/2026", now), "2026-12-10");
eq("day-first dashes, 2-digit year", normalizeDate("10-12-26", now), "2026-12-10");
eq("'10 Dec 2026'", normalizeDate("10 Dec 2026", now), "2026-12-10");
eq("'Thursday, 10th December 2026'", normalizeDate("Thursday, 10th December 2026", now), "2026-12-10");
eq("'Dec 10, 2026'", normalizeDate("Dec 10, 2026", now), "2026-12-10");
eq("no year, upcoming -> this year", normalizeDate("10 Dec", now), "2026-12-10");
eq("no year, long past -> next year", normalizeDate("5 Jan", now), "2027-01-05");
eq("impossible date left alone", normalizeDate("31/02/2026", now), "31/02/2026");
eq("garbage left alone", normalizeDate("tomorrow", now), "tomorrow");

// Times
eq("time fraction 0.583333 -> 14:00", normalizeTime(14 / 24), "14:00");
eq("time fraction 0.729166 -> 17:30", normalizeTime(17.5 / 24), "17:30");
eq("'14:00:00'", normalizeTime("14:00:00"), "14:00");
eq("'2:00 PM'", normalizeTime("2:00 PM"), "14:00");
eq("'2pm'", normalizeTime("2pm"), "14:00");
eq("'12am'", normalizeTime("12am"), "00:00");
eq("'14.00'", normalizeTime("14.00"), "14:00");
eq("bare '14' left alone", normalizeTime("14"), "14");
eq("bare number 14 left alone (not midnight)", normalizeTime(14), "14");
eq("datetime serial in time cell -> time part", normalizeTime(46366 + 17 / 24), "17:00");

// Whole row as an owner might type a walk-in (no reference, mixed cell types).
const walkIn = fromRow(["", "Walk-in", 46366, 17 / 24, "Haircut", "Kunle"], now);
eq("walk-in row: date", walkIn.date, "2026-12-10");
eq("walk-in row: time", walkIn.time, "17:00");
eq("walk-in row: status 'Walk-in' blocks as booked", walkIn.status, "booked");
eq("walk-in row: blank status blocks as booked", fromRow(["", "", "2026-12-10", "17:00"], now).status, "booked");
eq("released row stays released", fromRow(["FF-1", "Released", "2026-12-10", "17:00"], now).status, "released");

eq("'Cancelled' status reads as cancelled", fromRow(["FF-1", "Cancelled", "2026-12-10", "17:00"], now).status, "cancelled");
eq("'canceled' (US spelling) reads as cancelled", fromRow(["FF-1", "canceled", "2026-12-10", "17:00"], now).status, "cancelled");

// Owner edits after a paid booking: cancel in the Sheet, or delete the row.
{
  const store = new MemoryStore();
  const pay = new MockPayments("http://local");
  // Find an open weekday a few days out.
  let date;
  for (let i = 3; i < 12; i++) {
    const d = addDays(lagosDate(), i);
    const r = await checkAvailability(store, { date: d });
    if (r.freeSlots?.length) { date = d; break; }
  }
  const book = async (time) => {
    const h = await holdSlotAndCreateDeposit(store, pay, { name: "Unit", service: "haircut", date, time });
    pay.paid.set(h.reference, pay.expected.get(h.reference));
    const v = await verifyPayment(store, pay, { reference: h.reference });
    return { h, v };
  };

  const a = await book("10:00");
  eq("owner-cancel setup: paid booking is booked", a.v.code, "booked");
  const row = store.rows.find((r) => r.reference === a.h.reference);
  row.status = "cancelled";
  const again = await verifyPayment(store, pay, { reference: a.h.reference });
  eq("owner cancelled a paid booking: verify says cancelled", again.code, "cancelled");
  eq("owner cancelled a paid booking: deposit flagged as paid", again.depositPaid, true);
  eq("owner cancelled a paid booking: row NOT re-booked", store.rows.find((r) => r.reference === a.h.reference).status, "cancelled");
  eq("owner cancelled a paid booking: slot is free again", (await checkAvailability(store, { date, time: "10:00" })).code, "available");

  const b = await book("11:00");
  store.rows = store.rows.filter((r) => r.reference !== b.h.reference);
  const gone = await verifyPayment(store, pay, { reference: b.h.reference });
  eq("owner deleted a paid booking's row: paid_booking_missing (never 'reserved')", gone.code, "paid_booking_missing");
}

console.log(failures ? `\n${failures} UNIT FAILED\n` : "\nUNIT ALL PASSED\n");
process.exit(failures ? 1 : 0);
