/**
 * The fields a logged error carries: its message, with every URL replaced, because viem puts the
 * request URL (and an RPC or relay URL can hold an API key) into its error messages (L2).
 */
export function errorFields(error: unknown): { error: string } {
  const message = error instanceof Error ? error.message : String(error)
  return { error: message.replace(/https?:\/\/\S+/g, '<url>') }
}
