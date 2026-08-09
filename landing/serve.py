#!/usr/bin/env python3
"""
Static server for local preview, with caching switched off.

`python -m http.server` sends no cache headers, so browsers cache aggressively
and happily render a stale stylesheet against fresh HTML. That looks exactly
like a broken layout — misaligned, half-restyled, "mixed up" — and it sends you
hunting for a CSS bug that is not there. Half an hour went into one of those.

No-store on everything. A preview server has no reason to cache.
"""
import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass


with socketserver.TCPServer(("", PORT), NoCache) as httpd:
    print(f"landing on http://localhost:{PORT} (no-store)")
    httpd.serve_forever()
