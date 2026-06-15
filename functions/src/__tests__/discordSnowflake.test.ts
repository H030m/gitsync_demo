import {
  snowflakeForTaipeiDate,
  snowflakeForTaipeiDayEnd,
  taipeiDayStartMs,
} from '../tools/discordSnowflake';

describe('snowflakeForTaipeiDate', () => {
  it('produces a numeric string that round-trips to roughly the day start', () => {
    const sf = snowflakeForTaipeiDate('2026-06-03');
    expect(sf).toMatch(/^\d+$/);

    // Decode: ms = (snowflake >> 22) + DISCORD_EPOCH. Should be ~ Taipei
    // 2026-06-03 00:00 = 2026-06-02T16:00:00Z (minus the 1ms inclusivity nudge).
    const DISCORD_EPOCH_MS = 1420070400000n;
    const ms = Number((BigInt(sf) >> 22n) + DISCORD_EPOCH_MS);
    const expected = Date.parse('2026-06-02T16:00:00Z');
    expect(Math.abs(ms - expected)).toBeLessThanOrEqual(2);
  });

  it('is monotonic across days', () => {
    const a = BigInt(snowflakeForTaipeiDate('2026-06-03'));
    const b = BigInt(snowflakeForTaipeiDate('2026-06-04'));
    expect(b > a).toBe(true);
  });

  it('rejects malformed dates', () => {
    expect(() => snowflakeForTaipeiDate('2026-6-3')).toThrow();
    expect(() => snowflakeForTaipeiDate('nope')).toThrow();
  });
});

describe('snowflakeForTaipeiDayEnd', () => {
  it('equals roughly the start of the NEXT Taipei day', () => {
    const end = snowflakeForTaipeiDayEnd('2026-06-03');
    const DISCORD_EPOCH_MS = 1420070400000n;
    const ms = Number((BigInt(end) >> 22n) + DISCORD_EPOCH_MS);
    // Taipei 2026-06-04 00:00 = 2026-06-03T16:00:00Z.
    const expected = Date.parse('2026-06-03T16:00:00Z');
    expect(Math.abs(ms - expected)).toBeLessThanOrEqual(2);
  });

  it('day end of D equals (just above) the day start of D+1, forming a tight window', () => {
    const endOf3 = BigInt(snowflakeForTaipeiDayEnd('2026-06-03'));
    const startOf4 = BigInt(snowflakeForTaipeiDate('2026-06-04'));
    const startOf3 = BigInt(snowflakeForTaipeiDate('2026-06-03'));
    // A message in [start3, end3) belongs to day 3; end3 ~= start4 boundary.
    expect(endOf3 > startOf3).toBe(true);
    expect(endOf3 >= startOf4).toBe(true);
  });

  it('rejects malformed dates', () => {
    expect(() => snowflakeForTaipeiDayEnd('bad')).toThrow();
  });
});

describe('taipeiDayStartMs', () => {
  it('returns Taipei 00:00 as a UTC epoch-ms', () => {
    expect(taipeiDayStartMs('2026-06-03')).toBe(Date.parse('2026-06-02T16:00:00Z'));
  });
});
