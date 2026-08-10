import { describe, expect, it } from 'bun:test';
import {
  RESERVED_FLOOR, eligible, meets, rankOf, reservedSlots,
} from './eligibility';
import type { Standing } from './standing';

const ALL: readonly Standing[] = ['unproven', 'building', 'reliable', 'exceptional'];

describe('the ordering', () => {
  it('runs weakest to strongest', () => {
    expect(ALL.map(rankOf)).toEqual([0, 1, 2, 3]);
  });

  it('meets itself and everything below it', () => {
    for (const required of ALL) {
      for (const actual of ALL) {
        expect(meets(actual, required)).toBe(rankOf(actual) >= rankOf(required));
      }
    }
  });
});

describe('sizing the reservation', () => {
  // The fraction alone rounds to zero on a small campaign, which is exactly
  // where a newcomer is most likely to be looking.
  it('never falls below the floor, however small the campaign', () => {
    for (const cap of [undefined, 0, 1, 5, 10, -4, Number.NaN]) {
      expect(reservedSlots(cap)).toBeGreaterThanOrEqual(RESERVED_FLOOR);
    }
  });

  it('scales with a larger campaign', () => {
    expect(reservedSlots(100)).toBe(20);
    expect(reservedSlots(500)).toBe(100);
  });

  it('lets a brand set the number themselves, including zero', () => {
    expect(reservedSlots(100, 7)).toBe(7);
    expect(reservedSlots(100, 0)).toBe(0);
  });

  it('ignores a nonsense override rather than trusting it', () => {
    expect(reservedSlots(100, -1)).toBe(20);
    expect(reservedSlots(100, Number.NaN)).toBe(20);
  });
});

describe('a campaign with no floor', () => {
  it('admits anyone, and does not spend a reserved slot doing it', () => {
    for (const standing of ALL) {
      const r = eligible({ standing, acceptedBelowFloor: 999 });
      expect(r.admitted).toBe(true);
      expect(r.admitted && r.viaReservedSlot).toBe(false);
    }
  });

  it("treats a floor of 'unproven' as no floor at all", () => {
    const r = eligible({ minStanding: 'unproven', standing: 'unproven', acceptedBelowFloor: 999 });
    expect(r.admitted).toBe(true);
  });
});

describe('a campaign asking for reliable', () => {
  const base = { minStanding: 'reliable' as Standing, expectedSubmissions: 100 };

  it('admits a creator who meets it on their own record', () => {
    for (const standing of ['reliable', 'exceptional'] as Standing[]) {
      const r = eligible({ ...base, standing, acceptedBelowFloor: 999 });
      expect(r.admitted).toBe(true);
      expect(r.admitted && r.viaReservedSlot).toBe(false);
    }
  });

  // Ship the filter without this and you have a marketplace nobody can enter.
  it('admits a creator below the floor while reserved slots remain', () => {
    const r = eligible({ ...base, standing: 'unproven', acceptedBelowFloor: 0 });
    expect(r.admitted).toBe(true);
    expect(r.admitted && r.viaReservedSlot).toBe(true);
  });

  it('admits right up to the last reserved slot', () => {
    const r = eligible({ ...base, standing: 'unproven', acceptedBelowFloor: 19 });
    expect(r.admitted).toBe(true);
  });

  it('refuses once they are taken', () => {
    const r = eligible({ ...base, standing: 'unproven', acceptedBelowFloor: 20 });
    expect(r.admitted).toBe(false);
  });

  it('refuses a creator who is closer but still short', () => {
    const r = eligible({ ...base, standing: 'building', acceptedBelowFloor: 20 });
    expect(r.admitted).toBe(false);
  });
});

describe('what a refusal says', () => {
  it('names the floor, the number of places, and how to earn standing', () => {
    const r = eligible({
      minStanding: 'reliable', expectedSubmissions: 100,
      standing: 'unproven', acceptedBelowFloor: 20,
    });
    expect(r.admitted).toBe(false);
    if (r.admitted) return;
    expect(r.reason).toContain('reliable');
    expect(r.reason).toContain('20');
    expect(r.reason).toContain('three counted');
    expect(r.slotsWere).toBe(20);
  });

  it('tells a creator admitted on a reserved slot that that is what happened', () => {
    const r = eligible({
      minStanding: 'exceptional', expectedSubmissions: 50,
      standing: 'unproven', acceptedBelowFloor: 0,
    });
    expect(r.admitted && r.reason).toContain('have not');
  });
});

describe('a brand that turns the reservation off', () => {
  // Allowed, and it is their campaign. The default protects the newcomer; an
  // explicit zero is a choice somebody made rather than one we made for them.
  it('refuses everyone below the floor', () => {
    const r = eligible({
      minStanding: 'reliable', reservedForUnproven: 0,
      standing: 'unproven', acceptedBelowFloor: 0,
    });
    expect(r.admitted).toBe(false);
  });
});
