---
stepsCompleted: [1]
inputDocuments: []
workflowType: 'research'
lastStep: 1
research_type: 'technical'
research_topic: 'tech stack for restaurant management system'
research_goals: 'Cross-device support (tablets, desktop/web, kitchen/bar displays, mobile phones); easy for non-technical staff to maintain with managed/hosted services; JavaScript/TypeScript team'
user_name: 'Teran'
date: '2026-05-16'
web_research_enabled: true
source_verification: true
---

# Research Report: Technical

**Date:** 2026-05-16
**Author:** Teran
**Research Type:** Technical

---

## Research Overview

## Technical Research Scope Confirmation

**Research Topic:** tech stack for restaurant management system
**Research Goals:** Cross-device support (tablets, desktop/web, kitchen/bar displays, mobile phones); easy for non-technical staff to maintain with managed/hosted services; JavaScript/TypeScript team

**Technical Research Scope:**

- Architecture Analysis - design patterns, frameworks, system architecture
- Implementation Approaches - development methodologies, coding patterns
- Technology Stack - languages, frameworks, tools, platforms
- Integration Patterns - APIs, protocols, interoperability
- Performance Considerations - scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** 2026-05-16

---

<!-- Content will be appended sequentially through research workflow steps -->

## Technology Stack Analysis

### Programming Languages

TypeScript is the dominant choice for restaurant management systems in 2026, with **48.8% of professional developers** using it and an **84.1% satisfaction rate** (Stack Overflow Developer Survey 2025). Its static typing reduces runtime bugs in complex order-state machines — critical when a missed KOT could mean a table waits 30 minutes.

_Popular Languages: TypeScript (primary), JavaScript (runtime)_
_Emerging: None displacing TS for this domain in 2026_
_Performance Characteristics: TypeScript compiles to optimized JS; adequate for real-time order routing at restaurant scale_
_Source: [Stack Overflow Developer Survey 2025 via strapi.io](https://strapi.io/blog/best-javascript-frameworks)_

---

### Development Frameworks and Libraries

**Frontend / Full-Stack:**

| Framework | Usage Share | Fit for Carpe Diem |
|---|---|---|
| **Next.js (React)** | ~44.7% | ⭐ Best fit — SSR + API routes + PWA support covers web dashboard, tablet UI, and KDS displays in one codebase |
| React Native | N/A (mobile) | Strong option if native tablet/mobile app is preferred over PWA |
| Vue / Nuxt | ~17.6% | Solid alternative, smaller ecosystem |
| SvelteKit | ~7.2% | High performance but smaller talent pool |

**Recommendation:** **Next.js + TypeScript** as the primary framework. It ships as a web app accessible from desktop browsers, tablets (as a PWA), and kitchen display screens — all from a single codebase. React Native is the upgrade path if native device features are needed later.

_Major Frameworks: Next.js dominates full-stack React in 2026_
_Ecosystem Maturity: Excellent — massive library availability, strong TypeScript support_
_Source: [Best Restaurant App Tech Stack 2026 — DEV Community](https://dev.to/quokka_labs/best-restaurant-app-tech-stack-in-2026-for-food-ordering-and-delivery-apps-g7n), [Best JavaScript Frameworks 2026 — Strapi](https://strapi.io/blog/best-javascript-frameworks)_

---

### Database and Storage Technologies

**Supabase (PostgreSQL-backed BaaS)** is the strongest match for Carpe Diem's needs:

| Criteria | Supabase | Firebase |
|---|---|---|
| Data model | Relational SQL (PostgreSQL) | NoSQL (Firestore) |
| Restaurant fit | ⭐ Excellent — orders → items → inventory are naturally relational | Weaker for complex joins |
| Real-time | Built-in (PostgreSQL logical replication → WebSocket) | Built-in (Firestore listeners) |
| Auth | Built-in | Built-in |
| Pricing | Flat tiers, predictable at scale | Per-operation — costs compound with high-frequency order events |
| Self-host option | Yes (open-source) | No |

**Why Supabase wins for a restaurant:** A KOT event is `orders → order_items → menu_items → categories`. Relational integrity prevents ghost orders and inventory drift. Supabase's real-time layer pushes order updates to kitchen displays in milliseconds via WebSocket subscriptions — no polling.

_Relational Databases: PostgreSQL via Supabase_
_NoSQL: Firebase (not recommended for this use case)_
_In-Memory / Cache: Not required at Carpe Diem's scale initially_
_Source: [Supabase vs Firebase 2026 — Bytebase](https://www.bytebase.com/blog/supabase-vs-firebase/), [Supabase Official](https://supabase.com/)_

---

### Development Tools and Platforms

| Tool | Purpose |
|---|---|
| **VS Code** | Primary IDE — best TypeScript/Next.js DX, free |
| **Git + GitHub** | Version control — standard |
| **Bun or npm** | Package management — Bun is 2-3x faster for installs |
| **ESLint + Prettier** | Code quality and formatting |
| **Vitest / Jest** | Unit and integration testing |
| **Playwright** | E2E testing for order-flow critical paths |

_Source: [Full Stack Frameworks Guide 2026 — GloryWebs](https://www.glorywebs.com/blog/full-stack-frameworks)_

---

### Cloud Infrastructure and Deployment

The restaurant management software market has made a decisive shift to cloud-native: **cloud-based POS commands ~50% of the market** (valued at $2.51B in 2025), and over **90% of operators prioritize system integration** as a top goal in 2026.

**Recommended managed stack (zero server administration):**

| Layer | Service | Why |
|---|---|---|
| Frontend + API | **Vercel** | Native Next.js hosting, auto-deploy from GitHub, global CDN, free tier generous |
| Database + Auth + Realtime | **Supabase** | Fully managed PostgreSQL, built-in auth, real-time subscriptions, storage |
| File storage (receipts, menus) | Supabase Storage | Integrated, S3-compatible |
| Email (receipts, alerts) | Resend or SendGrid | Simple managed transactional email |

**Total managed services, no server to maintain.** Non-technical staff only interact with the app UI; the infrastructure auto-scales and is maintained by Vercel and Supabase teams.

_Cloud Market Data Source: [Mordor Intelligence Restaurant Management Software Market](https://www.mordorintelligence.com/industry-reports/restaurant-management-software-market), [Research.com Cloud Restaurant Software 2026](https://research.com/software/cloud-based-restaurant-software)_

---

### Kitchen & Bar Display (KDS / BOT) Technology

Tablet-based KDS is the **industry standard in 2026**. The global KDS market is projected at **USD 520M in 2025** with 7.15% CAGR. Leading solutions (Fresh KDS, Square KDS, Loyverse) all run on iPad or Android tablets over Wi-Fi with cloud-hosted backends.

**For Carpe Diem — custom KDS approach:**

Rather than buying a third-party KDS subscription, a custom KDS display can be built as a **dedicated React page** within the same Next.js app. It subscribes to Supabase Realtime order events and renders tickets in real time on a tablet mounted in the kitchen or bar.

| Feature | Implementation |
|---|---|
| Real-time ticket delivery | Supabase Realtime WebSocket subscription |
| Color-coded order status | React UI state (new → in-progress → done) |
| Device | Cheap Android tablet or iPad as a browser kiosk |
| Routing | Kitchen tickets vs. Bar tickets filtered by `order_item.station` |

This avoids per-device KDS subscription fees and keeps the entire system in one codebase.

_Source: [Kitchen Display Systems Guide 2026 — Delivety](https://delivety.com/blog/kitchen-display-system-guide-what-is-a-kds), [Fresh KDS](https://www.fresh.technology/), [6 Best KDS 2025 — Loman.ai](https://loman.ai/blog/best-kitchen-display-systems-order-routing)_

---

### Technology Adoption Trends

- **Cloud-first is the default:** On-premise restaurant software is declining sharply. Managed cloud services reduce the IT burden that non-technical restaurant owners cannot handle.
- **TypeScript has crossed the majority threshold:** TS is no longer optional for serious JS projects — it's the default.
- **PWA vs. native app gap is closing:** Next.js PWAs on tablets now offer near-native performance, deferring the cost of a separate React Native build.
- **Supabase is displacing Firebase** for structured data applications — predictable pricing and SQL are winning the restaurant/retail vertical.
- **AI-assisted scheduling and operations** is an emerging add-on but not yet table-stakes for a v1 system.

_Source: [Restaurant Technology Stack 2026 — Affinect](https://affinect.com/restaurant-technology-stack), [Building a Modern Restaurant Tech Stack — GetSauce](https://www.getsauce.com/post/building-a-restaurant-tech-stack)_
