import type { NextRequest } from "next/server"

const trustedProxyOrigins = new Set([
  "https://clinical-cases-proxy.vercel.app",
  "https://cases.nkolosov.com",
])

const trustedCloudRunHosts = new Set([
  "eximion-frontend-497115726994.europe-west3.run.app",
  "eximion-frontend-aprnyhognq-ey.a.run.app",
])

export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")

  if (!origin || !host) return false

  try {
    const parsed = new URL(origin)

    if (
      parsed.origin !== origin ||
      !["https:", "http:"].includes(parsed.protocol)
    ) {
      return false
    }

    const isLocalhost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)

    // Normal same-origin requests.
    if (parsed.host === host) {
      return parsed.protocol === "https:" || isLocalhost
    }

    // Requests through our trusted Vercel reverse proxy.
    return (
      trustedProxyOrigins.has(parsed.origin) && trustedCloudRunHosts.has(host)
    )
  } catch {
    return false
  }
}
