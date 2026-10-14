// This server holds the actual platform API credentials, so it - not
// whatever calls it - is responsible for making sure a request can't reach
// back further than is reasonable before it ever hits an upstream API.
// MAX_LOOKBACK_HOURS is that hard ceiling (a generous week, since this is
// an API-abuse backstop, not report-relevance logic - a caller that wants a
// tighter window for its own purposes, e.g. a daily digest, enforces that
// itself on top of this).
export const MAX_LOOKBACK_HOURS = 24 * 7;

export function clampLookbackHours(hours: number | undefined, fallback: number): number {
  const v = Number.isFinite(hours) && (hours as number) > 0 ? (hours as number) : fallback;
  return Math.min(v, MAX_LOOKBACK_HOURS);
}

export function clampSinceTs(rawSinceTs: unknown): number | undefined {
  const ts = Number(rawSinceTs);
  if (!Number.isFinite(ts) || ts <= 0) return undefined;
  const floorTs = Math.floor(Date.now() / 1000) - MAX_LOOKBACK_HOURS * 3600;
  return Math.max(ts, floorTs);
}
