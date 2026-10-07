import React from 'react'
import { SANS, SERIF } from '../fonts'
import { enter } from '../motion'
import { C, panel } from '../theme'
import { VaultIcon } from './Icons'

/** How tall the block is (the tile, the title and one line under it), for centring it on a row. */
export const TREASURY_BLOCK_H = 232

/**
 * The community treasury as the trust model draws it: the vault tile, "Community treasury" and one
 * line under it. The newer scenes reuse it so the treasury looks the same in every picture.
 */
export const TreasuryBlock: React.FC<{ frame: number; at: number; left: number; top: number; sub: string }> = ({ frame, at, left, top, sub }) => (
  <>
    <div style={{ position: 'absolute', left, top, ...enter(frame, at) }}>
      <div style={{ ...panel, width: 104, height: 104, borderRadius: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <VaultIcon size={50} color={C.soft} strokeWidth={1.4} />
      </div>
    </div>
    <div style={{ position: 'absolute', left, top: top + 134, ...enter(frame, at + 5) }}>
      <div style={{ font: `400 46px/1.1 ${SERIF}`, color: C.head, letterSpacing: '-0.012em', whiteSpace: 'nowrap' }}>Community treasury</div>
      <div style={{ marginTop: 14, font: `400 24px/1.3 ${SANS}`, color: C.meta, whiteSpace: 'nowrap' }}>{sub}</div>
    </div>
  </>
)
