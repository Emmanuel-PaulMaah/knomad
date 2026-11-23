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

  // 9. Together: circles, shared to-dos, and version guards
  {
    const stamp = Date.now();
    const memberEmail = `knomad-e2e-member-${stamp}@example.com`;
    const memberPassword = "Knomad-E2E-Member-12345!";

    const memberSignUp = await jsonFetch(authBase() + "/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:8000" },
      body: JSON.stringify({ email: memberEmail, password: memberPassword, name: "Knomad Member" }),
    });

    let memberHeaders = null;
    if (memberSignUp.response.ok) {
      const cookies = cookieHeader(memberSignUp.response);
      const token = await jsonFetch(authBase() + "/token", {
        headers: { Origin: "http://localhost:8000", ...(cookies ? { Cookie: cookies } : {}) },
      });
      const memberJwt = token.body?.token || memberSignUp.response.headers.get("set-auth-jwt") || "";
      memberHeaders = { Authorization: "Bearer " + memberJwt };
    }

    const memberMe = memberHeaders ? await jsonFetch(fn + "/me", { headers: memberHeaders }) : null;
    const memberId = memberMe?.body?.userId || "";

    if (!memberHeaders || !memberId) {
      record("Together", "fail", "member sign-up failed: " + JSON.stringify(memberSignUp.body));
    } else {
      const requested = await jsonFetch(fn + "/friends/request", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberEmail }),
      });
      const memberSocial = await jsonFetch(fn + "/social", { headers: memberHeaders });
      const requestId = memberSocial.body?.incoming?.[0]?.id || "";
      const accepted = await jsonFetch(fn + "/friends/respond", {
        method: "POST",
        headers: { ...memberHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, action: "accept" }),
      });

      const personalListRes = await jsonFetch(fn + "/task-lists", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E personal list" }),
      });
      const personalList = personalListRes.body?.taskList || null;

      const personalTaskRes = await jsonFetch(fn + "/tasks", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "E2E personal task",
          listId: personalList?.id,
          dueAt: new Date(stamp + 24 * 60 * 60 * 1000).toISOString(),
        }),
      });
      const personalTask = personalTaskRes.body?.task || null;

      const memberBefore = await jsonFetch(fn + "/space", { headers: memberHeaders });
      const memberSeesPersonal = (memberBefore.body?.tasks || []).some(
        (task) => task.id === personalTask?.id,
      );

      const bumped = await jsonFetch(fn + "/tasks/" + encodeURIComponent(personalTask?.id || ""), {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "doing", version: personalTask?.version }),
      });
      const stale = await jsonFetch(fn + "/tasks/" + encodeURIComponent(personalTask?.id || ""), {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "open", version: personalTask?.version }),
      });

      const circleRes = await jsonFetch(fn + "/circles", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E circle " + stamp }),
      });
      const circle = circleRes.body?.circle || null;

      const addedMember = circle
        ? await jsonFetch(fn + "/circles/" + encodeURIComponent(circle.id) + "/members", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ userId: memberId }),
          })
        : { response: { ok: false }, body: null };

      const sharedListRes = circle
        ? await jsonFetch(fn + "/task-lists", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "E2E shared list", circleId: circle.id }),
          })
        : { response: { ok: false }, body: null };
      const sharedList = sharedListRes.body?.taskList || null;

      const sharedTaskRes = circle
        ? await jsonFetch(fn + "/tasks", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "E2E shared task",
              circleId: circle.id,
              listId: sharedList?.id,
              assigneeId: memberId,
            }),
          })
        : { response: { ok: false }, body: null };
      const sharedTask = sharedTaskRes.body?.task || null;

      const projectRes = circle
        ? await jsonFetch(fn + "/projects", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "E2E shared project",
              summary: "Prove milestones carry progress",
              status: "active",
              targetOn: new Date(stamp + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
              circleId: circle.id,
            }),
          })
        : { response: { ok: false }, body: null };
      const project = projectRes.body?.project || null;

      const milestoneRes = project
        ? await jsonFetch(fn + "/tasks", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "E2E milestone",
              projectId: project.id,
              circleId: circle.id,
              isMilestone: true,
            }),
          })
        : { response: { ok: false }, body: null };
      const milestone = milestoneRes.body?.task || null;

      const invalidMilestone = await jsonFetch(fn + "/tasks", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "E2E orphan milestone", isMilestone: true }),
      });

      const categoryRes = circle
        ? await jsonFetch(fn + "/shelf-categories", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Business", circleId: circle.id }),
          })
        : { response: { ok: false }, body: null };
      const shelfCategory = categoryRes.body?.shelfCategory || null;

      const memberCategoryCreate = circle
        ? await jsonFetch(fn + "/shelf-categories", {
            method: "POST",
            headers: { ...memberHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Member pick", circleId: circle.id }),
          })
        : { response: { ok: false }, body: null };

      const bookRes = circle
        ? await jsonFetch(fn + "/books", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "E2E shared book",
              author: "Knomad Author",
              category: shelfCategory?.name || "Business",
              pagesTotal: 240,
              circleId: circle.id,
            }),
          })
        : { response: { ok: false }, body: null };
      const book = bookRes.body?.book || null;

      const memberBookSpace = await jsonFetch(fn + "/space", { headers: memberHeaders });
      const seenBook = (memberBookSpace.body?.books || []).find(
        (entry) => entry.id === book?.id,
      ) || null;
      const seenCategory = (memberBookSpace.body?.shelfCategories || []).find(
        (entry) => entry.id === shelfCategory?.id,
      ) || null;

      const memberCategoryDelete = seenCategory
        ? await jsonFetch(fn + "/shelf-categories/" + encodeURIComponent(seenCategory.id), {
            method: "DELETE",
            headers: { ...memberHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ version: seenCategory.version }),
          })
        : { response: { ok: false }, body: null };

      const memberFinishedBook = seenBook
        ? await jsonFetch(fn + "/books/" + encodeURIComponent(seenBook.id), {
            method: "PATCH",
            headers: { ...memberHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ shelf: "finished", version: seenBook.version }),
          })
        : { response: { ok: false }, body: null };

      const ownerBookSpace = await jsonFetch(fn + "/space", { headers: authHeaders });
      const finishedBook = (ownerBookSpace.body?.books || []).find(
        (entry) => entry.id === book?.id,
      ) || null;

      const memberSpace = await jsonFetch(fn + "/space", { headers: memberHeaders });
      const seenTask = (memberSpace.body?.tasks || []).find((task) => task.id === sharedTask?.id) || null;
      const seenProject = (memberSpace.body?.projects || []).find((entry) => entry.id === project?.id) || null;
      const seenMilestone = (memberSpace.body?.tasks || []).find((task) => task.id === milestone?.id) || null;

      const memberDone = seenTask
        ? await jsonFetch(fn + "/tasks/" + encodeURIComponent(seenTask.id), {
            method: "PATCH",
            headers: { ...memberHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done", version: seenTask.version }),
          })
        : { response: { ok: false }, body: null };

      const milestoneDone = seenMilestone
        ? await jsonFetch(fn + "/tasks/" + encodeURIComponent(seenMilestone.id), {
            method: "PATCH",
            headers: { ...memberHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done", version: seenMilestone.version }),
          })
        : { response: { ok: false }, body: null };

      const ownerSpace = await jsonFetch(fn + "/space", { headers: authHeaders });
      const ownerSeesDone = (ownerSpace.body?.tasks || []).find(
        (task) => task.id === sharedTask?.id,
      ) || null;
      const ownerSeesMilestone = (ownerSpace.body?.tasks || []).find(
        (task) => task.id === milestone?.id,
      ) || null;

      const contactDay = new Date().toISOString().slice(0, 10);
      const contactRes = circle
        ? await jsonFetch(fn + "/contacts", {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "E2E shared contact",
              company: "Knomad Co",
              stage: "talking",
              tags: ["client", "warm"],
              nextFollowUpOn: contactDay,
              circleId: circle.id,
            }),
          })
        : { response: { ok: false }, body: null };
      const contact = contactRes.body?.contact || null;

      const privateContactRes = await jsonFetch(fn + "/contacts", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E private contact" }),
      });
      const privateContact = privateContactRes.body?.contact || null;

      const memberContactSpace = await jsonFetch(fn + "/space", { headers: memberHeaders });
      const seenContact = (memberContactSpace.body?.contacts || []).find(
        (entry) => entry.id === contact?.id,
      ) || null;
      const memberSeesPrivateContact = (memberContactSpace.body?.contacts || []).some(
        (entry) => entry.id === privateContact?.id,
      );

      const noteRes = seenContact
        ? await jsonFetch(fn + "/contacts/" + encodeURIComponent(seenContact.id) + "/notes", {
            method: "POST",
            headers: { ...memberHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ body: "E2E logged interaction", happenedOn: contactDay }),
          })
        : { response: { ok: false }, body: null };
      const contactNote = noteRes.body?.note || null;
      const notedContact = noteRes.body?.contact || null;

      const staleContact = contact
        ? await jsonFetch(fn + "/contacts/" + encodeURIComponent(contact.id), {
            method: "PATCH",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ company: "Too late", version: contact.version }),
          })
        : { response: { ok: false }, body: null };

      const archived = circle
        ? await jsonFetch(fn + "/circles/" + encodeURIComponent(circle.id), {
            method: "DELETE",
            headers: authHeaders,
          })
        : { response: { ok: false }, body: null };

      const afterArchiveOwner = await jsonFetch(fn + "/space", { headers: authHeaders });
      const detached = (afterArchiveOwner.body?.tasks || []).find(
        (task) => task.id === sharedTask?.id,
      ) || null;
      const detachedContact = (afterArchiveOwner.body?.contacts || []).find(
        (entry) => entry.id === contact?.id,
      ) || null;
      const detachedProject = (afterArchiveOwner.body?.projects || []).find(
        (entry) => entry.id === project?.id,
      ) || null;

      const afterArchiveMember = await jsonFetch(fn + "/space", { headers: memberHeaders });
      const memberStillSees =
        (afterArchiveMember.body?.circles || []).some((entry) => entry.id === circle?.id) ||
        (afterArchiveMember.body?.taskLists || []).some((list) => list.id === sharedList?.id) ||
        (afterArchiveMember.body?.tasks || []).some((task) => task.id === sharedTask?.id);

      const ok =
        memberSignUp.response.ok &&
        requested.response.ok &&
        accepted.response.ok &&
        Boolean(personalList?.id) &&
        personalTask?.circleId === null &&
        !memberSeesPersonal &&
        bumped.response.ok &&
        bumped.body?.task?.version === personalTask?.version + 1 &&
        stale.response.status === 409 &&
        stale.body?.current?.version === bumped.body?.task?.version &&
        circleRes.response.ok &&
        addedMember.response.ok &&
        sharedListRes.response.ok &&
        sharedTaskRes.response.ok &&
        projectRes.response.ok &&
        Boolean(project?.id) &&
        project?.circleId === circle?.id &&
        milestoneRes.response.ok &&
        milestone?.projectId === project?.id &&
        milestone?.isMilestone === true &&
        invalidMilestone.response.status === 400 &&
        seenProject?.version === project?.version &&
        seenMilestone?.version === milestone?.version &&
        milestoneDone.response.ok &&
        milestoneDone.body?.task?.status === "done" &&
        ownerSeesMilestone?.status === "done" &&
        categoryRes.response.ok &&
        Boolean(shelfCategory?.id) &&
        memberCategoryCreate.response.status === 403 &&
        seenCategory?.id === shelfCategory?.id &&
        memberCategoryDelete.response.status === 403 &&
        bookRes.response.ok &&
        Boolean(book?.id) &&
        seenBook?.version === book?.version &&
        memberFinishedBook.response.ok &&
        memberFinishedBook.body?.book?.shelf === "finished" &&
        memberFinishedBook.body?.book?.pagesRead === 240 &&
        finishedBook?.shelf === "finished" &&
        finishedBook?.pagesRead === 240 &&
        Boolean(finishedBook?.finishedOn) &&
        sharedTask?.assigneeId === memberId &&
        seenTask?.version === sharedTask?.version &&
        memberDone.response.ok &&
        memberDone.body?.task?.status === "done" &&
        ownerSeesDone?.status === "done" &&
        ownerSeesDone?.version === sharedTask?.version + 1 &&
        contactRes.response.ok &&
        Boolean(contact?.id) &&
        contact?.circleId === circle?.id &&
        privateContactRes.response.ok &&
        privateContact?.circleId === null &&
        seenContact?.version === contact?.version &&
        !memberSeesPrivateContact &&
        noteRes.response.ok &&
        contactNote?.body === "E2E logged interaction" &&
        String(notedContact?.lastContactOn || "").slice(0, 10) === contactDay &&
        notedContact?.version === contact?.version + 1 &&
        staleContact.response.status === 409 &&
        staleContact.body?.current?.version === notedContact?.version &&
        archived.response.ok &&
        detached?.circleId === null &&
        detached?.assigneeId === null &&
        detachedContact?.circleId === null &&
        detachedProject?.circleId === null &&
        !memberStillSees;

      record(
        "Together",
        ok ? "pass" : "fail",
        ok
          ? "personal rows stayed private, a stale write was refused with the current version, a shared contact stayed readable by the circle and a note updated last touch, and rows detached on archive"
          : JSON.stringify({
              memberSignUp: memberSignUp.body,
              requested: requested.body,
              accepted: accepted.body,
              personalList: personalListRes.body,
              personalTask: personalTaskRes.body,
              memberSeesPersonal,
              bumped: bumped.body,
              stale: { status: stale.response.status, body: stale.body },
              circle: circleRes.body,
              addedMember: addedMember.body,
              sharedList: sharedListRes.body,
              sharedTask: sharedTaskRes.body,
              category: categoryRes.body,
              memberCategoryCreate: memberCategoryCreate.body,
              seenCategory,
              memberCategoryDelete: memberCategoryDelete.body,
              project: projectRes.body,
              milestone: milestoneRes.body,
              invalidMilestone: { status: invalidMilestone.response.status, body: invalidMilestone.body },
              seenProject,
              seenMilestone,
              milestoneDone: milestoneDone.body,
              ownerSeesMilestone,
              book: bookRes.body,
              seenBook,
              memberFinishedBook: memberFinishedBook.body,
              finishedBook,
              seenTask,
              memberDone: memberDone.body,
              ownerSeesDone,
              archived: archived.body,
              detached,
              memberStillSees,
            }),
      );

      // Leave the test database tidy: tasks first, then their lists, then the project.
      for (const id of [personalTask?.id, sharedTask?.id, milestone?.id]) {
        const row = (afterArchiveOwner.body?.tasks || []).find((task) => task.id === id);
        if (!row) continue;
        await jsonFetch(fn + "/tasks/" + encodeURIComponent(id), {
          method: "DELETE",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ version: row.version }),
        }).catch(() => {});
      }
      for (const id of [personalList?.id, sharedList?.id]) {
        const row = (afterArchiveOwner.body?.taskLists || []).find((list) => list.id === id);
        if (!row) continue;
        await jsonFetch(fn + "/task-lists/" + encodeURIComponent(id), {
          method: "DELETE",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ version: row.version }),
        }).catch(() => {});
      }
      if (detachedProject) {
        await jsonFetch(fn + "/projects/" + encodeURIComponent(detachedProject.id), {
          method: "DELETE",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ version: detachedProject.version }),
        }).catch(() => {});
      }
      const bookRow = (afterArchiveOwner.body?.books || []).find((entry) => entry.id === book?.id);
      if (bookRow) {
        await jsonFetch(fn + "/books/" + encodeURIComponent(bookRow.id), {
          method: "DELETE",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ version: bookRow.version }),
        }).catch(() => {});
      }
      await jsonFetch(fn + "/friends/" + encodeURIComponent(memberId), {
        method: "DELETE",
        headers: authHeaders,
      }).catch(() => {});
    }
  }

  // 10. Clean up the E2E documents
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
