import { esc } from '../../views/page.js'

/**
 * The dashboard's only stylesheet, inline. Exported so the server can allow exactly it in the
 * Content-Security-Policy (by hash). Light and dark follow the system; no script is needed for
 * anything on the dashboard (forms post and redirect back, `<details>` expands).
 */
export const DASHBOARD_STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f3;--surface:#fff;--fg:#1b1b1f;--muted:#5b5e66;--line:#e2e2dc;--accent:#3550c8;--accent-fg:#fff;--ok:#2b7a3b;--warn:#9a5200;--bad:#c02626;--info:#17609e;--code:#f0f0eb}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--surface:#1b1b1f;--fg:#ececef;--muted:#a3a4ac;--line:#2e2e34;--accent:#94a7ff;--accent-fg:#0d0d10;--ok:#6fd884;--warn:#ffb15c;--bad:#ff8a8a;--info:#7cc4fd;--code:#24242a}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-999px;top:.5rem;background:var(--surface);padding:.5rem 1rem;z-index:10}
.skip:focus{left:1rem}
header.top{background:var(--surface);border-bottom:1px solid var(--line)}
.bar,nav.sections ul,main{max-width:72rem;margin:0 auto;padding-left:1rem;padding-right:1rem}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1rem;padding-top:.7rem;padding-bottom:.5rem}
.brand{font-weight:750;color:var(--fg);text-decoration:none;font-size:1.1rem}
.community{font-weight:600}
.spacer{flex:1}
.who{color:var(--muted);font-size:.9rem}
.bar form{margin:0}
nav.sections ul{list-style:none;display:flex;gap:.25rem;overflow-x:auto;margin-top:0;margin-bottom:0}
nav.sections a{display:block;padding:.5rem .7rem;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap}
nav.sections a[aria-current=page]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
main{padding-top:1.5rem;padding-bottom:4rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 .25rem}
h2{font-size:1.1rem;margin:0 0 .75rem}
h3{font-size:1rem;margin:1rem 0 .5rem}
.lede{color:var(--muted);margin:0 0 1.25rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.25rem;margin:0 0 1rem;min-width:0}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));margin:0 0 1rem}
.grid .card{margin:0}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;margin:0}
dl.facts dt{color:var(--muted)}
dl.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.big{font-size:1.6rem;font-weight:650;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.small{font-size:.85rem}
code,pre{font:.85rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{overflow-wrap:anywhere}
td code{white-space:nowrap;overflow-wrap:normal}
pre{background:var(--code);border-radius:8px;padding:.75rem;overflow:auto;max-height:28rem;margin:.5rem 0 0}
blockquote{margin:0;padding:.25rem 0 .25rem 1rem;border-left:3px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
.num{text-align:right;white-space:nowrap}
.pill{display:inline-block;padding:0 .55rem;border-radius:1rem;font-size:.8rem;font-weight:600;border:1px solid currentColor;white-space:nowrap;line-height:1.6}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.info{color:var(--info)}
.notice{border:1px solid var(--line);border-left:4px solid var(--info);background:var(--surface);padding:.75rem 1rem;border-radius:8px;margin:0 0 1rem}
.notice.ok{border-left-color:var(--ok)}.notice.bad{border-left-color:var(--bad)}.notice.warn{border-left-color:var(--warn)}
form.filters{display:flex;flex-wrap:wrap;gap:.75rem;align-items:flex-end;margin:0 0 1rem}
label{display:block;font-weight:600;font-size:.85rem;margin:0 0 .25rem}
input,select,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.45rem .6rem;max-width:100%}
textarea{width:100%;min-height:7rem}
.field{margin:0 0 .9rem}
fieldset{border:1px solid var(--line);border-radius:8px;padding:.6rem 1rem .9rem;margin:1rem 0 .75rem}
legend{font-weight:600;padding:0 .3rem}
fieldset label{font-weight:400;font-size:.95rem;margin:.35rem 0}
.row{display:flex;flex-wrap:wrap;gap:.75rem}
button,.button{font:inherit;font-weight:600;display:inline-block;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);padding:.45rem .9rem;cursor:pointer;text-decoration:none;line-height:1.4}
.secondary{background:transparent;color:var(--accent)}
button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
button.link{background:none;border:0;color:var(--accent);padding:0;font-weight:500;text-decoration:underline}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end}
.actions form{margin:0}
details>summary{cursor:pointer;font-weight:600}
ol.timeline{list-style:none;padding:0 0 0 1rem;margin:0;border-left:2px solid var(--line)}
ol.timeline li{position:relative;padding:0 0 .8rem}
ol.timeline li::before{content:"";position:absolute;left:-1.4rem;top:.45rem;width:10px;height:10px;border-radius:50%;background:var(--accent)}
pre.diff{white-space:pre-wrap}
.add{color:var(--ok)}.del{color:var(--bad)}
.pager{display:flex;justify-content:space-between;gap:1rem;margin-top:1rem}
.center{max-width:32rem;margin:3rem auto;text-align:center}
.center .card{text-align:left}
@media (max-width:40rem){dl.facts{grid-template-columns:1fr}dl.facts dt{margin-top:.4rem}.big{font-size:1.35rem}h1{font-size:1.3rem}}
`

export type Section = 'overview' | 'runs' | 'payees' | 'policies' | 'audit'

/** Who is looking, for the header: their name and what they may do here. */
export type HeaderViewer = { userName: string; csrf: string; canAct?: boolean }

const SECTIONS: { id: Section; label: string; path: string }[] = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'runs', label: 'Runs', path: '/runs' },
  { id: 'payees', label: 'Payees', path: '/payees' },
  { id: 'policies', label: 'Policies', path: '/policies' },
  { id: 'audit', label: 'Audit log', path: '/audit' },
]

/** The CSRF field every dashboard form carries. */
export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`

export function shell(opts: {
  title: string
  testnet: boolean
  body: string
  viewer?: HeaderViewer
  community?: { id: string; name: string; section: Section }
}): string {
  const { viewer, community } = opts
  const role = viewer?.canAct === undefined ? '' : viewer.canAct ? ' · Treasurer' : ' · read only'
  const who = viewer
    ? `<span class="who">${esc(viewer.userName)}${role}</span>
<form method="post" action="/auth/logout">${csrfField(viewer.csrf)}<button type="submit" class="link">Sign out</button></form>`
    : ''
  const nav = community
    ? `<nav class="sections" aria-label="${esc(community.name)}"><ul>${SECTIONS.map(
        (s) =>
          `<li><a href="/dashboard/${esc(community.id)}${s.path}"${s.id === community.section ? ' aria-current="page"' : ''}>${s.label}</a></li>`,
      ).join('')}</ul></nav>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(opts.title)}</title><style>${DASHBOARD_STYLE}</style></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar"><a class="brand" href="/dashboard">Rolepay</a>${opts.testnet ? '<span class="pill warn">testnet</span>' : ''}${
    community ? `<span class="community">${esc(community.name)}</span>` : ''
  }<span class="spacer"></span>${who}</div>${nav}</header>
<main id="main">${opts.body}</main></body></html>`
}

/** A short page with one message (signed out, an error, a refusal). */
export function messagePage(opts: { title: string; heading: string; body: string; testnet: boolean; viewer?: HeaderViewer }): string {
  return shell({
    title: `Rolepay: ${opts.title}`,
    testnet: opts.testnet,
    ...(opts.viewer ? { viewer: opts.viewer } : {}),
    body: `<div class="center"><h1>${esc(opts.heading)}</h1>${opts.body}</div>`,
  })
}
