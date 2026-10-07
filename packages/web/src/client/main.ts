// The one client bundle (/assets/rolepay.js). The server renders each page and embeds its
// config; this adds the passkey and signing steps for that page.
import { type AccountConfig, startAccount } from './account.js'
import { type ClaimConfig, startClaim } from './claim.js'
import { readConfig } from './dom.js'
import { type PolicyBudgetConfig, startPolicyBudget } from './policyBudget.js'
import { type SetupConfig, startSetup } from './setup.js'

const config = readConfig<ClaimConfig | SetupConfig | AccountConfig | PolicyBudgetConfig>()
if (config.page === 'claim') startClaim(config)
else if (config.page === 'setup') startSetup(config)
else if (config.page === 'account') startAccount(config)
else if (config.page === 'policy-budget') startPolicyBudget(config)
