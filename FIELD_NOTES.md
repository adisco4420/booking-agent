# Deployment field notes (working log)

Log each problem the moment it happens: the time, the exact error, and every step you took to find the cause, including dead ends. The write-up uses the brief's four parts. **Part 2 (how you found the cause) is what they read most closely**, so record the evidence as you go: which log line, which request, what you ruled out.

Aim for 2 to 3 strong notes in the submission. Pick the ones with the clearest diagnosis and the most actionable product feedback.

## Template

### N. <short title>
1. **What happened** (with the exact error message or behaviour, and when)
2. **How I worked out the cause** (evidence, what I checked, what I ruled out)
3. **How I fixed it or worked around it**
4. **What I'd change in Chord, its docs or its API** (specific enough that the team could ship it next week)

---

## Already hit during deployment (write these up now, while fresh)

### A. Paystack redirect after payment went to the wrong place (PUBLIC_BASE_URL)
1. **What happened**: TODO: what the customer saw after paying (URL it landed on, error page?), and when.
2. **How I worked out the cause**: TODO: e.g. the callback_url in the Paystack initialize request / server logs showed `<value>`; traced to PUBLIC_BASE_URL in Coolify.
3. **How I fixed it**: set PUBLIC_BASE_URL to https://booking-agent-mcp.vasrefil.com in Coolify and redeployed. TODO: confirm.
4. **What I'd change**: TODO (if Chord-related; otherwise frame as a deploy-checklist lesson, e.g. the server could refuse to boot when PUBLIC_BASE_URL is localhost in production).

### B. Coolify env var changes need a Redeploy, not a Restart
1. **What happened**: TODO: which variable, what still behaved the old way.
2. **How I worked out the cause**: TODO: e.g. /health still showed the old value / logs at boot.
3. **How I fixed it**: Redeploy after every env change.
4. **What I'd change**: TODO (Coolify UI hint; for Chord, the analogous trap is skill draft vs publish, see seed 2).

### C. Paystack test mode rate-limits payment-link creation (about 4 at once)
1. **What happened**: under a burst-load test, holds past roughly the 4th concurrent request got `payment_link_failed`. TODO: exact Paystack error text and HTTP status (the server now logs the reason).
2. **How I worked out the cause**: TODO: e.g. the logged reason, it only happened above N concurrent, single requests fine.
3. **How I fixed it**: the slot is released cleanly and the customer is told to retry, so nobody is left holding a phantom slot. 429s are retried with backoff.
4. **What I'd change**: not Chord. Note for the go-live risk list: real launch traffic is low, but a promo blast could hit it.

## Seeds to confirm in Chord (keep or drop based on what actually happens)

### 1. MCP server must be public HTTPS; localhost is blocked
- Capture: the exact error if you register a local or private URL first, and whether tool discovery gives a clear message or a generic failure.

### 2. Skill draft vs published
- Capture: what the agent does in the simulator when the skill is only saved as a draft (does it silently ignore it?). Screenshot the Instructions badge before and after publishing.

### 3. Sheet write after payment (consistency)
- Built: retries, then reconciliation log, and the customer is told their deposit is safe. Demo with `/admin/chaos` (ENABLE_CHAOS=true).
- Capture: how Chord handles a slow tool call (backoff can add seconds). Does the agent time out, retry, or wait?

## Other things to watch for in Chord

- How the bearer token is sent: is there header config at registration? Any `401 on /mcp ... auth header missing` lines in the server logs while registering mean it isn't being sent.
- Does Chord call `GET /mcp` (SSE) and choke on the 405? The server logs every request with its user agent.
- Does Chord give the agent the customer's WhatsApp number (for the `phone` arg)?
- Does the model use `today` from check_availability, or make up dates?
- Tool allowlist: what happens if `enabled_tools` has a typo (silent drop or error)?
- Credits: how fast do simulator conversations use them? Note the count before and after a full booking.

## Log

| Time | What | Exact error / observation | How I found the cause | Fix |
|---|---|---|---|---|
| | | | | |
