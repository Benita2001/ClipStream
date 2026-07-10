"use client";

import { useEffect, useState } from "react";
import { loadStoredWallet, type CircleWalletSession } from "@/lib/circleWallets";
import type { UseClipperWalletResult } from "@/lib/useClipperWallet";

// Kept as a real seeded wallet for the "preview another wallet" secondary
// path — this dev DB's richest organizer campaign history (campaigns 1 and
// 3 — real settlements, real on-chain balances), same convention as
// useClipperWallet's DEFAULT_DEV_WALLET.
export const DEFAULT_DEV_ORGANIZER_WALLET = "0x8a69D789Dc390779D0D0BffB69583F11CC3adc3E";

/**
 * Mirrors useClipperWallet exactly — same shape (UseClipperWalletResult),
 * same real-wallet-primary/dev-override-secondary logic — scoped to the
 * "organizer" owner_type instead of "clipper". Kept as a separate hook
 * rather than parameterizing useClipperWallet(role) so each role's default
 * dev-preview wallet and localStorage key (already role-scoped in
 * lib/circleWallets.ts) stay simple constants instead of being threaded
 * through a shared hook's call site everywhere.
 */
export function useOrganizerWallet(): UseClipperWalletResult {
  const [circleWallet, setCircleWallet] = useState<CircleWalletSession | null>(null);
  const [checkedStorage, setCheckedStorage] = useState(false);
  const [showDevOverride, setShowDevOverride] = useState(false);
  const [walletInput, setWalletInput] = useState(DEFAULT_DEV_ORGANIZER_WALLET);
  const [devOverrideWallet, setDevOverrideWallet] = useState<string | null>(null);

  useEffect(() => {
    setCircleWallet(loadStoredWallet("organizer"));
    setCheckedStorage(true);
  }, []);

  const activeWallet = showDevOverride ? devOverrideWallet : circleWallet?.address ?? null;

  return {
    circleWallet,
    setCircleWallet,
    checkedStorage,
    showDevOverride,
    setShowDevOverride,
    walletInput,
    setWalletInput,
    devOverrideWallet,
    setDevOverrideWallet,
    activeWallet,
  };
}
