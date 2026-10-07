import type React from 'react'
import { AI_PROPOSAL_FRAMES, AiProposal } from './AiProposal'
import { ARCHITECTURE_FRAMES, Architecture } from './Architecture'
import { END_CARD_FRAMES, EndCard } from './EndCard'
import { FOUR_BEATS_FRAMES, FourBeats } from './FourBeats'
import { FUNDING_FRAMES, Funding } from './Funding'
import { NEVER_PAY_TWICE_FRAMES, NeverPayTwice } from './NeverPayTwice'
import { NUMBERS_FRAMES, Numbers } from './Numbers'
import { OWN_BUDGETS_FRAMES, OwnBudgets } from './OwnBudgets'
import { PREFERRED_STABLECOIN_FRAMES, PreferredStablecoin } from './PreferredStablecoin'
import { PROBLEM_FRAMES, Problem } from './Problem'
import { TITLE_FRAMES, Title } from './Title'
import { TRUST_MODEL_FRAMES, TrustModel } from './TrustModel'
import { WHY_TEMPO_FRAMES, WhyTempo } from './WhyTempo'

/** Every animated scene, by the id the timelines use, with its composition id and length. */
export const SCENES = {
  title: { id: 'Title', component: Title, frames: TITLE_FRAMES },
  problem: { id: 'Problem', component: Problem, frames: PROBLEM_FRAMES },
  trustModel: { id: 'TrustModel', component: TrustModel, frames: TRUST_MODEL_FRAMES },
  ownBudgets: { id: 'OwnBudgets', component: OwnBudgets, frames: OWN_BUDGETS_FRAMES },
  fourBeats: { id: 'FourBeats', component: FourBeats, frames: FOUR_BEATS_FRAMES },
  aiProposal: { id: 'AiProposal', component: AiProposal, frames: AI_PROPOSAL_FRAMES },
  neverPayTwice: { id: 'NeverPayTwice', component: NeverPayTwice, frames: NEVER_PAY_TWICE_FRAMES },
  preferredStablecoin: { id: 'PreferredStablecoin', component: PreferredStablecoin, frames: PREFERRED_STABLECOIN_FRAMES },
  numbers: { id: 'Numbers', component: Numbers, frames: NUMBERS_FRAMES },
  architecture: { id: 'Architecture', component: Architecture, frames: ARCHITECTURE_FRAMES },
  whyTempo: { id: 'WhyTempo', component: WhyTempo, frames: WHY_TEMPO_FRAMES },
  funding: { id: 'Funding', component: Funding, frames: FUNDING_FRAMES },
  endCard: { id: 'EndCard', component: EndCard, frames: END_CARD_FRAMES },
} as const satisfies Record<string, { id: string; component: React.FC; frames: number }>

export type SceneId = keyof typeof SCENES
