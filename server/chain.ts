import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { CampaignEscrow__factory } from "../typechain-types/factories/contracts/CampaignEscrow__factory";
import type { CampaignEscrow } from "../typechain-types";

/**
 * Read-only on-chain access for the frontend-facing GET endpoints (campaign
 * remaining balance). Mirrors pacing/agent.ts's loadDeployments/loadProvider
 * pattern, but cached at module scope since these are called on every
 * request rather than once per pacing cycle, and read-only (no signer) since
 * these routes never send transactions.
 */

interface Deployments {
  campaignEscrow: string;
  payoutRegistry: string;
}

let cachedEscrow: CampaignEscrow | null = null;

function loadDeployments(): Deployments {
  const deploymentsPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`No deployments file at ${deploymentsPath} — run the deploy script first.`);
  }
  return JSON.parse(fs.readFileSync(deploymentsPath, "utf-8")) as Deployments;
}

export function getEscrowReader(): CampaignEscrow {
  if (!cachedEscrow) {
    const rpcUrl = process.env.ARC_TESTNET_RPC_URL;
    if (!rpcUrl) {
      throw new Error("Set ARC_TESTNET_RPC_URL in .env");
    }
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const deployments = loadDeployments();
    cachedEscrow = CampaignEscrow__factory.connect(deployments.campaignEscrow, provider) as unknown as CampaignEscrow;
  }
  return cachedEscrow;
}

/** Native-currency balance remaining in escrow for one on-chain campaign id, as a string (USDC base units). */
export async function getCampaignRemainingBalance(contractCampaignId: string): Promise<string> {
  const escrow = getEscrowReader();
  const balance = await escrow.getCampaignBalance(BigInt(contractCampaignId));
  return balance.toString();
}

export interface OnChainCampaignDetails {
  organizer: string;
  authorizedAgent: string;
  baseRate: string;
  maxDuration: string;
  balance: string;
  createdAt: string;
  closed: boolean;
}

/**
 * Full on-chain campaign struct, used by POST /campaigns to verify a
 * client-claimed contract_campaign_id actually exists on-chain before
 * indexing it into SQLite — organizer/baseRate/maxDuration are read from the
 * chain itself (the source of truth) rather than trusted from the request
 * body. Throws (campaignExists modifier reverts) if the id doesn't exist.
 */
export async function getCampaignOnChainDetails(contractCampaignId: string): Promise<OnChainCampaignDetails> {
  const escrow = getEscrowReader();
  const details = await escrow.getCampaignDetails(BigInt(contractCampaignId));
  return {
    organizer: details.organizer,
    authorizedAgent: details.authorizedAgent,
    baseRate: details.baseRate.toString(),
    maxDuration: details.maxDuration.toString(),
    balance: details.balance.toString(),
    createdAt: details.createdAt.toString(),
    closed: details.closed,
  };
}

/**
 * The address ClipStream's own Settlement/Pacing Agent signs with
 * (AGENT_PRIVATE_KEY), derived without a provider (pure key -> address, no
 * network call). Used by POST /campaigns to reject indexing a campaign whose
 * on-chain authorizedAgent isn't actually us — such a campaign would exist
 * on-chain but our Settlement Worker could never call release() on it
 * (NotAuthorizedAgent), silently never paying out. Better to catch this at
 * creation time than have it fail invisibly later.
 */
export function getConfiguredAgentAddress(): string {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) {
    throw new Error("Set AGENT_PRIVATE_KEY in .env");
  }
  return new ethers.Wallet(key).address;
}

const ARC_TESTNET_EXPLORER_BASE = "https://testnet.arcscan.app";

/** A real, clickable block-explorer link for a settlement's tx_hash — "real tx links," per the Clipper Profile page spec. */
export function getExplorerTxUrl(txHash: string | null): string | null {
  return txHash ? `${ARC_TESTNET_EXPLORER_BASE}/tx/${txHash}` : null;
}
