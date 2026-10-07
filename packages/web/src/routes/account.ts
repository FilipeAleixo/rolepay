import { KNOWN_TOKENS, TOKEN_SYMBOLS } from '@rolepay/core'
import { Hono } from 'hono'
import type { WebConfig } from '../config.js'
import { accountPage } from '../views/account.js'

export type AccountRoutesDeps = { config: WebConfig; testnet: boolean }

/**
 * /account: the payee's own account page. Read only on the server: the page is the same for
 * everyone, and the passkey signs any transfer in the browser and sends it straight to Tempo, so
 * there is no endpoint that takes an address or an amount.
 */
export function accountRoutes(deps: AccountRoutesDeps): Hono {
  const { config } = deps
  const app = new Hono()
  app.get('/account', (c) =>
    c.html(
      accountPage({
        page: 'account',
        network: config.network,
        testnet: deps.testnet,
        rpcUrl: config.rpcUrl,
        sponsorUrl: config.sponsorUrl,
        explorerUrl: config.explorerUrl,
        tokens: KNOWN_TOKENS[config.network].map((address) => ({ address, label: TOKEN_SYMBOLS[address] ?? address })),
      }),
    ),
  )
  return app
}
