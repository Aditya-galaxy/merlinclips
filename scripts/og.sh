#!/usr/bin/env bash
#
# Rasterise the share card.
#
# landing/og.png is what every platform actually fetches — no crawler renders
# SVG. It was hand-produced once and then the SVG was redesigned without it,
# so for weeks the card people saw was an older composition with the headline
# flush against the top edge. A generated asset cannot drift from its source.
#
#   ./scripts/og.sh        regenerate
#   ./scripts/og.sh --check fail if the PNG is stale (for CI)
#
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert not found. brew install librsvg" >&2
  exit 1
fi

render() { rsvg-convert -w 1200 -h 630 landing/og.svg -o "$1"; }

# The favicons come from the same source for the same reason. /favicon.ico used
# to be routed at logo.svg, so anything fetching that path — Google's
# search-result icon fetcher among them — received SVG bytes and rendered
# nothing.
icons() {
  rsvg-convert -w 32  -h 32  landing/logo.svg -o landing/favicon-32.png
  rsvg-convert -w 180 -h 180 landing/logo.svg -o landing/apple-touch-icon.png
}

if [ "${1:-}" = "--check" ]; then
  tmp=$(mktemp -t og).png
  render "$tmp"
  if ! cmp -s "$tmp" landing/og.png; then
    echo "landing/og.png is stale — run ./scripts/og.sh" >&2
    rm -f "$tmp"; exit 1
  fi
  rm -f "$tmp"
  echo "og.png matches og.svg"
else
  render landing/og.png
  icons
  echo "wrote landing/og.png ($(wc -c < landing/og.png) bytes, 1200x630)"
  echo "wrote landing/favicon-32.png and landing/apple-touch-icon.png"
fi
