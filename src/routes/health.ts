import { Hono } from "hono";
import type { Env } from "@/types/env";

export const healthRoutes = new Hono<{ Bindings: Env }>();
export const healthzRoutes = new Hono<{ Bindings: Env }>();

function deploymentStamp(env: Env) {
  return {
    ok: true,
    // The staging tier retains the deployed development Worker name.
    service:
      env.SCRY_ENV === "staging" ? "scry-cdn-service-dev" : "scry-cdn-service",
    env: env.SCRY_ENV ?? "dev",
    commit: env.SCRY_COMMIT ?? "dev",
    branch: env.SCRY_BRANCH ?? null,
    builtAt: env.SCRY_BUILD_TIME ?? null,
    deployId: env.SCRY_DEPLOY_ID ?? null,
    actor: env.SCRY_ACTOR ?? null,
  };
}

healthzRoutes.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(deploymentStamp(c.env));
});

healthRoutes.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    ...deploymentStamp(c.env),
    status: "healthy",
    platform: c.env.PLATFORM || "unknown",
    timestamp: new Date().toISOString(),
  });
});

healthRoutes.get("/ready", async (c) => {
  // Check storage connectivity
  try {
    const storage = await import("@/adapters/storage/factory").then((m) =>
      m.createStorageAdapter(c.env),
    );

    return c.json({
      status: "ready",
      checks: {
        storage: "ok",
      },
    });
  } catch (error) {
    return c.json(
      {
        status: "not ready",
        checks: {
          storage: "failed",
          error: String(error),
        },
      },
      503,
    );
  }
});
