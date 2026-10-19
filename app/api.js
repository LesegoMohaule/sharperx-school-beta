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
    id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export async function apiRequest(path, options = {}) {
  const { auth = true, responseType = "json", ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});
  if (auth && getAccessToken()) headers.set("Authorization", `Bearer ${getAccessToken()}`);
  if (auth) headers.set("X-Device-ID", deviceId());
  if (requestOptions.body && !(requestOptions.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...requestOptions, headers });
  } catch (error) {
    throw new Error("Could not reach the SharperTime server. Check your connection and try again.", { cause: error });
  }

  if (responseType === "blob") {
    if (!response.ok) throw await responseError(response);
    return response.blob();
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && auth) setAccessToken("");
    throw new Error(body.detail || body.message || `Request failed with HTTP ${response.status}`);
  }
  return body;
}

async function responseError(response) {
  const body = await response.clone().json().catch(() => ({}));
  return new Error(body.detail || body.message || `Request failed with HTTP ${response.status}`);
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
