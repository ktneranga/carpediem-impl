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
export function findRoutePolicy(pathname: string): RoutePolicy | null {
  let match: RoutePolicy | null = null

  for (const policy of ROUTE_ROLES) {
    if (pathname === policy.prefix || pathname.startsWith(`${policy.prefix}/`)) {
      if (!match || policy.prefix.length > match.prefix.length) {
        match = policy
      }
    }
  }

  return match
}

/** True when the role may access the path. Unrestricted paths allow any role. */
export function isRoleAllowed(pathname: string, role: StaffRole): boolean {
  const policy = findRoutePolicy(pathname)
  return policy === null || policy.roles.includes(role)
}
