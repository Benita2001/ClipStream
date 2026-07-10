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
    // ethers v6 always returns checksummed (mixed-case) addresses from
    // contract reads; Circle's wallet API returns lowercase. Found for
    // real, not hypothetical: a real organizer campaign (id 4, created
    // through the Circle-signed create-campaign flow) became permanently
    // invisible to GET /organizers/:wallet/campaigns — that endpoint's
    // exact-string-match query never matched the lowercase address the
    // frontend queries with, since this function was storing the
    // checksummed form. Lowercased at this one source (the only place in
    // this codebase that produces checksummed addresses) rather than
    // patching every downstream query — POST /campaigns' authorizedAgent
    // check already lowercased both sides defensively for the same
    // underlying reason, this closes the same gap at its root instead.
    organizer: details.organizer.toLowerCase(),
    authorizedAgent: details.authorizedAgent.toLowerCase(),
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

/**
 * Reads the real on-chain campaign id out of a confirmed createCampaign()
 * transaction's receipt — used by the organizer create-campaign flow after
 * a Circle-wallet-signed transaction confirms, so the frontend can then
 * call POST /campaigns with a real contract_campaign_id rather than
 * guessing one client-side (e.g. from a pre-tx read of campaignCount,
 * which would race any other campaign created between the read and the
 * tx confirming). Parses the CampaignCreated event directly off the
 * receipt's logs rather than trusting anything the client claims.
 */
export async function getCampaignIdFromTxHash(txHash: string): Promise<string> {
  const escrow = getEscrowReader();
  const provider = escrow.runner as ethers.Provider;
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error(`No transaction receipt found for ${txHash}`);
  }
  const escrowAddress = (await escrow.getAddress()).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowAddress) continue;
    try {
      const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "CampaignCreated") {
        return parsed.args.campaignId.toString();
      }
    } catch {
      // Not a log this interface can parse (e.g. from a different event) — skip.
    }
  }
  throw new Error(`No CampaignCreated event found in transaction ${txHash}`);
}

const ARC_TESTNET_EXPLORER_BASE = "https://testnet.arcscan.app";

/** A real, clickable block-explorer link for a settlement's tx_hash — "real tx links," per the Clipper Profile page spec. */
export function getExplorerTxUrl(txHash: string | null): string | null {
  return txHash ? `${ARC_TESTNET_EXPLORER_BASE}/tx/${txHash}` : null;
}
