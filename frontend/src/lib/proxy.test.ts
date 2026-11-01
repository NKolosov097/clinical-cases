// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { sameOrigin } from "./same-origin"
import { POST, PUT } from "@/app/api/backend/[...path]/route"

const CLOUD_RUN_HOST = "eximion-frontend-497115726994.europe-west3.run.app"

const CLOUD_RUN_ALIAS = "eximion-frontend-aprnyhognq-ey.a.run.app"

const VERCEL_ORIGIN = "https://clinical-cases-proxy.vercel.app"

const CUSTOM_ORIGIN = "https://cases.nkolosov.com"

const CASE_ID = "93cb8ced-8e78-42fc-a333-e4dfbb3345a5"

function makeRequest(
  origin: string | undefined,
  host = CLOUD_RUN_HOST,
  method: "GET" | "POST" | "PUT" = "GET",
  path = "/api/backend/auth/login",
) {
  const headers = new Headers({ host })

  if (origin !== undefined) {
    headers.set("origin", origin)
  }

  return new NextRequest(`http://0.0.0.0:8080${path}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: "{}" }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("same-origin session proxy", () => {
  describe("standard same-origin requests", () => {
    it("accepts HTTPS when Origin matches Host", () => {
      expect(
        sameOrigin(makeRequest("https://frontend.run.app", "frontend.run.app")),
      ).toBe(true)
    })

    it("accepts local HTTP development requests", () => {
      expect(
        sameOrigin(makeRequest("http://127.0.0.1:3000", "127.0.0.1:3000")),
      ).toBe(true)

      expect(
        sameOrigin(makeRequest("http://localhost:3000", "localhost:3000")),
      ).toBe(true)
    })

    it("rejects HTTP on public hosts", () => {
      expect(
        sameOrigin(makeRequest("http://frontend.run.app", "frontend.run.app")),
      ).toBe(false)
    })
  })

  describe("trusted Vercel reverse proxy", () => {
    it.each([
      [VERCEL_ORIGIN, CLOUD_RUN_HOST],
      [CUSTOM_ORIGIN, CLOUD_RUN_HOST],
      [VERCEL_ORIGIN, CLOUD_RUN_ALIAS],
      [CUSTOM_ORIGIN, CLOUD_RUN_ALIAS],
    ])("accepts Origin %s behind Host %s", (origin, host) => {
      expect(sameOrigin(makeRequest(origin, host))).toBe(true)
    })

    it.each([
      ["https://evil.test", CLOUD_RUN_HOST],
      ["http://cases.nkolosov.com", CLOUD_RUN_HOST],
      ["https://cases.nkolosov.com.evil.test", CLOUD_RUN_HOST],
      ["https://clinical-cases-proxy.vercel.app.evil.test", CLOUD_RUN_HOST],
      ["https://cases.nkolosov.com/", CLOUD_RUN_HOST],
      ["https://cases.nkolosov.com/path", CLOUD_RUN_HOST],
      ["null", CLOUD_RUN_HOST],
      ["", CLOUD_RUN_HOST],
      [undefined, CLOUD_RUN_HOST],
      [CUSTOM_ORIGIN, "unknown.run.app"],
      [VERCEL_ORIGIN, "malicious.example"],
    ])("rejects untrusted Origin %s with Host %s", (origin, host) => {
      expect(sameOrigin(makeRequest(origin, host))).toBe(false)
    })

    it("does not trust a forged X-Forwarded-Host", () => {
      const request = makeRequest("https://evil.test", CLOUD_RUN_HOST)

      request.headers.set("x-forwarded-host", "evil.test")

      expect(sameOrigin(request)).toBe(false)
    })

    it("does not trust an arbitrary Host with a trusted Origin", () => {
      expect(sameOrigin(makeRequest(CUSTOM_ORIGIN, "attacker.example"))).toBe(
        false,
      )
    })
  })

  describe("API mutation protection", () => {
    it("rejects forged POST requests before calling backend", async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      const response = await POST(
        makeRequest("https://evil.test", CLOUD_RUN_HOST, "POST"),
        { params: Promise.resolve({ path: ["auth", "login"] }) },
      )

      expect(response.status).toBe(403)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("rejects POST requests without Origin", async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      const response = await POST(
        makeRequest(undefined, CLOUD_RUN_HOST, "POST"),
        { params: Promise.resolve({ path: ["auth", "login"] }) },
      )

      expect(response.status).toBe(403)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([VERCEL_ORIGIN, CUSTOM_ORIGIN])(
      "allows login through trusted proxy %s",
      async (origin) => {
        const fetchMock = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              user: { id: "user-id", username: "alice" },
              session_token: "private-token",
            }),
          ),
        )

        vi.stubGlobal("fetch", fetchMock)

        const response = await POST(
          makeRequest(origin, CLOUD_RUN_HOST, "POST"),
          { params: Promise.resolve({ path: ["auth", "login"] }) },
        )

        expect(response.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledOnce()

        expect(await response.json()).toEqual({
          id: "user-id",
          username: "alice",
        })

        const cookie = response.headers.get("set-cookie")

        expect(cookie).toContain("clinical_session=")
        expect(cookie).toContain("HttpOnly")
        expect(cookie).toContain("SameSite=lax")
        expect(cookie).not.toContain("Domain=")
        expect(cookie).toContain("clinical_session=private-token")
      },
    )

    it("allows case mutations through trusted proxy", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ updated: true })))

      vi.stubGlobal("fetch", fetchMock)

      const request = makeRequest(
        CUSTOM_ORIGIN,
        CLOUD_RUN_HOST,
        "PUT",
        `/api/backend/clinical-cases/${CASE_ID}`,
      )

      request.cookies.set("clinical_session", "private-token")

      const response = await PUT(request, {
        params: Promise.resolve({
          path: ["clinical-cases", CASE_ID],
        }),
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledOnce()

      const [url, options] = fetchMock.mock.calls[0]

      expect(url).toContain(`/api/v1/clinical-cases/${CASE_ID}`)
      expect(options.method).toBe("PUT")
      expect(options.headers.get("authorization")).toBe("Bearer private-token")
    })

    it("keeps session when logout fails", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Unavailable" } }), {
          status: 503,
        }),
      )

      vi.stubGlobal("fetch", fetchMock)

      const request = makeRequest(
        CUSTOM_ORIGIN,
        CLOUD_RUN_HOST,
        "POST",
        "/api/backend/auth/logout",
      )

      request.cookies.set("clinical_session", "private-token")

      const response = await POST(request, {
        params: Promise.resolve({ path: ["auth", "logout"] }),
      })

      expect(response.status).toBe(503)
      expect(response.headers.get("set-cookie")).toBeNull()
    })

    it("revokes session cookie after successful logout", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ signed_out: true })))

      vi.stubGlobal("fetch", fetchMock)

      const request = makeRequest(
        CUSTOM_ORIGIN,
        CLOUD_RUN_HOST,
        "POST",
        "/api/backend/auth/logout",
      )

      // Set cookie through NextRequest.cookies, not headers.
      request.cookies.set("clinical_session", "private-token")

      const response = await POST(request, {
        params: Promise.resolve({ path: ["auth", "logout"] }),
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledOnce()

      expect(response.headers.get("set-cookie")).toContain("clinical_session=")

      expect(fetchMock.mock.calls[0][1].headers.get("authorization")).toBe(
        "Bearer private-token",
      )
    })

    it("never exposes session token in login JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              user: { id: "id", username: "alice" },
              session_token: "private-token",
            }),
          ),
        ),
      )

      const response = await POST(
        makeRequest("http://localhost", "localhost", "POST"),
        { params: Promise.resolve({ path: ["auth", "login"] }) },
      )

      const body = await response.json()

      expect(body).toEqual({
        id: "id",
        username: "alice",
      })

      expect(JSON.stringify(body)).not.toContain("private-token")
      expect(response.headers.get("set-cookie")).toContain("HttpOnly")
      expect(response.headers.get("cache-control")).toBe("no-store")
    })
  })
})
