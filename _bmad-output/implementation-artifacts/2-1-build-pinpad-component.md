# Story 2.1: Build PINPad Component

Status: review

> ⚠️ **SUPERSEDED IN PART — 2026-09-06.** PIN length was fixed at 4 digits (PRD FR38, amended). The PIN pad now auto-submits on the fourth digit; the Submit button, the `SHORT_PIN_ERROR` path and the 4–6 digit range described below no longer exist, and the login schema is `/^\d{4}$/`. Digit keys are 96×96px, not 80×80px. This file is a point-in-time record and is deliberately NOT rewritten — read `epics.md` Story 2.1 for the current acceptance criteria, and Story 3.3's Review Findings for why the change was made.

- **Epic:** 2 — Staff Authentication & Session Management
- **Story ID:** 2.1
- **Story Key:** 2-1-build-pinpad-component
- **Created:** 2026-08-21

---

## ⚠️ READ FIRST — epics.md and the UX spec disagree

Both documents specify this component and they contradict each other. The acceptance criteria below **merge** them. Resolutions are recorded so you do not have to re-derive them.

| Aspect | epics.md says | UX spec says | **Resolution** |
|---|---|---|---|
| Destructive key | **Clear** (wipes all digits) | **Backspace** (removes one) | **Both.** Clear satisfies the epics AC; backspace is strictly better under pressure and the UX spec asks for it. Grid has room. |
| Submit | Explicit **Submit** tap | **Auto-submits on 6th digit** | **Both.** PINs are 4–6 digits, so 4- and 5-digit PINs *require* a Submit button. Auto-submit fires only at exactly 6. |
| Key size | **80×80px** | "minimum 72×72px" | **80×80px** — satisfies both, and epics is the testable number. |
| Error copy | "PIN must be at least 4 digits" | shake + "Incorrect PIN" | **Two distinct states.** The first is local validation (this story). The second is server rejection — this story exposes an `error` prop to render it, but performs no authentication. |

**Scope boundary:** this story builds a **presentational component only**. No API call, no session, no database. Authentication is Story 2.2. If you find yourself importing `@/server/db`, stop — wrong story.

---

## Story

As a staff member,
I want a touch-friendly PIN entry pad that accepts my 4–6 digit PIN without invoking the device keyboard,
So that I can authenticate quickly on any tablet or touchscreen without the software keyboard obscuring the screen.

---

## Acceptance Criteria

**AC-1: Layout**
**Given** the PINPad component is rendered
**When** a staff member views it
**Then** it displays a digit grid (1–9, then 0) plus Clear and Submit controls; a PIN dot progress indicator showing filled/empty dots per entered digit; all digit buttons are 80×80px

**AC-2: Digit entry, no keyboard**
**Given** a staff member taps a digit button
**When** the tap is registered
**Then** the digit is appended to the internal PIN state; the corresponding dot fills; the device virtual keyboard does **NOT** appear at any point

**AC-3: Screen reader labels**
**Given** the PINPad component is rendered
**When** a screen reader focuses on any digit button
**Then** `aria-label` reads "Enter digit N" where N is the digit value (0–9)

**AC-4: Live progress announcement**
**Given** the PIN dot progress indicator
**When** the PIN state changes (digit added or cleared)
**Then** `aria-live="polite"` announces the current PIN length (e.g., "3 digits entered")

**AC-5: Clear**
**Given** a staff member has entered one or more digits
**When** they tap Clear
**Then** all entered digits are removed and all dots return to empty state

**AC-6: Submit and immediate wipe**
**Given** a staff member has entered their full PIN (4–6 digits)
**When** they tap Submit
**Then** the component calls the provided `onSubmit` callback with the entered PIN string; the PIN value is cleared from component state immediately after the callback is invoked

**AC-7: Reject short PIN**
**Given** a staff member taps Submit with fewer than 4 digits entered
**When** the submission is attempted
**Then** submission is rejected; an inline error "PIN must be at least 4 digits" is shown; `onSubmit` is **not** called

**AC-8: Auto-submit at six digits**
**Given** a staff member has entered exactly 6 digits
**When** the 6th digit is registered
**Then** `onSubmit` fires automatically without a Submit tap; state is wiped as in AC-6; no further digits can be entered

**AC-9: Backspace**
**Given** a staff member has entered one or more digits
**When** they tap Backspace
**Then** exactly one digit is removed from the end and the corresponding dot empties

**AC-10: Masked input**
**Given** any number of digits entered
**When** the component renders
**Then** only dots are shown — the entered digits are **never** rendered as text anywhere in the DOM

**AC-11: Error state from parent**
**Given** the parent passes a truthy `error` prop
**When** the component renders
**Then** the error message displays and a shake animation plays; the animation is suppressed when `prefers-reduced-motion: reduce` is set; no attempt count is ever displayed

**AC-12: Disabled state**
**Given** the parent passes `disabled` (e.g. while an auth request is in flight)
**When** the component renders
**Then** all buttons are non-interactive and visually indicate the disabled state; no input is accepted

---

## Tasks / Subtasks

- [x] **Task 1 — Create `src/components/pos/pin-pad.tsx`** (AC: 1, 2, 10)
  - `'use client'` — this component is stateful and touch-driven.
  - Props: `onSubmit: (pin: string) => void`, `error?: string | null`, `disabled?: boolean`, `label?: string`.
  - Internal state: `const [pin, setPin] = useState('')`. Nothing else holds the PIN.
  - **Never render a `<input>` element.** Any input, even `readOnly` or `inputMode="none"`, risks summoning the virtual keyboard on some Android builds. Digits are captured exclusively through `<button type="button">` taps.
  - Grid layout, 4 rows × 3 columns:
    ```
    [1] [2] [3]
    [4] [5] [6]
    [7] [8] [9]
    [Clear] [0] [⌫]
    ```
  - Submit renders as a full-width control below the grid.

- [x] **Task 2 — Dot progress indicator** (AC: 1, 4, 10)
  - Render 6 dots. Fill the first `pin.length`; the rest stay empty.
  - Wrap in a container with `aria-live="polite"` and a visually hidden text node reading `` `${pin.length} digits entered` ``.
  - The dots are decorative — mark them `aria-hidden="true"` so the screen reader announces only the count, never a per-dot reading.
  - Digits must not appear in any attribute, `data-*`, `title`, or `value`.

- [x] **Task 3 — Digit, Clear, and Backspace handlers** (AC: 2, 5, 9)
  - Digit: ignore if `pin.length >= 6` or `disabled`.
  - Clear: `setPin('')`.
  - Backspace: `setPin(p => p.slice(0, -1))`.
  - Every state change clears any locally-set validation error.

- [x] **Task 4 — Submit, validation, and wipe** (AC: 6, 7)
  - `pin.length < 4` → set local error "PIN must be at least 4 digits", do **not** call `onSubmit`.
  - Otherwise call `onSubmit(pin)` then `setPin('')` immediately.
  - Capture the value in a local const before wiping so the callback receives it.

- [x] **Task 5 — Auto-submit at six digits** (AC: 8)
  - When a digit brings length to exactly 6, submit on the same interaction.
  - Guard against double submission: auto-submit must not also fire the Submit handler.
  - Prefer handling this inside the digit handler over a `useEffect` on `pin` — an effect re-runs on unrelated re-renders and is easy to fire twice under React Strict Mode.

- [x] **Task 6 — Accessibility** (AC: 3, 4)
  - `aria-label="Enter digit N"` on each of the ten digit buttons.
  - `aria-label` on Clear ("Clear all digits"), Backspace ("Delete last digit"), Submit ("Submit PIN").
  - Buttons are 80×80px. Text large enough to read at arm's length on a tablet.
  - Keyboard navigation is **not** a requirement for waiter context (UX spec: touch-primary), but do not actively break it — native `<button>` gives it for free.

- [x] **Task 7 — Error and disabled states** (AC: 11, 12)
  - Render `error` prop text when present; render local validation error the same way.
  - Shake animation on error, wrapped in `@media (prefers-reduced-motion: no-preference)`.
  - Never display an attempt count or remaining-attempts hint — a bystander must not learn how close they are.
  - `disabled` sets `disabled` on every button plus a reduced-opacity visual state.

- [x] **Task 8 — Demo route for manual verification** (AC: all)
  - There is no test framework in this repo. Add a temporary page at `src/app/pin-demo/page.tsx` that renders `PINPad` and displays the submitted length only (never the PIN) plus a toggle for the `error` and `disabled` props.
  - This is a scaffold for manual verification, not a feature. Note it in Completion Notes for removal once Story 2.2 provides a real login screen.

---

## Dev Notes

### What already exists — do not rebuild

| Asset | Location | Notes |
|---|---|---|
| `cn()` class merger | `src/lib/utils.ts` | clsx + tailwind-merge. Use it for conditional classes. |
| Design tokens | `src/app/globals.css` | Full palette + spacing + type scale. Use these, do not hardcode hex. |
| Context variants | `src/app/globals.css:7-9` | `waiter:`, `owner:`, `kitchen:` Tailwind variants |
| POS component folder | `src/components/pos/` | Currently empty except `.gitkeep`. This story creates the first real file here. |

**shadcn/ui is configured but no components are installed.** `components.json` exists and aliases resolve, but `src/components/ui/` does not exist. Do **not** run `shadcn add` for this story — the PINPad is a bespoke touch component with no shadcn primitive that fits. A plain `<button>` grid is correct here.

### Design tokens available

```
Brand:   --color-brand-50 … --color-brand-900
         brand-600 is 4.6:1 on white (AA); brand-700 is 7.1:1 (AAA, waiter context)
Neutral: --color-neutral-0/50/100/200/400/600/900
Status:  --color-status-open / occupied / alert / info    ← alert (#EF4444) for error text
Spacing: --spacing-space-1 (4px) … --spacing-space-12 (48px)
Type:    --text-display (2rem) … --text-micro (0.75rem)
```

**80px is not a spacing token.** The scale stops at 48px. Use an explicit `size-20` (80px) Tailwind utility rather than inventing a token — Story 1.2's review flagged that token values are currently duplicated between `@layer base :root` and `@theme`, so adding tokens now means editing two places and risking drift.

### Naming conventions (architecture)

- Files: **kebab-case** → `pin-pad.tsx`
- Components: **PascalCase** → `PINPad`
- Types: PascalCase, no prefix/suffix → `PINPadProps`

### Security — this is a credential component

- **Never log the PIN.** No `console.log`, no `console.debug`, not even during development. NFR-S1: plaintext PINs are never persisted, logged, or transmitted beyond the auth call.
- Never write the PIN to `localStorage`, `sessionStorage`, a URL, or a `data-` attribute.
- Wipe state immediately after `onSubmit` (AC-6) so the value does not linger in a component that may stay mounted.
- Render dots only — a shoulder-surfer in a busy restaurant must not read the PIN off the screen (AC-10).
- No attempt count in the UI (AC-11) — it tells a bystander how many guesses remain.

### Previous story intelligence — Story 1.2 (design tokens)

Story 1.2 delivered the token system this component consumes. Its code review left three items that touch you:

- **Token duplication.** Every hex value is declared twice, in `@layer base :root` and in `@theme`. Adding or changing a token means editing both or the values drift. Avoid adding tokens in this story.
- **`--text-*` tokens have no `--{name}--line-height` companions.** Tailwind v4 falls back to `calc(1em + 0.5rem)`. If digit glyphs sit oddly in the 80px buttons, this is why — set line-height explicitly on the button rather than patching the token.
- **Never apply `waiter:` / `owner:` / `kitchen:` variants to the `<html>` element itself.** The variant is `&:is([data-context="waiter"] *)`, which requires the target to be a *descendant* of the attribute holder. `<html>` is not its own descendant.

`layout.tsx` already sets `data-context` from the `x-staff-role` header, so context variants work inside this component today — but that header is not populated until Story 2.3 builds the middleware. Expect `data-context` to be absent while developing this story. Design for the no-context default first.

### UX behavioural spec

From `ux-design-specification.md:1019`: *"Numeric pad · auto-submits on 6th digit · input masked · shake + inline error on failure · attempt count never shown"*.

From `ux-design-specification.md:921-928`: the PINPad is a **full-screen overlay** used for financial actions and user switching, with the label varying by context — "Confirm your PIN" for financial reauth versus staff name + avatar for a user switch. This story builds the pad itself; the overlay shell and contextual labelling arrive with Stories 2.2 and 2.4. Accept a `label` prop now so the shell has somewhere to put that text.

### Testing

No test framework is installed — `package.json` has no test script, and Vitest/Playwright are absent. **Do not install one in this story**; that is unrelated scope and would need its own decision.

Verify with:
1. `npx tsc --noEmit` → exit 0
2. `npx eslint` → 0 errors (one pre-existing warning in `src/server/socket/index.ts` is expected and not yours)
3. `pnpm dev`, open `/pin-demo`, and manually confirm:
   - Tapping digits fills dots; **no on-screen keyboard appears** (test on a touch device or Chrome device emulation)
   - Clear empties everything; Backspace removes exactly one
   - Submit with 3 digits shows the inline error and does not call back
   - Submit with 4 digits calls back and wipes state
   - A 6th digit auto-submits with no extra tap
   - Digits never appear as text — inspect the DOM to confirm
   - Error prop shakes; with reduced motion enabled in OS settings, it does not
   - Disabled blocks all interaction

Record the actual output in the Debug Log. Do not claim a check passed without running it.

### Project Structure

```
NEW: src/components/pos/pin-pad.tsx
NEW: src/app/pin-demo/page.tsx        (temporary scaffold — remove after Story 2.2)
```

No changes to `layout.tsx`, `globals.css`, the database, or any server file. If a change outside these two files seems necessary, that is a signal the scope has drifted.

### References

- [Source: epics.md#Story-2.1] — original ACs (AC-1 through AC-7)
- [Source: ux-design-specification.md:921-928#PINPad] — overlay behaviour, auto-submit, masking, error state
- [Source: ux-design-specification.md:1146-1150#PINPad-accessibility] — 80×80px, aria-label, aria-live
- [Source: ux-design-specification.md:1019#Form-Patterns] — PIN entry pattern
- [Source: architecture.md:323-370#Naming-Patterns] — file and component naming
- [Source: prd.md#NFR-S1] — plaintext PIN never persisted, logged, or transmitted
- [Source: 1-2-configure-design-token-system.md] — token system and its review findings

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

```
npx tsc --noEmit                     → exit 0
npx eslint                           → 0 errors
                                       (1 pre-existing warning, src/server/socket/index.ts:5,
                                        unused eslint-disable — Story 1.1, untouched)
env -u DATABASE_URL npx next build   → SUCCESS
                                       Routes: / , /_not-found , /api/health , /pin-demo

Compiled-CSS verification (.next/static/chunks/0gri_3493ov8l.css):
  .size-20           → width/height: calc(var(--spacing) * 20)
  --spacing          → .25rem   ⇒ 0.25rem × 20 = 5rem = 80px   ✓ AC-1
  .animate-shake     → animation: var(--animate-shake)
  --animate-shake    → shake .4s cubic-bezier(.36,.07,.19,.97) both
  @keyframes shake   → present
  prefers-reduced-motion:reduce → present   ✓ AC-11
  .h-space-12        → var(--spacing-space-12) = 48px
  .gap-space-3       → var(--spacing-space-3)
  .text-status-alert → var(--color-status-alert)
  .text-h1           → var(--text-h1)
  .sr-only           → clip-path inset(50%) …

Security audit (grep over both new files):
  console.* / localStorage / sessionStorage / document.cookie → NONE
  <input> element                                            → NONE (only a comment mentions it)
  `pin` rendered directly                                    → NONE; only `pin.length` (4 uses)
```

### Completion Notes List

**Two real bugs found and fixed during self-review, after the first working version:**

1. **Auto-submit could fire twice.** The first implementation called `queueMicrotask(() => submit(next))` from inside a `setPin` updater. State updaters must be pure — React invokes them twice under Strict Mode, so the microtask would have been scheduled twice and the credential submitted twice. Rewritten to compute `next` from the closure value and call `submit(next)` directly in the event handler. This is the exact failure the story's Task 5 warned about, and the first attempt walked into it anyway.

2. **The shake never replayed on a second failure.** A CSS animation does not restart while its class stays applied, so two consecutive wrong PINs produced one shake. Fixed with an `errorNonce` used as a `key` on the container, forcing a remount per new error.

**Two further issues fixed in the same pass:**

- **Nested live regions.** `role="alert"` (an assertive live region) was nested inside the `aria-live="polite"` container, which causes duplicated or dropped screen-reader announcements. The error paragraph is now a sibling of the polite region, not a child.
- **Stale parent error.** The parent's `error` prop persisted while the staff member typed a fresh PIN. Added an `errorDismissed` flag cleared on any keypress, so the message disappears the moment a new attempt starts.

**ESLint caught a third issue.** The nonce/dismiss reset was initially a `useEffect`, which tripped `react-hooks/set-state-in-effect`. Replaced with React's documented adjust-state-during-render pattern (`if (error !== prevError) { … }`), which also removes a frame of lag between the error arriving and the shake playing.

**Deviation from the story's stated file scope.** The story's Project Structure section said "no changes to `globals.css`". That was wrong — AC-11 requires a shake animation, and a CSS animation needs a `@keyframes` definition plus a Tailwind v4 `--animate-*` theme token. Added `--animate-shake`, `@keyframes shake`, and a `prefers-reduced-motion: reduce` override to `globals.css`. Deliberately additive: no existing token was touched, avoiding the token-duplication drift risk flagged in Story 1.2's review.

**Design decisions worth knowing:**
- Auto-submit at 6 digits AND a Submit button both exist. 4- and 5-digit PINs never reach the auto-submit threshold and would otherwise be unsubmittable.
- Both Clear and Backspace are present, resolving the epics/UX conflict in favour of having both.
- `submit()` wipes state *before* invoking `onSubmit`, so a throwing callback cannot leave the PIN resident in component state.
- Dots are `aria-hidden`; the live region announces a count instead, so a screen reader says "3 digits entered" rather than reading six bullet glyphs.
- The parent's server error outranks local validation when both are present.

**NOT verified — requires a real device:**
- **AC-2's core claim (no virtual keyboard) has not been observed.** It is structurally guaranteed — there is no `<input>` in the component, digits come only from `<button>` taps — but no touch device or Chrome device emulation was used. This is the single most important manual check remaining.
- The shake animation and its reduced-motion suppression were verified in compiled CSS, not visually.
- No screen reader was run. ARIA attributes are present and correct by inspection only.
- Touch ergonomics at arm's length on a real tablet are unassessed.

**No test framework exists in this repo**, so there are no automated tests for this component. Verification was typecheck, lint, production build, compiled-CSS assertions, and static security audit. The `/pin-demo` route is the manual harness — open it with `pnpm dev`.

**Temporary scaffold to remove:** `src/app/pin-demo/page.tsx` exists only for manual verification and must be deleted once Story 2.2 provides a real login screen. It renders the submitted PIN *length* only, never the value.

### File List

- NEW: `src/components/pos/pin-pad.tsx` (PINPad component — first file in the POS component library)
- NEW: `src/app/pin-demo/page.tsx` (temporary manual-verification harness — delete after Story 2.2)
- UPDATE: `src/app/globals.css` (added `--animate-shake` token, `@keyframes shake`, `prefers-reduced-motion` override)

### Change Log

- 2026-08-21: Story implemented. PINPad component built with 12 ACs satisfied structurally; two self-review bugs fixed before completion (double-submit via impure state updater, shake never replaying on repeat failure) plus nested live regions and a stale parent error. globals.css gained a shake animation token — a deviation from the story's stated file scope, since AC-11 cannot be met without a keyframe.
- 2026-08-21: Story created. Acceptance criteria merged from epics.md and the UX specification, which conflicted on the destructive key (Clear vs backspace), submission trigger (explicit tap vs auto-submit at 6), key size (80px vs 72px), and error copy. Five additional ACs added to cover UX-specified behaviour absent from epics: auto-submit, backspace, masking, parent error state, and disabled state.
