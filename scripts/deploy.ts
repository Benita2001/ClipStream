import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentPrivateKey) {
    throw new Error(
      "Set AGENT_PRIVATE_KEY in .env — its address becomes both CampaignEscrow's per-campaign authorizedAgent " +
        "(set later, per-campaign, in createCampaign) and PayoutRegistry's authorizedAgent (set once, here, at deploy time)."
    );
  }
  const agentAddress = new ethers.Wallet(agentPrivateKey).address;

  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with: ${deployer.address}`);
  console.log(`Network: ${(await ethers.provider.getNetwork()).name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);

  // No token address: USDC is Arc's native gas currency, not an ERC20 token —
  // CampaignEscrow takes no constructor args now.
  const CampaignEscrow = await ethers.getContractFactory("CampaignEscrow");
  const escrow = await CampaignEscrow.deploy();
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log(`CampaignEscrow deployed to: ${escrowAddress}`);

  const PayoutRegistry = await ethers.getContractFactory("PayoutRegistry");
  const registry = await PayoutRegistry.deploy(agentAddress);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`PayoutRegistry deployed to: ${registryAddress}`);

  const out = {
    network: "arcTestnet",
    chainId: 5042002,
    campaignEscrow: escrowAddress,
    payoutRegistry: registryAddress,
    deployedAt: new Date().toISOString(),
  };

  const outPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote deployment addresses to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
