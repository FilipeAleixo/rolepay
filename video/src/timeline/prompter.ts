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
    "Hey there, I'm Filipe. I built Rolepay for the World's Fair, to let a Discord community pay the people who run it, in stablecoins on Tempo. Today, that usually means a spreadsheet and waiting for enough multisig signers. With Rolepay, the list comes straight from Discord, and one approval pays everyone. It's already live on mainnet.",
  // Timed to the slow cut's three beats (pitch-2-demo.mp4: 0, 7.2 and 16.2 s), so the words land on what they describe.
  'pitch-2-demo': [
    { at: 0, text: "Here's a real payment on mainnet. With one command, you create a pay run." },
    { at: 7.2, text: 'Then a treasurer approves it in the treasury channel, and the person gets paid right away.' },
    { at: 16.2, text: "Everyone who's paid gets a receipt by DM, with a link to the transaction on Tempo." },
  ],
  'pitch-vo-trust-model':
    "The money stays in the community's own account, which only the treasurer's passkey controls. On Tempo, the bot gets its own key inside that account, with an expiry, a spending limit, and just one kind of transfer allowed. If a batch goes over the limit, the chain rejects all of it. So even a small community gets a multisig's guardrails, with one passkey and a capped bot.",
  'pitch-vo-why-tempo': "And all of this is part of Tempo's protocol, from the access keys to the stablecoin exchange.",
  'pitch-4-why-me':
    "A bit about me: I'm a software engineer from Lisbon. From 2021 to 2025 I worked on DeFi protocols, at Olympus DAO, Concave Finance and Fjord Foundry, and now I'm the founder of Soulform, an AI startup. In 2021 I also won two hackathon prizes, from Gitcoin and from Enzyme Finance at ETHOnline, and the code for both is on my GitHub.",
  'pitch-5-business': 'The core is open source, so anyone can audit it or run it themselves, and the business is the hosted bot, one per community.',
  'pitch-6-go-to-market':
    "I'll start with crypto communities, since they already hold stablecoins and pay contributors every month, beginning with the builders in this hackathon, and then move on to creators and gaming.",
  'pitch-7-status':
    'The testnet demo runs every feature, and on mainnet, a pilot I set up made its first real pay run on October 8th, for a fee well under a cent.',
  'pitch-8-close': "Thanks for watching. You can try it yourself at demo.rolepay.app, and you'll get paid at the next daily run.",
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
