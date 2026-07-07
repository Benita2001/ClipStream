import { expect } from "chai";
import { validateViewDelta, ViewDeltaEvent, MAX_PLAUSIBLE_VIEWS_PER_SECOND } from "./engine";

function baseEvent(overrides: Partial<ViewDeltaEvent> = {}): ViewDeltaEvent {
  return {
    clipId: "clip-1",
    tweetId: "1234567890",
    previousImpressionCount: 1000,
    currentImpressionCount: 1050,
    previousPolledAt: "2026-07-06T00:00:00.000Z",
    currentPolledAt: "2026-07-06T00:01:00.000Z", // 60s later
    ...overrides,
  };
}

describe("validateViewDelta (heuristic view-delta validator)", () => {
  describe("negative delta", () => {
    it("rejects when impression_count drops between polls", () => {
      const result = validateViewDelta(
        baseEvent({ previousImpressionCount: 1000, currentImpressionCount: 900 })
      );
      expect(result.status).to.equal("REJECTED");
      expect(result.reason).to.include("should only climb");
    });

    it("approves a zero delta (no new views since last poll)", () => {
      const result = validateViewDelta(
        baseEvent({ previousImpressionCount: 1000, currentImpressionCount: 1000 })
      );
      expect(result.status).to.equal("APPROVED");
    });

    it("approves a normal positive delta", () => {
      const result = validateViewDelta(
        baseEvent({ previousImpressionCount: 1000, currentImpressionCount: 1050 })
      );
      expect(result.status).to.equal("APPROVED");
      expect(result.reason).to.include("approved");
    });
  });

  describe("non-positive poll interval", () => {
    it("rejects when currentPolledAt equals previousPolledAt", () => {
      const result = validateViewDelta(
        baseEvent({ previousPolledAt: "2026-07-06T00:00:00.000Z", currentPolledAt: "2026-07-06T00:00:00.000Z" })
      );
      expect(result.status).to.equal("REJECTED");
      expect(result.reason).to.include("cannot validate a rate");
    });

    it("rejects when currentPolledAt is before previousPolledAt", () => {
      const result = validateViewDelta(
        baseEvent({ previousPolledAt: "2026-07-06T00:01:00.000Z", currentPolledAt: "2026-07-06T00:00:00.000Z" })
      );
      expect(result.status).to.equal("REJECTED");
      expect(result.reason).to.include("cannot validate a rate");
    });

    it("approves when the interval is positive, even if short", () => {
      const result = validateViewDelta(
        baseEvent({
          previousImpressionCount: 1000,
          currentImpressionCount: 1010,
          previousPolledAt: "2026-07-06T00:00:00.000Z",
          currentPolledAt: "2026-07-06T00:00:01.000Z", // 1s later
        })
      );
      expect(result.status).to.equal("APPROVED");
    });
  });

  describe("implausible jump given elapsed time", () => {
    it("rejects when the views-per-second rate exceeds the plausible ceiling", () => {
      const elapsedSeconds = 10;
      const delta = (MAX_PLAUSIBLE_VIEWS_PER_SECOND + 100) * elapsedSeconds;
      const result = validateViewDelta(
        baseEvent({
          previousImpressionCount: 1000,
          currentImpressionCount: 1000 + delta,
          previousPolledAt: "2026-07-06T00:00:00.000Z",
          currentPolledAt: "2026-07-06T00:00:10.000Z",
        })
      );
      expect(result.status).to.equal("REJECTED");
      expect(result.reason).to.include("implausible jump");
    });

    it("approves when the rate is right at the plausible ceiling", () => {
      const elapsedSeconds = 10;
      const delta = MAX_PLAUSIBLE_VIEWS_PER_SECOND * elapsedSeconds;
      const result = validateViewDelta(
        baseEvent({
          previousImpressionCount: 1000,
          currentImpressionCount: 1000 + delta,
          previousPolledAt: "2026-07-06T00:00:00.000Z",
          currentPolledAt: "2026-07-06T00:00:10.000Z",
        })
      );
      expect(result.status).to.equal("APPROVED");
    });

    it("approves a large but plausible viral-spike delta over a longer interval", () => {
      const result = validateViewDelta(
        baseEvent({
          previousImpressionCount: 10_000,
          currentImpressionCount: 500_000,
          previousPolledAt: "2026-07-06T00:00:00.000Z",
          currentPolledAt: "2026-07-06T01:00:00.000Z", // 1 hour later, ~136/s
        })
      );
      expect(result.status).to.equal("APPROVED");
    });
  });

  describe("approve otherwise", () => {
    it("approves a plausible, well-formed view-delta event", () => {
      const result = validateViewDelta(baseEvent());
      expect(result.status).to.equal("APPROVED");
      expect(result.reason).to.include("approved");
    });
  });
});
