// @rolepay/web/contract: the dashboard's policy page contract, for any policy backend to run
// (apps/server runs it against core's real services). Test code only.
export { GUILD, MEMBER, OUTSIDER, type HarnessBase, type PolicyBackendSetup, ROLE, TREASURER, TREASURY, TestBrowser, identity, usd } from '../dashboardHarness.js'
export { ALICE, BOB, CAROL, DAN, MONDAY, MONDAY_RULE, type PolicyBackend, type PolicyBackendFactory, policyPagesContract } from './policyPages.js'
