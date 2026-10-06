// Prints a Markdown table of each package's coverage (from vitest's json-summary reporter) for the
// GitHub job summary. Usage: node .github/scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = ['packages/core', 'packages/discord', 'packages/web', 'apps/server']
const METRICS = ['lines', 'statements', 'functions', 'branches']

const rows = PACKAGES.map((dir) => {
  const file = join(dir, 'coverage', 'coverage-summary.json')
  if (!existsSync(file)) return `| ${dir} | ${METRICS.map(() => 'no report').join(' | ')} |`
  const total = JSON.parse(readFileSync(file, 'utf8')).total
  return `| ${dir} | ${METRICS.map((m) => `${total[m].pct}% (${total[m].covered}/${total[m].total})`).join(' | ')} |`
})

console.log(['## Coverage', '', `| Package | ${METRICS.join(' | ')} |`, `| --- | ${METRICS.map(() => '---').join(' | ')} |`, ...rows, ''].join('\n'))
