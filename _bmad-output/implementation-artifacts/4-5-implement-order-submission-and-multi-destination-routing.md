# Story 4.5: Implement Order Submission & Multi-Destination Routing

Status: review

- **Epic:** 4 — Order Entry & Multi-Destination Routing (last story)
- **Story ID:** 4.5
- **Requirements:** FR9, FR12, FR13; NFR-D3, NFR-S3; sprint-change-proposal-2026-08-21 Change E4 (idempotency)
- **Depends on:** 4.3 (`seat_slots`, `lockOpenSession`), 4.4 (`round_number`, `modifier_text`, the staged round, the strip's `onSubmitOrder` seam)
- **Blocks:** Epic 5 (tickets are generated from what this story commits), Epic 6 (a bill is the sum of submitted rounds), Epic 8 (the portion decrement runs inside this story's transaction)

---

## Story

**As a** waiter,
**I want** to send the staged round in a single action that routes every item to its production destination,
**so that** the kitchen and bar have the order the moment I tap Send — no separate step per destination.

---

## Acceptance Criteria

**AC-1: One transaction writes the round**
**Given** a waiter taps **Send N to Kitchen & Bar** on the `OrderActionStrip`
**When** `POST /api/sessions/:sessionId/orders` is called
**Then** every staged line is written as one `ITEM_ADDED` `order_event` row, all in ONE database transaction. Each row carries `session_id`, `seat_slot_id`, `menu_item_id`, `quantity`, `unit_price_paisa`, `modifier_text`, `staff_id` (from `x-staff-id`), `round_number`; `created_at` is the submitted-at time. **201** on success

**AC-2: Every destination in one tap**
**Given** the round contains Kitchen, Pizza and Bar items
**When** it is sent
**Then** each destination present is notified in that one request — `kitchen` → KOT, `pizza_kitchen` → KOT-P, `bar` → BOT. A destination with no items is not notified. (What "notified" means before Epic 5 exists: Decision 3.)

**AC-3: Socket events after commit, before the response**
**Given** the transaction commits
**When** events are emitted
**Then** the `kitchen`, `pizza_kitchen` and `bar` rooms each receive `order:submitted` for their own items only, and the session's room receives `order:confirmed`. All emits happen **after** the commit and **before** the HTTP response. A failed emit never turns a committed round into an error.

**AC-4: Concurrent sends lose and duplicate nothing (NFR-D3)**
**Given** two waiters send rounds to the same session at the same moment
**When** both requests arrive
**Then** both rounds are written, with DIFFERENT round numbers, and no item is lost or duplicated

**AC-5: The screen moves on**
**Given** the send succeeds
**When** the client receives the response
**Then** the staged round and its local mirror are cleared, the sent items appear in the read-only history under their round, and the strip moves from `"items-added"` to `"submitted"`

**AC-6: A failure writes nothing and emits nothing**
**Given** the database errors mid-transaction
**When** the transaction rolls back
**Then** the response is **500**, no `order_event` row exists for the round, no socket event was emitted, and the staged round is still on the tablet so the waiter can retry

**AC-7: An unavailable item is refused**
**Given** a staged item became unavailable (or was deleted) between staging and sending
**When** the route validates the round
**Then** it returns **422** `{ success: false, error: { code: "ITEM_UNAVAILABLE", itemId } }`, writes nothing, and the client flags that line so the waiter can remove it and resend

**AC-8: Sending is idempotent** *(sprint-change-proposal-2026-08-21, Change E4 — never applied to epics.md)*
**Given** a send carries a client-generated `submissionId`
**When** the same `submissionId` arrives more than once — a double tap, a network retry, a tablet that reloaded mid-send
**Then** exactly one round exists, exactly one set of events was emitted, and every repeat returns the original round's result (**200**, `replayed: true`)

**AC-9: The server decides the price** *(added — see Decision 2)*
**Given** a line's quoted price differs from the menu's current price
**When** the round is validated
**Then** the response is **409** `PRICE_CHANGED` with the item id and the current price, nothing is written, and the waiter confirms the new price before resending. A client-supplied price is never written as-is.

**AC-10: Every seat must belong to this order** *(added)*
**Given** a line names a seat that is not on this session — removed on another tablet, or from another order entirely
**When** the round is validated
**Then** the response is **422** `SEAT_NOT_FOUND` with the seat id, nothing is written, and the client flags the line (Story 4.4's repair UI already exists)

**AC-11: Sockets are authenticated and rooms are policed** *(added — see Decision 1)*
**Given** a socket connects
**When** the handshake carries no valid staff session cookie
**Then** it is refused and receives nothing. **And** a `kitchen` user may join the production rooms but not a session room; a `waiter` or `owner` may join a session room but not the production rooms.

**AC-12: The floor's item count counts dishes** *(added — see Trap 4)*
**Given** a round is sent
**When** the floor grid updates
**Then** each device's table card shows the new count via `table:status_changed`, and the count is the SUM of quantities, not the number of rows — "Cashew × 3" is three items

**AC-13: A failed send can be retried safely** *(added — see Trap 5)*
**Given** a send fails for any reason — network, 500, the tablet reloading mid-request
**When** the waiter taps Send again without changing the round
**Then** the retry reuses the same `submissionId`, so a round the server DID commit is not written twice. Changing the round (adding, removing, re-quantifying a line) starts a new `submissionId`.

---

## Tasks / Subtasks

- [x] **Task 1 — Schema: `order_rounds`** (AC: 4, 8) — **first**
  - New table, append-only like `order_events`:
    ```ts
    export const orderRounds = pgTable('order_rounds', {
      /** The CLIENT-generated submission id. Primary key = the idempotency key. */
      id:          uuid('id').primaryKey(),
      sessionId:   uuid('session_id').notNull().references(() => orderSessions.id),
      roundNumber: integer('round_number').notNull(),
      staffId:     uuid('staff_id').notNull().references(() => staff.id),
      /** Dishes in the round (sum of quantities), so a replay can answer without re-counting. */
      itemCount:   integer('item_count').notNull(),
      submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    }, (t) => [
      uniqueIndex('idx_order_rounds_session_round').on(t.sessionId, t.roundNumber),
    ])
    ```
  - **The primary key IS the idempotency key** (AC-8). A replay collides on it (`23505` on `order_rounds_pkey`), and the route answers from the existing row. Catch it BY NAME with `isUniqueViolation(error, ...)`, as the seat routes do.
  - `idx_order_rounds_session_round` is the backstop for AC-4. `lockOpenSession` serialises sends so it should never fire; if it does, it is a 409 `ROUND_CONFLICT`, never a 500.
  - Add the table to the append-only trigger, in the migration: `CREATE TRIGGER ... BEFORE UPDATE OR DELETE ON order_rounds ... prevent_immutable_table_mutation()` — copy migration 0001's exact form. A round is a fact.
  - `order_events.round_number` stays, **denormalised on purpose**: every reader added so far (history, the Epic 5 ticket header, the Epic 7 timeline) reads events, and making them all join rounds would change three stories' queries to save one integer.
  - **⚠️ MIGRATION JOURNAL.** Confirm the new `when` exceeds 0014's (`…652460`). This check has caught a silently skipped migration three times.
  - **Why not the proposal's schema:** Change A5 proposed `ALTER TABLE order_sessions ADD COLUMN client_order_uuid UUID UNIQUE`. A session has MANY rounds; one unique key per session would make round 2 collide with round 1. The key belongs on the round.

- [x] **Task 2 — Move the shared order types out of `src/server`** (Trap 6)
  - `round-history.tsx` and `order-screen.tsx` import `SubmittedRoundRow` from `@/server/orders/submitted-rounds` (Story 4.4's review). `architecture.md` states "Components never import from `src/server/`". It is type-only and erased at build, but the boundary is a rule, not a runtime accident.
  - Create `src/types/orders.ts` with `SubmittedRoundRow`, `SubmittedItemRow`, and this story's request and response types. The server module and the components both import from there.

- [x] **Task 3 — `order.service.ts`: `submitRound`** (AC: 1, 4, 6, 7, 8, 9, 10)
  - `src/server/services/order.service.ts` — the name `architecture.md` already reserves. One exported function taking a `Tx`, so Epic 12's relay consumer can call the same code ("never writes directly; hands requests to `order.service.submit()`").
  - Inside ONE transaction, in this order:
    1. **Replay check first.** `select` the round by `submissionId`. If it exists **and belongs to this session**, return it with `replayed: true` and write nothing. If it exists on ANOTHER session, that is a client bug — 409 `SUBMISSION_ID_REUSED`, never a silent success.
    2. `lockOpenSession(tx, sessionId)` — the 4.3 helper. Locks the row and refuses a closed session.
    3. Load every referenced seat: all must have `session_id = sessionId` (AC-10).
    4. Load every referenced menu item: all must exist, be `is_available`, and have `price_paisa === quotedPricePaisa` (AC-7, AC-9). Report the FIRST failure with its id. Read these rows `FOR SHARE`, so an 86 cannot commit in the middle of the check and still let the round through.
    5. `roundNumber = coalesce(max(round_number), 0) + 1` for the session, read under the lock from Step 2. Take the max from **`order_rounds`**, not `order_events`: pre-0014 events have NULL rounds, and 4.4's history treats those as round 1, so a fresh `order_rounds` starting at 1 would give the first real send the same number. **Seed the max from events too** — `greatest(max rounds, max coalesce(events.round_number, 1) where an ITEM_ADDED row exists)` — and say so in the comment.
    6. Insert the `order_rounds` row, then every `order_events` row.
  - Return `{ roundNumber, submissionId, itemCount, replayed, byDestination }`, where `byDestination` holds the lines per destination (with seat labels and notes) for the emits.
  - **Epic 8's hook:** leave one clearly marked place, after Step 4 and inside the transaction, where `inventory.service.decrementBatch()` will go. Do not implement it.
  - Throw typed errors (`ItemUnavailableError(itemId)`, `PriceChangedError(itemId, currentPricePaisa)`, `SeatNotOnSessionError(seatId)`, `SubmissionIdReusedError`) — the pattern `table-session.service.ts` uses.

- [x] **Task 4 — `POST /api/sessions/:sessionId/orders`** (AC: 1, 3, 6, 7, 8, 9, 10)
  - Same file as 4.4's `GET`. Body, validated with zod:
    ```ts
    {
      submissionId: uuid,
      lines: Array<{               // 1..100
        menuItemId: uuid,
        seatSlotId: uuid,
        quantity: int 1..99,
        modifierText: string ≤120 (trimmed, '' → null),
        quotedPricePaisa: int ≥0,
      }>
    }
    ```
  - A present-but-malformed body is **400** — do not repeat the seat route's `.catch()` mistake that 4.3's review found.
  - Responses: **201** new round; **200** replay; **400** body; **401**; **409** `SESSION_ALREADY_CLOSED` / `PRICE_CHANGED` / `SUBMISSION_ID_REUSED` / `ROUND_CONFLICT`; **422** `ITEM_UNAVAILABLE` / `SEAT_NOT_FOUND`; **500**.
  - **Emit only for a NEW round, after the commit, before responding** (AC-3). A replay emits nothing: the first request already did.
  - Emit `table:status_changed` for every table on the session, with the new dish count (AC-12). Reuse whatever the session routes already assemble for the payload — every field the client patches, including `groupTableLabels` and `unavailableReason` (Story 3.8's rule).
  - RBAC is inherited from `/api/sessions` (owner, waiter). **Verify as Kumar (kitchen): 403.** Do not add a policy.

- [x] **Task 5 — Socket authentication and rooms** (AC: 3, 11) — see Decision 1
  - `src/server/socket/authenticate.ts` — a STANDALONE module, following `src/server/db/sweep-sessions.ts`. It must not import `@/server/db` or the session service: both reach `server-only`, which throws in `server.ts` (Trap 2). Parse the `__cdrms_session` cookie from `socket.handshake.headers.cookie`, verify its HMAC (copy `verifySessionCookie`'s logic, or extract it into a dependency-free module both use), look up `staff_sessions` joined to `staff` with its own small pool, and refuse expired sessions.
  - `server.ts`: `io.use(authenticate)` — no staff, no connection. Store `{ staffId, role }` on `socket.data`.
  - Subscribe handlers, with names from `architecture.md:414`:
    - `kitchen:subscribe`, `pizza:subscribe`, `bar:subscribe` → `kitchen` role only. (There is no bar role. The kitchen role serves every production station until Epic 10 adds station users.)
    - `owner:subscribe` → owner only.
    - `session:subscribe { sessionId }` → waiter or owner; joins `session:{sessionId}`.
    - A refused join replies with an ack error and never throws.
  - `emitOrderSubmitted(room, payload)` and `emitOrderConfirmed(sessionId, payload)` in `events.ts`, wrapped like the existing emitters so a socket failure never fails a committed write.
  - Payloads follow `architecture.md:526`: `eventId`, `timestamp`, `staffId`, plus `sessionId`, `roundNumber`, `tableLabels`, `usesSeats` (Epic 5 prints seat sub-headers only where seats are used), and the destination's lines with seat labels **and seat notes** (4.3 AC-11 — the note IS on the kitchen ticket).
  - `useSocketEvent` stays as it is; add a small `useSocketRoom(event, args)` that emits the subscribe on connect AND on every reconnect. A room join is lost when the socket drops.

- [x] **Task 6 — The Send button** (AC: 5, 6, 7, 8, 9, 10, 13)
  - `order-screen.tsx` passes `onSubmitOrder` to the strip. The strip already renders "Send N to Kitchen & Bar" once a handler exists (4.4).
  - **Block the send client-side** while any staged line has a problem (4.4's `stagedProblems`). Say why in the bar's detail line rather than disabling silently.
  - **Persist the pending `submissionId` with the staged round** (Trap 5): generate it on the first tap of Send, store it in the 4.4 store beside the lines, reuse it on every retry, and drop it whenever the lines change. Clear both on 201/200.
  - On success: `clearStagedRound`, invalidate `['orders', sessionId]` and `['tables']`, and set the strip's state to `submitted` (4.4's derivation already does this once the lines are empty and a round exists).
  - On 422/409: flag the named line — `ITEM_UNAVAILABLE` → the 4.4 unavailable flag; `SEAT_NOT_FOUND` → the seat-gone flag; `PRICE_CHANGED` → a new "price changed to LKR X — tap to accept" state that updates the line's price, which counts as a change and so a new `submissionId`. `SESSION_ALREADY_CLOSED` → 4.4's terminal screen.
  - On 500 or network failure: keep everything, show "Not sent — tap Send to try again".
  - Join `session:{sessionId}` and invalidate the orders query on `order:confirmed`, so the second tablet sees the round without a focus refetch.

- [x] **Task 7 — Dishes, not rows** (AC: 12) — see Trap 4
  - `/api/tables` counts `ITEM_ADDED` ROWS. Since 4.4, one row can carry quantity 3. Change it to `sum(quantity)`.
  - The same count drives the walkout/abandon decision in `/api/sessions/:id/close`, the table-addressed close route, and the order page's `itemCount`. Change them together — they are documented as changing together.

- [x] **Task 8 — Verify** (AC: all)
  - No test framework; manual, as every prior story. Matrix below.
  - **The concurrent-send test and the replay test are not optional.** AC-4 and AC-8 are the reasons this story adds a table.

---

## Dev Notes

### 🚨 Decision 1 — socket authentication and rooms are built HERE

`architecture.md:341`: "Socket.io rooms (`table:*`, `kitchen`, `bar`, `owner`) must be established **before order submission is built**." They were not. Today:

- `server.ts`'s `io.on('connection')` only logs. **No handshake authentication** — anything on the LAN can connect and receive every broadcast.
- **No room exists**, and no subscribe handler. Every emit in `events.ts` is `getIO().emit(...)`, a broadcast.

AC-3 cannot be met without rooms, and the payload makes authentication a requirement rather than a nicety: a kitchen ticket carries **seat notes** — "bald man", "red shirt" (4.3 AC-11). Broadcasting physical descriptions of guests to unauthenticated sockets on a restaurant's Wi-Fi is not acceptable.

The existing broadcasts (`table:status_changed`, `counter:changed`, `menu:item_updated`) stay broadcasts — to AUTHENTICATED sockets only, now that the handshake refuses everyone else.

### 🚨 Decision 2 — the server decides the price; the quote only guards against surprises

Story 4.4's Trap 3 captured the price at stage time so a mid-service re-price cannot change what a guest was quoted. Writing that client value straight into `unit_price_paisa` would make the tablet the authority on money, in a product whose premise is that the owner stops being the fraud detector (`prd.md:25`). A modified client could order anything at LKR 0.

So the quote is a CHECK, not a value: the server writes the menu's current price, and refuses (409 `PRICE_CHANGED`) if it differs from what the waiter saw. The guest is never charged something the waiter did not see, and the tablet never sets a price.

### 🚨 Decision 3 — this story does not print, and Epic 5 is not ready to

`sprint-change-proposal-2026-08-21` replaced the architecture's synchronous `print.service.printTickets()` (`architecture.md:867`) with a **durable print queue** — new Story 5.0, a transactional outbox of `print_jobs` rows. **That proposal's epic changes E1, E2 and E4 were never applied to `epics.md`**: there is no Story 5.0 section, 5.2 still describes the synchronous TCP call, and this story's own ACs lack the idempotency requirement (added here as AC-8).

So Story 4.5:

- **does not** open TCP connections or call any print code. The architecture's inline print step is superseded.
- **does** commit the round durably — `order_rounds` plus `order_events` are exactly what Story 5.0's outbox will enqueue from, in the same transaction, when it exists.
- **does** emit `order:submitted` to the production rooms. Nothing listens yet (5.1 and 5.3 are deferred), and a socket event is not durable. That is why the DB write, not the event, is the record.

**Run `bmad-correct-course` before Epic 5** to apply E1, E2 and E4 to `epics.md`, and to correct E4's schema (see Task 1).

### 🚨 Trap 1 — the round number race

Two sends both read "the last round was 2" and both write 3. The fix is the one 4.3 settled for seat labels and 4.4 wrote into the schema comment: derive `max + 1` **inside** the transaction, **after** `lockOpenSession`. The unique index on `(session_id, round_number)` is the backstop. A pre-check outside the lock is the defect 3.9's and 4.3's reviews each found once.

### 🚨 Trap 2 — `server-only` throws in `server.ts`

`@/server/db` starts with `import 'server-only'`, whose default export condition throws outside Next's module graph — which is exactly where `server.ts` runs. `server.ts` already works around this for the session sweep (`src/server/db/sweep-sessions.ts`: its own `Pool`, no ORM, no server-only). The socket authenticator must follow that precedent. Importing the session service from `server.ts` will crash the process at boot.

### 🚨 Trap 3 — emit order, and what a replay must not do

- **Emit after commit.** Emitting inside the transaction announces a round that may still roll back (AC-6).
- **Emit before responding** (AC-3), so the confirming tablet and the kitchen see it together.
- **A replay emits nothing.** The first request already did; emitting again is the duplicate ticket AC-8 exists to prevent.
- **Wrap every emit.** `events.ts`'s helpers already swallow and log; a socket failure after commit is not a 500.

### 🚨 Trap 4 — "items" have been counting rows

`/api/tables` counts `ITEM_ADDED` rows, and so do both close routes and the order page. Before 4.4, one row was one dish. Since 4.4 merges the same dish on the same seat into one line with a quantity, **the first send of "Cashew × 3" will show "1 item" on the floor card** — and a walkout confirmation will quote the wrong count against the waiter's name. Every counter changes to `sum(quantity)` together.

### 🚨 Trap 5 — a retry must not double the order

The dangerous case is the one that looks like a failure: the server commits, then the response is lost (Wi-Fi drop, tablet sleeps, a page reload mid-request). The waiter sees "not sent" and taps again. Without a stable `submissionId` that is a second, identical round — two tickets, two sets of dishes, one bill twice as large.

So the id is created once per round **content**, persisted with the staged lines in the 4.4 store (so a reload keeps it), reused on every retry, and replaced only when the round itself changes. The server's replay path then turns the second tap into "already sent" instead of a duplicate.

### 🚨 Trap 6 — two boundary leaks from Story 4.4

- Components import types from `src/server/orders/submitted-rounds` (Task 2).
- `seat_slots` is referenced by `order_events` with `ON DELETE no action`. 4.3's `deleteSeat` refuses a seat with items, so a seat can no longer be deleted once a round has used it. That is correct — and it is also why AC-10's check must run under the same lock as the insert: a seat deleted between the check and the insert would otherwise hit the foreign key as a 500.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/server/db/schema.ts` | `orderEvents` has `round_number`, `modifier_text`; no rounds table | `orderRounds` + append-only trigger |
| `src/server/services/order.service.ts` | — | NEW: `submitRound` |
| `src/app/api/sessions/[sessionId]/orders/route.ts` | `GET` only; 404 for an unknown session | `POST` |
| `src/server/orders/submitted-rounds.ts` | the shared history loader (4.4 review) | types move to `src/types/orders.ts` |
| `src/server/socket/events.ts` | three broadcast emitters, no rooms | `emitOrderSubmitted`, `emitOrderConfirmed` |
| `src/server/socket/authenticate.ts` | — | NEW, standalone |
| `server.ts` | `io.on('connection')` logs only | `io.use(authenticate)`, subscribe handlers |
| `src/hooks/use-socket.ts` | one shared socket, `useSocketEvent` | `useSocketRoom` (re-joins on reconnect) |
| `src/components/pos/use-staged-round.ts` | store over `localStorage`, lines only | + pending `submissionId` |
| `src/components/pos/order-screen.tsx` | `onSubmitOrder` undefined; no Send button | wired, with error states |
| `src/app/api/tables/route.ts`, both close routes, the order page | count `ITEM_ADDED` rows | `sum(quantity)` |

**Preserve, do not regress:**

- **Append-only.** `order_events` and now `order_rounds` never see UPDATE or DELETE. A correction is a new row (Epic 7).
- **No dead controls.** The strip renders no button without a handler; keep it that way for Generate Bill (Epic 6).
- **Seats only in the Tables zone** (4.4, Teran). Non-Tables orders still send a `seatSlotId` — the automatic Seat 1 — and the payload's `usesSeats: false` tells Epic 5 not to print seat headers.
- **Counter sales.** No table, no `table:status_changed`; emit `counter:changed` instead so the counter list's item count refreshes.
- **Integer paisa** everywhere, and `lkrFromPaisa` for display.
- **A confident comment must match the code beneath it.** Five stories running, review has found comments describing behaviour the code does not have. Re-read each one against its lines before ticking a task.

### Verification matrix

| Case | Expected |
|---|---|
| Send a 3-line round (Kitchen + Bar) | 201, round 1; 3 `ITEM_ADDED` rows with round 1 and server prices; 1 `order_rounds` row |
| Send again (new round) | round 2; history shows both rounds |
| **Same `submissionId` twice** | 201 then 200 `replayed: true`; still ONE round, one set of rows |
| **Two different sends, same session, simultaneously** | two rounds with distinct numbers; all rows present |
| `submissionId` reused on another session | 409 `SUBMISSION_ID_REUSED` |
| Item 86'd before sending | 422 `ITEM_UNAVAILABLE` with its id; zero rows written |
| Owner re-prices an item before sending | 409 `PRICE_CHANGED` with the new price; zero rows |
| Line on another session's seat | 422 `SEAT_NOT_FOUND` |
| Closed session | 409 `SESSION_ALREADY_CLOSED` |
| Malformed body / 0 lines / quantity 0 | 400 |
| Kumar (kitchen) → `POST .../orders` | **403** |
| Socket with no cookie | refused at handshake |
| Kitchen socket, `kitchen:subscribe` then send | receives `order:submitted` with ONLY kitchen lines, including seat notes |
| Waiter socket, `kitchen:subscribe` | refused |
| Second waiter tablet on the same session | receives `order:confirmed`; history updates without a refocus |
| Pre-0014 session with old NULL-round items | first send is round 2, not round 1 |
| Send "Cashew × 3" | floor card says 3 items on every device |
| Counter sale send | works; counter list refreshes |
| Bean Bags send | works; payload `usesSeats: false` |
| Kill the network after tapping Send, then retry | no duplicate round |
| Force a DB error mid-transaction | 500; zero rows; no socket event |

Seed accounts: **Nina 1234 `waiter`**, **Aruna 5678 `owner`**, **Kumar 4321 `kitchen`**.

### Project Structure Notes

- `architecture.md` places submission at `POST /api/orders/:orderId/submit`. The epic places it at `POST /api/sessions/:sessionId/orders`, which is where 4.4's `GET` already lives, and there is no separate "order" entity — the session is the order. **Follow the epic.**
- `order.service.ts` is the name `architecture.md:450` reserves.
- Socket event names follow `domain:action`, snake_case after the colon (`order:submitted`, `order:confirmed`); subscribe commands are present tense (`kitchen:subscribe`).

### References

- [Source: `epics.md` Story 4.5; Story 5.2 (`order:submitted` as its trigger); Story 8.2 (the decrement inside this transaction)]
- [Source: `prd.md` FR9, FR12, FR13; NFR-D3; NFR-S3]
- [Source: `architecture.md:242`, `:341`, `:405-420`, `:526-540`, `:862-883`] — rooms, event names, payload shape, the superseded inline print step
- [Source: `sprint-change-proposal-2026-08-21.md` Issue C, Changes A5, E1, E2, E4] — print queue and idempotency, never applied to `epics.md`
- [Source: `4-3-implement-seat-slot-management.md`] — `lockOpenSession`, the seat-label race, the `.catch()` defect
- [Source: `4-4-implement-add-item-to-order-with-modifiers-and-seat-assignment.md`] — the staged store, `stagedProblems`, the strip seam, the `round_number` derivation rule
- [Source: `src/server/db/sweep-sessions.ts`] — the standalone-module precedent for `server.ts`

---

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Claude Code)

### Debug Log References

- Migration **0015** generated cleanly; the append-only trigger was added by hand in Migration 0001's exact form. Journal: `0014 …652460 → 0015 …185161`, monotonic.
- **Testing the trigger left a stray round on a real session.** A hand-inserted `order_rounds` row (round 99) could not be deleted, which proved the trigger works — and would have made that session's next send round 100. Removed by disabling the trigger for one transaction on the dev database and re-enabling it (`tgenabled = O` confirmed). Nothing else was written that way.
- **A background `pnpm dev` of mine never actually served anything.** A dev server was already running (PID 34780, later 36788 after it reloaded on the `server.ts` change), and mine exited with "Another next dev server is already running". Every test below ran against that existing server, which had reloaded with the new socket authentication. My redundant watcher was stopped.
- Wiring the send, I first invalidated `['counter-sales']`; the counter list's real key is `['counter-sessions']`. The refresh would have silently done nothing. `COUNTER_QUERY_KEY` is now exported from `table-grid.tsx` and imported, the same fix `MENU_QUERY_KEY` got in 4.4.
- Two stale comments corrected on the way: `nextSeatLabel` said it derived the label from the seat COUNT (it uses the highest number), and five routes said "Counts ITEM_ADDED" after they began summing quantities.

### Completion Notes List

**What shipped**

- **`order_rounds`** — one append-only row per sent round, keyed by the client's submission id, with `(session_id, round_number)` unique.
- **`order.service.ts` `submitRound`** — replay check, `lockOpenSession`, a second replay check under the lock, seat ownership, dish availability and price read `FOR SHARE`, round number derived under the lock from BOTH `order_rounds` and older `order_events`, then the round row and the event rows. Epic 8's decrement has a marked place.
- **`POST /api/sessions/:sessionId/orders`** — the status codes in the story, with every refusal naming what to fix. Announcements are sent only for a new round, after the commit and before the response.
- **Socket authentication and rooms** — `io.use` refuses any connection without a live staff session (same HMAC and idle-window rules as HTTP). The join rules: kitchen role → `kitchen` / `pizza_kitchen` / `bar`; waiter or owner → one `session:<id>` room; owner → `owner`. Every join re-checks the session.
- **`useSocketRoom`** — joins, and re-joins on every reconnect.
- **The Send button** — "Send 3 to Kitchen & Bar"; blocked with a stated reason while any line has a problem; a send id kept per round content, so retries are safe across a reload; each refusal refreshes the query that makes the right line light up; success refreshes the history before clearing the round, so the bar never flickers.
- **Price changes** — a staged line whose menu price has moved shows "now costs LKR X each (was LKR Y)" with an **Accept** button; the server refuses the send until it is accepted.
- **Dishes, not rows** — every "items" figure (floor card, counter list, both close routes, merge, unmerge, the order page) now uses one shared `dishCount` expression.
- **Boundaries** — shared order types moved to `src/types/orders.ts`; the session cookie's signing and checking moved to a dependency-free `src/server/auth/session-cookie.ts`, used by both the proxy's session service and the socket authenticator.

**Verification** — two scripts against the running server and database. No browser automation exists, so neither exercises the order screen's taps.

*API — 20/20:*

| Case | Result |
|---|---|
| New round, kitchen + bar | ✅ 201, round 1, 4 dishes; rows carry quantity, **server** price, trimmed note, round, staff |
| Same submission id again | ✅ 200 `replayed`, still one round and two rows |
| Second round | ✅ round 2 |
| **6 simultaneous sends** | ✅ six 201s, rounds 3–8, all distinct |
| **5 simultaneous identical sends** (double tap) | ✅ one 201 and four 200s; exactly one new row |
| Quoted price wrong | ✅ 409 `PRICE_CHANGED` with the current price; nothing written |
| 86'd dish in the round | ✅ 422 `ITEM_UNAVAILABLE` naming it; nothing written |
| Seat from another order | ✅ 422 `SEAT_NOT_FOUND` |
| No lines / quantity 0 / bad id / note of 121 chars | ✅ 400 each |
| Kumar (kitchen) | ✅ 403 |
| Floor card | ✅ 13 dishes from 10 rows |
| History | ✅ rounds 1–9 |
| Submission id reused on another order | ✅ 409 `SUBMISSION_ID_REUSED` |
| Counter sale | ✅ 201 |
| Closed order | ✅ 409 `SESSION_ALREADY_CLOSED` |
| `UPDATE order_rounds` | ✅ refused by the trigger |

*Sockets — 20/20:*

| Case | Result |
|---|---|
| No cookie / forged cookie | ✅ refused at the handshake |
| Kitchen joins `kitchen` | ✅ allowed |
| Kitchen joins a session room | ✅ refused |
| Waiter joins `kitchen` / `bar` / `owner` | ✅ refused |
| Malformed session id | ✅ refused |
| Waiter joins its order's room | ✅ allowed |
| Send with kitchen + bar dishes | ✅ the kitchen room gets **exactly one** `order:submitted`, with **only** the kitchen line, its seat label **and seat note**, the round, the table, `usesSeats` and ids |
| Waiter in the order's room | ✅ gets `order:confirmed` (round 1, 4 dishes) and no ticket |
| Waiter NOT in the room | ✅ gets nothing |
| Replay | ✅ 200, and no second ticket or confirmation |
| First send on a session with a pre-0014 NULL-round item | ✅ round 2, not a second round 1 |

*Render:* an order with nine sent rounds renders all nine, with the bar in the sent state and no error page. `tsc` clean; `eslint` (warnings shown) clean apart from the pre-existing warning in `src/server/socket/index.ts`.

**Not verified, and why**

- **The order screen's Send flow has not run in a browser**: the tap, the disabled-with-reason state, "Sending…", the price Accept button, the not-sent messages, a retry after a reload, the second tablet's history updating live. Everything underneath it is verified; the wiring above it compiles and has not been clicked.
- **AC-6's "force a DB error mid-transaction"** was not induced. Rollback is by construction (one `db.transaction`; announcements run only after it returns), and every refused case above confirmed zero rows written.
- **A retry after a genuinely lost response** was not staged end to end; its two halves were — the id persists with the round in the store, and a repeated id is answered as a replay (including five at once).

**Deliberate divergences**

- **Kitchen-role users serve every production room.** There is no bar or pizza role; logged for Epic 10.
- **`registerRoomHandlers` lives beside the authenticator** rather than in `socket/index.ts`, because it must be importable from `server.ts`, where anything touching `server-only` throws.
- **A session room is left automatically** when the same tablet joins another order's room, so a long shift does not collect every table's confirmations.
- **The price check is derived on the client as well as enforced on the server**, so a changed price shows before the tap, not only as a refusal after it.

### File List

- `src/server/db/schema.ts` — MODIFIED: `orderRounds`
- `src/server/db/migrations/0015_superb_joseph.sql` — NEW (with the append-only trigger)
- `src/server/db/migrations/meta/_journal.json`, `meta/0015_snapshot.json` — MODIFIED / NEW
- `src/types/orders.ts` — NEW: shared order types, request/response and event payloads
- `src/server/services/order.service.ts` — NEW: `submitRound` and its errors
- `src/server/orders/item-count.ts` — NEW: `dishCount`
- `src/server/orders/submitted-rounds.ts` — MODIFIED: types from `src/types/orders`
- `src/app/api/sessions/[sessionId]/orders/route.ts` — MODIFIED: `POST`
- `src/server/auth/session-cookie.ts` — NEW: dependency-free cookie signing and checking
- `src/server/services/session.service.ts` — MODIFIED: uses and re-exports the cookie module
- `src/server/services/table-session.service.ts` — MODIFIED: `nextSeatLabel` comment corrected
- `src/server/socket/authenticate.ts` — NEW: handshake authentication and room policy
- `src/server/socket/events.ts` — MODIFIED: `emitOrderSubmitted`, `emitOrderConfirmed`, room names
- `server.ts` — MODIFIED: `io.use(authenticateSocket)`, `registerRoomHandlers(io)`
- `src/hooks/use-socket.ts` — MODIFIED: `useSocketRoom`
- `src/components/pos/use-staged-round.ts` — MODIFIED: per-round send id, `acceptPrice`, UUID fallback
- `src/components/pos/order-screen.tsx` — MODIFIED: Send, error states, session room, live history
- `src/components/pos/order-action-strip.tsx` — MODIFIED: `note`, `sendBlocked`
- `src/components/pos/staged-round-list.tsx` — MODIFIED: price-changed line with Accept
- `src/components/pos/round-history.tsx` — MODIFIED: type import path
- `src/components/pos/table-grid.tsx` — MODIFIED: exports `COUNTER_QUERY_KEY`
- `src/app/api/tables/route.ts`, `src/app/api/sessions/route.ts`, `src/app/api/sessions/[sessionId]/close/route.ts`, `src/app/api/sessions/[sessionId]/tables/route.ts`, `src/app/api/tables/[tableId]/merge/route.ts`, `src/app/api/tables/[tableId]/unmerge/route.ts`, `src/app/api/tables/[tableId]/sessions/close/route.ts`, `src/app/orders/[sessionId]/page.tsx` — MODIFIED: dishes, not rows
- `_bmad-output/implementation-artifacts/deferred-work.md` — MODIFIED

### Change Log

- 2026-09-17: Implemented, Tasks 1–8. Sending a round is one transaction under the session lock, idempotent on a client send id (a new `order_rounds` table whose primary key is that id), priced by the server with the waiter's quote as a check, and announced to authenticated, role-policed socket rooms only after it commits. Verified against the running server: 20/20 API cases, including six simultaneous sends producing six distinct rounds and five simultaneous identical sends producing exactly one; 20/20 socket cases, including refusal of unauthenticated and forged connections, a kitchen ticket that carries only kitchen lines and the seat note, and no second announcement on a replay. Every "items" count in the app now counts dishes. Found while wiring: a cache refresh aimed at a query key that does not exist (`counter-sales` for `counter-sessions`), fixed by exporting the real key. The order screen's Send flow compiles and renders but has not been exercised in a browser.
- 2026-09-16: Story created. Reading the socket server and the 2026-08-21 change proposal against the epic's ACs found three things the story must carry. **Socket rooms and socket authentication do not exist**, though the architecture requires them before submission is built — and the kitchen payload includes guests' physical descriptions, so authentication is a requirement. **The proposal's idempotency change (E4) and its print-queue story (E1) were never applied to `epics.md`**, and E4's proposed schema (one unique key per session) would have blocked every round after the first; the key belongs on a new `order_rounds` table. **The client-quoted price cannot be written as-is**, or the tablet sets prices; the server writes the menu price and refuses a mismatch. Five ACs added (idempotency, server price, seat ownership, socket auth, dish counts) plus one for retry safety. Six traps, including the lost-response retry that would double an order and the row-count "items" that 4.4's quantity merge has made wrong on the floor.
