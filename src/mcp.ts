/**
 * The MCP transport.
 *
 * `/mcp.json` has been served for months and no agent could ever use it: a
 * manifest describes tools, it does not answer calls. An agent that fetched it
 * learned what existed and had nowhere to send a request. This is the part
 * that was missing.
 *
 * JSON-RPC 2.0 over a single POST, which is the streamable-HTTP transport MCP
 * clients default to. Claude Code, Codex and anything else speaking MCP can
 * point at https://merlinclips.com/mcp and get a working tool list.
 *
 * ## Which tools exist here
 *
 * Only the ones an agent can genuinely complete.
 *
 * `create_campaign` opens a campaign the caller funds itself, which is why it
 * is here at all. The operator route stays privileged because it commits our
 * money; this one commits the caller's, stays invisible until their deposit
 * confirms on-chain, and can pay nobody until then — so the judgement a human
 * was making is made by the chain instead.
 *
 * Every one of them is a thin call onto the same handlers the website uses, so
 * there is no second implementation to drift.
 */

import { bothFormsOf } from './campaign/accounts';
import { authorise } from './mcpauth';
import type { CampaignRuntime } from './campaign/runtime';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, result });

const err = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** MCP returns tool output as content blocks, not bare JSON. */
const text = (value: unknown) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

export const TOOLS = [
  {
    name: 'list_open_campaigns',
    description:
      'Campaigns currently open to creators, with the rate, the hold, and how much of the '
      + 'pool is left. Only campaigns with USDC verified on-chain behind them appear — an '
      + 'unfunded pool is withheld rather than advertised.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_campaign',
    description:
      'Open a campaign you fund yourself. Returns a deposit address. The campaign is invisible '
      + 'to creators and accepts no clips until your USDC confirms on-chain — then it goes live '
      + 'automatically, with no approval step. Pool minimum 100 USDC, per-creator cap minimum 10. '
      + 'The brief describes the video required; it must not instruct the verifier. '
      + 'Requires an operator-issued key: send it as `Authorization: Bearer <key>`.',
    inputSchema: {
      type: 'object',
      properties: {
        brandName: {
          type: 'string',
          description: 'Who is paying, shown on the card beside the campaign. Also becomes the '
            + 'card art, so give the name you want creators to see.',
        },
        title: {
          type: 'string',
          description: 'What to call the campaign. Omit and we use "<brandName> Clipping", '
            + 'which is the convention creators already read.',
        },
        category: {
          type: 'string',
          enum: ['entertainment', 'technology', 'gaming', 'finance', 'education', 'product', 'other'],
          description: 'Used to filter the campaigns page. Anything unrecognised becomes "other" '
            + 'rather than failing the call.',
        },
        brief: {
          type: 'string',
          description: 'What the clip must show, in plain language — this is the whole spec and '
            + 'Gemini judges every clip against it. There is no separate title field. Describe '
            + 'the video required; do not address the verifier, as briefs that instruct it are '
            + 'refused. Good: "Show the product running, name spoken aloud in the first five '
            + 'seconds, no competitor logos."',
        },
        poolUsdc: { type: 'string', description: 'Total budget. Minimum 100.' },
        cpmUsdc: { type: 'string', description: 'Paid per 1,000 surviving views.' },
        perCreatorCapUsdc: { type: 'string', description: 'Max one creator can earn. Minimum 10.' },
        fundingWallet: {
          type: 'string',
          description: 'Your agent wallet. One wallet can fund every campaign you run — '
            + 'coverage nets your other pools off the balance, so each one only counts money '
            + 'not already promised elsewhere. It must be a wallet provisioned for this '
            + 'deployment: the campaign is paid out of the same wallet it is funded to, so an '
            + 'address we hold no key for is refused here rather than failing at the first '
            + 'payout. Ask the operator to provision one if you do not have it.',
        },
        chain: { type: 'string', description: 'base or base-sepolia. Default base.' },
        dwellHours: {
          type: 'number',
          description: 'How long a view must hold before it is payable. Minimum 1, default 24. '
            + 'Shorter pays faster and filters less.',
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['youtube', 'x', 'instagram'] },
          description: 'Where clips may be posted. YouTube is counted for any public video. '
            + 'X is accepted and never accrues, because no API answers for someone else\'s post. '
            + 'Instagram is counted only where a creator has authorised this deployment, so it '
            + 'is refused unless that is configured — the call tells you which. Default ["youtube"].',
        },
        minCpmUsdc: {
          type: 'string',
          description: 'Floor of the rate band. The agent may move the rate as the pool '
            + 'drains, but only inside this band. Defaults to cpmUsdc.',
        },
        maxCpmUsdc: { type: 'string', description: 'Ceiling of the rate band. Defaults to cpmUsdc.' },
        minStanding: {
          type: 'string',
          enum: ['unproven', 'building', 'reliable', 'exceptional'],
          description: 'Lowest creator standing accepted. Omit to open it to everyone, which '
            + 'is usually right — places are reserved for newcomers regardless.',
        },
        reservedForUnproven: {
          type: 'number',
          description: 'Places held for creators with no track record. Omit to let us compute it.',
        },
        settlementDays: {
          type: 'number',
          description: 'How long after a clip is accepted it can still be paid. Default 14. '
            + 'This is an obligation to the creator, not a convenience.',
        },
        endsAt: { type: 'string', description: 'ISO date the campaign stops accepting clips. Default 30 days.' },
        ownerId: { type: 'string', description: 'Your brand id, if you have one. Groups campaigns on your dashboard.' },
        campaignId: { type: 'string', description: 'Your own id for it. Omit and we generate one.' },
      },
      required: ['brief', 'poolUsdc', 'cpmUsdc', 'perCreatorCapUsdc', 'fundingWallet'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_clip',
    description:
      'Submit a clip to a campaign. Requires an operator-issued key — send it as '
      + '`Authorization: Bearer <key>` — because a creator must be identified before a clip '
      + 'is accepted, and the website enforces the same thing through sign-in. '
      + 'Accepting the clip freezes the rate, hold and per-creator cap onto it, so a brand '
      + 'cannot lower them afterwards. YouTube, and Instagram where configured.',
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', description: 'From list_open_campaigns.' },
        url: { type: 'string', description: 'The clip URL. YouTube or X.' },
        payoutAddress: { type: 'string', description: 'Base address that receives USDC.' },
      },
      required: ['campaignId', 'url', 'payoutAddress'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_clip',
    description:
      'What happened to one clip: whether it passed the brief, how many views have survived, '
      + 'what it has earned, and if it has not paid yet, which gate is holding it and why. '
      + 'A clip inside its hold is waiting, not rejected — say it that way to the creator.',
    inputSchema: {
      type: 'object',
      properties: { submissionId: { type: 'string', description: 'Returned by submit_clip.' } },
      required: ['submissionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_earnings',
    description:
      'Everything one payout address has submitted and been paid, across every campaign. '
      + 'Public by design — the address is the identity here, and its payouts are on-chain '
      + 'anyway, so anyone can already verify them.',
    inputSchema: {
      type: 'object',
      properties: { payoutAddress: { type: 'string', description: 'The Base address clips were submitted with.' } },
      required: ['payoutAddress'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_campaign_funding',
    description:
      'Read what is actually on-chain behind a campaign pool. Returns coverage as covered, '
      + 'partial, empty, unknown or no_wallet. A failed lookup reports unknown rather than '
      + 'zero — "could not check" and "there is nothing there" are different answers.',
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
      required: ['campaignId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_ledger',
    description:
      'The public audit ledger: every campaign and every settled payout, with the Base '
      + 'transaction that moved each one. Empty means nothing has settled, not that data '
      + 'is missing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'explain_payout_rules',
    description:
      'How a payout is decided: the dwell mechanic, the gates in order, and what each '
      + 'refusal means. Read this before submitting if you want to know why a clip might '
      + 'be held rather than paid.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

const RULES = `A view is payable once it has survived.

  confirmed = min(every observation from the anchor until now)
  payable   = confirmed - already_paid
  amount    = payable x cpm / 1000

Observations are taken hourly, so roughly 24 across a 24-hour window. The
minimum across the whole window — not the endpoints — is what catches a count
that was scrubbed and rebought.

The gate is first-match-wins and fails closed:

  unknown submission, campaign or creator   blocked
  past the settlement deadline              blocked
  campaign not live                         blocked
  no verdict, or the verdict failed         blocked
  dwell window still open                   held    (a wait, not a rejection)
  no views beyond what was already paid     no_op
  would exceed the campaign pool            blocked
  over this creator's cap                   requires_approval
  absolute ceiling, mandate, rolling window requires_approval
  mainnet without an explicit opt-in        blocked

There is no clawback. Settled USDC cannot be recalled, so a falling count
reduces the next payout rather than reversing one. A payout below 1.00 USDC is
held and rolls into the next, which is why a small balance shows as held
rather than paid.`;

export async function handleMcp(request: Request, campaigns: CampaignRuntime): Promise<Response> {
  // The Streamable HTTP transport opens an SSE stream with GET. This server
  // does not offer one — every tool here answers in a single round trip — and
  // the spec's answer for that is 405, not a JSON-RPC error. A client reading
  // -32600 concludes the server is broken rather than that it is
  // request/response only.
  //
  // The body is written for a person, because the other thing that reaches
  // this URL is someone pasting it into a browser to check it works.
  if (request.method === 'GET' || request.method === 'HEAD') {
    return Response.json(
      {
        name: 'merlinclips',
        transport: 'streamable-http (request/response only, no SSE)',
        usage: 'POST JSON-RPC 2.0 to this URL. Try {"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        tools: TOOLS.map((t) => t.name),
        docs: 'https://merlinclips.com/api.html',
      },
      { status: 405, headers: { allow: 'POST' } },
    );
  }

  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  const body = (await request.json().catch(() => ({}))) as JsonRpcRequest;
  const { id, method, params } = body;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'merlinclips', version: '1.0.0' },
    });
  }

  // Notifications carry no id and expect no response body.
  if (method === 'notifications/initialized') return new Response(null, { status: 202 });

  if (method === 'tools/list') return ok(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = String(params?.['name'] ?? '');
    const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;

    // Only `create_campaign` needs a key — see WRITE_TOOLS for why the reads
    // and `submit_clip` deliberately do not. The refusal names the header that
    // is missing rather than only reporting that something is.
    const auth = authorise(name, request.headers.get('authorization'), campaigns.mcpKeys);
    if (!auth.ok) {
      // Captured, not just returned. A refusal is the most informative event
      // this endpoint produces: it is an agent that found us, chose a tool and
      // could not use it, which is integration friction rather than noise.
      void campaigns.analytics.capture({
        event: 'mcp_tool_refused',
        distinctId: 'mcp:anonymous',
        properties: { tool: name, status: auth.status },
      });
      return err(id, auth.status === 503 ? -32000 : -32001, auth.reason);
    }

    const started = Date.now();
    // The key's owner when there is one, and a single shared id when there is
    // not. Anonymous callers collapsing to one subject overstates nothing —
    // we genuinely cannot tell them apart, and inventing a per-request or
    // per-IP identity would report a population we have not observed.
    const distinctId = auth.owner === 'public' ? 'mcp:anonymous' : `mcp:${auth.owner}`;
    let outcome = 'ok';

    const run = async (): Promise<Response> => {
      switch (name) {
        case 'list_open_campaigns': {
          const view = await campaigns.publicView();
          return ok(id, text({
            campaigns: view.campaigns
              .filter((c) => c.status === 'active')
              .map((c) => ({
                campaignId: c.campaignId,
                brief: c.brief,
                cpmUsdc: c.cpmUsdc,
                remainingUsdc: c.remainingUsdc,
                perCreatorCapUsdc: c.perCreatorCapUsdc,
                dwellHours: c.dwellHours,
                platforms: c.platforms,
                backedOnChain: c.funding.coverage,
              })),
          }));
        }

        case 'create_campaign': {
          // The key's owner, not a field the caller supplies. A caller-supplied
          // owner would make the record of who opened a campaign worth exactly
          // as much as the caller's honesty.
          const res = await campaigns.handleAgentCampaign(new Request('http://mcp/api/agent/campaigns', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...args, ownerId: auth.owner }),
          }));
          return ok(id, text(await res.json()));
        }

        case 'submit_clip': {
          // The key's owner, forwarded so the runtime can tell an authorised
          // agent from an anonymous POST. Submitting now needs an account on
          // the website, and a gate the MCP layer walks around is not a gate.
          const res = await campaigns.handleSubmit(new Request('http://mcp/api/submissions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-mcp-owner': auth.owner },
            body: JSON.stringify(args),
          }));
          return ok(id, text(await res.json()));
        }

        case 'check_clip': {
          const res = await campaigns.handleSubmissionStatus(String(args['submissionId'] ?? ''));
          return ok(id, text(await res.json()));
        }

        case 'check_earnings': {
          // The store is empty until the log has been replayed. Every other
          // tool goes through a handler that awaits this; reading the store
          // directly skipped it, so a cold instance answered "no clips, no
          // earnings" to a creator who had both — the most alarming possible
          // wrong answer on a payouts product.
          await campaigns.ready();
          const wallet = String(args['payoutAddress'] ?? '').toLowerCase();
          const state = campaigns.store.exportState();
          // Against the stored form. Comparing to the bare address returned
          // "no clips, no earnings" to creators who had both — the most
          // alarming possible wrong answer on a payouts product.
          const ids = bothFormsOf(wallet);
          const mine = state.submissions.filter((x) => ids.includes(x.creatorId.toLowerCase()));
          const paid = campaigns.publicPayoutsFor(wallet);
          return ok(id, text({
            payoutAddress: wallet,
            clipsSubmitted: mine.length,
            settlements: paid,
            totalPaidUsdc: paid
              .reduce((t, x) => t + Number(x.amountUsdc), 0)
              .toFixed(2),
            clips: mine.map((x) => ({
              submissionId: x.submissionId,
              campaignId: x.campaignId,
              url: x.url,
              submittedAt: x.submittedAt,
              cpmUsdc: x.acceptedTerms.cpmUsdc.toString(),
              dwellHours: Math.round(x.acceptedTerms.dwellMs / 3_600_000),
            })),
          }));
        }

        case 'check_campaign_funding': {
          const res = await campaigns.handleCheckFunding(String(args['campaignId'] ?? ''));
          return ok(id, text(await res.json()));
        }

        case 'get_ledger': {
          const view = await campaigns.publicView();
          return ok(id, text({ campaigns: view.campaigns, payouts: view.payouts }));
        }

        case 'explain_payout_rules':
          return ok(id, text(RULES));

        default:
          return err(id, -32601, `unknown tool: ${name}`);
      }
    };

    try {
      return await run();
    } catch (error) {
      // Reported as a tool error rather than a transport error, so the agent
      // sees what went wrong instead of assuming the server is unreachable.
      outcome = 'threw';
      void campaigns.analytics.captureException(error, 'mcp', { tool: name });
      return ok(id, {
        ...text(`${name} failed: ${(error as Error).message}`),
        isError: true,
      });
    } finally {
      // In `finally` so the call is counted whichever way it left. Only
      // exceptions were captured before, which meant the funnel showed what
      // broke and never what worked — a tool nobody could complete and a tool
      // nobody tried looked identical.
      //
      // `outcome: 'ok'` means the transport succeeded, not that the agent got
      // what it wanted: a tool answering `{error: ...}` in its own body counts
      // here as ok. The distinction that matters for a funnel is the tool
      // name, and that is recorded either way.
      void campaigns.analytics.capture({
        event: 'mcp_tool_called',
        distinctId,
        properties: {
          tool: name,
          outcome,
          authenticated: auth.owner !== 'public',
          durationMs: Date.now() - started,
        },
      });
    }
  }

  return err(id, -32601, `unknown method: ${String(method)}`);
}
