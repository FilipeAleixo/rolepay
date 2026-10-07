import { type Result, err, ok, parseAmount } from '@rolepay/core'

export type RecipientSpec = { userId: string; amount: bigint | null }

const USER = /^(?:<@!?(\d{17,20})>|(\d{17,20}))(?:[=:](.+))?$/
const ROLE = /^<@&\d{17,20}>/

/**
 * The `users` option of /rolepay new: mentions or IDs, each optionally followed by its
 * own amount (`@alice @bob=40`). Mentions in a string option arrive as `<@id>`.
 */
export function parseRecipients(text: string): Result<RecipientSpec[], { code: 'invalid_input'; issues: string[] }> {
  const tokens = text
    .replace(/\s*([=:])\s*/g, '$1')
    .split(/[\s,]+/)
    .filter(Boolean)
  const out: RecipientSpec[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (ROLE.test(token)) {
      issues.push('users: roles go in the role option, not in users')
      continue
    }
    const m = USER.exec(token)
    if (!m) {
      issues.push(/^[=:]/.test(token) ? `users: "${token}" has no user before it` : `users: "${token}" is not a user mention`)
      continue
    }
    const userId = (m[1] ?? m[2]) as string
    let amount: bigint | null = null
    if (m[3] !== undefined) {
      const parsed = parseAmount(m[3])
      if (!parsed.ok) {
        issues.push(`users: the amount for <@${userId}> is not valid (${parsed.error.code})`)
        continue
      }
      amount = parsed.value
    }
    if (seen.has(userId)) {
      issues.push(`users: <@${userId}> is listed twice`)
      continue
    }
    seen.add(userId)
    out.push({ userId, amount })
  }
  return issues.length ? err({ code: 'invalid_input', issues }) : ok(out)
}
