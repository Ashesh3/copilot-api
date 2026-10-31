import { expect, test } from "bun:test"

import { createBackupStream } from "~/lib/config-backup"
import {
  credentialDigest,
  insertGatewayCredential,
} from "~/lib/storage/credentials-repository"
import { DesktopGatewayAuthRepository } from "~/lib/storage/desktop-gateway-auth-repository"
import { restoreBackup } from "~/lib/storage/restore"

import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const issuer = "https://gateway.example/v1"
const password = "desktop-auth-backup-fixture"

test.each(["gateway", "inference"] as const)(
  "encrypted backup preserves Desktop access, refresh, and pending devices approved by %s",
  async (kind) => {
    await withTransferStorage(async (source) => {
      const now = Date.now() - 10_000
      const issuerKey = "desktop-backup-" + kind + "-key"
      await source.transaction(async (session) => {
        await (kind === "gateway" ?
          insertGatewayCredential(session, {
            id: "desktop-backup-issuer",
            credential: issuerKey,
            label: "Desktop backup issuer",
            createdAt: now,
          })
        : session.execute({
            sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,scopes_json,created_at,updated_at) VALUES (?,'desktop-backup-issuer','test','inference:desktop-backup','[\"user:inference\"]',?,?)",
            args: [credentialDigest(issuerKey), now, now],
          }))
      })
      const original = new DesktopGatewayAuthRepository(source)
      const device = await original.issueDeviceAuthorization({ issuer, now })
      expect(
        await original.approveDeviceAuthorization({
          issuer,
          issuerKey,
          userCode: device.userCode,
          now: now + 1000,
        }),
      ).toEqual({ status: "approved" })
      const issued = await original.exchangeDeviceCode({
        issuer,
        deviceCode: device.deviceCode,
        now: now + 5000,
      })
      if (issued.status !== "ok") throw new Error("Device token fixture failed")
      const pending = await original.issueDeviceAuthorization({
        issuer,
        now: now + 6000,
      })
      const expected = await original.resolveAccessToken(
        issued.tokens.accessToken,
        now + 7000,
      )
      expect(expected).toMatchObject({ scopes: ["user:inference"] })
      const backup = await streamBytes(
        createBackupStream(password, undefined, source),
      )
      const encrypted = Buffer.from(backup).toString("utf8")
      expect(encrypted).not.toContain(issued.tokens.accessToken)
      expect(encrypted).not.toContain(issued.tokens.refreshToken)
      await withTransferStorage(async (target) => {
        expect(
          (await restoreBackup(bytesStream(backup), password, target)).phase,
        ).toBe("complete")
        const restored = new DesktopGatewayAuthRepository(target)
        expect(
          await restored.resolveAccessToken(
            issued.tokens.accessToken,
            now + 7000,
          ),
        ).toEqual(expected)
        expect(
          await restored.refresh({
            issuer,
            refreshToken: issued.tokens.refreshToken,
            now: now + 8000,
          }),
        ).toMatchObject({ status: "ok" })
        expect(
          await restored.resolveAccessToken(
            issued.tokens.accessToken,
            now + 3_605_000,
          ),
        ).toBeNull()
        expect(
          await restored.getDeviceAuthorization({
            issuer,
            userCode: pending.userCode,
            now: now + 7000,
          }),
        ).toMatchObject({ status: "pending" })
        expect(
          await restored.approveDeviceAuthorization({
            issuer,
            issuerKey,
            userCode: pending.userCode,
            now: now + 9000,
          }),
        ).toEqual({ status: "approved" })
        expect(
          await restored.exchangeDeviceCode({
            issuer,
            deviceCode: pending.deviceCode,
            now: now + 11_000,
          }),
        ).toMatchObject({ status: "ok" })
        expect(
          await original.refresh({
            issuer,
            refreshToken: issued.tokens.refreshToken,
            now: now + 9000,
          }),
        ).toMatchObject({ status: "ok" })
      })
    })
  },
)
