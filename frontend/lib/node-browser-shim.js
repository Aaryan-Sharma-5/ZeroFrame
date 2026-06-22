// Browser shim for Node.js built-ins imported by @0glabs/0g-ts-sdk's browser bundle.
// Stubs are safe because those code paths never execute in the browser —
// the SDK's actual network I/O goes through fetch, not fs/path/crypto.

import { sha256 } from '@noble/hashes/sha256'

export default {}

// ─── node:fs / fs ────────────────────────────────────────────────────────────
export const open = undefined
export const readFile = undefined
export const writeFile = undefined
export const existsSync = undefined
export const mkdirSync = undefined

// ─── node:path / path ────────────────────────────────────────────────────────
export const join = undefined
export const resolve = undefined
export const dirname = undefined
export const basename = undefined
export const extname = undefined

// ─── node:crypto ─────────────────────────────────────────────────────────────
// The SDK calls createHash('sha256') at module-init time to compute STREAM_DOMAIN.
// We satisfy it with @noble/hashes/sha256 which is pure JS and always available.
export function createHash(_algorithm) {
  const chunks = []
  return {
    update(data) {
      if (typeof data === 'string') {
        chunks.push(new TextEncoder().encode(data))
      } else if (data instanceof Uint8Array) {
        chunks.push(data)
      } else {
        chunks.push(new Uint8Array(data))
      }
      return this
    },
    digest(encoding) {
      let total = 0
      for (const c of chunks) total += c.length
      const combined = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { combined.set(c, off); off += c.length }
      const hash = sha256(combined)
      if (encoding === 'hex') {
        return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('')
      }
      return hash
    },
  }
}

export const randomBytes = undefined
export const createHmac = undefined
