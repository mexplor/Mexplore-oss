/**
 * A minimal plugin used only by the integration harness.
 *
 * The host provides `@opencode/plugin` at runtime, so this import is resolved by
 * OpenCode, not by Bun's node_modules. Keep the import surface to the root export.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "probe-plugin",
  setup: async (ctx) => {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "probe_echo",
        description: "Echo back the given text.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        options: { codemode: false },
        execute: async (input) => ({
          content: `echo:${String((input as { text?: string } | undefined)?.text ?? "")}`,
        }),
      })
    })
    return async () => {}
  },
})
