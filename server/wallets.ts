import { Router, Request, Response } from "express";
import { upsertWallet, WalletOwnerType, WalletKind } from "../db/db";

const OWNER_TYPES: WalletOwnerType[] = ["clipper", "organizer"];
const WALLET_TYPES: WalletKind[] = ["user_controlled", "developer_controlled", "external"];

export const walletsRouter = Router();

/**
 * Registers a wallet — the prerequisite step behind both the Clipper
 * Profile page's "wallet connection state" and X-account linking
 * (/auth/x/start 400s if the wallet isn't registered yet). Idempotent:
 * upsertWallet no-ops on an already-registered address rather than erroring,
 * so a frontend can safely call this every time a wallet connects.
 */
walletsRouter.post("/wallets", (req: Request, res: Response) => {
  const { address, owner_type, wallet_type } = req.body ?? {};

  if (typeof address !== "string" || address.length === 0) {
    return res.status(400).json({ error: "address (string) is required" });
  }
  if (!OWNER_TYPES.includes(owner_type)) {
    return res.status(400).json({ error: `owner_type must be one of: ${OWNER_TYPES.join(", ")}` });
  }
  if (!WALLET_TYPES.includes(wallet_type)) {
    return res.status(400).json({ error: `wallet_type must be one of: ${WALLET_TYPES.join(", ")}` });
  }

  const wallet = upsertWallet({ address, owner_type, wallet_type });
  res.status(201).json({ wallet });
});
