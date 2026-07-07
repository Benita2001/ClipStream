import { expect } from "chai";
import { computePacingDecisions, PacingInput } from "./pacingEngine";

function decisionFor(decisions: ReturnType<typeof computePacingDecisions>, clipId: string) {
  const d = decisions.find((x) => x.clipId === clipId);
  if (!d) throw new Error(`no decision for clip ${clipId}`);
  return d;
}

describe("computePacingDecisions (pure, BigInt)", () => {
  describe("even split", () => {
    it("gives every clip ~1x (unchanged) when all clips have equal velocity", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 1_000_000n, // generous, shouldn't be hit
        remainingBalance: 800n,
        totalBudget: 1_000n, // 80% runway, well above the 20% threshold
        clips: [
          { clipId: "1", recentViewVelocity: 100n },
          { clipId: "2", recentViewVelocity: 100n },
          { clipId: "3", recentViewVelocity: 100n },
          { clipId: "4", recentViewVelocity: 100n },
        ],
      };
      const decisions = computePacingDecisions(input);
      for (const clipId of ["1", "2", "3", "4"]) {
        const d = decisionFor(decisions, clipId);
        expect(d.effectiveCpmRate).to.equal(100_000n); // exactly base rate, 1.0x multiplier
        expect(d.rationale).to.include("1.00x multiplier");
      }
    });
  });

  describe("one dominant clip vs others", () => {
    it("boosts the dominant clip above 1x and throttles the others below 1x", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 1_000_000n, // generous, shouldn't be hit
        remainingBalance: 800n,
        totalBudget: 1_000n,
        clips: [
          { clipId: "dominant", recentViewVelocity: 800n },
          { clipId: "other-a", recentViewVelocity: 100n },
          { clipId: "other-b", recentViewVelocity: 100n },
        ],
      };
      const decisions = computePacingDecisions(input);

      const dominant = decisionFor(decisions, "dominant");
      const otherA = decisionFor(decisions, "other-a");
      const otherB = decisionFor(decisions, "other-b");

      // hand-computed: dominant share 80%, n=3 → multiplier 5000 + 800*3*5000/1000 = 17000bp = 1.7x
      expect(dominant.effectiveCpmRate).to.equal(170_000n);
      // other: share 10%, multiplier 5000 + 100*3*5000/1000 = 6500bp = 0.65x
      expect(otherA.effectiveCpmRate).to.equal(65_000n);
      expect(otherB.effectiveCpmRate).to.equal(65_000n);

      expect(Number(dominant.effectiveCpmRate)).to.be.greaterThan(100_000);
      expect(Number(otherA.effectiveCpmRate)).to.be.lessThan(100_000);
    });
  });

  describe("all-zero-velocity case", () => {
    it("reverts every clip to null (campaign base rate) when nobody has recent velocity", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 1_000_000n,
        remainingBalance: 800n,
        totalBudget: 1_000n,
        clips: [
          { clipId: "1", recentViewVelocity: 0n },
          { clipId: "2", recentViewVelocity: 0n },
          { clipId: "3", recentViewVelocity: 0n },
        ],
      };
      const decisions = computePacingDecisions(input);
      for (const clipId of ["1", "2", "3"]) {
        const d = decisionFor(decisions, clipId);
        expect(d.effectiveCpmRate).to.equal(null);
        expect(d.rationale).to.include("no recent view velocity");
      }
    });

    it("reverts only the zero-velocity clip to null when mixed with active clips", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 1_000_000n,
        remainingBalance: 800n,
        totalBudget: 1_000n,
        clips: [
          { clipId: "active", recentViewVelocity: 500n },
          { clipId: "idle", recentViewVelocity: 0n },
        ],
      };
      const decisions = computePacingDecisions(input);
      expect(decisionFor(decisions, "idle").effectiveCpmRate).to.equal(null);
      expect(decisionFor(decisions, "active").effectiveCpmRate).to.not.equal(null);
    });
  });

  describe("max_cpm clamp", () => {
    it("clamps a rate that would otherwise exceed the ceiling, and says so in the rationale", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 120_000n, // tight ceiling — only 1.2x headroom
        remainingBalance: 800n,
        totalBudget: 1_000n,
        clips: [
          // 2 clips, n=2: dominant share 80%, multiplier 5000 + 800*2*5000/1000 = 13000bp = 1.3x, rawRate 130000
          { clipId: "dominant", recentViewVelocity: 800n },
          { clipId: "other", recentViewVelocity: 200n },
        ],
      };
      const decisions = computePacingDecisions(input);
      const dominant = decisionFor(decisions, "dominant");

      expect(dominant.effectiveCpmRate).to.equal(120_000n); // clamped, not 130000
      expect(dominant.rationale).to.include("HIT ceiling 120000");
      expect(dominant.rationale).to.include("clamped from 130000 to 120000");
    });
  });

  describe("runway throttle", () => {
    it("applies the 0.7x global dampening when remainingBalance/totalBudget is below 20%", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 1_000_000n,
        remainingBalance: 150n,
        totalBudget: 1_000n, // 15% runway, below the 20% threshold
        clips: [
          { clipId: "1", recentViewVelocity: 100n },
          { clipId: "2", recentViewVelocity: 100n },
        ],
      };
      const decisions = computePacingDecisions(input);
      // even split → 1.0x multiplier → rate 100000 pre-throttle, then *0.7 = 70000
      for (const clipId of ["1", "2"]) {
        const d = decisionFor(decisions, clipId);
        expect(d.effectiveCpmRate).to.equal(70_000n);
        expect(d.rationale).to.include("below 20.0% threshold");
        expect(d.rationale).to.include("0.70x throttle applied");
      }
    });

    it("does not throttle when runway is comfortably above the threshold", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 1_000_000n,
        remainingBalance: 500n,
        totalBudget: 1_000n, // 50% runway
        clips: [
          { clipId: "1", recentViewVelocity: 100n },
          { clipId: "2", recentViewVelocity: 100n },
        ],
      };
      const decisions = computePacingDecisions(input);
      expect(decisionFor(decisions, "1").effectiveCpmRate).to.equal(100_000n);
      expect(decisionFor(decisions, "1").rationale).to.include("no throttle applied");
    });
  });

  describe("extreme dominance never violates the max_cpm ceiling", () => {
    it("clamps exactly to maxCpm even when one clip has an overwhelming velocity share among many clips", () => {
      // 10 clips: one with 9910 velocity, nine others sharing 90 total (10 each).
      // Dominant share ~99.1%; with n=10 the naive multiplier is huge (~5.46x),
      // deliberately constructed to blow well past any reasonable ceiling.
      const clips = [{ clipId: "dominant", recentViewVelocity: 9910n }];
      for (let i = 0; i < 9; i++) {
        clips.push({ clipId: `minor-${i}`, recentViewVelocity: 10n });
      }
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 200_000n,
        remainingBalance: 800n,
        totalBudget: 1_000n,
        clips,
      };
      const decisions = computePacingDecisions(input);
      const dominant = decisionFor(decisions, "dominant");

      expect(dominant.effectiveCpmRate).to.equal(200_000n); // clamped hard to the ceiling
      expect(Number(dominant.effectiveCpmRate)).to.be.at.most(Number(input.maxCpm));
      expect(dominant.rationale).to.include("HIT ceiling 200000");

      // every other clip's rate must also never exceed maxCpm
      for (const d of decisions) {
        if (d.effectiveCpmRate !== null) {
          expect(Number(d.effectiveCpmRate)).to.be.at.most(Number(input.maxCpm));
        }
      }
    });
  });

  describe("single clip", () => {
    it("gets exactly the base rate (1x) regardless of its velocity, since it's 100% of the campaign's velocity", () => {
      const input: PacingInput = {
        campaignCpmRate: 100_000n,
        maxCpm: 1_000_000n,
        remainingBalance: 800n,
        totalBudget: 1_000n,
        clips: [{ clipId: "only", recentViewVelocity: 42n }],
      };
      const decisions = computePacingDecisions(input);
      expect(decisionFor(decisions, "only").effectiveCpmRate).to.equal(100_000n);
    });
  });
});
