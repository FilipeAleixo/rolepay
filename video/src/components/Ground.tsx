import React from 'react'
import { AbsoluteFill } from 'remotion'

/**
 * The ink ground, as on every Rolepay page: near-black with a slight cool cast (#08090B to
 * #101116), one faint gold light high and off-centre, a neutral lift at the base, and a grain that
 * stops the gradient from banding. It never moves.
 */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E\")"

export const Ground: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ backgroundColor: '#0B0C0F' }}>
    <AbsoluteFill
      style={{
        background: [
          'radial-gradient(120% 80% at 20% -18%, rgba(237,190,90,0.055) 0%, rgba(237,190,90,0.018) 42%, transparent 72%)',
          'radial-gradient(110% 52% at 52% 116%, rgba(200,205,215,0.055) 0%, transparent 74%)',
          'linear-gradient(180deg, #08090B 0%, #0C0D11 34%, #101116 62%, #0C0D11 86%, #0A0B0E 100%)',
        ].join(', '),
      }}
    />
    <AbsoluteFill style={{ opacity: 0.05, mixBlendMode: 'overlay', backgroundImage: GRAIN, backgroundRepeat: 'repeat' }} />
    {children}
  </AbsoluteFill>
)
