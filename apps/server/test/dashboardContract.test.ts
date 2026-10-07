// The dashboard's policy page contract (`@rolepay/web/contract`) against core's REAL policy services
// through the server's adapters (`policyPortFromCore`, `auditPortFromCore`): the same page tests
// packages/web runs against InMemoryPolicies, so the two cannot drift apart.
import { policyPagesContract } from '@rolepay/web/contract'
import { coreBackend } from './coreBackend.js'

policyPagesContract('core (memory adapters)', coreBackend)
