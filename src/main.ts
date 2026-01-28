#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import packageJson from "../package.json" with { type: "json" }
import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { config } from "./config"
import { debug } from "./debug"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "copilot-api",
    version: packageJson.version,
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: { auth, start, "check-usage": checkUsage, debug, config },
})

await runMain(main)
