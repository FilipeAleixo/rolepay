/**
 * What passkeys are called. The name is what a person sees in their device's passkey list, and the
 * Accounts SDK uses it too: asked to create a passkey under a name this browser already remembers,
 * it signs in with that account instead of making a new one. So a name must belong to exactly one
 * person. A payee's passkey names the community and the person (their Discord username, or their
 * Discord ID when no username was kept), so a second payee claiming in the same browser gets their
 * own passkey, never the first person's account. The treasury's ("Rolepay treasury: <community>")
 * is one per community, and signing back in to it is what its treasurer wants.
 */

/** WebAuthn lets an authenticator cut a user name at 64 bytes; staying inside keeps the name whole everywhere. */
export const MAX_PASSKEY_NAME_BYTES = 64

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length

/**
 * "Rolepay: <community> (<who>)". `who` is a Discord username (2 to 32 of a-z, 0-9, _ and .) or a
 * Discord ID, so it holds no brackets or spaces and two names never read alike. A long community
 * name is shortened, on whole characters, with "…"; the person is never shortened.
 */
export function payeePasskeyName(communityName: string, who: string): string {
  const full = `Rolepay: ${communityName} (${who})`
  if (byteLength(full) <= MAX_PASSKEY_NAME_BYTES) return full
  const chars = Array.from(communityName)
  while (chars.length > 0 && byteLength(`Rolepay: ${chars.join('').trimEnd()}… (${who})`) > MAX_PASSKEY_NAME_BYTES) chars.pop()
  return `Rolepay: ${chars.join('').trimEnd()}… (${who})`
}
