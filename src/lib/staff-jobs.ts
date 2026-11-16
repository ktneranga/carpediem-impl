/**
 * Job titles for staff (Story 10.2, Teran 2026-11-13).
 *
 * The owner picks a job; its `access` becomes the person's `staff.role`
 * (owner / waiter / kitchen), which is what the proxy checks. A new job here
 * needs no permission change as long as it uses one of those three. Extra
 * rights for one person are per-person permissions (Story 10.6).
 *
 * Shared by the server (validation) and the Manage screen. Adding a job: add it
 * here; stored values are the `job` keys, so never rename one.
 */
export const STAFF_JOBS = [
  { job: 'waiter', label: 'Waiter', access: 'waiter' },
  { job: 'bartender', label: 'Bartender', access: 'waiter' },
  { job: 'barista', label: 'Barista', access: 'waiter' },
  { job: 'cashier', label: 'Cashier', access: 'waiter' },
  { job: 'helper', label: 'Helper', access: 'waiter' },
  { job: 'chef', label: 'Chef', access: 'kitchen' },
  { job: 'owner', label: 'Owner', access: 'owner' },
] as const

export type StaffJob = (typeof STAFF_JOBS)[number]['job']

export const isStaffJob = (value: string): value is StaffJob => STAFF_JOBS.some((j) => j.job === value)

/** The access (`staff.role`) a job gives. */
export const accessOf = (job: StaffJob) => STAFF_JOBS.find((j) => j.job === job)!.access

export const jobLabel = (job: string) => STAFF_JOBS.find((j) => j.job === job)?.label ?? job
