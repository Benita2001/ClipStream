import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { CampaignEscrow } from "../typechain-types";

dotenv.config();

/**
 * Manual, network-facing walkthrough of the escrow lifecycle: create campaign
 * -> fund -> release (as the authorized agent) -> verify the clipper's on-chain
 * native USDC balance increased -> reuse the same settlementId and confirm it
 * reverts.
 *
 * This complements (does not replace) test/CampaignEscrow.test.ts, which covers
 * the same cases plus edge cases locally. This script is meant to be run
 * against a real deployment (Arc Testnet, via `npm run flow:arc-testnet`) to
 * prove the deployed bytecode behaves the same way with real USDC (Arc's
 * native gas currency, not an ERC20 token) and real gas.
 */
async function main() {
  const deploymentsPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`No deployments file at ${deploymentsPath} — run the deploy script first.`);
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));

  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  const clipperAddress = process.env.CLIPPER_ADDRESS;
  if (!agentPrivateKey) throw new Error("Set AGENT_PRIVATE_KEY in .env — a funded wallet to act as the Settlement Agent.");
  if (!clipperAddress) throw new Error("Set CLIPPER_ADDRESS in .env — the payout recipient for this test.");

  const [organizer] = await ethers.getSigners();
  const agent = new ethers.Wallet(agentPrivateKey, ethers.provider);

  console.log(`Organizer: ${organizer.address}`);
  console.log(`Agent:     ${agent.address}`);
  console.log(`Clipper:   ${clipperAddress}`);

  const escrow = (await ethers.getContractAt(
    "CampaignEscrow",
    deployments.campaignEscrow,
    organizer
  )) as unknown as CampaignEscrow;

  const baseRate = 100n;
  const maxDuration = 60n * 60n; // 1 hour
  const initialDeposit = 100_000n; // 0.1 USDC at 6 decimals, sent as native value

  console.log("\n1) createCampaign — depositing (native value) and creating in one tx");
  const createTx = await escrow.createCampaign(baseRate, maxDuration, agent.address, { value: initialDeposit });
  const createReceipt = await createTx.wait();
  const campaignId = 0n; // first campaign on a fresh contract; adjust if reusing a deployment
  console.log(`   campaign created in tx ${createReceipt?.hash}, balance = ${await escrow.getCampaignBalance(campaignId)}`);

  console.log("\n2) topUp — adding more native value");
  const topUpAmount = 50_000n;
  await (await escrow.topUp(campaignId, { value: topUpAmount })).wait();
  console.log(`   balance after top-up = ${await escrow.getCampaignBalance(campaignId)}`);

  console.log("\n3) release — as the authorized agent");
  const releaseAmount = 10_000n;
  const settlementId = ethers.id(`manual-test-flow-${Date.now()}`);
  const clipperBalanceBefore: bigint = await ethers.provider.getBalance(clipperAddress);

  const releaseTx = await (escrow.connect(agent) as CampaignEscrow).release(
    campaignId,
    clipperAddress,
    releaseAmount,
    settlementId
  );
  await releaseTx.wait();

  const clipperBalanceAfter: bigint = await ethers.provider.getBalance(clipperAddress);
  const delta = clipperBalanceAfter - clipperBalanceBefore;
  console.log(`   clipper balance delta = ${delta} (expected ${releaseAmount})`);
  if (delta !== releaseAmount) {
    throw new Error("Clipper balance did not increase by the released amount.");
  }
  console.log("   OK: clipper balance increased by exactly the released amount");

  console.log("\n4) release again with the SAME settlementId — expecting a revert");
  try {
    await (escrow.connect(agent) as CampaignEscrow).release(campaignId, clipperAddress, releaseAmount, settlementId);
    throw new Error("Expected reused settlementId to revert, but it did not.");
  } catch (err: any) {
    if (err.message?.includes("SettlementAlreadyUsed") || err.message?.includes("Expected reused")) {
      if (err.message?.includes("Expected reused")) throw err;
      console.log("   OK: reused settlementId reverted with SettlementAlreadyUsed as expected");
    } else {
      throw err;
    }
  }

  console.log("\nAll checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
