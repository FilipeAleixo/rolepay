import { getLength } from '@remotion/paths'
import React from 'react'
import { C } from '../theme'

/** The mark's paths, exactly as docs/brand/rolepay-mark.svg (a 512 by 512 box). */
const MASK = 'M124 150Q190 110 256 136Q322 110 388 150C414 234 394 342 324 398Q256 446 188 398C118 342 98 234 124 150Z'
const FACE = 'M162 248Q200 186 238 248Q200 230 162 248ZM274 248Q312 186 350 248Q312 230 274 248ZM178 298Q256 394 334 298Q256 340 178 298Z'
const MASK_LENGTH = getLength(MASK)

/**
 * Rolepay's mark: a gold theatre mask on maroon. With no progress props it is the finished mark.
 * For the draw-in, each stage takes a 0..1 progress: the maroon tile settles in, the gold outline
 * draws, the gold fills, then the eyes and mouth appear.
 */
export const Mark: React.FC<{
  size: number
  tile?: number
  outline?: number
  fill?: number
  face?: number
  style?: React.CSSProperties
}> = ({ size, tile = 1, outline = 1, fill = 1, face = 1, style }) => {
  const scale = 0.94 + 0.06 * tile
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" style={{ display: 'block', overflow: 'visible', ...style }}>
      <g style={{ transformOrigin: '256px 256px', transform: `scale(${scale})`, opacity: tile }}>
        <rect width="512" height="512" rx="116" fill={C.maroon} />
      </g>
      <path d={MASK} fill={C.gold} fillOpacity={fill} />
      <path
        d={MASK}
        fill="none"
        stroke={C.gold}
        strokeWidth={7}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={MASK_LENGTH}
        strokeDashoffset={MASK_LENGTH * (1 - outline)}
        opacity={outline > 0 ? 1 - fill : 0}
      />
      <path d={FACE} fill={C.maroon} opacity={face} />
    </svg>
  )
}
