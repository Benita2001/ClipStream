import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "hardhat";
import * as fs from "fs";

import {
  insertCampaign,
  insertClip,
  insertViewSnapshot,
  insertPendingSettlement,
  markPendingSettlementFailed,
  listAgentDecisionsByCampaign,
  getClipById,
} from "../db/db";
import { runPacingCycle } from "../pacing/agent";

/**
 * Real (not simulated) end-to-end proof of the LLM-augmented Pacing Agent
 * (pacing/llmAdvisor.ts + its wiring in pacing/agent.ts): a real Claude API
 * call, against a real local Hardhat on-chain campaign, with the result read
 * back from a real SQLite agent_decisions row.
 *
 * Runs against a *temporary, isolated* SQLite DB and deployments.json (via
 * CLIPSTREAM_DB_PATH / DEPLOYMENTS_OUT env vars, checked below) — this
 * intentionally never touches the real Arc testnet campaign or the shared
 * dev clipstream.db, learning from the earlier local/testnet data
 * contamination bug (see claude.md's Pacing Agent phase writeup).
 *
 * Invoke via:
 *   ARC_TESTNET_RPC_URL=http://127.0.0.1:8545 \
 *   CLIPSTREAM_DB_PATH=/tmp/clipstream-llm-live-test.db \
 *   DEPLOYMENTS_OUT=/tmp/deployments-llm-live-test.json \
 *   npx hardhat run scripts/test-llm-advisor-live.ts --network localhost
 */
async function main() {
  const dbPath = process.env.CLIPSTREAM_DB_PATH;
  const deploymentsPath = process.env.DEPLOYMENTS_OUT;
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL;
  if (!dbPath || !dbPath.includes("llm-live-test") || !deploymentsPath || !deploymentsPath.includes("llm-live-test") || rpcUrl !== "http://127.0.0.1:8545") {
    throw new Error(
      "Refusing to run: CLIPSTREAM_DB_PATH and DEPLOYMENTS_OUT must both point at dedicated *-llm-live-test.* temp paths, and ARC_TESTNET_RPC_URL must be http://127.0.0.1:8545 — this guards against ever accidentally running this against the real dev DB or the real Arc testnet deployment."
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set — this script exists specifically to prove a real Claude API call, so it refuses to run without one.");
  }

  console.log(`Using isolated temp DB: ${dbPath}`);
  console.log(`Using isolated temp deployments file: ${deploymentsPath}`);

  const [deployer, agent, clipper1, clipper2] = await ethers.getSigners();

  const CampaignEscrow = await ethers.getContractFactory("CampaignEscrow");
  const escrow = await CampaignEscrow.deploy();
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();

  const PayoutRegistry = await ethers.getContractFactory("PayoutRegistry");
  const registry = await PayoutRegistry.deploy(agent.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();

  const baseRate = 100n;
  const maxDuration = 60n * 60n * 24n * 30n;
  const initialDeposit = 10_000_000n;
  const cpmRate = "100000";
  const maxCpm = "150000"; // deliberately close to clipA's deterministic rate so an LLM upward nudge has a real chance to interact with the clamp

  const createTx = await escrow.createCampaign(baseRate, maxDuration, agent.address, { value: initialDeposit });
  await createTx.wait();
  console.log(`Real on-chain campaign 0 created on local Hardhat network. Escrow balance: ${await escrow.getCampaignBalance(0)}`);

  fs.writeFileSync(
    deploymentsPath,
    JSON.stringify(
      { network: "localhost", chainId: 31337, campaignEscrow: escrowAddress, payoutRegistry: registryAddress, deployedAt: new Date().toISOString() },
      null,
      2
    )
  );

  const campaign = insertCampaign({
    organizer_wallet: deployer.address,
    contract_campaign_id: "0",
    base_rate: 100,
    cpm_rate: cpmRate,
    max_cpm: maxCpm,
    max_duration: Number(maxDuration),
  });
  console.log(`SQLite campaign row id=${campaign.id}, cpm_rate=${cpmRate}, max_cpm=${maxCpm}`);

  const clipA = insertClip({
    campaign_id: campaign.id,
    clipper_wallet: clipper1.address,
    url: "https://x.com/test/status/1",
    tweet_id: "llm-live-test-clip-a",
  });
  const clipB = insertClip({
    campaign_id: campaign.id,
    clipper_wallet: clipper2.address,
    url: "https://x.com/test/status/2",
    tweet_id: "llm-live-test-clip-b",
  });
  console.log(`Clip A id=${clipA.id} (will show strong recent velocity), Clip B id=${clipB.id} (modest velocity)`);

  // Two snapshots per clip so computeClipVelocity's window has a real delta.
  // Deliberately lopsided (5000 vs 500) so the deterministic engine's
  // multiplier differs meaningfully between the two clips — something
  // substantive for Claude to actually reason about, not a coin flip.
  insertViewSnapshot({ clip_id: clipA.id, tweet_id: clipA.tweet_id, impression_count: 0 });
  insertViewSnapshot({ clip_id: clipA.id, tweet_id: clipA.tweet_id, impression_count: 5000 });
  insertViewSnapshot({ clip_id: clipB.id, tweet_id: clipB.tweet_id, impression_count: 0 });
  insertViewSnapshot({ clip_id: clipB.id, tweet_id: clipB.tweet_id, impression_count: 500 });

  // Seed one real recent settlement failure for clip A (the dominant, near-ceiling
  // clip) — a genuine rate-ceiling rejection, exactly the kind of real signal
  // getRecentFailedSettlementReasonsForClip surfaces to the LLM. This gives Claude
  // a concrete reason it might actually choose to dampen clip A's rate, rather than
  // reasoning in a vacuum with no anomaly data at all.
  const failedPs = insertPendingSettlement({
    clip_id: clipA.id,
    campaign_id: campaign.id,
    clipper_wallet: clipper1.address,
    view_delta: "9000",
    computed_amount: "180000",
    settlement_id: `llm-live-test-failed-${Date.now()}`,
    validation_reason: "APPROVED",
  });
  markPendingSettlementFailed(failedPs.id, "rate-ceiling reject: computed_amount 180000 would exceed campaign max_cpm-derived cap for this settlement window");

  console.log("\nRunning one real Pacing Agent cycle (this makes one real Claude API call)...\n");
  await runPacingCycle();

  console.log("\n=== agent_decisions read back from the (temp, isolated) DB ===");
  const decisions = listAgentDecisionsByCampaign(campaign.id);
  for (const d of decisions) {
    console.log(`\ndecision id=${d.id} clip_id=${d.clip_id} decision_type=${d.decision_type} llm_used=${d.llm_used}`);
    console.log(`  old_rate=${d.old_rate} new_rate=${d.new_rate}`);
    console.log(`  rationale: ${d.rationale}`);
  }

  const anyLlmUsed = decisions.some((d) => d.llm_used);
  console.log(`\n=== RESULT: at least one agent_decisions row has llm_used=true: ${anyLlmUsed} ===`);
  const capViolation = decisions.some((d) => d.new_rate !== null && d.new_rate > Number(maxCpm));
  console.log(`=== RESULT: every stored new_rate respects max_cpm (${maxCpm}): ${!capViolation} ===`);

  const clipAAfter = getClipById(clipA.id);
  const clipBAfter = getClipById(clipB.id);
  console.log(`\nClip A effective_cpm_rate: ${clipAAfter?.effective_cpm_rate}`);
  console.log(`Clip B effective_cpm_rate: ${clipBAfter?.effective_cpm_rate}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
