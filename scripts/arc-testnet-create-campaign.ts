import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { CampaignEscrow } from "../typechain-types";

dotenv.config();

/**
 * One-off: creates and funds one real campaign on the just-deployed Arc
 * testnet CampaignEscrow, printing the real creation tx hash. Separate from
 * scripts/deploy.ts so the deployment step and the first on-chain campaign
 * are each their own inspectable transaction.
 */
async function main() {
  const deploymentsPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));

  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentPrivateKey) throw new Error("Set AGENT_PRIVATE_KEY in .env");
  const agentAddress = new ethers.Wallet(agentPrivateKey).address;

  const [organizer] = await ethers.getSigners();
  console.log(`Organizer: ${organizer.address}`);
  console.log(`Agent (authorizedAgent): ${agentAddress}`);
  console.log(`CampaignEscrow: ${deployments.campaignEscrow}`);

  const escrow = (await ethers.getContractAt(
    "CampaignEscrow",
    deployments.campaignEscrow,
    organizer
  )) as unknown as CampaignEscrow;

  const baseRate = 100n;
  const cpmRate = 100000n; // informational to SQLite only, not read on-chain
  const maxDuration = 60n * 60n * 24n * 30n; // 30 days
  const initialDeposit = 10_000n; // modest, symbolic — proving the mechanism, not spending the faucet allocation

  const tx = await escrow.createCampaign(baseRate, maxDuration, agentAddress, { value: initialDeposit });
  console.log(`createCampaign tx submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt?.blockNumber}, tx hash: ${receipt?.hash}`);

  console.log(`Campaign 0 balance on-chain: ${await escrow.getCampaignBalance(0)}`);

  console.log(
    JSON.stringify(
      {
        organizerWallet: organizer.address,
        agentWallet: agentAddress,
        contractCampaignId: "0",
        baseRate: baseRate.toString(),
        cpmRate: cpmRate.toString(),
        maxCpm: (cpmRate * 2n).toString(),
        maxDuration: maxDuration.toString(),
        createCampaignTxHash: receipt?.hash,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
