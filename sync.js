/**
 * Browser-side Neon bindings.
 *
 * Only public values live here:
 *   VITE_NEON_AUTH_URL      branch Managed Better Auth URL
 *   VITE_NEON_SYNC_URL      deployed knomadsync Function URL
 *   VITE_NEON_REALTIME_URL  branch Realtime WebSocket URL
 *
 * The AI Gateway token, Realtime secret, Postgres URL and S3 secret stay in
 * the Function. The Gemini API key stays in this browser and is never sent
 * here, because it is not part of any synced document.
 */
import { createAuthClient } from "@neondatabase/auth";
import { createRealtimeClient } from "@neon/realtime/client";

const authUrl = (import.meta.env.VITE_NEON_AUTH_URL || "").trim();
const syncUrl = (import.meta.env.VITE_NEON_SYNC_URL || "").trim().replace(/\/$/, "");
const realtimeUrl = (import.meta.env.VITE_NEON_REALTIME_URL || "").trim();

export const cloudConfig = {
  authUrl,
  syncUrl,
  realtimeUrl,
  configured: Boolean(authUrl && syncUrl),
};

export const authClient = cloudConfig.configured ? createAuthClient(authUrl) : null;

// ---------------------------------------------------------------- token

/**
 * Sync API calls need a fresh JWT, but Better Auth can keep reporting a
 * session whose cookie is gone (third-party cookie blocking, a revoked
 * session, cleared site data). Callers use this error to stop claiming the
 * person is signed in.
 */
export class AuthRequiredError extends Error {
  constructor(message = "Session expired. Sign in again.") {
    super(message);
    this.name = "AuthRequiredError";
    this.code = "AUTH_REQUIRED";
  }
}

let cached = { token: "", expiresAt: 0 };
let pendingToken = null;

function jwtExpiry(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(part));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function authMessage(error, fallback) {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  return error.message || fallback;
}

function looksLikeJwt(value) {
  return typeof value === "string" && value.split(".").length === 3;
}

/**
 * Better Auth answers a token request from its 60-second session cache after a
 * page reload. That cached payload is the session object, not `{ token }`, and
 * the Neon adapter stores the `set-auth-jwt` header in `session.token`. Accept
 * every known shape so a warm cache never looks like a signed-out person.
 */
function extractToken(result) {
  if (!result) return "";
  const data = result.data || result;
  const candidates = [
    data.token,
    data.access_token,
    data.session && data.session.token,
    data.session && data.session.access_token,
    result.token
  ];
  return candidates.find(looksLikeJwt) || "";
}

async function fetchToken(force) {
  if (!authClient) throw new AuthRequiredError("Cloud sync is not configured");
  if (!force && cached.token && (!cached.expiresAt || Date.now() < cached.expiresAt - 30_000)) {
    return cached.token;
  }
  if (pendingToken) return pendingToken;

  pendingToken = (async () => {
    let networkError = null;
    let authError = null;

    // Two attempts: the first may hit a stale cached session, so ask Better
    // Auth to re-read the session before giving up on the person.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await authClient.token({ fetchOptions: { cache: "no-store" } });
        if (result && result.error) {
          authError = new AuthRequiredError(authMessage(result.error, "Session expired. Sign in again."));
        } else {
          const token = extractToken(result);
          if (token) {
            cached = { token, expiresAt: jwtExpiry(token) };
            return token;
          }
        }
      } catch (error) {
        if (error instanceof AuthRequiredError || error.code === "AUTH_REQUIRED") authError = error;
        else networkError = error;
      }

      if (attempt === 0) {
        try {
          await authClient.getSession({ fetchOptions: { cache: "no-store" } });
        } catch {
          // The retry below reports the real problem.
        }
      }
    }

    clearTokenCache();

    if (authError) throw authError;
    if (networkError) {
      throw new Error("Could not reach the sign-in service. Check your connection and try again.");
    }
    throw new AuthRequiredError();
  })();

  try {
    return await pendingToken;
  } finally {
    pendingToken = null;
  }
}

export function clearTokenCache() {
  cached = { token: "", expiresAt: 0 };
}

// ---------------------------------------------------------------- api

export async function api(path, options = {}) {
  if (!cloudConfig.configured) throw new Error("Cloud sync is not configured");
  const { method = "GET", body, retry = true } = options;

  const token = await fetchToken(false);
  const response = await fetch(syncUrl + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401) {
    clearTokenCache();
    if (retry) return api(path, { ...options, retry: false });
    throw new AuthRequiredError();
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || "Request failed (" + response.status + ")");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// ---------------------------------------------------------------- auth

export async function signUpCloud({ email, password, name }) {
  if (!authClient) throw new Error("Cloud sync is not configured");
  const result = await authClient.signUp.email({ email, password, name });
  if (result && result.error) throw new Error(authMessage(result.error, "Could not create account"));
  return result && result.data;
}

export async function signInCloud({ email, password }) {
  if (!authClient) throw new Error("Cloud sync is not configured");
  const result = await authClient.signIn.email({ email, password });
  if (result && result.error) throw new Error(authMessage(result.error, "Could not sign in"));
  return result && result.data;
}

export async function getCloudSession() {
  if (!authClient) return null;
  try {
    const result = await authClient.getSession();
    if (!result || result.error || !result.data) return null;
    return result.data;
  } catch {
    return null;
  }
}

export async function signOutCloud() {
  if (!authClient) return;
  clearTokenCache();
  closeRealtime();
  const result = await authClient.signOut();
  if (result && result.error) throw new Error(authMessage(result.error, "Could not sign out"));
}

/**
 * Drop the local session after the server stops accepting it. Unlike
 * signOutCloud this never throws, so a dead session cannot leave the UI in a
 * signed-in state.
 */
export async function forgetCloudSession() {
  clearTokenCache();
  closeRealtime();
  if (!authClient) return;
  try {
    await authClient.signOut();
  } catch {
    // The cookie is already unusable; clearing local state is enough.
  }
}

// ---------------------------------------------------------------- realtime

let realtimeClient = null;

export function closeRealtime() {
  try {
    if (realtimeClient && typeof realtimeClient.close === "function") realtimeClient.close();
  } catch {
    // ignore
  }
  realtimeClient = null;
}

/**
 * Ask the Function to seal a user-scoped live query, then subscribe to it.
 * Returns an object with unsubscribe(), or null when Realtime is not enabled.
 */
export async function subscribeToDocs(onRows, onState) {
  if (!cloudConfig.realtimeUrl || !authClient) return null;

  const sealed = await api("/realtime/token", { method: "POST" });
  if (!realtimeClient) realtimeClient = createRealtimeClient({ url: realtimeUrl });

  const subscription = realtimeClient.subscribe(sealed);
  const offChange =
    typeof subscription.onChange === "function"
      ? subscription.onChange((snapshot) => {
        if (snapshot && Array.isArray(snapshot.data)) onRows(snapshot.data);
      })
      : () => {};

  if (typeof subscription.onStateChange === "function") {
    subscription.onStateChange((state) => {
      if (onState) onState(state);
    });
  }

  return {
    unsubscribe() {
      try {
        offChange();
      } catch {
        // ignore
      }
      try {
        subscription.unsubscribe();
      } catch {
        // ignore
      }
    },
  };
}

// ---------------------------------------------------------------- files + ai

export async function uploadResumeFile(file) {
  if (!file) throw new Error("No file selected");
  const token = await fetchToken(false);
  const form = new FormData();
  form.append("file", file, file.name);

  const response = await fetch(syncUrl + "/resume", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || "Upload failed");
  return data;
}

export async function aiChat(prompt) {
  const data = await api("/ai/chat", { method: "POST", body: { prompt } });
  if (!data || typeof data.text !== "string") throw new Error("AI Gateway returned no text");
  return data.text;
}

// ---------------------------------------------------------------- push

/**
 * Web Push is server-sent: the browser registers a subscription and the
 * Function stores it, so a reminder can arrive while the tab is closed.
 * These calls carry the subscription only — the VAPID private key never
 * leaves the Function.
 */
export async function fetchPushConfig() {
  return api("/push/config");
}

export async function savePushSubscription(subscription, timezone) {
  if (!subscription || !subscription.endpoint) throw new Error("No push subscription");
  return api("/push/subscribe", {
    method: "POST",
    body: { subscription, timezone: timezone || "" },
  });
}

export async function dropPushSubscription(endpoint) {
  if (!endpoint) return null;
  return api("/push/unsubscribe", { method: "POST", body: { endpoint } });
}

// Settings removes another browser by the opaque id from /push/config, so a
// push endpoint never has to be handed to the page or kept in the DOM.
export async function removePushDevice(id) {
  if (!id) return null;
  return api("/push/unsubscribe", { method: "POST", body: { id } });
}

export async function sendTestPush() {
  return api("/push/test", { method: "POST" });
}
