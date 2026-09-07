# Claude Design brief — Carpe Diem RMS

Paste everything below the line into claude.ai/design.

---

Design a restaurant POS for **Carpe Diem**, a beach restaurant on the south coast of Sri Lanka. It replaces a fully manual, pen-and-paper operation. Currency is LKR.

## The problem it exists to solve

The owner cannot see income. Orders are taken verbally, the kitchen cooks without a ticket, and cash disappears. Every screen must make the recorded path *faster* than the verbal shortcut — if using the system is slower than shouting an order at the kitchen, staff will shout.

## Who uses it, and where

**Waiters — the primary users.** Android tablets, held one-handed, outdoors, in direct tropical sunlight, often while walking. Frequently wet hands. They work across four open-air zones: **bean bags, sun beds, tables, rooftop**. 15 tables, ~100 menu items, 8 staff. Roles are fluid — anyone can take or close any order.

**The owner.** Mobile browser, checking remotely, usually the morning after. Wants revenue, cash gaps, comps, and anything left unclosed overnight.

**Kitchen and bar.** A fixed always-on display, no login, never touched except to acknowledge a ticket. Read from about a metre away in a loud, hot room.

These are three genuinely different experiences from one codebase — different density, contrast and target sizes, not three separate apps.

## Screens to design

1. **Sign in** — numeric PIN pad, exactly 4 digits, no keyboard ever, masked as four dots, signs in automatically on the last digit with no confirm button. Sessions expire after 5 minutes idle so this screen is seen constantly. It must feel instant, not ceremonial.
2. **Table grid** — the home screen. Zone filter, then every table with live status: open, occupied, unavailable. Occupied tables show elapsed time and item count. A waiter crossing the deck must read the room at a glance.
3. **Order entry** — search-first menu (100+ items, search is the primary navigation, not browsing), item modifiers, seat assignment, a running total, and one obvious Send action. Items route automatically to three destinations: Kitchen, Pizza Kitchen, Bar.
4. **Bill and split** — drag items between people to split a bill mid-settlement. Groups merge tables across zones and settle separately; this is normal here, not an edge case. Per-person totals update live.
5. **Counter sale** — a guest walks up to the bar, takes a beer or water from the fridge, pays, leaves. One screen: pick, pay, done. No table, no seats, no waiting.
6. **Kitchen ticket display** — always-on ticket queue. One interaction only: acknowledge. Large type, high contrast, no auto-dismiss.
7. **Owner dashboard** — chart-first, not a wall of metric cards. Hourly revenue, payment split, top items, comps by reason. Dark mode matters; it is read on a phone at night.

## Constraints that are not negotiable

- **Touch targets: 80×80px for waiters.** 44px for owner and kitchen. Sunlight, motion and wet hands make anything smaller unusable.
- **Colour never carries meaning alone.** Every status has a text label beside it. Outdoor glare washes out hue.
- **No bottom tab bar anywhere.** Navigation is linear and workflow-driven: a context header with a breadcrumb, a zone filter, and a bottom action strip whose buttons change with the state of the selected table.
- **Order entry in 20 seconds, four taps or fewer.** The rooftop — furthest from the bar — is the benchmark.
- **Nothing is ever edited or deleted.** A correction is a new record. Comps carry a reason code and the name of whoever approved them. The audit trail is the product.

## Where to start visually

There is an existing token system, and I want it evolved rather than replaced:

- **Brand:** coastal sky blue — `#2288B4` primary, `#1A6A8C` darker, `#6EC1E4` light, `#EBF8FD` pale tint
- **Neutrals:** slate — `#0F172A` `#475569` `#94A3B8` `#E2E8F0` `#F1F5F9` `#FFFFFF`
- **Status:** open `#22C55E`, occupied `#F59E0B`, unavailable `#EF4444`
- **Type:** Inter, 12 / 14 / 16 / 18 / 24 / 32px
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48px

The blue ties to the beach setting and is already stored per-tenant for white-labelling. Keep it as the brand, but I want the surrounding craft to go much further than a flat card with a thin grey border — real elevation, deliberate density, and a table card whose whole shape reads its status from across a deck.

## What I want back

A design system plus those screens as artboards: palette with tinted status pairs, type ramp, elevation, radii, and the reusable pieces — table card in every state, PIN pad, zone filter, menu item card, order line, ticket, action strip, status pills.

Tablet landscape, roughly 1194×834. Show the interesting states, not just the empty happy path: an occupied table running 67 minutes with an unpaid bill, an item that has sold out, a printer that failed, a bill mid-split.

## What to avoid

- Generic SaaS dashboard styling — this is an operational tool used standing up, not a reporting product
- Food photography. A beach kitchen has no product shots, and the menu is text
- Dense desktop tables or small text anywhere in the waiter flow
- Decorative gradients or anything that costs contrast in sunlight
