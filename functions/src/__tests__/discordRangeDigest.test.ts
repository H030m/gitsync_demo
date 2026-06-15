import { enumerateDays } from '../flows/discordRangeDigest';

describe('enumerateDays', () => {
  it('enumerates an inclusive range, oldest first', () => {
    const { days, capped } = enumerateDays('2026-06-03', '2026-06-06');
    expect(days).toEqual(['2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06']);
    expect(capped).toBe(false);
  });

  it('handles a single-day range', () => {
    const { days } = enumerateDays('2026-06-03', '2026-06-03');
    expect(days).toEqual(['2026-06-03']);
  });

  it('crosses month boundaries correctly', () => {
    const { days } = enumerateDays('2026-05-30', '2026-06-02');
    expect(days).toEqual(['2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02']);
  });

  it('caps a long range and flags it', () => {
    const { days, capped } = enumerateDays('2026-01-01', '2026-12-31', 5);
    expect(days).toHaveLength(5);
    expect(days[0]).toBe('2026-01-01');
    expect(capped).toBe(true);
  });

  it('throws on malformed dates', () => {
    expect(() => enumerateDays('nope', '2026-06-03')).toThrow();
  });
});
