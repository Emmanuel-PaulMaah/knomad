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

let cached = { token: "", expiresAt: 0 };

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

async function fetchToken(force) {
  if (!authClient) throw new Error("Cloud sync is not configured");
  if (!force && cached.token && (!cached.expiresAt || Date.now() < cached.expiresAt - 30_000)) {
    return cached.token;
  }

  if (typeof authClient.token === "function") {
    const result = await authClient.token();
    if (result && result.error) throw new Error(authMessage(result.error, "Could not read session token"));
    const token = result && result.data && result.data.token;
    if (token) {
      cached = { token, expiresAt: jwtExpiry(token) };
      return token;
    }
  }

  const session = await authClient.getSession();
  if (session && session.error) throw new Error(authMessage(session.error, "Could not read session"));
  const accessToken = session && session.data && session.data.session && session.data.session.access_token;
  if (accessToken) {
    cached = { token: accessToken, expiresAt: jwtExpiry(accessToken) };
    return accessToken;
  }

  throw new Error("Sign in to sync");
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

  if (response.status === 401 && retry) {
    clearTokenCache();
    return api(path, { ...options, retry: false });
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error((data && data.error) || "Request failed (" + response.status + ")");
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

export async function aiChat(prompt, model) {
  const data = await api("/ai/chat", { method: "POST", body: { prompt, model } });
  if (!data || typeof data.text !== "string") throw new Error("AI Gateway returned no text");
  return data.text;
}
