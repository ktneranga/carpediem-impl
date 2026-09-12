import 'server-only'

/**
 * The restaurant's day boundary, computed in the RESTAURANT's timezone.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `new Date().setHours(0, 0, 0, 0)` gives midnight in the Node process's
 * timezone, which is not the restaurant's. `docker-compose.yml` passes
 * `TIMEZONE=Asia/Colombo`, but **Node reads `TZ`**, not `TIMEZONE` — so in the
 * container the process runs in UTC and "today" begins at 05:30 local. The bug
 * is invisible in development, because a developer's own machine is usually
 * already in the restaurant's timezone, and appears only in production.
 *
 * `tenant_config.timezone` has existed since Story 1.3, seeded to `Asia/Colombo`,
 * and until now was read by nothing. This is what it is for.
 *
 * ── Why not just set TZ ──────────────────────────────────────────────────────
 * `TZ` is also set in `docker-compose.yml`, because a process whose clock agrees
 * with the restaurant makes logs and stack traces legible. But correctness must
 * not depend on deployment configuration: a second deployment, a different host,
 * or a forgotten env var would silently move the day boundary again, and nothing
 * would fail loudly. The timezone is a property of the restaurant, so it is read
 * from the restaurant.
 */
export function startOfDayInZone(timeZone: string, now: Date = new Date()): Date {
  // The calendar date as the restaurant sees it right now. `en-CA` yields
  // ISO-shaped `YYYY-MM-DD`, which needs no reassembly.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  // Treat that local date as if it were UTC, then subtract the zone's offset AT
  // that instant. Taking the offset at `now` instead would be wrong across a DST
  // change; taking it at the guess is correct for every zone this product runs
  // in, and Asia/Colombo has no DST at all.
  const guess = new Date(`${today}T00:00:00Z`)
  return new Date(guess.getTime() - zoneOffsetMs(timeZone, guess))
}

/** How far ahead of UTC `timeZone` is, at a given instant, in milliseconds. */
function zoneOffsetMs(timeZone: string, at: Date): number {
  // Format the instant in the target zone, read the result back as if it were
  // UTC, and the difference is the offset. Cheaper and more robust than parsing
  // `timeZoneName`, which is localised and inconsistent across runtimes.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')

  // `hour12: false` can render midnight as hour 24 in some runtimes.
  const hour = get('hour') % 24

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  )

  return asUtc - at.getTime()
}
