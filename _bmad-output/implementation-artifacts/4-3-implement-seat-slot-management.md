# Story 4.3: Implement Seat Slot Management

Status: review

- **Epic:** 4 — Order Entry & Multi-Destination Routing
- **Story ID:** 4.3
- **Requirement:** FR10
- **Blocks:** 4.4 assigns every item to a seat; 4.5 writes `seat_slot_id` on every `order_event`; Epic 6.4 bills a seat by id. **None of that is expressible today** — see Decision 1.

---

## Story

**As a** waiter,
**I want** to create named seat slots on a table before taking orders,
**so that** I can track which items belong to which person from the moment of order entry.

---

## Acceptance Criteria

**AC-1: One seat exists without asking**
**Given** a waiter opens a new session
**When** the order screen loads
**Then** a single seat slot labelled **Seat 1** already exists; a single-guest table needs no setup at all

**AC-2: Adding a seat**
**Given** a waiter taps **Add Seat**
**When** it completes
**Then** `POST /api/sessions/:sessionId/seats` creates a slot with the next sequential label (Seat 2, Seat 3…) and it appears immediately

**AC-3: The seat selector**
**Given** a session has more than one seat
**When** the order screen renders
**Then** the seats are a horizontally scrollable chip row; the active seat is highlighted; tapping a chip makes it active for subsequent item additions

**AC-4: `POST /api/sessions/:sessionId/seats`**
**Given** the route is called
**When** it succeeds
**Then** a `seat_slots` row is created with `session_id`, `seat_label` and `created_at`; **201** with the new seat's `id` and `seatLabel`

**AC-5: Seats persist and are shared**
**Given** a session has seats
**When** it is loaded on any device
**Then** every seat is visible and selectable; seats survive a refresh, a reconnection, and being opened on a second tablet

**AC-6: The last seat cannot be deleted**
**Given** a session has exactly one seat
**When** a waiter tries to delete it
**Then** it is refused — an active session always has at least one seat

**AC-7: Deleting a seat that has items is refused** *(added beyond the epic)*
**Given** a seat has order items assigned to it
**When** a waiter tries to delete it
**Then** it is refused with a message naming the count — deleting it would orphan `order_event` rows on an **append-only** table, which cannot be corrected afterwards

**AC-8: A seat belongs to the SESSION, not to a table** *(added beyond the epic)*
**Given** a merged group or a counter sale
**When** seats are listed
**Then** there is exactly one set of seats for the whole session — a party across three tables shares one seat list, and a counter sale has seats like anything else. See Decision 2.

**AC-9: The seats namespace is policed** *(added beyond the epic)*
**Given** a kitchen user calls any route under `/api/sessions/:id/seats`
**When** the proxy evaluates the policy
**Then** it is refused — inherited from `/api/sessions`, which Story 3.9 added. **Verify; do not add a policy.**

**AC-10: A seat can carry a note naming the person** *(added 2026-09-12, Teran)*
**Given** a waiter is adding or editing a seat
**When** they type a short note — "red shirt", "curly hair", "bald man"
**Then** it is stored on the seat, optional and never required, and the chip shows the note in place of the number

**Given** a seat with no note
**When** the chip renders
**Then** it shows its label — "Seat 3" — unchanged

**AC-11: The note NEVER reaches a guest-facing bill** *(added 2026-09-12, Teran)*
**Given** a seat carries a note
**When** a bill is generated for that seat
**Then** the bill shows the seat LABEL and not the note — handing someone a slip reading "Bald man · LKR 2,400" is a bad thirty seconds, and the note exists to help staff remember a face, not to describe a customer to their face

**Given** the same seat
**When** a kitchen ticket is produced
**Then** the note IS shown — `Table 7 · Seat 2 (red shirt)` — because that is the moment it earns its keep: the runner has to hand the plate to the right person

---

## Tasks / Subtasks

- [x] **Task 1 — Schema: seats become rows** (AC: 4, 6, 7, 8) — **everything else depends on this**
  - `src/server/db/schema.ts`:
    ```ts
    export const seatSlots = pgTable('seat_slots', {
      id:        uuid('id').primaryKey().defaultRandom(),
      sessionId: uuid('session_id').notNull().references(() => orderSessions.id),
      seatLabel: text('seat_label').notNull(),
      /** "red shirt", "curly hair" — a memory aid, never printed for a guest. */
      seatNote:  text('seat_note'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    }, (t) => [
      index('idx_seat_slots_session_id').on(t.sessionId),
      uniqueIndex('idx_seat_slots_session_label').on(t.sessionId, t.seatLabel),
    ])
    ```
  - `seat_note` is **nullable and unconstrained in length at the database**; the 40-character cap is a UI affordance, not an invariant, and a CHECK would turn a waiter's typo into a 500. The unique index covers `seat_label` only — two people in red shirts is not an error.
  - The unique index is what stops two "Seat 2"s appearing when two devices add a seat at the same moment. **The database decides that race**, as it decides every other race in this codebase — do not pre-check the max label and hope.
  - **`order_events.seatSlot` (integer) becomes `seatSlotId` (uuid, nullable, FK).** See Decision 1. `order_events` currently holds **14 rows, none with a seat value**, so the migration drops and adds rather than backfilling — state that in the migration comment so nobody later assumes data was migrated.
  - **Also rename `unitPricePaysa` → `unitPricePaisa`.** Same typo Story 4.2 fixed on `menu_items`; the column is `unit_price_paisa`, nothing reads the key yet, and Story 4.5 is about to write to it. Leave `compRecords.amountPaysa` and `paymentRecords.amountPaysa` alone — Epics 6 and 7 own those, and they are logged.
  - **⚠️ MIGRATION JOURNAL.** After `pnpm db:generate`, confirm the new entry's `when` exceeds 0010's `1789143478009`. The real clock has now overtaken the hand-set values, so this should pass — **check anyway**; it has silently skipped a migration three times.
  - `order_events` is append-only (migration 0001's trigger). The trigger fires on row UPDATE/DELETE, not on DDL, so `ALTER TABLE` is fine.

- [x] **Task 2 — Service: a seat comes with the session** (AC: 1, 8)
  - `table-session.service.ts` — `openSession` AND `openCounterSession` both create **Seat 1** in the same transaction that creates the session.
  - In the transaction, not a follow-up call: AC-1 says the seat exists with no action required, and a session that committed without one would be a session the order screen cannot assign an item to.
  - Add `createSeat(tx, { sessionId, seatLabel })` and `nextSeatLabel(tx, sessionId)` so the route and the open path share one implementation.

- [x] **Task 3 — Routes** (AC: 2, 4, 6, 7, 9)
  - `POST /api/sessions/[sessionId]/seats` — 201 `{ id, seatLabel }`. The label is derived server-side; **never trust a client-supplied label**, or two devices produce "Seat 2" and "Seat 2".
  - `POST` accepts an optional `seatNote`; `PATCH /api/sessions/[sessionId]/seats/[seatId]` updates it. **Editable after the fact** — the useful detail ("the one in the red shirt") is usually noticed after the order has started, not before.
  - Trim the note and store `null` for an empty string, so a cleared field is genuinely cleared rather than becoming `''` that the chip then renders as a blank pill.
  - `DELETE /api/sessions/[sessionId]/seats/[seatId]` — 409 `SESSION_NEEDS_A_SEAT` when it is the last (AC-6), 409 `SEAT_HAS_ITEMS` when `order_events` reference it (AC-7).
  - `GET` is not needed: seats come with the order screen's own query (Task 4).
  - **Verify the policy rather than adding one.** `{ prefix: '/api/sessions', roles: ['owner','waiter'] }` exists from Story 3.9 and covers everything beneath it. Confirm as Kumar (4321) — this is the check, not the assumption.
  - Both guards must hold **inside the transaction**, under a `FOR UPDATE` lock on the session row. Story 3.9's review found the last-TABLE guard reading in one transaction and writing in another, so two devices could both pass. Do not repeat it one story later.

- [x] **Task 4 — The seat chip row** (AC: 1, 3, 5)
  - `src/components/pos/seat-chip-row.tsx`. Same idiom as `MenuCategoryChips` — and **extract nothing yet**: three chip rows now exist (zones, menu categories, seats) and a shared abstraction is worth building when the third one proves what they actually have in common, not before. Note the duplication in the Dev Agent Record.
  - Active chip uses **`brand-700`**, not `brand-500` — white on 500 is 3.9:1 and fails AA, corrected across the codebase on 2026-09-12.
  - Seats come from the order page's server query, not a separate fetch — AC-5's "any device" is satisfied by the page load, and Story 4.4 will need them in the same render anyway.
  - A chip shows `seatNote` when present, otherwise `seatLabel` — the row should read as people, because people are what the waiter is looking at. Keep the label in the accessible name either way (`"Seat 2, red shirt"`), so a chip is still identifiable when the note is absent or ambiguous.
  - The note is entered inline when adding a seat and editable by selecting the seat afterwards. **Never required** — Add Seat with an empty note must work in one tap.
  - **Add Seat** sits at the end of the row. **Delete** is NOT on the chip: a mis-tap must not destroy a seat. Put it behind selecting the seat, consistent with the floor screen's select-then-act rule.

- [x] **Task 5 — Verify** (AC: all except where noted)
  - No test framework; manual, as every prior story. Matrix in Dev Notes.
  - **The concurrent Add Seat test is not optional** — it is the only thing that proves the unique index, and Task 1's whole design rests on it.

---

## Dev Notes

### 🚨 Decision 1 — seats must be ROWS, and `order_events.seat_slot` is the wrong shape

There is **no `seat_slots` table**. What exists is a bare integer:

```ts
// order_events
seatSlot: integer('seat_slot'),
```

Every downstream story needs identity, not a number:

| Where | Needs |
|---|---|
| AC-4 (this story) | "a `seat_slot` row is created with `session_id`, `seat_label`" |
| AC-6, AC-7 | deleting a seat — you cannot delete an integer |
| `epics.md:1398` (4.5) | every `order_event` row carries **`seat_slot_id`** |
| `epics.md:1668` (6.4) | `POST /api/sessions/:sessionId/seats/:seatId/bill`, and `bill.seat_slot_id` |

An integer cannot be renamed, cannot be deleted, and cannot be referenced by a bill. So this story creates the table and converts the column. `order_events` holds **14 rows and none has a seat value**, so nothing is migrated — the conversion is free today and gets progressively more expensive every story that writes items.

The architecture document says nothing about seat slots at all, so there is no prior decision to contradict.

### 🚨 Decision 2 — a seat belongs to the SESSION

FR10 says "seat slots on a single table", which was written before merged tables and counter sales existed. Both change the picture:

- A **merged group** is one session across several tables. One seat list, shared — a party of six at two pushed-together tables is one party, and "Seat 4" means one person, not one per table.
- A **counter sale** has no table at all, and two friends buying at the bar can still want separate bills.

`seat_slots.session_id` therefore, never `table_id`. This also makes seating a counter sale (Story 3.9 AC-5) a non-event for seats: the session keeps the seats it had.

### 🚨 Decision 3 — the note is internal, and stays internal

A waiter cannot ask four strangers their names, so the seat note is how a person becomes identifiable: "red shirt", "curly hair", "bald man". Teran's request, 2026-09-12.

It appears on exactly two surfaces, and the split is deliberate:

| Surface | Note shown? | Why |
|---|---|---|
| The seat chip row | **Yes** | The row should read as people, not numbers |
| The kitchen ticket (Epic 5) | **Yes** | `Table 7 · Seat 2 (red shirt)` is how the runner delivers to the right person — the moment the note earns its keep |
| A guest-facing **bill** (Epic 6) | **NO** | Handing someone a slip reading "Bald man · LKR 2,400" is a bad thirty seconds |

That last row is a product decision, not an oversight, and it has to be **enforced where the bill is built**, not left to whoever writes that story to remember. AC-11 states it, and it is logged against Epic 6 in `deferred-work.md` so it arrives as a requirement rather than as a discovery.

Worth being clear about what this data is: a physical description of a customer, stored against a session that lives in the audit trail indefinitely. That is defensible for a memory aid on a single-restaurant system — but it is a reason to keep it off anything printed, out of any export, and short.

### 🚨 Trap 1 — two devices adding a seat at the same moment

Both read "the highest label is Seat 1", both create "Seat 2". Nothing in the label generation is atomic.

The fix is the unique index on `(session_id, seat_label)` and a `23505` catch — **not** a pre-check. This codebase decides races in the database everywhere else (`idx_one_open_session_per_table`, the conditional close UPDATE), and `src/server/db/errors.ts` already has the named-index helper. On a collision, re-derive the next label and retry once; a second collision is a 409.

### 🚨 Trap 2 — the last-seat guard must hold the lock it checks

Story 3.9's review found exactly this defect in the last-TABLE guard: the count ran in its own transaction which closed before the release began, so two devices both passed and left a session attached to nothing. `releaseTable` now takes a `FOR UPDATE` lock on the session row and counts inside it.

AC-6 is the same shape. Lock the session row, count seats, then delete — in one transaction. The fix is already written one file over; copy the pattern, not just the intent.

### 🚨 Trap 3 — deleting a seat with items would orphan append-only rows

`order_events` is append-only, enforced by a database trigger (migration 0001). If a seat is deleted while `order_events.seat_slot_id` rows point at it, those rows cannot be updated to repair the reference — the trigger refuses. Restoring the seat is not possible either; it is a new row with a new id.

Hence AC-7. `ON DELETE no action` on the FK makes the database refuse too, but the route must catch it first and say something a waiter can act on ("Seat 3 has 4 items on it") rather than surfacing a 500.

### Known gap for Story 4.5 — `round_number` does not exist either

`epics.md:1398` requires each `order_event` row to carry `session_id`, `seat_slot_id`, `menu_item_id`, `modifier_text`, `staff_id`, `round_number` and `submitted_at`. Against the current table:

| Specified | Reality |
|---|---|
| `seat_slot_id` | **this story adds it** |
| `modifier_text` | `notes` exists — decide whether it serves or a column is needed |
| `round_number` | **missing entirely**, and "Add More Items" plus the KOT's "Round 2" header both depend on it |
| `submitted_at` | `created_at` exists |

Not this story's work. Recorded here so 4.4 and 4.5 are not surprised, and logged in `deferred-work.md`.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/server/db/schema.ts` | No seat table; `order_events.seatSlot` is an integer; `unitPricePaysa` misspelled | `seatSlots`; `seatSlotId` FK; the typo fixed |
| `src/server/services/table-session.service.ts` | `openSession`, `openCounterSession`, `attachTables`, `releaseTable`, `closeSession` | `createSeat`, `nextSeatLabel`; both open paths create Seat 1 |
| `src/app/orders/[sessionId]/page.tsx` | Loads session, tables, staff, config, item count | Also loads seats, passes them down |
| `src/components/pos/order-screen.tsx` | Info card, `MenuBrowser`, close controls, `OrderActionStrip` | Seat chip row above the menu |
| `src/app/api/sessions/[sessionId]/seats/route.ts` | — | NEW — POST, and PATCH under `[seatId]` |
| `src/components/pos/seat-chip-row.tsx` | — | NEW |

**Preserve, do not regress:**

- The order screen works for a **counter sale** — `tableLabel` and `zoneName` are nullable, the walkout copy branches on `tableLabel`, and the info card's label reads "Type: Counter sale". Seats must not reintroduce a table assumption.
- Only the **menu grid scrolls**; the search field and chips are `shrink-0` and the page does not grow. A seat row added above the menu must be `shrink-0` too, or it will push the grid and reintroduce the bug where "Close table" ended up below every dish.
- The strip is driven by `itemCount`, not hardcoded. Seats do not change that.
- **`brand-700` for active chips.** `brand-500` with white text fails AA and was corrected across the codebase on 2026-09-12.
- Socket payloads carry every field the client patches. If seats ever go live-updated, the payload carries them — Story 3.8's `groupTableLabels` lesson.

### Verification matrix

| Case | Expected |
|---|---|
| Open a table session | exactly one seat, labelled **Seat 1**, with no action |
| Open a **counter** sale | same — one seat, same shape |
| `POST .../seats` ×2 | Seat 2 then Seat 3; 201 each with `id` and `seatLabel` |
| **Two devices POST `.../seats` simultaneously** | **two DISTINCT labels, no duplicate, no 500** |
| Reload the order screen | every seat still there and selectable |
| Open the same session on a second tablet | identical seat list |
| `DELETE` the only seat | 409 `SESSION_NEEDS_A_SEAT` |
| `DELETE` a seat with items | 409 `SEAT_HAS_ITEMS`, naming the count |
| **Two devices DELETE the last two seats at once** | one 200, one 409 — never zero seats |
| Merged group (B1+B2+B3) | ONE seat list for the session |
| **Kumar (4321, kitchen) → any `/seats` route** | **403**, inherited from `/api/sessions` |
| Nina (1234, waiter) | allowed |
| Seat row on a long menu | row stays put; only the grid scrolls |
| Add a seat with a note | chip reads **Red shirt**, not "Seat 2" |
| Add a seat with no note | chip reads **Seat 3** |
| Edit a note after ordering has started | updates; items stay on the seat |
| Clear a note | chip reverts to the seat label, not a blank pill |
| Accessible name, note present | `"Seat 2, red shirt"` — both facts |

Seed accounts: **Nina 1234 `waiter`**, **Aruna 5678 `owner`**, **Kumar 4321 `kitchen`**.

### Project Structure Notes

- API paths are plural nouns, kebab-case (`architecture.md:367`). `/api/sessions/:sessionId/seats` matches the shape Epic 6 already assumes.
- Components: kebab-case files, PascalCase exports, in `src/components/pos/`.
- `architecture.md` describes no seat model, so nothing here contradicts it — but it should probably gain one once this ships.

### References

- [Source: `epics.md` Story 4.3; `:1398` for what 4.5 writes; `:1668`/`:1683` for Epic 6's seat billing]
- [Source: `prd.md` FR10]
- [Source: `ux-design-specification.md:718-727`] — Flow 2, the upfront seat model
- [Source: `_bmad-output/implementation-artifacts/3-9-implement-counter-sale.md`] — the last-table guard defect this story must not repeat, and the `/api/sessions` policy it inherits
- [Source: `src/server/db/errors.ts`] — the named-index unique-violation helper for Trap 1

---

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Claude Code)

### Debug Log References

- `drizzle-kit generate` needed a TTY to answer the `seat_slot` → `seat_slot_id` rename-or-drop prompt. Split into two unambiguous passes instead: **0011** adds `seat_slots`, `order_events.seat_slot_id` and `unit_price_paisa` (both old and new columns present), **0012** drops `order_events.seat_slot`. Journal checked after each: `0010 …478009 → 0011 …968012 → 0012 …983513`, monotonic.
- **Verification found a real defect in the POST retry loop.** A twelve-way concurrent burst returned **5 × 500** alongside 7 × 201. The unique index held — every label was distinct — but a unique violation on the *second* attempt was re-thrown into the generic handler, so an ordinary lost race surfaced as a server error. Fixed: a collision on the last attempt returns **409 `SEAT_LABEL_TAKEN`** and logs a warning. Re-run: 6 × 201, 6 × 409, 20 distinct labels, zero duplicates, zero 500s.
- AC-7 needed an `order_events` row pointing at a seat, which no route writes until Story 4.5. One was inserted directly into the dev database. It cannot be removed — `order_events` is append-only and the trigger refuses DELETE — so the dev data carries one fabricated `ITEM_ADDED` (2 × LKR 1,500) on a session that was then closed as a walkout. Harmless, and it disappears on the next re-seed.
- The dev server was left running throughout. `.next` was not touched — deleting `.next/dev` under a live server corrupted Turbopack's cache earlier in this epic.

### Completion Notes List

**What shipped**

- `seat_slots` as a real table keyed on `session_id`, with `idx_seat_slots_session_label` as the thing that actually decides the Add Seat race, plus the `order_events.seat_slot` → `seat_slot_id` (uuid FK) conversion and the `unitPricePaysa` → `unitPricePaisa` rename that Story 4.5 is about to write to.
- Both open paths — `openSession` and `openCounterSession` — create **Seat 1** inside the transaction that creates the session, so AC-1 is true by construction rather than by a follow-up call that could fail on its own.
- Three routes under `/api/sessions/:sessionId/seats`, all inheriting Story 3.9's `/api/sessions` policy. **Verified as Kumar (4321, kitchen): 403 on both POST and GET.** No policy was added.
- `SeatChipRow`, wired into the order screen above the menu. A chip shows the seat's note when it has one and its label otherwise; the accessible name always carries both.
- The note editor sits behind selecting a seat and tapping **Edit** — removal is one step further in, behind a confirmation, because a seat cannot be brought back: a new one is a new row with a new id, and any `order_events` pointing at the old one could never be repaired.

**Deliberate divergences and judgement calls**

- **Seats reach the client twice over.** The page's server query supplies them (AC-5's "any device" is satisfied in the first paint), and the screen holds them in a TanStack query seeded with `initialData` and a 30s `staleTime`, so it never fetches on mount but the three mutations can invalidate and get the truth back without a page reload. This is why the `GET` exists despite Task 3 saying it was not needed.
- **The active seat is derived, not synced.** `activeSeatId` falls back to the first seat whenever the selection no longer exists. Story 4.2's review replaced the same shape on the category chips; an effect that writes state after render is a frame of wrong UI, and the React Compiler lint rejects it besides.
- **Add Seat opens the note field but never requires it.** One tap creates the seat; the editor appears already selected so the note can be typed while the waiter is still looking at the person, and is skipped by ignoring it.
- **Remove seat is hidden when only one seat remains.** The server refuses it either way (AC-6, verified) — this just stops a waiter discovering the rule by being told no.
- **Nothing was extracted.** Three chip rows now exist — `ZoneChipBar`, `MenuCategoryChips`, `SeatChipRow` — sharing an idiom and almost no props: open counts and a Counter pill, a category icon, a person's description and an Edit affordance. A shared abstraction here would be parameterised into uselessness. Logged in `deferred-work.md` against a fourth.

**Verification results** (dev server, seeded data, Nina 1234 / Kumar 4321)

| Case | Result |
|---|---|
| Open a table session | ✅ one seat, `Seat 1`, no action |
| Open a counter sale | ✅ identical |
| `POST .../seats` ×2 | ✅ `Seat 2` then `Seat 3`, 201 each |
| Note trimmed on create | ✅ `"  red shirt  "` → `"red shirt"` |
| **12 concurrent POSTs** | ✅ **20 distinct labels, no duplicate, no 500** — 6 × 201, 6 × 409 `SEAT_LABEL_TAKEN` (was 5 × 500 before the fix) |
| Label after deleting a middle seat | ✅ a session holding only `Seat 2` gets `Seat 3`, not a reused `Seat 1` |
| `DELETE` the only seat | ✅ 409 `SESSION_NEEDS_A_SEAT` |
| `DELETE` a seat with items | ✅ 409 `SEAT_HAS_ITEMS` — "This seat has 1 item on it" |
| **Concurrent DELETE of the last two seats** | ✅ one 200, one 409 — one seat left, never zero |
| Merged group B1 + B3 | ✅ one seat list of three for the whole session |
| Kumar (kitchen) → POST and GET | ✅ 403 both, inherited |
| Nina (waiter) | ✅ allowed throughout |
| `PATCH` a note after ordering started | ✅ 200, item stayed on the seat |
| Clear a note | ✅ `"   "` → `null`, chip reverts to `Seat 1` |
| Seat id from another session | ✅ 404 `SEAT_NOT_FOUND`, nothing updated |
| Note over 40 characters | ✅ 400 `INVALID_BODY` |
| Server-rendered order page | ✅ chips read `Seat 1`, `red shirt`, `Seat 3`; accessible name `"Seat 2, red shirt"`; `Add Seat` and `Edit Seat 1` present; `bg-brand-700` active |
| Counter-sale order page | ✅ renders with its seat row and "Counter sale" |
| Row does not steal from the menu | ✅ section is `shrink-0`; only the grid scrolls |

**Not verified, and why**

- **AC-11** (the note never reaches a guest bill) cannot be tested — no bill exists until Epic 6. The requirement is recorded in `deferred-work.md` against Epic 6.4 so it arrives as a requirement rather than a discovery, and the editor's own copy states the promise to the person typing it.
- No browser pass. Everything above is API responses and server-rendered HTML; the touch behaviour of the chip row and the editor panel has not been seen on a real screen. Epic 4's UI as a whole is still unviewed.

### File List

- `src/server/db/schema.ts` — MODIFIED: `seatSlots`; `orderEvents.seatSlotId` (uuid FK) replacing `seatSlot` (integer); `unitPricePaysa` → `unitPricePaisa`
- `src/server/db/migrations/0011_*.sql` — NEW: `seat_slots`, its two indexes, `order_events.seat_slot_id`, `order_events.unit_price_paisa`
- `src/server/db/migrations/0012_*.sql` — NEW: drops `order_events.seat_slot`
- `src/server/db/migrations/meta/_journal.json` — MODIFIED
- `src/server/services/table-session.service.ts` — MODIFIED: `nextSeatLabel`, `createSeat`, `deleteSeat`, `SessionNeedsASeatError`, `SeatHasItemsError`; both open paths create Seat 1
- `src/app/api/sessions/[sessionId]/seats/route.ts` — NEW: POST (server-derived label, one retry, 409 on a lost race), GET
- `src/app/api/sessions/[sessionId]/seats/[seatId]/route.ts` — NEW: PATCH (note), DELETE (both guards)
- `src/components/pos/seat-chip-row.tsx` — NEW
- `src/components/pos/order-screen.tsx` — MODIFIED: seat row, note editor, three mutations
- `src/app/orders/[sessionId]/page.tsx` — MODIFIED: loads the session's seats and passes them down
- `_bmad-output/implementation-artifacts/deferred-work.md` — MODIFIED

### Change Log

- 2026-09-12: Story created. Two decisions recorded: seats must be ROWS rather than the bare `order_events.seat_slot` integer that exists today — AC-4, AC-6, Story 4.5's `seat_slot_id` and Epic 6.4's `/seats/:seatId/bill` all need identity, and the conversion is free right now because `order_events` holds 14 rows with no seat values; and a seat belongs to the SESSION rather than a table, because FR10 predates merged tables and counter sales, both of which make "seats on a table" wrong. Three ACs added beyond the epic: AC-7 (deleting a seat with items would orphan rows on an append-only table), AC-8 (one seat list per session), AC-9 (verify the inherited policy rather than adding one). Three traps documented, two of them defects this codebase has already shipped once — a race decided in application code instead of the database, and a guard that does not hold the lock it checks. Also recorded: `round_number` does not exist and Story 4.5 requires it.
- 2026-09-12: Implemented, Tasks 1–5. `seat_slots` created and `order_events.seat_slot` converted to `seat_slot_id` across migrations 0011 and 0012 (split to avoid drizzle-kit's interactive rename prompt); journal confirmed monotonic. Verification caught a defect the implementation had shipped: the POST retry loop re-threw a second unique violation into the generic handler, so a twelve-way burst produced five 500s for what is an ordinary lost race — now a 409 `SEAT_LABEL_TAKEN`. The unique index itself held throughout: 20 concurrent adds, 20 distinct labels. The last-seat guard was confirmed under concurrency too — two simultaneous deletes of the last two seats gave one 200 and one 409, never zero seats, which is the `FOR UPDATE` pattern Story 3.9's review had to introduce. AC-11 is unverifiable until Epic 6 has a bill and stays logged in `deferred-work.md`.
- 2026-09-12: AC-10 and AC-11 added at Teran's request — a seat carries an optional short note ("red shirt", "curly hair") because a waiter cannot ask four strangers their names, and the chip shows it in place of the number so the row reads as people. Teran's explicit call that the note must **not** print on a guest-facing bill; it appears on the waiter's screen and on the kitchen ticket, where it tells the runner who to hand the plate to. Logged against Epic 6 so the bill's builder receives it as a requirement rather than discovering it.
