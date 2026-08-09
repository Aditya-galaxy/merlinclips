/**
 * The product, as a person uses it.
 *
 * Until this existed the platform was reachable only by `curl`. Every
 * invariant held, settlement worked on-chain, and a creator still had no way
 * to be paid without writing HTTP by hand. An engine that nobody can operate
 * is not a product, however correct it is.
 *
 * Deliberately one file, no framework, no build step. The whole app is
 * fetch calls against the same public API an agent would use — which is the
 * honest demonstration that the API is the product and this is a client of
 * it, not a privileged view with a private back door.
 *
 * A creator's identity is their payout address and their submission ids live
 * in localStorage. There is no account, no password, and nothing to recover,
 * because the only thing we could tie to an account is a wallet that already
 * belongs to them.
 */

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Merlin Clips — get paid for views that survived</title>
<style>
  :root{
    --bg:#FAF7F2; --card:#FFFFFF; --line:#E8E1D7; --line-2:#D6CCBE;
    --ink:#17130F; --ink-2:#6B6157; --muted:#948A7E;
    --accent:#5B2FD6; --accent-2:#7C4DFF; --accent-soft:#F0EAFF;
    --ok:#0E7A4F; --ok-soft:#E4F5ED;
    --wait:#9A5B00; --wait-soft:#FDF0DC;
    --no:#A8281E; --no-soft:#FBE9E7;
    --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  }
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
       font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1080px;margin-inline:auto;padding-inline:22px}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}

  header{border-bottom:1px solid var(--line);background:rgba(250,247,242,.9);
         backdrop-filter:blur(10px);position:sticky;top:0;z-index:10}
  header .wrap{display:flex;align-items:center;gap:14px;height:62px}
  .logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16.5px;
        letter-spacing:-.02em;color:var(--ink);margin-right:auto}
  .logo i{width:22px;height:22px;border-radius:7px;flex:none;
          background:linear-gradient(140deg,var(--accent-2),var(--accent))}
  header a.l{font-size:14px;color:var(--ink-2);font-weight:500}

  h1{font-size:clamp(32px,5.2vw,52px);line-height:1.04;letter-spacing:-.035em;
     font-weight:700;margin:0 0 14px}
  h2{font-size:21px;letter-spacing:-.02em;margin:0 0 4px;font-weight:650}
  .lede{font-size:17.5px;color:var(--ink-2);margin:0;max-width:56ch}
  .hero{padding:52px 0 30px}
  section{padding:26px 0}
  .sub{color:var(--muted);font-size:14px;margin:0 0 18px}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
  .card h3{margin:0 0 8px;font-size:16.5px;letter-spacing:-.015em;font-weight:650}
  .brief{color:var(--ink-2);font-size:14.5px;margin:0 0 16px;min-height:44px}

  .meta{display:flex;gap:22px;margin-bottom:14px}
  .meta div{display:flex;flex-direction:column}
  .meta b{font-family:var(--mono);font-size:19px;font-weight:600;letter-spacing:-.02em}
  .meta span{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}

  .bar{height:7px;border-radius:99px;background:var(--line);overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent-2),var(--accent))}
  .barcap{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:7px}

  .btn{display:inline-block;background:var(--accent);color:#fff;border:0;cursor:pointer;
       font-family:var(--sans);font-size:15px;font-weight:600;padding:12px 20px;border-radius:10px}
  .btn:hover{background:var(--accent-2)}
  .btn[disabled]{opacity:.5;cursor:not-allowed}
  .btn.small{font-size:13.5px;padding:9px 15px;border-radius:9px}
  .btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--line-2)}

  label{display:block;font-size:13px;font-weight:600;color:var(--ink-2);margin:0 0 6px}
  input,select{width:100%;font-family:var(--sans);font-size:15px;padding:12px 14px;
        border:1px solid var(--line-2);border-radius:10px;background:#fff;color:var(--ink)}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
  .field{margin-bottom:14px}
  .hint{font-size:12.5px;color:var(--muted);margin:6px 0 0}

  .pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:650;
        padding:5px 11px;border-radius:99px;letter-spacing:.01em}
  .pill.ok{background:var(--ok-soft);color:var(--ok)}
  .pill.wait{background:var(--wait-soft);color:var(--wait)}
  .pill.no{background:var(--no-soft);color:var(--no)}

  .clip{background:var(--card);border:1px solid var(--line);border-radius:14px;
        padding:16px 18px;margin-bottom:12px}
  .clip .top{display:flex;align-items:center;gap:12px;margin-bottom:8px}
  .clip .url{font-size:14px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;
             white-space:nowrap;flex:1}
  .clip .why{font-size:14px;color:var(--ink-2);margin:0}
  .nums{display:flex;gap:26px;margin-top:12px}
  .nums div{display:flex;flex-direction:column}
  .nums b{font-family:var(--mono);font-size:16px;font-weight:600}
  .nums span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}

  .empty{border:1px dashed var(--line-2);border-radius:14px;padding:30px;text-align:center;
         color:var(--muted);font-size:14.5px;background:#fff}
  .note{background:var(--accent-soft);border-radius:12px;padding:14px 16px;font-size:14px;
        color:#3A1E8C;margin-top:18px}
  footer{border-top:1px solid var(--line);margin-top:44px;padding:22px 0 50px;
         color:var(--muted);font-size:13.5px}
  .err{background:var(--no-soft);color:var(--no);border-radius:10px;padding:11px 14px;
       font-size:14px;margin-top:12px}
</style>
</head>
<body>

<header><div class="wrap">
  <span class="logo"><i></i>Merlin Clips</span>
  <a class="l" href="/console">Operator console</a>
  <a class="l" href="/openapi.json">API</a>
</div></header>

<main class="wrap">

  <div class="hero">
    <h1>Get paid for views<br />that actually stayed.</h1>
    <p class="lede">Post a clip against an open campaign. Twenty-four hours later you are paid in
      USDC for every view that survived — at the rate you were promised.</p>
  </div>

  <section>
    <h2>Open campaigns</h2>
    <p class="sub">The remaining pool is shown before you spend an evening editing.</p>
    <div class="grid" id="campaigns"></div>
  </section>

  <section>
    <h2>Submit a clip</h2>
    <p class="sub">No signup. Your wallet is your identity, because it is the thing that gets paid.</p>
    <div class="card" style="max-width:560px">
      <div class="field">
        <label for="camp">Campaign</label>
        <select id="camp"></select>
      </div>
      <div class="field">
        <label for="url">YouTube link</label>
        <input id="url" placeholder="https://www.youtube.com/watch?v=..." />
        <p class="hint">YouTube only for now. We refuse links we cannot verify rather than promise a check we cannot perform.</p>
      </div>
      <div class="field">
        <label for="addr">Your USDC wallet address</label>
        <input id="addr" placeholder="0x..." spellcheck="false" />
        <p class="hint">Paid straight here. Nothing is held by us.</p>
      </div>
      <button class="btn" id="go">Submit clip</button>
      <div id="err"></div>
    </div>
  </section>

  <section>
    <h2>Your clips</h2>
    <p class="sub">Status updates as the agent runs. Refusals say why, in words rather than codes.</p>
    <div id="clips"></div>
  </section>

</main>

<footer><div class="wrap">
  Every decision is written to an append-only record ·
  <a href="/console">operator console</a> ·
  <a href="https://github.com/Aditya-galaxy/merlinclips">source</a>
</div></footer>

<script>
var STORE = 'merlinclips.submissions';
var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
};
var mine = function () { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { return []; } };
var remember = function (id) {
  var a = mine(); if (a.indexOf(id) < 0) { a.push(id); localStorage.setItem(STORE, JSON.stringify(a)); }
};

function pillFor(s) {
  // A clip awaiting its first check and a clip that failed the brief are both
  // \`blocked\`. Showing them the same way tells a creator their work was
  // rejected when it is only queued.
  if (parseFloat(s.paidForViews || '0') > 0) return '<span class="pill ok">Paid</span>';
  if (s.settled === false) return '<span class="pill wait">In progress</span>';
  if (s.status === 'held') return '<span class="pill wait">Waiting</span>';
  if (s.status === 'blocked') return '<span class="pill no">Not paid</span>';
  if (s.status === 'auto_pay') return '<span class="pill ok">Paying</span>';
  return '<span class="pill wait">' + esc(s.status || 'pending') + '</span>';
}

async function loadCampaigns() {
  var r = await fetch('/api/campaign');
  var d = await r.json();
  var list = d.campaigns || [];
  var host = document.getElementById('campaigns');
  var sel = document.getElementById('camp');

  if (!list.length) {
    host.innerHTML = '<div class="empty">No campaigns are open right now.</div>';
    sel.innerHTML = '<option value="">No open campaigns</option>';
    return;
  }

  host.innerHTML = list.map(function (c) {
    var pool = parseFloat(c.poolUsdc || '0');
    var left = parseFloat(c.remainingUsdc != null ? c.remainingUsdc : c.poolUsdc || '0');
    var pct = pool > 0 ? Math.max(0, Math.min(100, (left / pool) * 100)) : 0;
    return '<div class="card">'
      + '<h3>' + esc(c.campaignId) + '</h3>'
      + '<p class="brief">' + esc(c.brief) + '</p>'
      + '<div class="meta">'
      +   '<div><b>' + esc(c.cpmUsdc) + '</b><span>USDC / 1k views</span></div>'
      +   '<div><b>' + esc(c.dwellHours != null ? c.dwellHours : 24) + 'h</b><span>must survive</span></div>'
      + '</div>'
      + '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>'
      + '<div class="barcap"><span>' + esc(left) + ' USDC left</span><span>of ' + esc(pool) + '</span></div>'
      + '</div>';
  }).join('');

  sel.innerHTML = list.map(function (c) {
    return '<option value="' + esc(c.campaignId) + '">' + esc(c.campaignId) + ' — ' + esc(c.cpmUsdc) + ' USDC/1k</option>';
  }).join('');
}

async function loadClips() {
  var ids = mine();
  var host = document.getElementById('clips');
  if (!ids.length) {
    host.innerHTML = '<div class="empty">Nothing submitted yet. Your clips will appear here.</div>';
    return;
  }
  var rows = await Promise.all(ids.map(async function (id) {
    try { var r = await fetch('/api/submissions/' + encodeURIComponent(id)); return await r.json(); }
    catch (e) { return { submissionId: id, status: 'unknown', reason: 'could not load' }; }
  }));

  host.innerHTML = rows.map(function (s) {
    return '<div class="clip">'
      + '<div class="top">' + pillFor(s) + '<span class="url">' + esc(s.url || s.submissionId) + '</span></div>'
      + (s.reason ? '<p class="why">' + esc(s.reason) + '</p>' : '')
      + '<div class="nums">'
      +   '<div><b>' + esc(s.confirmedViews || '0') + '</b><span>views survived</span></div>'
      +   '<div><b>' + esc(s.paidForViews || '0') + '</b><span>paid for</span></div>'
      +   '<div><b>' + esc(s.earnedUsdc || '0') + '</b><span>USDC earned</span></div>'
      + '</div></div>';
  }).join('');
}

document.getElementById('go').addEventListener('click', async function () {
  var btn = this;
  var errBox = document.getElementById('err');
  errBox.innerHTML = '';
  var body = {
    campaignId: document.getElementById('camp').value,
    url: document.getElementById('url').value.trim(),
    payoutAddress: document.getElementById('addr').value.trim()
  };
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    var r = await fetch('/api/submissions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    var d = await r.json();
    if (!r.ok) {
      errBox.innerHTML = '<div class="err">' + esc(d.error || 'Could not submit') + '</div>';
    } else {
      remember(d.submissionId);
      document.getElementById('url').value = '';
      await loadClips();
      errBox.innerHTML = '<div class="note">Accepted. Your terms are frozen at '
        + esc(d.agreedTerms && d.agreedTerms.cpmUsdc) + ' USDC per 1,000 views for '
        + esc(d.agreedTerms && d.agreedTerms.dwellHours) + 'h dwell — the brand cannot change them now.</div>';
    }
  } catch (e) {
    errBox.innerHTML = '<div class="err">Network error — try again.</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'Submit clip';
  }
});

loadCampaigns();
loadClips();
setInterval(loadClips, 20000);
</script>
</body>
</html>`;
