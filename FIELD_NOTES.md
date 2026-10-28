# Deployment field notes

These are the problems I hit while building and deploying the booking agent. Notes 1 to 3 come from my MCP server and the two systems behind it, Paystack and Google Sheets. Note 4 is from setting up Chord. Most of 1 to 3 turned up during a pressure test I ran with Claude Code against the deployed server: real Sheet, Paystack test mode, and Paystack's real test checkout driven in a headless browser. So the evidence below comes from logs and traces, not guesses.

## 1. Paying customers landed on a dead page, and my logs showed nothing wrong

**What happened.** On 23 Oct I ran the first full booking against the live server at booking-agent-mcp.vasrefil.com. On my side everything worked: the hold was written to the sheet, the Paystack test card went through, and `verify_payment` came back `booked`. But in the browser, after paying, the customer landed on Chrome's error page instead of my "go back to WhatsApp and reply paid" page.

**How I worked out the cause.** The server logs were clean, because from the server's point of view nothing had failed. The redirect happens between Paystack and the customer's browser, so my server never sees it. First I ruled out the page itself: opening `/paid?reference=...` directly on the live domain loaded fine. Then I made a second test booking and logged every page the browser went to after paying. Paystack was sending the customer to `https://salon-mcp.vasrefil.com/paid?trxref=FF-261218-F13B3A&reference=FF-261218-F13B3A`, which failed with `net::ERR_NAME_NOT_RESOLVED`. `salon-mcp` was a subdomain I'd planned early on and never created. My server builds Paystack's callback URL from `PUBLIC_BASE_URL`, and in Coolify that variable still had the old value.

**How I fixed it.** I set `PUBLIC_BASE_URL=https://booking-agent-mcp.vasrefil.com` in Coolify and redeployed. The next test booking (FF-261218-C9F444) redirected to the right page. Worth knowing: the callback URL is fixed when the payment link is created, so links made before the fix still point at the dead domain.

**What I'd change.** This one was my config, not Chord's. Two things would have caught it in minutes instead of by luck:
- In my server: at boot, check that `PUBLIC_BASE_URL` resolves and serves `/health`, and log a loud warning if it doesn't.
- In Paystack: the initialize response doesn't echo back the `callback_url` it stored. If it did, my server could log it on every new payment link, and this would have been visible in the first log line.

## 2. The owner's sheet read typed dates the American way

**What happened.** The owner's Google Sheet is the agent's diary, and the owner adds walk-ins by typing straight into it. A Lagos owner types `10/12/2026` meaning 10 December. While reviewing how hand-typed rows are read, I found that the sheet's locale was United States. That means Sheets stores `10/12/2026` as 12 October the moment it's typed, before my server ever reads it. The walk-in would block the wrong day and leave the real one open for a double booking. The same review found a second trap: a time typed as a bare `14` is stored as the number 14, and my parser turned that into midnight, so the walk-in silently blocked nothing.

**How I worked out the cause.** The `14` one showed up in a unit test: `normalizeTime(14)` returned `00:00`. For the dates, I added a boot check that reads the spreadsheet's locale over the Sheets API. On the first deploy with that check, the Coolify logs printed `[SHEET] Locale is en_US: dates typed like 10/12/2026 are read month-first.` That confirmed the risk was live, not theoretical.

**How I fixed it.** I went to change the locale to Nigeria, but Google Sheets doesn't list Nigeria. I used United Kingdom, which also reads dates day first, and set the time zone to Lagos. On the server side, it now reads raw cell values so the display format can't confuse it. It accepts the formats an owner is likely to type (`10/12/2026`, `10 Dec`, `5pm`, `17:00`), treats a blank status as booked, and logs any row it can't place on a slot as `[SHEET] Row N ... blocks nothing`. I checked it on the live sheet by typing only a date (`10/12/2026`) and a time (`17:00`) into an empty row. The agent then reported 10 Dec at 17:00 as `slot_taken`, and the rest of that day as free.

**What I'd change.** For Chord's docs: many Nigerian businesses will keep their back office in Google Sheets, so any guide on tools that read business data from Sheets should say two things up front. Set the spreadsheet locale to a day-first one (United Kingdom, since Nigeria isn't offered), and read cells unformatted. It's a one-paragraph note that saves a silent double booking.

## 3. Under a burst, two rate limits stacked, and I blamed the wrong one first

**What happened.** In the pressure test I sent 30 availability checks and 10 bookings at the same moment. They were split across two copies of the production server, against the real sheet and Paystack test mode. 7 of the 10 bookings came back `payment_link_failed`.

**How I worked out the cause.** The only error in the logs was one reconciliation entry: `Sheets GET 429: Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'`. So I assumed Google Sheets was the problem and added retries with backoff. I also noticed my server wasn't logging why Paystack link creation failed; the reason only went into the sheet's Note column. So I added that logging too, and reran. Six bookings still failed, and every one logged `Paystack initialize failed (429): Rate limit exceeded!`. There were two separate limits. Google Sheets allows 60 reads a minute per service account, and each booking costs about three. Paystack test mode turned away link creation past about four at once.

**How I fixed it.** Availability checks now share a cached read for 5 seconds. Bookings always read fresh, so the cache can't cause a double booking. Both Sheets and Paystack 429s are retried with backoff. In the final run the Sheets 429s were gone, and the median response time under the burst dropped from about 1.5 s to 0.7 s. Paystack still refused 6 of 10 links even after 7 seconds of retries. For one barbershop I've accepted that: those customers' slots are released straight away and the agent tells them to try again in a minute, so nobody is left holding a slot they can't pay for.

**What I'd change.**
- For Paystack: document the test-mode rate limits and send a `Retry-After` header with the 429. The body only says `Rate limit exceeded!`, so I had to guess the backoff.
- For Chord: retries make a tool call slow (the slowest call in the burst took 13.7 s). I couldn't find Chord's timeout for a tool call in the docs. If it were documented, I could size my retries to finish inside it instead of guessing.

## 4. Chord: which API key scopes does connecting my own MCP server need?

**What happened.** Before starting, I needed an API key that could register my MCP server and attach it to my teammate. From the endpoint reference I worked out I'd need `mcp:create`, `mcp:read`, `mcp:manage`, `teammate:read` and `teammate:update`. What I couldn't tell was whether a key I created myself was allowed those scopes, or whether TSG Labs would have to register the server for me.

**How I worked out the cause.** The docs list the scope each endpoint needs, but not which scopes an account can grant, and there's no single place that says "to connect your own MCP server, you need these." So I asked support. The answer: "The scoped API key you create will only have access to what you need for your build. If you're unsure, feel free to create a key with all access."

**How I fixed it or worked around it.** [Fill in after setup: which scopes you actually picked, and whether registration, discovery and the tool allowlist worked first time.]

**What I'd change.** Add a short page per workflow, starting with "Connect your own MCP server", that lists exactly the scopes it needs, and offer a matching preset when you create a key. "If you're unsure, use all access" is the answer most builders will take, which leaves a lot of over-privileged keys sitting in `.env` files. Related: the steps to give the WhatsApp simulator access (Admin Panel, then Connected Apps, then Allow approved apps) reached me by email. [Check the docs: if they aren't there, say so and suggest adding them to the simulator page.]

---

## To capture during Chord setup (delete this section before submitting)

Log anything that happens as it happens, with the exact error text and a timestamp. The strongest final set is probably notes 1 and 3, plus the best Chord problem from this list.

- Registering the MCP server: is the bearer token set as a header at registration? Any `401 on /mcp ... auth header missing` in the Coolify logs means it isn't being sent.
- Does Chord call `GET /mcp` and fail on the 405? The server logs every request with its user agent.
- Tool discovery and the `enabled_tools` allowlist: what happens with a typo? A silent drop, or an error?
- Skill draft versus publish: what does the agent do in the simulator while the skill is only a draft? Screenshot the Instructions badge before and after publishing.
- Does Chord pass the customer's WhatsApp number to the agent, for the `phone` argument?
- Does the model use `today` from `check_availability`, or make up dates?
- Credits: note the balance before and after each simulator conversation.
