/**
 * Pure HTML builders. Pages are rendered on the server with everything a person needs to
 * read; the client bundle (`/assets/payrun.js`) only adds the passkey and signing steps.
 */

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}

/** Embeds JSON for the client. `<` is escaped so no value can close the script tag. */
const configScript = (config: unknown) =>
  `<script type="application/json" id="payrun-config">${JSON.stringify(config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).replaceAll('<', '\\u003c')}</script>`

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1f;--muted:#5f6368;--line:#e2e2de;--accent:#3b5bdb;--accent-fg:#fff;--ok:#2b8a3e;--warn:#b35c00;--bad:#c92a2a}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1d1d20;--fg:#ececee;--muted:#a0a0a8;--line:#2e2e33;--accent:#748ffc;--accent-fg:#0b0b0c;--ok:#69db7c;--warn:#ffa94d;--bad:#ff8787}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:38rem;margin:0 auto;padding:2rem 1rem 4rem}
.brand{font-weight:700;letter-spacing:.02em;color:var(--muted);margin:0 0 1.5rem}
.testnet{display:inline-block;margin-left:.5rem;padding:0 .5rem;border:1px solid var(--warn);border-radius:1rem;color:var(--warn);font-size:.8rem;font-weight:600}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .75rem}
h2{font-size:1.1rem;margin:0 0 .5rem}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.25rem;margin:1rem 0}
p{margin:.5rem 0}
.muted{color:var(--muted);font-size:.92rem}
code{font:.9rem ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
button{font:inherit;font-weight:600;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);padding:.6rem 1rem;cursor:pointer;margin:.25rem .5rem .25rem 0}
button.secondary{background:transparent;color:var(--accent)}
button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
button:disabled{opacity:.5;cursor:default}
label{display:block;margin:.6rem 0 .2rem;font-weight:600;font-size:.92rem}
input,select{font:inherit;width:100%;padding:.5rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.row{display:flex;gap:.75rem;flex-wrap:wrap}.row>div{flex:1 1 10rem}
#status{min-height:1.5rem;font-weight:600}
#status.ok{color:var(--ok)}#status.bad{color:var(--bad)}
a{color:var(--accent)}
`

export function page(opts: { title: string; body: string; config?: unknown; testnet: boolean }): string {
  const script = opts.config === undefined ? '' : `${configScript(opts.config)}<script type="module" src="/assets/payrun.js"></script>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(opts.title)}</title><style>${STYLE}</style></head>
<body><main><p class="brand">payrun${opts.testnet ? '<span class="testnet">testnet</span>' : ''}</p>${opts.body}</main>${script}</body></html>`
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
    title: 'payrun: link not valid',
    testnet,
    body: `<h1>${why}</h1><p>Run <code>${esc(command)}</code> in Discord for a new one.</p>`,
  })
}
