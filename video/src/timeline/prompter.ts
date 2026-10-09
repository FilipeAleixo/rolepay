import { sec } from '../theme'

/**
 * The pitch's words, for PitchPrompter: the pitch with each item's line on screen, long enough to
 * read calmly, so the whole voice-over is recorded in one take while the film plays. The take is
 * then cut at the item boundaries into the voice files PitchVideo plays (`pitch-1-problem.wav`,
 * ...), and PitchVideo fits each item to the speech. Keyed by the item's `voice` name; an item
 * with no line here stays silent.
 */
/** A line in parts, each shown from `at` seconds into its item (a recording whose beats it follows). */
export type PrompterCue = { at: number; text: string }
export type PrompterLine = string | readonly PrompterCue[]

export const PROMPTER_LINES: Record<string, PrompterLine> = {
  'pitch-1-problem':
    "Hey there, I'm Filipe. I built Rolepay for the World's Fair: it pays the people who run a Discord community, in stablecoins on Tempo. Today, that's a spreadsheet, then a multisig, once enough signers are online. With Rolepay, the list comes from Discord, one approval pays everyone, and regular pay runs itself. It's live on mainnet.",
  // Timed to the slow cut's three beats (pitch-2-demo.mp4: 0, 7.2 and 16.2 s), so the words land on what they describe.
  'pitch-2-demo': [
    { at: 0, text: 'Here it is, on mainnet. One command builds a pay run.' },
    { at: 7.2, text: 'A treasurer approves it in the treasury channel, and the money lands.' },
    { at: 16.2, text: 'Everyone paid gets a receipt by DM, with the transaction on Tempo mainnet.' },
  ],
  'pitch-vo-trust-model':
    "The treasury is the community's own account, and its root key is the treasurer's passkey. On Tempo, the bot's spending key is part of that account: it expires, it's capped, and it can make one kind of transfer. Inside the cap, a batch pays everyone. Over it, the chain refuses the whole batch. So one passkey and a capped bot give a small community a multisig's guardrails.",
  'pitch-vo-why-tempo': "Everything here is in Tempo's protocol, from the access keys to the stablecoin exchange.",
  'pitch-4-why-me':
    "About me: I'm from Lisbon, a software engineer. From 2021 to 2025 I worked on DeFi protocols: Olympus DAO, Concave Finance, and Fjord Foundry. Now I'm the founder of Soulform, an AI startup. In 2021 I also won two hackathon prizes: a Gitcoin prize for Discord and Ethereum authentication, and an Enzyme Finance prize at ETHOnline. The code for both is on my GitHub.",
  'pitch-5-business': 'The core is open source: anyone can audit it or run their own. The business is the hosted bot, one per community.',
  'pitch-6-go-to-market': 'Crypto communities first: they already hold stablecoins and pay contributors every month. Then creators, then gaming. I start with the builders here.',
  'pitch-7-status':
    'The testnet demo runs all of it. On mainnet, a pilot I set up made its first real pay run on 8 October, for a fee well under a cent. Still open: a second RPC, the setup page on its own origin, and a separate signer.',
}

/** A calm reading pace (slower than the film's 2.5 words a second), and a breath after the last word. */
const WORDS_PER_SECOND = 2.1
const BREATH_SECONDS = 1.4

const words = (text: string) => text.split(/\s+/).filter(Boolean).length

/** How long a line needs on screen: for a timed line, until its last part has been read. */
export const readFrames = (line: PrompterLine) => {
  if (typeof line === 'string') return sec(words(line) / WORDS_PER_SECOND + BREATH_SECONDS)
  const last = line[line.length - 1]
  return last ? sec(last.at + words(last.text) / WORDS_PER_SECOND + BREATH_SECONDS) : 0
}

/** The part of a line on screen `seconds` into its item. */
export const cueAt = (line: PrompterLine, seconds: number) =>
  typeof line === 'string' ? { text: line, from: 0, until: null } : (() => {
    const i = Math.max(0, line.filter((c) => c.at <= seconds).length - 1)
    return { text: line[i]?.text ?? '', from: line[i]?.at ?? 0, until: line[i + 1]?.at ?? null }
  })()

/** Before the film: the instructions, a count of three, and a white flash that marks the film's first frame in the take. */
export const PROMPTER_INTRO_FRAMES = sec(6)
export const PROMPTER_FLASH_FRAMES = 4
