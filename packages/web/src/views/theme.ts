/**
 * The look every page shares: the ink ground, the fonts, the mark, the head tags, and the base
 * stylesheet that both page stylesheets (`STYLE` in page.ts, `DASHBOARD_STYLE` in the dashboard's
 * layout.ts) start with. Pure: strings only.
 *
 * Dark only, on purpose. The ground is near-black ink with a slight cool cast, one faint gold
 * light high and off-centre, a neutral lift at the base and a grain overlay that stops the
 * gradient from banding. It is fixed and never moves. Surfaces are panels separated by light
 * (a near-black wash with a hairline of light along the top edge), never boxes inside boxes.
 * Colour lives in small marks: gold for the primary action, the focus ring and the current page;
 * the status colours for pills, dots and diff lines.
 */

/** Rolepay's mark: a gold theatre mask on maroon. Also served as the favicon (`/favicon.svg`). */
export const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="116" fill="#4A1B2A"/><path fill="#EDBE5A" d="M124 150Q190 110 256 136Q322 110 388 150C414 234 394 342 324 398Q256 446 188 398C118 342 98 234 124 150Z"/><path fill="#4A1B2A" d="M162 248Q200 186 238 248Q200 230 162 248ZM274 248Q312 186 350 248Q312 230 274 248ZM178 298Q256 394 334 298Q256 340 178 298Z"/></svg>'

/** The mark inline, decorative (the text next to it says "Rolepay"). */
export const mark = (size: number) =>
  MARK_SVG.replace('<svg ', `<svg class="mark" width="${size}" height="${size}" aria-hidden="true" focusable="false" `)

/** The fonts the pages use, served from this origin under /assets/fonts/ (SIL Open Font License 1.1). */
export const FONTS = [
  { family: 'Lora', weight: 400, file: 'lora-latin-400-normal.woff2', module: '@fontsource/lora/files/lora-latin-400-normal.woff2' },
  { family: 'Montserrat', weight: 400, file: 'montserrat-latin-400-normal.woff2', module: '@fontsource/montserrat/files/montserrat-latin-400-normal.woff2' },
  { family: 'Montserrat', weight: 500, file: 'montserrat-latin-500-normal.woff2', module: '@fontsource/montserrat/files/montserrat-latin-500-normal.woff2' },
  { family: 'Montserrat', weight: 600, file: 'montserrat-latin-600-normal.woff2', module: '@fontsource/montserrat/files/montserrat-latin-600-normal.woff2' },
] as const

/** The licence that comes with each family, served next to the fonts. */
export const FONT_LICENSES = [
  { file: 'Lora-OFL.txt', module: '@fontsource/lora/LICENSE' },
  { file: 'Montserrat-OFL.txt', module: '@fontsource/montserrat/LICENSE' },
] as const

export const FONT_PATH = '/assets/fonts/'

/** The Latin subset's characters: text outside it (a community name in Cyrillic, say) falls back to the system font. */
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

const fontFaces = FONTS.map(
  (f) => `@font-face{font-family:${f.family};font-style:normal;font-weight:${f.weight};font-display:swap;src:url(${FONT_PATH}${f.file}) format("woff2");unicode-range:${LATIN}}`,
).join('\n')

/**
 * Head tags every page carries: the favicon, the iPhone home-screen icon (a PNG of the mark,
 * `appleTouchIcon.ts`), and a preload for the two faces every page shows first (the serif heading
 * and the body text), so they arrive with the stylesheet.
 */
export const HEAD_LINKS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#0B0C0F">${[FONTS[0], FONTS[1]]
  .map((f) => `<link rel="preload" href="${FONT_PATH}${f.file}" as="font" type="font/woff2" crossorigin>`)
  .join('')}`

/** Fractal-noise grain, as a data URI (img-src allows data:). Near-invisible: it only stops the dark gradient from banding. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")"

/** The select's chevron, in the META grey. */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2394938F' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"

/**
 * The shared base. Contrast on the lightest surface (a panel over the field's lightest point):
 * --head 14.9:1, --fg 13.6, --soft 8.5, --meta 5.5, --muted 4.8, gold 9.7, ok 9.0, warn 8.7,
 * bad 6.8, info 8.2, --accent-2 7.5 (on #101116). Every text colour passes WCAG AA at any size.
 * --accent-2, a soft periwinkle, is the second accent and the cool one: gold stays the brand and the
 * primary action; the periwinkle marks the Discord side, step numbers and small labels, never on the
 * same small element as gold. Only the home page uses it so far.
 */
export const INK_BASE = `
/* Lora and Montserrat: SIL Open Font License 1.1, ${FONT_PATH}${FONT_LICENSES[0].file} and ${FONT_PATH}${FONT_LICENSES[1].file} */
${fontFaces}
:root{color-scheme:dark;--ink:#0B0C0F;--head:#F2F1EE;--fg:#E8E7E4;--soft:#B9B8B4;--meta:#94938F;--muted:#8A8985;--line:rgba(255,255,255,.07);--gold:#EDBE5A;--accent-2:#8F9CFF;--ok:#8CCB9E;--warn:#E2B26E;--bad:#E08E92;--info:#8FB8E6;--serif:Lora,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--sans:Montserrat,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--panel-bg:rgba(255,255,255,.022);--panel-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 18px 45px -30px rgba(0,0,0,.95)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--ink);-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--fg);font:400 15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;overflow-wrap:break-word}
body::before,body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none}
body::before{background:radial-gradient(130% 78% at 18% -16%,rgba(237,190,90,.04) 0%,rgba(237,190,90,.013) 40%,transparent 72%),radial-gradient(115% 48% at 52% 114%,rgba(200,205,215,.05) 0%,transparent 74%),linear-gradient(180deg,#08090B 0%,#0C0D11 34%,#101116 62%,#0C0D11 86%,#0A0B0E 100%)}
body::after{opacity:.035;mix-blend-mode:overlay;background-image:${GRAIN};background-repeat:repeat}
h1,h2{font-family:var(--serif);font-weight:400;color:var(--head);letter-spacing:-.01em}
h1{font-size:34px;line-height:1.15;margin:0 0 .6rem}
h2{font-size:19px;line-height:1.3;margin:0 0 .75rem}
h3{font:500 10.5px/1.5 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta);margin:1.25rem 0 .5rem}
strong{font-weight:600;color:var(--head)}
a{color:var(--fg);text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:rgba(237,190,90,.45);text-underline-offset:.22em}
a:hover{color:var(--gold);text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
a:focus-visible{border-radius:3px}
.mark{display:block;flex:none}
.muted{color:var(--muted)}
.small{font-size:12px}
code{font:12.5px/1.5 var(--mono);color:#D8D6D1;overflow-wrap:anywhere}
pre{font:12px/1.6 var(--mono);color:#D8D6D1;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:.85rem 1rem;overflow:auto;max-height:28rem;margin:.6rem 0 0}
.testnet,.pill{display:inline-flex;align-items:center;gap:.45em;padding:.25em .75em;border-radius:999px;border:1px solid rgba(255,255,255,.1);font:500 10px/1.4 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta);white-space:nowrap;vertical-align:middle}
.testnet{color:var(--warn);border-color:rgba(226,178,110,.32);background:rgba(226,178,110,.06)}
.pill.ok,.pill.warn,.pill.bad,.pill.info{background:transparent}
.pill.ok::before,.pill.warn::before,.pill.bad::before,.pill.info::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.pill.ok{color:var(--ok);border-color:rgba(140,203,158,.3)}
.pill.warn{color:var(--warn);border-color:rgba(226,178,110,.32)}
.pill.bad{color:var(--bad);border-color:rgba(224,142,146,.34)}
.pill.info{color:var(--info);border-color:rgba(143,184,230,.3)}
h1 .pill{margin-left:.4rem;position:relative;top:-.15em}
h2 .pill{margin-left:.3rem;position:relative;top:-.1em}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;min-height:2.5rem;padding:.55rem 1.05rem;border-radius:10px;border:1px solid rgba(237,190,90,.34);background:rgba(237,190,90,.12);color:var(--gold);font:500 13.5px/1.25 var(--sans);letter-spacing:.01em;text-decoration:none;text-align:center;cursor:pointer;-webkit-tap-highlight-color:transparent}
button:hover,.button:hover{background:rgba(237,190,90,.19);border-color:rgba(237,190,90,.55);color:var(--gold)}
.secondary,.button.secondary{background:transparent;border-color:rgba(255,255,255,.11);color:var(--soft)}
.secondary:hover,.button.secondary:hover{background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.22);color:var(--fg)}
button.danger{background:transparent;border-color:rgba(224,142,146,.34);color:var(--bad)}
button.danger:hover{background:rgba(224,142,146,.08);border-color:rgba(224,142,146,.55);color:var(--bad)}
button:disabled{opacity:.45;cursor:default;pointer-events:none}
button.link{min-height:0;padding:0;border:0;background:none;color:var(--soft);text-decoration:underline;text-decoration-color:rgba(237,190,90,.45);text-underline-offset:.22em}
button.link:hover{background:none;color:var(--gold)}
input:not([type=radio]):not([type=checkbox]),select,textarea{font:400 14px/1.4 var(--sans);color:var(--fg);background-color:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:.6rem .8rem;max-width:100%;min-height:2.5rem}
input:not([type=radio]):not([type=checkbox]):hover,select:hover,textarea:hover{border-color:rgba(255,255,255,.14)}
input:not([type=radio]):not([type=checkbox]):focus,select:focus,textarea:focus{outline:none;border-color:rgba(237,190,90,.6);box-shadow:0 0 0 3px rgba(237,190,90,.16)}
input::placeholder,textarea::placeholder{color:var(--muted)}
select{-webkit-appearance:none;appearance:none;padding-right:2.25rem;background-image:${CHEVRON};background-repeat:no-repeat;background-position:right .85rem center;background-size:10px 6px}
option{background:#15161A;color:var(--fg)}
input[type=radio],input[type=checkbox]{accent-color:var(--gold);width:1rem;height:1rem;margin:.2rem 0 0;flex:none}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{padding:.55rem .75rem;text-align:left;font:500 10px/1.4 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta);border-bottom:1px solid rgba(255,255,255,.08);white-space:nowrap;vertical-align:bottom}
td{padding:.7rem .75rem;font-size:13px;line-height:1.5;color:var(--fg);border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}
time{white-space:nowrap}
td>a:only-child{white-space:nowrap}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}
tbody tr:last-child td{border-bottom:0}
@media (min-width:40rem){h1{font-size:40px}}
@media (max-width:40rem){input:not([type=radio]):not([type=checkbox]),select,textarea{font-size:16px}button,.button{min-height:2.75rem}.table-wrap table{width:max-content;min-width:100%}td{max-width:17rem}}
@media (prefers-reduced-motion:no-preference){a,button,.button,input,select,textarea,summary{transition:color .15s,background-color .15s,border-color .15s,box-shadow .15s}}
`
