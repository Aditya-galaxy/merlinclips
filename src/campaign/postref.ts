/**
 * Turning a URL a stranger gave us into a platform and a post id.
 *
 * Small, and worth its own file because it is the boundary where creator input
 * becomes something we act on. Every branch here is a shape a real submission
 * arrives in, and the failure mode of guessing is fetching the wrong post's
 * view count and paying against it.
 *
 * Deliberately strict: anything not recognised returns `undefined` rather than
 * a best guess. "I do not know what this link is" is a state the caller can
 * handle; a confidently wrong post id is not.
 */

import type { Platform } from './types';

export interface PostRef {
  readonly platform: Platform;
  readonly postId: string;
}

/** YouTube ids are 11 chars of URL-safe base64; X ids are numeric snowflakes. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const X_ID = /^\d{5,25}$/;
/**
 * Instagram shortcodes are URL-safe base64 and usually 11 characters, but the
 * length is not documented as fixed and longer ones exist in the wild. Bounded
 * loosely rather than pinned to 11, because rejecting a real submission is the
 * worse error here — a wrong-but-well-formed shortcode resolves to no media in
 * any account we hold a token for, and the oracle answers "could not tell".
 */
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,24}$/;

export function parsePostUrl(raw: string): PostRef | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }

  // Only https. An http link is either a downgrade or a typo, and neither is
  // something to resolve silently.
  if (url.protocol !== 'https:') return undefined;

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    const id = segments[0];
    return id && YOUTUBE_ID.test(id) ? { platform: 'youtube', postId: id } : undefined;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    // /watch?v=ID
    const query = url.searchParams.get('v');
    if (query && YOUTUBE_ID.test(query)) return { platform: 'youtube', postId: query };
    // /shorts/ID, /live/ID, /embed/ID
    if (segments.length >= 2 && ['shorts', 'live', 'embed', 'v'].includes(segments[0]!)) {
      const id = segments[1]!;
      if (YOUTUBE_ID.test(id)) return { platform: 'youtube', postId: id };
    }
    return undefined;
  }

  if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') {
    // /<handle>/status/<id>, with an optional trailing /photo/1 etc.
    const at = segments.indexOf('status');
    const id = at >= 0 ? segments[at + 1] : undefined;
    return id && X_ID.test(id) ? { platform: 'x', postId: id } : undefined;
  }

  if (host === 'instagram.com' || host === 'm.instagram.com') {
    // /reel/<code>, /p/<code>, /tv/<code>, and the handle-prefixed
    // /<handle>/reel/<code> form the app shares. Located by keyword rather
    // than by position, so both shapes resolve to the same shortcode instead
    // of the handle being read as one.
    const at = segments.findIndex((s) => s === 'reel' || s === 'reels' || s === 'p' || s === 'tv');
    const code = at >= 0 ? segments[at + 1] : undefined;
    return code && INSTAGRAM_SHORTCODE.test(code)
      ? { platform: 'instagram', postId: code }
      : undefined;
  }

  return undefined;
}

/**
 * The canonical URL for a ref, so a stored link is one we produced.
 *
 * A record rather than a ternary. The previous version returned an x.com URL
 * for anything that was not YouTube, so adding a third platform would have
 * silently rendered Instagram submissions as X links — in the creator's
 * dashboard and in the public ledger. Keyed by platform, a missing entry is a
 * type error at the point the platform is added.
 */
const CANONICAL: Record<Platform, (postId: string) => string> = {
  youtube: (id) => `https://www.youtube.com/watch?v=${id}`,
  x: (id) => `https://x.com/i/status/${id}`,
  instagram: (id) => `https://www.instagram.com/reel/${id}/`,
};

export function canonicalUrl(ref: PostRef): string {
  return CANONICAL[ref.platform](ref.postId);
}
