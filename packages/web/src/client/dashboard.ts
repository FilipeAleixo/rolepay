// The dashboard's script (/assets/live.js): small, no viem, no passkeys. It only makes a
// community's pages update live; every page works without it.
import { startDashboardLive } from './dashboardLive.js'

if (typeof EventSource === 'function' && typeof DOMParser === 'function') {
  startDashboardLive({
    document,
    EventSource,
    fetch: (url, init) => fetch(url, init),
    parse: (html) => new DOMParser().parseFromString(html, 'text/html'),
    href: () => window.location.href,
  })
}
