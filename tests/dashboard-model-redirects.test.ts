import { expect, test } from "bun:test"

import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"

test("generated model redirects UI exposes a target verbosity override", () => {
  expect(DASHBOARD_HTML).toContain("Target verbosity")
  expect(DASHBOARD_HTML).toContain("Preserve verbosity")
})
