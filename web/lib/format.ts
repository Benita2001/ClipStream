/**
 * Formatting helpers for bigint-as-text USDC base-unit fields (see
 * docs/FRONTEND_DATA_CONTRACT.md's "one rule that matters most" —
 * these must never be run through Number() for arithmetic).
 *
 * USDC_DECIMALS = 6 is an inference, not a confirmed fact from the data
 * contract: every Circle-issued USDC deployment uses 6 decimals, and Arc
 * is Circle's own chain, so this is the standard convention rather than a
 * documented one. Flagging it here since the doc itself never states it.
 */
const USDC_DECIMALS = 6;

function addThousandsSeparators(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats a bigint-as-text USDC base-unit amount as "$X,XXX.XX" — string
 * math only, never Number(). Shows at least 2 decimal places, but keeps
 * more when the real value needs them: at this product's per-view scale,
 * real amounts (e.g. "830" base units = $0.00083) are genuinely
 * sub-cent — truncating to 2 decimals would silently show "$0.00" for
 * real, nonzero earnings, which is worse than a few extra digits.
 */
export function formatUsdc(baseUnits: string): string {
  const negative = baseUnits.startsWith("-");
  const digits = negative ? baseUnits.slice(1) : baseUnits;
  const padded = digits.padStart(USDC_DECIMALS + 1, "0");
  const whole = padded.slice(0, padded.length - USDC_DECIMALS);
  let fraction = padded.slice(padded.length - USDC_DECIMALS).replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}$${addThousandsSeparators(whole)}.${fraction}`;
}

/**
 * Inverse of formatUsdc: parses a user-typed decimal USD string (e.g.
 * "0.10", "10", "0.000015") from a form input into USDC base units (6
 * decimals), as a string. Exact string-digit math, not parseFloat/Number —
 * same reason arithmetic on these amounts elsewhere in this app never uses
 * Number() (docs/FRONTEND_DATA_CONTRACT.md's "one rule that matters
 * most"); floating point would risk silently mis-parsing a currency
 * amount an organizer is about to actually spend on-chain. Throws on
 * anything that isn't a plain non-negative decimal number, rather than
 * silently coercing a malformed form value into something wrong.
 */
export function parseUsdcToBaseUnits(input: string): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`"${input}" is not a valid USDC amount`);
  }
  const [wholePart, fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > USDC_DECIMALS) {
    throw new Error(`"${input}" has more than ${USDC_DECIMALS} decimal places`);
  }
  const combined = `${wholePart}${fractionPart.padEnd(USDC_DECIMALS, "0")}`.replace(/^0+(?=\d)/, "");
  return combined;
}

/** "$X.XX per 1,000 views" from a campaign's (or clip's effective) cpm_rate. */
export function formatRatePerThousand(cpmRateBaseUnits: string): string {
  return `${formatUsdc(cpmRateBaseUnits)} per 1,000 views`;
}

/**
 * A number-typed rate field (agent_decisions.old_rate/new_rate are
 * INTEGER in the DB, not TEXT-bigint like cpm_rate) still formats
 * correctly through formatUsdc/formatRatePerThousand — those functions
 * do pure string-digit math with no Number() parsing internally, so the
 * TEXT-vs-INTEGER storage distinction (which matters for backend
 * summation precision) doesn't affect formatting a single already-
 * resolved value. String(n) on a safe integer is exact, so this is a
 * thin, honest adapter rather than new formatting logic.
 */
export function formatRatePerThousandFromNumber(rate: number): string {
  return formatRatePerThousand(String(rate));
}

/** "2m ago" / "3h ago" style relative time, recomputed against `nowMs` (pass a ticking value to keep it live). */
export function formatRelativeTime(isoString: string, nowMs: number = Date.now()): string {
  const then = new Date(isoString).getTime();
  const diffSeconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
