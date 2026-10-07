import { HEAD_LINKS, INK_BASE, mark } from './theme.js'

/**
 * Pure HTML builders. Pages are rendered on the server with everything a person needs to
 * read; the client bundle (`/assets/rolepay.js`) only adds the passkey and signing steps.
 */

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}

/** Embeds JSON for the client. `<` is escaped so no value can close the script tag. */
const configScript = (config: unknown) =>
  `<script type="application/json" id="rolepay-config">${JSON.stringify(config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).replaceAll('<', '\\u003c')}</script>`

/**
 * The pages' only stylesheet, inline: the shared ink base (theme.ts) and the rules for the claim,
 * setup, account and home pages. Exported so the server can allow exactly it in the CSP (by hash).
 */
export const STYLE = `${INK_BASE}
main{max-width:40rem;margin:0 auto;padding:1.75rem 1rem 4rem}
.brand{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .7rem;margin:0 0 2.25rem;font:500 10.5px/1.4 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:var(--meta)}
.brand .testnet{margin-left:.15rem}
h1+p{color:var(--soft);margin-bottom:1.5rem}
p{margin:.6rem 0}
section{margin:1.25rem 0;padding:1.25rem;border-radius:16px;border:1px solid rgba(255,255,255,.05);background:var(--panel-bg);box-shadow:var(--panel-shadow)}
section>:first-child,section>div:first-child>:first-child{margin-top:0}
section>:last-child{margin-bottom:0}
.muted{font-size:13.5px;color:var(--meta)}
code{word-break:break-all;background:rgba(255,255,255,.05);border-radius:6px;padding:.12em .4em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
button{margin:.3rem .5rem .3rem 0}
label{display:block;margin:.9rem 0 .4rem;font:500 12.5px/1.4 var(--sans);color:var(--soft)}
input:not([type=radio]):not([type=checkbox]),select{width:100%}
.row{display:flex;gap:0 .9rem;flex-wrap:wrap}.row>div{flex:1 1 10rem}
form>button:last-of-type{margin-top:.75rem}
#status{margin:1rem 0 0;font-size:14px}
#status:not(:empty){position:relative;padding:.85rem 1rem .85rem 2.2rem;border-radius:12px;border:1px solid rgba(255,255,255,.06);background:var(--panel-bg);box-shadow:var(--panel-shadow)}
#status:not(:empty)::before{content:"";position:absolute;left:1rem;top:calc(.85rem + .8em - 3px);width:6px;height:6px;border-radius:50%;background:var(--meta)}
#status.ok{border-color:rgba(140,203,158,.26)}#status.ok::before{background:var(--ok)}
#status.bad{border-color:rgba(224,142,146,.3)}#status.bad::before{background:var(--bad)}
strong[data-field]{font:400 1.25em/1 var(--serif);color:var(--head);font-variant-numeric:lining-nums}
#balances p{margin:.2rem 0;color:var(--soft)}
#balances strong{font:400 30px/1.25 var(--serif);color:var(--head);margin-right:.3rem;font-variant-numeric:lining-nums proportional-nums}
#live-keys p{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:1rem 0 0;padding-top:1rem;border-top:1px solid var(--line);font-size:14px}
#live-keys button{margin:0}
noscript p{color:var(--muted)}
.home{max-width:44rem;padding-top:3rem}
.home h1+p{margin-bottom:2.5rem}
.home .brand{margin-bottom:1.5rem}
.wordmark{display:flex;align-items:center;gap:1rem;margin:0 0 1rem;font-size:48px;line-height:1;letter-spacing:-.015em}
.tagline{margin:0 0 2.5rem;font-size:17px;line-height:1.55;color:var(--soft);max-width:34rem}
.home h2{font:500 10.5px/1.5 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:var(--meta);margin:0 0 .25rem}
ol.trust{list-style:none;margin:0;padding:0}
ol.trust li{display:flex;gap:1rem;align-items:baseline;padding:.9rem 0;border-top:1px solid var(--line)}
ol.trust li:first-child{border-top:0}
ol.trust .n{font:400 22px/1 var(--serif);color:var(--meta);min-width:1.1rem;font-variant-numeric:lining-nums}
ol.trust p{margin:0;font-size:15.5px;color:var(--fg)}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1rem;margin:2rem 0 0}
.cta .button{margin:0}
.cta .source{font-size:13.5px;color:var(--soft)}
@media (min-width:40rem){main{padding-top:3.5rem}section{padding:1.5rem 1.6rem}.home{padding-top:clamp(5rem,16vh,10rem)}.wordmark{font-size:56px}}
@media (max-width:40rem){.cta .button{flex:1 1 100%}}
`

/** The document head: the title, the favicon and font preloads, and one inline stylesheet (allowed by its hash). */
export function head(opts: { title: string; style: string; description?: string; index?: boolean }): string {
  const robots = opts.index ? '' : '<meta name="robots" content="noindex">'
  const description = opts.description ? `<meta name="description" content="${esc(opts.description)}">` : ''
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${robots}${description}<title>${esc(opts.title)}</title>${HEAD_LINKS}<style>${opts.style}</style></head>`
}

/** The META brand line: the mark, "Rolepay", and the testnet pill on testnet. */
const brandLine = (testnet: boolean) => `<p class="brand">${mark(24)}Rolepay${testnet ? '<span class="testnet">testnet</span>' : ''}</p>`

export function page(opts: { title: string; body: string; config?: unknown; testnet: boolean }): string {
  const script = opts.config === undefined ? '' : `${configScript(opts.config)}<script type="module" src="/assets/rolepay.js"></script>`
  return `<!doctype html>
<html lang="en">${head({ title: opts.title, style: STYLE })}
<body><main>${brandLine(opts.testnet)}${opts.body}</main>${script}</body></html>`
}

/** What a person sees for a link that no longer works. `command` is the Discord command that issues a new one. */
export function linkErrorPage(code: string, command: string, testnet: boolean): string {
  const why =
    code === 'link_expired'
      ? 'This link has expired.'
      : code === 'link_already_used'
        ? 'This link was already used.'
        : 'This link is not valid.'
  return page({
    title: 'Rolepay: link not valid',
    testnet,
    body: `<h1>${why}</h1><p>Run <code>${esc(command)}</code> in Discord for a new one.</p>`,
  })
}
