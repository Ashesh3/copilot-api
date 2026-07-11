import { defineCommand } from "citty"
import consola from "consola"

import { resetAdminAuth } from "~/lib/admin-auth"

export const admin = defineCommand({
  meta: {
    name: "admin",
    description: "Manage local administrator authentication",
  },
  args: {
    reset: {
      type: "boolean",
      description:
        "Reset the admin password and revoke every dashboard session",
    },
  },
  async run({ args }) {
    if (!args.reset) {
      consola.info("Use --reset to reset administrator authentication.")
      return
    }
    const confirmed = await consola.prompt(
      "Reset the admin password and revoke all dashboard sessions?",
      { type: "confirm", initial: false },
    )
    if (!confirmed) {
      consola.info("Cancelled.")
      return
    }
    await resetAdminAuth()
    consola.success(
      "Administrator authentication reset. Use the dashboard to set it up again.",
    )
  },
})
