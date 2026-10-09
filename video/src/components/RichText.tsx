import React from 'react'
import { C } from '../theme'

/**
 * Tiny markup for on-screen lines: *words* are gold (the keyword), `words` are monospace (a
 * command such as /rolepay new). Nothing else is parsed. With `wholeCode`, a monospace run never
 * breaks across lines (a repository name stays whole and moves to the next line instead).
 */
export const RichText: React.FC<{ text: string; highlight?: string; mono?: string; wholeCode?: boolean }> = ({ text, highlight = C.gold, mono, wholeCode = false }) => {
  const parts = text.split(/(\*[^*]+\*|`[^`]+`)/g).filter(Boolean)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('*') && p.endsWith('*')) return <span key={i} style={{ color: highlight }}>{p.slice(1, -1)}</span>
        if (p.startsWith('`') && p.endsWith('`'))
          return (
            <span key={i} style={{ fontFamily: mono ?? 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.86em', letterSpacing: 0, color: highlight, whiteSpace: wholeCode ? 'nowrap' : undefined }}>
              {p.slice(1, -1)}
            </span>
          )
        return <React.Fragment key={i}>{p}</React.Fragment>
      })}
    </>
  )
}
