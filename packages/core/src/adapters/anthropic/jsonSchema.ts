import { z } from 'zod'

/** What structured outputs accept; everything else (lengths, numeric bounds, $schema) is dropped and checked by Zod after. */
const KEEP = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description'])

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean)
  if (node === null || typeof node !== 'object') return node
  const o = node as Record<string, unknown>
  // ["string", "null"] becomes anyOf, the form the structured outputs docs list.
  if (Array.isArray(o.type)) {
    const { type, ...rest } = o
    return clean({ anyOf: (type as string[]).map((t) => ({ ...rest, type: t })) })
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (!KEEP.has(k)) continue
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, clean(s)])) : clean(v)
  }
  return out
}

/**
 * The JSON schema the model must answer in, derived from the domain's Zod schema (the single
 * source of truth). Every object closes with additionalProperties false and requires all its
 * keys; constraints structured outputs do not support are left to the Zod check after.
 */
export function outputSchema(schema: z.ZodType): Record<string, unknown> {
  return clean(z.toJSONSchema(schema, { target: 'draft-2020-12' })) as Record<string, unknown>
}
