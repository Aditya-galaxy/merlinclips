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
:root{
  --paper:#F7F7F9; --card:#FFFFFF; --sunk:#F1F1F4;
  --line:#E4E4EA; --line-2:#D2D2DB;
  --ink:#0E0E11; --ink-2:#5A5A66; --ink-3:#8A8A96;
  --violet:#5B2FD6; --violet-2:#7C52F0; --violet-wash:#F0ECFE;
  --settled:#0F7B4F; --settled-wash:#E7F4EE;
  --waiting:#8A6100; --waiting-wash:#FBF1DF;
  --refused:#A32820; --refused-wash:#FBECEA;
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
.bar{border-bottom:1px solid var(--line);background:rgba(247,247,249,.88);
     backdrop-filter:blur(12px);position:sticky;top:0;z-index:20}
.bar .wrap{display:flex;align-items:center;gap:26px;height:60px}
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
.offers{border-top:1px solid var(--line)}
.offer{display:grid;grid-template-columns:1fr auto;gap:26px;align-items:center;
       padding:20px 0;border-bottom:1px solid var(--line)}
.offer .brief{font-size:15.5px;margin:0 0 9px;max-width:60ch}
.offer .id{font-family:var(--num);font-size:11.5px;color:var(--ink-3);letter-spacing:.03em}
.offer .facts{display:flex;gap:26px;align-items:flex-end}
.offer .fact{text-align:right}
.offer .fact b{display:block;font-family:var(--num);font-size:17px;font-weight:500}
.offer .fact span{font-size:10.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.pool{width:150px}
.pool .track{height:5px;border-radius:99px;background:var(--sunk);overflow:hidden;margin-bottom:6px}
.pool .fill{display:block;height:100%;background:var(--violet)}
.pool .cap{display:flex;justify-content:space-between;font-family:var(--num);font-size:11px;color:var(--ink-3)}

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
</style>
</head>
<body>

<div class="bar"><div class="wrap">
  <span class="mark"><i></i>Merlin Clips</span>
  <a class="nav" href="/console">Console</a>
  <a class="nav" href="/openapi.json">API</a>
</div></div>

<main class="wrap">

  <div class="head">
    <p class="eyebrow">Clipping campaigns · paid in USDC</p>
    <h1>Get paid for the views that stay.</h1>
    <p class="stand">Clip content you enjoy, submit it to a campaign, and earn on every view that is
      still there a day later — at the CPM you were quoted, paid straight to your wallet.</p>
    <div class="terms">
      <div><b>24h</b><span>Views must hold</span></div>
      <div><b>Locked</b><span>CPM on approval</span></div>
      <div><b>0%</b><span>Fee on your earnings</span></div>
    </div>
  </div>

  <section>
    <div class="shead"><h2>Live campaigns</h2><span class="count" id="ccount"></span></div>
    <p class="note">Every campaign shows its remaining budget up front, so you know what is left to
      earn before you start editing. When a budget runs out, it runs out.</p>
    <div class="offers" id="campaigns"></div>
  </section>

  <section>
    <div class="shead"><h2>Submit your clip</h2></div>
    <p class="note">No signup and no follower minimum. Your wallet address is your account, because it
      is the thing that gets paid.</p>
    <div class="panel">
      <div class="f">
        <label for="camp">Campaign</label>
        <select id="camp"></select>
      </div>
      <div class="f">
        <label for="url">Link to your post</label>
        <input id="url" placeholder="https://www.youtube.com/watch?v=…" spellcheck="false" />
        <p class="hint">YouTube for now — TikTok and Instagram need platform review we do not yet hold. We
          turn down links we cannot verify rather than promise a check we cannot perform.</p>
      </div>
      <div class="f">
        <label for="addr">Payout wallet</label>
        <input id="addr" placeholder="0x…" spellcheck="false" />
        <p class="hint">Paid directly here. We never hold your balance.</p>
      </div>
      <button class="go" id="go">Submit &amp; start earning</button>
      <div id="said"></div>
    </div>
  </section>

  <section>
    <div class="shead"><h2>Your submissions</h2><span class="count" id="lcount"></span></div>
    <p class="note">Your balance updates as the agent runs. When a submission is not paid, the reason
      says why in plain words — and a clip still counting down is never shown as a rejection.</p>
    <div class="lines" id="clips"></div>
  </section>

</main>

<footer><div class="wrap">
  Create, post and earn on YouTube. Every payout decision is written to an append-only record. ·
  <a href="/console">Operator console</a> ·
  <a href="https://github.com/Aditya-galaxy/merlinclips">Source</a>
</div></footer>

<script>
var KEY = 'merlinclips.submissions';
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function mine(){try{return JSON.parse(localStorage.getItem(KEY)||'[]');}catch(e){return[];}}
function keep(id){var a=mine();if(a.indexOf(id)<0){a.push(id);localStorage.setItem(KEY,JSON.stringify(a));}}
function money(n){var v=parseFloat(n||'0');return v.toLocaleString('en-US',{maximumFractionDigits:2});}
function count(n){return parseInt(n||'0',10).toLocaleString('en-US');}

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

async function loadCampaigns(){
  var host=document.getElementById('campaigns');
  var sel=document.getElementById('camp');
  var d;
  try{ d=await (await fetch('/api/campaign')).json(); }catch(e){ d={campaigns:[]}; }
  var list=d.campaigns||[];
  document.getElementById('ccount').textContent=list.length?list.length+' live':'';
  if(!list.length){
    host.innerHTML='<div class="blank">No live campaigns right now. Check back shortly.</div>';
    sel.innerHTML='<option value="">No live campaigns</option>';
    return;
  }
  host.innerHTML=list.map(function(c){
    var pool=parseFloat(c.poolUsdc||'0');
    var left=parseFloat(c.remainingUsdc!=null?c.remainingUsdc:c.poolUsdc||'0');
    var pct=pool>0?Math.max(0,Math.min(100,left/pool*100)):0;
    return '<div class="offer">'
      + '<div><p class="brief">'+esc(c.brief)+'</p><span class="id">'+esc(c.campaignId)+'</span></div>'
      + '<div class="facts">'
      +   '<div class="fact"><b>'+esc(c.cpmUsdc)+'</b><span>per 1k views</span></div>'
      +   '<div class="fact"><b>'+esc(c.dwellHours!=null?c.dwellHours:24)+'h</b><span>views must hold</span></div>'
      +   '<div class="pool"><span class="track"><i class="fill" style="width:'+pct.toFixed(1)+'%"></i></span>'
      +     '<span class="cap"><span>$'+money(left)+' left</span><span>of $'+money(pool)+'</span></span></div>'
      + '</div></div>';
  }).join('');
  sel.innerHTML=list.map(function(c){
    return '<option value="'+esc(c.campaignId)+'">'+esc(c.brief.slice(0,54))+(c.brief.length>54?'…':'')+' — '+esc(c.cpmUsdc)+'/1k</option>';
  }).join('');
}

async function loadClips(){
  var ids=mine(), host=document.getElementById('clips');
  document.getElementById('lcount').textContent=ids.length?ids.length+' submitted':'';
  if(!ids.length){ host.innerHTML='<div class="blank">No submissions yet. Pick a campaign above to start earning.</div>'; return; }
  var rows=await Promise.all(ids.map(async function(id){
    try{ return await (await fetch('/api/submissions/'+encodeURIComponent(id))).json(); }
    catch(e){ return {submissionId:id,status:'unknown',reason:'Could not load this clip.'}; }
  }));
  host.innerHTML=rows.map(function(s){
    var st=stateOf(s);
    return '<div class="line is-'+st+'">'
      + '<span class="stripe"></span>'
      + '<div class="what">'
      +   '<span class="tag '+st+'">'+esc(labelFor(st,s))+'</span>'
      +   '<div class="ref">'+esc(s.url||s.submissionId)+'</div>'
      +   (s.reason?'<p class="why">'+esc(s.reason)+'</p>':'')
      + '</div>'
      + '<div class="ledger">'
      +   '<div><b>'+count(s.confirmedViews)+'</b><span>views held</span></div>'
      +   '<div><b>'+count(s.paidForViews)+'</b><span>paid for</span></div>'
      +   '<div class="paid"><b>$'+money(s.earnedUsdc)+'</b><span>earned</span></div>'
      + '</div></div>';
  }).join('');
}

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
</script>
</body>
</html>
`;
