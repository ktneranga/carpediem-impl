import type { staffRoleEnum } from '@/server/db/schema'

export type StaffRole = (typeof staffRoleEnum.enumValues)[number]

/**
 * Route access policy, held as data rather than scattered `if` statements so it
 * can be read, reviewed, and tested in one place.
 *
 * ── Role model divergence (Story 2.3) ────────────────────────────────────────
 * The PRD permission matrix (prd.md:341-357) defines FOUR roles:
 * Owner / Manager / Staff / Kitchen-Bar. The schema enum only ever had THREE:
 * owner / waiter / kitchen. There is no `manager`.
 *
 * For v1, Manager capabilities are folded into `owner`. Carpe Diem has 8 staff
 * with explicitly fluid roles (prd.md:38), so a middle tier buys nothing here —
 * it is a SaaS-customer need. Adding the enum value would require a migration
 * and touch Epics 7-10, none of which exist yet.
 *
 * Whoever builds Epic 7 (audit), 8 (inventory), 9 (dashboard) or 10 (config)
 * must revisit this.
 */
export type RoutePolicy = {
  prefix: string
  roles: StaffRole[]
  /**
   * Methods EXEMPT from this policy — everything else it governs.
   *
   * Stated as an exemption list, not an allowlist, so the default direction
   * matches the rest of this file: anything not named is restricted. The first
   * version of this field listed the governed methods instead
   * (`['POST','PATCH','DELETE']`), which meant an unlisted verb matched no
   * policy at all and fell through to default-allow — so a future
   * `PUT /api/tables/:id` would have silently been reachable by every role,
   * with no missing-policy error to surface it. Caught in Story 3.3's review.
   *
   * Omitted means the policy governs all methods, so every policy written
   * before method-awareness existed keeps its original meaning.
   *
   * `/api/tables` needs to be READABLE by every role — the landing screen
   * renders the table grid whoever is signed in — while every write beneath it
   * must exclude kitchen staff, who are display-only (prd.md:348). A path-only
   * policy cannot express that: adding `/api/tables` for owner+waiter would
   * have 403'd the grid for kitchen users.
   */
  exemptMethods?: string[]
}

export const ROUTE_ROLES: RoutePolicy[] = [
  // Configuration and staff management — Owner only (PRD: "Full menu
  // management", "Staff management", "System configuration").
  { prefix: '/api/config', roles: ['owner'] },
  { prefix: '/api/staff', roles: ['owner'] },
  { prefix: '/owner', roles: ['owner'] },

  // Kitchen display. Listed now even though Epic 5 builds the screen — access
  // policy belongs with the policy, not with whichever story adds the route.
  // Waiters are excluded: the PRD matrix gives them no KDS access.
  { prefix: '/api/kitchen', roles: ['owner', 'kitchen'] },
  { prefix: '/kitchen', roles: ['owner', 'kitchen'] },

  // Order entry and billing — everyone except kitchen staff, who are
  // display-only (prd.md:348).
  { prefix: '/api/orders', roles: ['owner', 'waiter'] },
  { prefix: '/api/bills', roles: ['owner', 'waiter'] },
  { prefix: '/api/payments', roles: ['owner', 'waiter'] },

  // Opening and closing table sessions is order entry, so it follows the same
  // rule. Reads are exempt because every role's landing screen calls
  // GET /api/tables; every write — including verbs that do not exist yet — is
  // owner + waiter.
  //
  // NOTE for whoever adds table CRUD: prd.md:341-357 reserves table
  // configuration for owner, but this prefix cannot distinguish
  // `POST /api/tables` (create a table, owner-only) from
  // `POST /api/tables/:id/sessions` (seat a table, waiters too). When a CRUD
  // handler lands, give it its own longer-prefix policy — longest match wins,
  // so `/api/tables/config` or similar will correctly override this entry.
  {
    prefix: '/api/tables',
    roles: ['owner', 'waiter'],
    exemptMethods: ['GET', 'HEAD'],
  },

  // The ordering menu (Story 4.2, FR7).
  //
  // Added BEFORE the route existed, for the reason spelled out below: an
  // unmatched prefix is default-allow. Kitchen staff are excluded because they
  // read tickets, not the ordering menu — if Epic 5's KDS ever needs item names
  // it gets its own endpoint under `/api/kitchen`, which is already policed.
  { prefix: '/api/menu', roles: ['owner', 'waiter'] },

  // Session-addressed order entry (Story 3.9, FR64).
  //
  // ADDED BEFORE THE FIRST ROUTE EXISTS UNDER IT, and that ordering is the whole
  // point. `findRoutePolicy` returns null for an unmatched prefix and
  // `isRoleAllowed` reads null as "any authenticated role" — default-allow is
  // deliberate so a new route surfaces as a missing policy rather than a
  // confusing 403. But `/api/sessions` matched NOTHING, so shipping a route
  // under it first would have let every kitchen user open, close and read
  // orders, with nothing erroring and nothing logging.
  //
  // No exemptMethods. Unlike /api/tables — whose GET is exempt because every
  // role's landing screen calls it — nothing here needs reading by kitchen.
  //
  // NOTE for Epic 6/7: `GET /api/sessions/:sessionId/history` is specified as
  // readable by any staff member, and that CANNOT be carved out with a longer
  // prefix — the session id sits mid-path and a dynamic segment defeats prefix
  // specialisation, the same limitation documented against /api/tables above.
  // Give the history and audit views their own namespace (/api/audit/...).
  { prefix: '/api/sessions', roles: ['owner', 'waiter'] },

  // The order entry screen itself. Kitchen staff are excluded from opening
  // sessions, so letting them read the order screen — covers, timing, session
  // detail — by typing a URL would make that exclusion cosmetic. The table grid
  // at `/` stays open to every role; this is only the per-table screen.
  //
  // `/orders` is the session-addressed successor to `/tables/[tableId]`. It does
  // NOT inherit the `/api/orders` policy — a page path does not start with the
  // API prefix — so without this entry, moving the order screen there would have
  // silently undone the protection the `/tables` entry exists to provide.
  { prefix: '/tables', roles: ['owner', 'waiter'] },
  { prefix: '/orders', roles: ['owner', 'waiter'] },
]

/**
 * Longest matching prefix wins, so `/api/config/advanced` cannot be loosened by
 * a shorter, more permissive entry appearing first.
 *
 * Returns null when no policy matches — meaning "any authenticated staff member".
 * Default-allow is deliberate: default-deny would break every Epic 3/4/5 route
 * the moment it is added, and would surface as a confusing 403 rather than an
 * obvious missing-policy error.
 */
export function findRoutePolicy(pathname: string, method?: string): RoutePolicy | null {
  let match: RoutePolicy | null = null

  for (const policy of ROUTE_ROLES) {
    if (pathname !== policy.prefix && !pathname.startsWith(`${policy.prefix}/`)) continue

    // Method filtering happens DURING matching, not after.
    //
    // Filtering afterwards would let a method-mismatched longest prefix shadow a
    // shorter policy that does apply, silently widening access. A policy that
    // does not govern this method is simply not a candidate.
    //
    // Exemption, not allowlist: only the methods named are skipped, so any verb
    // nobody thought about stays governed.
    if (policy.exemptMethods && method && policy.exemptMethods.includes(method.toUpperCase())) {
      continue
    }

    if (!match || policy.prefix.length > match.prefix.length) {
      match = policy
    }
  }

  return match
}

/**
 * True when the role may access the path. Unrestricted paths allow any role.
 *
 * `method` is optional so existing callers and tests keep working; omitting it
 * means no exemption can apply, so the policy governs everything — the
 * conservative direction (deny more, never less).
 */
export function isRoleAllowed(pathname: string, role: StaffRole, method?: string): boolean {
  const policy = findRoutePolicy(pathname, method)
  return policy === null || policy.roles.includes(role)
}
