/**
 * The mexplore TUI part (REQ-021): `/mexplore <args>` answers INSTANTLY, in a
 * dialog, with no model call.
 *
 * **Why this part exists.** The server command replies through
 * `ctx.session.synthetic({ resume: false })`. That message is admitted to the
 * session, but the TUI renders pending inbox items only when they are of type
 * `user` (`packages/tui/src/routes/session/index.tsx:221-226`), so a synthetic
 * reply stays invisible until the user's NEXT prompt. The TUI cannot fix that
 * from the outside — so it answers the same question itself, from the same code.
 *
 * **Two names, one implementation.** The TUI's slash command is `/mexplore`; the
 * SERVER command is `/mexplore-settings`, which desktop and web use. The split
 * means the TUI can keep the short name users expect without that name also
 * existing as a deferred-reply server command in the same client.
 *
 * The TUI's keymap also gets FIRST REFUSAL over a same-named server command:
 * `argumentSlash(inputText, keymapCommands())` runs BEFORE the server-command
 * branch in `component/prompt/index.tsx` (line 1141 vs. lines 1155-1159) and is
 * dispatched at line 1152, so even a user who has the server command under the
 * same name would get the dialog. Both routes call `runCommandText`, so the
 * reply text is identical.
 *
 * **What lives here.** Almost nothing on purpose: parse the arguments, call the
 * server's RPC, show the text. Every decision — storage, provider reloads,
 * whether a key exists, model validation — is the server's, reached through
 * `MexploreRpc`, so this file cannot disagree with `/mexplore` elsewhere. It never
 * touches the key: `/mexplore key` only explains `/connect`, exactly as on the
 * server. Help text is rendered with the TUI's own label (`/mexplore`), so it
 * never points a TUI user at a command that only desktop and web have.
 *
 * @module mexplore/tui
 */
import { Plugin } from '@opencode/plugin/tui'
import { MexploreRpc, unavailableText } from './rpc'

/** The plugin id the server part uses; both surfaces report one name. */
export const TUI_PLUGIN_ID = 'mexplore.tui'

/** The slash name. Deliberately the same as the server command: see the header. */
export const SLASH_NAME = 'mexplore'

/** The dialog title every reply is shown under. */
export const DIALOG_TITLE = 'mexplore'

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    // The welcome dialog is armed here but opened LATER: a dialog shown inside
    // `setup` races the TUI's own first paint and can be swallowed. It opens on
    // the first session or route event instead, which is the first moment a user
    // is actually in the UI (Lane B, item 7).
    scheduleWelcome(context)
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: `${TUI_PLUGIN_ID}.command`,
          title: 'mexplore memory settings',
          group: 'mexplore',
          // Keep the whole line in the prompt and hand its raw text to `run`,
          // which is what lets `/mexplore model x` reach the server intact.
          slash: { name: SLASH_NAME, arguments: true },
          run: async (input) => {
            await showReply(context, input ?? '')
          },
        },
      ],
    }))
  },
})

/** The typed view of the one RPC method this part uses. */
export interface CommandClient {
  command: (input: { args: string; sessionID?: string }) => Promise<{ text: string }>
}

/** The slice of the TUI context this part needs (so a test needs no renderer). */
export interface ReplyContext {
  readonly client: { rpc: (definition: typeof MexploreRpc) => unknown }
  readonly ui?: {
    readonly router?: {
      /** The route on screen: a session, home, or a plugin page. */
      current?: () => { readonly type: string; readonly sessionID?: string }
    }
  }
  readonly data?: { readonly session?: { list?: () => ReadonlyArray<{ id: string; time?: { updated?: number } }> } }
}

/**
 * Narrow the host's RPC client to this one method.
 *
 * `client.rpc(definition)` is typed from the JSON Schema, and a JSON Schema value
 * is `unknown` in TypeScript (the docs say so: "narrow them before use"). This is
 * that narrowing, in ONE place, against the contract in `rpc.ts` — which is also
 * the schema the server validates the reply against, so a drift fails loudly on
 * the wire rather than silently here.
 */
function commandClient(context: ReplyContext): CommandClient {
  return context.client.rpc(MexploreRpc) as CommandClient
}

/** The text `/mexplore <args>` should show, or an actionable failure message. */
export async function replyText(
  context: ReplyContext & { readonly ui?: unknown },
  args: string,
): Promise<string> {
  try {
    // The session is optional and used only for the status line's parent model:
    // on the home screen there is none, and a settings change must still work.
    const sessionID = currentSessionID(context)
    const result = await commandClient(context).command({
      args,
      ...(sessionID === undefined ? {} : { sessionID }),
    })
    return result.text
  } catch (error) {
    // Never surface a raw RPC failure as the whole answer: name what happened so
    // the user can retry instead of seeing a blank or a stack trace.
    return unavailableText(error)
  }
}

/**
 * Call the server's `command` RPC and show the reply in a dialog.
 *
 * The dialog is `ui.dialog.alert` — the documented promise-based alert; it takes
 * a title and a message, needs no renderer, and dismisses on its own key.
 */
export async function showReply(
  context: ReplyContext & {
    readonly ui: { dialog: { alert: (options: { title: string; message: string }) => Promise<void> } }
  },
  args: string,
): Promise<void> {
  const message = await replyText(context, args)
  await context.ui.dialog.alert({ title: DIALOG_TITLE, message })
}

/**
 * Does this reply carry a URL the TUI could open?
 *
 * The TUI's own `openUrl` helper lives in `@opencode/util/open`, which is NOT
 * host-provided for plugins (`plugin/src/runtime.ts` only provides `effect/*`
 * and `@opencode/plugin/*`), so importing it would break the module graph on a
 * real install. The dialog therefore SHOWS the URL and says to open it; a future
 * host API can turn this into a real open with no other change.
 */
export function browsableUrl(text: string): string | undefined {
  return /http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/.exec(text)?.[0]
}

/**
 * The session the user is LOOKING AT, not merely the most recently touched one.
 *
 * `ui.router.current()` is the documented source for that
 * (`packages/plugin/src/tui/context.ts:496-500`): with several tabs or a
 * background session running, "most recently updated" reports the wrong
 * session's model in `/mexplore status`, and can make `/mexplore test` exercise
 * a model the current session is not on.
 *
 * Falls back to the most recently updated session only when the route is not a
 * session (home, a plugin page), and returns `undefined` rather than guessing
 * when there is nothing: the RPC then runs without a session, which only affects
 * one status line.
 */
function currentSessionID(context: ReplyContext): string | undefined {
  const route = context.ui?.router?.current?.()
  if (route?.type === 'session' && typeof route.sessionID === 'string') return route.sessionID
  const sessions = context.data?.session?.list?.()
  if (sessions === undefined || sessions.length === 0) return undefined
  return [...sessions].sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0))[0]?.id
}

/** The storage key that remembers the welcome dialog was seen (versioned). */
export const WELCOME_KEY = 'welcome'

/** The welcome text (Lane B, item 7): shared with `/mexplore help`. */
export const WELCOME_TEXT = [
  'mexplore gives this OpenCode long-term memory.',
  '',
  'It works on its own: the agent recalls before decisions and saves durable decisions,',
  'preferences and corrections. Every save is announced as "saved to memory: …" in the reply.',
  '',
  'Next steps:',
  '  1. Start a conversation: memory inherits your current model without a separate key.',
  '  2. Check it: /mexplore test',
  '  3. Optional dashboard: /mexplore ui',
  '',
  'Memory and the token-usage log stay on this machine. `/mexplore help` shows this again.',
].join('\n')

/** The two actions the welcome dialog offers. */
export const WELCOME_ACTIONS = [
  { title: 'Use my current model (default)', value: 'current' },
  { title: 'Optional custom endpoint key', value: 'connect' },
] as const

/**
 * The welcome text with RESOLVED locations (Lane B review #9).
 *
 * The static `WELCOME_TEXT` cannot name where memory and the log actually live on
 * this machine, or how to turn logging off — and those are exactly the facts the
 * user needs on the first run. The values come from the server over the same RPC
 * the `/mexplore` dialog uses, so the UI never guesses a path.
 */
export async function welcomeText(context: {
  readonly client?: { rpc?: (definition: typeof MexploreRpc) => unknown }
}): Promise<string> {
  const base = WELCOME_TEXT
  const rpc = context.client?.rpc
  if (rpc === undefined) return base
  try {
    const result = (await (rpc(MexploreRpc) as CommandClient).command({ args: 'status' })) as { text?: string }
    const text = typeof result?.text === 'string' ? result.text : ''
    const graph = /^graph: (\S+) \(source: /m.exec(text)?.[1]
    const usage = /^usage log: (.+)$/m.exec(text)?.[1]
    if (graph === undefined && usage === undefined) return base
    return [
      base,
      '',
      'On this machine:',
      ...(graph === undefined ? [] : [`  memory graph: ${graph}`]),
      ...(usage === undefined ? [] : [`  token usage log: ${usage}`]),
      '  turn the usage log off with the plugin option usageLog: false',
    ].join('\n')
  } catch {
    // No server answer: the static text is still a correct welcome.
    return base
  }
}

/** The slice of the TUI context the welcome needs. */
export interface WelcomeContext {
  readonly data?: {
    /**
     * The host's typed event subscription. Loosely typed here (the event NAME is
     * a large union in the host) so a test can pass a plain stub.
     */
    readonly on?: (type: never, handler: () => void) => () => void
    readonly session?: { list?: () => ReadonlyArray<{ id: string }> }
  }
  /**
   * The durable store. One concrete shape rather than a generic: the welcome only
   * ever keeps `{ seen }`, and a concrete signature is what a test stub can
   * satisfy without mirroring the host's generic.
   */
  readonly storage?: {
    store?: (
      key: string,
      options: { initial: { seen: number } },
    ) => readonly [
      { readonly seen?: number },
      (mutation: (draft: { seen?: number }) => void) => Promise<void>,
    ]
  }
  /** The RPC client, so the welcome can name the real locations. */
  readonly client?: { rpc?: (definition: typeof MexploreRpc) => unknown }
  readonly ui?: {
    readonly dialog?: {
      select?: (options: {
        title: string
        options: ReadonlyArray<{ title: string; value: string }>
        placeholder?: string
      }) => Promise<string | undefined>
      alert?: (options: { title: string; message: string }) => Promise<void>
    }
    readonly toast?: { show: (options: { message: string; variant?: 'success' | 'warning' | 'error' }) => void }
  }
}

/** Bumped when the welcome copy changes materially: a new version shows once. */
export const WELCOME_VERSION = 1

/**
 * Open the welcome dialog once, on the first session or route activity.
 *
 * The "seen" flag is durable (`storage.store`), so it survives a restart and a
 * plugin reload; the version lets a future copy re-introduce itself once rather
 * than never. The listeners detach as soon as either fires.
 */
export function scheduleWelcome(context: WelcomeContext): void {
  const storage = context.storage?.store?.(WELCOME_KEY, { initial: { seen: 0 } })
  if (storage === undefined) return
  const [state, update] = storage
  if ((state.seen ?? 0) >= WELCOME_VERSION) return

  let opened = false
  const detachers: Array<() => void> = []
  const detach = (): void => {
    for (const stop of detachers.splice(0)) {
      try {
        stop()
      } catch {
        // A listener that is already gone is not an error.
      }
    }
  }

  const open = async (): Promise<void> => {
    if (opened) return
    opened = true
    detach()
    const dialog = context.ui?.dialog
    if (dialog?.select === undefined) {
      // No dialog API at all: nothing was shown, so the welcome must NOT be
      // marked seen — re-arm for the next session event (review #2-6).
      opened = false
      rearm()
      return
    }

    // The CONTENT comes first, then the actions (Lane B review #9). The reviewer's
    // point was that picking "use my current model" used to close the dialog
    // having shown the user nothing: the only text appeared on cancellation.
    // So: show the full welcome (with the resolved locations) as an alert, and
    // only then ask what to do.
    const message = await welcomeText(context)
    let displayed = false
    if (dialog.alert !== undefined) {
      displayed = await dialog
        .alert({ title: 'Welcome to mexplore', message })
        .then(() => true)
        .catch(() => false)
    }
    if (!displayed) {
      // The alert failed (or there is no alert API): mark nothing, and let the
      // next session event try again (review #2-6). A welcome nobody saw, marked
      // seen, is a welcome nobody will ever see.
      opened = false
      rearm()
      return
    }
    // Seen only once the content has actually been DISPLAYED.
    await update((draft) => {
      draft.seen = WELCOME_VERSION
    }).catch(() => undefined)

    const choice = await dialog
      .select({ title: 'Welcome to mexplore', placeholder: 'Choose', options: [...WELCOME_ACTIONS] })
      .catch(() => undefined)
    if (choice === 'connect' && dialog.alert !== undefined) {
      await dialog
        .alert({
          title: 'Connect mexplore',
          message:
            'No separate key is needed when memory inherits your chat model. For a custom memory endpoint, first configure `/mexplore base-url <url>` and `/mexplore model <model-id>`, then run `/connect` → mexplore with that endpoint\'s key. Run `/mexplore test` to check it.',
        })
        .catch(() => undefined)
    }
  }

  const subscribe = context.data?.on as
    | ((type: string, handler: () => void) => () => void)
    | undefined
  /**
   * Re-attach the triggers after a display that did not happen (review #2-6).
   * A fresh listener rather than a kept one: the host's subscription may itself
   * have been dropped, and re-arming is cheap and idempotent.
   */
  const rearm = (): void => {
    for (const type of ['session.created', 'session.viewed']) {
      const stop = subscribe?.(type, () => void open())
      if (stop !== undefined) detachers.push(stop)
    }
  }
  for (const type of ['session.created', 'session.viewed']) {
    const stop = subscribe?.(type, () => void open())
    if (stop !== undefined) detachers.push(stop)
  }
  // No event API at all (an older TUI): fall back to opening immediately rather
  // than never showing the welcome.
  if (detachers.length === 0) void open()
}
