// Small DOM helpers shared by the pages. Browser only.

export function readConfig<T>(): T {
  const el = document.getElementById('rolepay-config')
  if (!el?.textContent) throw new Error('Rolepay: page config missing')
  return JSON.parse(el.textContent) as T
}

export const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)

export function show(selector: string, visible: boolean) {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) el.hidden = !visible
}

export function fill(field: string, text: string) {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-field="${field}"]`)) el.textContent = text
}

export function status(text: string, tone: 'ok' | 'bad' | 'info' = 'info') {
  const el = $('#status')
  if (!el) return
  el.textContent = text
  el.className = tone === 'info' ? '' : tone
}

/** Runs a button's action once at a time, with its buttons disabled meanwhile, and reports failures. */
export function busy(buttons: (HTMLButtonElement | null)[], work: () => Promise<void>, explain: (e: unknown) => string) {
  return async () => {
    const live = buttons.filter((b): b is HTMLButtonElement => b !== null)
    for (const b of live) b.disabled = true
    try {
      await work()
    } catch (error) {
      console.error(error)
      status(explain(error), 'bad')
    } finally {
      for (const b of live) b.disabled = false
    }
  }
}

export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: { code: string } & Record<string, unknown> }

/** Same-origin JSON POST (cookies included). Expected failures come back as results. */
export async function post<T>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await res.json()) as ApiResult<T>
}

export async function get<T>(path: string): Promise<ApiResult<T>> {
  const res = await fetch(path, { credentials: 'same-origin' })
  return (await res.json()) as ApiResult<T>
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

/** 6-decimal micro-units (as a decimal string) to "12.5". */
export function formatMicros(micros: string): string {
  const v = BigInt(micros)
  const whole = v / 1_000_000n
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** A passkey prompt the person closed, or any other failure, in plain English. */
export function explainPasskeyError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (/NotAllowedError|cancel|abort|timed out/i.test(text)) return 'The passkey prompt was closed before it finished. Try again.'
  if (/InvalidStateError|already registered|excludeCredentials/i.test(text)) return 'This device already has a Rolepay passkey. Use "sign in" instead.'
  // The details (which can carry RPC URLs and request bodies) are in the console, not on the page.
  return `Something went wrong${error instanceof Error && error.name !== 'Error' ? ` (${error.name})` : ''}. The details are in the browser console; try again in a moment.`
}
