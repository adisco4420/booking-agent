// One-command test: boots the server in memory/mock mode on a spare port and runs the smoke checks.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unit checks for sheet-cell parsing first (no server needed).
const unit = spawn("npx", ["tsx", "scripts/unit.mjs"], { stdio: "inherit" });
const unitCode = await new Promise((r) => unit.on("exit", r));
if (unitCode !== 0) process.exit(unitCode ?? 1);

const port = 3900 + Math.floor(Math.random() * 90);
const token = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  STORE: "memory", PAYMENTS: "mock", HOLD_MINUTES: "0.05", ENABLE_CHAOS: "true",
  PORT: String(port), MCP_BEARER_TOKEN: token,
  RECON_LOG_PATH: join(mkdtempSync(join(tmpdir(), "salon-test-")), "reconciliation.jsonl"),
};

const server = spawn("npx", ["tsx", "src/index.ts"], { env, stdio: ["ignore", "ignore", "inherit"] });
const stop = () => server.kill();
process.on("exit", stop);

for (let i = 0; ; i++) {
  try { if ((await fetch(`http://localhost:${port}/health`)).ok) break; } catch {}
  if (i > 60) { console.error("server did not start"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}

const smoke = spawn("node", ["scripts/smoke.mjs"], {
  env: { ...process.env, MCP_URL: `http://localhost:${port}/mcp`, MCP_BEARER_TOKEN: token },
  stdio: "inherit",
});
smoke.on("exit", (code) => { stop(); process.exit(code ?? 1); });
