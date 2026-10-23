# Deployment field notes (working log)

Log problems the moment they happen: paste the exact error, the time, and what you tried. Write them up in the four-part format at the end. Aim for 2 to 3 strong ones.

Format per note:
1. **What I was trying to do**
2. **What happened** (exact error / behaviour, timestamp)
3. **What I did about it**
4. **What I'd change in Chord / the docs / the product**

---

## Seeds (confirm or discard with real evidence)

### 1. MCP server must be public HTTPS; localhost is blocked
- Expectation from docs: localhost and private addresses rejected at registration.
- To capture: the exact registration error if you try a local/tunnel URL first, and whether the discover-tools step surfaces a clear message or a generic failure.

### 2. Skill draft vs published
- Expectation: a saved draft is not live; you must Review and Publish, then the Instructions badge updates.
- To capture: what the agent does in the simulator when the skill is only drafted (does it silently ignore it?). Screenshot the badge before/after.

### 3. Sheet write after payment (consistency)
- Built: retry 3x, then reconciliation log, customer told "deposit safe". Demo with `/admin/chaos`.
- To capture: how Chord surfaces a slow tool call (retries add ~1.2s). Does the agent time out or wait?

## Other things worth watching for

- How Chord passes the bearer token: header config at registration? Any 401 lines in server logs (`401 on /mcp ... auth header missing`) while registering = it isn't being sent.
- Does Chord call `GET /mcp` (SSE) and choke on the 405? Server logs every request with user agent.
- Does Chord give the agent the customer's WhatsApp number (for the `phone` arg)?
- Does the model use `today` from check_availability, or hallucinate dates?
- Tool allowlist: what happens if `enabled_tools` has a typo (silent drop vs error)?
- Paystack: rejection of placeholder email domain? callback_url behaviour in the simulator's in-app browser?

## Log

| Time | What | Exact error / observation | Fix |
|---|---|---|---|
| | | | |
