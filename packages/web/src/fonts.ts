import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { FONTS, FONT_LICENSES } from './views/theme.js'

export type FontFile = { body: Uint8Array<ArrayBuffer>; type: string }

/**
 * The font files the pages use (Lora and Montserrat, Latin, from the @fontsource packages) and
 * their licence texts (SIL Open Font License 1.1), served from this origin under /assets/fonts/.
 *
 * Found through node's module resolution from this file. In production that is the server's
 * bundle (apps/server/dist/main.js), which resolves npm packages from apps/server/node_modules,
 * so apps/server depends on the font packages too (apps/server/test/runtimeDependencies.test.ts).
 */
const resolve = createRequire(import.meta.url).resolve

const FILES = new Map<string, { module: string; type: string }>([
  ...FONTS.map((f) => [f.file, { module: f.module, type: 'font/woff2' }] as const),
  ...FONT_LICENSES.map((l) => [l.file, { module: l.module, type: 'text/plain; charset=utf-8' }] as const),
])

const cache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()

/** A font or licence file by its published name, read once; null for any other name. */
export async function fontFile(name: string): Promise<FontFile | null> {
  const file = FILES.get(name)
  if (!file) return null
  let body = cache.get(name)
  if (!body) {
    body = readFile(resolve(file.module))
    cache.set(name, body)
    body.catch(() => cache.delete(name)) // a failed read is retried on the next request
  }
  return { body: await body, type: file.type }
}
