import { expect } from "chai";
import { ethers } from "hardhat";
import { PayoutRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("PayoutRegistry", () => {
  let registry: PayoutRegistry;
  let agent: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let clipper: HardhatEthersSigner;

  beforeEach(async () => {
    [, agent, stranger, clipper] = await ethers.getSigners();

    const PayoutRegistryFactory = await ethers.getContractFactory("PayoutRegistry");
    registry = await PayoutRegistryFactory.deploy(agent.address);
    await registry.waitForDeployment();
  });

  it("happy path: the authorized agent records a payout and PayoutRecorded is emitted with the correct args", async () => {
    const settlementId = ethers.id("settlement-1");
    const campaignId = 1n;
    const viewDelta = 500n;
    const amount = 10_000n;
    const agentRationaleHash = ethers.id("rationale-1");

    await expect(
      registry.connect(agent).recordPayout(settlementId, campaignId, clipper.address, viewDelta, amount, agentRationaleHash)
    )
      .to.emit(registry, "PayoutRecorded")
      .withArgs(settlementId, campaignId, clipper.address, viewDelta, amount, agentRationaleHash);
  });

  it("reused settlementId: a second recordPayout call reverts with SettlementAlreadyRecorded", async () => {
    const settlementId = ethers.id("settlement-retry");

    await registry
      .connect(agent)
      .recordPayout(settlementId, 1n, clipper.address, 500n, 10_000n, ethers.id("rationale-1"));

    // different campaign/clipper/amount/rationale — only settlementId is the idempotency key
    await expect(
      registry
        .connect(agent)
        .recordPayout(settlementId, 2n, stranger.address, 999n, 1n, ethers.id("rationale-2"))
    )
      .to.be.revertedWithCustomError(registry, "SettlementAlreadyRecorded")
      .withArgs(settlementId);
  });

  describe("access control", () => {
    it("reverts if called by anyone other than the authorized agent", async () => {
      await expect(
        registry.connect(stranger).recordPayout(ethers.id("settlement-access"), 1n, clipper.address, 10n, 100n, ethers.id("r"))
      ).to.be.revertedWithCustomError(registry, "NotAuthorizedAgent");
    });

    it("succeeds when called by the authorized agent", async () => {
      await expect(
        registry.connect(agent).recordPayout(ethers.id("settlement-agent-ok"), 1n, clipper.address, 10n, 100n, ethers.id("r"))
      ).to.not.be.reverted;
    });
  });

  it("constructor reverts on a zero-address agent", async () => {
    const PayoutRegistryFactory = await ethers.getContractFactory("PayoutRegistry");
    await expect(PayoutRegistryFactory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      PayoutRegistryFactory,
      "ZeroAddress"
    );
  });

  it("recorded(settlementId) getter reflects state before and after recordPayout", async () => {
    const settlementId = ethers.id("settlement-getter");

    expect(await registry.recorded(settlementId)).to.equal(false);

    await registry
      .connect(agent)
      .recordPayout(settlementId, 1n, clipper.address, 500n, 10_000n, ethers.id("rationale-1"));

    expect(await registry.recorded(settlementId)).to.equal(true);
  });
});
