/**
 * Campaign card art, and the two properties it exists for.
 *
 * Deterministic, because the whole reason to derive art rather than upload it
 * is that a brand's campaigns should look like a set and a card should not
 * change appearance between page loads. And safe, because the input is a
 * brand-supplied string rendered straight into markup.
 */

import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import { WORDMARK_VERSION, wordmarkSvg } from './wordmark';

describe('the same name always draws the same mark', () => {
  test('two calls agree', () => {
    expect(wordmarkSvg('Merlin Clips')).toBe(wordmarkSvg('Merlin Clips'));
  });

  test('case and surrounding space do not change the colour', () => {
    // A brand typing "  merlin clips " must not get a different colour from
    // one typing "Merlin Clips", or their own campaigns stop matching. The
    // drawn text does differ, and should: the card shows the name as written.
    const colour = (svg: string) => /stop-color="([^"]+)"/.exec(svg)?.[1];
    expect(colour(wordmarkSvg('  merlin clips '))).toBe(colour(wordmarkSvg('Merlin Clips')));
  });

  test('colours come from the site palette, not an arbitrary hue', () => {
    // A free hue put "Merlin Clips" in forest green, which belongs to no part
    // of this palette. Four accents the stylesheet already defines.
    const PALETTE = ['#6D28D9', '#0E8FA8', '#0F7B4F', '#4D7C0F'];
    for (const name of ['Boxabl', 'Lovable', 'CapCut', 'Merlin Clips', 'Topps']) {
      const c = /stop-color="([^"]+)"/.exec(wordmarkSvg(name))?.[1] ?? '';
      expect(PALETTE).toContain(c);
    }
  });

  test('the name is drawn, not its initials', () => {
    // A clipper scanning a list reads "Merlin Clips" faster than they decode
    // "MC", and a wide strip is a wordmark's natural shape.
    expect(wordmarkSvg('Merlin Clips')).toContain('>Merlin Clips</text>');
  });

  test('a long name is scaled down rather than overflowing', () => {
    const size = (svg: string) => Number(/font-size="(\d+)"/.exec(svg)?.[1]);
    expect(size(wordmarkSvg('A Very Long Brand Name Here'))).toBeLessThan(size(wordmarkSvg('Topps')));
  });

  test('an empty name still draws something', () => {
    expect(wordmarkSvg('')).toContain('>Campaign</text>');
  });
});

describe('a brand name is untrusted input', () => {
  test('markup in the name cannot escape the label', () => {
    const svg = wordmarkSvg('<script>alert(1)</script>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('quotes cannot break out of the aria-label attribute', () => {
    const svg = wordmarkSvg('a" onload="alert(1)');
    expect(svg).not.toContain('onload="alert');
    expect(svg).toContain('&quot;');
  });
});

describe('the shape it draws', () => {
  test('it is an SVG at the size asked for', () => {
    const svg = wordmarkSvg('Merlin Clips', { width: 480, height: 270 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 480 270"');
  });

  test('the default is wide, because a card art strip is', () => {
    // 16:9 cropped by object-fit on a card cut the initials in half.
    const svg = wordmarkSvg('Merlin Clips');
    expect(svg).toContain('viewBox="0 0 960 240"');
  });

  test('gradient ids are per-name, so two marks on one page cannot collide', () => {
    // Two <defs> sharing an id means the second card renders with the first
    // card's colours — a bug that only appears once a page lists more than
    // one campaign.
    const idOf = (svg: string) => /id="(g[a-z0-9]+)"/.exec(svg)?.[1];
    expect(idOf(wordmarkSvg('Boxabl'))).not.toBe(idOf(wordmarkSvg('Lovable')));
  });
});

/**
 * The version in the path has to match the version in the code.
 *
 * The art is cached `immutable` for a year, so a change to the drawing only
 * reaches anyone if the URL changes with it. That happened twice: the type
 * size was fixed and could not reach a loaded card, and then the whole mark
 * was redrawn and still served the old one, because bumping the constant and
 * bumping the pages are two separate edits and nothing checked they agreed.
 *
 * WORDMARK_VERSION was a comment pretending to be a mechanism until this
 * asserted it.
 */
describe('the cache-busting version is real', () => {
  const pages = ['landing/campaigns.html', 'landing/index.html'];

  test('every page requests the current version', () => {
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      const used = [...html.matchAll(/\/campaign-art\/v(\d+)\//g)].map((m) => Number(m[1]));
      expect(used.length).toBeGreaterThan(0);
      for (const v of used) expect(v).toBe(WORDMARK_VERSION);
    }
  });

  test('no page requests art without a version', () => {
    // An unversioned URL still renders, so this would not fail visibly — it
    // would just never update again.
    for (const page of pages) {
      expect(readFileSync(page, 'utf8')).not.toMatch(/\/campaign-art\/(?!v\d+\/)/);
    }
  });
});
