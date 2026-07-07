import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * One-off setup for a real (not simulated) local end-to-end proof of the
 * Settlement Worker, standing in for Arc testnet since no funded testnet
 * credentials are configured in .env yet. Deploys the real
 * CampaignEscrow/PayoutRegistry contracts to the persistent local Hardhat
 * node, creates one campaign matching the SQLite campaigns row already in
 * clipstream.db (id=1, contract_campaign_id='0'), funds it with native value
 * (USDC is Arc's native gas currency, not an ERC20 token — Hardhat's default
 * local accounts already hold native balance, no mock token needed), and
 * writes deployments.json so settlement/worker.ts can pick it up unmodified.
 */
async function main() {
  const [deployer, agent] = await ethers.getSigners();
  console.log(`Deployer/organizer: ${deployer.address}`);
  console.log(`Agent: ${agent.address}`);

  const CampaignEscrow = await ethers.getContractFactory("CampaignEscrow");
  const escrow = await CampaignEscrow.deploy();
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log(`CampaignEscrow deployed to: ${escrowAddress}`);

  const PayoutRegistry = await ethers.getContractFactory("PayoutRegistry");
  const registry = await PayoutRegistry.deploy(agent.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`PayoutRegistry (authorizedAgent=${agent.address}) deployed to: ${registryAddress}`);

  // Campaign 0 on-chain, matching campaigns.id=1 / contract_campaign_id='0' in clipstream.db
  const baseRate = 100n; // matches the seeded SQLite campaign's base_rate
  const maxDuration = 60n * 60n * 24n * 30n;
  const initialDeposit = 1_000_000n; // 1 USDC (6 decimals) — plenty for these tests

  const createTx = await escrow.createCampaign(baseRate, maxDuration, agent.address, { value: initialDeposit });
  await createTx.wait();
  console.log(`Campaign 0 created on-chain: baseRate=${baseRate}, authorizedAgent=${agent.address}, deposit=${initialDeposit}`);
  console.log(`Escrow balance for campaign 0: ${await escrow.getCampaignBalance(0)}`);

  const out = {
    network: "localhost",
    chainId: 31337,
    campaignEscrow: escrowAddress,
    payoutRegistry: registryAddress,
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote deployment addresses to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
