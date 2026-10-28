import express, { type NextFunction, type Request, type Response } from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BUSINESS, DEPOSIT_NGN, HOLD_MINUTES } from "./config.js";
import { ChaosStore, MemoryStore, SheetsStore, type Store } from "./store.js";
import { MockPayments, PaystackPayments, type Payments } from "./paystack.js";
import { checkAvailability, holdSlotAndCreateDeposit, verifyPayment } from "./booking.js";

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";
const STORE = process.env.STORE ?? "sheets"; // sheets | memory
const PAYMENTS = process.env.PAYMENTS ?? "paystack"; // paystack | mock

if (MCP_BEARER_TOKEN.length < 24) {
  console.error("MCP_BEARER_TOKEN must be set (24+ chars). Generate one with: openssl rand -hex 32");
  process.exit(1);
}

mkdirSync(dirname(process.env.RECON_LOG_PATH ?? "./data/reconciliation.jsonl"), { recursive: true });

// Demo-only failure injection, flipped at runtime via POST /admin/chaos.
// Off unless ENABLE_CHAOS=true, so a normal deployment has no way to break its own writes.
const CHAOS_ENABLED = process.env.ENABLE_CHAOS === "true";
const chaos = { failConfirmWrites: CHAOS_ENABLED && process.env.CHAOS_FAIL_CONFIRM_WRITES === "true" };
if (CHAOS_ENABLED) console.warn("[CHAOS] failure injection is enabled (ENABLE_CHAOS=true). Demo use only.");

let baseStore: Store;
if (STORE === "memory") {
  baseStore = new MemoryStore();
} else {
  const sheets = new SheetsStore(
    required("GOOGLE_SHEET_ID"),
    process.env.GOOGLE_SHEET_TAB ?? "Bookings",
    Buffer.from(required("GOOGLE_SERVICE_ACCOUNT_JSON_B64"), "base64").toString("utf8"),
  );
  await sheets.ensureHeader();
  baseStore = sheets;
}
const store: Store = CHAOS_ENABLED ? new ChaosStore(baseStore, () => chaos.failConfirmWrites) : baseStore;

const payments: Payments =
  PAYMENTS === "mock"
    ? new MockPayments(PUBLIC_BASE_URL)
    : new PaystackPayments(required("PAYSTACK_SECRET_KEY"), `${PUBLIC_BASE_URL}/paid`);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------- MCP server

const asText = (result: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
});

const safe = (name: string, fn: () => Promise<unknown>) =>
  fn().then(asText).catch((e: Error) => {
    console.error(`[tool:${name}] ${e.stack ?? e.message}`);
    return { ...asText({ ok: false, code: "internal_error", message: "Booking system error. Ask the customer to try again shortly." }), isError: true };
  });

const dateSchema = z.string().describe("Date in YYYY-MM-DD (Africa/Lagos).");
const timeSchema = z.string().describe("Slot start time in 24-hour HH:MM, e.g. 14:00.");

function buildServer(): McpServer {
  const server = new McpServer({ name: "salon-booking", version: "1.0.0" });

  server.registerTool(
    "check_availability",
    {
      title: "Check availability",
      description:
        `Check open slots at ${BUSINESS.name}. Returns today's date in Lagos (use it to resolve "today"/"tomorrow"). ` +
        "With only a date, lists free slots that day. With date and time, says whether that slot is free and suggests alternatives if not. " +
        "Codes: slots_listed, fully_booked, day_over, closed, available, slot_taken, outside_hours, in_past, too_far_ahead, invalid_date, invalid_time. " +
        "Read-only: does not reserve anything.",
      inputSchema: { date: dateSchema.optional(), time: timeSchema.optional() },
      annotations: { readOnlyHint: true },
    },
    (args) => safe("check_availability", () => checkAvailability(store, args)),
  );

  server.registerTool(
    "hold_slot_and_create_deposit",
    {
      title: "Hold slot and create deposit link",
      description:
        `Reserve a slot for ${HOLD_MINUTES} minutes and create a Paystack payment link for the NGN ${DEPOSIT_NGN} deposit. ` +
        "Call only after the customer has confirmed name, service, date and time. The booking is NOT confirmed until verify_payment returns code 'booked'. " +
        "If code is 'slot_taken', offer the returned alternatives.",
      inputSchema: {
        name: z.string().trim().min(1).max(100).describe("Customer's name."),
        service: z.string().describe(`Service key or label. One of: ${Object.keys(BUSINESS.services).join(", ")}.`),
        date: dateSchema,
        time: timeSchema,
        phone: z.string().optional().describe("Customer's WhatsApp number, if known."),
        email: z.string().optional().describe("Customer email for the Paystack receipt, only if they offered one."),
      },
    },
    (args) => safe("hold_slot_and_create_deposit", () => holdSlotAndCreateDeposit(store, payments, args)),
  );

  server.registerTool(
    "verify_payment",
    {
      title: "Verify deposit payment",
      description:
        "Check the deposit for a booking reference with Paystack and update the booking. " +
        "Codes: booked, already_booked, awaiting_payment, payment_failed, payment_processing, released_unpaid, paid_slot_conflict, paid_needs_manual_record, paid_booking_missing, cancelled, amount_mismatch, unknown_reference. " +
        "Call when the customer says they have paid. Safe to call more than once.",
      inputSchema: { reference: z.string().describe("Booking reference returned by hold_slot_and_create_deposit, e.g. FF-261024-A1B2C3.") },
      annotations: { idempotentHint: true },
    },
    (args) => safe("verify_payment", () => verifyPayment(store, payments, args)),
  );

  return server;
}

// ---------------------------------------------------------------- HTTP

const app = express();
app.set("trust proxy", true); // behind Coolify's Traefik
app.use(express.json({ limit: "256kb" }));

app.use((req, _res, next) => {
  if (req.path !== "/health") console.log(`${new Date().toISOString()} ${req.method} ${req.path} ua=${req.get("user-agent") ?? "-"}`);
  next();
});

function requireBearer(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(MCP_BEARER_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn(`401 on ${req.path} from ${req.ip} (auth header ${header ? "present" : "missing"})`);
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, store: STORE, payments: PAYMENTS, ...(CHAOS_ENABLED && { chaos }) });
});

// Stateless Streamable HTTP: a fresh server + transport per request, no session affinity needed.
app.post("/mcp", requireBearer, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// Paystack callback_url lands here after checkout. Verification still happens in verify_payment.
app.get("/paid", (req, res) => {
  const ref = String(req.query.reference ?? req.query.trxref ?? "").replace(/[^A-Za-z0-9-]/g, "");
  res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BUSINESS.name}</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h2>Thanks, you're nearly done</h2>
<p>Go back to WhatsApp and reply <b>paid</b> so we can confirm your slot.</p>
${ref ? `<p style="color:#666">Reference: ${ref}</p>` : ""}
</body>`);
});

// Demo-only: toggle failure injection during the screen recording.
if (CHAOS_ENABLED) {
  app.post("/admin/chaos", requireBearer, (req, res) => {
    if (typeof req.body?.failConfirmWrites === "boolean") chaos.failConfirmWrites = req.body.failConfirmWrites;
    console.warn(`[CHAOS] failConfirmWrites=${chaos.failConfirmWrites}`);
    res.json(chaos);
  });
}

if (payments instanceof MockPayments) {
  const mock = payments;
  app.get("/mock-pay/:ref", (req, res) => {
    const ref = req.params.ref;
    const amt = mock.expected.get(ref);
    if (amt === undefined) {
      res.status(404).send("unknown reference");
      return;
    }
    if (req.query.outcome === "failed") {
      mock.failed.add(ref); // simulate a declined card; the link can be retried
      res.status(402).send("card declined (mock)");
      return;
    }
    mock.failed.delete(ref);
    mock.paid.set(ref, amt);
    res.redirect(`/paid?reference=${ref}`);
  });
}

app.listen(PORT, () => {
  console.log(`salon-booking MCP on :${PORT} (store=${STORE}, payments=${PAYMENTS}) public=${PUBLIC_BASE_URL}/mcp`);
});
