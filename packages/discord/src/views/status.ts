import type { Community, KeyStatusView, Run, RunStatus } from '@rolepay/core'
import type { Message } from '../api.js'
import { COLORS, NO_PINGS, count, escapeMarkdown, money, relativeTime, roleMention } from './format.js'
import { keyText } from './key.js'

export const STATUS_LABELS: Record<RunStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  executing: 'Paying',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** One line per run, for lists and autocomplete (plain text: callers that render markdown escape the note). */
export const runSummary = (r: Run) =>
  [r.id, STATUS_LABELS[r.status], money(r.total, r.token), count(r.lines.length, 'person', 'people'), r.note]
    .filter(Boolean)
    .join(' · ')

/** /rolepay status without a run: recent runs, the approver role and the bot key. */
export function statusMessage(v: { community: Community; runs: Run[]; key: KeyStatusView | null }): Message {
  const runs = v.runs.length
    ? v.runs.map((r) => `• ${runSummary({ ...r, note: r.note === null ? null : escapeMarkdown(r.note) })} · ${relativeTime(r.createdAt)}`).join('\n')
    : 'No pay runs yet. Create one with `/rolepay new`.'
  return {
    embeds: [
      {
        title: 'rolepay status',
        color: COLORS.working,
        fields: [
          { name: 'Approver role', value: v.community.approverRoleId ? roleMention(v.community.approverRoleId) : 'Not set (`/rolepay setup approver_role:`)' },
          { name: 'Bot key', value: v.key ? keyText(v.key) : 'None yet. Run `/rolepay setup`.' },
          { name: 'Recent runs', value: runs.slice(0, 1024) },
        ],
        footer: { text: 'Details of one run: /rolepay status run:<id>' },
      },
    ],
    allowed_mentions: NO_PINGS,
  }
}
