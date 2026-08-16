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
 * Up to two initials.
 *
 * Word initials when the name has words — "Merlin Clips" is MC. A single word
 * gives its first two letters, because one enormous letter reads as a generic
 * placeholder rather than as a mark. Non-letters are dropped so "@brand" and
 * "brand" produce the same thing.
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter((w) => /[A-Za-z]/.test(w[0]!));

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

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
  const w = options.width ?? 480;
  const h = options.height ?? 270;
  const seed = hash(name.trim().toLowerCase() || 'merlin');
  const hue = seed % 360;
  // A second hue a fixed distance away, so the wash has direction without
  // becoming a two-colour gradient that fights the type.
  const hue2 = (hue + 38) % 360;
  const initials = initialsOf(name);
  const id = `g${seed.toString(36)}`;

  // Escaped because the name is brand-supplied and this is rendered as markup.
  const label = name.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 42% 34%)"/>
      <stop offset="1" stop-color="hsl(${hue2} 46% 22%)"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#${id})"/>
  <circle cx="${w * 0.82}" cy="${h * 0.22}" r="${h * 0.42}" fill="hsl(${hue2} 60% 60%)" opacity="0.13"/>
  <text x="${w * 0.5}" y="${h * 0.5}" text-anchor="middle" dominant-baseline="central"
        font-family="ui-serif, Georgia, 'Iowan Old Style', 'Times New Roman', serif"
        font-size="${Math.round(h * 0.34)}" font-weight="600" letter-spacing="${-h * 0.012}"
        fill="#FAF8F5">${initials}</text>
</svg>`;
}
