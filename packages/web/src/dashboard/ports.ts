import type { Result } from '@rolepay/core'

/**
 * Ports the dashboard needs from outside. Each has a real implementation (`discordOAuth.ts` here,
 * the member view over the bot's Discord REST client in apps/server) and a fake in
 * `@rolepay/web/testing`. The policy and audit ports are in `policyPort.ts`.
 */

/** Who signed in with Discord, and the servers they are in (a snapshot at sign-in). */
export type DiscordIdentity = {
  user: { id: string; name: string }
  guilds: { id: string; name: string }[]
}

export type OAuthError = { code: 'oauth_failed'; status?: number }

/**
 * Discord's OAuth2 authorization code flow with PKCE, scopes `identify guilds`. `signIn` exchanges
 * the code and reads the user and their guilds in one step, so the access token never leaves the
 * adapter (Rolepay keeps no Discord token: the server's own session is the only credential).
 */
export interface DiscordOAuth {
  /** Discord's consent screen for this sign-in: state and the S256 PKCE challenge included. */
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string
  signIn(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<Result<DiscordIdentity, OAuthError>>
}

/** A guild member as the bot sees them: roles and display name. Never what the browser says. */
export type GuildMember = { roles: string[]; name: string | null }

/** The bot's view of guild members (Discord REST as the bot). null = not a member (or left). */
export interface GuildMembers {
  member(guildId: string, userId: string): Promise<GuildMember | null>
}
