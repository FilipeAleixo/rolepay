/**
 * Expected failures are values, not throws. Every service method returns a
 * Result whose error carries a snake_case `code` the caller can switch on.
 */
export type Result<T, E extends { code: string } = { code: string }> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

export const err = <E extends { code: string }>(error: E): { ok: false; error: E } => ({ ok: false, error })
