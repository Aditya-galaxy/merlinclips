/**
 * A campaign's hero image, derived from its brand name.
 *
 * Every clipping marketplace puts artwork on a campaign card, and a card
 * without one reads as unfinished beside cards that have it. The obvious
 * options were both wrong. Asking brands to upload an image adds a field, a
 * hosting story and a moderation problem to campaign creation — the one flow
 * that must stay short. Generating artwork with a model puts an invented
 * picture of somebody else's brand on our site, presented as theirs, and costs
 * money per campaign.
 *
 * So: a wordmark, computed from the name. Nothing is invented about the brand
 * beyond its own initials, every campaign gets a distinct and stable card, and
 * a brand that later supplies a real logo simply overrides it.
 *
 * Deterministic on purpose. The same name always produces the same colour, so
 * a brand's campaigns look like a set, the image is cacheable forever, and a
 * card does not change appearance between two page loads.
 */

/**
 * A stable 32-bit hash of the name.
 *
 * FNV-1a, because it is small and well-distributed for short strings. Not a
 * security primitive and not used as one — the only thing derived from it is a
 * hue.
 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Bumped whenever the drawing changes.
 *
 * The art is served `immutable` for a year, which is right for a URL whose
 * content is fixed and a lie for one whose content comes from a generator we
 * edit. Two fixes have already failed to reach a loaded card because of it.
 *
 * The version is part of the path, so a change here is a change to the URL and
 * every cache misses exactly once. `wordmark.test.ts` asserts the pages
 * request this number — without that, bumping the constant and bumping the
 * pages are two edits nothing checks agree, which is how v2 shipped a redrawn
 * mark that nobody saw.
 */
export const WORDMARK_VERSION = 3;

/**
 * The card art for a name.
 *
 * Hue comes from the hash; saturation and lightness are fixed and low, so
 * every mark sits in the same family as the cream ground rather than each one
 * arriving at its own idea of the palette. The result is a set that looks
 * designed rather than random, which is the whole reason not to pick colours
 * at random.
 */
export function wordmarkSvg(name: string, options: { width?: number; height?: number } = {}): string {
  // Wide by default, and the type sized to survive a crop.
  //
  // A card's art strip is far wider than it is tall, and `object-fit: cover`
  // on a 16:9 source cut the top and bottom off the initials. The source is
  // 4:1 now and the type is a quarter of the height rather than a third, so
  // the mark stays whole at the aspect ratios a card actually uses.
  const w = options.width ?? 960;
  const h = options.height ?? 240;
  const seed = hash(name.trim().toLowerCase() || 'merlin');

  // Drawn from the site's own accents rather than from an arbitrary hue.
  //
  // A free hue meant a campaign could land on any colour in the wheel —
  // "Merlin Clips" came out forest green, which belongs to no part of this
  // palette. These are the four accents styles.css already defines, each with
  // a darker partner for the gradient, so a card looks like it came from the
  // same place as the page around it while still distinguishing brands.
  const PALETTE = [
    ['#6D28D9', '#4C1D95'], // pop, the brand purple
    ['#0E8FA8', '#0B5F70'], // accent, teal
    ['#0F7B4F', '#0A5235'], // ok, green
    ['#4D7C0F', '#33520A'], // lime
  ] as const;
  const [from, to] = PALETTE[seed % PALETTE.length]!;
  const id = `g${seed.toString(36)}`;

  // Escaped because the name is brand-supplied and this is rendered as markup.
  const label = name.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  // The name itself, not its initials.
  //
  // Initials are what you draw when the canvas is square and small. This one
  // is a wide strip across the top of a card, which is a wordmark's natural
  // shape — and a clipper scanning a list reads "Merlin Clips" faster than
  // they decode "MC".
  //
  // Sized to fit rather than at a fixed size: a long name at one size either
  // overflows or forces every short name to be tiny. The divisor is the
  // longer of the name's length and a floor, so short names stop growing
  // before they become absurd.
  const shown = name.trim().slice(0, 28) || 'Campaign';
  const fontSize = Math.round(Math.min(h * 0.30, (w * 0.86) / Math.max(shown.length, 7) * 1.75));

  const esc = (v: string) => v.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#${id})"/>
  <circle cx="${w * 0.86}" cy="${h * 0.18}" r="${h * 0.46}" fill="#FAF8F5" opacity="0.07"/>
  <text x="${w * 0.5}" y="${h * 0.5}" text-anchor="middle" dominant-baseline="central"
        font-family="ui-serif, Georgia, 'Iowan Old Style', 'Times New Roman', serif"
        font-size="${fontSize}" font-weight="600" letter-spacing="${-fontSize * 0.02}"
        fill="#FAF8F5">${esc(shown)}</text>
</svg>`;
}
