import { describe, expect, it } from 'bun:test';
import { MemoryBlobStore } from './persistence';
import { approveBrand, brandFor, brandKey } from './brands';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const good = { email: 'Dana@Boxabl.com', company: 'Boxabl', website: 'https://boxabl.com',
               fromEnquiry: 'enq-abc', approvedBy: 'aditya' };

describe('approving a brand', () => {
  it('creates it, keyed by the email that will sign in', async () => {
    const s = new MemoryBlobStore();
    const r = await approveBrand(s, good, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.brand.email).toBe('dana@boxabl.com');
    expect(r.brand.company).toBe('Boxabl');
    expect(r.brand.brandId).toMatch(/^brd-[0-9a-f]{8}$/);
    expect(r.brand.approvedBy).toBe('aditya');
  });

  it('is found by the address at sign-in, whatever its case', async () => {
    const s = new MemoryBlobStore();
    await approveBrand(s, good, NOW);
    for (const e of ['dana@boxabl.com', 'DANA@BOXABL.COM', ' Dana@Boxabl.com ']) {
      expect((await brandFor(s, e))?.company).toBe('Boxabl');
    }
  });

  it('keeps the enquiry it came from, so an approval can be traced', async () => {
    const s = new MemoryBlobStore();
    const r = await approveBrand(s, good, NOW);
    expect(r.ok && r.brand.fromEnquiry).toBe('enq-abc');
  });
});

// Approving twice must not quietly rewrite a brand that campaigns already
// point at — in particular it must not move an established identity onto a
// different company name.
describe('approving the same address twice', () => {
  it('returns the original rather than replacing it', async () => {
    const s = new MemoryBlobStore();
    await approveBrand(s, good, NOW);
    const second = await approveBrand(
      s, { ...good, company: 'Somebody Else Entirely' }, new Date('2026-09-01T00:00:00.000Z'),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.brand.company).toBe('Boxabl');
    expect(second.brand.approvedAt).toBe(NOW.toISOString());
  });
});

describe('what approval refuses', () => {
  it('needs an address that could actually sign in', async () => {
    const s = new MemoryBlobStore();
    for (const email of ['', 'not-an-email', 'dana@localhost', 42]) {
      const r = await approveBrand(s, { ...good, email }, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe('email');
    }
  });

  it('needs a company', async () => {
    const s = new MemoryBlobStore();
    const r = await approveBrand(s, { ...good, company: '' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('company');
  });
});

describe('an address nobody approved', () => {
  it('is not a brand', async () => {
    const s = new MemoryBlobStore();
    expect(await brandFor(s, 'stranger@example.com')).toBeUndefined();
    expect(await brandFor(s, undefined)).toBeUndefined();
  });

  it('stays not a brand when storage is unreadable', async () => {
    const broken = {
      get: async () => { throw new Error('down'); },
      put: async () => {}, list: async () => [], putIfAbsent: async () => true,
    };
    expect(await brandFor(broken, 'dana@boxabl.com')).toBeUndefined();
  });
});

describe('the key', () => {
  it('normalises so one address is one brand', () => {
    expect(brandKey(' Dana@Boxabl.com ')).toBe(brandKey('dana@boxabl.com'));
  });
});
