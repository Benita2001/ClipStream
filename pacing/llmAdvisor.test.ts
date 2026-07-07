import { expect } from "chai";
import {
  getLlmAdjustments,
  applyLlmAdjustment,
  AnthropicMessagesClient,
  LlmCampaignContext,
  MIN_ADJUSTMENT_FACTOR,
  MAX_ADJUSTMENT_FACTOR,
} from "./llmAdvisor";

/** Wraps a canned ParsedMessage-shaped response (or a thrown error) as a fake client. */
function fakeClient(respond: () => Promise<any>): AnthropicMessagesClient {
  return { messages: { parse: respond } };
}

/** parsed_output = null simulates the real SDK's own schema-parse failure (e.g. truncated
 * or otherwise non-conformant output) — getLlmAdjustments must treat that the same as any
 * other malformed-response case: fall back, don't throw. */
function parsedResponse(parsed_output: any, stopReason: string = "end_turn") {
  return { stop_reason: stopReason, parsed_output };
}

const baseContext: LlmCampaignContext = {
  campaignCpmRate: "100000",
  maxCpm: "200000",
  runwayPercent: "80.0%",
  runwayThrottleApplied: false,
  clips: [
    { clipId: "1", recentViewVelocity: "500", deterministicMultiplier: "1.20x", deterministicRate: "120000", recentFailures: [] },
    { clipId: "2", recentViewVelocity: "100", deterministicMultiplier: "0.80x", deterministicRate: "80000", recentFailures: ["rate-ceiling reject: computed 250000 exceeds max_cpm 200000"] },
  ],
};

describe("getLlmAdjustments (defensive parsing + fallback)", () => {
  it("returns [] immediately for a campaign with no clips, without calling the API", async () => {
    const client = fakeClient(async () => {
      throw new Error("should never be called");
    });
    const result = await getLlmAdjustments({ ...baseContext, clips: [] }, client);
    expect(result).to.deep.equal([]);
  });

  it("applies a well-formed, in-bounds response", async () => {
    const client = fakeClient(async () =>
      parsedResponse({
        adjustments: [
          { clipId: "1", adjustment_factor: 1.1, rationale: "Clip 1 has strong sustained velocity relative to clip 2; nudging it up slightly." },
          { clipId: "2", rationale: "Clip 2 has a recent rate-ceiling rejection on record; leaving its rate unchanged rather than compounding the risk." },
        ],
      })
    );
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.not.equal(null);
    const byClip = new Map(result!.map((a) => [a.clipId, a]));
    expect(byClip.get("1")!.adjustmentFactor).to.equal(1.1);
    expect(byClip.get("1")!.rationale).to.include("velocity");
    // clip 2 omitted adjustment_factor -> defaults to 1.0 (documented choice: omission means "no opinion")
    expect(byClip.get("2")!.adjustmentFactor).to.equal(1.0);
  });

  it("[Real test 2a] falls back to null when parsed_output is null (schema-parse failure), without throwing", async () => {
    const client = fakeClient(async () => parsedResponse(null));
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.equal(null);
  });

  it("[Real test 2b] falls back to null when adjustment_factor is out of the stated bound", async () => {
    const client = fakeClient(async () =>
      parsedResponse({
        adjustments: [
          { clipId: "1", adjustment_factor: 5.0, rationale: "way too aggressive" },
          { clipId: "2", rationale: "no change" },
        ],
      })
    );
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.equal(null);
  });

  it("[Real test 2c] falls back to null when the response omits a clip that was sent (incomplete coverage)", async () => {
    const client = fakeClient(async () => parsedResponse({ adjustments: [{ clipId: "1", rationale: "only clip 1, clip 2 missing" }] }));
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.equal(null);
  });

  it("[Real test 2d] falls back to null on a response missing the required rationale field", async () => {
    const client = fakeClient(async () =>
      parsedResponse({ adjustments: [{ clipId: "1", adjustment_factor: 1.0 }, { clipId: "2", rationale: "fine" }] })
    );
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.equal(null);
  });

  it("[Real test 2e] falls back to null when the response references an unknown clipId", async () => {
    const client = fakeClient(async () =>
      parsedResponse({
        adjustments: [
          { clipId: "1", rationale: "fine" },
          { clipId: "999-does-not-exist", rationale: "hallucinated clip" },
        ],
      })
    );
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.equal(null);
  });

  it("[Real test 3] falls back to null on an API error/timeout, without throwing", async () => {
    const client = fakeClient(async () => {
      throw new Error("simulated network timeout");
    });
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.equal(null);
  });

  it("falls back to null when Claude refuses the request (stop_reason: refusal)", async () => {
    const client = fakeClient(async () => parsedResponse(null, "refusal"));
    const result = await getLlmAdjustments(baseContext, client);
    expect(result).to.equal(null);
  });
});

describe("applyLlmAdjustment (pure, non-negotiable max_cpm clamp)", () => {
  it("applies an in-bounds adjustment factor normally", () => {
    expect(applyLlmAdjustment(100_000n, 1.1, 200_000n)).to.equal(110_000n);
    expect(applyLlmAdjustment(100_000n, 0.9, 200_000n)).to.equal(90_000n);
  });

  it("[Real test 4] never exceeds max_cpm even at the maximum allowed adjustment_factor", () => {
    // Deterministic rate already near the ceiling; even the max allowed 1.2x must not push past maxCpm.
    const maxCpm = 200_000n;
    const deterministicRate = 190_000n;
    const result = applyLlmAdjustment(deterministicRate, MAX_ADJUSTMENT_FACTOR, maxCpm);
    expect(result).to.equal(maxCpm);
    expect(Number(result)).to.be.at.most(Number(maxCpm));
  });

  it("[Real test 4b] never exceeds max_cpm even when the deterministic rate is already exactly at the ceiling", () => {
    const maxCpm = 200_000n;
    const result = applyLlmAdjustment(maxCpm, MAX_ADJUSTMENT_FACTOR, maxCpm);
    expect(result).to.equal(maxCpm);
  });

  it("never goes negative at the minimum allowed adjustment_factor", () => {
    const result = applyLlmAdjustment(100_000n, MIN_ADJUSTMENT_FACTOR, 200_000n);
    expect(result).to.equal(80_000n);
    expect(result >= 0n).to.equal(true);
  });
});
