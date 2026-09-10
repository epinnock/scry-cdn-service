import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import type { Env } from "@/types/env";

describe.each(["/healthz", "/health"])("%s deployment stamp", (path) => {
  const app = createApp();

  async function request(env: Env = {}) {
    const response = await app.request(
      `https://view.scrymore.com${path}`,
      {
        // Health must bypass viewer auth and asset redirects even with a referer.
        headers: {
          Referer: "https://view.scrymore.com/privateProject/main/iframe.html",
        },
      },
      { NODE_ENV: "production", ...env },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;

    if (path === "/health") {
      expect(body.status).toBe("healthy");
      expect(body.platform).toBe(env.PLATFORM ?? "unknown");
      expect(new Date(String(body.timestamp)).toISOString()).toBe(body.timestamp);
      delete body.status;
      delete body.platform;
      delete body.timestamp;
    }
    return body;
  }

  it("returns local defaults without credentials or storage bindings", async () => {
    expect(await request()).toEqual({
      ok: true,
      service: "scry-cdn-service",
      env: "dev",
      commit: "dev",
      branch: null,
      builtAt: null,
      deployId: null,
      actor: null,
    });
  });

  it.each([
    ["staging", "scry-cdn-service-dev"],
    ["production", "scry-cdn-service"],
    ["dev", "scry-cdn-service"],
  ] as const)("returns only public metadata for %s", async (env, service) => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(
      await request({
        PLATFORM: "cloudflare",
        SCRY_ENV: env,
        SCRY_COMMIT: commit,
        SCRY_BRANCH: "feature/deploy-stamp",
        SCRY_BUILD_TIME: "2026-09-10T12:34:56Z",
        SCRY_DEPLOY_ID: "123456789",
        SCRY_ACTOR: "test-actor",
        FIREBASE_PRIVATE_KEY: "fake-private-key",
        PREVIEW_TOKEN_SECRET: "fake-preview-secret",
        FIREBASE_PROJECT_ID: "private-config",
      }),
    ).toEqual({
      ok: true,
      service,
      env,
      commit,
      branch: "feature/deploy-stamp",
      builtAt: "2026-09-10T12:34:56Z",
      deployId: "123456789",
      actor: "test-actor",
    });
  });
});
