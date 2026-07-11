/**
 * Thin fetch wrappers over the backend documented in
 * docs/FRONTEND_DATA_CONTRACT.md. Field names/shapes here are copied
 * directly from that doc, not guessed.
 *
 * NEXT_PUBLIC_API_BASE_URL: base URL of the ClipStream backend
 * (server/app.ts, default port 3000). Falls back to localhost:3000 for
 * local dev — set this in Vercel once the backend has a real deployed
 * URL.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3000";

export interface Campaign {
  id: number;
  name: string;
  contract_campaign_id: string;
  organizer_wallet: string;
  cpm_rate: string;
  max_cpm: string;
  max_duration: number;
  status: string;
  description: string | null;
  source_link: string | null;
  created_at: string;
  remaining_balance: string;
  total_settled: string;
  total_budget: string;
  runway_percent: number | null;
  clip_count: number;
  spend_velocity_last_hour: string;
}

export interface CampaignClip {
  id: number;
  campaign_id: number;
  clipper_wallet: string;
  url: string;
  tweet_id: string;
  per_clip_cap: string | null;
  is_capped: boolean;
  effective_cpm_rate: string | null;
  submitted_at: string;
  current_view_count: number | null;
  last_polled_at: string | null;
  total_earnings: string;
}

export interface ClipSettlement {
  id: number;
  view_delta: number;
  amount: string;
  settlement_id: string;
  tx_hash: string | null;
  tx_url: string | null;
  created_at: string;
}

export interface ClipEarnings {
  clip_id: number;
  campaign_id: number;
  clipper_wallet: string;
  effective_cpm_rate: string | null;
  total_earnings: string;
  current_view_count: number | null;
  last_polled_at: string | null;
  recent_settlements: ClipSettlement[];
}

export interface AgentDecision {
  id: number;
  campaign_id: number;
  clip_id: number | null;
  decision_type: string;
  rationale: string | null;
  // INTEGER in the DB, not TEXT-bigint like cpm_rate/max_cpm/etc — see
  // docs/FRONTEND_DATA_CONTRACT.md's agent_decisions section. Safe as a
  // JS number at current scale, unlike the bigint-as-text fields.
  old_rate: number | null;
  new_rate: number | null;
  llm_used: boolean;
  created_at: string;
}

export interface ClipperProfileCampaign {
  campaign_id: number;
  contract_campaign_id: string;
  cpm_rate: string;
  max_cpm: string;
  status: string;
  clips_submitted: number;
  earnings_in_campaign: string;
}

export interface ClipperProfile {
  wallet_address: string;
  x_account: { linked: false } | { linked: true; x_handle: string; x_user_id: string };
  lifetime_earnings: string;
  clips_submitted: number;
  campaigns: ClipperProfileCampaign[];
}

export interface ClipperSettlement {
  id: number;
  campaign_id: number;
  clip_id: number;
  view_delta: number;
  amount: string;
  settlement_id: string;
  tx_hash: string | null;
  tx_url: string | null;
  created_at: string;
}

export interface OrganizerCampaigns {
  organizer_wallet: string;
  aggregate_spend: string;
  campaigns: Campaign[];
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

/** Clipper browse view: every open (active) campaign, for discovering something to join without already knowing an id. */
export async function fetchCampaigns(): Promise<Campaign[]> {
  const res = await fetch(`${API_BASE}/campaigns`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load campaigns (${res.status})`));
  }
  const data = await res.json();
  return data.campaigns;
}

export async function fetchCampaign(id: string): Promise<Campaign> {
  const res = await fetch(`${API_BASE}/campaigns/${id}`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load campaign (${res.status})`));
  }
  const data = await res.json();
  return data.campaign;
}

export async function fetchClipperClips(campaignId: string, clipperWallet: string): Promise<CampaignClip[]> {
  const url = `${API_BASE}/campaigns/${campaignId}/clips?clipper_wallet=${encodeURIComponent(clipperWallet)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load clips (${res.status})`));
  }
  const data = await res.json();
  return data.clips;
}

/** Every clip in a campaign — the Organizer view (no clipper_wallet filter). */
export async function fetchCampaignClips(campaignId: string): Promise<CampaignClip[]> {
  const res = await fetch(`${API_BASE}/campaigns/${campaignId}/clips`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load clips (${res.status})`));
  }
  const data = await res.json();
  return data.clips;
}

export async function fetchAgentDecisions(campaignId: string, limit: number): Promise<AgentDecision[]> {
  const res = await fetch(`${API_BASE}/campaigns/${campaignId}/agent-decisions?limit=${limit}`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load agent decisions (${res.status})`));
  }
  const data = await res.json();
  return data.agent_decisions;
}

export async function fetchClipEarnings(clipId: number): Promise<ClipEarnings> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/earnings`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load clip earnings (${res.status})`));
  }
  return res.json();
}

export async function fetchClipperProfile(wallet: string): Promise<ClipperProfile> {
  const res = await fetch(`${API_BASE}/clippers/${encodeURIComponent(wallet)}/profile`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load profile (${res.status})`));
  }
  return res.json();
}

export async function fetchClipperSettlements(wallet: string): Promise<ClipperSettlement[]> {
  const res = await fetch(`${API_BASE}/clippers/${encodeURIComponent(wallet)}/settlements`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load settlements (${res.status})`));
  }
  const data = await res.json();
  return data.settlements;
}

/** Indexes a just-confirmed on-chain createCampaign() into SQLite, attaching the off-chain-only cpm_rate/max_cpm pricing. */
export async function indexCampaign(input: {
  name: string;
  contract_campaign_id: string;
  cpm_rate: string;
  max_cpm: string;
  description?: string | null;
  source_link?: string | null;
}): Promise<Campaign> {
  const res = await fetch(`${API_BASE}/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Failed to index campaign (${res.status})`);
  }
  return data.campaign;
}

export async function fetchOrganizerCampaigns(wallet: string): Promise<OrganizerCampaigns> {
  const res = await fetch(`${API_BASE}/organizers/${encodeURIComponent(wallet)}/campaigns`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load organizer campaigns (${res.status})`));
  }
  return res.json();
}

export async function submitClip(input: {
  campaign_id: number;
  clipper_wallet: string;
  url: string;
}): Promise<{ clip: { id: number }; ownership: string }> {
  const res = await fetch(`${API_BASE}/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Failed to submit clip (${res.status})`);
  }
  return data;
}
