/**
 * LLM-assisted layer on top of the deterministic Pacing Agent
 * (pacing/pacingEngine.ts).
 *
 * Design principle: "LLM proposes, deterministic system disposes." Claude
 * never has final say over the actual on-chain rate — it can only suggest a
 * bounded adjustment_factor on top of the already-computed deterministic
 * rate, and that suggestion is re-clamped to the campaign's max_cpm
 * afterward regardless of what it says (see pacing/agent.ts, where the
 * clamp is applied). This is deliberate: a system moving real money should
 * never have an unconstrained LLM as the last word on a number, but a
 * tightly bounded one can add judgment a fixed formula can't — e.g.
 * weighing a clip's recent settlement failures, or trading off multiple
 * clips' engagement relative to each other in a way a per-clip multiplier
 * formula can't see.
 *
 * One Claude API call per campaign, not per clip: cheaper, and lets Claude
 * reason about clips relative to each other, which is the actual judgment
 * call worth making here.
 *
 * If the API call times out, errors, or returns something that fails
 * validation (malformed JSON, an out-of-bounds adjustment_factor, or an
 * incomplete set of per-clip responses), this module returns null and the
 * caller falls back to the deterministic-only result for that cycle —
 * never blocking a pacing cycle (or, worse, a settlement) on an LLM outage
 * or a bad response. Same principle as never letting an audit-log failure
 * block a real payment (see settlement/worker.ts).
 *
 * Note on inputs: "recent Validation Engine anomaly flags" were part of the
 * original spec for this layer, but the Validation Engine's own rejections
 * (validateViewDelta returning non-APPROVED) are never persisted anywhere —
 * poller/viewPoller.ts only logs them to the console and returns without
 * writing a row. So there is no real "anomaly flag" data at that layer to
 * hand to Claude. The closest real, queryable signal is a
 * pending_settlements row that *did* pass validation but then failed
 * downstream (rate-ceiling reject, cap exhaustion, on-chain revert) — see
 * db/db.ts's getRecentFailedSettlementReasonsForClip. That's what's actually
 * sent below, honestly labeled as "recent settlement failures," not
 * "Validation Engine flags."
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ParsedMessage } from "@anthropic-ai/sdk/lib/parser";

export const MODEL = "claude-sonnet-4-6";
export const MIN_ADJUSTMENT_FACTOR = 0.8;
export const MAX_ADJUSTMENT_FACTOR = 1.2;
const API_TIMEOUT_MS = 30_000;
const BP = 10000n;

/**
 * Structural shape only — deliberately no .min()/.max() on adjustment_factor.
 * Anthropic's json_schema structured-output translation doesn't support
 * numeric bounds (minimum/maximum aren't carried into the schema the API
 * enforces), so relying on Zod to reject an out-of-range value here would be
 * an implicit, easy-to-miss guarantee. The actual [MIN_ADJUSTMENT_FACTOR,
 * MAX_ADJUSTMENT_FACTOR] bound is checked explicitly in getLlmAdjustments
 * below, where it's visible and auditable.
 */
const AdjustmentEntrySchema = z.object({
  clipId: z.string(),
  adjustment_factor: z.number().optional(),
  rationale: z.string().min(1),
});
const AdjustmentsResponseSchema = z.object({
  adjustments: z.array(AdjustmentEntrySchema),
});
type AdjustmentsResponse = z.infer<typeof AdjustmentsResponseSchema>;

export interface LlmClipContext {
  clipId: string;
  /** Stringified bigint — display only, never used for arithmetic here. */
  recentViewVelocity: string;
  /** e.g. "1.34x" — the deterministic multiplier already computed, display only. */
  deterministicMultiplier: string;
  /** Stringified bigint — the deterministic rate already computed, before any LLM adjustment. */
  deterministicRate: string;
  /** Real failure_reason strings from recent pending_settlements 'failed' rows for this clip. May be empty. */
  recentFailures: string[];
}

export interface LlmCampaignContext {
  campaignCpmRate: string;
  maxCpm: string;
  /** e.g. "65.0%" — display only. */
  runwayPercent: string;
  runwayThrottleApplied: boolean;
  clips: LlmClipContext[];
}

export interface LlmAdjustment {
  clipId: string;
  /** Always populated after validation — defaults to 1.0 if Claude omitted it for a clip. */
  adjustmentFactor: number;
  rationale: string;
}

/** Minimal shape of the one Anthropic SDK call this module makes (client.messages.parse,
 * structured output — see below), so tests can inject a fake. `params`/`options` are typed
 * loosely (not the SDK's own overloaded param types) purely so this interface structurally
 * matches both the real Anthropic client and a hand-written test stub without fighting
 * TypeScript's overload resolution — the real shape is enforced at the one real call site below. */
export interface AnthropicMessagesClient {
  messages: {
    parse: (params: any, options?: { timeout?: number }) => Promise<ParsedMessage<AdjustmentsResponse>>;
  };
}

let cachedClient: Anthropic | null = null;
function getDefaultClient(): AnthropicMessagesClient {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient as unknown as AnthropicMessagesClient;
}

function buildSystemPrompt(): string {
  return [
    "You are an assistant to ClipStream's Pacing Agent, a system that allocates a campaign's per-view payout rate across competing clips.",
    "A deterministic formula has ALREADY computed a base rate for every clip in this campaign. Your job is only to suggest a small, bounded adjustment on top of that rate — you do NOT set the final rate, and you have no authority beyond the bound stated here.",
    `For each clip, you may propose an adjustment_factor between ${MIN_ADJUSTMENT_FACTOR} and ${MAX_ADJUSTMENT_FACTOR} inclusive. This is your entire leash: any value outside that range will be discarded and the deterministic rate used unchanged for every clip in this campaign.`,
    "Use this to account for things the deterministic formula cannot see — e.g. a clip with recent settlement failures (rate-ceiling rejections, cap exhaustion, on-chain reverts) might warrant a lower adjustment; a clip with strong velocity relative to its peers might warrant a slightly higher one. Do not invent signals you were not given.",
    "If you have no adjustment to make for a clip, omit adjustment_factor for that clip entirely — it will default to 1.0 (no change). Do not force an opinion where you have none.",
    "Every clip MUST have a rationale: a short, specific, plain-language explanation of your reasoning for that clip, even when you are not adjusting its rate. This text is shown directly to the campaign organizer.",
    "Respond with STRICT JSON ONLY. No prose, no markdown code fences, nothing outside the JSON object. The response must match exactly this shape:",
    '{"adjustments": [{"clipId": "<string>", "adjustment_factor": <number, optional>, "rationale": "<string>"}]}',
    "You must include exactly one entry per clip you were given. Each entry's clipId must be copied EXACTLY (character-for-character) from the clipId given for that clip below — never a label or paraphrase of it.",
  ].join("\n");
}

function buildUserPrompt(context: LlmCampaignContext): string {
  const lines: string[] = [
    `Campaign: base cpm_rate=${context.campaignCpmRate}, max_cpm ceiling=${context.maxCpm}.`,
    `Runway: ${context.runwayPercent} of budget remaining. Runway throttle ${
      context.runwayThrottleApplied ? "IS" : "is NOT"
    } currently applied by the deterministic engine.`,
    "",
    "Clips:",
  ];
  for (const clip of context.clips) {
    const failuresText =
      clip.recentFailures.length > 0 ? clip.recentFailures.map((f) => `    - ${f}`).join("\n") : "    (none)";
    lines.push(
      // clipId is quoted and labeled explicitly (not "Clip X") so Claude echoes the exact
      // raw id back in its response rather than a human-readable label built around it —
      // an earlier real test run showed Claude return clipId: "Clip 1" instead of "1" when
      // the prompt read "- Clip 1: ...".
      `- clipId="${clip.clipId}": recent view velocity=${clip.recentViewVelocity}, deterministic multiplier=${clip.deterministicMultiplier}, deterministic rate=${clip.deterministicRate}.\n` +
        `  Recent settlement failures for this clip:\n${failuresText}`
    );
  }
  return lines.join("\n");
}

/**
 * Applies an LLM-suggested adjustment on top of an already-clamped
 * deterministic rate, then re-clamps to [0, maxCpm] regardless of what the
 * adjustment factor was — this clamp is non-negotiable and runs every time,
 * mirroring pacingEngine.ts's own ceiling clamp. Pure, no I/O, so it can be
 * unit-tested directly (including the "even at the max allowed adjustment
 * factor, the ceiling still holds" case) without a real or stubbed API call.
 * Basis-points arithmetic throughout — adjustmentFactor is only ever
 * converted to a Number for this one multiplication's scaling, never used
 * directly as a float multiplier on the actual rate.
 */
export function applyLlmAdjustment(deterministicRate: bigint, adjustmentFactor: number, maxCpm: bigint): bigint {
  const adjustmentBp = BigInt(Math.round(adjustmentFactor * 10000));
  let rate = (deterministicRate * adjustmentBp) / BP;
  if (rate < 0n) rate = 0n;
  if (rate > maxCpm) rate = maxCpm;
  return rate;
}

/**
 * Runs one Claude API call for the campaign and defensively validates the
 * result. Returns null (never throws) on any failure — API error, timeout,
 * invalid JSON, an out-of-bounds adjustment_factor, or an incomplete set of
 * per-clip responses — so the caller can fall back to the deterministic
 * result unconditionally. A partially-valid response is never partially
 * trusted: any single validation failure discards the whole response.
 */
export async function getLlmAdjustments(
  context: LlmCampaignContext,
  client: AnthropicMessagesClient = getDefaultClient()
): Promise<LlmAdjustment[] | null> {
  if (context.clips.length === 0) return [];

  let response: ParsedMessage<AdjustmentsResponse>;
  try {
    response = await client.messages.parse(
      {
        model: MODEL,
        max_tokens: 4096,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildUserPrompt(context) }],
        output_config: { format: zodOutputFormat(AdjustmentsResponseSchema) },
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err: any) {
    console.error(`[pacing:llm] API call failed — falling back to deterministic-only result. ${err?.message ?? err}`);
    return null;
  }

  if (response.stop_reason === "refusal") {
    console.error("[pacing:llm] Claude declined the request (refusal) — falling back to deterministic-only result.");
    return null;
  }

  // parsed_output is null if the response didn't parse/validate against the schema
  // (e.g. truncated output, or — pre-structured-output — a markdown-fenced response;
  // structured output mode makes this failure mode rare but client.messages.parse()
  // still guards against it rather than assuming success).
  const parsed = response.parsed_output;
  if (!parsed) {
    console.error("[pacing:llm] Response did not parse against the expected schema (parsed_output is null) — falling back to deterministic-only result.");
    return null;
  }

  const expectedClipIds = new Set(context.clips.map((c) => c.clipId));
  const seenClipIds = new Set<string>();
  const result: LlmAdjustment[] = [];

  for (const entry of parsed.adjustments) {
    if (typeof entry?.clipId !== "string" || typeof entry?.rationale !== "string" || entry.rationale.length === 0) {
      console.error(`[pacing:llm] Malformed adjustment entry — falling back to deterministic-only result. Entry: ${JSON.stringify(entry)}`);
      return null;
    }
    if (!expectedClipIds.has(entry.clipId)) {
      console.error(`[pacing:llm] Response referenced unknown clipId "${entry.clipId}" — falling back to deterministic-only result.`);
      return null;
    }
    if (seenClipIds.has(entry.clipId)) {
      console.error(`[pacing:llm] Response contained a duplicate entry for clipId "${entry.clipId}" — falling back to deterministic-only result.`);
      return null;
    }

    let adjustmentFactor = 1.0;
    if (entry.adjustment_factor !== undefined) {
      if (typeof entry.adjustment_factor !== "number" || !Number.isFinite(entry.adjustment_factor)) {
        console.error(`[pacing:llm] Non-numeric adjustment_factor for clip "${entry.clipId}" — falling back to deterministic-only result.`);
        return null;
      }
      if (entry.adjustment_factor < MIN_ADJUSTMENT_FACTOR || entry.adjustment_factor > MAX_ADJUSTMENT_FACTOR) {
        console.error(
          `[pacing:llm] adjustment_factor ${entry.adjustment_factor} for clip "${entry.clipId}" is outside the allowed [${MIN_ADJUSTMENT_FACTOR}, ${MAX_ADJUSTMENT_FACTOR}] bound — falling back to deterministic-only result.`
        );
        return null;
      }
      adjustmentFactor = entry.adjustment_factor;
    }

    seenClipIds.add(entry.clipId);
    result.push({ clipId: entry.clipId, adjustmentFactor, rationale: entry.rationale });
  }

  if (seenClipIds.size !== expectedClipIds.size) {
    console.error(
      `[pacing:llm] Response covered ${seenClipIds.size}/${expectedClipIds.size} clips — falling back to deterministic-only result.`
    );
    return null;
  }

  return result;
}
