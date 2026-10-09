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
 * What the home page's small "Paid per week" picture shows, oldest week first (made-up USDC.e, on
 * a scale of 0 to 100, so each is also its bar's height in percent; the last week is in progress).
 * Here because the stylesheet draws the bars; the home page writes the total and the label from it.
 */
export const PAID_WEEKS: readonly number[] = [30, 45, 40, 70, 35, 60, 50, 25]

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
label.check{display:flex;gap:.65rem;align-items:flex-start;margin:.6rem 0;font:400 14px/1.5 var(--sans);color:var(--fg)}
#payouts p{margin:.9rem 0 .2rem}
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
#balances p{border-radius:10px;transition:box-shadow .6s ease}
#balances .pill{margin-left:.4rem}
#balances p.glow strong{animation:rp-glow 1.6s ease-out}
@keyframes rp-glow{0%{color:var(--gold);text-shadow:0 0 0 rgba(237,190,90,0)}30%{color:var(--gold);text-shadow:0 0 18px rgba(237,190,90,.55)}100%{color:var(--head);text-shadow:0 0 0 rgba(237,190,90,0)}}
ul.received{list-style:none;margin:0;padding:0}
ul.received li{display:flex;flex-wrap:wrap;align-items:baseline;gap:.15rem .5rem;padding:.7rem 0;border-top:1px solid var(--line);font-size:14px;color:var(--soft)}
ul.received li:first-child{border-top:0;padding-top:0}
ul.received li strong{font:400 18px/1.3 var(--serif);color:var(--head);font-variant-numeric:lining-nums}
ul.received li.none{color:var(--meta)}
ul.received li.arrived{animation:rp-arrive .7s cubic-bezier(.2,.7,.2,1)}
@keyframes rp-arrive{from{opacity:0;transform:translateY(-.6rem)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){#balances p.glow strong,ul.received li.arrived{animation:none}}
#live-keys p{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:1rem 0 0;padding-top:1rem;border-top:1px solid var(--line);font-size:14px}
#live-keys button{margin:0}
noscript p{color:var(--muted)}
@media (min-width:40rem){main{padding-top:3.5rem}section{padding:1.5rem 1.6rem}}
/* The home page. A breathing light behind the hero (opacity and transform only, still under reduced motion), the top bar, a product shot, then editorial sections. */
/* The lights are scoped to .atmos: this stylesheet serves every page, and a bare .glow also took the account's balance row out of its card while a payment glowed. */
.atmos{position:absolute;top:0;left:0;right:0;height:66rem;overflow:hidden;z-index:-1;pointer-events:none}
.atmos .glow{position:absolute;display:block;border-radius:50%;opacity:.7}
.atmos .glow.warm{left:-24rem;top:-26rem;width:72rem;height:54rem;background:radial-gradient(closest-side,rgba(237,190,90,.14),rgba(237,190,90,.05) 48%,rgba(237,190,90,0))}
.atmos .glow.cool{right:-26rem;top:6rem;width:68rem;height:52rem;background:radial-gradient(closest-side,color-mix(in srgb,var(--accent-2) 16%,transparent),color-mix(in srgb,var(--accent-2) 5%,transparent) 48%,transparent)}
@media (prefers-reduced-motion:no-preference){.atmos .glow{will-change:opacity,transform}.atmos .glow.warm{animation:rp-breathe 9s ease-in-out infinite}.atmos .glow.cool{animation:rp-breathe-cool 9s ease-in-out -4.5s infinite}}
@keyframes rp-breathe{0%,100%{opacity:.55;transform:translate3d(0,0,0)}50%{opacity:.85;transform:translate3d(3%,2%,0)}}
@keyframes rp-breathe-cool{0%,100%{opacity:.55;transform:translate3d(0,0,0)}50%{opacity:.85;transform:translate3d(-3%,-2%,0)}}
.topbar{position:relative}
.topbar::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,rgba(237,190,90,0),rgba(237,190,90,.2) 25%,rgba(255,255,255,.07) 50%,color-mix(in srgb,var(--accent-2) 22%,transparent) 75%,transparent)}
.topbar .bar{max-width:70rem;margin:0 auto;padding:.85rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.topbar .logo{display:flex;align-items:center;gap:.6rem;margin:0;font:400 20px/1 var(--serif);letter-spacing:-.01em;color:var(--head)}
.topbar nav{display:flex;align-items:center;gap:1.4rem}
.topbar .quiet{font-size:13.5px;color:var(--soft);text-decoration:none}
.topbar .quiet:hover{color:var(--fg)}
.topbar nav a{white-space:nowrap}
.topbar .narrow{display:none}
.topbar .button,.home .button:not(.secondary){white-space:nowrap}
.topbar .button:not(.cool),.home .button:not(.secondary):not(.cool){box-shadow:0 12px 30px -16px rgba(237,190,90,.65)}
/* One gold button per screen. The second action is a periwinkle outline, no fill and no glow: periwinkle is Discord's colour on the home page, and these are Discord actions. */
.button.cool{background:transparent;border-color:color-mix(in srgb,var(--accent-2) 28%,transparent);color:var(--accent-2)}
.button.cool:hover{background:color-mix(in srgb,var(--accent-2) 6%,transparent);border-color:color-mix(in srgb,var(--accent-2) 55%,transparent);color:color-mix(in srgb,var(--accent-2),#fff 18%)}
.home{max-width:70rem;padding:0 1rem 2.5rem}
.home section{margin:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none}
.home ul,.home ol{list-style:none;margin:0;padding:0}
.home h2{font-size:30px;line-height:1.2;letter-spacing:-.015em;margin:0}
.home h1,.home h2,.home h3{text-wrap:balance}
.home h3{margin:0 0 .4rem;font:400 21px/1.3 var(--serif);letter-spacing:-.01em;text-transform:none;color:var(--head)}
.home .hero{display:grid;gap:3.25rem;align-items:center;padding:3rem 0 4.5rem}
.home .badge{margin:0 0 1.5rem}
.home .hero h1{font-size:42px;line-height:1.06;letter-spacing:-.025em;margin:0 0 1.4rem;max-width:11em}
.home .hero .sub{margin:0 0 2.25rem;font-size:17px;line-height:1.65;color:var(--soft);max-width:30rem}
.home .actions{display:flex;flex-wrap:wrap;align-items:center;gap:1rem 1.75rem;margin:0}
.home .actions .button{margin:0;min-height:2.85rem;padding:.65rem 1.3rem;font-size:14px}
.home .actions.pair{display:grid;grid-template-columns:repeat(2,minmax(0,13.5rem));gap:1rem}
.home .actions.pair .button{justify-content:center;text-align:center}
.home .more{font-size:14px;color:var(--soft);text-decoration:none}
.home .more::after{content:"\\2193";margin-left:.45em;color:var(--accent-2)}
.home .more:hover{color:var(--fg)}
/* What to do once in the demo server, in one line on a desktop: wider than its column by about 2.5rem, into the gap beside the product shot, where the shot has nothing at that height. */
.home .hint{max-width:28rem;margin:1.15rem 0 0;font-size:13px;line-height:1.6;color:var(--meta);text-wrap:pretty}
.home .down{margin:1rem 0 0}
.home .hint code{white-space:nowrap;word-break:normal}
.shot{display:flex;flex-direction:column;gap:.9rem;width:100%;max-width:30rem;justify-self:center}
.shot p{margin:0}
.shot .ways{padding:.95rem 1.05rem .95rem;border-radius:16px;border:1px solid color-mix(in srgb,var(--accent-2) 26%,transparent);background:linear-gradient(180deg,#141623,#101220);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 30px 60px -34px rgba(0,0,0,.95),0 0 46px -16px color-mix(in srgb,var(--accent-2) 42%,transparent)}
.shot .w-label{font:500 10.5px/1.5 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--meta)}
.shot .ways ul{margin:.4rem 0 0}
.shot .ways li{display:grid;grid-template-columns:minmax(0,1fr) 7.5rem;gap:1rem;align-items:baseline;padding:.55rem 0;border-top:1px solid var(--line);font-size:13px;line-height:1.5}
.shot .ways li:first-child{border-top:0}
.shot .w-what{color:var(--head)}
.shot .w-how{font-size:11.5px;line-height:1.45;color:var(--muted);text-align:right}
.shot .ways .ai{margin:.2rem -.6rem 0;padding:.55rem .6rem;border-top:0;border-radius:10px;background:color-mix(in srgb,var(--accent-2) 7%,transparent)}
.shot .ai .w-what{position:relative;padding-left:1.45rem}
.shot .ai svg{position:absolute;left:0;top:.15em;color:var(--accent-2)}
.shot .ai-foot{margin-top:.7rem;font-size:12px;line-height:1.5;color:var(--soft);text-wrap:pretty}
@media (max-width:40rem){.shot .ways li{grid-template-columns:minmax(0,1fr);gap:.1rem}.shot .w-how{text-align:left}}
.shot .ch{padding:0 .2em;border-radius:3px;color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 9%,transparent)}
.shot .msg{padding:1rem 1.1rem 1.1rem;border-radius:16px;border:1px solid rgba(255,255,255,.07);background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.022));box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 40px 80px -40px rgba(0,0,0,.95)}
.shot .who{display:flex;align-items:center;gap:.55rem;margin-bottom:.7rem;font-size:13px;color:var(--meta)}
.shot .who .mark{clip-path:circle(50%)}
.shot .who b{font-weight:600;font-size:14px;color:var(--head)}
.shot .app{padding:.3em .45em;border-radius:4px;font:600 9px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 16%,transparent)}
.shot .when{font-size:11.5px;color:var(--muted)}
.shot .embed{margin-left:2.6rem;padding:.75rem .95rem .8rem;border-left:3px solid var(--ok);border-radius:4px 8px 8px 4px;background:rgba(0,0,0,.22)}
.shot .e-title{font:600 14px/1.4 var(--sans);color:var(--head)}
.shot .e-note{margin:.1rem 0 .5rem;font-size:13px;color:var(--soft)}
.shot .lines li{display:flex;justify-content:space-between;gap:1rem;padding:.3rem 0;border-top:1px solid rgba(255,255,255,.045);font-size:13px}
.shot .lines li:first-child{border-top:0}
.shot .at{padding:0 .2em;border-radius:3px;color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 9%,transparent)}
.shot .amt{color:var(--fg);font-variant-numeric:tabular-nums}
.shot .e-status{margin-top:.6rem;font-size:12.5px;line-height:1.5;color:var(--soft)}
.shot .e-foot{margin-top:.3rem;font-size:11px;color:var(--muted)}
.shot .budget{padding:1.05rem 1.15rem 1rem;border-radius:16px;border:1px solid rgba(255,255,255,.075);background:linear-gradient(180deg,#18191E,#121317);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 30px 60px -24px rgba(0,0,0,.95)}
.shot .b-label{font:500 10px/1.5 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta)}
.shot .b-amount{margin:.35rem 0 .85rem;font-size:13px;color:var(--meta)}
.shot .b-amount strong{margin-right:.3rem;font:400 28px/1 var(--serif);color:var(--head);font-variant-numeric:lining-nums}
.shot .b-bar{position:relative;height:8px;margin-right:2px;border-radius:4px;background:rgba(255,255,255,.08)}
.shot .b-fill{position:absolute;left:0;top:0;bottom:0;width:60%;border-radius:4px;background:linear-gradient(90deg,rgba(237,190,90,.5),rgba(237,190,90,.85))}
.shot .b-limit{position:absolute;right:-2px;top:-7px;width:2px;height:22px;border-radius:1px;background:var(--gold);box-shadow:0 0 10px rgba(237,190,90,.7),0 0 24px rgba(237,190,90,.35)}
.shot .b-row{display:flex;justify-content:space-between;gap:1rem;margin-top:.7rem;font-size:11.5px;color:var(--meta)}
.shot .b-lim{font:500 9.5px/1.6 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--gold)}
.shot .b-cap{margin-top:.75rem;padding-top:.7rem;border-top:1px solid var(--line);font-size:12px;color:var(--soft)}
/* Where each card lives, quietly, at the right end of its first row: "Discord" on the run, "Dashboard" on the allowance (its label breaks after "allowance" to leave the gap). */
.shot .surface{flex:none;font:500 9.5px/1.5 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.shot .who{flex-wrap:wrap;row-gap:.2rem}
.shot .when{white-space:nowrap}
.shot .who .surface{margin-left:auto;padding-left:.75rem}
.shot .b-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem}
@media (max-width:25rem){.shot .day{display:none}}
/* Below the hero the sections are told apart by their shape and their type, not by boxes and rules. A line is drawn only where it carries something: a change, a sequence, the end of the page. */
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.home .kicker{margin:0 0 1rem;font:500 10.5px/1.5 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:var(--accent-2)}
.home .lede{margin:1.25rem 0 0;font:400 18px/1.6 var(--serif);color:var(--soft);max-width:30rem;text-wrap:pretty}
/* What it replaces: each line a pair, today dimmed in the sans and Rolepay brighter in the serif. Wide, the two sit either side of one axis, joined by a thread of light that ends in a gold point. */
.home .contrast{padding:2rem 0 0}
.home .contrast .cols{display:none;margin:0 0 1.75rem;font:500 10.5px/1.5 var(--sans);letter-spacing:.18em;text-transform:uppercase}
.home .contrast .cols span:first-child{color:var(--meta)}
.home .contrast .cols span:last-child{color:var(--gold)}
.home .contrast ul{display:grid;gap:1.6rem}
.home .contrast li{display:grid;gap:.3rem}
.home .contrast p{margin:0}
.home .contrast .was{font-size:13.5px;line-height:1.5;color:var(--meta);text-wrap:balance}
.home .contrast .now{position:relative;padding-left:1.2rem;font:400 19px/1.4 var(--serif);letter-spacing:-.005em;color:var(--head);text-wrap:balance}
.home .contrast .now::after{content:"";position:absolute;left:0;top:.64em;width:6px;height:6px;border-radius:50%;background:var(--gold);box-shadow:0 0 0 3px rgba(237,190,90,.12),0 0 12px rgba(237,190,90,.55)}
@media (min-width:60rem){.home .contrast .cols,.home .contrast li{grid-template-columns:minmax(0,.85fr) 5rem minmax(0,1.15fr)}.home .contrast .cols{display:grid}.home .contrast .cols span:first-child{text-align:right}.home .contrast .cols span:last-child{grid-column:3}.home .contrast ul{gap:1.4rem}.home .contrast li{gap:0;align-items:baseline}.home .contrast .was{text-align:right;font-size:15px}.home .contrast .now{grid-column:3;padding-left:0;font-size:23px}.home .contrast .now::before{content:"";position:absolute;right:calc(100% + .9rem);top:.78em;width:3.2rem;height:1px;background:linear-gradient(90deg,rgba(237,190,90,0),rgba(237,190,90,.7))}.home .contrast .now::after{left:auto;right:calc(100% + .9rem - 3px);top:calc(.78em - 2.5px)}}
/* How a run works: four steps on one quiet thread, with large serif numerals as its stations. The thread runs in the periwinkle of the work and warms to gold at the step that pays. */
.home .how{display:grid;gap:2.75rem;padding:6.5rem 0 0}
.home .how h2{max-width:15em}
.home .steps li{position:relative;display:grid;grid-template-columns:3.5rem minmax(0,1fr);align-items:baseline;padding:0 0 2.6rem}
.home .steps li:last-child{padding-bottom:0}
.home .steps .n{justify-self:center;font:400 30px/1 var(--serif);letter-spacing:-.01em;color:var(--accent-2);font-variant-numeric:lining-nums tabular-nums}
.home .steps li:not(:last-child)::before{content:"";position:absolute;left:1.75rem;top:2.3rem;bottom:.35rem;width:1px;background:linear-gradient(180deg,color-mix(in srgb,var(--accent-2) 50%,transparent),color-mix(in srgb,var(--accent-2) 12%,transparent))}
.home .steps li:nth-child(3)::before{background:linear-gradient(180deg,color-mix(in srgb,var(--accent-2) 50%,transparent),rgba(237,190,90,.5))}
.home .steps li:last-child .n{color:var(--gold);text-shadow:0 0 24px rgba(237,190,90,.4)}
.home .steps h3{margin:0 0 .45rem}
.home .steps p{margin:0;font-size:15px;line-height:1.65;color:var(--soft);max-width:33rem}
@media (min-width:60rem){.home .how{grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:5rem;padding-top:8.5rem}.home .how .intro{position:sticky;top:3rem;align-self:start}.home .steps li{grid-template-columns:5rem minmax(0,1fr);padding-bottom:3.1rem}.home .steps .n{font-size:44px}.home .steps li:not(:last-child)::before{left:2.5rem;top:3rem}.home .steps h3{font-size:23px}}
/* The two places: no panels, only the two pictures, each on its own pool of light, with what happens there in plain lines under it. */
.home .places{padding:7rem 0 0}
.home .places h2{max-width:15em}
.home .places .lede{max-width:33rem}
.home .panes{display:grid;gap:4.5rem;margin-top:3.25rem}
.home .pane{position:relative;min-width:0}
.home .pane h3{margin:0;font-size:25px}
.home .pane .where{margin:.3rem 0 0;font-size:14px;color:var(--meta)}
.home .pane ul{display:grid;gap:.85rem;margin-top:1.75rem}
.home .pane li{position:relative;padding-left:1.25rem;font-size:14.5px;line-height:1.6;color:var(--soft)}
.home .pane li::before{content:"";position:absolute;left:.1rem;top:calc(.8em - 2px);width:5px;height:5px;border-radius:50%;background:var(--gold);opacity:.85}
.home .pane.cool li::before{background:var(--accent-2)}
.home .pane .cmd{padding:0 .25em;border-radius:4px;white-space:nowrap;color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 10%,transparent)}
.home .pane .also{position:relative;margin:2rem 0 0;padding-left:1.25rem;font:400 17px/1.55 var(--serif);color:var(--fg);max-width:30rem;text-wrap:pretty}
.home .pane .also::before{content:"";position:absolute;left:0;top:.62em;width:6px;height:6px;border-radius:50%;background:var(--gold);box-shadow:0 0 0 3px rgba(237,190,90,.12),0 0 12px rgba(237,190,90,.55)}
@media (prefers-reduced-motion:no-preference){.home .pane .also::before{animation:rp-live 4.5s ease-in-out infinite}}
@keyframes rp-live{0%,100%{opacity:.5}50%{opacity:1}}
.home .weeks{margin:1.6rem 0 0;padding:1rem 1.1rem .85rem;border-radius:14px;border:1px solid rgba(255,255,255,.075);background:linear-gradient(180deg,#18191E,#121317);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 24px 50px -30px rgba(0,0,0,.95),0 0 70px -24px rgba(237,190,90,.26)}
.home .weeks p{margin:0}
.home .wk-label{font:500 10px/1.5 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--meta)}
.home .weeks .wk-amount{margin:.35rem 0 1.1rem;font-size:13px;color:var(--meta)}
.home .wk-amount strong{margin-right:.3rem;font:400 26px/1 var(--serif);color:var(--head);font-variant-numeric:lining-nums}
.home .wk-chart{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:.6rem}
.home .wk-axis{position:relative;height:6.5rem;min-width:1.35rem}
.home .wk-axis span{position:absolute;top:0;right:0;font:400 10px/1 var(--sans);color:var(--muted);font-variant-numeric:tabular-nums;transform:translateY(-50%)}
.home .wk-axis span:nth-child(2){top:50%}.home .wk-axis span:nth-child(3){top:100%}
.home .wk-bars{display:grid;grid-template-columns:repeat(${PAID_WEEKS.length},minmax(0,1fr));align-items:end;height:6.5rem;border-bottom:1px solid rgba(255,255,255,.16);background:linear-gradient(rgba(255,255,255,.06),rgba(255,255,255,.06)) 0 0/100% 1px no-repeat,linear-gradient(rgba(255,255,255,.06),rgba(255,255,255,.06)) 0 50%/100% 1px no-repeat}
.home .wk-bars>span{position:relative;justify-self:center;width:min(20px,60%);border-radius:3px 3px 0 0;background:linear-gradient(180deg,rgba(237,190,90,.9),rgba(237,190,90,.55))}
${PAID_WEEKS.map((v, i) => `.home .wk-bars>span:nth-child(${i + 1}){height:${v}%}`).join('')}
.home .wk-bars .sofar{position:absolute;left:50%;bottom:100%;margin-bottom:.35rem;transform:translateX(-50%);font:400 10px/1 var(--sans);color:var(--soft);white-space:nowrap}
.home .wk-ticks{grid-column:2;display:grid;grid-template-columns:repeat(${PAID_WEEKS.length},minmax(0,1fr));margin-top:.5rem;font:400 10.5px/1.4 var(--sans);color:var(--muted)}
.home .wk-ticks span{grid-row:1;justify-self:center;white-space:nowrap}
.home .wk-ticks span:nth-child(1){grid-column:2}.home .wk-ticks span:nth-child(2){grid-column:4}.home .wk-ticks span:nth-child(3){grid-column:5}.home .wk-ticks span:nth-child(4){grid-column:6}.home .wk-ticks span:nth-child(5){grid-column:8;justify-self:end}
.home .wk-ticks .n{display:none}
.home .dm{margin:1.6rem 0 0;padding:.95rem 1rem 1rem;border-radius:14px;border:1px solid color-mix(in srgb,var(--accent-2) 16%,transparent);background:linear-gradient(180deg,#141623,#101220);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 24px 50px -30px rgba(0,0,0,.95),0 0 70px -22px color-mix(in srgb,var(--accent-2) 34%,transparent)}
.home .dm p{margin:0}
.home .dm .who{display:flex;flex-wrap:wrap;align-items:center;gap:.2rem .5rem;margin-bottom:.6rem;font-size:13px;color:var(--meta)}
.home .dm .who .mark{clip-path:circle(50%)}
.home .dm .who b{font-weight:600;font-size:13.5px;color:var(--head)}
.home .dm .app{padding:.3em .45em;border-radius:4px;font:600 8.5px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 16%,transparent)}
.home .dm .when{font-size:11px;color:var(--muted)}
.home .dm .embed{margin-left:2rem;padding:.65rem .85rem .75rem;border-left:3px solid var(--ok);border-radius:4px 8px 8px 4px;background:rgba(0,0,0,.22)}
.home .dm .e-title{font:600 14px/1.4 var(--sans);color:var(--head)}
.home .dm .e-note{margin-top:.15rem;font-size:12.5px;line-height:1.5;color:var(--soft)}
.home .dm .e-note b{font-weight:600;color:var(--fg)}
.home .dm .fields{display:flex;flex-wrap:wrap;gap:.4rem 1.5rem;margin-top:.6rem;font-size:12.5px;color:var(--fg);font-variant-numeric:tabular-nums}
.home .dm .f-name{display:block;font-size:11.5px;font-weight:600;color:var(--soft)}
.home .dm .links{display:flex;flex-wrap:wrap;gap:.45rem;margin:.6rem 0 0 2rem}
.home .dm .links span{padding:.4rem .7rem;border-radius:4px;font-size:12px;font-weight:500;color:var(--fg);background:rgba(255,255,255,.08)}
.home .dm .links span::after{content:"\\2197";margin-left:.4em;color:var(--muted)}
@media (max-width:60rem){.home .wk-bars>span{width:min(14px,60%)}.home .wk-ticks .w{display:none}.home .wk-ticks .n{display:block}.home .dm .embed,.home .dm .links{margin-left:0}}
@media (min-width:40rem) and (max-width:59.99rem){.home .pane{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:2rem;align-items:start}.home .pane>h3,.home .pane>.where,.home .pane>.also{grid-column:1/-1}.home .pane>ul{grid-column:2}}
@media (min-width:60rem){.home .panes{grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);column-gap:5rem}}
@media (min-width:72rem){.home .pane:not(.cool) ul{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:2rem;row-gap:1rem}}
/* Who it is for: two lanes, the people paid and the treasurer, each named in the serif beside its three features. */
.home .details{padding:7rem 0 0}
.home .details h2{margin:0 0 2.5rem;font:500 10.5px/1.5 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:var(--meta)}
.home .groups{display:grid;gap:3.25rem}
.home .group h3{margin:0 0 1.5rem;font:400 25px/1.25 var(--serif);color:var(--head)}
.home .features{display:grid;gap:1.6rem}
.home .features li{display:grid;grid-template-columns:2.4rem minmax(0,1fr);align-items:start}
.home .features svg{margin-top:.1rem;color:var(--gold)}
.home .features .cool svg{color:var(--accent-2)}
.home .features p{margin:0;font-size:14.5px;line-height:1.6;color:var(--soft)}
.home .features strong{display:block;margin:0 0 .2rem;font:400 18px/1.4 var(--serif);color:var(--head)}
@media (min-width:60rem){.home .group{display:grid;grid-template-columns:minmax(0,13rem) minmax(0,1fr);column-gap:3.5rem;align-items:start}.home .group h3{margin:2.15rem 0 0}.home .features{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:2.5rem}.home .features li{display:block}.home .features svg{display:block;margin:0 0 1rem}}
/* Why you can trust it: three statements set as one confident block, centred on a soft pool of gold light under a single arc of it. No card: the light is the frame. */
.home section.trust{position:relative;margin:0;padding:9rem 0 0;text-align:center}
.home section.trust::before{content:"";position:absolute;left:50%;top:6.25rem;width:min(26rem,70%);height:2.4rem;transform:translateX(-50%);border-top:1px solid rgba(237,190,90,.7);border-radius:50%;-webkit-mask-image:linear-gradient(90deg,transparent,#000 35%,#000 65%,transparent);mask-image:linear-gradient(90deg,transparent,#000 35%,#000 65%,transparent);filter:drop-shadow(0 0 5px rgba(237,190,90,.55))}
.home section.trust::after{content:"";position:absolute;left:50%;top:5rem;width:52rem;max-width:100%;height:34rem;transform:translateX(-50%);border-radius:50%;background:radial-gradient(closest-side,rgba(237,190,90,.075),rgba(237,190,90,.025) 55%,rgba(237,190,90,0));pointer-events:none}
.home .trust h2{position:relative;z-index:1;margin:0 auto 3rem;max-width:15em}
.home .trust ul{position:relative;z-index:1;display:grid;gap:2.75rem;max-width:40rem;margin:0 auto}
.home .trust li{display:grid;justify-items:center;gap:.85rem}
.home .ic{display:flex;color:var(--gold)}
.home .ic svg{display:block}
.home .trust p{margin:0}
.home .trust strong{display:block;font:400 23px/1.35 var(--serif);letter-spacing:-.005em;color:var(--head);text-wrap:balance}
.home .trust p>span{display:block;max-width:31rem;margin:.6rem auto 0;font-size:15px;line-height:1.65;color:var(--soft);text-wrap:balance}
.home .final{position:relative;padding:8rem 0 1rem;text-align:center}
.home .final::before{content:"";position:absolute;left:50%;top:4rem;width:44rem;max-width:100%;height:16rem;transform:translateX(-50%);border-radius:50%;background:radial-gradient(closest-side,rgba(237,190,90,.075),rgba(237,190,90,0));pointer-events:none}
.home .final>*{position:relative}
.home .final h2{margin:0 auto 2rem;max-width:14em}
.home .cta{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:.75rem 1.1rem;margin:0}
.home .cta .button{margin:0}
.home .cta .source{font-size:13.5px;color:var(--soft)}
/* The foot of the page: the name again, and what it was built for, under the same thread of light that closes the top bar. */
.foot{position:relative;max-width:70rem;margin:3.5rem auto 0;padding:1.75rem 1rem 2.25rem;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem 2rem}
.foot::before{content:"";position:absolute;left:1rem;right:1rem;top:0;height:1px;background:linear-gradient(90deg,rgba(237,190,90,0),rgba(237,190,90,.2) 25%,rgba(255,255,255,.07) 50%,color-mix(in srgb,var(--accent-2) 22%,transparent) 75%,transparent)}
.foot .logo{display:flex;align-items:center;gap:.55rem;margin:0;font:400 17px/1 var(--serif);color:var(--head)}
.foot .footnote{margin:0;font-size:12.5px;color:var(--meta)}
@media (min-width:40rem){.topbar .bar,.home,.foot{padding-left:1.5rem;padding-right:1.5rem}.foot::before{left:1.5rem;right:1.5rem}.home h2{font-size:36px}.home .hero h1{font-size:56px}}
@media (min-width:60rem){.home .hero{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:4.5rem;padding:4.75rem 0 6rem}.home .hero h1{font-size:62px}.home .trust strong{font-size:26px}.home .final h2{font-size:42px}}
@media (max-width:40rem){.topbar .quiet:not(.account){display:none}.topbar nav{gap:1rem}.topbar .wide{display:none}.topbar .narrow{display:inline}.home .cta .button{flex:1 1 100%}.home .actions.pair{grid-template-columns:minmax(0,1fr)}}
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
