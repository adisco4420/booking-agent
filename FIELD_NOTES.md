# Deployment field notes

These are the problems I hit while building and deploying the booking agent. Notes 1, 5 and 6 are about Chord. Notes 2 to 4 come from my MCP server and the two systems behind it, Paystack and Google Sheets; most of those turned up during a pressure test I ran with Claude Code against the deployed server (real Sheet, Paystack test mode, Paystack's real test checkout driven in a headless browser). Wherever I name a cause, the evidence is from logs and traces, not guesses.

## 1. The teammate sometimes answered without calling its tool, and Chord never contacted my server

**What happened.** On turns where the customer says they've paid, the teammate must call `verify_payment` before replying. Occasionally it didn't. On 29 Oct at 00:00:53 (Lagos) it told a customer "You're booked, Sodiq!" without checking Paystack; the Sheet row stayed `pending` until a later turn ran the tool. On 29 Oct at 00:54:23, after I had paid, it replied "I'm sorry, Sodiq, but I wasn't able to run the payment check just now", and the next "Paid" booked me normally. It happened 2 times in about 32 payment-check turns.

**How I worked out the cause.** Chord's thread data (`GET /v1/threads/{id}/turns`) records `tools_used` on every agent turn. On both bad turns it was empty while `skill_execution_id` was present, so the reply ran under my published skill but with no tool call. Both came back in 2 to 3 seconds instead of the usual 4 to 11, though one normal turn also took 2.9 s with the tool, so speed alone isn't proof. Then I lined the 00:54 conversation up against my MCP server's request log, which records every request with a UTC timestamp. Every other tool call in that chat appears as a `POST /mcp` 1 to 2 seconds before its reply. Around the skipped turn there is nothing: no request between 23:53:48 and 23:54:58 UTC, while my Paystack redirect (`GET /paid` at 23:54:00) shows I had already paid. Chord never contacted the server on that turn, so my server, Paystack and the Sheet are ruled out. To find a trigger I scripted 5 reproduction runs in the simulator, varying repeated "Paid" messages, the exact slot-taken flow, leaving for the checkout tab and coming back, the first "Paid" after a real payment, and 2-second reply gaps. 14 of 14 turns called the tool, so it is intermittent rather than tied to how the customer writes. Chord's route tester only covers REST connections ("No endpoints available"), so I couldn't see how MCP tools are chosen for a turn, and because Chord lists my tools once per conversation, my server log can't tell "tools not offered" apart from "offered but not called". The agent's own wording points to the first.

**How I fixed it or worked around it.** I can't force the tool call from outside Chord, so I made the failure safe through the skill (published versions 4 and 5): any message that means "I've paid" must trigger `verify_payment` in that same turn; "booked" or "confirmed" may only be said if that call returned `booked` in this turn; the agent may not invent corrections to earlier replies; and it's told that its earlier tool calls aren't shown to it in the chat history. Before that last rule it kept apologising for "not checking" when the log showed it had. After the change, a skipped turn produces an honest "I couldn't check, please try again" instead of a false confirmation. The production fix is a Paystack `charge.success` webhook, so the booking record never depends on the agent remembering to check.

**What I'd change in Chord.**
- Record in each reply's metadata whether tools were offered on that turn, and if not, why (router decision, fallback mode). "Why this reply" would be the natural place.
- Let a skill mark a tool as required before certain claims, or flag replies that state a booking or payment status with no tool call behind them.
- Carry earlier tool calls and results into the next turn's context on customer channels, or document that they aren't carried.
- Extend the route tester to MCP servers.

## 2. Paying customers landed on a dead page, and my logs showed nothing wrong

**What happened.** On 23 Oct I ran the first full booking against the live server at booking-agent-mcp.vasrefil.com. On my side everything worked: the hold was written to the sheet, the Paystack test card went through, and `verify_payment` came back `booked`. But in the browser, after paying, the customer landed on Chrome's error page instead of my "go back to WhatsApp and reply paid" page.

**How I worked out the cause.** The server logs were clean, because from the server's point of view nothing had failed. The redirect happens between Paystack and the customer's browser, so my server never sees it. First I ruled out the page itself: opening `/paid?reference=...` directly on the live domain loaded fine. Then I made a second test booking and logged every page the browser went to after paying. Paystack was sending the customer to `https://salon-mcp.vasrefil.com/paid?trxref=FF-261218-F13B3A&reference=FF-261218-F13B3A`, which failed with `net::ERR_NAME_NOT_RESOLVED`. `salon-mcp` was a subdomain I'd planned early on and never created. My server builds Paystack's callback URL from `PUBLIC_BASE_URL`, and in Coolify that variable still had the old value.

**How I fixed it.** I set `PUBLIC_BASE_URL=https://booking-agent-mcp.vasrefil.com` in Coolify and redeployed. The next test booking (FF-261218-C9F444) redirected to the right page. Worth knowing: the callback URL is fixed when the payment link is created, so links made before the fix still point at the dead domain.

**What I'd change.** This one was my config, not Chord's. Two things would have caught it in minutes instead of by luck:
- In my server: at boot, check that `PUBLIC_BASE_URL` resolves and serves `/health`, and log a loud warning if it doesn't.
- In Paystack: the initialize response doesn't echo back the `callback_url` it stored. If it did, my server could log it on every new payment link, and this would have been visible in the first log line.

## 3. The owner's sheet read typed dates the American way

**What happened.** The owner's Google Sheet is the agent's diary, and the owner adds walk-ins by typing straight into it. A Lagos owner types `10/12/2026` meaning 10 December. While reviewing how hand-typed rows are read, I found that the sheet's locale was United States. That means Sheets stores `10/12/2026` as 12 October the moment it's typed, before my server ever reads it. The walk-in would block the wrong day and leave the real one open for a double booking. The same review found a second trap: a time typed as a bare `14` is stored as the number 14, and my parser turned that into midnight, so the walk-in silently blocked nothing.

**How I worked out the cause.** The `14` one showed up in a unit test: `normalizeTime(14)` returned `00:00`. For the dates, I added a boot check that reads the spreadsheet's locale over the Sheets API. On the first deploy with that check, the Coolify logs printed `[SHEET] Locale is en_US: dates typed like 10/12/2026 are read month-first.` That confirmed the risk was live, not theoretical.

**How I fixed it.** I went to change the locale to Nigeria, but Google Sheets doesn't list Nigeria. I used United Kingdom, which also reads dates day first, and set the time zone to Lagos. On the server side, it now reads raw cell values so the display format can't confuse it. It accepts the formats an owner is likely to type (`10/12/2026`, `10 Dec`, `5pm`, `17:00`), treats a blank status as booked, and logs any row it can't place on a slot as `[SHEET] Row N ... blocks nothing`. I checked it on the live sheet by typing only a date (`10/12/2026`) and a time (`17:00`) into an empty row. The agent then reported 10 Dec at 17:00 as `slot_taken`, and the rest of that day as free.

**What I'd change.** For Chord's docs: many Nigerian businesses will keep their back office in Google Sheets, so any guide on tools that read business data from Sheets should say two things up front. Set the spreadsheet locale to a day-first one (United Kingdom, since Nigeria isn't offered), and read cells unformatted. It's a one-paragraph note that saves a silent double booking.

## 4. Under a burst, two rate limits stacked, and I blamed the wrong one first

**What happened.** In the pressure test I sent 30 availability checks and 10 bookings at the same moment. They were split across two copies of the production server, against the real sheet and Paystack test mode. 7 of the 10 bookings came back `payment_link_failed`.

**How I worked out the cause.** The only error in the logs was one reconciliation entry: `Sheets GET 429: Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'`. So I assumed Google Sheets was the problem and added retries with backoff. I also noticed my server wasn't logging why Paystack link creation failed; the reason only went into the sheet's Note column. So I added that logging too, and reran. Six bookings still failed, and every one logged `Paystack initialize failed (429): Rate limit exceeded!`. There were two separate limits. Google Sheets allows 60 reads a minute per service account, and each booking costs about three. Paystack test mode turned away link creation past about four at once.

**How I fixed it.** Availability checks now share a cached read for 5 seconds. Bookings always read fresh, so the cache can't cause a double booking. Both Sheets and Paystack 429s are retried with backoff. In the final run the Sheets 429s were gone, and the median response time under the burst dropped from about 1.5 s to 0.7 s. Paystack still refused 6 of 10 links even after 7 seconds of retries. For one barbershop I've accepted that: those customers' slots are released straight away and the agent tells them to try again in a minute, so nobody is left holding a slot they can't pay for.

**What I'd change.**
- For Paystack: document the test-mode rate limits and send a `Retry-After` header with the 429. The body only says `Rate limit exceeded!`, so I had to guess the backoff.
- For Chord: retries make a tool call slow (the slowest call in the burst took 13.7 s). I couldn't find Chord's timeout for a tool call in the docs. If it were documented, I could size my retries to finish inside it instead of guessing.

## 5. Chord: which API key scopes does connecting my own MCP server need?

**What happened.** Before starting, I needed an API key that could register my MCP server and attach it to my teammate. From the endpoint reference I worked out I'd need `mcp:create`, `mcp:read`, `mcp:manage`, `teammate:read` and `teammate:update`. What I couldn't tell was whether a key I created myself was allowed those scopes, or whether TSG Labs would have to register the server for me.

**How I worked out the cause.** The docs list the scope each endpoint needs, but not which scopes an account can grant, and there's no single place that says "to connect your own MCP server, you need these." So I asked support. The answer: "The scoped API key you create will only have access to what you need for your build. If you're unsure, feel free to create a key with all access."

**How I fixed it or worked around it.** In the end I didn't need a key. The Chord app has the same flow under Admin, then Channels & Tools, then Tools, then Custom tools (MCP), then Add server, with fields for the URL, auth type, token, transport and an allowed-tools list. I registered `https://booking-agent-mcp.vasrefil.com/mcp` there with auth type `bearer` and the three tool names. Chord's health probe returned `ok` in 607 ms and discovery listed all three tools first time. Two things worth knowing: the form's Auth type defaults to `none`, so a pasted token isn't sent unless you change it; and the API guide's advice to register a server disabled clashes with its own note that a disabled server doesn't send its stored token to the health and discovery probes.

**What I'd change.** Add a short page per workflow, starting with "Connect your own MCP server", that lists exactly the scopes it needs, and offer a matching preset when you create a key. "If you're unsure, use all access" is the answer most builders will take, which leaves a lot of over-privileged keys sitting in `.env` files. Related: the steps to give the WhatsApp simulator access (Admin Panel, then Connected Apps, then Allow approved apps) reached me by email. The "Build your first teammate" guide says the simulator "needs its own Chord Connect approval, organization access and consent" but doesn't give the click path. Adding those three steps there would save the next builder an email. And if `none` stays the default auth type, the form could warn when a token is pasted with it.

## 6. Chord told me, the workspace owner, it couldn't confirm my activation access

**What happened.** On 28 Oct at about 16:14 (Lagos), on Create a teammate, then Review, switching Autonomy to "Act independently" turned off "Activate after setup", locked the toggle, and showed: "We couldn't confirm activation access. Setup will finish with a paused teammate; an authorized admin can activate it from Settings." I own the workspace. Going back and repeating the same steps a few minutes later worked normally, and I couldn't reproduce it.

**How I worked out the cause.** The browser's network log for that page showed the workspace permission check, `GET /v1/workspaces/{ws}/governance`, returning 401. It was followed immediately by `POST /api/auth/refresh` returning 200, and every later governance request returned 200. My session token had expired, and the page read the failed permission check as "you don't have access". The log has no wall-clock times, so I can't prove this is the 16:14 request, but it is the only failed permission check in the log and the sequence matches what I saw. The same session expiry hit me several more times while working, as 401 `Missing or malformed Authorization header` errors until the page refreshed its token.

**How I fixed it or worked around it.** I redid the review step after the session refreshed. Had I not noticed, the teammate would have been created paused, and I'd have gone looking for a permissions problem that didn't exist.

**What I'd change.** When a permission check returns 401, refresh the session and retry before showing a permission message. If it still fails, say "We couldn't check your permissions (your session expired). Retry", not something that implies the user lacks access.

## Smaller Chord observations

- **Skill name ignored on upload.** My SKILL.md frontmatter says `name: salon-booking`, but the uploaded skill was stored as "Untitled skill" (confirmed in `GET /v1/teammates/{id}/skills`). The name can be fixed in the Edit skill draft dialog, but only after the teammate exists. Reading `name` from the frontmatter, or showing the field on the review screen, would fix it.
- **Draft versus published works as documented.** After saving an edit, the panel showed "Draft not live. Replies and simulator tests use published v1." until I chose Publish skill. Clear in the app; worth repeating in any guide that tells builders to edit a skill.
- **Tool detail differs by channel.** Direct-line replies keep a "How I did this" block with each tool's input and output; simulator conversations only record the tool names. For debugging customer-channel replies, the full blocks would have saved me an afternoon.
- **The simulator's "Start a new conversation" button** asks for confirmation with a browser dialog, so it does nothing in embedded browsers that suppress dialogs.
