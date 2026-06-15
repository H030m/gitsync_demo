// Discord snowflake helpers.
// ⚠️ Mirror of functions/src/tools/discordSnowflake.ts — keep both in sync.

// Discord epoch: 2015-01-01T00:00:00Z in milliseconds.
const DISCORD_EPOCH_MS = 1420070400000n;
// Asia/Taipei is a fixed UTC+8 offset year-round.
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// Returns the snowflake id for the START of the given Asia/Taipei calendar day
// (YYYY-MM-DD), usable as an `after` cursor (messages on/after that instant have
// a larger id). Throws on a malformed date.
export function snowflakeForTaipeiDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date: ${date}`);
  }
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(utcMidnight)) {
    throw new Error(`invalid date: ${date}`);
  }
  // -1ms so the `after` cursor is inclusive of a message on the exact boundary.
  const startMs = BigInt(utcMidnight - TAIPEI_OFFSET_MS - 1);
  return ((startMs - DISCORD_EPOCH_MS) << 22n).toString();
}

// Returns the snowflake for the END of the given Taipei day (= START of the next
// day, +24h). EXCLUSIVE upper bound (high cursor): a message is in range iff its
// id is < snowflakeForTaipeiDayEnd(endDate). Throws on a malformed date.
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
