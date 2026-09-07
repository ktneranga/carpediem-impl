# Story 3.2: Implement Zone-Filtered Table Grid with Real-Time Status

Status: in-progress

- **Epic:** 3 — Zone & Table Navigation
- **Story ID:** 3.2
- **Story Key:** 3-2-implement-zone-filtered-table-grid-with-real-time-status
- **Created:** 2026-08-21

---

## ⚠️ READ FIRST — blockers and corrections

**Two corrections were already applied to `epics.md` before this story was written** — you are reading the fixed version:

| Was | Now | Why |
|---|---|---|
| `table:statusChanged` | **`table:status_changed`** | `architecture.md:381` is authoritative for event names. A camelCase listener would never fire — the server emits snake_case, so real-time silently does nothing. 7 occurrences fixed across epics.md. |
| table status `"closed"` | **`unavailable`** | `tableStatusEnum` is `['open','occupied','unavailable']`. No `closed` value exists. |

**Three blockers you must clear before the grid can render:**

| # | Blocker | Action |
|---|---|---|
| 1 | **TanStack Query is not installed.** AC-4 names it explicitly and `architecture.md:255` mandates it for server state. | `pnpm add @tanstack/react-query` — **pre-approved**, do not HALT. Current: **v5.102.x**. There is no v6 for React (v6 is Svelte-only). |
| 2 | **`seed.ts` creates no zones and no tables.** The grid has nothing to render. | Extend the seed — Task 2. |
| 3 | **No Socket.io client wiring exists.** `socket.io-client@4.8.3` is installed but nothing imports it; there is no provider, no hook, no connection. | Build it — Tasks 5 and 6. |

---

## Story

As a waiter,
I want to see all tables filtered by zone with their live status,
So that I can instantly know which tables are available without hunting.

---

## Acceptance Criteria

**AC-1: Grid loads with real data**
**Given** a waiter lands on the main screen after authenticating
**When** the table grid loads
**Then** all tables across all zones render as `TableCard` components with their status from the database; `ZoneChipBar` is visible with "All Zones" active; load completes in under 1 second on the restaurant LAN

**AC-2: Zone filtering is client-side**
**Given** the grid is displayed
**When** a waiter taps a zone chip
**Then** only that zone's tables are shown; the filter is instant with **no additional network request** — it filters already-loaded data

**AC-3: Real-time status propagation**
**Given** the grid is displayed
**When** another device opens or closes a table session
**Then** the affected `TableCard` updates its status colour and label within 2 seconds via the Socket.io `table:status_changed` event; no manual refresh is required

**AC-4: Targeted invalidation**
**Given** a `table:status_changed` event is received
**When** TanStack Query processes it
**Then** only the affected table's data is updated; the full table list is not refetched from scratch

**AC-5: Open tables are actionable**
**Given** a table with status `open`
**When** a waiter views its card
**Then** the card is tappable and navigates toward the order screen for that table

**AC-6: Unavailable tables are inert**
**Given** a table with status `unavailable`
**When** a waiter views its card
**Then** the card is visually distinct (greyed or `status-alert`); tapping it does **not** open a session; an "Unavailable" label is visible

**AC-7: Grid data endpoint**
**Given** `GET /api/tables` is called
**When** the Route Handler responds
**Then** the response includes every table with `zoneId`, `zoneName`, `status`, and the active `sessionId` when occupied; response time is under 300ms on the restaurant LAN

**AC-8: Occupied cards show live detail**
**Given** an occupied table
**When** its card renders
**Then** elapsed minutes since `opened_at` and the active item count are shown, satisfying `TableCard`'s existing props from Story 3.1

**Given** the elapsed time is displayed
**When** a minute passes with no server event
**Then** the displayed elapsed time advances without a refetch

**AC-9: Seed provides a usable restaurant**
**Given** a developer runs the seed against an empty database
**When** it completes
**Then** four zones exist — Bean Bags, Sun Beds, Tables, Rooftop — with tables spread across them covering the `open` and `unavailable` statuses. *(AMENDED 2026-09-06 by code review: originally read "all three statuses", which contradicted Task 2 — an `occupied` table with no `order_sessions` row is data the grid query cannot explain. `occupied` coverage arrives with Story 3.3, which creates real sessions.)*

**AC-10: Socket connection is scoped and cleaned up**
**Given** the grid mounts
**When** the Socket.io client connects
**Then** exactly one connection is established per browser tab; it is torn down on unmount; a dropped connection reconnects automatically without duplicating listeners

---

## Tasks / Subtasks

- [x] **Task 1 — Install TanStack Query** (AC: 1, 4)
  - `pnpm add @tanstack/react-query` — **pre-approved**, do not HALT.
  - v5 (currently 5.102.x). **Do not look for v6** — it exists only for Svelte; React stays on v5.
  - Do not add `@tanstack/react-query-devtools` unless you actually use it.

- [x] **Task 2 — Extend `seed.ts` with zones and tables** (AC: 9)
  - Four zones with `displayOrder` 1–4: Bean Bags, Sun Beds, Tables, Rooftop.
  - Tables spread across them — include at least one `unavailable` so AC-6 is testable, and leave the rest `open`. **Do not seed `occupied`** — occupancy comes from an `order_sessions` row, and a table marked occupied with no session would be inconsistent data.
  - Keep the existing idempotency guard: the script already bails if a tenant exists. Extend that check, do not bypass it.
  - `label` is free text ("B1", "R2", "Table 4") — match the fixtures already used in `/nav-demo`.

- [x] **Task 3 — `GET /api/tables` Route Handler** (`src/app/api/tables/route.ts`) (AC: 7)
  - Returns every table for the tenant with its zone name and, when occupied, the active session.
  - **One query, not N+1.** Left-join `zones`, and left-join `order_sessions` on `closed_at IS NULL`:
    ```ts
    .leftJoin(orderSessions, and(
      eq(orderSessions.tableId, tables.id),
      isNull(orderSessions.closedAt),
    ))
    ```
    The partial unique index guarantees at most one open session per table, so this join cannot fan out.
  - Include `openedAt` so the client can compute elapsed time itself (AC-8) rather than asking the server every minute.
  - Item count comes from `order_events` — count `ITEM_ADDED` minus `ITEM_REMOVED` for the session, or simply count `ITEM_ADDED` rows for now and note the simplification.
  - Order by `zones.displayOrder`, then `tables.displayOrder`.
  - Standard envelope: `{ success: true, data: [...] }`.
  - Auth is already handled — the proxy rejects unauthenticated requests before this runs. Do **not** re-check the session here.

- [x] **Task 4 — TanStack Query provider** (`src/app/providers.tsx`) (AC: 1)
  - `'use client'`, wrapping `QueryClientProvider`.
  - Create the `QueryClient` **inside** a `useState` initialiser, not at module scope. A module-level client is shared across requests on the server and leaks one user's data into another's render.
  - Mount it in `layout.tsx` around `{children}`. Keep `layout.tsx` a Server Component — only the provider is a client component.
  - Sensible defaults: `staleTime` around 30s, and `refetchOnWindowFocus: false` (a tablet regains focus constantly during service; refetching every time is noise).

- [x] **Task 5 — Socket.io client hook** (`src/hooks/use-socket.ts`) (AC: 3, 10)
  - `socket.io-client@4.8.3` is installed but **nothing uses it yet**. This is the first client-side wiring.
  - One shared socket per tab — a module-level singleton created lazily, not one per component. Multiple components will subscribe later (Epics 4 and 5).
  - Connect to the same origin; the custom `server.ts` already attaches Socket.io to port 3000, so no URL configuration is needed.
  - Return the socket and a connection status. Clean up listeners on unmount, but **do not disconnect the shared socket** when a single component unmounts.
  - Reconnection is Socket.io's default; verify listeners are not re-registered on reconnect (that duplicates handlers and fires events twice).

- [x] **Task 6 — Emit `table:status_changed` from the server** (AC: 3)
  - Story 3.3 creates sessions; this story only needs the grid to *listen*. But nothing emits yet, so add the emit helper now and call it wherever table status changes.
  - Use `getIO()` from `src/server/socket/index.ts` — **call it inside the request function, never at module top level.** A deferred item from Story 1.1 warns that a module-level `getIO()` throws on import because `server.ts` has not run yet.
  - Payload: `{ tableId, status, sessionId, openedAt, itemCount }` — enough for a targeted cache update without a refetch. *(CORRECTED 2026-09-06 by code review: `itemCount` was implemented and required by `TableStatusChangedPayload` but missing from this task text, so a Story 3.3 implementer working from the task alone would hit a type error.)*
  - Event name is **`table:status_changed`** (snake_case). Getting this wrong means the listener never fires and real-time silently does nothing.

- [x] **Task 7 — Build the table grid screen** (`src/app/page.tsx`) (AC: 1, 2, 5, 6, 8)
  - Replace the Story 2.3 placeholder. This becomes the waiter's landing screen.
  - Compose the three Story 3.1 components — **do not modify them**, they are reviewed and complete.
  - `useQuery` for `/api/tables`; zone filter is `useState` + client-side `filter` (AC-2 forbids a refetch).
  - `unavailable` cards must not navigate (AC-6). Disable the interaction rather than only styling it — a greyed card that still fires `onSelect` is worse than no styling.
  - Elapsed minutes tick client-side (AC-8). Reuse the `useSyncExternalStore` pattern from `ContextHeader` rather than a `useEffect` + `setState` — Story 3.1 hit `react-hooks/set-state-in-effect` doing it the other way.
  - Tapping an `open` card navigates toward the order screen. **Story 3.3 creates the session**; here, route to a placeholder or hold selection state. Do not call `POST /api/tables/:id/sessions` — that is 3.3's AC.

- [x] **Task 8 — Targeted cache update on socket event** (AC: 4)
  - On `table:status_changed`, use `queryClient.setQueryData(['tables'], ...)` to patch the one affected row.
  - **`invalidateQueries` would refetch the whole list**, which AC-4 explicitly forbids. Patch, do not invalidate.
  - Guard against an event for a table not in the current cache (added by another device) — fall back to a single invalidation in that case only.

- [x] **Task 9 — Delete the Story 3.1 scaffold** (AC: 1)
  - Remove `src/app/nav-demo/page.tsx`. Story 3.1 flagged it for deletion once the real grid existed. That is now.

---


### Review Findings

Code review 2026-09-06 — three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) plus verification. Scope covered Story 3.2 **and** the unspecified design-system pass sharing the same working tree.

Baseline: `tsc --noEmit` clean, `eslint src` clean. Every finding below is semantic — none of it is caught by the toolchain.

#### Decision needed

- [x] [Review][Decision] **`[data-context]` variant system is now dead** — `@custom-variant waiter/owner/kitchen` remain defined in `globals.css:20-22` but grep finds zero consumers in `src/`. `TableCard` went from `waiter:min-h-20`/`min-w-20` to a fixed `h-30`, so Story 3.1 AC-3 (>=80x80 waiter, >=44x44 owner) no longer holds and the owner-density dial does not exist. `architecture.md:266` states all variant rules cascade from this attribute. Either the redesign intentionally supersedes the variant system (needs an architecture amendment plus a Story 3.1 AC-3 waiver) or the sizing must be restored. **RESOLVED 2026-09-06 — retro-spec.** The redesign is accepted as intentional and superseding. CARVE-OUT: the retro-spec must state how the redesign delivers owner-context density, since Epic 9 depends on it — it is not enough to note the variants are unused. Raised as a patch below.
- [x] [Review][Decision] **`ZoneChipBar` public contract broken under a task that forbids editing it** — `Zone` now requires `openCount`, and a new required `totalOpenCount` prop was added (`zone-chip-bar.tsx:6-19`). The spec documents `{id,name}[]`. Task 7 says the Story 3.1 components are "complete and reviewed — do not modify them". It compiles only because `nav-demo` was deleted in the same change. Accept the new contract (amend Story 3.1) or revert. **RESOLVED 2026-09-06 — retro-spec.** New contract accepted; amend the Story 3.1 component contract to `{id, name, openCount}[]` plus `totalOpenCount`.
- [x] [Review][Decision] **Sign-out is unreachable from the entire application** — `page.tsx` dropped `<LogoutButton />` when `TableGrid` replaced the placeholder; grep finds only the component's own definition. `POST /api/auth/logout` has no caller. On a shared tablet a waiter cannot end a shift, so the next person inherits their `x-staff-id` and every order is misattributed. Needs a placement decision (header, drawer, or restored on the grid). **RESOLVED 2026-09-06 — wire the existing staff button to logout.** Reuses the control already in the header rather than adding a second affordance; re-points to the PIN-switch flow when Story 2.4 lands. Raised as a patch below.
- [x] [Review][Decision] **Staff button in the header is inert** — `onStaffTap` is optional so `tsc` passes, but `TableGrid` never passes it. A 44px control announced as "Signed in as {name}. Switch user." does nothing. Story 2.4 (the PIN-switch flow) is deferred post-demo, so this needs a call: wire it to logout, hide it until 2.4, or leave it dead knowingly. **RESOLVED 2026-09-06 — same fix as the sign-out item above.** Passing `onStaffTap` resolves both findings in one change.
- [x] [Review][Decision] **AC-9 contradicts Task 2 — seed has no `occupied` table** — AC-9 requires "all three statuses"; Task 2 says "Do not seed `occupied`". The dev followed Task 2 (11 open, 2 unavailable, 0 occupied). Consequence: AC-8's entire `occupied` render branch, the elapsed-minute tick, and the item-count query have never executed once. The spec must be corrected one way or the other before 3.2 can be called done. **RESOLVED 2026-09-06 — AC-9 amended to two statuses.** Task 2 wins: its reasoning is sound. AC-9 text corrected in the Acceptance Criteria section above. Note the consequence stands — AC-8 has still never executed.
- [x] [Review][Decision] **Zone name no longer visible on cards** — `<span className="sr-only">{zoneName}</span>` replaced the visible zone name, breaking Story 3.1 AC-4 ("the card also shows the table label and zone name"). Related: `ContextHeader`'s leaf crumb changed from `Table {tableLabel}` to `{tableLabel}`, against Story 3.1 AC-10's literal breadcrumb format. Confirm whether the redesign intends this. **RESOLVED 2026-09-06 — retro-spec.** Deliberate design decision; supersedes Story 3.1 AC-4 and AC-10. Record the new breadcrumb format and the sr-only zone name in the retro-spec.
- [x] [Review][Decision] **`pin-pad.tsx` and `login/page.tsx` rewritten under a story specifying neither** — `size-20` (80px) to `size-24` (96px) violates Story 2.1 AC-1 ("all digit buttons are 80x80px"); `Clear` became `Clr`, `Submit` became `Sign in`, and the in-code AC citations that made those constraints traceable were stripped. `src/lib/design.ts` and `src/lib/format.ts` appear in no story at all. Mitigating: a grep for every removed token found zero stale references, so nothing renders unstyled. Decide whether to retro-spec this work or revert it. **RESOLVED 2026-09-06 — retro-spec.** Supersedes Story 2.1 AC-1 (80px keys → 96px). Retro-spec must also re-establish the AC citations stripped from the code, since those were the traceability link.
- [x] [Review][Decision] **`tables.status` is never reconciled with the session join — the one live break in the 3.3 handoff** — `/api/tables` selects `status: tables.status` and separately left-joins `order_sessions`, without deriving one from the other. If Story 3.3 opens a session without also updating `tables.status`, the socket patch sets `occupied` and the next refetch reverts the card to `open`, discarding elapsed time and item count. Deriving status from `sessionId !== null` in the handler makes this structurally impossible. Decide the contract now, before 3.3 is written. **RESOLVED 2026-09-06 — derive status from the join.** `/api/tables` computes `occupied` from `sessionId !== null` so the divergence is structurally impossible and Story 3.3 cannot get it wrong. Raised as a patch below.

#### Patch

- [ ] [Review][Patch] **ACTION — write the design-system retro-spec** (from Decision 1, resolved 2026-09-06) — Capture the unspecified design pass as a story: the `globals.css` token replacement, `src/lib/design.ts`, `src/lib/format.ts`, and the restyling of `TableCard`, `ZoneChipBar`, `ContextHeader`, `pin-pad` and `login`. Amend Story 3.1 AC-3/AC-4/AC-10 and Story 2.1 AC-1 to record that they are intentionally superseded, and update the Story 3.1 `ZoneChipBar` contract. Also amend `architecture.md:266`, which currently describes a `[data-context]` cascade that no longer has any consumers.
- [ ] [Review][Patch] **Owner-context density has no delivery mechanism** [`table-card.tsx`, `globals.css:20-22`] (carve-out from Decision 1) — Accepting the redesign does not resolve this: `TableCard`'s fixed `h-30` replaced `waiter:min-h-20`, and no consumer of the `waiter`/`owner`/`kitchen` variants remains anywhere in `src/`. Epic 9 (owner dashboard) needs a denser card than the waiter tablet. Either restore variant-driven sizing, or specify and implement the replacement mechanism before Epic 9 starts — do not leave this to be discovered there.
- [x] [Review][Patch] **Wire the staff button to sign-out** [`table-grid.tsx`, `context-header.tsx`, `logout-button.tsx`] (from Decisions 3 and 4, resolved 2026-09-06) — Pass `onStaffTap` from `TableGrid` so the header control calls `POST /api/auth/logout`, restoring sign-out and killing the dead button in one change. Reuse the logic already in `LogoutButton` rather than duplicating the fetch; if the component ends up unused afterwards, delete it rather than leaving it orphaned. Re-point this handler to the PIN-switch flow when Story 2.4 lands. Also disconnect the shared socket on sign-out — it currently outlives the session it was opened under.
- [x] [Review][Patch] **Derive table status from the session join** [`api/tables/route.ts`] (from Decision 8, resolved 2026-09-06) — Compute `occupied` as `sessionId !== null` instead of reading `tables.status` directly, keeping the column only for the `unavailable` case. This makes the cache-patch/refetch divergence structurally impossible and means Story 3.3 cannot get it wrong regardless of whether it updates the column. Record the resulting contract in Story 3.3's Dev Notes when it is created.
- [x] [Review][Patch] **CRITICAL — every `text-fs-*` sharing a `cn()` call with a text colour is silently deleted** [`src/lib/utils.ts` plus call sites in `table-card.tsx`, `zone-chip-bar.tsx`, `context-header.tsx`, `pin-pad.tsx`] — `tailwind-merge` cannot distinguish the custom `text-fs-*` font-size tokens from `text-<color>` utilities, so they share a conflict group and the colour wins. Verified by running the project's own `twMerge`: `text-fs-16`, `text-fs-12`, `text-fs-14`, `text-fs-24` all DROPPED. The utilities compile fine — this is purely the merge. Elapsed time, item counts, status words, zone counts, breadcrumb, staff button and PIN digits all fall back to inherited 1rem, discarding the entire type scale on the surfaces designed for ten-metre legibility. Fix: `extendTailwindMerge` with `text-fs-*` registered as a `font-size` class group.
- [x] [Review][Patch] **`shadow-el-2` is deleted by `shadow-inset-top`** [`pin-pad.tsx:238`, `zone-chip-bar.tsx:45`] — Both utilities write `--tw-shadow`; verified `twMerge` drops `shadow-el-2`, and even without `cn()` the later compiled rule wins. The Sign in button and active zone chip render with no elevation, only the 1px inset — the exact flat-in-sunlight outcome the comment at `globals.css:136` says the inset exists to prevent. Fix: move the inset to the `--inset-shadow-*` namespace, or fold both layers into a single token.
- [x] [Review][Patch] **White text on the `open` and `occupied` bands fails WCAG AA** [`table-card.tsx:66-73`] — White on `#22C55E` is about 2.28:1, on `#F59E0B` about 2.15:1. The band carries the table label at 18px bold (below the 18.66px large-text threshold) and the status word at 12px; both need 4.5:1. `STATUS_TONES` in `design.ts` already defines passing `ink` values (`#0F5F2F`, `#7C4A03`) — used on the body tint but never on the band. Affects every card on the default grid.
- [x] [Review][Patch] **A socket event arriving before the first fetch resolves is dropped, then overwritten** [`table-grid.tsx:100-122`] — The updater returns `current` unchanged when the cache is empty, with no invalidation and no replay. The listener registers on mount, before `fetchTables` resolves, so the window is real. Genuine lost update: device 2 discards the event, then commits the pre-change response and shows the table as Open until reload. The `index === -1` branch invalidates; the `!current` branch must too.
- [x] [Review][Patch] **No resync on socket reconnect — events missed during a drop are lost permanently** [`use-socket.ts:63-72`, `providers.tsx:16-25`] — `connect`/`disconnect` are subscribed only to drive the unused status snapshot. `staleTime: 30_000` marks data stale but never schedules a fetch; `refetchOnWindowFocus` is off; there is no `refetchInterval`; `refetchOnReconnect` fires on the browser `online` event, not socket recovery. The comment in `events.ts:36-37` ("The client refetches on its own staleTime as a fallback") is factually wrong. A server restart or a 20-second Wi-Fi roam leaves the grid silently wrong for the rest of the session.
- [x] [Review][Patch] **A failed background refetch wipes a populated grid** [`table-grid.tsx:180-186`] — `isPending ? ... : isError ? ...` checks `isError` before considering `data`. In TanStack Query v5 `status` becomes `'error'` even when `data` is still populated. With `retry: 1`, an invalidation firing just after the 5-minute session timeout returns 401 and replaces the whole floor plan with one red sentence mid-service.
- [x] [Review][Patch] **Item-count query scans all of `order_events` on every grid load** [`api/tables/route.ts:72-82`] — No `inArray(sessionId, openSessionIds)`, no tenant bound, no date bound; the restriction happens in JS afterward via `openSessionIds.includes()`, O(n*m) on an array. `order_events` is the append-only audit table and only ever grows. AC-7's 33-77ms was measured with zero open sessions, so this branch never ran during verification.
- [x] [Review][Patch] **`/api/tables` ignores `zones.is_active`** [`api/tables/route.ts:56-63`] — No `eq(zones.isActive, true)`. Deactivating a zone for the monsoon leaves its tables in the grid and its chip in the filter, seatable as normal.
- [x] [Review][Patch] **`display_order` ties give nondeterministic ordering and interleave zones** [`api/tables/route.ts:63`] — Both columns default to `0` and only the seed assigns distinct values. PostgreSQL guarantees no order for ties, so the grid reshuffles between refetches and two zones sharing a `display_order` have their tables intermixed. Add a stable tiebreaker (id or label).
- [x] [Review][Patch] **Unavailable cards are inert to the mouse but operable to assistive tech** [`table-card.tsx`, `table-grid.tsx:200-207`] — The guard lives in the caller (`if (status === 'unavailable') return`), but the card still renders an enabled `<button aria-pressed>` with `active:scale-[0.97]` press feedback. A screen-reader user is told it is operable; a sighted user gets a press animation with no result. Any future consumer that forgets the caller-side guard loses AC-6 silently. Add `disabled`/`aria-disabled` on that branch.
- [x] [Review][Patch] **"No tables anywhere" renders as "No tables in this zone. Pick another zone above."** [`table-grid.tsx:187-190`] — The two states are collapsed into one message instructing an impossible recovery: when there are no tables at all, `zones` is `[]` and there is no other zone to pick. Reachable on a deployment where migrations ran but the seed did not.
- [x] [Review][Patch] **Seed is not transactional — a mid-run failure bricks reseeding** [`seed.ts:93-148`] — The idempotency guard checks only `tenants`, but tenant, config, staff, zones and tables are separate unwrapped statements with no `db.transaction(...)`. A failure after the tenant insert leaves zero zones and zero tables, and re-running prints "A tenant already exists — nothing to do" and exits. The only recovery offered is dropping the database.
- [x] [Review][Patch] **Malformed `openedAt` renders "NaNh NaNm"** [`table-grid.tsx:58-62`, `lib/format.ts:33-39`] — `Math.max(0, NaN)` is `NaN`, so the clock-skew guard does not catch it and the hours branch is taken. The `/api/tables` path is safe, but the socket payload's `openedAt` is neither validated nor parsed on receipt — `zod` is installed but unused in every new file.
- [x] [Review][Patch] **401 and 503 both render "Cannot reach the restaurant server"** [`table-grid.tsx:64-72`] — `if (!response.ok) throw` fires before the body is read, discarding the four structured error codes the API and proxy deliberately define (`NOT_PROVISIONED`, `INTERNAL_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`). On the 5-minute idle timeout the waiter is told to check the network instead of being sent to `/login`.
- [x] [Review][Patch] **Back chevron appears with no breadcrumb above it** [`context-header.tsx:80-83`, `table-grid.tsx:163-166`] — `backTarget = tableLabel ? 'zone' : zoneName ? 'zones' : null` but the breadcrumb renders only when `zoneName` is set. Selecting a table while "All zones" is active shows a Back control with nothing explaining where it leads. Two derivations of the same navigational state use different conditions.
- [x] [Review][Patch] **`useSocketStatus` is dead code** [`use-socket.ts`] — Zero call sites. The degraded-state indicator its doc comment describes does not exist, so a waiter gets no signal when real-time is down — which compounds the two staleness findings above. Wire it or remove it.
- [x] [Review][Patch] **Task 6's documented payload is missing `itemCount`** [`server/socket/events.ts`] — Task 6 specifies `{ tableId, status, sessionId, openedAt }`; both the emitter and `TableStatusChangedPayload` require a fifth field. Compile-safe via the exported type, but a 3.3 implementer working from the task text hits a type error. Doc drift — correct the spec.
- [x] [Review][Patch] **`--env-file-if-exists` raises the Node floor with no `engines` declaration** [`package.json`] — The flag landed in Node 20.12 / 21.7. On an older CI image or Docker base pinned below 20.12, `dev`, `start` and `db:seed` all abort with `bad option` and no explanation. No `engines` field exists.
- [x] [Review][Patch] **Selecting a card replaces its status word with "Selected"** [`table-card.tsx:60-70`] — Contradicts the same file's stated rule: "The word, always. Hue is accompanied by the label; the label is not optional." On a selected occupied card the status is carried by nothing visual, while `aria-label` still says "occupied" — visual and accessible names diverge.

#### Deferred

- [x] [Review][Defer] **Socket.io connections are unauthenticated** [`server.ts:37-50`, `server/socket/events.ts:33`] — deferred, pre-existing. No `io.use()` handshake middleware; `cors: { origin: false }` does not stop a direct socket client, and the proxy cannot cover it because Socket.io claims `/socket.io/*` on the same `httpServer` before Next's handler runs. Any LAN device can subscribe to live occupancy, session ids and item counts without a PIN. **Already logged in `deferred-work.md` from Story 1.1, deferred to Epic 2 — Epic 2 has now shipped without it. The deferral target has elapsed and this needs an owner.**
- [x] [Review][Defer] **`itemCount` counts event rows, not quantities** [`api/tables/route.ts:73`] — deferred, pre-existing. `orderEvents.quantity` exists and is never summed, so one `ITEM_ADDED` with `quantity: 3` renders "1 item". Belongs with Epic 4, which defines add/remove semantics; the story already notes the related `ITEM_REMOVED` simplification.
- [x] [Review][Defer] **Response body is cast, not parsed** [`table-grid.tsx:78-86`] — deferred, pre-existing. `body` is implicitly `any` and `data` is asserted to `TableGridRow[]`, so a 200 with a different shape renders `undefined` labels. Cross-cutting: no socket or fetch boundary in the project uses `zod` yet.
- [x] [Review][Defer] **A zone with zero tables never appears in the filter** [`table-grid.tsx:127-136`] — deferred, pre-existing. Zones are folded out of the table rows and the endpoint inner-joins from `tables`, so there is no second source. Latent only: every seeded zone has tables. Becomes live when Story 10.3 adds zone CRUD.
- [x] [Review][Defer] **Tenant selection is unpinned and differs between page and API** [`page.tsx:24-27`, `api/tables/route.ts:30`] — deferred, pre-existing. Two independent unordered `limit(1)` picks; the single-tenant assumption (NFR-SC1) is a comment, not a schema constraint. Only reachable if a second `tenants` row is ever created.
- [x] [Review][Defer] **`handlerRef` assigned in a passive effect** [`use-socket.ts:52-56`] — deferred, pre-existing. A socket event landing between commit and effect flush invokes the previous render's handler. Currently harmless (the handler closes only over the stable `queryClient`), but load-bearing for the Epic 4/5 subscribers that will close over props.
- [x] [Review][Defer] **PIN pad may overflow at 375px** [`login/page.tsx`, `pin-pad.tsx`] — deferred, pre-existing. Fixed-width keys total 312px against roughly 231px available inside the card's padding at that viewport, against a comment claiming the pad "must survive a narrow viewport". Not observed in a browser — needs verification before it is treated as real.
- [x] [Review][Defer] **Unused `eslint-disable` directive** [`src/server/socket/index.ts:5`] — deferred, pre-existing. The only lint warning in the project; the file is untouched by this change.

#### Dismissed as noise (6)

Verified false: `openedAt.toISOString()` timezone risk (schema is `withTimezone: true`, Date mode — correct); `cn()` colour/background conflicts (`twMerge` resolves these properly — the font-size case above is the real one, and it fails the opposite way); duplicate seed runs (guard exists at `seed.ts:93`); Route Handler build-time caching (this is Next 16, where handlers are uncached by default); `ContextHeader` compile error (`onStaffTap` is optional, `tsc` clean); AC-5 navigation missing (Task 7 explicitly defers session creation to Story 3.3).

## Dev Notes

### What exists — reuse, do not rebuild

| Asset | Location | Status |
|---|---|---|
| `TableCard`, `ZoneChipBar`, `ContextHeader` | `src/components/pos/` | **Complete and reviewed (3.1) — do not edit** |
| `getIO()` | `src/server/socket/index.ts` | Server-side Socket.io accessor |
| Socket.io server | `server.ts` | Attached to port 3000 already |
| `db` singleton | `src/server/db/index.ts` | Lazy `Proxy`; safe to import anywhere server-side |
| Proxy + RBAC | `src/proxy.ts` | Every route is already authenticated |
| `cn()`, design tokens, `no-scrollbar` | `src/lib/utils.ts`, `globals.css` | — |

### Component contracts from Story 3.1 — match these exactly

```tsx
<TableCard
  label={string} zoneName={string}
  status={'open' | 'occupied' | 'unavailable'}   // matches tableStatusEnum
  elapsedMinutes={number | undefined}
  itemCount={number | undefined}
  selected={boolean} onSelect={() => void}
/>

<ZoneChipBar zones={{id,name}[]} activeZoneId={string|null} onZoneChange={(id|null) => void} />

<ContextHeader restaurantName staffName zoneName? tableLabel?
  onNavigate={(level: 'zones'|'zone') => void} onStaffTap? />
```

### Schema you are querying

```ts
zones         = { id, tenantId, name, displayOrder, isActive }
tables        = { id, tenantId, zoneId, label, status, capacity, displayOrder }
orderSessions = { id, tenantId, tableId, openedByStaffId, closedByStaffId,
                  openedAt, closedAt, coverCount }
orderEvents   = { id, sessionId, staffId, menuItemId, eventType, seatSlot,
                  quantity, unitPricePaysa, notes, createdAt }
```

**`order_sessions` has no `status` column.** Open means `closed_at IS NULL`. This was corrected in epics.md on 2026-08-21 — earlier drafts referenced `status: "active"`, which does not exist. The partial unique index `idx_order_sessions_one_open_per_table` keys on `table_id WHERE closed_at IS NULL`, which is also what guarantees your join returns at most one session per table.

### Socket.io event names — architecture is authoritative

```
'order:submitted'  'table:opened'  'table:closed'  'ticket:printed'
'printer:alert'    'inventory:depleted'   'table:status_changed'
client → server:   'table:subscribe'  'kitchen:subscribe'
```

Rooms: `table:{tableId}`, `zone:{zoneId}`, `kitchen`, `bar`, `owner`.

For this story a global broadcast is acceptable — every device wants table status. Room-scoped emits matter from Epic 4 onward.

### Where identity comes from

The proxy sets `x-staff-id` and `x-staff-role` on every authenticated request. Read them with `headers()` in a Server Component, or `request.headers` in a Route Handler. **Never** re-read the session cookie — Story 2.3's AC-7 requires attribution to come from the header and nothing else.

`ContextHeader` needs `staffName`, which the header does not carry — only the id. Fetch the name in the Server Component (`src/app/page.tsx` already does this for the placeholder) and pass it down.

### Performance

- AC-1: under 1s load. AC-7: under 300ms for the endpoint. One joined query, indexed on `tenant_id` and `zone_id`.
- AC-2 forbids a network request on zone change — filter in memory.
- AC-4 forbids a full refetch on socket events — patch the cache.
- `refetchOnWindowFocus: false`. A tablet in a restaurant regains focus constantly.

### Previous story intelligence

**Story 3.1 (components):**
- Card sizing is `min-h-*`/`min-w-*`, not fixed `size-*` — cards must be free to grow with content.
- Verify Tailwind utilities in the compiled stylesheet; do not assume they emitted.
- `useSyncExternalStore` is the established pattern for ticking values. `useEffect` + `setState` trips lint.
- `data-context` drives card size and is confirmed working: Nina → `waiter`, Aruna → `owner`.

**Story 2.3 (proxy):**
- Every route is authenticated by default; `/api/tables` needs no auth code.
- `session.service.ts` deliberately omits `server-only` because `proxy.ts` imports it. Do not add it.
- **PostgreSQL is the clock authority.** The container clock ran 120s ahead of the host during 2.3. `openedAt` comes from the database, but elapsed time will be computed against the *browser* clock — a skew here shows as a wrong minute count. If elapsed time looks wrong, suspect clock skew before suspecting the query.

**Story 2.2 (seed):**
- `seed.ts` owns its own `pg` Pool and does not import `@/server/db` — that module is `server-only` and throws outside Next's module graph. Keep that structure when extending it.
- `dotenv` is deliberately absent. Pass `DATABASE_URL` explicitly.

### Testing

No test framework, and **do not add one**.

Verify with:
1. `npx tsc --noEmit` → 0
2. `npx eslint` → 0 errors (one pre-existing warning in `src/server/socket/index.ts` expected)
3. `env -u DATABASE_URL npx next build` → succeeds
4. Reseed, then confirm in psql: 4 zones, tables across all three statuses
5. `curl /api/tables` with a valid cookie → correct shape, and **time it** against AC-7's 300ms
6. Live in a browser, signed in as Nina:
   - Grid renders every table with correct colours and labels
   - Zone chips filter instantly — **check the Network tab shows no request** (AC-2)
   - `unavailable` card cannot be tapped
   - Elapsed time advances without a refetch
7. **Two browser windows side by side.** Change a table's status directly in psql, emit the event, and confirm the other window updates within 2s **and** that the Network tab shows no full list refetch (AC-3, AC-4)
8. Confirm exactly one socket connection per tab in the Network tab's WS view (AC-10)

Record real output in the Debug Log.

### Project Structure

```
NEW:    src/app/api/tables/route.ts
NEW:    src/app/providers.tsx
NEW:    src/hooks/use-socket.ts
NEW:    src/server/services/table.service.ts     (optional — extract the query if the handler grows)
UPDATE: src/app/page.tsx                         (placeholder → real grid)
UPDATE: src/app/layout.tsx                       (mount the provider)
UPDATE: src/server/db/seed.ts                    (zones + tables)
UPDATE: package.json                             (@tanstack/react-query)
DELETE: src/app/nav-demo/page.tsx                (Story 3.1 scaffold)
```

No schema changes, no migrations — every table needed already exists.

### References

- [Source: epics.md#Story-3.2] — ACs; event name and table status corrected 2026-08-21
- [Source: architecture.md:372-386#Socket.io-events] — authoritative event names and rooms
- [Source: architecture.md:252-270#Frontend-Architecture] — TanStack Query for server state, Socket.io invalidation
- [Source: architecture.md:829-857#Core-Data-Flow] — emit co-located with the DB write
- [Source: src/server/db/schema.ts] — zones, tables, order_sessions, order_events
- [Source: 3-1-build-navigation-components.md] — component props and verified behaviour
- [Source: 2-3-implement-session-middleware-and-role-based-access-control.md] — header identity, clock authority
- [TanStack Query releases](https://github.com/tanstack/query/releases) · [npm @tanstack/react-query](https://www.npmjs.com/package/@tanstack/react-query)

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

```
pnpm add @tanstack/react-query  → 5.102.8
npx tsc --noEmit                → exit 0
npx eslint                      → 0 errors (1 pre-existing warning, src/server/socket/index.ts:5)
next build (no DATABASE_URL)    → SUCCESS
    Routes: / , /_not-found , /api/auth/login , /api/auth/logout ,
            /api/health , /api/tables , /login       ƒ Proxy (Middleware)
    /nav-demo correctly absent (Task 9)

AC-9 — reseed after TRUNCATE:
  "[seed] Created tenant "Carpe Diem" with config, 3 staff, 4 zones and 13 tables."
  psql:
     zone    | tables | open | unavailable
    Bean Bags|      3 |    3 |           0
    Sun Beds |      3 |    2 |           1
    Tables   |      4 |    4 |           0
    Rooftop  |      3 |    2 |           1

AC-7 — GET /api/tables (authenticated as Nina):
  success: true | rows: 13
  keys: id,label,status,zoneId,zoneName,capacity,sessionId,openedAt,itemCount
  sample: {"id":"b88ff58c-…","label":"B1","status":"open","zoneId":"36cc4856-…",
           "zoneName":"Bean Bags","capacity":2,"sessionId":null,
           "openedAt":null,"itemCount":0}
  statuses present: open, unavailable
  zones present: Bean Bags | Sun Beds | Tables | Rooftop

AC-7 — response time, 5 runs (threshold 300ms):
  0.077s  0.038s  0.038s  0.044s  0.033s      ⇒ well inside budget

AC-1 — SSR output of /:
  "Carpe Diem" (from tenant_config), "Signed in as Nina" (from x-staff-id lookup),
  "All Zones" chip, and "Loading tables…"
  ⇒ cards are client-rendered after hydration; see Completion Notes

AC-10 — Socket.io:
  GET /socket.io/?EIO=4&transport=polling  → HTTP 200
  Node socket.io-client over websocket:
    "CONNECTED id= 1usDw5y26_zdZDFcAAAC"
    listener registered on table:status_changed
    "no event (nothing emits yet — expected)"
```

### Completion Notes List

**Three React-rule violations were caught by ESLint and fixed properly rather than suppressed.**

1. **`Date.now()` called during render.** `elapsedMinutes()` read the clock inside the component body, which `react-hooks/purity` flags — an unrelated re-render would produce a different elapsed value, and React makes no promise about when renders happen. Moved the clock read into the `useSyncExternalStore` snapshot, which returns "now" truncated to the minute, and made the derivation a pure function of that value. Truncating also keeps the snapshot referentially stable between ticks, which the store requires to avoid an infinite render loop.

2. **Ref mutated during render.** `handlerRef.current = handler` ran in the component body (`react-hooks/refs`). Moved into its own effect.

3. **`setState` seeded from an effect** in `useSocketStatus` — the same rule Stories 2.1 and 3.1 hit. Rewritten with `useSyncExternalStore`, which is correct here anyway: a socket *is* an external store. That is now the third place this pattern has been the right answer; worth treating as the house style.

**`setQueryData`, not `invalidateQueries`.** AC-4 forbids refetching the list on a socket event. The reflex is `invalidateQueries`, which triggers a full `GET /api/tables`. The handler patches the single affected row in place, and falls back to one invalidation only when the event names a table the client has never seen (added by another device).

**The grid is client-rendered.** SSR emits "Loading tables…" and cards appear after hydration plus one fetch. That follows from `useQuery`, which AC-4 effectively requires. The fetch measured 33–77ms so AC-1's 1-second budget is met comfortably, but there is a brief loading flash on first paint. A server-side prefetch with hydration would remove it; not done here because it adds real complexity for a sub-100ms gap.

**Item count is a deliberate simplification.** It counts `ITEM_ADDED` rows and ignores `ITEM_REMOVED`, because removal does not exist until Epic 4. Marked in the code with a pointer to Story 4.4.

**Nothing is seeded as `occupied`.** Occupancy is derived from an `order_sessions` row with `closed_at IS NULL`; a table flagged occupied with no session would be data the grid query cannot explain. Real occupancy arrives in Story 3.3.

**Socket connection is one per tab**, a lazily-created module singleton. Component unmount removes only that component's listener and deliberately leaves the shared socket connected — Epics 4 and 5 will add more subscribers, and disconnecting on every unmount would thrash the connection during normal navigation.

**NOT verified — the significant gap:**

- **AC-3 and AC-4 could not be tested end to end, because nothing emits `table:status_changed` yet.** Story 3.3 is the producer — it creates and closes sessions. Both ends are built and wired: `emitTableStatusChanged()` exists with the correct snake_case name, the client listener is registered, and a real socket.io-client connected over websocket and sat listening. But no event has ever travelled the path. **The first genuine test of real-time is Story 3.3.**
- **No browser was used.** Everything above is curl, psql, a Node socket client, and build output. Card rendering, zone filtering, the no-network-request claim in AC-2, and the elapsed-time tick were all verified structurally, not observed.
- AC-5's navigation is selection-only. Tapping an open card selects it and updates the breadcrumb; it does **not** call `POST /api/tables/:id/sessions`, which is Story 3.3's AC.
- AC-8's live tick was not watched over a real minute boundary.

**Environment note carried forward:** the Docker container clock ran 120s ahead of the host in Story 2.3. `openedAt` comes from PostgreSQL but elapsed time is computed against the browser clock, so a skewed host will show a wrong minute count. If elapsed time looks wrong once Story 3.3 creates real sessions, suspect clock skew before suspecting the query.

**No test framework exists**, so none of this is captured as an automated test.

### File List

- NEW: `src/app/api/tables/route.ts` (grid data endpoint, single joined query)
- NEW: `src/app/providers.tsx` (QueryClientProvider, per-request client)
- NEW: `src/hooks/use-socket.ts` (shared socket, event subscription, connection status)
- NEW: `src/server/socket/events.ts` (typed `table:status_changed` emitter)
- NEW: `src/components/pos/table-grid.tsx` (the grid screen)
- UPDATE: `src/app/page.tsx` (placeholder → real grid, restaurant name and staff name from DB)
- UPDATE: `src/app/layout.tsx` (mount Providers; stays a Server Component)
- UPDATE: `src/server/db/seed.ts` (4 zones, 13 tables, 2 unavailable)
- UPDATE: `package.json` (@tanstack/react-query 5.102.8)
- DELETE: `src/app/nav-demo/page.tsx` (Story 3.1 scaffold, superseded)

**Code review 2026-09-06 — additional changes:**

- UPDATE: `src/lib/utils.ts` (extendTailwindMerge — custom `text-fs-*`, `shadow-el-*`, `inset-shadow-top` class groups)
- UPDATE: `src/app/globals.css` (`--inset-shadow-top` own namespace; `--color-*-band` WCAG-passing band fills)
- UPDATE: `src/lib/design.ts` (STATUS_TONES bands point at the new `--*-band` tokens)
- UPDATE: `src/components/pos/table-card.tsx` (inert unavailable card, status word always shown, brand-700 selected band)
- UPDATE: `src/components/pos/context-header.tsx` (Back and breadcrumb share one derivation)
- UPDATE: `src/components/pos/table-grid.tsx` (lost-update guard, reconnect resync, degraded banner, session-expiry redirect, empty-state split, NaN guard, sign-out)
- UPDATE: `src/components/pos/pin-pad.tsx`, `zone-chip-bar.tsx` (`shadow-inset-top` → `inset-shadow-top`)
- UPDATE: `src/hooks/use-socket.ts` (`disconnectSocket()` for sign-out)
- UPDATE: `src/app/api/tables/route.ts` (status derived from the session join, bounded item-count query, `zones.isActive`, stable ordering)
- UPDATE: `src/server/db/seed.ts` (single transaction)
- UPDATE: `src/server/socket/events.ts` (corrected the inaccurate staleTime-fallback comment)
- UPDATE: `package.json` (`engines.node >= 20.12.0`)
- DELETE: `src/components/pos/logout-button.tsx` (orphaned; sign-out now lives on the header staff control)

### Change Log

- 2026-08-21: Story implemented. Real table grid replaces the placeholder home page — GET /api/tables (single joined query, 33-77ms), TanStack Query with per-request client, client-side zone filtering, shared Socket.io connection, and targeted cache patching via setQueryData. Seed extended to 4 zones and 13 tables. Three React-rule violations caught by lint and fixed at the root (impure Date.now during render, ref mutation during render, setState seeded from an effect). Story 3.1 scaffold deleted.
- 2026-08-21: Story created. Two defects corrected in epics.md beforehand: the Socket.io event was written `table:statusChanged` in 7 places while `architecture.md:381` specifies `table:status_changed` — a camelCase listener would never fire and real-time would silently do nothing; and AC-6 referenced a table status of `"closed"`, which does not exist in `tableStatusEnum`. Three blockers surfaced and scoped into tasks: TanStack Query is not installed despite being named in the ACs, `seed.ts` creates no zones or tables, and no Socket.io client wiring exists anywhere. Three ACs added beyond the epic — live elapsed-time ticking, seed coverage, and socket connection lifecycle.
