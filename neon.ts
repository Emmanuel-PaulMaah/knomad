import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Managed Better Auth: users + sessions live in the branch's neon_auth schema.
  auth: true,

  // One OpenAI-compatible endpoint for every model, injected into the Function.
  aiGateway: true,

  // Live SQL over the branch, used to trigger sync pulls across devices.
  preview: {
    realtime: {
      allowedOrigins: ["http://localhost:8000", "http://127.0.0.1:8000"],
    },
  },

  functions: {
    // Slug is permanent and appears in the invocation URL.
    knomadsync: {
      name: "knomad sync API",
      source: "./src/function/index.ts",
      env: {
        // Realtime is not injected into Functions automatically; the sync API
        // needs this secret to seal a user-scoped live query.
        NEON_REALTIME_SECRET: {
          value: process.env.NEON_REALTIME_SECRET,
          required: true,
        },
      },
    },
  },

  buckets: {
    // Private: originals are only reachable through the Function's presigned URLs.
    resumes: { access: "private" },
  },

  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
