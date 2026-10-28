# Salon booking agent on Chord

A WhatsApp booking agent for a Lagos barbershop, built on [Chord](https://tsglabs.dev). A customer picks a service and time in chat; the agent holds the slot in the shop's Google Sheet and sends a Paystack deposit link. **No deposit, no booking**: the slot is confirmed only after the payment is verified with Paystack.

## Why this job

Lagos barbers lose real money to no-shows on weekend slots, and bookings already happen on WhatsApp, just by hand. A small deposit is the standard fix, but chasing transfers and matching them to names in a notebook is the part owners hate. This agent does the chasing and the matching.

## How it fits together

```
Customer (WhatsApp) ─▶ Chord teammate (SKILL.md) ─▶ this MCP server (HTTPS, bearer token)
                                                      ├─▶ Google Sheets  (the shop's diary)
                                                      └─▶ Paystack test mode (deposit link + verify)
```

| Tool | Does |
|---|---|
| `check_availability(date?, time?)` | Reads the sheet. Returns Lagos `today` so the agent can resolve "tomorrow". Read-only. |
| `hold_slot_and_create_deposit(name, service, date, time, phone?, email?)` | Re-checks the slot, writes a `pending` row with a 15-min hold, creates a Paystack payment link. |
| `verify_payment(reference)` | Verifies with Paystack, then marks `booked`, keeps the hold, releases it, or flags it. Idempotent. |

Every result carries a machine-readable `code`; SKILL.md maps each code to what the agent says.

## The three failure paths

| Path | What happens | Where |
|---|---|---|
| **Slot taken mid-flow** | Hold re-checks under a per-slot lock, then reads the sheet back after writing. If another hold or a hand-entered walk-in landed first (earliest `Created` wins), ours is released and the customer gets the next 3 free slots. | `holdSlotAndCreateDeposit` |
| **Deposit abandoned** | Holds expire after `HOLD_MINUTES`. Expired holds stop blocking the slot immediately; `verify_payment` marks them `released`. If they pay after expiry and the slot is still free, they get it; if not, `paid_slot_conflict` and the owner is flagged. | `isActive`, `verifyPayment` |
| **Paid, but sheet write fails** | Paystack is checked first. The `booked` write is retried 3 times; if it still fails, the booking is written to a reconciliation log (persistent volume + stderr) and the customer is told their deposit is safe. Re-running `verify_payment` later completes the write. | `verifyPayment`, `reconcile` |

Also guarded: declined cards (`payment_failed`: the hold stays and the same link can be retried), amount/currency mismatch, unknown references, Paystack link failure (slot given back), off-grid or past times, dates beyond `MAX_DAYS_AHEAD`, live keys (server refuses to boot with `sk_live_`), and bad numeric settings (server refuses to boot).

## Run locally (no Google or Paystack needed)

```bash
npm install && npm run build
export MCP_BEARER_TOKEN=$(openssl rand -hex 32)
npm test           # unit checks for sheet-cell parsing, then boots a mock server and runs the smoke checks: happy path, all failure paths, auth, input guards

# or by hand:
STORE=memory PAYMENTS=mock HOLD_MINUTES=0.05 ENABLE_CHAOS=true npm start
npm run smoke      # in another shell, same MCP_BEARER_TOKEN
```

## Deploy (Coolify)

1. **Sheet**: create a Google Sheet with a tab `Bookings`. Create a GCP service account, enable the Sheets API, download its JSON key, and share the sheet with the service account's `client_email` as Editor. The header row is written on first boot.
2. **Coolify**: new resource from this repo, build pack Dockerfile, port 3000, set a domain (Coolify issues TLS). Add a persistent volume mounted at `/data`. Set env vars from `.env.example` (`GOOGLE_SERVICE_ACCOUNT_JSON_B64` = `base64 -w0 key.json`).
3. Check: `curl https://booking-agent-mcp.vasrefil.com/health`.
4. **Chord**: register `https://booking-agent-mcp.vasrefil.com/mcp` with header `Authorization: Bearer <MCP_BEARER_TOKEN>` (created disabled), scope it to the teammate, enable, discover tools, allowlist the three tool names.
5. **Skill**: upload `skill/SKILL.md`, then Review and **Publish** (a saved draft is not live). Check the Instructions badge before testing in the simulator.

### Demo switch for failure path 3

Only available when the server runs with `ENABLE_CHAOS=true`; leave it unset in a real deployment.

```bash
curl -X POST https://booking-agent-mcp.vasrefil.com/admin/chaos -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'content-type: application/json' -d '{"failConfirmWrites": true}'
```

To show the slot-taken path on camera: after the agent says a slot is free, type a walk-in row into the sheet for that date and time, then confirm in chat.

### Walk-ins typed by the owner

The owner can add a walk-in by typing a row with just a **Date**, **Time** and (optionally) **Status**; Reference can stay empty.

- Dates: any way Sheets accepts them (a real date cell), or plain text such as `10/12/2026` (day first), `10 Dec 2026`, `Dec 10` or `2026-12-10`. The diary is read unformatted, so the sheet's display format and locale don't matter.
- Times: a real time cell, or text such as `17:00`, `5pm`, `5:00 PM` or `17.00`.
- Status: blank, `booked`, `walk-in`, `confirmed` or `paid` all block the slot. Only `released` (or another non-booking word) frees it.

Rows the server can't read as a date and time are ignored, so a typo there won't block a slot. That's the one thing to check when a walk-in "didn't take".

## How I used AI tools

- **Claude (claude.ai)**: planning and problem choice discussion, reading the Chord docs to map the registration and skill-publish flow, and the first scaffold of the MCP server, SKILL.md and smoke test.
- **Claude Code**: code review and hardening (race on late payments, input guards, quota retries, hand-typed sheet cells), real-service QA against the deployed Docker image (Paystack test checkout driven with Playwright), and deploy verification on Coolify.
- **What I decided myself**: the business and problem, the FDE role, verify-on-return instead of webhooks for the demo, the deploy target, and what to leave out. I reviewed and tested every change before committing.
- The agent itself is built and run on Chord, as the brief requires.

## What is not production-ready (honestly)

- **Concurrency**: the lock is in-process. With more than one instance, correctness relies on the write-then-read-back check, which narrows the race but doesn't close it. Production: a real database with a unique constraint on `(date, time, chair)`, Sheets as a synced view.
- **Payment confirmation** is synchronous: the customer must come back and say "paid". Production: Paystack `charge.success` webhook (HMAC-verified) confirms the booking and messages the customer proactively; verify-on-return stays as the fallback.
- **API quotas**: Google Sheets allows 60 reads/min per service account, and a hold costs about 3 reads plus 2 writes, so the ceiling is roughly 15 holds a minute. Availability checks share a 5-second cached read, and Sheets and Paystack 429s are retried with backoff (up to about 15 s), so short bursts get slower rather than failing. Past that, ask Google for a quota increase or move the diary to a database.
- **Expired holds** are released lazily (on the next verify), so the sheet can show stale `pending` rows. They don't block slots. Production: a sweeper job.
- **Reconciliation log** is a file on one volume plus stderr. Production: alert the owner on WhatsApp/email and a durable queue.
- **One slot per service, single schedule**: no multi-hour services, no per-barber calendars, no reschedule/cancel tool.
- **Placeholder email** for Paystack, since it requires one and WhatsApp users rarely give it.
- **Bearer token** is a single static secret. Production: per-client tokens with rotation, or OAuth if Chord supports it.
- **Test mode only** by design.
