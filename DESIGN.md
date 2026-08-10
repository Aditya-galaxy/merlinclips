# Design

Why the site looks the way it does, and what was ruled out. Written because
this went through four rejected passes, and every one of them was rejected for
a reason worth not rediscovering.

---

## What the market actually looks like

Six platforms compete here. They do **not** agree on how to present, and the
disagreement is the useful part.

| | Ground | Hero shows | Accent |
|---|---|---|---|
| **Whop** — market leader, >$150k/mo in payouts | Near-black | Nothing. A headline and two buttons in a lot of empty space | Orange |
| **Content Rewards** | Warm cream | Floating app screenshots in perspective | Orange |
| **Pika** | White | Product collage, right half of a split hero | Pink |
| **Orshot** | Near-black | Large product frame under a centred headline | Blue |
| Vyro, Clipping.net, ClipAffiliates, Promote.fun | mixed | mixed | mixed |

Sources: [Ssemble](https://www.ssemble.com/blog/best-clipping-platforms-2026),
[ClipAffiliates](https://www.clipaffiliates.com/blog/whop-vyro-clipping-alternatives-2026),
[Clipper University](https://www.clipper.university/brands/best-clipping-platforms-2026-whop-alternatives).

### The thing worth noticing

**Whop can be minimal because everyone already knows what Whop is.** Emptiness
reads as confidence when the reader arrives knowing what the product does. It
reads as an unfinished page when they do not.

We are unknown. So the reference that fits us is Pika and Orshot — *show the
product* — not the market leader, however successful the leader is. Copying
Whop's restraint would be copying the output of a brand position we have not
earned.

---

## Decisions

**Product in the hero.** Four passes of this page were text only, and all four
were rejected. A page made only of claims reads as an essay about a product
rather than a product. The hero now carries a browser frame showing live
campaigns.

That frame is **markup, not a screenshot** — the same tokens the real app
uses. A PNG goes stale the moment the app changes, blurs on retina displays,
and costs a request on a page that otherwise makes none. It is `aria-hidden`:
a picture for sighted users, and a screen reader reciting the whole stage set
between the call to action and the payment explanation would be worse than
useless.

**Violet, one accent.** Whop and Content Rewards both own orange in this
market; taking it would make us look like a clone of the incumbent we are
arguing against. Violet is the creator-economy register without being theirs,
and it is the colour the name already implies — Merlin is a wizard. Cyan
survives only as the brand-side marker in the two-sided split, where it has a
job. Green, amber and red are semantic and never decorative: money moved, money
held, money refused.

**Warm light ground.** Whop and Orshot are dark; Pika and Content Rewards are
light. Both work, and this page was dark for four passes before being changed.

The argument for dark was that a payments product should read as a ledger.
That was reasoning about the product rather than the reader: the person
deciding whether to spend an evening editing is not auditing a ledger, and
warmth is what makes a platform feel like somewhere you would trust to pay
you. Content Rewards understood that and this did not.

The ground is a warm off-white rather than the cream-and-serif look that has
become an AI-generated default — barely tinted, so violet stays the only real
colour on the page.

An earlier dark version was also rejected as looking generated, and the
diagnosis is worth keeping even though the decision moved: it was dark **with
gradient text and no imagery**, which is the default. Orshot is equally dark
and does not read that way, because it shows the product. Darkness was never
the problem, and lightness is not the fix — showing the product is.

**Structure follows Content Rewards.** Their frame is what this market already
knows how to read: campaigns with a budget bar, `$X / 1k views`, hold, creator
counts. Their *vocabulary* too — clipping, campaign, budget, CPM, submission,
earning. A creator arriving from a competitor should not have to learn new
words for the same things.

---

## What was deliberately not copied

**Their claims.** `Trusted by 50k+ Creators`, `Connect your bank account`,
`Available to pay out $2,000.00`, `Get paid on time, every time` — every one
of those is false about us. We have no creators yet, we touch no banks, we hold
no balances, and we pay after a 24-hour hold. A product whose entire pitch is
*"we only pay for what is real"* cannot open with numbers it invented. The
frame is theirs; the claims have to be ours.

**Success stories and brand results.** Both references have them. We have
neither, and inventing them is precisely the behaviour this product exists to
argue against. They go back the moment they are true.

**Their trust score.** Theirs is ratings and approval rates, which can be
farmed by doing a lot of anything. Ours is survival rate — the share of a
creator's views still standing when the hold closed — which cannot, because
buying views lowers it. Same section, better number.

**"Untrusted" as an opening label.** Hostile, and wrong about someone who has
done nothing. Standing starts at `unproven`.

**The sparkle glyph.** Every AI product ships it in 2026. Adopting it at the
moment we are trying to look like a company rather than a demo would be
spending our one distinctive mark on the most generic option available.

---

## Rules that outlive this page

1. **Every number on the site is checkable.** Test counts, invariant counts,
   simulated decisions and settlement hashes are real or absent. If the
   simulation changes, re-run `bun run sweep` rather than letting figures
   drift.
2. **A wait never looks like a rejection.** The gate returns `blocked` both for
   a clip awaiting its first check and for one that failed the brief. Rendering
   those alike tells a creator their work was rejected when it is merely
   queued — the single most damaging thing this interface could get wrong.
3. **No external requests.** No fonts, no analytics, no CDN. Nothing we do not
   control can slow the page down or block it.
4. **One origin.** The site, the app and the API are served by one Cloud Run
   service. Splitting them makes every internal link cross-origin, and a
   relative link works perfectly in local preview then 404s once deployed
   apart — the worst kind of broken link, because it passes every check you run
   before shipping.
