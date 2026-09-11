import type { StorageConfig } from "~/lib/storage/config"
import type { Storage } from "~/lib/storage/types"

import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"

export function createStorage(config: StorageConfig): Storage {
  return new LocalSqliteStorage(config.path)
}
