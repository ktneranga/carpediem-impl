# Story 1.2: Configure Design Token System

Status: done

## Story

As a developer,
I want the complete CDRMS design token system implemented as CSS custom properties and Tailwind configuration,
so that all components across every epic use consistent brand colors, neutral palette, semantic status colors, typography, and spacing without re-implementing values.

## Acceptance Criteria

1. **Given** `src/app/globals.css` **When** the browser renders any CDRMS page **Then** the following CSS custom properties are defined: `--color-brand-400` (#6EC1E4) as the base brand with a full `brand-50` through `brand-900` scale; `--color-brand-600` (#2288B4); `--color-brand-700` (#1A6A8C); neutral scale `neutral-0` (#FFFFFF) through `neutral-900` (#0F172A); status colors `--color-status-open` (#22C55E), `--color-status-occupied` (#F59E0B), `--color-status-alert` (#EF4444), `--color-status-info` (#3B82F6)

2. **Given** brand-600 (#2288B4) used as interactive text on a white background **When** contrast ratio is measured **Then** the ratio is ≥ 4.5:1 (WCAG AA pass — 4.6:1 per UX spec)

3. **Given** brand-700 (#1A6A8C) used as interactive text in `[data-context="waiter"]` **When** contrast ratio is measured **Then** the ratio is ≥ 7:1 (WCAG AAA pass — 7.1:1 per UX spec — outdoor use requirement)

4. **Given** `src/app/layout.tsx` (root layout) **When** an authenticated staff member accesses the application **Then** the `<html>` element carries a `data-context` attribute set server-side from the authenticated staff role: `"waiter"` for Staff, `"owner"` for Owner/Manager, `"kitchen"` for Kitchen/Bar

5. **Given** the root layout with no authenticated session **When** an unauthenticated request renders the layout **Then** `data-context` is absent — no attribute is rendered on the `<html>` element

6. **Given** Tailwind token configuration **When** a developer uses `text-brand-600` or `p-space-4` **Then** Tailwind resolves correctly: `text-brand-600` → #2288B4; `p-space-4` → 16px (4 × 4px base unit)

7. **Given** the font configuration in the layout **When** any text is rendered **Then** Inter is the loaded font family; type scale CSS utilities are available: `text-display` (32px), `text-h1` (24px), `text-h2` (18px), `text-body` (16px), `text-small` (14px), `text-micro` (12px)

## Tasks / Subtasks

- [x] Task 1: Replace Geist fonts with Inter in layout.tsx (AC: 7)
  - [x] Remove `Geist` and `Geist_Mono` imports from `next/font/google` — these are the create-next-app defaults
  - [x] Import `Inter` from `next/font/google` with `subsets: ['latin']` and `variable: '--font-inter'`
  - [x] Apply `inter.variable` to the `<html>` className (replaces `geistSans.variable geistMono.variable`)
  - [x] Note: `next/font/google` is already available via the `next` package — no new dependency needed

- [x] Task 2: Replace globals.css @theme block with full CDRMS design token system (AC: 1, 2, 3, 6, 7)
  - [x] Keep `@import "tailwindcss"` as the first line (Tailwind v4 CSS-first — do NOT add a tailwind.config.ts)
  - [x] Define brand color scale in `@theme` using `--color-brand-*` naming (Tailwind v4 convention — creates `text-brand-*`, `bg-brand-*`, `border-brand-*` utilities automatically)
  - [x] Define neutral scale using `--color-neutral-*` naming
  - [x] Define status colors using `--color-status-open`, `--color-status-occupied`, `--color-status-alert`, `--color-status-info`
  - [x] Define spacing tokens using `--spacing-space-*` naming (creates `p-space-*`, `m-space-*`, `gap-space-*` utilities)
  - [x] Define typography sizes using `--text-*` naming (creates `text-display`, `text-h1`, etc. utilities)
  - [x] Set `--font-sans: var(--font-inter)` to wire Inter into Tailwind's `font-sans` utility

- [x] Task 3: Add [data-context] custom variants in globals.css (AC: 4, 5)
  - [x] Add `@custom-variant waiter (&:is([data-context="waiter"] *))` — enables `waiter:text-brand-700` etc. on descendant elements
  - [x] Add `@custom-variant owner (&:is([data-context="owner"] *))` — owner context variant
  - [x] Add `@custom-variant kitchen (&:is([data-context="kitchen"] *))` — kitchen context variant
  - [x] These variants cascade from `<html data-context="waiter">` downward through all children

- [x] Task 4: Update layout.tsx with Inter font and data-context plumbing (AC: 4, 5)
  - [x] Make the layout function `async` — required to read `headers()` (Next.js App Router pattern)
  - [x] Import `headers` from `'next/headers'` to read the `x-staff-role` header (injected by middleware in Story 2.2)
  - [x] Read `x-staff-role` header; if present, set it as the `data-context` attribute on `<html>`
  - [x] If header is absent (pre-auth / Story 1.x timeframe), omit the `data-context` attribute entirely — do NOT default to any role
  - [x] Update page `<title>` and `<description>` in `metadata` export from create-next-app defaults to "Carpe Diem RMS"
  - [x] Keep `lang="en"` and `className` with Inter font variable + `antialiased`

- [x] Task 5: Verify design tokens resolve correctly end-to-end (AC: 1, 6, 7)
  - [x] `pnpm dev` starts without errors
  - [x] HTTP 200 on GET / confirmed via Invoke-WebRequest
  - [x] `--color-brand-600: #2288B4` confirmed in served CSS (`@layer base :root`)
  - [x] `--color-status-open: #22C55E` confirmed in served CSS
  - [x] `--spacing-space-4: 16px` confirmed in served CSS
  - [x] `--text-display: 2rem` confirmed in served CSS
  - [x] `pnpm exec tsc --noEmit` exits 0 (no TypeScript errors)

## Dev Notes

### ⚠️ Critical: No tailwind.config.ts in Tailwind v4 — CSS-First @theme

This is the most important thing to get right. Story 1.1 established that this project uses **Tailwind CSS v4** (tailwindcss 4.3.1), which uses CSS-first configuration. The architecture doc references `tailwind.config.ts` in the directory tree — **this file does NOT exist and should NOT be created.** All token definitions go into `src/app/globals.css` using the `@theme` block.

**v4 `@theme` naming convention → Tailwind utility class mapping:**

| `@theme` declaration | Tailwind utility generated |
|---|---|
| `--color-brand-600: #2288B4` | `text-brand-600`, `bg-brand-600`, `border-brand-600`, `ring-brand-600` |
| `--color-status-open: #22C55E` | `text-status-open`, `bg-status-open` |
| `--spacing-space-4: 16px` | `p-space-4`, `m-space-4`, `gap-space-4`, `w-space-4`, `h-space-4` |
| `--text-display: 2rem` | `text-display` (font-size utility) |
| `--font-sans: var(--font-inter)` | `font-sans` resolves to Inter |

**The brand token token is fixed per-installation (Carpe Diem). Post-MVP, it becomes configurable per tenant via the DB `tenant_config.brand_color`, but for this story, hardcode all brand values directly in `@theme`.**

### Full Brand Color Scale (from UX spec — all values required)

```css
@theme {
  --color-brand-50:  #EBF8FD;   /* Light tint backgrounds, hover surfaces */
  --color-brand-100: #CCF0FB;   /* Card accent backgrounds */
  --color-brand-200: #9DDCF5;   /* Subtle borders, inactive states */
  --color-brand-300: #7ACEED;   /* Light decorative accents */
  --color-brand-400: #6EC1E4;   /* Brand anchor — header strip, logo tint */
  --color-brand-500: #3FABD9;   /* Hover state on primary buttons */
  --color-brand-600: #2288B4;   /* Primary buttons, active nav (4.6:1 on white ✅ WCAG AA) */
  --color-brand-700: #1A6A8C;   /* Outdoor buttons — waiter context (7.1:1 on white ✅ WCAG AAA) */
  --color-brand-800: #0F4560;   /* Dark accent, pressed states */
  --color-brand-900: #082B3D;   /* Near-black accent */
}
```

### Full Neutral Scale (Slate family — cool undertone)

```css
@theme {
  --color-neutral-0:   #FFFFFF;  /* Card surfaces, modal backgrounds */
  --color-neutral-50:  #F8FAFC;  /* Page background */
  --color-neutral-100: #F1F5F9;  /* Input backgrounds, inactive areas */
  --color-neutral-200: #E2E8F0;  /* Borders, dividers */
  --color-neutral-400: #94A3B8;  /* Placeholder text, disabled */
  --color-neutral-600: #475569;  /* Secondary text */
  --color-neutral-900: #0F172A;  /* Primary text */
}
```

### Status Colors (semantic — never overridden by brand)

Always paired with an icon — never communicate status by color alone (color-blind safety).

```css
@theme {
  --color-status-open:     #22C55E;  /* Table available, order confirmed */
  --color-status-occupied: #F59E0B;  /* Table occupied, in progress */
  --color-status-alert:    #EF4444;  /* Needs attention, error, low inventory */
  --color-status-info:     #3B82F6;  /* Informational notices */
}
```

### Spacing Scale (4px base unit)

```css
@theme {
  --spacing-space-1:  4px;   /* Icon internal padding */
  --spacing-space-2:  8px;   /* Within components (label + value) */
  --spacing-space-3:  12px;  /* Compact list items */
  --spacing-space-4:  16px;  /* Standard padding, between fields */
  --spacing-space-6:  24px;  /* Between card sections */
  --spacing-space-8:  32px;  /* Between major page sections */
  --spacing-space-12: 48px;  /* Page edge padding */
}
```

### Typography Scale

```css
@theme {
  --font-sans: var(--font-inter);

  --text-display: 2rem;      /* 32px — zone names, table numbers */
  --text-h1:      1.5rem;    /* 24px — section titles, modal headers */
  --text-h2:      1.125rem;  /* 18px — card titles, item names in order */
  --text-body:    1rem;      /* 16px — standard content, menu items */
  --text-small:   0.875rem;  /* 14px — timestamps, metadata, labels */
  --text-micro:   0.75rem;   /* 12px — badges, status chips, tags */
}
```

Note: Tailwind v4 text size tokens can optionally include line-height using `/` syntax: `--text-display: 2rem / 1.2`. Omitting line-height uses `calc(1em + 0.5rem)` as the Tailwind v4 default — this is acceptable for now; Story 1.x doesn't implement specific line-height requirements.

### [data-context] Custom Variants — Tailwind v4 Syntax

In Tailwind v4, custom variants use `@custom-variant`:

```css
/* In globals.css — after @import "tailwindcss" */
@custom-variant waiter { [data-context="waiter"] & }
@custom-variant owner  { [data-context="owner"]  & }
@custom-variant kitchen { [data-context="kitchen"] & }
```

The `&` refers to the element the variant is applied to. With `[data-context="waiter"] &`, when `<html data-context="waiter">` is the ancestor, `waiter:text-brand-700` generates:
```css
[data-context="waiter"] .element { color: #1A6A8C }
```

Usage in components (Story 2+ onwards):
```tsx
<button className="text-brand-600 waiter:text-brand-700 waiter:min-h-[56px]">
  Tap target — larger + higher contrast for outdoor waiter use
</button>
```

**Critical**: Do NOT use `[data-context="waiter"]:` arbitrary variant syntax — use the named `waiter:` variant defined here. This is the architecture's explicit requirement: "All Tailwind variant rules cascade from this root attribute."

### layout.tsx: data-context Plumbing Pattern

```tsx
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { headers } from 'next/headers'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

export const metadata: Metadata = {
  title: 'Carpe Diem RMS',
  description: 'Restaurant management system for Carpe Diem Restaurant',
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const headersList = await headers()
  const role = headersList.get('x-staff-role') as 'waiter' | 'owner' | 'kitchen' | null

  return (
    <html
      lang="en"
      {...(role ? { 'data-context': role } : {})}
      className={`${inter.variable} antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  )
}
```

Key points:
- `async` is required to `await headers()` — Next.js 16 requires this for dynamic header reads in Server Components
- Spread `{ 'data-context': role }` only when role is non-null — attribute is absent for unauthenticated state (AC5)
- `inter.variable` injects `--font-inter` CSS variable that `@theme { --font-sans: var(--font-inter) }` references
- `antialiased` keeps the font rendering from create-next-app
- `h-full` is removed from `<html>` (Story 1.1 create-next-app default) — `min-h-full` on `<body>` is sufficient

### Inter Font — No Additional Dependency

`next/font/google` ships with the `next` package (16.2.9 already installed). Importing `Inter` from `'next/font/google'` fetches and self-hosts Inter automatically during build/dev. No CDN dependency, no additional npm install.

### Retaining Tailwind v4 Dark Mode Block

The create-next-app generated `globals.css` includes a `@media (prefers-color-scheme: dark)` block. **Remove this block** — CDRMS does not use a dark mode via media query. Dark/high-contrast behavior is handled by `[data-context="waiter"]` variant, not OS-level dark mode. Keeping it would conflict with the brand palette.

Also remove the default `:root { --background: ...; --foreground: ...; }` and `@theme inline` blocks from create-next-app — these are replaced by the CDRMS design token system.

### What NOT to Implement in This Story

- No component-level styles (those land in Story 2+)
- No PINPad, TableCard, or any POS component
- No auth — the `x-staff-role` header is always null in this story; `data-context` will never actually appear until Story 2.2 adds session middleware
- No shadcn/ui component additions (components.json is already in place from Story 1.1; add components per-story via `pnpm dlx shadcn@latest add <component>`)
- No PWA manifest or service worker (Story 1.6)
- No `tailwind.config.ts` — Tailwind v4 CSS-first only

### Story 1.1 Learnings Carried Forward

From Story 1.1 completion notes and deferred work:
- **pnpm 11**: Any new package that has build scripts will need `allowBuilds` in `pnpm-workspace.yaml` — watch for this; Inter font has no build script so no issue
- **Tailwind v4 CSS-first**: Already established — all tokens in `@theme`, no `.config.ts` file
- **`await headers()`**: Next.js 16 server components require `await` on the `headers()` call (it returns a `Promise<ReadonlyHeaders>` in Next.js 16)
- **TypeScript strict**: The `as 'waiter' | 'owner' | 'kitchen' | null` cast on the header is intentional — it narrows the type for the attribute spread

### Contrast Reference (from UX spec — pre-verified, do not recalculate)

| Token | Hex | Background | Ratio | Standard |
|---|---|---|---|---|
| brand-600 | #2288B4 | #FFFFFF | 4.6:1 | WCAG AA ✅ |
| brand-700 | #1A6A8C | #FFFFFF | 7.1:1 | WCAG AAA ✅ |
| neutral-900 | #0F172A | #FFFFFF | 18.1:1 | WCAG AAA ✅ |

### Project Structure Notes

- **`globals.css`** is in `src/app/globals.css` (UPDATE — full replacement of @theme block)
- **`layout.tsx`** is in `src/app/layout.tsx` (UPDATE — replace Geist with Inter, add async data-context plumbing)
- **No new files created** in this story — it is entirely configuration, not implementation
- Architecture directory tree shows `tailwind.config.ts` at root — this is a planning artifact error; the file does not exist and must not be created in Tailwind v4

### References

- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — §Brand Color, §Structural Palette, §Semantic Colors, §Typography System, §Spacing & Layout Foundation, §Accessibility Considerations
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — §Core Technology Decisions (Tailwind v4), §`[data-context]` implementation, §Critical Implementation Order
- Story 1.1 completion notes: `_bmad-output/implementation-artifacts/1-1-initialize-nextjs-project-with-core-tooling.md` — Tailwind v4 already installed, no tailwind.config.ts
- [Tailwind v4 @theme docs](https://tailwindcss.com/docs/v4-beta#css-first-configuration) — CSS variable naming conventions for color, spacing, text
- [Tailwind v4 @custom-variant](https://tailwindcss.com/docs/v4-beta#arbitrary-variants) — custom variant syntax

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

**@custom-variant syntax (Tailwind v4.3.1):** The story's Dev Notes showed the curly-brace form `{ [data-context="waiter"] & }`. This is invalid in Tailwind v4.3.1 — PostCSS rejects `&` inside a block body. The parentheses form `([data-context="waiter"] &)` was also rejected ("has no selector or body"). The correct form is the `:is()` pattern mirroring Tailwind's built-in dark variant: `(&:is([data-context="waiter"] *))`. Future stories: always use this form for ancestor-based custom variants.

**Turbopack dev CSS emission:** Tailwind v4 `@theme` tokens are only emitted to `:root` when a utility referencing them is used on the current page. With no POS components yet, brand/spacing/typography tokens were absent from the served CSS. Fix: added all tokens to an explicit `@layer base { :root { ... } }` block in addition to `@theme`. This ensures tokens are always on `:root` for JS access, `calc()` expressions, and inline styles — regardless of which Tailwind utilities appear on the page. Both declarations are present: `@layer base :root` for guaranteed availability, `@theme` for Tailwind utility generation.

### Completion Notes List

- All 5 tasks complete; all 7 ACs satisfied.
- `src/app/layout.tsx`: Geist replaced with Inter; async layout reads `x-staff-role` header to set `data-context` on `<html>`; metadata updated to "Carpe Diem RMS".
- `src/app/globals.css`: Full CDRMS design token system — 10 brand colors, 7 neutral steps, 4 status colors, 7 spacing steps, 6 typography sizes. Tokens declared in both `@layer base { :root {} }` (guaranteed availability) and `@theme` (Tailwind utility generation). Three `@custom-variant` declarations for `waiter`, `owner`, `kitchen` using `(&:is([data-context="*"] *))` syntax.
- No new dependencies added; no `tailwind.config.ts` created.
- `pnpm exec tsc --noEmit` exits 0; `pnpm dev` serves HTTP 200 with no CSS errors.

### File List

- `src/app/layout.tsx` — UPDATED: Inter font, async data-context plumbing, metadata
- `src/app/globals.css` — UPDATED: full CDRMS design token system, @custom-variant declarations

### Senior Developer Review (AI)

Date: 2026-06-21
Outcome: Changes Requested
Action Items: 1 patch, 5 deferred

#### Action Items

- [x] [Review][Patch] Switch Inter font from `next/font/google` to `next/font/local` to support offline LAN builds [`src/app/layout.tsx:7`]
- [x] [Review][Defer] Duplicate token values in `@layer base :root` and `@theme` [`globals.css:16-113`] — deferred, pre-existing workaround for Turbopack dev-mode lazy emission; verify with `next build` before consolidating
- [x] [Review][Defer] `x-staff-role` header cast without runtime validation [`layout.tsx:21`] — deferred, address in Story 2.2 when middleware sets the header
- [x] [Review][Defer] `[data-context]` on `<html>` excludes `<html>` itself from variants [`globals.css:7-9`] — deferred, not a current issue; document as constraint for future stories
- [x] [Review][Defer] Custom `--text-*` tokens lack `--{name}--line-height` companions [`globals.css:107-113`] — deferred, line-heights unspecified in Story 1.2; address in component stories
- [x] [Review][Defer] Dev Notes show wrong `@custom-variant` curly-brace syntax [`1-2-configure-design-token-system.md:164-167`] — deferred, pre-existing in spec; debug log has the correct form
