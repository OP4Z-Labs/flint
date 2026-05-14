import { z } from 'zod'
import type { Env } from './auth'

// ─────────────────────────────────────────────────────────────────────────────
// KVCollection — a small typed wrapper over a KVNamespace with Zod validation
// on every read and write. Each document lives at `<prefix>:<id>`; a manifest
// at `<prefix>:__index` keeps an ordered list of ids for O(1) listing without
// paying for KV list pagination on hot paths.
//
// Lifted from the Blaze reference app. The generic class is the reusable
// surface — add app-specific collection factories at the bottom.
// ─────────────────────────────────────────────────────────────────────────────

export class KVCollection<S extends z.ZodTypeAny> {
  constructor(
    private kv: KVNamespace,
    private prefix: string,
    private schema: S,
  ) {}

  private docKey(id: string) { return `${this.prefix}:${id}` }
  private indexKey()         { return `${this.prefix}:__index` }

  async get(id: string): Promise<z.infer<S> | null> {
    const raw = await this.kv.get(this.docKey(id), 'json')
    if (raw === null) return null
    return this.schema.parse(raw) as z.infer<S>
  }

  async put(id: string, value: z.infer<S>): Promise<void> {
    const parsed = this.schema.parse(value)
    await this.kv.put(this.docKey(id), JSON.stringify(parsed))
    await this.ensureIndexed(id)
  }

  async patch(id: string, partial: Partial<z.infer<S>>): Promise<z.infer<S>> {
    const current = await this.get(id)
    if (!current) throw new Error(`Not found: ${this.docKey(id)}`)
    const merged = { ...current, ...partial }
    const parsed = this.schema.parse(merged)
    await this.kv.put(this.docKey(id), JSON.stringify(parsed))
    return parsed as z.infer<S>
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(this.docKey(id))
    const ids = await this.listIds()
    const next = ids.filter(x => x !== id)
    await this.kv.put(this.indexKey(), JSON.stringify(next))
  }

  async listIds(): Promise<string[]> {
    const raw = await this.kv.get(this.indexKey(), 'json')
    if (!raw) return []
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === 'string')
  }

  async listAll(): Promise<Array<z.infer<S>>> {
    const ids = await this.listIds()
    const docs = await Promise.all(ids.map(id => this.get(id)))
    return docs.filter(d => d !== null) as Array<z.infer<S>>
  }

  /** Append the id to the manifest if absent. Idempotent. */
  private async ensureIndexed(id: string): Promise<void> {
    const ids = await this.listIds()
    if (ids.includes(id)) return
    ids.push(id)
    await this.kv.put(this.indexKey(), JSON.stringify(ids))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R2Media — typed wrapper for the media bucket. Uploads are proxied through
// the Worker (no presigned URLs in v1); the admin sends multipart and the
// Worker writes the file under a key convention you define in your endpoint.
// ─────────────────────────────────────────────────────────────────────────────

export class R2Media {
  constructor(private bucket: R2Bucket) {}

  async upload(key: string, file: File): Promise<string> {
    const body = await file.arrayBuffer()
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    })
    return key
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key)
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key)
  }
}

// Example wiring — replace with your own app's collections.
export function mediaStore(env: Env) {
  return new R2Media(env.MEDIA_BUCKET)
}

// `Env` is re-exported only to keep imports symmetric in api endpoints.
export type { Env }
