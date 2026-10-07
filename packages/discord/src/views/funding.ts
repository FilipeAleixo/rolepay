import { type FundingSource, type FundingSourceView, type FundingSummary, type NetworkName, formatAmount } from '@rolepay/core'
import { ButtonStyle, ComponentType, type Message } from '../api.js'
import { NO_PINGS, addressUrl, count, escapeMarkdown, mention, money } from './format.js'

const ONLY_TIP20 = 'Send only TIP-20 stablecoins on Tempo to it: a token from another network, or any other kind of token, does not arrive.'

const fundingPage = (dashboardBaseUrl: string | null | undefined, guildId: string) =>
  dashboardBaseUrl && /^https?:\/\//.test(dashboardBaseUrl) ? `${dashboardBaseUrl.replace(/\/+$/, '')}/${guildId}/funding` : null

/** What a source received: in its one token, else in USD (every token here is a USD stablecoin). */
const receivedWords = (r: FundingSummary) => {
  if (r.deposits === 0) return 'nothing yet'
  const only = r.byToken.length === 1 ? r.byToken[0] : undefined
  return `${only ? money(only.amount, only.token) : `${formatAmount(r.total)} USD`} in ${count(r.deposits, 'deposit', 'deposits')}`
}

/** The answer to /rolepay fund new, posted in the channel: the source and its deposit address, to share with the funder. */
export function fundingSourceMessage(input: { source: FundingSource; network: NetworkName; dashboardBaseUrl?: string | null }): Message {
  const { source } = input
  const page = fundingPage(input.dashboardBaseUrl, source.communityId)
  const buttons = [
    ...(page ? [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'Funding page', url: page }] : []),
    { type: ComponentType.Button, style: ButtonStyle.Link, label: 'On the explorer', url: addressUrl(input.network, source.depositAddress) },
  ]
  return {
    content: [
      `Funding source **${escapeMarkdown(source.name)}** created by ${mention(source.createdBy)}. Its deposit address:`,
      `\`${source.depositAddress}\``,
      `Anything sent there lands in the treasury directly, and Rolepay records it under this source. ${ONLY_TIP20}`,
    ].join('\n'),
    components: [{ type: ComponentType.ActionRow, components: buttons }],
    allowed_mentions: NO_PINGS,
  }
}

/** A name already in use: the source that has it, and its address. */
export const nameTakenText = (source: FundingSource) => `A funding source is already called **${escapeMarkdown(source.name)}**. Its deposit address: \`${source.depositAddress}\``

export const NOT_SET_UP = 'Deposit addresses are not set up yet. A treasurer sets them up once on the treasury page: run `/rolepay setup` for the link (about a minute, one passkey prompt).'

/** The answer to /rolepay fund list (ephemeral): every source with its address and what it received. */
export function fundingListMessage(input: { sources: FundingSourceView[]; guildId: string; dashboardBaseUrl?: string | null }): Message {
  const page = fundingPage(input.dashboardBaseUrl, input.guildId)
  const tail = page ? `Every deposit, with its transaction: ${page}` : ''
  if (input.sources.length === 0) return { content: ['No funding sources yet. A treasurer creates one with `/rolepay fund new name:`.', tail].filter(Boolean).join('\n'), allowed_mentions: NO_PINGS }
  // As many sources as fit in one message (2,000 characters), with room for the last two lines.
  const budget = 2000 - tail.length - 60
  const lines: string[] = []
  let used = 0
  for (const { source, received } of input.sources) {
    const line = `**${escapeMarkdown(source.name)}**: \`${source.depositAddress}\`, received ${receivedWords(received)}`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length < input.sources.length) lines.push(`And ${input.sources.length - lines.length} more on the dashboard.`)
  if (tail) lines.push(tail)
  return { content: lines.join('\n'), allowed_mentions: NO_PINGS }
}
