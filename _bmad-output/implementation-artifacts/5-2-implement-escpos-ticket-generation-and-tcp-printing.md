# Story 5.2: Implement ESC/POS Ticket Generation & TCP Printing

Status: review

- **Epic:** 5 — Ticket Output: ESC/POS Printing & KDS Display
- **Story ID:** 5.2
- **Requirements:** FR14, FR15, FR16, FR17, FR18; NFR-P1; sprint-change-proposal-2026-08-21 Changes E2, U3
- **Depends on:** 5.0 (the queue, the `TicketTransport` seam, `TicketPayload`, the retry ladder)
- **Blocks:** nothing. This is the last story on the demo path for Epic 5 — 5.1 and 5.3 are deferred while `kds_display_enabled = false`.

---

## ⚠️ Read this before starting

**`epics.md`'s Story 5.2 is the pre-rewrite version. Do not build it.** It describes a synchronous TCP
call inside the submit handler with an inline 5-second timeout, and a `printer:alert` meaning "failed,
reprint manually". Change E2 of `sprint-change-proposal-2026-08-21` replaced all of that, and Story 5.0
has already built the replacement: ticket delivery is a queued job with retries. `correct-course` still
owes `epics.md` both this rewrite and Story 5.0 itself.

What survives from the epic's version, verbatim: the ticket's CONTENT (`epics.md:1482`), one ticket per
destination (`epics.md:1478`), and the USB/TCP mode split. What is gone: the inline call, the 5-second
budget as a user-facing limit, and manual reprint as the recovery mechanism.

**The queue is finished and must not be re-opened.** Retry, backoff, dead-lettering, ordering and
recovery all work and are verified. This story writes bytes and opens a socket, behind an interface that
already exists. If you find yourself editing `worker.ts`, stop and re-read this line.

---

## Story

As kitchen and bar staff,
I want the tickets the queue holds to come out of the station's thermal printer, correctly formatted,
So that I can cook and pour from paper rather than from a screen I have to walk to.

---

## Acceptance Criteria

**AC-1 — One ticket per destination, typed**
**Given** a round containing kitchen, pizza-kitchen and bar items
**When** its jobs are delivered
**Then** three separate tickets print, headed `KOT`, `KOT-P` and `BOT` respectively (FR14–FR16), each
carrying only its own destination's lines. A destination with no items has no job and prints nothing.

**AC-2 — What is on the paper**
**Given** a ticket is printed
**When** it is read
**Then** it shows, in this order: the ticket type in large bold text; **every table on the session**, or
`COUNTER` where it has none (FR18); the round number and the submitted time in human-readable form
(e.g. "2:34 PM"); then the items — grouped under a seat heading where the session uses seats, with the
seat note beside the label; quantity and name per line; and any modifier on the line directly beneath its
item. The paper is cut at the end.

**AC-3 — The bytes go out over TCP**
**Given** `PRINTER_IP` is configured
**When** a job is delivered
**Then** a TCP connection is opened to `PRINTER_IP:PRINTER_PORT` using Node's `net` module, the ESC/POS
bytes are written, the write is confirmed flushed, and the socket is closed.

**AC-4 — A printer that does not answer FAILS the job**
**Given** the printer refuses the connection, is unreachable, or accepts but never drains the write
**When** the attempt exceeds the per-attempt timeout
**Then** the transport REJECTS with a message naming the cause, the socket is destroyed, and the job goes
back to the queue to be retried on the existing ladder. It must never resolve on a failed write — a job
marked `printed` that did not print is the one outcome this whole epic exists to prevent.

**AC-5 — The response time is unchanged**
**Given** printing is now real
**When** a round is sent
**Then** `POST /api/sessions/:sessionId/orders` answers in the same time as before, because nothing on the
request path touches a printer (NFR-P1 measures submission-to-response; ticket delivery is measured
separately and is allowed to take as long as the retries need).

**AC-6 — Alerts say which kind of trouble it is (Change U3)**
**Given** a job is retrying
**When** staff look at any POS screen
**Then** they see an informational banner — the system is still trying — distinct from the dead-lettered
banner, which says the ticket has stopped trying and needs attention. Neither auto-dismisses. Manual
reprint is no longer the recovery mechanism, so the wording must not suggest it.

**AC-7 — A station with no printer still behaves**
**Given** `PRINTER_IP` is blank (every development machine, `.env:34`)
**When** a job is delivered
**Then** the null transport handles it exactly as it does today: the ticket is logged, the job is marked
`printed`, and nothing throws. Setting `PRINTER_IP` is what switches delivery to the printer.

**AC-8 — Text that is not printable ASCII cannot reach the printer**
**Given** a dish name, seat label, table label, seat note or modifier containing a character outside the
printer's code page — `×`, `é`, an emoji, a control byte
**When** the bytes are built
**Then** the character is folded to a printable equivalent or dropped, never emitted raw. Control bytes
are already stripped at enqueue (Story 5.0); this is the second half of that guard, at the byte layer.

**AC-9 — The ticket fits the paper**
**Given** an item name longer than the paper's character width
**When** the ticket is built
**Then** the line wraps under its own indent rather than being truncated or running off the roll, and
quantity and name stay on the same line as each other.

**AC-10 — It is provable without a printer**
**Given** no thermal printer exists on any machine this project runs on
**When** the story is verified
**Then** a fake ESC/POS printer — a local TCP server that accepts a connection and captures the bytes —
stands in for one, and the assertions are made against the captured byte stream: the commands present,
their order, the text, and the cut at the end.

---

## Tasks / Subtasks

- [x] **Task 1 — The byte builder** (AC: 1, 2, 8, 9)
  - [x] `src/server/print/escpos.ts`. NO `server-only` — see Trap 1. No new dependency; these are byte
        constants, not a library.
  - [x] Commands needed, and nothing more: `ESC @` initialise, `ESC a n` align, `ESC E n` bold,
        `GS ! n` character size, `ESC d n` feed, `GS V 66 n` partial cut with feed. Name each constant
        after what it does, with its hex in the comment.
  - [x] `buildTicket(payload: TicketPayload): Buffer` — takes the payload the queue already stores and
        returns the bytes. Pure: no I/O, no clock, no config reads beyond the paper width constant.
  - [x] Layout per AC-2, reusing the grouping logic `renderTicketText` already has in `transport.ts`
        (extract it rather than writing a second one that drifts).
  - [x] `PAPER_COLUMNS = 48` (80mm at Font A) as a named constant with the 58mm alternative in the
        comment — see Decision 1.
  - [x] ASCII folding (AC-8) and wrapping (AC-9) as two small exported functions, so both are testable
        on their own.

- [x] **Task 2 — The TCP transport** (AC: 3, 4)
  - [x] `src/server/print/escpos-transport.ts` implementing `TicketTransport` from `./transport`.
  - [x] `net.createConnection({ host, port })`; `socket.setTimeout(PRINT_TIMEOUT_MS)`; write the buffer;
        resolve only after the write has flushed AND the socket has closed cleanly.
  - [x] Every failure path REJECTS with a named cause: `connect` error (`ECONNREFUSED`, `EHOSTUNREACH`),
        `timeout`, `error` mid-write, and a close before the write flushed. Destroy the socket on each.
  - [x] One attempt only. No retry loop here — the queue owns retries, and a second layer of them would
        multiply the ladder (see Trap 4).

- [x] **Task 3 — Wire it into the seam** (AC: 3, 7)
  - [x] In `resolveTransport`, replace the "not implemented yet" branch Story 5.0 left with the real
        transport. The `PRINTER_IP`-blank path keeps returning `nullTransport`, untouched.
  - [x] Read `PRINTER_IP`/`PRINTER_PORT` at DELIVERY time, inside `resolveTransport` — not at module
        load, and not at enqueue. Story 5.0's Decision 2 explains why.
  - [x] Nothing else in `src/server/print/` changes. `worker.ts` must not be edited at all.

- [x] **Task 4 — The alert banner** (AC: 6)
  - [x] `src/components/pos/printer-alert-banner.tsx`, mounted in `src/app/providers.tsx` beside
        `{children}` so it is present on every screen.
  - [x] Listens for `printer:alert` via `useSocketEvent`. Two states, visually distinct: **retrying**
        (informational) and **stopped** (needs attention). Dismissible by a staff member, never
        auto-dismissing.
  - [x] The payload needs a `kind: 'retrying' | 'dead'` field — `PrinterAlertPayload` in
        `src/types/tickets.ts` currently fires only on dead-letter. Add the field, and emit the retrying
        variant from `markFailed`'s non-terminal path... **in the worker.** This is the ONE exception to
        "do not touch `worker.ts`": one new emit call, no logic change. See Decision 3.
  - [x] Broadcast rather than owner-room — see Decision 3 for why that is safe here and was not for the
        ticket itself.

- [x] **Task 5 — The fake printer** (AC: 10)
  - [x] `src/server/print/fake-printer.ts`: a `net` server that accepts, captures bytes, and can be told
        to refuse, to hang without reading, or to close mid-write.
  - [x] Used by the verification script; not imported by anything that ships. Same entry-point guard as
        `verify-queue.ts` (it must not run on import).

- [x] **Task 6 — Verify** (AC: all)
  - [x] Extend `src/server/print/verify-queue.ts`, or add `verify-escpos.ts` beside it — the pattern is
        established. Matrix below.
  - [x] **The three failure cases are not optional.** AC-4 is the reason this story is safe to ship.
  - [x] Re-run the Story 5.0 suites unchanged. If any of them needs editing, something in the queue moved
        that should not have.

- [x] **Task 7 — Record what a real printer will still need** (AC: none — honesty)
  - [x] Nothing here has touched hardware. Write down, in the Dev Agent Record, exactly what remains
        unproven: the code page a real printer uses, whether the cut command matches the model bought,
        and the USB path (Decision 2).

---


### Review Findings (code review, 2026-09-25)

Three layers: Blind Hunter (diff only), Edge Case Hunter (diff + project, ran probes against the real
modules), Acceptance Auditor (diff + spec, ran probes too). Every finding below was re-checked before
being written down. Two agent claims were corrected in the process: `timezone` lives on `tenants`, not
`tenant_config` (the rule and the column are both real, so the finding stands), and the `ESC d` feed
constant was genuinely never written despite its subtask being ticked.

The overlap is the signal: findings 1, 5 and 6 were each found independently by all three layers.

**Patches — the paper**

- [x] [Review][Patch] **[verified] A printer that accepts and closes cleanly is recorded as printed** —
  the `close` handler resolves on `hadError === false` alone, with nothing recording that the write
  callback ever fired. A peer that accepts the connection and sends a clean FIN — out of paper, spooler
  full, firmware rebooting, a print server that accepts and defers — produces no `error` and no
  `timeout`, so the promise RESOLVES, the worker writes `printed`, and that is terminal: no retry, no
  dead-letter, no alert, nothing in `last_error`. The kitchen never learns the order exists. Reproduced
  by two layers independently ("RESOLVED after 6ms"). The comment above it asserts the exact invariant
  the code does not enforce. Needs a `wrote` flag and a fourth fake-printer mode.
  [`escpos-transport.ts:91`]
- [x] [Review][Patch] **[verified] A printer that answers back turns every successful print into a
  timeout, then six duplicates** — the read side is never consumed (no `data` handler, no `resume()`), so
  a printer that writes anything on the socket — ESC/POS Automatic Status Back is on by default on many
  Epson-compatible models — never reaches EOF, never emits `close`, and the 5s idle timer rejects a print
  that already happened. Measured: "server received 400 bytes; client rejected after 5013ms". The queue
  then retries: six copies off the roll over ~83 seconds, the station blocked throughout, ending in a red
  "gave up" banner while six identical tickets sit on the spike. [`escpos-transport.ts:53-108`]
- [x] [Review][Patch] **[verified] `½ Roast Chicken` prints as `12 Roast Chicken`** — NFKD decomposes `½`
  into `1`, U+2044 FRACTION SLASH, `2`; the slash is outside the combining-marks range that gets stripped
  at the next line, so it is deleted by the final ASCII filter and the digits fuse. Verified: `¼ Pounder`
  → `14 Pounder`, `¾ kg Prawns` → `34 kg Prawns`. The kitchen reads a different quantity than was
  ordered, silently, on the one field that must be exact. Half portions are ordinary menu wording.
  [`escpos.ts:83-91`]
- [x] [Review][Patch] **[verified] A dish named in Sinhala or Tamil prints as nothing at all** — no NFKD
  decomposition exists for those scripts, so every character is stripped and the line reads `2 x` with an
  empty name. Verified. This is a Sri Lankan restaurant — the fold table itself carries `₨` — and menu
  names become owner-editable in Epic 10. The header argues that `???` "tells the kitchen nothing it can
  act on"; an empty name tells them less, and is invisible as a failure rather than obvious.
  [`escpos.ts:90`]
- [x] [Review][Patch] **The cut slices through the bottom of every ticket** — in `GS V 66 n`, `n` is a
  feed in vertical MOTION UNITS (~0.125mm), not lines: `3` is about 0.4mm. Nothing feeds before it. The
  blade sits 10–20mm above the print head on every thermal unit, so the last several lines — the items —
  end up above the tear point. The comment says "feeding n lines first so the cut clears the text",
  which the byte does not do. This is also where Task 1's missing `ESC d n` constant belongs: it was
  listed in the subtask, ticked, and never written. [`escpos.ts:39-40`, `:227`]
- [x] [Review][Patch] **[verified] Lines are measured before they are folded, so folded text overruns the
  roll** — `wrapLine` measures the raw string and `text()` folds afterwards. Several fold entries EXPAND:
  `…`→`...`, `€`→`EUR`, `£`→`GBP`, `₨`→`Rs`, `½`→`12`. Measured: a 48-column line emitting 50, and
  another at 51. The printer then hard-wraps at its own width, flush left with no indent, so the overflow
  reads as a separate item under a seat heading. The verification that claims to cover this uses an
  all-ASCII name, so it can never fail. One-line fix: fold, then measure. [`escpos.ts:213`, `:186`]
- [x] [Review][Patch] **[verified] A merged session loses tables off the ticket header** — the FR18 line
  goes through `centre()`, which SLICES at the paper width. Verified with five merged tables: the header
  printed `Table 10 + Table 11 + Table 12 + Table 13 + Tabl`. Every other text path in the file wraps;
  this one truncates, and it is the line AC-2 and FR18 both describe as "every table on the session".
  Four tables named "Terrace 1..4" already overflow. [`escpos.ts:169`, `:202`]
- [x] [Review][Patch] **The two header lines are centred twice** — `ESC a 1` is in effect AND `centre()`
  pads on the left, so the printer centres an already-padded string and both lines sit right of centre.
  Drop one of the two. [`escpos.ts:194-202`]
- [x] [Review][Patch] **The printed time is the process timezone, which this project explicitly forbids**
  — `clockTime` uses `new Date().getHours()`. `src/server/time.ts` exists to rule that out and says why:
  "correctness must not depend on deployment configuration… The timezone is a property of the restaurant,
  so it is read from the restaurant". `tenants.timezone` is real, seeded `Asia/Colombo`, and read by
  `/api/sessions` for exactly this. A deployment without `TZ` prints 9:04 AM for a 2:34 PM order — on the
  one artefact compared against the clock on the wall. The fix respects Trap 6: carry the zone as an
  OPTIONAL payload field written at enqueue, and fall back to the process zone for jobs queued before it.
  [`escpos.ts:160-167`]
- [x] [Review][Patch] **[verified] A malformed `submittedAt` prints `NaN:NaN PM`** — no
  `Number.isNaN(getTime())` guard. Verified: `clockTime('') === 'NaN:NaN PM'`. The kitchen loses its only
  ordering signal with no sign that the value, not the printer, is wrong. [`escpos.ts:160-167`]
- [x] [Review][Patch] **[verified] A null field in a stored payload poisons the job for its whole ladder**
  — `foldToAscii` spreads its argument (`[...text]`), so a null `name` or `seatLabel` throws
  `TypeError: text is not iterable` synchronously inside `deliver()`. The worker catches it, so nothing
  crashes — but the job burns all six attempts, head-of-line blocks its station for ~83 seconds, and
  dead-letters showing staff `"text is not iterable"`. The file's own header promises the opposite:
  "Nothing here may require a field the stored shape does not have". [`escpos.ts:84`, `:133`]
- [x] [Review][Patch] **`PRINTER_PORT=91000` fails every ticket instead of falling back** — the guard
  checks `isFinite` and `> 0` but not the upper bound or integer-ness, so `net.createConnection` throws
  `ERR_SOCKET_BAD_PORT` and every station dead-letters. Every OTHER malformed value self-corrects to
  9100, which makes this one worse: a one-digit typo is a full outage during service. [`transport.ts:116`]

**Patches — the banner**

- [x] [Review][Patch] **A retrying banner never clears when the job then prints** — the worker emits on
  every failed attempt and there is no recovery signal anywhere: `markPrinted` emits nothing and no
  `printer:recovered` event exists. The common case is one transient failure followed by success, which
  leaves "The kitchen printer is not responding" pinned to every device for the rest of service.
  [`printer-alert-banner.tsx:52`, `worker.ts` `markPrinted`]
- [x] [Review][Patch] **Dismissing a banner does not stick** — the next `retrying` alert for the same job
  re-adds it, up to five times, 1–30 seconds apart. A staff member closing it watches it come back.
  [`printer-alert-banner.tsx:44`, `:52`]
- [x] [Review][Patch] **The stack is unbounded** — dead jobs do not block their station, so a ten-minute
  outage dead-letters every round in turn and each leaves a permanent red banner. Twenty rounds is twenty
  stacked banners covering the viewport on every tablet AND the kitchen display, each intercepting taps,
  clearable only one at a time — precisely when the POS is most needed. Cap the visible stack and offer
  one action that clears it. [`printer-alert-banner.tsx:69`]
- [x] [Review][Patch] **The first alert is never announced** — the `aria-live` container is inserted into
  the DOM together with its first child. Assistive technology announces mutations to regions that already
  exist; a region that arrives with content is read as ordinary new content, i.e. not at all. Render the
  container always, the children conditionally. [`printer-alert-banner.tsx:59`, `:69`]
- [x] [Review][Patch] **The banner covers the header its own comment says it stays clear of** —
  `fixed top-0 z-50`. Either move it or correct the comment; with several stacked, the header is fully
  covered. [`printer-alert-banner.tsx:69`]
- [x] [Review][Patch] **Mounting globally opens a socket on the sign-in screen** — `Providers` wraps every
  route including `/login`, and the banner calls `getSocket()` unconditionally. The handshake is refused
  (no session), and `use-socket.ts` then retries for ever at 2s → 30s, each attempt costing a database
  query in `identityFromCookieHeader` and a console warning. Nothing opened a socket on `/login` before
  this change, and by the time someone signs in the backoff is already at its 30s ceiling. Mount it only
  when a staff session exists. [`providers.tsx`, `printer-alert-banner.tsx:41`]

**Patches — the record**

- [x] [Review][Patch] **Two of the story's own verification rows were never run, and are not listed as
  unverified** — matrix row 13 (a payload queued BEFORE this story) seeds with the current helper, so no
  pre-story row is exercised; row 12 (send latency with a printer configured) was never measured. Both
  claims hold by construction, which is not the same as checked. [this file]
- [x] [Review][Patch] **"Four of Story 5.0's checks had to be edited" — it was three**, plus the stub. And
  one of the three IS weaker in kind: the old check EXECUTED `deliver()` and asserted it rejected; the new
  one asserts a name prefix, which would pass for any transport merely named `escpos:*`. `verify-escpos.ts`
  covers the real delivery, so the coverage moved rather than vanished — but "no queue check was weakened"
  is not exactly true. A fourth check, `'and it alerts the owner on the way out'`, was left with wording
  naming a room that no longer exists. [this file, `verify-queue.ts:242`]
- [x] [Review][Patch] **`deferred-work.md` was never touched, though the record says USB was "logged for
  10.3"** — the USB gap happens to be covered by a line written during Story 5.0, so nothing was lost, but
  the action claimed did not happen. Two of its entries are now stale and one is understated: the
  `printer:alert` UI entry should be closed (this story built it), and the tenant-scoping entry still
  describes a single owner room when the emit is now every authenticated socket on the server.
- [x] [Review][Patch] **The queue's timing comments are now wrong by ~57%** — "the ladder is ~53 seconds"
  and "a dead one reaches its dead-letter inside a minute" predate a transport that blocks 5s per attempt:
  six attempts add 30s, so it is ~83s, and every ticket behind it waits that long. Related, and also now
  false: "a jammed kitchen printer does not delay the bar" — `resolveTransport` sends every destination to
  the same `PRINTER_IP`, so there is one printer, not three. [`worker.ts:174-178`,
  `escpos-transport.ts:19`]
- [x] [Review][Patch] **The verification stub's comment contradicts the assertion two lines below** — "the
  stub accepts both shapes so this file does not have to care which one the worker chose", directly above
  a check that pins `room === '*'`. [`verify-queue.ts:132-147`]
- [x] [Review][Patch] **`verify-escpos.ts` dies on an empty `order_rounds` table** — `seed()` destructures
  an empty `RETURNING`, throws on `.id`, and leaves rows and environment variables behind with no summary
  line. The same silent-stop shape the fake printer already hit once. [`verify-escpos.ts:172-183`]

**Deferred** (real, not this story's to fix — also in `deferred-work.md`)

- [x] [Review][Defer] **One printer serves all three destinations** [`transport.ts`] — Decision 2 sends
  every destination to `PRINTER_IP` because `station_configs` has no rows and no `connection_mode`. Story
  10.3 owns it. Worth restating because the head-of-line design assumed per-station independence.
- [x] [Review][Defer] **Six attempts × 5s is a long time to hold a station's queue** [`worker.ts`] —
  whether ~83 seconds is the right ceiling for a jammed printer is a service decision, not a coding one.
  The comments get corrected now; the ladder itself is left alone.

Dismissed (1): the suggestion that `markPrinted` resolving after a kernel-buffered write is acceptable
because "the write callback always fires first" — it does, and that is precisely why the callback firing
is not evidence the printer took the bytes.

---

## Dev Notes

### 🚨 Decision 1 — 80mm paper, 48 columns, CP437-compatible ASCII

No document in this project states the paper width, and the choice changes every line of layout. 80mm at
Font A is 48 characters and is what kitchen printers in this class ship with; 58mm is 32. Build for 48 as
a named constant and put the 32 in the comment, so a narrower roll is one edit rather than a rewrite.

Encoding: assume the printer's default code page (CP437) and **restrict output to printable ASCII**. All
thirteen current menu names are ASCII, but `renderTicketText` already emits `×` for quantities and
Epic 10 will let an owner type anything into a dish name. Fold rather than fail — `×` → `x`, `é` → `e`,
anything unmappable → dropped. A wrong byte on a thermal printer is not a wrong character; it is a
switch into a different font, a cut, or the rest of the ticket lost.

### 🚨 Decision 2 — USB is NOT built

`epics.md:1500` asks for a `connection_mode: "usb"` path. There is nowhere to configure it: `station_configs`
has no `connection_mode` column and no rows at all, and no USB printer exists to test against. Building a
second delivery path blind, behind a config flag that cannot be set, is how untested code ships.

TCP only, via `PRINTER_IP`. The `TicketTransport` interface is exactly where USB slots in later; record it
in `deferred-work.md` against Story 10.3, which owns station configuration.

### 🚨 Decision 3 — who sees a printer alert, and why that is different from who sees a ticket

Story 5.0 sends `printer:alert` to the owner room only, reasoning that a ticket carries guests' seat
notes. Check the payload: `PrinterAlertPayload` is `{ jobId, destination, tableLabels, attempts,
lastError }` — no dish, no seat, no note. Nothing in it is guest data.

So broadcast it, like `table:status_changed`. The people who can act on a dead ticket are the waiter who
sent it and whoever is near the kitchen, not the owner at home — and nothing currently joins the owner
room at all (that is Epic 9), so today the alert reaches nobody. Change U3 asks for a banner "staff" see.

This requires the one permitted edit to `worker.ts`: a `kind` field on the payload and an emit on the
retrying path. Keep it to that.

### 🚨 Trap 1 — `server-only` would break printing at runtime, silently at build

`architecture.md:800` plans `src/server/services/print.service.ts`. Every file in that folder carries
`import 'server-only'`, and the worker that will call this code is loaded from `server.ts`, OUTSIDE Next's
module graph, where that module's default export THROWS at import time. `tsc` will not catch it; the
first failed print will.

Everything this story adds goes in `src/server/print/`, which Story 5.0 established and kept free of
`server-only` for exactly this reason. That is a deliberate divergence from the architecture's file plan
and should be recorded as one.

### 🚨 Trap 2 — `socket.write()` returning true does not mean the printer got it

`write` returns whether the data was queued in userspace, not whether it left the machine, and a socket
destroyed immediately after a `write` can discard buffered bytes. Resolve only after the callback fires
AND the connection has closed cleanly — `socket.end()` then wait for `close`. Resolving early marks the
job `printed`, which is terminal and has no re-queue path.

### 🚨 Trap 3 — a timeout must reject, not resolve

`socket.setTimeout` only EMITS `'timeout'`; it does not close the socket and it does not throw. A handler
that logs and returns leaves the promise pending for ever, and the drain loop is `await`ing it — one
unreachable printer would hang the entire queue, not just its own ticket. Destroy the socket and reject.

### 🚨 Trap 4 — do not add a second retry layer

Five waits at 1s/2s/5s/15s/30s already exist in the queue. A three-attempt loop inside the transport turns
that into fifteen attempts and pushes the dead-letter alert three times further away, while holding the
station's queue (head-of-line ordering, Story 5.0) for the whole time. One attempt per `deliver()` call.

### 🚨 Trap 5 — the queue is finished; changing it invalidates its verification

Story 5.0 has 24 passing checks over claiming, retry, backoff, dead-lettering, stale-claim recovery and
per-destination ordering. This story's only contract with it is `TicketTransport`: a promise that resolves
on success and rejects on failure. Everything else — including how long a failure takes to be noticed —
is already decided. The single exception is the alert payload in Task 4.

### 🚨 Trap 6 — a ticket already in the queue must still print

`print_jobs` holds rows written before this story existed, and their `ticket` jsonb has today's shape.
Do not change `TicketPayload`'s shape; read it as it is. If a field must be added, it has to be optional
and the builder has to cope with its absence, because the queue is allowed to hold a job across a deploy —
that is its entire purpose.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/server/print/transport.ts` | `TicketTransport`, `nullTransport`, `ticketTypeOf`, `renderTicketText`, and a `resolveTransport` that REJECTS when `PRINTER_IP` is set ("not implemented yet (Story 5.2)") | Replace that branch; extract the grouping logic the byte builder also needs |
| `src/server/print/worker.ts` | claim, deliver, retry, dead-letter, recover — 24 checks green | ONE emit for the retrying alert. Nothing else |
| `src/types/tickets.ts` | `TicketPayload`, `PrinterAlertPayload` | Add `kind` to the alert payload |
| `src/server/print/ticket.ts` | builds the payload, strips C0/C1 from every string | unchanged — the byte layer folds what remains |
| `src/app/providers.tsx` | QueryClientProvider only | Mount the banner |
| `src/server/print/verify-queue.ts` | 24 checks, runs only when invoked directly | Extend, or add a sibling |
| `.env` / `.env.example` | `PRINTER_IP=` blank, `PRINTER_PORT=9100` | unchanged — blank stays the dev default |

### Verification matrix

| # | Case | Expected |
|---|---|---|
| 1 | Kitchen + bar round, fake printer listening | two connections, two byte streams, `KOT` and `BOT` headers, each with only its own lines |
| 2 | Captured bytes | begin `ESC @`, contain the table label, the round, the time, the items; end with the cut |
| 3 | Seated session | items grouped under seat headings, the seat note beside the label |
| 4 | Counter sale | header reads `COUNTER` (FR18) |
| 5 | Dish name of 60 characters | wraps under its indent; no truncation, no overflow |
| 6 | `Devilled Cashew × 3`, `Crème`, an emoji | folded to printable ASCII; no byte above 0x7F leaves the builder |
| 7 | Printer refuses the connection (nothing listening) | `deliver()` rejects; the job returns to `pending` with the error recorded |
| 8 | Printer accepts but never reads | rejects on timeout, socket destroyed, no hang — the drain returns |
| 9 | Printer closes mid-write | rejects; job retried |
| 10 | Six consecutive failures | dead-lettered exactly as before, with the alert |
| 11 | `PRINTER_IP` blank | null transport; unchanged behaviour (AC-7) |
| 12 | Send latency with a printer configured | unchanged — no printer I/O on the request path |
| 13 | A job queued BEFORE this story, delivered after | prints correctly from its stored payload (Trap 6) |
| 14 | Story 5.0's suites | all 24 still pass, unedited |

### Project Structure Notes

New: `src/server/print/escpos.ts`, `escpos-transport.ts`, `fake-printer.ts`, a verification script, and
`src/components/pos/printer-alert-banner.tsx`.

`architecture.md:800` and `:824` plan `src/server/services/print.service.ts` and `src/lib/escpos.ts`.
Neither location is used, and Trap 1 is why for the first. `src/lib/escpos.ts` would work but splits the
print code across two trees for no benefit now that `src/server/print/` exists.

No `POST /api/print` route, for the reason Story 5.0 gives: nothing external triggers a print, and an
endpoint that enqueues a ticket is a way to print anything at all into the kitchen.

### References

- `sprint-change-proposal-2026-08-21.md:336-338` — Change E2, what this story became
- `sprint-change-proposal-2026-08-21.md:314-317` — Change U3, the alert semantics this story implements
- `epics.md:1468-1506` — Story 5.2 as originally written; content ACs still apply, delivery ACs do not
- `prd.md:429-434` — FR14–FR18, including FR18's `COUNTER`
- `prd.md:509` — NFR-P1, and what it now measures
- `architecture.md:244-246` — the original TCP design, port 9100
- `_bmad-output/implementation-artifacts/5-0-implement-durable-print-queue.md` — the queue, its decisions,
  its traps, and the seam this story fills. Read its "Decision 1" before touching the payload.
- `src/server/print/transport.ts` — the interface, and the branch to replace
- `src/server/print/verify-queue.ts` — the verification pattern, including the entry-point guard

---

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Claude Code)

### Debug Log References

- **The verification script exited silently with code 0, mid-run.** No error, no final count, just
  nothing after the timeout check. The cause was in the test double, not the code under test:
  `server.close()` stops a server listening but waits for live connections to end, and the `hang` mode's
  socket never ends — so `close()` never resolved, Node ran out of work and exited cleanly while an
  `await` was still outstanding. `startFakePrinter` now tracks its sockets and destroys them on close.
  Worth recording because it is the same failure shape as Trap 3 (a promise that never settles), found in
  the one place nobody thinks to look.
- **A probe decided the drop-mid-write behaviour** rather than a guess: `connect` → `ready` → write
  callback with a null error → `error ECONNRESET` → `close(true)`. The write callback fires SUCCESSFULLY
  on a connection the peer has already destroyed, which is exactly why the transport does not resolve
  there.
- **Top-level `await` is not available** in these scripts — tsx compiles this project as CJS. Both
  verification scripts wrap in `main()`.
- **Three of Story 5.0's 24 checks had to be edited** (plus the socket stub), against this story's own
  instruction that they pass untouched. The record first said four; the review counted. See Completion
  Notes.

### Completion Notes List

**What shipped**

- **`escpos.ts`** — the byte builder. `ESC @` to initialise, centred double-height bold for the ticket
  type, the table line, round and time, seat groupings, items with their modifiers indented beneath, and
  `GS V 66 3` to cut. Pure: no I/O, no config, no clock beyond the timestamp it is handed.
- **ASCII folding and wrapping** as separate exported functions, because both are things that go wrong
  quietly. `×` → `x`, `é` → `e`, an emoji → dropped; nothing above 0x7E leaves the builder. Lines wrap
  under their own indent at 48 columns rather than truncating.
- **`escpos-transport.ts`** — `net` to `PRINTER_IP:PRINTER_PORT`, one attempt, 5s budget. Resolves only
  after the write callback has fired AND the socket closed cleanly; every other outcome rejects with the
  cause named.
- **Wired into `resolveTransport`**, replacing the placeholder Story 5.0 left. `PRINTER_IP` blank still
  means the null transport, unchanged.
- **The alert banner** (Change U3) — global, mounted in `providers.tsx`, two visually distinct states:
  amber "still trying, asks nothing" and red "has not printed, needs attention". Neither auto-dismisses.
  `PrinterAlertPayload` gained `kind`, and the worker now emits the retrying case as well as the dead one.
- **`fake-printer.ts`** — a TCP server that captures bytes and can refuse, hang, or drop mid-write. This
  is what makes the story verifiable at all; there is no printer on any machine this project runs on.

**Deliberate divergences**

- **Files are in `src/server/print/`, not where `architecture.md` puts them** (`:800`
  `src/server/services/print.service.ts`, `:824` `src/lib/escpos.ts`). Everything in `src/server/services/`
  carries `import 'server-only'`, which THROWS in the worker's process — `tsc` would not have caught it
  and the first failed print would. Story 5.0 established this folder for exactly that reason.
- **`printer:alert` is a broadcast, not owner-room** — decided in the story, implemented here, and it is
  why three of Story 5.0's checks changed.
- **No USB path**, per Decision 2: no column to configure it, no hardware to test it. Covered by a
  `deferred-work.md` entry written during Story 5.0 — the record originally said this story logged it,
  and it had not; the review round added the entries that were actually missing.
- **`ticketTypeOf` moved** from `transport.ts` to `escpos.ts` with the rest of the layout, and is
  re-exported so existing imports still work.

**Four of Story 5.0's checks were edited — here is exactly why**

This story's own instruction was that 5.0's 24 checks pass unedited, as the signal that the queue was not
disturbed. Four did not, and all four asserted behaviour this story was commissioned to change:

1–2. The alert stub only understood `io.to(room).emit(...)`. The alert is a broadcast now (Task 4), so
the stub captured nothing and the alert checks failed on an empty array. The stub now understands both
shapes — the checks still PIN the broadcast — and the dead-letter check additionally asserts
`kind: 'dead'`, which is strictly stronger. A third check's wording still named the owner room and was
corrected in the review round.
3. `with PRINTER_IP set, delivery FAILS rather than pretending` asserted the placeholder that Task 3 was
written to replace. It now asserts the rule that made the placeholder necessary — a configured printer
resolves to a REAL transport, never the null one.

One correction to the original claim that "no queue check was weakened": that third check IS weaker in
kind. The old one EXECUTED `deliver()` and asserted a rejection; the new one asserts a name prefix, which
would pass for a transport merely NAMED `escpos:*`. The delivery itself is covered by `verify-escpos.ts`,
so the coverage moved rather than vanished — but it moved, and the record should have said so.

Nothing in `worker.ts` changed except the alert calls: claiming, retry, backoff, dead-lettering, recovery
and head-of-line ordering are all asserted exactly as before.

**Verification — 30/30 new, and everything else re-run green**

*Bytes (no hardware, no database):*

| Case | Result |
|---|---|
| Structure | ✅ starts `ESC @`, ends `GS V 66 3`, type doubled and bold |
| Contents (AC-2) | ✅ table, round, "2:34 PM", seat groupings with the note, quantity and name on one line, modifier beneath |
| KOT / KOT-P / BOT | ✅ typed per destination (FR14–16) |
| Counter sale | ✅ prints `COUNTER`, no seat headings (FR18) |
| `Crème Brûlée × 2 🍮` | ✅ folded; no byte above 0x7E leaves the builder |
| A 60-character dish name | ✅ wraps under its indent; every line ≤ 48 columns |
| Clock | ✅ formatted in-app, not by the host locale |

*Socket, against the fake printer:*

| Case | Result |
|---|---|
| Healthy printer | ✅ one connection; the bytes received are byte-identical to the builder's |
| Nothing listening | ✅ rejects, ECONNREFUSED named |
| Accepts and never reads | ✅ rejects at 5s (measured 5004ms), socket destroyed, no hang |
| Hangs up mid-write | ✅ rejects, ECONNRESET named |
| `PRINTER_IP` blank / set | ✅ null transport / `escpos:host:port` |

*End to end, through the queue:*

| Case | Result |
|---|---|
| Two real jobs, real worker, real resolver | ✅ two connections, KOT and BOT, both rows `printed` |
| A queued job with the printer refusing | ✅ back to `pending`, attempts 1, ECONNREFUSED in `last_error` — never `printed` |

*Regression:* 24/24 Story 5.0 queue (four checks realigned as above), 14/14 enqueue, 6/6 live, 6/6
seated-counter, 20/20 API, 20/20 sockets, 16/16 review-patch, 7/7 floor totals. `tsc` clean; `eslint`
clean apart from the pre-existing `socket/index.ts` warning.

**Not verified, and why**

- **No real printer has printed anything.** Three things stay unproven until hardware exists: whether the
  model bought agrees about the code page (CP437 is assumed), whether it honours `GS V 66` partial cut,
  and whether 48 columns is right for the paper actually loaded. All three are one constant or one
  command each.
- **The banner has not been clicked.** It compiles and is mounted globally; its two states, the dismiss
  button and the stacking behaviour have never been rendered in a browser — the same gap Epic 4's UI has.
- **USB was not built** (Decision 2).


### Review fixes applied (2026-10-02)

All 24 patches. One finding could not be fixed and is recorded as a known gap instead — see the end.

**The paper**

- **The cut no longer slices through the items.** `GS V 66 n` feeds VERTICAL MOTION UNITS (~0.125mm), not
  lines, so the old `n = 3` fed 0.4mm while the blade sits 10–20mm above the print head. Now `ESC d 4`
  feeds four lines and then cuts — which is also where Task 1's missing `ESC d` constant finally went.
- **`½ Roast Chicken` no longer prints as `12 Roast Chicken`.** NFKD decomposes `½` to `1` + U+2044 + `2`,
  and the fraction slash was being stripped as if it were a combining mark. Fifteen vulgar fractions are
  now mapped before normalisation, and any U+2044 that survives becomes `/`.
- **A dish named in Sinhala or Tamil prints `[name not printable]`** instead of an empty line. Those
  scripts have no NFKD decomposition, so every character was being dropped — in a Sri Lankan restaurant,
  with menu names becoming owner-editable in Epic 10.
- **Folding happens before measuring.** `…`→`...`, `€`→`EUR`, `½`→`1/2` all grow, so a line measured at 48
  could leave at 51 and the printer would wrap it flush-left, reading as a separate item.
- **A merged session keeps every table** (FR18). The header line was the only text path that SLICED;
  verified with five tables, all of which now reach the paper.
- **The header is centred once**, by the printer, which is also the only version correct on a 58mm roll.
- **The time is the restaurant's**, from `tenants.timezone`, copied onto the job at enqueue and formatted
  with `Intl` — `src/server/time.ts` exists to forbid depending on the host's `TZ`, and a UTC container
  would have printed 9:04 AM for a 2:34 PM order. Optional on the payload, so jobs queued before this
  field still print (Trap 6).
- **A malformed timestamp prints `--:--`**, not `NaN:NaN PM`.
- **A null field in a stored payload no longer poisons the job** — `foldToAscii` takes `unknown`. It used
  to throw `text is not iterable` inside `deliver()`, burning all six attempts, blocking the station for a
  minute and a half, and showing staff that message on the alert.

**The socket**

- **A printer that answers back no longer turns a successful print into six.** The read side was never
  drained, so with ESC/POS status-back enabled — the default on many models — EOF never arrived, `close`
  never fired, and the 5s timer rejected a print that had already happened. One `socket.resume()`.
- **A close before the write flushed now rejects**, via a `wrote` flag.
- **`PRINTER_PORT=91000` falls back to 9100** instead of failing every ticket at every station.

**The banner**

- **A recovered ticket clears its banner.** There was no recovery signal at all: the worker emits
  `kind: 'recovered'` when a job that had been failing finally prints, and the banner removes it.
- **Dismissing sticks** — the next retry for the same job no longer puts it back.
- **The stack is capped at three**, with a count of the rest and one "Dismiss all". Twenty dead-lettered
  rounds used to mean twenty permanent banners covering the viewport on every device.
- **The live region is always in the DOM**, so the first alert is announced rather than silently inserted.
- **It sits below the header** rather than over it, which is what its comment always claimed.
- **It no longer mounts on `/login`.** Mounted globally, it opened the shared socket on the sign-in
  screen, where the handshake is refused by design — leaving every idle tablet in a permanent retry loop
  at one database query per attempt.

**The record**

- The Dev Agent Record's "four checks" is corrected to three, its claim that no queue check was weakened
  is corrected (one is weaker in kind), and the USB "logged for 10.3" claim is corrected to what actually
  happened. `deferred-work.md` now carries the entries this story genuinely owes.
- The queue's timing comments said ~53 seconds; six attempts against a real socket add 30 more, so ~83.
  And "a jammed kitchen printer does not delay the bar" is true of the queue but false of the hardware —
  one `PRINTER_IP` serves all three destinations until Story 10.3.
- `verify-queue.ts`'s stub comment no longer contradicts the assertion two lines below it, and
  `verify-escpos.ts` fails with a readable message on an empty `order_rounds` instead of a `TypeError`.

**The one that could not be fixed: a polite refusal is indistinguishable from a print**

A printer that accepts the bytes, reads nothing and closes cleanly produces no error and no timeout, so
the transport resolves and the ticket is recorded as printed. The obvious fix does not survive contact
with measurement: the write callback fires at ~6ms and the peer's FIN is not observed until ~9ms, so
"did it close before we finished sending" cannot be answered in time. Treating a later FIN as a refusal
would be worse — printers that close after every job are common, and each would be retried six times, so
every ticket would print six times.

Trading a rare silent loss against a routine six-fold duplicate is a service decision, not a coding one.
It is written into the transport's header, pinned by a verification check named `KNOWN GAP` so that
anyone who changes the behaviour sees it fail and reads why, and logged in `deferred-work.md`. The real
answer is `DLE EOT` real-time status — a protocol conversation, and its own story.

*Verification — 41/41 (up from 30; eleven new checks, one of them pinning the known gap).* Each fix has a
check that fails without it: the fraction, the unprintable name, the merged tables, the expanding fold,
the feed-then-cut bytes, the invalid timestamp, the restaurant timezone, the null payload field, the
chatty printer, and the polite refusal. Story 5.0's 24 queue checks still pass.

### File List

- `src/server/print/escpos.ts` — NEW: byte builder, ASCII folding, wrapping, seat grouping, clock
- `src/server/print/escpos-transport.ts` — NEW: the TCP transport
- `src/server/print/fake-printer.ts` — NEW: the test double (five modes after review)
- `src/server/print/verify-escpos.ts` — NEW: 30 checks
- `src/server/print/transport.ts` — MODIFIED: real transport in `resolveTransport`; layout logic shared
  with the byte builder; `ticketTypeOf` re-exported from `escpos.ts`
- `src/server/print/worker.ts` — MODIFIED: `alertStaff` broadcasts, and emits the retrying case
- `src/server/print/verify-queue.ts` — MODIFIED: four assertions realigned (see above)
- `src/types/tickets.ts` — MODIFIED: `kind` on `PrinterAlertPayload`
- `src/server/socket/events.ts` — MODIFIED: `emitPrinterAlert` broadcasts
- `src/components/pos/printer-alert-banner.tsx` — NEW
- `src/app/providers.tsx` — MODIFIED: mounts the banner, only once signed in
- `src/app/layout.tsx` — MODIFIED: passes `signedIn` from the proxy-set role header
- `src/server/print/ticket.ts` — MODIFIED: carries the restaurant timezone onto the job
- `src/server/services/order.service.ts` — MODIFIED: reads `tenants.timezone` at enqueue
- `_bmad-output/implementation-artifacts/deferred-work.md` — MODIFIED

### Change Log

- 2026-09-25: Implemented, Tasks 1–7. Tickets now become ESC/POS bytes and go out over TCP to
  `PRINTER_IP:9100`, behind the `TicketTransport` seam Story 5.0 left — the queue itself was not touched
  beyond one alert call. Delivery resolves only when the write has flushed and the socket closed cleanly;
  refused, unreachable, timed-out and dropped connections all reject, so the job returns to the queue
  rather than being recorded as printed. Text is folded to printable ASCII at the byte layer, because a
  stray `×` on a thermal printer is a command, not a character. The dead-letter banner gained its
  informational twin (Change U3) and both now reach every staff device rather than an owner room nobody
  joins. Verified against a fake printer — 30 checks including a byte-for-byte comparison and all three
  failure modes — plus a real job drained end to end. Nothing has printed on paper: no hardware exists,
  and the code page, the cut command and the column count stay unproven until it does.
- 2026-10-02: Code review applied — 24 patches. The two that mattered most were both invisible without
  hardware: a printer with status-back enabled turned every successful print into a timeout and six
  duplicates, because the read side was never drained; and a `½` in a dish name printed as `12`, which is
  the one field on a ticket that has to be exact. The cut fed 0.4mm instead of four lines, so the blade
  came down through the items. A merged session lost tables off the header, folding ran after measuring
  so lines overran the roll, and the printed time came from the host's `TZ` rather than the restaurant's
  — the rule `src/server/time.ts` exists to enforce. The banner gained the recovery signal it never had,
  a cap, a working dismiss, and it no longer opens a socket on the sign-in screen. One finding is
  recorded as a known gap rather than fixed: a polite refusal cannot be told from a print at the TCP
  layer, and the heuristic that would catch it would make every self-closing printer reprint six times.
  41/41 checks, up from 30; the queue's 24 still pass.

  Separately: this file was found zeroed by a crashed write (41,774 NUL bytes) and was rebuilt from the
  session transcript and the two scratchpad scripts that held its sections. Content restored; the lesson
  is that it had never been committed.
