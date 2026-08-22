import { expect, test } from "bun:test"

import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"

test("dashboard confirmation dialogs wrap long identifiers without overflow", () => {
  expect(DASHBOARD_HTML).toContain("confirm-dialog")
  expect(DASHBOARD_HTML).toContain("min(400px, calc(100vw - 32px))")
  expect(DASHBOARD_HTML).toContain("direction:ltr")
  expect(DASHBOARD_HTML).toContain("text-align:left")
  expect(DASHBOARD_HTML).toContain("overflow-wrap:anywhere")
  expect(DASHBOARD_HTML).toContain("white-space:normal")
})
