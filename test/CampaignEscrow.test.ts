import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { CampaignEscrow } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("CampaignEscrow", () => {
  let escrow: CampaignEscrow;
  let organizer: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let clipper: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const BASE_RATE = 100n; // arbitrary units
  const MAX_DURATION = 60n * 60n * 24n * 30n; // 30 days
  const INITIAL_DEPOSIT = 1_000_000n; // 1 USDC (6 decimals) — sent as native value (msg.value), not an ERC20 transfer

  beforeEach(async () => {
    [organizer, agent, clipper, stranger] = await ethers.getSigners();

    const CampaignEscrowFactory = await ethers.getContractFactory("CampaignEscrow");
    escrow = await CampaignEscrowFactory.deploy();
    await escrow.waitForDeployment();
  });

  it("creates and funds a campaign atomically", async () => {
    const tx = await escrow
      .connect(organizer)
      .createCampaign(BASE_RATE, MAX_DURATION, agent.address, { value: INITIAL_DEPOSIT });
    await expect(tx)
      .to.emit(escrow, "CampaignCreated")
      .withArgs(0n, organizer.address, agent.address, BASE_RATE, MAX_DURATION, INITIAL_DEPOSIT);

    expect(await escrow.getCampaignBalance(0)).to.equal(INITIAL_DEPOSIT);
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(INITIAL_DEPOSIT);
  });

  it("reverts createCampaign with zero value", async () => {
    await expect(
      escrow.connect(organizer).createCampaign(BASE_RATE, MAX_DURATION, agent.address, { value: 0n })
    ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
  });

  it("lets the organizer top up an existing campaign", async () => {
    await escrow.connect(organizer).createCampaign(BASE_RATE, MAX_DURATION, agent.address, { value: INITIAL_DEPOSIT });

    const balanceBefore = await escrow.getCampaignBalance(0);
    const topUpAmount = 500_000n;

    await expect(escrow.connect(organizer).topUp(0, { value: topUpAmount }))
      .to.emit(escrow, "CampaignFunded")
      .withArgs(0n, organizer.address, topUpAmount, balanceBefore + topUpAmount);

    expect(await escrow.getCampaignBalance(0)).to.equal(balanceBefore + topUpAmount);
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(balanceBefore + topUpAmount);
  });

  describe("release", () => {
    beforeEach(async () => {
      await escrow.connect(organizer).createCampaign(BASE_RATE, MAX_DURATION, agent.address, { value: INITIAL_DEPOSIT });
    });

    it("happy path: pays the clipper (native value) and decrements the campaign balance", async () => {
      const settlementId = ethers.id("settlement-1");
      const amount = 10_000n;

      // clipper never sends a transaction here (agent does), so no gas-cost
      // accounting is needed on this side of the balance check.
      const clipperBalanceBefore = await ethers.provider.getBalance(clipper.address);
      const campaignBalanceBefore = await escrow.getCampaignBalance(0);

      await expect(escrow.connect(agent).release(0, clipper.address, amount, settlementId))
        .to.emit(escrow, "PayoutReleased")
        .withArgs(0n, clipper.address, amount, settlementId);

      expect(await ethers.provider.getBalance(clipper.address)).to.equal(clipperBalanceBefore + amount);
      expect(await escrow.getCampaignBalance(0)).to.equal(campaignBalanceBefore - amount);
    });

    it("access control: reverts if called by anyone other than the authorized agent", async () => {
      await expect(
        escrow.connect(stranger).release(0, clipper.address, 10_000n, ethers.id("s-access"))
      ).to.be.revertedWithCustomError(escrow, "NotAuthorizedAgent");
    });

    it("insufficient balance: reverts if releasing more than the campaign has left", async () => {
      const campaignBalance = await escrow.getCampaignBalance(0);

      await expect(
        escrow.connect(agent).release(0, clipper.address, campaignBalance + 1n, ethers.id("s-insufficient"))
      ).to.be.revertedWithCustomError(escrow, "InsufficientCampaignBalance");
    });

    it("reused settlementId: reverts and does not pay the clipper a second time (double-pay protection)", async () => {
      const settlementId = ethers.id("settlement-retry");
      const amount = 10_000n;

      await escrow.connect(agent).release(0, clipper.address, amount, settlementId);
      const clipperBalanceAfterFirstRelease = await ethers.provider.getBalance(clipper.address);

      await expect(
        escrow.connect(agent).release(0, clipper.address, amount, settlementId)
      ).to.be.revertedWithCustomError(escrow, "SettlementAlreadyUsed");

      // the idempotency check must happen before any transfer — confirm no second payout landed
      expect(await ethers.provider.getBalance(clipper.address)).to.equal(clipperBalanceAfterFirstRelease);
    });

    it("reentrancy: a malicious clipper contract cannot re-enter release() to drain extra funds", async () => {
      const ReentrantClipperFactory = await ethers.getContractFactory("ReentrantClipper");
      const reentrantClipper = await ReentrantClipperFactory.deploy(await escrow.getAddress());
      await reentrantClipper.waitForDeployment();
      const reentrantClipperAddress = await reentrantClipper.getAddress();

      const amount = 10_000n;
      const campaignBalanceBefore = await escrow.getCampaignBalance(0);

      // The attacker contract's receive() hook tries to call release() again with a
      // *different* settlementId (so it isn't just caught by the idempotency check) —
      // nonReentrant on release() must be what stops it, not incidental luck.
      await reentrantClipper.armReentry(1, ethers.id("settlement-reentry-attempt"));

      await escrow.connect(agent).release(0, reentrantClipperAddress, amount, ethers.id("settlement-original"));

      // Only the single, legitimate release should have gone through.
      expect(await ethers.provider.getBalance(reentrantClipperAddress)).to.equal(amount);
      expect(await escrow.getCampaignBalance(0)).to.equal(campaignBalanceBefore - amount);
      expect(await escrow.usedSettlementIds(ethers.id("settlement-reentry-attempt"))).to.equal(false);
    });
  });

  describe("withdrawRemaining", () => {
    it("reverts before maxDuration has elapsed", async () => {
      await escrow.connect(organizer).createCampaign(BASE_RATE, MAX_DURATION, agent.address, { value: INITIAL_DEPOSIT });

      await expect(escrow.connect(organizer).withdrawRemaining(0)).to.be.revertedWithCustomError(
        escrow,
        "MaxDurationNotElapsed"
      );
    });

    it("returns unspent funds to the organizer after maxDuration, and a second withdraw reverts", async () => {
      const maxDuration = 1_000n;
      await escrow.connect(organizer).createCampaign(BASE_RATE, maxDuration, agent.address, { value: INITIAL_DEPOSIT });
      await escrow.connect(agent).release(0, clipper.address, 10_000n, ethers.id("s-before-close"));

      await time.increase(Number(maxDuration) + 1);

      const remaining = await escrow.getCampaignBalance(0);
      const organizerBalanceBefore = await ethers.provider.getBalance(organizer.address);

      const tx = await escrow.connect(organizer).withdrawRemaining(0);
      await expect(tx).to.emit(escrow, "CampaignClosed").withArgs(0n, organizer.address, remaining);

      // organizer both calls this (pays gas) and receives `remaining` in the same
      // tx, so the balance delta must account for gas cost explicitly, not just
      // add `remaining` — this is native value, not an ERC20 transfer to a
      // separate, non-gas-paying recipient like the release() test above.
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      expect(await ethers.provider.getBalance(organizer.address)).to.equal(
        organizerBalanceBefore + remaining - gasCost
      );
      expect(await escrow.getCampaignBalance(0)).to.equal(0);

      await expect(escrow.connect(organizer).withdrawRemaining(0)).to.be.revertedWithCustomError(
        escrow,
        "CampaignAlreadyClosed"
      );
    });

    it("reverts if called by anyone other than the organizer", async () => {
      const maxDuration = 1_000n;
      await escrow.connect(organizer).createCampaign(BASE_RATE, maxDuration, agent.address, { value: INITIAL_DEPOSIT });
      await time.increase(Number(maxDuration) + 1);

      await expect(escrow.connect(stranger).withdrawRemaining(0)).to.be.revertedWithCustomError(
        escrow,
        "NotOrganizer"
      );
    });
  });
});
