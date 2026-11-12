/**
 * End-to-end proof for every Neon service wired into knomad.
 * Usage: npm test   (loads .env.local: DATABASE_URL, NEON_AUTH_BASE_URL,
 *                    NEON_REALTIME_URL, NEON_AI_GATEWAY_*, AWS_*)
 */
import { functionBaseUrl } from "@neon/env";
import { createRealtimeClient } from "@neon/realtime/client";

const results = [];
let hardFailure = false;

function record(name, status, detail) {
  results.push({ service: name, status, detail });
  if (status === "fail") hardFailure = true;
  console.log(`[${status.toUpperCase()}] ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

function syncUrl() {
  if (process.env.KNOMAD_SYNC_URL) return process.env.KNOMAD_SYNC_URL.replace(/\/$/, "");
  return functionBaseUrl("knomadsync");
}

function authBase() {
  const url = process.env.NEON_AUTH_BASE_URL;
  if (!url) throw new Error("NEON_AUTH_BASE_URL is missing");
  return url.replace(/\/$/, "");
}

function cookieHeader(response) {
  const list =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return list.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function main() {
  const fn = syncUrl();
  console.log("Function:", fn);
  console.log("Auth:    ", authBase());
  console.log("Realtime:", process.env.NEON_REALTIME_URL || "(missing)");
  console.log("");

  // 1. Function reachability + injected service env
  {
    const { response, body } = await jsonFetch(fn + "/health");
    if (response.ok && body && body.ok) {
      record("Functions", "pass", body);
      const missing = Object.entries(body.services || {})
        .filter(([, present]) => !present)
        .map(([name]) => name);
      record(
        "Service env injection",
        missing.length ? "fail" : "pass",
        missing.length ? "missing env: " + missing.join(", ") : "postgres, auth, storage, aiGateway, realtime all injected",
      );
    } else {
      record("Functions", "fail", `HTTP ${response.status}: ${JSON.stringify(body)}`);
      return;
    }
  }

  // 2. Auth: create a throwaway user, then mint a JWT
  const email = `knomad-e2e-${Date.now()}@example.com`;
  const password = "Knomad-E2E-12345!";
  let jwt = "";

  {
    const { response, body } = await jsonFetch(authBase() + "/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:8000" },
      body: JSON.stringify({ email, password, name: "Knomad E2E" }),
    });

    if (!response.ok) {
      record("Auth sign-up", "fail", `HTTP ${response.status}: ${JSON.stringify(body)}`);
      return;
    }

    const cookies = cookieHeader(response);

    const token = await jsonFetch(authBase() + "/token", {
      headers: { Origin: "http://localhost:8000", ...(cookies ? { Cookie: cookies } : {}) },
    });
    jwt = token.body?.token || response.headers.get("set-auth-jwt") || "";

    if (!jwt) {
      record("Auth sign-up", "fail", "signed up but /token returned no JWT: " + JSON.stringify(token.body));
      return;
    }
    record("Auth", "pass", "signed up " + email + " and minted a JWT");
  }

  const authHeaders = { Authorization: "Bearer " + jwt };

  // 3. Function verifies the JWT
  {
    const { response, body } = await jsonFetch(fn + "/me", { headers: authHeaders });
    if (response.ok && body?.userId) record("Function JWT verification", "pass", "userId " + body.userId);
    else {
      record("Function JWT verification", "fail", `HTTP ${response.status}: ${JSON.stringify(body)}`);
      return;
    }
  }

  // 4. Postgres round-trip + last-write-wins
  const now = Date.now();
  {
    const first = await jsonFetch(fn + "/docs", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "profile",
        docId: "me",
        payload: { name: "First write", marker: "e2e-1" },
        clientUpdatedAt: now,
      }),
    });

    const stale = await jsonFetch(fn + "/docs", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "profile",
        docId: "me",
        payload: { name: "Stale write", marker: "e2e-stale" },
        clientUpdatedAt: now - 1000,
      }),
    });

    const pull = await jsonFetch(fn + "/docs?since=1970-01-01T00:00:00.000Z", {
      headers: authHeaders,
    });

    const row = (pull.body?.docs || []).find((doc) => doc.kind === "profile" && doc.doc_id === "me");
    const ok =
      first.response.ok &&
      stale.response.ok &&
      stale.body?.applied === false &&
      row &&
      row.payload?.marker === "e2e-1";

    record(
      "Postgres + sync API",
      ok ? "pass" : "fail",
      ok
        ? "wrote, ignored a stale write, and read the newer payload back"
        : JSON.stringify({ first: first.body, stale: stale.body, row }),
    );
  }

  // 5. Object Storage: upload a resume, then fetch the presigned URL
  {
    const bytes = Buffer.from("knomad e2e resume " + now + "\n");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "text/plain" }), "e2e-resume.txt");

    const upload = await jsonFetch(fn + "/resume", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });

    if (!upload.response.ok || !upload.body?.url) {
      record("Object Storage", "fail", JSON.stringify(upload.body));
    } else {
      const download = await fetch(upload.body.url);
      const downloaded = Buffer.from(await download.arrayBuffer());
      const ok = download.ok && downloaded.equals(bytes);
      record(
        "Object Storage",
        ok ? "pass" : "fail",
        ok
          ? `uploaded ${upload.body.key} and verified the presigned download`
          : `presigned download failed: HTTP ${download.status}`,
      );
    }
  }

  // 6. Realtime: seal a user-scoped query, subscribe, observe a new write
  {
    const rtUrl = process.env.NEON_REALTIME_URL;
    if (!rtUrl) {
      record("Realtime", "fail", "NEON_REALTIME_URL is missing");
    } else {
      const sealed = await jsonFetch(fn + "/realtime/token", {
        method: "POST",
        headers: authHeaders,
      });

      if (!sealed.response.ok || !sealed.body) {
        record("Realtime", "fail", "seal failed: " + JSON.stringify(sealed.body));
      } else {
        try {
          const client = createRealtimeClient({ url: rtUrl });
          const subscription = client.subscribe(sealed.body);

          const sawUpdate = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), 15_000);
            subscription.onChange((snapshot) => {
              if (!Array.isArray(snapshot.data)) return;
              const hit = snapshot.data.some(
                (row) => row.kind === "application" && row.doc_id === "e2e-app",
              );
              if (hit) {
                clearTimeout(timer);
                resolve(true);
              }
            });

            setTimeout(() => {
              fetch(fn + "/docs", {
                method: "POST",
                headers: { ...authHeaders, "Content-Type": "application/json" },
                body: JSON.stringify({
                  kind: "application",
                  docId: "e2e-app",
                  payload: { id: "e2e-app", company: "Realtime Co", position: "Test" },
                  clientUpdatedAt: Date.now(),
                }),
              }).catch(() => {});
            }, 1500);
          });

          try {
            subscription.unsubscribe();
          } catch {
            // ignore
          }
          try {
            client.close();
          } catch {
            // ignore
          }

          record(
            "Realtime",
            sawUpdate ? "pass" : "fail",
            sawUpdate ? "live subscription received the new application row" : "no live update within 15s",
          );
        } catch (err) {
          record("Realtime", "fail", err.message);
        }
      }
    }
  }

  // 7. AI Gateway
  {
    const { response, body } = await jsonFetch(fn + "/ai/chat", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: 'Reply with exactly this JSON and nothing else: {"ok":true}' }),
    });

    if (response.ok && body?.text) {
      record("AI Gateway", "pass", { model: body.model, text: body.text.slice(0, 120) });
    } else if (response.status === 402 || /paid_plan_required|credits/i.test(JSON.stringify(body))) {
      record(
        "AI Gateway",
        "blocked",
        "credentials minted, but the account has no AI Gateway credits/model access: " +
          JSON.stringify(body).slice(0, 300),
      );
    } else {
      record("AI Gateway", "fail", `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
    }
  }

  // 8. Clean up the E2E documents
  {
    await jsonFetch(fn + "/docs/batch", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        docs: [
          { kind: "profile", docId: "me", deleted: true, clientUpdatedAt: Date.now() },
          { kind: "application", docId: "e2e-app", deleted: true, clientUpdatedAt: Date.now() },
        ],
      }),
    }).catch(() => {});
  }

  console.log("\n" + JSON.stringify(results, null, 2));
  // The Realtime client keeps a socket open; end the run explicitly.
  process.exit(hardFailure ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
