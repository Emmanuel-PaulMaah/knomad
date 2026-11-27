import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Managed Better Auth: users + sessions live in the branch's neon_auth schema.
  auth: true,

  // One OpenAI-compatible endpoint for every model, injected into the Function.
  aiGateway: true,

  // Live SQL over the branch, used to trigger sync pulls across devices.
  preview: {
    realtime: {
      allowedOrigins: ["http://localhost:8000", "http://127.0.0.1:8000", "https://knomad.netlify.app"],
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
        // Web Push signing. Generate a pair once with `npm run push:keys` and
        // keep it stable: changing the keys invalidates every subscription.
        // "default-branch" keeps preview branches deployable without push.
        VAPID_PUBLIC_KEY: {
          value: process.env.VAPID_PUBLIC_KEY,
          required: "default-branch",
        },
        VAPID_PRIVATE_KEY: {
          value: process.env.VAPID_PRIVATE_KEY,
          required: "default-branch",
        },
        VAPID_SUBJECT: process.env.VAPID_SUBJECT || "mailto:hello@knomad.example",
      },
    },
  },

  // The push tick sends reminders and due tasks with no browser open. It runs
  // every minute so a reminder is punctual; knomad_push_log dedupes the send.
  triggers: {
    "knomad-push-tick": {
      type: "schedule",
      function: "knomadsync",
      cron: "* * * * *",
      functionPath: "/push/run",
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
