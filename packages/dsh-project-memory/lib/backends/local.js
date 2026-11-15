/** Local-file backend: the historical behaviour, unchanged. */
import { ProjectMemoryStore } from '../store.js'

export class LocalFileBackend extends ProjectMemoryStore {
  constructor(options = {}) {
    super(options)
    this.backendName = 'local'
  }

  /** No cloud sync in local mode. */
  syncInfo() {
    return { backend: 'local', configured: false, stale: false }
  }

  /** Kept for the backend interface; local mode has nothing to flush. */
  async flush() {
    return { sent: 0, pending: 0, skipped: true }
  }

  async close() {}
}
