// GET /api/health — minimal liveness probe.
// Returns 200 with the resolved binding names so you can confirm
// `wrangler.toml` is wired correctly without invoking real endpoints.

import { ok } from '../_shared/response'
import type { Env } from '../_shared/auth'

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return ok({
    status: 'ok',
    bindings: {
      CONTENT_KV: Boolean(env.CONTENT_KV),
      MEDIA_BUCKET: Boolean(env.MEDIA_BUCKET),
    },
    runtime: 'cloudflare-pages-functions',
  })
}
