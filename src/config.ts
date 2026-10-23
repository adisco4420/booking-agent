// Business configuration. Swap these for the real salon before recording.
// Everything the agent quotes (services, prices, hours) should come from here
// or from SKILL.md, and the two must agree.

export const TIMEZONE_OFFSET = "+01:00"; // Africa/Lagos, no DST

/** Reads a numeric env var and exits at boot if it is not a usable positive number. */
function envNumber(name: string, fallback: number, integer = false): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    console.error(`${name} must be a positive ${integer ? "whole " : ""}number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

export const BUSINESS = {
  name: process.env.BUSINESS_NAME ?? "Fade & Finesse Studio",
  // Opening hours per weekday (0 = Sunday). null = closed.
  hours: {
    0: null,
    1: { open: "09:00", close: "19:00" },
    2: { open: "09:00", close: "19:00" },
    3: { open: "09:00", close: "19:00" },
    4: { open: "09:00", close: "19:00" },
    5: { open: "09:00", close: "20:00" },
    6: { open: "08:00", close: "20:00" },
  } as Record<number, { open: string; close: string } | null>,
  slotMinutes: 60,
  // How many customers can be served in the same slot (number of chairs).
  chairs: envNumber("CHAIRS", 1, true),
  // Every service fits one slot. Multi-slot services are out of scope (see README).
  services: {
    "haircut": { label: "Haircut", priceNgn: 5000 },
    "haircut-and-beard": { label: "Haircut + beard trim", priceNgn: 7000 },
    "beard-trim": { label: "Beard trim", priceNgn: 3000 },
    "kids-haircut": { label: "Kids haircut", priceNgn: 4000 },
  } as Record<string, { label: string; priceNgn: number }>,
};

export const DEPOSIT_NGN = envNumber("DEPOSIT_NGN", 2000, true);
export const HOLD_MINUTES = envNumber("HOLD_MINUTES", 15);
/** How far ahead customers may book, in days from today (Lagos). */
export const MAX_DAYS_AHEAD = envNumber("MAX_DAYS_AHEAD", 60, true);

const cheapest = Math.min(...Object.values(BUSINESS.services).map((s) => s.priceNgn));
if (DEPOSIT_NGN > cheapest) {
  console.error(`DEPOSIT_NGN (${DEPOSIT_NGN}) is more than the cheapest service (${cheapest}); the balance would be negative.`);
  process.exit(1);
}
