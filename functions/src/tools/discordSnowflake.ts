// Discord snowflake helpers. A snowflake id encodes its creation time in the
// high bits, so a calendar date can be turned into a snowflake to use as an
// `after` cursor for REST message backfill (channel.messages.fetch({ after })).
//
// ⚠️ Keep in sync with discord-bot/src/snowflake.ts (same formula, two runtimes).

// Discord epoch: 2015-01-01T00:00:00Z in milliseconds.
const DISCORD_EPOCH_MS = 1420070400000n;
// Asia/Taipei is a fixed UTC+8 offset year-round (matches the digest flow).
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Returns the snowflake id for the START of the given Asia/Taipei calendar day
 * (`YYYY-MM-DD`). Messages posted at/after that instant have a larger id, so the
 * result works as an `after` cursor to fetch a day onward. Throws on a malformed
 * date.
 */
export function snowflakeForTaipeiDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date: ${date}`);
  }
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(utcMidnight)) {
    throw new Error(`invalid date: ${date}`);
  }
  // Taipei midnight is 16:00 UTC the previous day; subtracting the offset from
  // the parsed UTC-midnight gives the correct instant. Subtract 1ms so the
  // `after` cursor is inclusive of a message landing exactly on the boundary.
  const startMs = BigInt(utcMidnight - TAIPEI_OFFSET_MS - 1);
  return ((startMs - DISCORD_EPOCH_MS) << 22n).toString();
}

/**
 * Returns the snowflake id for the END of the given Asia/Taipei calendar day —
 * i.e. the START of the NEXT day (`date` + 24h). This is the EXCLUSIVE upper
 * bound (high cursor) of a backfill range: a message belongs to the range iff
 * its id is `< snowflakeForTaipeiDayEnd(endDate)`. No -1ms here (we want the
 * exact next-day boundary, compared with `>=`). Throws on a malformed date.
 */
export function snowflakeForTaipeiDayEnd(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date: ${date}`);
  }
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(utcMidnight)) {
    throw new Error(`invalid date: ${date}`);
  }
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const endMs = BigInt(utcMidnight - TAIPEI_OFFSET_MS + ONE_DAY_MS);
  return ((endMs - DISCORD_EPOCH_MS) << 22n).toString();
}

/** Taipei 00:00 of `date` as a UTC epoch-ms number (for Firestore Timestamp). */
export function taipeiDayStartMs(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date: ${date}`);
  }
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(utcMidnight)) {
    throw new Error(`invalid date: ${date}`);
  }
  return utcMidnight - TAIPEI_OFFSET_MS;
}
