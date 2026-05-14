import { z } from 'zod'
import type { Env } from './auth'

// ─────────────────────────────────────────────────────────────────────────────
// KVCollection — a small typed wrapper over a KVNamespace with Zod validation
// on every read and write. Each document lives at `<prefix>:<id>`; a manifest
// at `<prefix>:__index` keeps an ordered list of ids for O(1) listing without
// paying for KV list pagination on hot paths.
//
// Lifted from the Blaze/Chorus reference apps. The generic class is the
// reusable surface — add app-specific collection factories at the bottom.
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

// Example wiring — replace with your own app's collections.
// import { MyDocSchema } from './schemas'
// export function myCollection(env: Env) {
//   return new KVCollection(env.CONTENT_KV, 'my-doc', MyDocSchema)
// }

// `Env` is re-exported only to keep imports symmetric in api endpoints.
export type { Env }
