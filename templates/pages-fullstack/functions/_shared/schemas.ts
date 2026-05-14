// Zod schemas — the single source of truth for content shape. Add your
// app's domain schemas here and import them from `storage.ts` to attach
// to KV collections. Login is the only schema Flint ships with — every
// generated app needs it for the HMAC admin flow.

import { z } from 'zod'

export const LoginRequestSchema = z.object({
  password: z.string().min(1),
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>
