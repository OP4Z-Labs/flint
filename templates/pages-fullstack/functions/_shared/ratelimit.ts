// KV-backed sliding-window rate limiter for edge endpoints. Each window gets
// its own bucket key (`<prefix>:<key>:<windowBucket>`) so old buckets fall off
// the namespace automatically once their KV TTL elapses — no cleanup job.
//
// Caller picks the `key` shape (typically `login:<ip>`) and supplies the KV
// namespace. The module is deliberately storage-agnostic about *what* is being
// limited; it just counts hits inside a time window.

const KEY_PREFIX = 'ratelimit'

export interface RateLimitConfig {
  /** Length of the rolling window, in seconds. Also used as the KV TTL. */
  windowSeconds: number
  /** Maximum number of attempts allowed inside a single window. */
  maxAttempts:   number
}

export interface RateLimitResult {
  /** False once the caller has hit `maxAttempts` inside the active window. */
  allowed:         boolean
  /** Attempts still available before the window flips to `allowed=false`. */
  remaining:       number
  /** Seconds until the current window bucket expires (suitable for Retry-After). */
  resetInSeconds:  number
}

function bucketFor(windowSeconds: number, nowMs = Date.now()): number {
  return Math.floor(nowMs / (windowSeconds * 1000))
}

function bucketKey(key: string, bucket: number): string {
  return `${KEY_PREFIX}:${key}:${bucket}`
}

/**
 * Increment the hit counter for `key` inside the active window and report
 * whether the caller is still allowed through. Increment happens unconditionally
 * — even when the call is being denied — so floods don't slip past once the
 * limit is hit.
 *
 * Bucket keys carry a KV `expirationTtl` matching `windowSeconds` so spent
 * buckets disappear without any sweeper job.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const nowMs        = Date.now()
  const bucket       = bucketFor(config.windowSeconds, nowMs)
  const storageKey   = bucketKey(key, bucket)
  const windowEndMs  = (bucket + 1) * config.windowSeconds * 1000
  const resetInSeconds = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000))

  const prior   = await kv.get(storageKey)
  const attempts = prior ? parseInt(prior, 10) || 0 : 0
  const next     = attempts + 1

  await kv.put(storageKey, String(next), { expirationTtl: config.windowSeconds })

  const allowed   = attempts < config.maxAttempts
  const remaining = Math.max(0, config.maxAttempts - next)

  return { allowed, remaining, resetInSeconds }
}

/**
 * Drop the active-window bucket for `key`. Use on successful auth so a one-off
 * fat-finger from a legitimate user doesn't burn down their attempt budget.
 *
 * Only the current bucket is cleared — historical buckets are already expiring
 * on their own TTL, so there is nothing else to chase.
 */
export async function resetRateLimit(
  kv: KVNamespace,
  key: string,
  windowSeconds: number,
): Promise<void> {
  const bucket     = bucketFor(windowSeconds)
  const storageKey = bucketKey(key, bucket)
  await kv.delete(storageKey)
}
