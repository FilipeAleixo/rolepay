import { esc, head } from '../../views/page.js'
import { INK_BASE, mark } from '../../views/theme.js'

/**
 * The dashboard's only stylesheet, inline: the shared ink base (views/theme.ts) and the dashboard's
 * own rules. Exported so the server can allow exactly it in the Content-Security-Policy (by hash).
 * Dark only; no script is needed for anything on the dashboard (forms post and redirect back,
 * `<details>` expands).
 */
export const DASHBOARD_STYLE = `${INK_BASE}
body{font-size:14px}
.skip{position:absolute;left:-999px;top:.75rem;z-index:10;padding:.6rem 1rem;border-radius:10px;background:#15161A;color:var(--gold);border:1px solid rgba(237,190,90,.4);text-decoration:none}
.skip:focus{left:1rem}
header.top,main{max-width:76rem;margin:0 auto;padding-left:1rem;padding-right:1rem}
header.top{padding-top:1.25rem}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem;min-height:2.75rem}
.brand,.community{font:500 10.5px/1.4 var(--sans);letter-spacing:.18em;text-transform:uppercase}
.brand{display:inline-flex;align-items:center;gap:.65rem;color:var(--meta);text-decoration:none;padding:.35rem 0}
.brand:hover{color:var(--fg)}
.dot{color:var(--muted)}
.community{color:var(--soft);min-width:0;overflow-wrap:anywhere}
.bar .testnet{margin-left:.15rem}
.spacer{flex:1}
.who{color:var(--meta);font-size:12px}
.bar form{margin:0}
.bar button.link{min-height:2rem;padding:.3rem .8rem;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:transparent;font-size:12px;color:var(--meta);text-decoration:none}
.bar button.link:hover{color:var(--fg);border-color:rgba(255,255,255,.2)}
nav.sections{margin-top:.9rem;border-bottom:1px solid var(--line)}
nav.sections ul{list-style:none;display:flex;gap:.5rem;margin:0 -.55rem;padding:0;overflow-x:auto;scrollbar-width:none}
nav.sections ul::-webkit-scrollbar{display:none}
nav.sections a{position:relative;display:block;padding:.75rem .55rem .7rem;border-radius:8px 8px 0 0;font:500 13px/1.2 var(--sans);color:var(--meta);text-decoration:none;white-space:nowrap}
nav.sections a:hover{color:var(--fg)}
nav.sections a[aria-current=page]{color:var(--gold)}
nav.sections a[aria-current=page]::after{content:"";position:absolute;left:.55rem;right:.55rem;bottom:0;height:1px;background:var(--gold)}
nav.sections a:focus-visible{outline-offset:-2px}
main{padding-top:2.25rem;padding-bottom:5rem}
h2{margin-bottom:.9rem}
main h1:has(.pill),.card h2:has(.pill){display:flex;flex-wrap:wrap;align-items:center;gap:.35rem .7rem}
main h1:has(.pill) .pill,.card h2:has(.pill) .pill{margin:0;top:0}
.lede{font-size:13px;color:var(--meta);margin:0 0 1.75rem;max-width:46rem}
p{margin:.6rem 0}
.card{position:relative;min-width:0;margin:0 0 1.25rem;padding:1.25rem;border-radius:16px;border:1px solid rgba(255,255,255,.05);background:var(--panel-bg);box-shadow:var(--panel-shadow)}
.card>:first-child{margin-top:0}
.card>:last-child{margin-bottom:0}
.grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr));margin:0 0 1.25rem}
.grid .card{margin:0}
.card ul:not(.card){list-style:none;margin:0;padding:0}
.card ul:not(.card) li{padding:.65rem 0;border-top:1px solid var(--line)}
.card ul:not(.card) li:first-child{border-top:0;padding-top:0}
ul.card{list-style:none;padding:.35rem 1.4rem}
ul.card li{border-top:1px solid var(--line)}
ul.card li:first-child{border-top:0}
ul.card a{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0;font:400 19px/1.3 var(--serif);color:var(--head);text-decoration:none}
ul.card a::after{content:"";width:7px;height:7px;flex:none;border-top:1.5px solid var(--meta);border-right:1.5px solid var(--meta);transform:rotate(45deg);margin-right:.25rem}
ul.card a:hover{color:var(--gold)}
ul.card a:hover::after{border-color:var(--gold)}
dl.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);margin:0;font-size:13.5px}
dl.facts dt,dl.facts dd{padding:.6rem 0;border-top:1px solid var(--line);line-height:1.55}
dl.facts dt{padding-right:1.5rem;font:500 10px/2.1 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta)}
dl.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
dl.facts dt:first-of-type,dl.facts dt:first-of-type+dd{border-top:0;padding-top:.15rem}
.big{margin:.1rem 0 .6rem;font:400 34px/1.15 var(--serif);color:var(--head);letter-spacing:-.01em;font-variant-numeric:lining-nums proportional-nums}
.big+p.muted{margin-top:-.35rem}
.card .big+dl.facts,.card p.muted+dl.facts{margin-top:.9rem}
code{color:#D8D6D1}
td code{white-space:nowrap;overflow-wrap:normal}
td .small{line-height:1.45}
a code{color:inherit}
blockquote{margin:.25rem 0 .9rem;padding:.15rem 0 .15rem 1rem;border-left:2px solid rgba(237,190,90,.4);font:400 16px/1.6 var(--serif);color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere}
.num{text-align:right;white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.info{color:var(--info)}
.notice,.notice.ok,.notice.bad,.notice.warn{position:relative;margin:0 0 1.25rem;padding:.85rem 1rem .85rem 2.2rem;border-radius:12px;border:1px solid rgba(255,255,255,.06);background:var(--panel-bg);box-shadow:var(--panel-shadow);color:var(--fg);font-size:13.5px}
.notice::before{content:"";position:absolute;left:1rem;top:calc(.85rem + .78em - 3px);width:6px;height:6px;border-radius:50%;background:var(--info)}
.notice.ok{border-color:rgba(140,203,158,.24)}.notice.ok::before{background:var(--ok)}
.notice.warn{border-color:rgba(226,178,110,.28)}.notice.warn::before{background:var(--warn)}
.notice.bad{border-color:rgba(224,142,146,.3)}.notice.bad::before{background:var(--bad)}
.card .notice{box-shadow:none;margin:.75rem 0 0}
h1+.notice{margin-top:1.25rem}
main>p:has(>.button){margin:0 0 1.25rem}
form.filters{display:flex;flex-wrap:wrap;gap:.75rem 1rem;align-items:flex-end;margin:0 0 1.25rem}
form.filters>div{flex:0 1 13rem;min-width:0}
form.filters select{width:100%}
form.filters label{font:500 10px/1.4 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta);margin-bottom:.45rem}
label{display:block;margin:0 0 .4rem;font:500 12.5px/1.4 var(--sans);color:var(--soft)}
input:not([type=radio]):not([type=checkbox]),select,textarea{font-size:13.5px}
textarea{width:100%;min-height:8rem;line-height:1.55;resize:vertical}
.field{margin:0 0 1.1rem}
.field input:not([type=radio]):not([type=checkbox]){width:100%}
.field select{width:100%}
fieldset,fieldset.field{border:0;border-top:1px solid var(--line);padding:1rem 0 0;margin:1.75rem 0 1rem;min-width:0}
legend{padding:0 .75rem 0 0;font:500 10px/1.4 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta)}
fieldset label{display:flex;gap:.65rem;align-items:flex-start;margin:.55rem 0;font:400 13.5px/1.5 var(--sans);color:var(--fg)}
fieldset label[for]{margin-top:1rem;font:500 12.5px/1.4 var(--sans);color:var(--soft)}
fieldset.field input:not([type=radio]):not([type=checkbox]){width:8rem}
.row{display:flex;flex-wrap:wrap;gap:0 1rem}
.row>.field{flex:1 1 11rem;min-width:0;display:flex;flex-direction:column;justify-content:flex-end}
.actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin:0 0 .25rem}
.actions form{margin:0}
.actions+.actions{margin-top:.6rem}
details{margin-top:.75rem}
details>summary{display:inline-block;padding:.3rem 0;cursor:pointer;font:500 12.5px/1.4 var(--sans);color:var(--soft)}
details>summary:hover{color:var(--fg)}
details>summary::before{content:"";display:inline-block;width:5px;height:5px;margin:0 .6rem .12em .1rem;border-top:1.5px solid currentColor;border-right:1.5px solid currentColor;transform:rotate(45deg)}
details[open]>summary::before{transform:rotate(135deg);margin-bottom:.2em}
details>summary::-webkit-details-marker{display:none}
details>summary{list-style:none}
ol.timeline{list-style:none;margin:0;padding:0 0 0 1.4rem;border-left:1px solid rgba(255,255,255,.1)}
ol.timeline li{position:relative;padding:0 0 1.1rem;font-size:13.5px}
ol.timeline li:last-child{padding-bottom:.1rem}
ol.timeline li::before{content:"";position:absolute;left:calc(-1.4rem - 5px);top:.5em;width:9px;height:9px;border-radius:50%;background:#101116;border:1px solid rgba(255,255,255,.4)}
ol.timeline li:last-child::before{border-color:var(--gold)}
ol.timeline .small{display:inline-block;margin-top:.15rem}
pre.diff{white-space:pre-wrap}
.add{color:var(--ok)}.del{color:var(--bad)}
.pager{display:flex;justify-content:space-between;gap:1rem;margin-top:1.1rem;padding-top:1rem;border-top:1px solid var(--line)}
.pager:not(:has(a)){display:none}
.pager a{display:inline-flex;align-items:center;min-height:2.5rem;padding:.5rem .95rem;border-radius:10px;border:1px solid rgba(255,255,255,.11);font-size:13px;color:var(--soft);text-decoration:none}
.pager a:hover{color:var(--fg);border-color:rgba(255,255,255,.22)}
.center{max-width:32rem;margin:4.5rem auto 3rem;text-align:center}
.center .lede,.center p{color:var(--soft)}
.center .muted{color:var(--muted)}
.center .button{margin-top:.5rem}
.center .card{text-align:left}
.center h1{font-size:30px}
@media (min-width:48rem){header.top,main{padding-left:2rem;padding-right:2rem}header.top{padding-top:1.75rem}main{padding-top:3rem}.card{padding:1.5rem 1.6rem}ul.card{padding:.35rem 1.6rem}}
@media (max-width:40rem){dl.facts{grid-template-columns:1fr}dl.facts dt{padding-bottom:0;border-top:1px solid var(--line)}dl.facts dd{border-top:0;padding-top:.1rem}dl.facts dt:first-of-type{padding-top:0}.big{font-size:30px}nav.sections ul{gap:0}.bar button.link{min-height:2.5rem}form.filters>div{flex:1 1 9rem}.pager a{min-height:2.75rem}}
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
<html lang="en">${head({ title: opts.title, style: DASHBOARD_STYLE })}
<body><a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar"><a class="brand" href="/dashboard">${mark(24)}Rolepay</a>${
    community ? `<span class="dot" aria-hidden="true">·</span><span class="community">${esc(community.name)}</span>` : ''
  }${opts.testnet ? '<span class="testnet">testnet</span>' : ''}<span class="spacer"></span>${who}</div>${nav}</header>
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
