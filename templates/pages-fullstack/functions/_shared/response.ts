// Response envelope helpers — { ok: true, data } / { ok: false, error }.
// All API endpoints should return through these so the typed client on the
// browser side can rely on the shape.

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

export function ok<T>(data: T, init: ResponseInit = {}): Response {
  return json({ ok: true, data }, init)
}

export function err(message: string, status = 400, details?: unknown): Response {
  return json(
    { ok: false, error: message, ...(details ? { details } : {}) },
    { status },
  )
}

export function unauthorized(): Response {
  return err('Invalid Credentials', 401)
}
