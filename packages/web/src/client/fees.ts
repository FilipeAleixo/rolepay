// Who pays the network fee of a transaction this browser signs, when there is no sponsor
// (mainnet). Pure, so it is tested without a browser or a chain.

/** 0.1 of a 6-decimal stablecoin: far above one passkey transaction's fee on Tempo (about a cent). */
export const FEE_RESERVE = 100_000n

/**
 * The token the treasury pays its own transactions' fees in (authorising, replacing or revoking the
 * bot key): the fee token while it holds enough for a fee, otherwise the payout token, so the
 * treasurer can always revoke a key even after the fee token ran out. With neither, the fee token:
 * that transaction fails, and the page's funding step shows both balances.
 */
export function treasuryFeeToken(o: { feeToken: string | null; payoutToken: string; balances: { fee: bigint | null; payout: bigint } }): string {
  if (!o.feeToken) return o.payoutToken
  if ((o.balances.fee ?? 0n) >= FEE_RESERVE) return o.feeToken
  return o.balances.payout >= FEE_RESERVE ? o.payoutToken : o.feeToken
}
