export const API_BASE_URL = (window.SHARPERX_API_BASE_URL || "https://api.46.225.173.118.nip.io").replace(/\/$/, "");

const TOKEN_KEY = "sharperx_access_token";
const DEVICE_KEY = "sharperx_web_device_id";

export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setAccessToken(value) {
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
}

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : "") || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export async function apiRequest(path, options = {}) {
  const { auth = true, responseType = "json", ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});
  if (auth && getAccessToken()) headers.set("Authorization", `Bearer ${getAccessToken()}`);
  if (auth) headers.set("X-Device-ID", deviceId());
  if (requestOptions.body && !headers.has("Content-Type")) {
    if (requestOptions.body instanceof URLSearchParams) {
      headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (!(requestOptions.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...requestOptions, headers });
  } catch (error) {
    throw new Error("Could not connect. Check your connection and try again.", { cause: error });
  }

  if (responseType === "blob") {
    if (!response.ok) throw await responseError(response, auth);
    return response.blob();
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 401 && auth
      ? "Your session has expired. Sign in again."
      : formatApiError(body.detail ?? body.message, response.status));
    error.status = response.status;
    if (response.status === 401 && auth) {
      setAccessToken("");
      window.dispatchEvent(new Event("sharperx:auth-expired"));
    }
    throw error;
  }
  return body;
}

async function responseError(response, auth = true) {
  const body = await response.clone().json().catch(() => ({}));
  const error = new Error(response.status === 401 && auth
    ? "Your session has expired. Sign in again."
    : formatApiError(body.detail ?? body.message, response.status));
  error.status = response.status;
  if (response.status === 401 && auth) {
    setAccessToken("");
    window.dispatchEvent(new Event("sharperx:auth-expired"));
  }
  return error;
}

function formatApiError(detail, status) {
  const fallback = `Request failed with HTTP ${status}`;
  if (typeof detail === "string" && detail.trim()) return safeErrorMessage(detail, fallback);
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const message = item.msg || item.message;
      const location = Array.isArray(item.loc) ? item.loc.filter((part) => part !== "body").join(" → ") : "";
      return message ? `${location ? `${location}: ` : ""}${message}` : "";
    }).filter(Boolean);
    return safeErrorMessage(messages.join("; ") || fallback, fallback);
  }
  if (detail && typeof detail === "object") {
    return safeErrorMessage(detail.message || detail.msg || JSON.stringify(detail), fallback);
  }
  return fallback;
}

function safeErrorMessage(message, fallback) {
  return /\bserver\b|gpt\s*[- ]?\s*6\s*[- ]?\s*luna|\bxhigh\b/i.test(String(message))
    ? "Could not complete this request. Please try again."
    : message || fallback;
}

export function getJson(path, options = {}) {
  return apiRequest(path, { method: "GET", ...options });
}

export function postJson(path, payload, options = {}) {
  return apiRequest(path, { method: "POST", body: JSON.stringify(payload), ...options });
}

export function postForm(path, values, options = {}) {
  const form = values instanceof URLSearchParams ? values : new URLSearchParams(values);
  return apiRequest(path, { method: "POST", body: form, ...options });
}

export function uploadForm(path, form, options = {}) {
  return apiRequest(path, { method: "POST", body: form, ...options });
}

export async function postLocalPairingJson(namespace, action, payload = {}) {
  if (!["device-remote", "canvas-pairing"].includes(namespace) || !["sessions", "join"].includes(action)) {
    throw new Error("Invalid local phone connection request.");
  }

  let response;
  try {
    response = await fetch(new URL(`/api/${namespace}/${action}`, window.location.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error("Could not reach the local phone connection. Check that both devices are on the same Wi-Fi and reload this page.", { cause: error });
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(formatApiError(body.detail ?? body.message, response.status));
    error.status = response.status;
    throw error;
  }
  return body;
}

export function isLocalIntranetPage() {
  const page = new URL(window.location.origin);
  if (page.protocol !== "http:" || !["5500", "5501", "8080"].includes(page.port)) return false;
  const host = page.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d+)\./);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
}

export function postPairingJson(namespace, action, payload = {}) {
  if (isLocalIntranetPage()) return postLocalPairingJson(namespace, action, payload);
  if (!["device-remote", "canvas-pairing"].includes(namespace) || !["sessions", "join"].includes(action)) {
    throw new Error("Invalid phone connection request.");
  }
  return postJson(`/api/${namespace}/${action}`, payload);
}

export function pairingWebSocketUrl(namespace, sessionId) {
  if (!["device-remote", "canvas-pairing"].includes(namespace)) throw new Error("Invalid phone connection type.");
  const base = isLocalIntranetPage() ? window.location.origin : API_BASE_URL;
  const url = new URL(`/api/${namespace}/ws/${encodeURIComponent(sessionId)}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
