/**
 * Front-end bootstrap: analytics, and the bot challenge on the enquiry form.
 *
 * Both are driven by /api/web-config rather than baked into the HTML, so the
 * same static pages work across environments and a key rotation needs no
 * redeploy of the markup.
 *
 * PostHog is loaded through our own origin at /ingest. A direct request to a
 * known analytics domain is the first thing a blocker drops, and this audience
 * runs blockers — so a direct integration would lose exactly the users most
 * worth measuring. The signup and enquiry events are also captured server-side,
 * where no extension can intervene; what happens here is the browsing context
 * around them.
 */
(function () {
  'use strict';

  function loadScript(src, onload) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = onload || null;
    document.head.appendChild(s);
  }

  fetch('/api/web-config', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) return;

      /* ── analytics ───────────────────────────────────────────────────── */
      if (cfg.posthogKey) {
        var host = window.location.origin + (cfg.ingestPath || '/ingest');
        !function (t, e) {
          var o, n, p, r;
          e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) {
            function g(t, e) {
              var o = e.split('.');
              2 == o.length && (t = t[o[0]], e = o[1]);
              t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); };
            }
            (p = t.createElement('script')).type = 'text/javascript';
            p.async = !0; p.src = s.api_host + '/static/array.js';
            (r = t.getElementsByTagName('script')[0]).parentNode.insertBefore(p, r);
            var u = e;
            for (void 0 !== a ? u = e[a] = [] : a = 'posthog', u.people = u.people || [],
              u.toString = function (t) {
                var e = 'posthog'; return 'posthog' !== a && (e += '.' + a), t || (e += ' (stub)'), e;
              }, u.people.toString = function () { return u.toString(1) + '.people (stub)'; },
              o = 'capture identify alias people set set_once register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag'.split(' '),
              n = 0; n < o.length; n++) g(u, o[n]);
            e._i.push([i, s, a]);
          }, e.__SV = 1);
        }(document, window.posthog || []);

        window.posthog.init(cfg.posthogKey, {
          api_host: host,
          /* Served from our origin, so the SDK must not rewrite asset URLs. */
          ui_host: 'https://eu.posthog.com',
          person_profiles: 'identified_only',
          capture_pageview: true,
          capture_pageleave: true,
          /* Never let a URL carry an address or an email into analytics. */
          sanitize_properties: function (props) {
            ['$current_url', '$referrer', '$pathname'].forEach(function (k) {
              if (typeof props[k] === 'string') {
                props[k] = props[k].replace(/0x[a-fA-F0-9]{40}/g, '0x…')
                                   .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '…@…');
              }
            });
            return props;
          },
        });
      }

      /* ── bot challenge on the enquiry form ───────────────────────────── */
      var slot = document.getElementById('e-turnstile-slot');
      if (cfg.turnstileSiteKey && slot) {
        var widget = slot.querySelector('.cf-turnstile');
        if (widget) {
          widget.setAttribute('data-sitekey', cfg.turnstileSiteKey);
          slot.hidden = false;
          loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js');
        }
      }
    })
    .catch(function () { /* analytics and challenges never break the page */ });
})();
