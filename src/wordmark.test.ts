/**
 * Campaign card art, and the two properties it exists for.
 *
 * Deterministic, because the whole reason to derive art rather than upload it
 * is that a brand's campaigns should look like a set and a card should not
 * change appearance between page loads. And safe, because the input is a
 * brand-supplied string rendered straight into markup.
 */

import { describe, expect, test } from 'bun:test';

import { initialsOf, wordmarkSvg } from './wordmark';

describe('the same name always draws the same mark', () => {
  test('two calls agree', () => {
    expect(wordmarkSvg('Merlin Clips')).toBe(wordmarkSvg('Merlin Clips'));
  });

  test('case and surrounding space do not change the art', () => {
    // A brand typing "  merlin clips " must not get a different colour from
    // one typing "Merlin Clips", or their own campaigns stop matching.
    //
    // The art, not the whole file: aria-label carries the name as written,
    // which is right — a screen reader should hear what the brand called
    // itself, not a normalised version of it.
    const art = (svg: string) => svg.replace(/aria-label="[^"]*"/, '');
    expect(art(wordmarkSvg('  merlin clips '))).toBe(art(wordmarkSvg('Merlin Clips')));
  });

  test('different names get different colours', () => {
    const hue = (svg: string) => /hsl\((\d+)/.exec(svg)?.[1];
    expect(hue(wordmarkSvg('Boxabl'))).not.toBe(hue(wordmarkSvg('Lovable')));
  });
});

describe('initials', () => {
  test('two words give one letter each', () => {
    expect(initialsOf('Merlin Clips')).toBe('MC');
  });

  test('one word gives two letters, not one enormous one', () => {
    // A single huge letter reads as a missing image rather than as a mark.
    expect(initialsOf('Lovable')).toBe('LO');
  });

  test('punctuation and handles are ignored', () => {
    expect(initialsOf('@boxabl')).toBe('BO');
    expect(initialsOf('clip-farm')).toBe('CF');
  });

  test('a name with no letters still produces something drawable', () => {
    // Never empty: an empty <text> renders as a blank rectangle, which looks
    // like the image failed to load.
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('123 456')).toBe('?');
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

  test('gradient ids are per-name, so two marks on one page cannot collide', () => {
    // Two <defs> sharing an id means the second card renders with the first
    // card's colours — a bug that only appears once a page lists more than
    // one campaign.
    const idOf = (svg: string) => /id="(g[a-z0-9]+)"/.exec(svg)?.[1];
    expect(idOf(wordmarkSvg('Boxabl'))).not.toBe(idOf(wordmarkSvg('Lovable')));
  });
});
