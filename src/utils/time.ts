/**
 * One way to render an instant, used everywhere the suite prints a time.
 *
 * Every timestamp this project deals with is UTC and always will be: GitHub's
 * `x-ratelimit-reset` is epoch seconds, its `created_at`/`updated_at` are
 * Z-qualified (SCH-06 pins that), and GitHub Actions cron has no timezone support
 * at all. The reader, however, is usually not in UTC — so a bare `...Z` is correct
 * and still leaves them doing arithmetic to work out whether a budget resets
 * before or after their next coffee.
 *
 * So every rendered time states UTC explicitly *and* shows the local equivalent.
 * The local zone comes from the machine, or from REPORT_TIMEZONE when set — an
 * IANA name such as `Europe/Berlin`. On a CI runner the zone is UTC, so the
 * parenthetical is dropped rather than printed twice.
 */

import { env } from '../config/env';

/** Resolved once: `Intl` zone lookup is not free and this cannot change mid-run. */
const localZone = env.reportTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

const UTC_ALIASES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Universal', 'Zulu']);

/** GitHub reports rate-limit resets as epoch **seconds**, not milliseconds. */
export function fromEpochSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

/** `2026-08-03 04:32:37 UTC` — the unambiguous half, always present. */
function utcPart(when: Date): string {
  return `${when.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/**
 * `2026-08-03 04:32:37 UTC (06:32 Europe/Berlin)`
 *
 * The local time carries its date too whenever it falls on a different day from
 * the UTC one — near midnight, `23:40 UTC (01:40)` would otherwise read as an
 * instant that has already passed.
 */
export function formatInstant(when: Date): string {
  if (UTC_ALIASES.has(localZone)) return utcPart(when);

  const utcDay = when.toISOString().slice(0, 10);
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: localZone }).format(when);

  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: localZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(when);

  const local = localDay === utcDay ? clock : `${localDay} ${clock}`;
  return `${utcPart(when)} (${local} ${localZone})`;
}

/** Convenience for the common case: a GitHub rate-limit reset header. */
export function formatResetTime(epochSeconds: number): string {
  return formatInstant(fromEpochSeconds(epochSeconds));
}