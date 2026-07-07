import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { CampaignEscrow } from "../typechain-types";

dotenv.config();

/**
 * One-off: creates a genuinely new campaign on the real, already-deployed
 * Arc testnet CampaignEscrow (a fresh contract_campaign_id, distinct from
 * campaign 0 which is already indexed in SQLite), printing the real
 * on-chain campaign id so it can be POSTed to /campaigns for a live
 * end-to-end test of that new endpoint.
 */
async function main() {
  const deploymentsPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));

  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentPrivateKey) throw new Error("Set AGENT_PRIVATE_KEY in .env");
  // TEST_WRONG_AGENT lets this script deliberately create a campaign whose
  // authorizedAgent is NOT ClipStream's configured agent, to test POST
  // /campaigns' agent-mismatch rejection against a real on-chain campaign.
  const agentAddress = process.env.TEST_WRONG_AGENT || new ethers.Wallet(agentPrivateKey).address;

  const [organizer] = await ethers.getSigners();
  const escrow = (await ethers.getContractAt(
    "CampaignEscrow",
    deployments.campaignEscrow,
    organizer
  )) as unknown as CampaignEscrow;

  const baseRate = 100n;
  const maxDuration = 60n * 60n * 24n * 30n;
  const initialDeposit = 5_000n;

  const tx = await escrow.createCampaign(baseRate, maxDuration, agentAddress, { value: initialDeposit });
  const receipt = await tx.wait();

  const event = receipt?.logs
    .map((log) => {
      try {
        return escrow.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "CampaignCreated");
  const campaignId = event?.args.campaignId.toString();

  console.log(JSON.stringify({ contractCampaignId: campaignId, organizer: organizer.address, agentAddress, txHash: receipt?.hash }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
