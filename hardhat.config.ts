import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL || "";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

// Hardhat validates every configured network's accounts at config-load time,
// even for commands targeting a different network (e.g. `--network localhost`
// still loads and checks the arcTestnet block below). A private key that's
// present but malformed (wrong length, since Hardhat requires exactly 32
// bytes) would otherwise hard-fail local-only runs too — so only pass it
// through if it actually looks like a valid key, and warn instead of crashing
// if it's set but doesn't.
const isValidPrivateKey = /^0x[0-9a-fA-F]{64}$/.test(DEPLOYER_PRIVATE_KEY);
if (DEPLOYER_PRIVATE_KEY && !isValidPrivateKey) {
  console.warn(
    `WARNING: DEPLOYER_PRIVATE_KEY is set but is not a valid private key (expected 0x + 64 hex chars, ` +
      `got ${DEPLOYER_PRIVATE_KEY.length} chars) — ignoring it for the arcTestnet network config.`
  );
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    arcTestnet: {
      url: ARC_TESTNET_RPC_URL,
      accounts: isValidPrivateKey ? [DEPLOYER_PRIVATE_KEY] : [],
      chainId: 5042002,
    },
  },
};

export default config;
