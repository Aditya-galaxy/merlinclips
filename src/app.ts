/**
 * The product, as a person uses it.
 *
 * Shaped as a statement rather than a marketing page, because that is what it
 * is: a record of what you posted, what survived, and what you were paid. The
 * numbers are set in monospace at display size and everything else gets out of
 * their way — on a payout ledger the figures are the argument, so they are the
 * typography rather than an afterthought inside it.
 *
 * A wait and a refusal never look alike. The gate returns `blocked` for a clip
 * awaiting its first check and for one that failed the brief; rendering those
 * the same way would tell a creator their work was rejected when it is merely
 * queued, which is the single most damaging thing this interface could get
 * wrong.
 *
 * No framework, no build step, no external request — not minimalism for its
 * own sake, but because every call this page makes is one an agent could make
 * against the same public API. The interface is a client of the product, not a
 * privileged view into it.
 */

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Merlin Clips — paid for views that survived</title>
<meta name="description" content="Post a clip. Twenty-four hours later you are paid in USDC for every view that survived, at the rate you were promised." />
<style>
/* These are the landing page's tokens, not a second palette. The app is one
   click from the site, and the cool grey the app used to sit on made that
   click look like a handoff to somebody else's product. */
:root{
  --paper:#FAF8F5; --card:#FFFFFF; --sunk:#F3F0EB;
  --line:#E8E3DB; --line-2:#D8D1C6;
  --ink:#151310; --ink-2:#5C554C; --ink-3:#8B8378;
  --violet:#6D28D9; --violet-2:#7C3AED; --violet-wash:#F3EEFE;
  --settled:#0F7B4F; --settled-wash:#E7F4EE;
  --waiting:#8A5A00; --waiting-wash:#FBF1DF;
  --refused:#B02A20; --refused-wash:#FBECEA;
  --ui:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --num:ui-monospace,"SF Mono",SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--ui);
     font-size:15.5px;line-height:1.5;font-weight:450;-webkit-font-smoothing:antialiased;
     font-variant-numeric:tabular-nums}
.wrap{max-width:1120px;margin-inline:auto;padding-inline:28px}
a{color:var(--violet);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--violet);outline-offset:2px;border-radius:4px}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* ── masthead ── */
.bar{border-bottom:1px solid var(--line);background:rgba(250,248,245,.88);
     backdrop-filter:blur(12px);position:sticky;top:0;z-index:20}
.bar .wrap{display:flex;align-items:center;gap:26px;height:60px}
/* Google's button, close enough to the one people recognise that it reads as
   the real thing, on our surface rather than theirs. */
.gbtn{display:inline-flex;align-items:center;gap:9px;font-size:14px;font-weight:600;
      padding:8px 15px;border-radius:99px;border:1px solid var(--line-2);
      background:var(--card);color:var(--ink);white-space:nowrap;text-decoration:none}
.gbtn:hover{border-color:var(--ink-3);text-decoration:none}
/* ── the dashboard ──
   Four tiles, because four numbers are what a creator opens this page to see:
   what they earned, what it was earned on, how much is in flight, and whether
   they are trusted yet. Everything else is detail below. */
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0 16px}
@media(max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}}
@media(max-width:520px){.tiles{grid-template-columns:1fr}}
.tile{border:1px solid var(--line);border-radius:16px;background:var(--card);
      padding:18px 20px;display:flex;flex-direction:column;gap:5px}
.tlabel{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);
        font-weight:600}
.tnum{font-family:var(--num);font-size:29px;font-weight:600;letter-spacing:-.03em;
      color:var(--ink);line-height:1.05;font-variant-numeric:tabular-nums}
.tsub{font-size:13px;color:var(--ink-3)}
.tile.standing .tnum{text-transform:capitalize}
.tile.standing[data-level="reliable"] .tnum{color:var(--settled)}
.tile.standing[data-level="exceptional"] .tnum{color:var(--settled)}
.tile.standing[data-level="unproven"] .tnum{color:var(--ink-2)}
/* The bar is the survival rate itself, not a progress-to-next-level guess.
   Inventing a distance to the next tier would be inventing a number. */
.meter{height:5px;border-radius:99px;background:var(--sunk);overflow:hidden;margin-top:8px}
.meter i{display:block;height:100%;background:var(--settled);border-radius:99px}
#dwallets{font-family:var(--num);font-size:12.5px;color:var(--ink-3);
          overflow-wrap:anywhere}
.signin-note{margin:0 0 20px;padding:13px 16px;border-radius:11px;
             border:1px solid var(--line-2);background:var(--refused-wash);
             color:var(--refused);font-size:14.5px}
.who{font-size:14px;color:var(--ink-2);white-space:nowrap;overflow:hidden;
     text-overflow:ellipsis;max-width:26ch}
@media(max-width:640px){
  .bar .wrap{gap:14px}
  .bar .nav{display:none}
  .gbtn{font-size:13px;padding:7px 12px}
  .who{max-width:14ch}
}
.mark{display:flex;align-items:center;gap:9px;font-weight:600;font-size:15.5px;
      letter-spacing:-.02em;color:var(--ink);margin-right:auto}
.mark i{width:20px;height:20px;border-radius:6px;flex:none;background:var(--violet);
        position:relative}
.mark i::after{content:"";position:absolute;inset:6px 6px auto auto;width:5px;height:5px;
        border-radius:50%;background:#fff}
.bar a.nav{font-size:14px;color:var(--ink-2);font-weight:480}
.bar a.nav:hover{color:var(--ink);text-decoration:none}

/* ── statement head ── */
.head{padding:64px 0 40px;border-bottom:1px solid var(--line)}
.eyebrow{font-family:var(--num);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;
         color:var(--ink-3);margin:0 0 20px}
h1{font-size:clamp(34px,4.4vw,50px);line-height:1.06;letter-spacing:-.028em;font-weight:500;
   margin:0 0 18px;max-width:16ch;text-wrap:balance}
.stand{font-size:17.5px;color:var(--ink-2);margin:0;max-width:58ch;line-height:1.5}
.terms{display:flex;gap:0;margin-top:34px;border:1px solid var(--line);border-radius:10px;
       background:var(--card);overflow:hidden;max-width:640px}
.terms div{padding:14px 20px;flex:1;border-right:1px solid var(--line)}
.terms div:last-child{border-right:0}
.terms b{display:block;font-family:var(--num);font-size:19px;font-weight:500;letter-spacing:-.02em}
.terms span{font-size:11.5px;color:var(--ink-3);letter-spacing:.04em;text-transform:uppercase}

/* ── sections ── */
section{padding:44px 0}
.shead{display:flex;align-items:baseline;gap:14px;margin-bottom:6px}
h2{font-size:19px;font-weight:550;letter-spacing:-.018em;margin:0}
.count{font-family:var(--num);font-size:12.5px;color:var(--ink-3)}
.note{font-size:14.5px;color:var(--ink-2);margin:0 0 22px;max-width:62ch}

/* ── offers (campaigns) ── */
/* Campaign cards, framed the way this market already reads them: what kind of
   work it is, how old, whose brand, how much of the budget is gone, the rate,
   and who else is here. A creator scans six of these and picks one. */
.offers{display:grid;grid-template-columns:repeat(auto-fill,minmax(324px,1fr));gap:16px}
.offer{background:var(--card);border:1px solid var(--line);border-radius:14px;
       padding:18px 20px 16px;display:flex;flex-direction:column;gap:0}
.offer .tags{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.chip{font-size:11px;font-weight:600;letter-spacing:.02em;padding:3px 9px;border-radius:6px;
      background:var(--violet-wash);color:#4A22B8}
.chip.plain{background:var(--sunk);color:var(--ink-2)}
.chip.funded{background:var(--settled-wash);color:var(--settled)}
.chip.partial{background:var(--waiting-wash);color:var(--waiting)}
.chip.unbacked{background:var(--refused-wash);color:var(--refused)}
.offer .fundnote{font-size:12px;color:var(--ink-2);margin:10px 0 0;line-height:1.4}
.offer .age{margin-left:auto;font-size:11.5px;color:var(--ink-3)}
.offer .title{font-size:15.5px;font-weight:550;letter-spacing:-.012em;margin:0 0 3px;
      line-height:1.32;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
      overflow:hidden}
.offer .by{font-family:var(--num);font-size:11.5px;color:var(--ink-3);margin-bottom:14px}
.offer .money{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px}
.offer .spent{font-family:var(--num);font-size:15px;font-weight:500}
.offer .spent em{font-style:normal;color:var(--ink-3);font-weight:400}
.offer .cpm{font-family:var(--num);font-size:13px;color:var(--ink-2)}
.track{height:5px;border-radius:99px;background:var(--sunk);overflow:hidden}
.fill{display:block;height:100%;background:var(--violet);border-radius:99px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px;
       padding-top:14px;border-top:1px solid var(--line)}
.stats div span{display:block;font-size:10.5px;color:var(--ink-3);text-transform:uppercase;
       letter-spacing:.06em;margin-bottom:2px}
.stats div b{font-family:var(--num);font-size:14.5px;font-weight:500}

/* ── form ── */
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:560px}
label{display:block;font-size:12.5px;font-weight:550;color:var(--ink-2);margin:0 0 7px;
      letter-spacing:.01em}
input,select{width:100%;font-family:var(--ui);font-size:15px;font-weight:450;padding:11px 13px;
      border:1px solid var(--line-2);border-radius:9px;background:var(--card);color:var(--ink)}
input::placeholder{color:var(--ink-3)}
input:focus,select:focus{outline:2px solid var(--violet);outline-offset:-1px;border-color:transparent}
.f{margin-bottom:16px}
.hint{font-size:12.5px;color:var(--ink-3);margin:7px 0 0;line-height:1.45}
button.go{font-family:var(--ui);font-size:15px;font-weight:550;padding:12px 22px;border:0;
      border-radius:9px;background:var(--violet);color:#fff;cursor:pointer}
button.go:hover{background:var(--violet-2)}
button.go[disabled]{opacity:.45;cursor:not-allowed}
.said{margin-top:14px;font-size:14px;border-radius:9px;padding:12px 14px;line-height:1.45}
.said.ok{background:var(--violet-wash);color:#3A1B9E}
.said.bad{background:var(--refused-wash);color:var(--refused)}

/* ── statement lines (your clips) ── */
.lines{border-top:1px solid var(--line)}
.line{display:grid;grid-template-columns:3px 1fr auto;gap:18px;align-items:center;
      padding:18px 0 18px 0;border-bottom:1px solid var(--line)}
.stripe{align-self:stretch;border-radius:99px;background:var(--line-2)}
.line.is-settled .stripe{background:var(--settled)}
.line.is-waiting .stripe{background:var(--waiting)}
.line.is-refused .stripe{background:var(--refused)}
.line .what{min-width:0}
.line .ref{font-family:var(--num);font-size:12px;color:var(--ink-3);margin-bottom:5px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line .why{font-size:14.5px;color:var(--ink-2);margin:0;max-width:56ch}
.tag{display:inline-block;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:5px;
     letter-spacing:.02em;margin-bottom:6px}
.tag.settled{background:var(--settled-wash);color:var(--settled)}
.tag.waiting{background:var(--waiting-wash);color:var(--waiting)}
.tag.refused{background:var(--refused-wash);color:var(--refused)}
.ledger{display:flex;gap:28px;text-align:right}
.ledger div b{display:block;font-family:var(--num);font-size:16px;font-weight:500}
.ledger div span{font-size:10.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.ledger .paid b{color:var(--settled)}

.blank{border:1px dashed var(--line-2);border-radius:11px;padding:34px;text-align:center;
       color:var(--ink-3);font-size:14.5px;background:var(--card)}
footer{border-top:1px solid var(--line);margin-top:36px;padding:26px 0 60px;
       color:var(--ink-3);font-size:13px}
@media(max-width:760px){
  .offer{grid-template-columns:1fr;gap:14px}
  .offer .facts{justify-content:space-between}
  .pool{width:auto;flex:1}
  .line{grid-template-columns:3px 1fr;gap:14px}
  .ledger{grid-column:2;justify-content:flex-start;text-align:left;margin-top:10px}
  .terms{flex-wrap:wrap}
}

/* ── dashboard shell ──
   A violet rail, because the one thing a creator does here repeatedly is move
   between their own records — and a top bar with seven links is a top bar
   nobody reads twice. The rail collapses to a scrolling strip on a phone
   rather than a hamburger: seven destinations is few enough to show. */
.shell{display:grid;grid-template-columns:236px 1fr;min-height:100vh}
.rail{background:linear-gradient(180deg,#5B21B6,#4C1D95);color:#EDE9FE;
      display:flex;flex-direction:column;padding:22px 16px;position:sticky;top:0;
      height:100vh;overflow-y:auto}
.rmark{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;
       letter-spacing:-.02em;color:#fff;text-decoration:none;padding:0 8px 22px}
.rmark i{width:19px;height:19px;border-radius:6px;background:#fff;flex:none;position:relative}
.rmark i::after{content:"";position:absolute;inset:6px 6px auto auto;width:5px;height:5px;
                border-radius:50%;background:#5B21B6}
.rnav{display:flex;flex-direction:column;gap:2px}
.rl{display:block;padding:9px 12px;border-radius:9px;color:#DDD6FE;text-decoration:none;
    font-size:14.5px;font-weight:500;white-space:nowrap}
.rl:hover{background:rgba(255,255,255,.1);color:#fff;text-decoration:none}
.rl[aria-current="true"]{background:rgba(255,255,255,.16);color:#fff;font-weight:650}
.rl b{font-weight:inherit}
.rfoot{margin-top:auto;padding-top:18px;display:flex;flex-direction:column;gap:2px}
.rl.quiet{font-size:13px;color:#C4B5FD;opacity:.85}
.rwho{padding:8px 12px;font-size:13px;color:#DDD6FE;overflow:hidden;text-overflow:ellipsis}
.rfoot .gbtn{margin:4px 0 8px;justify-content:center}
.pane{min-width:0;background:var(--paper)}
.pane .wrap{padding-block:26px 60px}

@media(max-width:820px){
  .shell{grid-template-columns:1fr}
  .rail{position:static;height:auto;padding:14px 12px;
        flex-direction:row;align-items:center;gap:10px;overflow-x:auto}
  .rmark{padding:0 10px 0 4px}
  .rnav{flex-direction:row;gap:4px}
  .rfoot{margin-top:0;margin-left:auto;padding-top:0;flex-direction:row;align-items:center}
  .rwho{display:none}
}

/* ── entity rows ──
   Label on the left, value on the right, one fact per line. A table would
   imply the fields are comparable across rows; they are not. */
.rows{display:flex;flex-direction:column;gap:12px;margin-top:18px}
.erow{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:16px 18px}
.erow h4{margin:0 0 10px;font-size:15px;font-weight:650;letter-spacing:-.01em}
.erow dl{display:grid;grid-template-columns:auto 1fr;gap:7px 18px;margin:0}
.erow dt{font-size:12.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em;
         font-weight:600}
.erow dd{margin:0;font-size:14.5px;color:var(--ink);font-family:var(--num);
         overflow-wrap:anywhere}
.erow dd.words{font-family:var(--ui)}
.erow .empty{font-size:14.5px;color:var(--ink-3)}
@media(max-width:520px){.erow dl{grid-template-columns:1fr;gap:2px 0}
                        .erow dd{margin-bottom:8px}}

/* ── the signed-in person, in the rail ── */
.rprofile{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:8px;
          border-radius:10px;background:rgba(255,255,255,.1);min-width:0}
.ravatar{border-radius:50%;flex:none;display:block}
.rinitial{width:30px;height:30px;border-radius:50%;flex:none;display:grid;place-items:center;
          background:#fff;color:#5B21B6;font-weight:700;font-size:14px}
.rid{display:flex;flex-direction:column;min-width:0;line-height:1.25}
.rid b{font-size:13.5px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;
       white-space:nowrap}
.rid em{font-style:normal;font-size:11.5px;color:#C4B5FD;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap}
@media(max-width:820px){.rid{display:none}.rprofile{padding:6px;margin:0}}

/* ── dashboard cards ──
   The main area was a marketing page with a form in it: a headline, a
   paragraph of persuasion, then the tool. Somebody signed in has already been
   persuaded. Cards, headed by what they are, holding the thing itself. */
.card{border:1px solid var(--line);border-radius:16px;background:var(--card);
      padding:20px 22px;margin-bottom:16px}
.card > h3{margin:0 0 4px;font-size:16px;font-weight:650;letter-spacing:-.015em}
.card > .sub{margin:0 0 16px;font-size:13.5px;color:var(--ink-3)}
.cardgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
@media(max-width:1040px){.cardgrid{grid-template-columns:1fr}}
.dhead{display:flex;align-items:baseline;justify-content:space-between;gap:16px;
       margin:0 0 20px;flex-wrap:wrap}
.dhead h1{margin:0;font-size:26px;font-weight:680;letter-spacing:-.03em}
.dhead .when{font-size:13px;color:var(--ink-3);font-family:var(--num)}

/* ── onboarding banner & filter chips ── */
.onboarding-banner{background:linear-gradient(135deg,rgba(109,40,217,.06),rgba(124,58,237,.02));
  border:1px solid var(--line-2);border-radius:16px;padding:20px 24px;margin-bottom:22px}
.onboarding-header{display:flex;align-items:center;justify-space-between;margin-bottom:16px}
.onboarding-header h3{margin:0;font-size:17px;font-weight:650;letter-spacing:-.015em;color:var(--ink)}
.onboarding-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:768px){.onboarding-steps{grid-template-columns:1fr}}
.onboarding-step-card{background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:14px 16px;display:flex;gap:12px;align-items:flex-start}
.onboarding-step-num{width:26px;height:26px;border-radius:50%;background:var(--violet-wash);
  color:var(--violet);font-weight:700;font-size:13px;display:grid;place-items:center;flex:none}
.onboarding-step-text h4{margin:0 0 3px;font-size:13.5px;font-weight:650;color:var(--ink)}
.onboarding-step-text p{margin:0;font-size:12.5px;color:var(--ink-2);line-height:1.4}

.search-filter-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;
  margin-bottom:16px;flex-wrap:wrap}
.search-input-wrap{flex:1;min-width:220px}
.search-input-wrap input{font-size:13.5px;padding:8px 12px;border-radius:8px}
.filter-chips{display:flex;gap:6px}
.filter-chip{font-family:var(--ui);font-size:12.5px;font-weight:550;padding:6px 13px;
  border-radius:99px;border:1px solid var(--line-2);background:var(--card);color:var(--ink-2);
  cursor:pointer;transition:all .15s ease}
.filter-chip:hover{border-color:var(--ink-3);color:var(--ink)}
.filter-chip.active{background:var(--violet);color:#fff;border-color:var(--violet)}

.verification-code-box{display:flex;align-items:center;justify-content:space-between;
  background:var(--violet-wash);border:1px dashed var(--violet);border-radius:10px;
  padding:12px 16px;margin:14px 0}
.verification-code-box code{font-family:var(--num);font-size:16px;font-weight:700;
  color:var(--violet);letter-spacing:.05em}

.tile{transition:transform .15s ease,box-shadow .15s ease}
.tile:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.04)}
.offer{transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease}
.offer:hover{transform:translateY(-2px);border-color:var(--line-2);box-shadow:0 6px 16px rgba(0,0,0,.05)}
</style>
</head>
<body>

<div class="shell">

<aside class="rail">
  <a class="rmark" href="/"><img src="/logo.svg" alt="Merlin Clips" width="22" height="22" style="border-radius:6px;display:block;" />Merlin Clips</a>

  <nav class="rnav" aria-label="Your account">
    <a class="rl" href="#overview" data-sec="overview"><b>Overview</b></a>
    <a class="rl" href="#campaigns" data-sec="campaigns">Campaigns</a>
    <a class="rl" href="#submit" data-sec="submit">Submit a clip</a>
    <a class="rl" href="#submissions" data-sec="submissions">Submissions</a>
    <a class="rl" href="#payouts" data-sec="payouts">Payouts</a>
    <a class="rl" href="#wallets" data-sec="wallets">Wallets</a>
    <a class="rl" href="#standing" data-sec="standing">Standing</a>
  </nav>

  <div class="rfoot">
    <!-- A profile, not a sign-in button. /app is gated, so anyone reading this
         is already signed in — a "Continue with Google" button here could only
         ever be dead chrome asking a signed-in person to sign in. -->
    <div class="rprofile" id="rprofile" hidden>
      <img class="ravatar" id="ravatar" alt="" width="30" height="30" referrerpolicy="no-referrer" hidden />
      <span class="rinitial" id="rinitial" aria-hidden="true"></span>
      <span class="rid">
        <b id="rname">—</b>
        <em id="remail"></em>
      </span>
    </div>
    <a class="rl quiet" href="/api.html">API reference</a>
    <a class="rl quiet" href="/auth/logout">Sign out</a>
  </div>
</aside>

<div class="pane">

<main class="wrap">

  <div class="dhead">
    <div>
      <h1 id="dtitle">Creator Earnings &amp; Performance Hub</h1>
      <p style="margin:4px 0 0;font-size:14.5px;color:var(--ink-2);">Real-time view survival tracking, locked CPM rates, and automated USDC payouts on Base.</p>
    </div>
    <span class="when" id="dwhen" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:99px;background:var(--settled-wash);color:var(--settled);font-weight:600;font-size:12.5px;">
      <span style="width:7px;height:7px;border-radius:50%;background:var(--settled);display:inline-block;"></span>
      Base Mainnet Settlement Active
    </span>
  </div>

  <!-- Only for a signed-in creator, and hidden until the profile answers. -->
  <section id="overview" hidden style="padding-top:10px;">
    <div class="tiles" style="grid-template-columns:repeat(4,1fr);">
      <div class="tile">
        <span class="tlabel">Total Earned</span>
        <b class="tnum" id="t-earned" style="color:var(--settled);">—</b>
        <span class="tsub">settled directly to your EVM wallet</span>
      </div>
      <div class="tile">
        <span class="tlabel">Awaiting 24h Hold</span>
        <b class="tnum" id="t-holding" style="color:var(--waiting);">—</b>
        <span class="tsub"><span id="t-holding-views">0</span> views in survival countdown</span>
      </div>
      <div class="tile">
        <span class="tlabel">Surviving Views</span>
        <b class="tnum" id="t-views">—</b>
        <span class="tsub">views present across 24h hold</span>
      </div>
      <div class="tile standing" id="t-standing-card">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="tlabel">Standing Level</span>
          <span id="t-next-level" style="font-size:11px;font-weight:600;color:var(--violet);background:var(--violet-wash);padding:2px 7px;border-radius:99px;">—</span>
        </div>
        <b class="tnum" id="t-standing" style="text-transform:capitalize;">—</b>
        <span class="tsub" id="t-standing-says">&nbsp;</span>
        <div class="meter" id="t-meter" hidden><i id="t-meter-fill"></i></div>
      </div>
    </div>

    <p class="note" id="dwallets" style="margin-top:12px;padding:10px 14px;background:var(--card);border:1px solid var(--line);border-radius:10px;"></p>
  </section>

  <!-- Creator Onboarding Guide -->
  <div class="onboarding-banner" id="c-onboarding">
    <div class="onboarding-header">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">⚡</span>
        <h3>How Creator Rewards Pay You on Merlin Clips</h3>
      </div>
      <button type="button" class="gbtn" onclick="document.getElementById('c-onboarding').hidden=true" style="font-size:12px;padding:4px 10px;">Dismiss</button>
    </div>
    <div class="onboarding-steps">
      <div class="onboarding-step-card">
        <span class="onboarding-step-num">1</span>
        <div class="onboarding-step-text">
          <h4>Select Brief &amp; Add Verification Code</h4>
          <p>Pick an active campaign brief below. Copy your unique <code>MC-XXXXXX</code> code into your clip description.</p>
        </div>
      </div>
      <div class="onboarding-step-card">
        <span class="onboarding-step-num">2</span>
        <div class="onboarding-step-text">
          <h4>CPM Rate Locks Instantly</h4>
          <p>Your CPM rate ($/1k views) and 24h survival hold lock the moment your clip link is submitted.</p>
        </div>
      </div>
      <div class="onboarding-step-card">
        <span class="onboarding-step-num">3</span>
        <div class="onboarding-step-text">
          <h4>Automated On-Chain USDC Payouts</h4>
          <p>Views that survive 24 hours are paid directly to your EVM wallet in USDC on Base. Never held on platform.</p>
        </div>
      </div>
    </div>
  </div>

  <div class="cardgrid">
    <section id="campaigns">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div>
            <h3>Active Campaign Briefs</h3>
            <p class="sub" style="margin-bottom:0;">Published campaign budgets &amp; CPM rates. <span class="count" id="ccount"></span></p>
          </div>
        </div>
        
        <div class="search-filter-bar">
          <div class="search-input-wrap">
            <input id="csearch" placeholder="Search campaign briefs, topics, or IDs..." spellcheck="false" />
          </div>
          <div class="filter-chips" id="pfilter">
            <button class="filter-chip active" data-plat="all">All Platforms</button>
            <button class="filter-chip" data-plat="youtube">YouTube</button>
            <button class="filter-chip" data-plat="x">X / Shorts</button>
          </div>
        </div>

        <div class="offers" id="campaigns-list"></div>
      </div>
    </section>

    <section id="submit">
      <div class="card">
        <h3>Submit a Clip</h3>
        <p class="sub">Your CPM rate and 24h hold lock the moment your link is accepted.</p>
        <div class="f">
          <label for="camp">Campaign Brief</label>
          <select id="camp"></select>
        </div>
        <div class="f">
          <label for="url">Link to Your Video Clip</label>
          <input id="url" placeholder="https://www.youtube.com/watch?v=…" spellcheck="false" />
          <p class="hint">YouTube videos &amp; Shorts — links are verified automatically against the brief.</p>
        </div>

        <div class="verification-code-box">
          <div>
            <span style="font-size:12px;color:var(--muted);display:block;font-weight:600;">Your Creator Verification Token:</span>
            <span style="font-size:11.5px;color:var(--ink-2);display:block;margin-bottom:4px;">Paste this code in your video description to prove ownership:</span>
            <code id="ver-code-val">MC-8F92A1</code>
          </div>
          <button type="button" class="gbtn" id="copy-ver-code" style="font-size:12px;padding:6px 12px;background:var(--violet);color:#fff;border-color:var(--violet);">Copy Code</button>
        </div>

        <div class="f" style="margin-top:14px;">
          <label for="addr">Base Payout Wallet Address (USDC)</label>
          <input id="addr" placeholder="0x…" spellcheck="false" />
          <p class="hint">Earnings settle directly here. We Never hold your money.</p>
        </div>
        <button class="go" id="go" style="width:100%;text-align:center;padding:13px 20px;font-size:15px;border-radius:99px;">Submit Clip &amp; Lock Rate</button>
        <div id="said"></div>
      </div>

      <!-- Brand Studio: Deploy New Campaign (Operator Gated) -->
      <div class="card" style="border:1px solid var(--violet);background:linear-gradient(180deg,var(--violet-wash),var(--card));margin-top:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:var(--ink);">🏢 Brand Studio — Deploy New Campaign</h3>
            <p class="sub" style="margin:2px 0 0;">Create an autonomous creator campaign with Gemini brief validation &amp; Base USDC settlement.</p>
          </div>
          <span class="chip funded" style="font-size:11.5px;padding:4px 10px;">Operator Gated</span>
        </div>

        <form id="deploy-campaign-form">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div class="f">
              <label for="c-title">Campaign Brief Title <span style="color:var(--refused);">*</span></label>
              <input id="c-title" placeholder="e.g. Clip the factory tour, fold-out in first 5s" required maxlength="120" />
            </div>
            <div class="f">
              <label for="c-brand">Brand Identifier <span style="color:var(--refused);">*</span></label>
              <input id="c-brand" placeholder="e.g. boxabl-official or lovable-clipping" required maxlength="60" />
            </div>
          </div>

          <div class="f">
            <label for="c-rules">Video Brief Guidelines (Judged by Gemini AI) <span style="color:var(--refused);">*</span></label>
            <textarea id="c-rules" rows="3" style="width:100%;font-family:var(--ui);font-size:14px;padding:10px 12px;border:1px solid var(--line-2);border-radius:99px;border-radius:9px;background:var(--card);" placeholder="State clear criteria for Gemini AI to verify. e.g. Show app building a real project for at least 5s, sound on." required minlength="10"></textarea>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:12px;">
            <div class="f">
              <label for="c-pool">Total Pool (USDC) <span style="color:var(--refused);">*</span></label>
              <input id="c-pool" type="number" step="10" min="100" value="1000" required />
            </div>
            <div class="f">
              <label for="c-cpm">CPM Rate ($/1k views) <span style="color:var(--refused);">*</span></label>
              <input id="c-cpm" type="number" step="0.10" min="0.10" value="1.00" required />
            </div>
            <div class="f">
              <label for="c-cap">Per-Creator Cap (USDC) <span style="color:var(--refused);">*</span></label>
              <input id="c-cap" type="number" step="10" min="10" value="250" required />
            </div>
            <div class="f">
              <label for="c-dwell">Dwell Hold <span style="color:var(--refused);">*</span></label>
              <select id="c-dwell">
                <option value="24">24 Hours (Standard)</option>
                <option value="48">48 Hours (High Security)</option>
              </select>
            </div>
            <div class="f">
              <label for="c-standing">Standing Floor</label>
              <select id="c-standing">
                <option value="unproven">Open to All</option>
                <option value="building">Building (≥ 3 clips)</option>
                <option value="reliable">Reliable (≥ 70% rate)</option>
                <option value="exceptional">Exceptional (≥ 90% rate)</option>
              </select>
            </div>
          </div>

          <div class="f" style="margin-top:4px;">
            <label for="c-secret">Operator Secret Key <span style="color:var(--refused);">*</span></label>
            <input id="c-secret" type="password" placeholder="Enter Operator Secret to authorize &amp; fund" required />
            <p class="hint">Ensures money is only committed by authorized brand owners &amp; platform operators.</p>
          </div>

          <button type="submit" class="go" id="btn-deploy-campaign" style="width:100%;text-align:center;padding:13px 20px;font-size:15px;border-radius:99px;margin-top:10px;">🚀 Deploy &amp; Fund Campaign on Base</button>
          <div id="c-deploy-status" style="margin-top:12px;"></div>
        </form>
      </div>
    </section>
  </div>

  <section id="submissions">
    <div class="shead"><h2>Your Submissions &amp; Earnings</h2><span class="count" id="lcount"></span></div>
    <p class="note">Your balance updates automatically as the view oracle runs. When a submission is not paid, the reason states why in plain words.</p>

    <div class="search-filter-bar" style="margin-bottom:14px;">
      <div class="filter-chips" id="subfilter">
        <button class="filter-chip active" data-state="all">All Submissions</button>
        <button class="filter-chip" data-state="settled">Paid (USDC)</button>
        <button class="filter-chip" data-state="waiting">24h Hold Countdown</button>
        <button class="filter-chip" data-state="refused">Not Paid</button>
      </div>
    </div>

    <div class="lines" id="clips"></div>
  </section>

  <section id="payouts" hidden>
    <div class="shead"><h2>On-Chain Payout Ledger</h2><span class="count" id="pcount"></span></div>
    <p class="note">Every USDC settlement on Base Mainnet, with verified transaction hashes and view counts covered.</p>
    <div class="rows" id="prows"></div>
  </section>

  <section id="wallets" hidden>
    <div class="shead"><h2>Wallets</h2></div>
    <p class="note">Addresses you have been paid to. The first account to submit with an address
      claims it, so nobody else can attach your earnings to their record.</p>
    <div class="rows" id="wrows"></div>
  </section>

  <section id="standing" hidden>
    <div class="shead"><h2>Standing</h2></div>
    <p class="note">The share of your views still there when the wait closed — the same number
      that decides your payout, shown back to you.</p>
    <div class="rows" id="srows"></div>
  </section>

</main>
</div>
</div>

<footer><div class="wrap" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
  <div style="display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px;color:var(--ink);">
    <img src="/logo.svg" alt="Merlin Clips Logo" width="20" height="20" style="border-radius:5px;display:block;" />
    Merlin Clips
  </div>
  <span style="color:var(--ink-3);">· Create, post and earn on YouTube. Every payout decision is written to an append-only record. ·</span>
  <a href="https://github.com/Aditya-galaxy/merlinclips">Source</a>
</div></footer>

<script>
var KEY = 'merlinclips.submissions';
var RAW_CAMPAIGNS = [];
var RAW_CLIPS = [];
var ACTIVE_PLATFORM = 'all';
var ACTIVE_SUB_STATE = 'all';

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function mine(){try{return JSON.parse(localStorage.getItem(KEY)||'[]');}catch(e){return[];}}
function keep(id){var a=mine();if(a.indexOf(id)<0){a.push(id);localStorage.setItem(KEY,JSON.stringify(a));}}
function money(n){var v=parseFloat(n||'0');return v.toLocaleString('en-US',{maximumFractionDigits:2});}
function rate(n){var v=parseFloat(n||'0');
  return v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function count(n){return parseInt(n||'0',10).toLocaleString('en-US');}
function compact(n){var v=parseInt(n||'0',10);
  if(v>=1e9)return (v/1e9).toFixed(1).replace(/\.0$/,'')+'B';
  if(v>=1e6)return (v/1e6).toFixed(1).replace(/\.0$/,'')+'M';
  if(v>=1e3)return (v/1e3).toFixed(1).replace(/\.0$/,'')+'K';
  return String(v);}
/* The budget is the number a creator bets an evening on, so whether money is
   actually behind it belongs on the card, not in a footnote nobody reads. */
function fundChip(f){
  if(!f) return '';
  if(f.coverage==='covered')  return '<span class="chip funded">Funded</span>';
  if(f.coverage==='partial')  return '<span class="chip partial">Part funded</span>';
  if(f.coverage==='empty')    return '<span class="chip unbacked">Unfunded</span>';
  if(f.coverage==='no_wallet')return '<span class="chip unbacked">Unbacked</span>';
  return '<span class="chip plain">Budget unverified</span>';
}
function ago(iso){var t=Date.parse(iso);if(isNaN(t))return '';
  var d=Math.floor((Date.now()-t)/86400000);
  if(d<=0)return 'today'; if(d===1)return '1 day ago';
  if(d<30)return d+' days ago';
  var m=Math.floor(d/30); return m===1?'1 month ago':m+' months ago';}

/* Three states, not two. A clip waiting for its first check and a clip that
   failed the brief are both refused by the gate; showing them alike tells a
   creator their work was rejected when it is only queued. */
function stateOf(s){
  if(parseFloat(s.paidForViews||'0')>0) return 'settled';
  if(s.settled===false) return 'waiting';
  if(s.status==='held') return 'waiting';
  if(s.status==='blocked') return 'refused';
  return 'waiting';
}
function labelFor(st,s){
  if(st==='settled') return 'Paid';
  if(st==='refused') return 'Not paid';
  return s.settled===false && s.control==='dwell_unmet' ? 'Counting down' : 'In progress';
}

function renderCampaignList(){
  var host=document.getElementById('campaigns-list');
  var sel=document.getElementById('camp');
  var query=(document.getElementById('csearch').value||'').toLowerCase().trim();
  
  var list=RAW_CAMPAIGNS.filter(function(c){
    var plat=(c.platforms&&c.platforms[0])||'youtube';
    if(ACTIVE_PLATFORM!=='all' && plat!==ACTIVE_PLATFORM) return false;
    if(query && c.brief.toLowerCase().indexOf(query)<0 && c.campaignId.toLowerCase().indexOf(query)<0) return false;
    return true;
  });

  document.getElementById('ccount').textContent=list.length?list.length+' live':'';
  if(!list.length){
    host.innerHTML='<div class="blank">No matching campaigns found. Try adjusting filters.</div>';
    return;
  }
  host.innerHTML=list.map(function(c){
    var pool=parseFloat(c.poolUsdc||'0');
    var spent=parseFloat(c.spentUsdc||'0');
    var pct=pool>0?Math.max(0,Math.min(100,spent/pool*100)):0;
    var plat=(c.platforms&&c.platforms[0])||'youtube';
    return '<article class="offer">'
      + '<div class="tags"><span class="chip">Clipping</span>'
      +   '<span class="chip plain">'+esc(plat.charAt(0).toUpperCase()+plat.slice(1))+'</span>'
      +   fundChip(c.funding)
      +   '<span class="age">'+esc(ago(c.startsAt))+'</span></div>'
      + '<h3 class="title">'+esc(c.brief)+'</h3>'
      + '<div class="by">'+esc(c.campaignId)+'</div>'
      + '<div class="money"><span class="spent">$'+money(spent)+' <em>/ $'+money(pool)+'</em></span>'
      +   '<span class="cpm">$'+esc(c.cpmUsdc)+' / 1k views</span></div>'
      + '<span class="track"><i class="fill" style="width:'+pct.toFixed(1)+'%"></i></span>'
      + '<div class="stats">'
      +   '<div><span>Hold</span><b>'+esc(c.dwellHours!=null?c.dwellHours:24)+'h</b></div>'
      +   '<div><span>Views paid</span><b>'+compact(c.paidViews)+'</b></div>'
      +   '<div><span>Creators</span><b>'+count(c.creators)+'</b></div>'
      + '</div>'
      + '<div style="margin-top:12px;"><button class="gbtn" style="width:100%;justify-content:center;" onclick="selectCampaign(\''+esc(c.campaignId)+'\')">⚡ Clip This Brief</button></div>'
      + (c.funding && c.funding.coverage!=='covered'
          ? '<p class="fundnote">'+esc(c.funding.summary)+'</p>' : '')
      + '</article>';
  }).join('');
}

function selectCampaign(cid){
  var sel=document.getElementById('camp');
  if(sel){ sel.value=cid; }
  var subSec=document.getElementById('submit');
  if(subSec){ subSec.scrollIntoView({behavior:'smooth'}); }
}

async function loadCampaigns(){
  var d;
  try{ d=await (await fetch('/api/campaign')).json(); }catch(e){ d={campaigns:[]}; }
  RAW_CAMPAIGNS=d.campaigns||[];
  var sel=document.getElementById('camp');
  if(RAW_CAMPAIGNS.length){
    sel.innerHTML=RAW_CAMPAIGNS.map(function(c){
      return '<option value="'+esc(c.campaignId)+'">'+esc(c.brief.slice(0,54))+(c.brief.length>54?'…':'')+' — '+esc(c.cpmUsdc)+'/1k</option>';
    }).join('');
  } else {
    sel.innerHTML='<option value="">No live campaigns</option>';
  }
  renderCampaignList();
}

function renderClipsList(){
  var host=document.getElementById('clips');
  var list=RAW_CLIPS.filter(function(s){
    var st=stateOf(s);
    if(ACTIVE_SUB_STATE!=='all' && st!==ACTIVE_SUB_STATE) return false;
    return true;
  });

  document.getElementById('lcount').textContent=list.length?list.length+' shown':RAW_CLIPS.length+' submitted';
  if(!list.length){ host.innerHTML='<div class="blank">No submissions match the selected filter.</div>'; return; }

  host.innerHTML=list.map(function(s){
    var st=stateOf(s);
    return '<div class="line is-'+st+'">'
      + '<span class="stripe"></span>'
      + '<div class="what">'
      +   '<span class="tag '+st+'">'+esc(labelFor(st,s))+'</span>'
      +   '<div class="ref"><a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.url||s.submissionId)+'</a></div>'
      +   (s.reason?'<p class="why">'+esc(s.reason)+'</p>':'')
      + '</div>'
      + '<div class="ledger">'
      +   '<div><b>'+count(s.confirmedViews)+'</b><span>views held</span></div>'
      +   '<div><b>'+count(s.paidForViews)+'</b><span>paid for</span></div>'
      +   '<div class="paid"><b>$'+money(s.earnedUsdc)+'</b><span>earned</span></div>'
      + '</div></div>';
  }).join('');
}

async function loadClips(){
  var ids=mine();
  if(!ids.length){ document.getElementById('clips').innerHTML='<div class="blank">No submissions yet. Pick a campaign above to start earning.</div>'; return; }
  RAW_CLIPS=await Promise.all(ids.map(async function(id){
    try{ return await (await fetch('/api/submissions/'+encodeURIComponent(id))).json(); }
    catch(e){ return {submissionId:id,status:'unknown',reason:'Could not load this clip.'}; }
  }));
  renderClipsList();
}

// Verification Code Handler
var CURRENT_VER_CODE = 'MC-' + Math.random().toString(36).substring(2, 8).toUpperCase();
var verCodeEl = document.getElementById('ver-code-val');
if(verCodeEl){ verCodeEl.textContent = CURRENT_VER_CODE; }

var copyVerBtn = document.getElementById('copy-ver-code');
if(copyVerBtn){
  copyVerBtn.onclick = function(){
    navigator.clipboard.writeText(CURRENT_VER_CODE).then(function(){
      copyVerBtn.textContent = 'Copied!';
      setTimeout(function(){ copyVerBtn.textContent = 'Copy Code'; }, 2000);
    });
  };
}

// Event Listeners for Filters
document.getElementById('csearch').addEventListener('input', renderCampaignList);

document.getElementById('pfilter').addEventListener('click', function(e){
  var btn=e.target.closest('button');
  if(!btn) return;
  document.querySelectorAll('#pfilter .filter-chip').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  ACTIVE_PLATFORM=btn.dataset.plat;
  renderCampaignList();
});

document.getElementById('subfilter').addEventListener('click', function(e){
  var btn=e.target.closest('button');
  if(!btn) return;
  document.querySelectorAll('#subfilter .filter-chip').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  ACTIVE_SUB_STATE=btn.dataset.state;
  renderClipsList();
});

document.getElementById('go').addEventListener('click',async function(){
  var btn=this, said=document.getElementById('said');
  said.innerHTML='';
  btn.disabled=true; btn.textContent='Submitting…';
  try{
    var r=await fetch('/api/submissions',{method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        campaignId:document.getElementById('camp').value,
        url:document.getElementById('url').value.trim(),
        payoutAddress:document.getElementById('addr').value.trim()})});
    var d=await r.json();
    if(!r.ok){
      said.innerHTML='<div class="said bad">'+esc(d.error||'Could not submit that clip.')+'</div>';
    }else{
      keep(d.submissionId);
      document.getElementById('url').value='';
      await loadClips();
      var t=d.agreedTerms||{};
      said.innerHTML='<div class="said ok">Approved. Your CPM is locked at $'+esc(t.cpmUsdc)
        +' per 1,000 views on a '+esc(t.dwellHours)+'-hour hold. The brand cannot change it now.</div>';
    }
  }catch(e){
    said.innerHTML='<div class="said bad">Could not reach the server. Check your connection and try again.</div>';
  }finally{
    btn.disabled=false; btn.textContent='Submit clip';
  }
});

loadCampaigns();
loadClips();
setInterval(loadClips,20000);

var deployForm = document.getElementById('deploy-campaign-form');
if (deployForm) {
  deployForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    var btn = document.getElementById('btn-deploy-campaign');
    var status = document.getElementById('c-deploy-status');
    btn.disabled = true;
    btn.textContent = 'Deploying Campaign on Base…';
    status.innerHTML = '';

    var secret = document.getElementById('c-secret').value.trim();
    var brandId = document.getElementById('c-brand').value.trim().toLowerCase();
    var title = document.getElementById('c-title').value.trim();
    var rules = document.getElementById('c-rules').value.trim();

    var payload = {
      campaignId: 'camp-' + Math.random().toString(36).substring(2, 10),
      ownerId: brandId,
      brief: title + ': ' + rules,
      poolUsdc: document.getElementById('c-pool').value,
      cpmUsdc: document.getElementById('c-cpm').value,
      perCreatorCapUsdc: document.getElementById('c-cap').value,
      dwellHours: parseInt(document.getElementById('c-dwell').value, 10),
      minStanding: document.getElementById('c-standing').value,
      fundingWallet: '0x0003a59858f44451be2a5b486ee612b4139700f0',
      chain: 'base',
      platforms: ['youtube']
    };

    try {
      var r = await fetch('/api/campaigns', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-operator-secret': secret
        },
        body: JSON.stringify(payload)
      });
      var data = await r.json();
      if (!r.ok) {
        status.innerHTML = '<div style="padding:10px 14px;border-radius:9px;background:var(--refused-wash);color:var(--refused);font-size:13.5px;"><b>Campaign Creation Refused:</b> ' + esc(data.error || 'Invalid operator secret key or invalid payload.') + '</div>';
      } else {
        status.innerHTML = '<div style="padding:10px 14px;border-radius:9px;background:var(--settled-wash);color:var(--settled);font-size:13.5px;"><b>🚀 Campaign Activated on Base!</b> Campaign ID <code>' + esc(data.campaignId) + '</code> published. Pool funded with $' + Number(data.poolUsdc).toFixed(2) + ' USDC.</div>';
        deployForm.reset();
        await loadCampaigns();
      }
    } catch (err) {
      status.innerHTML = '<div style="padding:10px 14px;border-radius:9px;background:var(--refused-wash);color:var(--refused);font-size:13.5px;">Network error deploying campaign. Check your connection.</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 Deploy & Fund Campaign on Base';
    }
  });
}

/* Sign-in state comes from the server, never from the cookie: the session
   cookie is HttpOnly precisely so this script cannot read it, and a page that
   decides who you are from something JavaScript can write is deciding
   nothing. When sign-in is not configured on a deployment, no button appears
   at all rather than one that 503s. */
(function () {
  /* Who is signed in. The avatar is Google's; when it will not load — an
     account with no photo, or a blocked referrer — an initial stands in, so
     the rail never shows a broken image where a face should be. */
  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.signedIn) return;
      var who = document.getElementById('rprofile');
      var name = me.name || me.email || 'Signed in';
      document.getElementById('rname').textContent = name;
      document.getElementById('remail').textContent = me.email || '';
      var img = document.getElementById('ravatar');
      var ini = document.getElementById('rinitial');
      ini.textContent = name.trim().charAt(0).toUpperCase();
      if (me.picture) {
        img.onload = function () { img.hidden = false; ini.hidden = true; };
        img.onerror = function () { img.hidden = true; ini.hidden = false; };
        img.src = me.picture;
      }
      who.hidden = false;
    })
    .catch(function () { /* signed out is the safe assumption */ });

  /* The record, for whoever is signed in. Rendered only once it answers:
     a dashboard that paints zeroes and corrects itself a moment later tells a
     creator they earned nothing, which is the one thing it must never say by
     accident. */
  fetch('/api/me/profile', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (p) {
      if (!p) return;
      var overviewSec = document.getElementById('overview');
      var num = function (id, v) {
        var el = document.getElementById(id);
        if (el) el.textContent = v;
      };

      num('t-earned', '$' + Number(p.totals.earnedUsdc || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      num('t-holding', '$' + Number(p.totals.holdingUsdc || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      num('t-holding-views', Number(p.totals.holdingViews || 0).toLocaleString('en-US'));
      num('t-views', Number(p.totals.viewsPaid || 0).toLocaleString('en-US'));

      var card = document.getElementById('t-standing-card');
      if (card) {
        card.dataset.level = p.standing.level;
        num('t-standing', p.standing.level);
        num('t-standing-says', p.standing.says || '');
        if (p.standing.nextLevelName) {
          num('t-next-level', 'Next: ' + p.standing.nextLevelName + ' (' + (p.standing.nextLevelProgress || 0) + '%)');
        }

        var meter = document.getElementById('t-meter');
        var fill = document.getElementById('t-meter-fill');
        if (meter && fill) {
          meter.hidden = false;
          fill.style.width = (p.standing.nextLevelProgress || 0) + '%';
        }
      }

      var walletText = document.getElementById('dwallets');
      if (walletText) {
        walletText.textContent = p.wallets && p.wallets.length
          ? 'Paid directly to linked Base EVM wallet: ' + p.wallets.join(', ')
          : 'No wallet linked yet — submit a clip and the one you are paid to is linked here.';
      }

      if (overviewSec) overviewSec.hidden = false;
      renderEntities(p);
    })
    .catch(function () { /* signed out, or the profile is unavailable */ });

  var q = new URLSearchParams(location.search);
  if (q.get('signin') === 'failed') {
    var why = q.get('why') || 'unknown';
    var note = document.createElement('div');
    note.className = 'signin-note';
    note.textContent = why === 'declined'
      ? 'Sign-in was cancelled. Nothing was changed.'
      : 'Sign-in could not be verified, so you were not signed in.';
    document.querySelector('main').prepend(note);
  }
})();

/* Entity views. Each renders the fields for one thing a creator owns, and
   nothing renders until the data for it exists — an empty row that fills in
   later reads as a value that changed. */
function renderEntities(p) {
  var esc = function (t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var money = function (n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return iso; }
  };
  var show = function (id, html) {
    var host = document.getElementById(id);
    if (!host) return;
    host.innerHTML = html;
    var sec = host.closest('section');
    if (sec) sec.hidden = false;
  };
  var row = function (title, pairs) {
    return '<div class="erow"><h4>' + esc(title) + '</h4><dl>'
      + pairs.map(function (kv) {
          return '<dt>' + esc(kv[0]) + '</dt><dd' + (kv[2] ? ' class="words"' : '') + '>'
            + (kv[3] ? kv[1] : esc(kv[1])) + '</dd>';
        }).join('')
      + '</dl></div>';
  };

  /* Payouts: amount, views paid, settled at, tx. */
  if (p.payouts) {
    var pcount = document.getElementById('pcount');
    if (pcount) pcount.textContent = p.payouts.length + (p.payouts.length === 1 ? ' payout' : ' payouts');
    show('prows', p.payouts.length
      ? p.payouts.map(function (x) {
          var txLink = x.txHash
            ? '<a href="https://basescan.org/tx/' + esc(x.txHash) + '" target="_blank" rel="noopener"><code>' + esc(x.txHash.slice(0, 10)) + '…</code></a>'
            : 'not broadcast — settled in dry run';
          return row(money(x.amountUsdc), [
            ['Views paid', Number(x.viewsPaidTo).toLocaleString('en-US')],
            ['Settled', when(x.settledAt)],
            ['Campaign', x.campaignId],
            ['Transaction', txLink, false, true]
          ]);
        }).join('')
      : '<div class="erow"><p class="empty">Nothing settled yet. A clip pays once its wait closes and the amount clears the minimum worth sending.</p></div>');
  }

  /* Wallets: address, chain, first seen, last paid. */
  if (p.linkedWallets) {
    show('wrows', p.linkedWallets.length
      ? p.linkedWallets.map(function (w) {
          return row(w.address, [
            ['Chain', w.chain || 'Base'],
            ['First seen', when(w.firstSeenAt)],
            ['Last paid', when(w.lastPaidAt)]
          ]);
        }).join('')
      : '<div class="erow"><p class="empty">No wallet linked yet. The address you are paid to on your first submission is claimed by this account.</p></div>');
  }

  /* Standing: rate, level, clips judged. */
  if (p.standing) {
    var rateStr = typeof p.standing.survivalRate === 'number'
      ? Math.round(p.standing.survivalRate * 1000) / 10 + '%'
      : 'not enough history yet';
    show('srows', row(p.standing.level, [
      ['Survival rate', rateStr],
      ['Clips counted', String(p.standing.clipsJudged)],
      ['What it means', p.standing.says || '', true]
    ]));
  }
}

/* The rail follows the section you are actually looking at, rather than only
   the last link clicked — otherwise scrolling leaves it pointing at the wrong
   place, which is worse than not highlighting at all. */
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.rl[data-sec]'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var mark = function (id) {
    links.forEach(function (a) {
      a.setAttribute('aria-current', String(a.dataset.sec === id));
    });
  };
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) mark(e.target.id); });
  }, { rootMargin: '-20% 0px -70% 0px' });
  links.forEach(function (a) {
    var el = document.getElementById(a.dataset.sec);
    if (el) seen.observe(el);
  });
})();

</script>
</body>
</html>
`;
