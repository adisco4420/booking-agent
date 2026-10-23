// End-to-end smoke test over real Streamable HTTP, using the MCP SDK client.
// Run against a local server started with STORE=memory PAYMENTS=mock HOLD_MINUTES=0.05.
//   MCP_URL=http://localhost:3000/mcp MCP_BEARER_TOKEN=... npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const BASE = URL_.replace(/\/mcp$/, "");
const TOKEN = process.env.MCP_BEARER_TOKEN;
const auth = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n      ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: auth } }));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const pay = (paymentUrl) => fetch(paymentUrl, { redirect: "manual" });

// 0. Auth and discovery
const unauth = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("rejects missing bearer token with 401", unauth.status === 401, unauth.status);
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("exposes exactly the three tools", JSON.stringify(tools) === JSON.stringify(["check_availability", "hold_slot_and_create_deposit", "verify_payment"]), tools);

// Find an open day at least 2 days out with a few free slots.
const today = (await call("check_availability", {})).today;
let date, slots;
for (let i = 2; i < 10; i++) {
  const d = new Date(`${today}T12:00:00+01:00`); d.setUTCDate(d.getUTCDate() + i);
  const r = await call("check_availability", { date: d.toISOString().slice(0, 10) });
  if (r.freeSlots?.length >= 6) { date = r.date; slots = r.freeSlots; break; }
}
check("found an open test day", !!date, { today });
const [s1, s2, s3, s4, s5] = slots;
const who = { name: "Tunde", service: "haircut", phone: "+2348000000000" };

// 1. Happy path
let h = await call("hold_slot_and_create_deposit", { ...who, date, time: s1 });
check("happy: slot held with payment link", h.code === "held" && h.paymentUrl, h);
check("happy: slot now shows taken", (await call("check_availability", { date, time: s1 })).code === "slot_taken");
check("happy: verify before paying = awaiting_payment", (await call("verify_payment", { reference: h.reference })).code === "awaiting_payment");
await pay(h.paymentUrl);
check("happy: verify after paying = booked", (await call("verify_payment", { reference: h.reference })).code === "booked");
check("happy: verify again is idempotent", (await call("verify_payment", { reference: h.reference })).code === "already_booked");

// 2. Failure path 1: race for the same slot
const [a, b] = await Promise.all([
  call("hold_slot_and_create_deposit", { ...who, name: "Ada", date, time: s2 }),
  call("hold_slot_and_create_deposit", { ...who, name: "Bola", date, time: s2 }),
]);
const codes = [a.code, b.code].sort();
check("race: exactly one hold wins", JSON.stringify(codes) === JSON.stringify(["held", "slot_taken"]), codes);
const loser = a.code === "slot_taken" ? a : b;
check("race: loser gets alternatives", loser.alternatives?.length > 0, loser);

// 3. Failure path 2: deposit abandoned, hold expires (HOLD_MINUTES=0.05 => 3s)
h = await call("hold_slot_and_create_deposit", { ...who, date, time: s3 });
await sleep(3500);
check("abandoned: slot free again after hold expiry", (await call("check_availability", { date, time: s3 })).code === "available");
let v = await call("verify_payment", { reference: h.reference });
check("abandoned: verify releases the hold", v.code === "released_unpaid", v);

// 3b. Paid after expiry, slot taken by someone else in the meantime
h = await call("hold_slot_and_create_deposit", { ...who, name: "Late", date, time: s4 });
await sleep(3500);
const other = await call("hold_slot_and_create_deposit", { ...who, name: "Early", date, time: s4 });
await pay(h.paymentUrl);
v = await call("verify_payment", { reference: h.reference });
check("late payer: paid_slot_conflict with alternatives", v.code === "paid_slot_conflict" && v.alternatives?.length, v);
check("late payer: other customer's hold untouched", other.code === "held", other);

// 4. Failure path 3: payment succeeds, sheet write fails
await fetch(`${BASE}/admin/chaos`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ failConfirmWrites: true }) });
h = await call("hold_slot_and_create_deposit", { ...who, date, time: s5 });
await pay(h.paymentUrl);
v = await call("verify_payment", { reference: h.reference });
check("sheet down: paid_needs_manual_record (booking not lost)", v.code === "paid_needs_manual_record", v);
await fetch(`${BASE}/admin/chaos`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ failConfirmWrites: false }) });
v = await call("verify_payment", { reference: h.reference });
check("sheet back: re-verify reconciles to booked", v.code === "booked", v);

// 5. Input guards
check("rejects unknown service", (await call("hold_slot_and_create_deposit", { ...who, service: "manicure", date, time: s1 })).code === "unknown_service");
check("rejects off-grid time", (await call("check_availability", { date, time: "14:30" })).code === "outside_hours");
let r = await call("check_availability", { date: "2020-01-06" });
check("past date = in_past with future alternatives", r.code === "in_past" && r.alternatives?.every((x) => x.date >= today), r);
r = await call("check_availability", { date: "2099-01-05" });
check("far-future date = too_far_ahead", r.code === "too_far_ahead" && !!r.lastBookableDate, r);
r = await call("hold_slot_and_create_deposit", { ...who, date: "2099-01-05", time: "10:00" });
check("hold refuses far-future date", r.code === "too_far_ahead", r);
r = await call("hold_slot_and_create_deposit", { ...who, email: "not-an-email", date, time: slots[5] });
check("malformed email still gets a hold", r.code === "held", r);

await client.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
