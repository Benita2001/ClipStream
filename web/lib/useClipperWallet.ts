"use client";

import { useEffect, useState } from "react";
import { loadStoredWallet, type CircleWalletSession } from "@/lib/circleWallets";

// Kept as a real seeded wallet for the "preview another wallet" secondary
// path — genuinely useful for testing, no longer the primary path now that
// real Circle Wallets creation exists (see WalletCreation.tsx).
export const DEFAULT_DEV_WALLET = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

export interface UseClipperWalletResult {
  circleWallet: CircleWalletSession | null;
  setCircleWallet: (session: CircleWalletSession | null) => void;
  checkedStorage: boolean;
  showDevOverride: boolean;
  setShowDevOverride: (show: boolean) => void;
  walletInput: string;
  setWalletInput: (value: string) => void;
  devOverrideWallet: string | null;
  setDevOverrideWallet: (address: string | null) => void;
  /** showDevOverride ? devOverrideWallet : circleWallet?.address ?? null — the one address every page should actually fetch/submit against. */
  activeWallet: string | null;
}

/**
 * Single source of truth for "which wallet is this clipper using right
 * now," shared between the Clipper Campaign and Clipper Profile pages so
 * they can't drift into two separate implementations. Real Circle wallet
 * (persisted in localStorage, see lib/circleWallets.ts) is the primary
 * path; a dev-override text input is the demoted secondary path, still
 * useful for previewing another wallet's data.
 */
export function useClipperWallet(): UseClipperWalletResult {
  const [circleWallet, setCircleWallet] = useState<CircleWalletSession | null>(null);
  const [checkedStorage, setCheckedStorage] = useState(false);
  const [showDevOverride, setShowDevOverride] = useState(false);
  const [walletInput, setWalletInput] = useState(DEFAULT_DEV_WALLET);
  const [devOverrideWallet, setDevOverrideWallet] = useState<string | null>(null);

  useEffect(() => {
    setCircleWallet(loadStoredWallet());
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
