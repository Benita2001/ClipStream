/**
 * Client-side orchestration for organizer contract calls (createCampaign,
 * topUp) signed through a Circle User-Controlled Wallet's PIN-approval
 * flow. Reuses lib/circleWallets.ts's postJson/getAuthenticatedSdk/
 * loadStoredWallet/createCircleWallet rather than redefining them — the
 * only genuinely new piece here is driving a *contract-execution*
 * challenge instead of a CREATE_WALLET one, and the multi-step orchestration
 * (session -> init -> PIN approval -> finalize -> resolve) that's specific
 * to signing and confirming a real transaction.
 */
import {
  postJson,
  getAuthenticatedSdk,
  loadStoredWallet,
  createCircleWallet,
  API_BASE,
  type CircleWalletSession,
} from "./circleWallets";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request to ${path} failed (${res.status})`);
  }
  return data;
}

/** Wraps sdk.execute's callback style in a promise, same pattern as lib/circleWallets.ts's wallet-creation flow. */
function executeChallenge(sdk: Awaited<ReturnType<typeof getAuthenticatedSdk>>, challengeId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sdk.execute(challengeId, (error) => {
      if (error) {
        reject(new Error(error.message || "Transaction was not approved"));
      } else {
        resolve();
      }
    });
  });
}

/** Returns the caller's existing organizer Circle wallet, creating one (with the same real PIN flow) if none exists yet. */
async function ensureOrganizerWallet(onStatus: (status: string) => void): Promise<CircleWalletSession> {
  const existing = loadStoredWallet("organizer");
  if (existing) return existing;
  onStatus("Setting up your organizer wallet…");
  return createCircleWallet(onStatus, "organizer");
}

export interface CreateCampaignInput {
  baseRate: number;
  maxDuration: number;
  depositAmountBaseUnits: string;
  onStatus: (status: string) => void;
}

export interface CreateCampaignResult {
  txHash: string;
  contractCampaignId: string;
  organizerWallet: string;
}

/**
 * Full create-campaign flow: ensure an organizer Circle wallet exists,
 * start a real createCampaign(uint256,uint256,address) contract-execution
 * challenge (payable with the deposit), drive the PIN approval, poll until
 * the resulting transaction is genuinely confirmed on-chain (not just
 * challenge-complete — see server/circleTransactions.ts's doc comment for
 * why that distinction matters), then resolve the real on-chain
 * contract_campaign_id from the confirmed transaction's receipt. Does
 * *not* call POST /campaigns itself — the caller does that once it also
 * has the off-chain cpm_rate/max_cpm pricing to attach.
 */
export async function createCampaignFlow(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  const { baseRate, maxDuration, depositAmountBaseUnits, onStatus } = input;
  const session = await ensureOrganizerWallet(onStatus);

  onStatus("Starting a secure session…");
  const { userToken, encryptionKey } = await postJson<{ userToken: string; encryptionKey: string }>(
    "/circle-wallets/session",
    { userId: session.userId }
  );

  onStatus("Preparing the campaign transaction…");
  const { challengeId } = await postJson<{ challengeId: string }>("/circle-wallets/create-campaign/init", {
    userToken,
    walletAddress: session.address,
    base_rate: baseRate,
    max_duration: maxDuration,
    deposit_amount: depositAmountBaseUnits,
  });

  const sdk = await getAuthenticatedSdk(userToken, encryptionKey);
  onStatus("Approve the transaction with your PIN…");
  await executeChallenge(sdk, challengeId);

  onStatus("Waiting for confirmation on Arc Testnet — this can take a little while…");
  const { tx_hash } = await postJson<{ tx_hash: string; state: string }>("/circle-wallets/transactions/finalize", {
    userToken,
    challengeId,
  });

  onStatus("Reading the new campaign id…");
  const { contract_campaign_id } = await getJson<{ contract_campaign_id: string }>(`/campaigns/resolve-tx/${tx_hash}`);

  return { txHash: tx_hash, contractCampaignId: contract_campaign_id, organizerWallet: session.address };
}

export interface TopUpInput {
  contractCampaignId: string;
  amountBaseUnits: string;
  onStatus: (status: string) => void;
}

export interface TopUpResult {
  txHash: string;
  organizerWallet: string;
}

/** Same shape as createCampaignFlow, minus the campaign-id resolution step — a top-up needs no further indexing, GET /campaigns/:id already reads the on-chain balance live. */
export async function topUpFlow(input: TopUpInput): Promise<TopUpResult> {
  const { contractCampaignId, amountBaseUnits, onStatus } = input;
  const session = await ensureOrganizerWallet(onStatus);

  onStatus("Starting a secure session…");
  const { userToken, encryptionKey } = await postJson<{ userToken: string; encryptionKey: string }>(
    "/circle-wallets/session",
    { userId: session.userId }
  );

  onStatus("Preparing the top-up transaction…");
  const { challengeId } = await postJson<{ challengeId: string }>("/circle-wallets/top-up/init", {
    userToken,
    walletAddress: session.address,
    contract_campaign_id: contractCampaignId,
    amount: amountBaseUnits,
  });

  const sdk = await getAuthenticatedSdk(userToken, encryptionKey);
  onStatus("Approve the transaction with your PIN…");
  await executeChallenge(sdk, challengeId);

  onStatus("Waiting for confirmation on Arc Testnet — this can take a little while…");
  const { tx_hash } = await postJson<{ tx_hash: string; state: string }>("/circle-wallets/transactions/finalize", {
    userToken,
    challengeId,
  });

  return { txHash: tx_hash, organizerWallet: session.address };
}
