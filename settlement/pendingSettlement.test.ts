import { expect } from "chai";
import { computeSettlementAmount, computeSettlementId, clampToRemainingCap } from "./pendingSettlement";

describe("computeSettlementAmount (pure, BigInt)", () => {
  it("multiplies viewDelta by baseRate", () => {
    expect(computeSettlementAmount(50n, 100n)).to.equal(5_000n);
  });

  it("returns 0 for a zero delta", () => {
    expect(computeSettlementAmount(0n, 100n)).to.equal(0n);
  });

  it("preserves full precision beyond Number.MAX_SAFE_INTEGER", () => {
    // Number.MAX_SAFE_INTEGER is 9_007_199_254_740_991. Construct a product that
    // exceeds it and confirm BigInt arithmetic keeps every digit — the whole
    // point of not using JS Number here.
    const viewDelta = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2, deliberately unsafe as a Number
    const baseRate = 3n;
    const expected = 27_021_597_764_222_979n;

    expect(computeSettlementAmount(viewDelta, baseRate)).to.equal(expected);
    // Sanity check that this value genuinely can't round-trip through Number:
    // converting to Number and back to BigInt loses the last digit to float64
    // rounding, which is exactly the failure mode this function avoids.
    expect(BigInt(Number(viewDelta))).to.not.equal(viewDelta);
  });

  it("is commutative and consistent regardless of argument order in practice", () => {
    expect(computeSettlementAmount(7n, 11n)).to.equal(computeSettlementAmount(11n, 7n));
  });
});

describe("computeSettlementId (pure, deterministic)", () => {
  it("produces a 32-byte hex string (bytes32-compatible)", () => {
    const id = computeSettlementId(1, "2026-07-06T14:01:53.592Z");
    expect(id).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic: same clipId + polledAt always yields the same id", () => {
    const a = computeSettlementId(42, "2026-07-06T14:01:53.592Z");
    const b = computeSettlementId(42, "2026-07-06T14:01:53.592Z");
    expect(a).to.equal(b);
  });

  it("differs when clipId differs", () => {
    const a = computeSettlementId(1, "2026-07-06T14:01:53.592Z");
    const b = computeSettlementId(2, "2026-07-06T14:01:53.592Z");
    expect(a).to.not.equal(b);
  });

  it("differs when polledAt differs", () => {
    const a = computeSettlementId(1, "2026-07-06T14:01:53.592Z");
    const b = computeSettlementId(1, "2026-07-06T14:02:24.450Z");
    expect(a).to.not.equal(b);
  });
});

describe("clampToRemainingCap (pure, BigInt)", () => {
  it("returns the full amount unchanged when null (uncapped)", () => {
    const result = clampToRemainingCap({ requestedAmount: 500n, alreadyPaid: 10_000n, cap: null });
    expect(result).to.deep.equal({ payableAmount: 500n, isCapped: false });
  });

  it("returns the full amount unchanged when comfortably under the cap", () => {
    const result = clampToRemainingCap({ requestedAmount: 100n, alreadyPaid: 200n, cap: 1_000n });
    expect(result).to.deep.equal({ payableAmount: 100n, isCapped: false });
  });

  it("returns the full amount, not capped, when it lands exactly on the cap boundary", () => {
    // alreadyPaid + requestedAmount === cap exactly: this payment itself isn't
    // reduced, so isCapped is false here — the *next* attempt against this
    // clip is what discovers the cap is now exhausted (see doc comment).
    const result = clampToRemainingCap({ requestedAmount: 300n, alreadyPaid: 700n, cap: 1_000n });
    expect(result).to.deep.equal({ payableAmount: 300n, isCapped: false });
  });

  it("clamps to whatever remains when the request would exceed the cap", () => {
    const result = clampToRemainingCap({ requestedAmount: 500n, alreadyPaid: 700n, cap: 1_000n });
    expect(result).to.deep.equal({ payableAmount: 300n, isCapped: true });
  });

  it("returns zero and isCapped=true when the cap is already fully spent", () => {
    const result = clampToRemainingCap({ requestedAmount: 100n, alreadyPaid: 1_000n, cap: 1_000n });
    expect(result).to.deep.equal({ payableAmount: 0n, isCapped: true });
  });

  it("returns zero and isCapped=true when alreadyPaid has somehow exceeded the cap", () => {
    const result = clampToRemainingCap({ requestedAmount: 100n, alreadyPaid: 1_200n, cap: 1_000n });
    expect(result).to.deep.equal({ payableAmount: 0n, isCapped: true });
  });
});
