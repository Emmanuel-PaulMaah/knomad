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

    // A clock that runs an hour ahead must be refused, not stored: it would
    // outrank every later write from every other device.
    const future = await jsonFetch(fn + "/docs", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "profile",
        docId: "me",
        payload: { name: "Future write", marker: "e2e-future" },
        clientUpdatedAt: now + 60 * 60 * 1000,
      }),
    });

    // The same rejection inside a batch must come back as applied:false with a
    // reason, so the client can stop claiming the write was saved.
    const batch = await jsonFetch(fn + "/docs/batch", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        docs: [
          {
            kind: "application",
            docId: "e2e-clock",
            payload: { marker: "e2e-clock" },
            clientUpdatedAt: now + 60 * 60 * 1000,
          },
        ],
      }),
    });
    const batchResult = batch.body?.results?.[0];

    const pull = await jsonFetch(fn + "/docs?since=1970-01-01T00:00:00.000Z", {
      headers: authHeaders,
    });

    const row = (pull.body?.docs || []).find((doc) => doc.kind === "profile" && doc.doc_id === "me");
    const ok =
      first.response.ok &&
      stale.response.ok &&
      stale.body?.applied === false &&
      future.response.status === 409 &&
      batch.response.ok &&
      batchResult?.applied === false &&
      /clock/i.test(batchResult?.error || "") &&
      row &&
      row.payload?.marker === "e2e-1";

    record(
      "Postgres + sync API",
      ok ? "pass" : "fail",
      ok
        ? "wrote, ignored a stale write, rejected a future clock in /docs and /docs/batch, and read the newer payload back"
        : JSON.stringify({ first: first.body, stale: stale.body, future: future.body, batch: batch.body, row }),
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

    // A file whose name is not on the allowlist must be refused, not stored
    // with attacker-chosen Content-Type and served inline.
    const rejectedForm = new FormData();
    rejectedForm.append(
      "file",
      new Blob(["<script>alert(1)</script>"], { type: "text/html" }),
      "resume.html",
    );
    const rejected = await jsonFetch(fn + "/resume", {
      method: "POST",
      headers: authHeaders,
      body: rejectedForm,
    });

    if (!upload.response.ok || !upload.body?.url) {
      record("Object Storage", "fail", JSON.stringify(upload.body));
    } else {
      const download = await fetch(upload.body.url);
      const downloaded = Buffer.from(await download.arrayBuffer());
      const ok = download.ok && downloaded.equals(bytes) && rejected.response.status === 415;
      record(
        "Object Storage",
        ok ? "pass" : "fail",
        ok
          ? `uploaded ${upload.body.key}, verified the presigned download, and refused a .html upload`
          : `storage check failed: HTTP ${download.status}, reject=${rejected.response.status}`,
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

  // 8. Friends + shared inbox: request, accept, send, read, dismiss
  {
    const friendEmail = `knomad-e2e-friend-${Date.now()}@example.com`;
    const friendPassword = "Knomad-E2E-Friend-12345!";

    const signUp = await jsonFetch(authBase() + "/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:8000" },
      body: JSON.stringify({ email: friendEmail, password: friendPassword, name: "Knomad Friend" }),
    });

    if (!signUp.response.ok) {
      record("Friends", "fail", "friend sign-up failed: " + JSON.stringify(signUp.body));
    } else {
      const cookies = cookieHeader(signUp.response);
      const token = await jsonFetch(authBase() + "/token", {
        headers: { Origin: "http://localhost:8000", ...(cookies ? { Cookie: cookies } : {}) },
      });
      const friendJwt = token.body?.token || signUp.response.headers.get("set-auth-jwt") || "";
      const friendHeaders = { Authorization: "Bearer " + friendJwt };
      const friendMe = await jsonFetch(fn + "/me", { headers: friendHeaders });
      const friendId = friendMe.body?.userId || "";

      const requested = await jsonFetch(fn + "/friends/request", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ email: friendEmail }),
      });

      const friendSocial = await jsonFetch(fn + "/social", { headers: friendHeaders });
      const requestId = friendSocial.body?.incoming?.[0]?.id || "";

      const accepted = await jsonFetch(fn + "/friends/respond", {
        method: "POST",
        headers: { ...friendHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, action: "accept" }),
      });

      const shared = await jsonFetch(fn + "/shares", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          toUserId: friendId,
          company: "E2E Co",
          position: "Test role",
          url: "https://example.com/e2e",
          note: "A job for you",
          jobDescription: "E2E job description",
        }),
      });
      const shareId = shared.body?.share?.id || "";

      const received = await jsonFetch(fn + "/social", { headers: friendHeaders });
      const inboxItem = received.body?.inbox?.[0] || null;

      await jsonFetch(fn + "/shares/" + encodeURIComponent(shareId) + "/read", {
        method: "POST",
        headers: friendHeaders,
      });
      const afterRead = await jsonFetch(fn + "/social", { headers: friendHeaders });

      await jsonFetch(fn + "/shares/" + encodeURIComponent(shareId), {
        method: "DELETE",
        headers: friendHeaders,
      });
      const afterDismiss = await jsonFetch(fn + "/social", { headers: friendHeaders });

      // A reply revives the dismissed lead for the recipient and is unread for them.
      const senderReply = await jsonFetch(fn + "/shares/" + encodeURIComponent(shareId) + "/messages", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Still interested in this one?" }),
      });
      const revived = await jsonFetch(fn + "/social", { headers: friendHeaders });
      const revivedItem = revived.body?.inbox?.find((item) => item.id === shareId) || null;

      await jsonFetch(fn + "/shares/" + encodeURIComponent(shareId) + "/messages/read", {
        method: "POST",
        headers: friendHeaders,
      });
      const afterMessageRead = await jsonFetch(fn + "/social", { headers: friendHeaders });
      const readItem = afterMessageRead.body?.inbox?.find((item) => item.id === shareId) || null;

      const friendReply = await jsonFetch(fn + "/shares/" + encodeURIComponent(shareId) + "/messages", {
        method: "POST",
        headers: { ...friendHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Yes, applying today." }),
      });
      const senderThread = await jsonFetch(fn + "/social", { headers: authHeaders });
      const sentItem = senderThread.body?.sent?.find((item) => item.id === shareId) || null;

      await jsonFetch(fn + "/friends/" + encodeURIComponent(friendId), {
        method: "DELETE",
        headers: authHeaders,
      });
      await jsonFetch(fn + "/shares/" + encodeURIComponent(shareId), {
        method: "DELETE",
        headers: authHeaders,
      });

      const ok =
        requested.response.ok &&
        requested.body?.status === "requested" &&
        friendSocial.body?.incoming?.some((item) => item.id === requestId) &&
        accepted.body?.status === "accepted" &&
        shared.response.ok &&
        inboxItem?.company === "E2E Co" &&
        inboxItem?.note === "A job for you" &&
        received.body?.unread === 1 &&
        afterRead.body?.unread === 0 &&
        afterDismiss.body?.inbox?.length === 0 &&
        senderReply.response.ok &&
        senderReply.body?.message?.mine === true &&
        revivedItem?.messages?.length === 1 &&
        revivedItem?.messages?.[0]?.mine === false &&
        revivedItem?.messageUnread === 1 &&
        revived.body?.unreadMessages === 1 &&
        readItem?.messageUnread === 0 &&
        afterMessageRead.body?.unreadMessages === 0 &&
        friendReply.response.ok &&
        sentItem?.messages?.length === 2 &&
        sentItem?.messages?.[1]?.mine === false &&
        sentItem?.messageUnread === 1 &&
        senderThread.body?.unreadMessages === 1;

      record(
        "Friends + shared inbox",
        ok ? "pass" : "fail",
        ok
          ? "requested, accepted, shared a job, marked it read, dismissed it, then revived it with a reply and exchanged messages both ways"
          : JSON.stringify({
              requested: requested.body,
              incoming: friendSocial.body?.incoming,
              accepted: accepted.body,
              shared: shared.body,
              inboxItem,
              unread: received.body?.unread,
              afterRead: afterRead.body?.unread,
              afterDismiss: afterDismiss.body?.inbox?.length,
              senderReply: senderReply.body,
              revivedItem: revivedItem && {
                status: revivedItem.status,
                messages: revivedItem.messages?.length,
                messageUnread: revivedItem.messageUnread,
              },
              revivedUnreadMessages: revived.body?.unreadMessages,
              readMessageUnread: readItem?.messageUnread,
              afterMessageRead: afterMessageRead.body?.unreadMessages,
              friendReply: friendReply.body,
              sentItem: sentItem && {
                messages: sentItem.messages?.length,
                messageUnread: sentItem.messageUnread,
              },
              senderUnreadMessages: senderThread.body?.unreadMessages,
            }),
      );
    }
  }

  // 9. Clean up the E2E documents
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
