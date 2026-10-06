/** JSON for the browser: bigints (money in micro-units) travel as decimal strings. */
export const toJson = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

export const jsonResponse = (status: number, body: unknown) =>
  new Response(toJson(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Expected failures, in the same shape as core's results. */
export const failure = (status: number, error: { code: string } & Record<string, unknown>) => jsonResponse(status, { ok: false, error })

/** Link errors map to HTTP: unknown is 404, used or expired is 410. */
export const linkStatus = (code: string) => (code === 'link_not_found' ? 404 : code === 'link_expired' || code === 'link_already_used' ? 410 : 400)
