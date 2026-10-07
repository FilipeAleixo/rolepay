/**
 * The slice of Discord's wire format Rolepay uses: numeric enums and message payload
 * shapes. Kept small and explicit instead of pulling in a full Discord library.
 */

export const InteractionType = { Ping: 1, ApplicationCommand: 2, MessageComponent: 3, Autocomplete: 4, ModalSubmit: 5 } as const

export const ResponseType = {
  Pong: 1,
  ChannelMessage: 4,
  DeferredChannelMessage: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  AutocompleteResult: 8,
  Modal: 9,
} as const

/** Slash commands (chat input) and the right-click commands on a message. */
export const CommandType = { ChatInput: 1, User: 2, Message: 3 } as const

export const MessageFlags = { Ephemeral: 1 << 6 } as const

export const OptionType = { SubCommand: 1, SubCommandGroup: 2, String: 3, Integer: 4, Boolean: 5, User: 6, Channel: 7, Role: 8 } as const

export const ComponentType = { ActionRow: 1, Button: 2, TextInput: 4, TextDisplay: 10, Label: 18 } as const
export const TextInputStyle = { Short: 1, Paragraph: 2 } as const

/** Channel types Rolepay reads from (text, announcement, threads) or lists (forum). */
export const ChannelType = { Text: 0, Voice: 2, Category: 4, Announcement: 5, AnnouncementThread: 10, PublicThread: 11, PrivateThread: 12, Forum: 15, Media: 16 } as const
export const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 } as const

/** Permission bits Rolepay checks (from the interaction's member.permissions bitfield). */
export const Permission = { Administrator: 1n << 3n, ManageGuild: 1n << 5n, ViewChannel: 1n << 10n, ReadMessageHistory: 1n << 16n } as const

export type Embed = {
  title?: string
  description?: string
  url?: string
  color?: number
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string }
  timestamp?: string
}

export type Button =
  | { type: typeof ComponentType.Button; style: 1 | 2 | 3 | 4; label: string; custom_id: string; disabled?: boolean }
  | { type: typeof ComponentType.Button; style: typeof ButtonStyle.Link; label: string; url: string }

export type ActionRow = { type: typeof ComponentType.ActionRow; components: Button[] }

export type TextInput = {
  type: typeof ComponentType.TextInput
  custom_id: string
  label: string
  style: 1 | 2
  min_length?: number
  max_length?: number
  required?: boolean
  value?: string
  placeholder?: string
}

/** Markdown text shown in a modal above its inputs (Discord's Text Display component). */
export type TextDisplay = { type: typeof ComponentType.TextDisplay; content: string }

/** A modal (a form Discord shows): the response to a command or a button, never to a modal. */
export type Modal = { custom_id: string; title: string; components: ({ type: typeof ComponentType.ActionRow; components: [TextInput] } | TextDisplay)[] }

/** A file sent alongside a message (an attachment). */
export type FileUpload = { name: string; contentType: string; data: string }

/** A message as Rolepay builds it: what goes into a reply, an edit, a follow-up or a DM. */
export type Message = {
  content?: string
  embeds?: Embed[]
  components?: ActionRow[]
  flags?: number
  allowed_mentions?: { parse: ('users' | 'roles' | 'everyone')[]; users?: string[] }
  files?: FileUpload[]
}

/** Splits a message into its JSON part and its files (which travel as multipart parts). */
export function splitFiles(message: Message): { json: Omit<Message, 'files'>; files: FileUpload[] } {
  const { files = [], ...json } = message
  return { json, files }
}

/** The `attachments` metadata Discord matches against the `files[n]` parts. */
export const attachmentMeta = (files: FileUpload[]) => files.map((f, i) => ({ id: i, filename: f.name }))

/** multipart/form-data for a JSON body that carries files (`payload_json` + `files[n]`). */
export function multipartBody(json: unknown, files: FileUpload[]): FormData {
  const form = new FormData()
  form.append('payload_json', JSON.stringify(json))
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.contentType }), f.name))
  return form
}
