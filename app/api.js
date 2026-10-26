export const API_BASE_URL = (window.SHARPERX_API_BASE_URL || "https://api.46.225.173.118.nip.io").replace(/\/$/, "");

const TOKEN_KEY = "sharperx_access_token";
const DEVICE_KEY = "sharperx_web_device_id";
let pendingApiCalls = new Map();
let nextApiCallId = 0;
let processingTimer = null;

function processingMessage(path) {
  const route = String(path || "").toLowerCase();
  if (route.includes("speech/transcribe") || route.includes("voice-note")) return "Transcribing your speech…";
  if (route.includes("question-snapshot")) return "Reading the selected question and its diagrams…";
  if (route.includes("/education/tutor/ask")) return "Preparing your response…";
  if (route.includes("/photo/transcribe-math")) return "Reading your handwriting and drawings…";
  if (route.includes("/mark") || route.includes("mark-attempt")) return "Checking your working…";
  if (route.includes("exam") || route.includes("assessment")) return "Preparing your assessment…";
  if (route.includes("/education/")) return "Loading your learning activity…";
  return "Processing your request…";
}

function updateProcessingIndicator() {
  const indicator = document.getElementById("processingIndicator");
  if (!indicator) return;
  if (!pendingApiCalls.size) {
    indicator.hidden = true;
    return;
  }
  const messages = Array.from(pendingApiCalls.values());
  const message = messages[messages.length - 1];
  const label = indicator.querySelector("[data-processing-message]");
  if (label && message) label.textContent = message;
  indicator.hidden = false;
}

function beginApiActivity(path) {
  const id = ++nextApiCallId;
  pendingApiCalls.set(id, processingMessage(path));
  if (!processingTimer) {
    processingTimer = window.setTimeout(() => {
      processingTimer = null;
      updateProcessingIndicator();
    }, 300);
  }
  return () => {
    pendingApiCalls.delete(id);
    if (!pendingApiCalls.size && processingTimer) {
      window.clearTimeout(processingTimer);
      processingTimer = null;
    }
    updateProcessingIndicator();
  };
}

function apiRequestTimeout(path) {
  const route = String(path || "").toLowerCase();
  if (route.includes("/education/tutor/ask")) {
    // Tutor requests use a single bounded generation and self-check pass.
    return 480_000;
  }
  if (route.includes("/photo/transcribe-math")) return 150_000;
  if (route.includes("speech/transcribe") || route.includes("mark-attempt")) {
    return 175_000;
  }
  return 60_000;
}

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

function deviceMetadata() {
  const ua = navigator.userAgent || "";
  if (/(Android\s*(?:TV|tv)|Smart[- ]?TV|Google[- ]?TV|HbbTV|Tizen|Web0S|webOS|BRAVIA|AFT[A-Z0-9]*|NetCast|Viera|Hisense|MiTV|SMART_TV)/i.test(ua)) {
    return { type: "tv", label: /Android/i.test(ua) ? "Android TV" : "Smart TV" };
  }
  if (/(iPhone|iPod|Android.*Mobile|Windows Phone)/i.test(ua)) return { type: "mobile", label: "Phone" };
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile|Mobi/i.test(ua))) return { type: "tablet", label: "Tablet" };
  if (/Macintosh|Mac OS/i.test(ua)) return { type: "desktop", label: "Mac" };
  if (/Windows/i.test(ua)) return { type: "desktop", label: "Windows PC" };
  return { type: "desktop", label: "Computer" };
}

export function getClientDeviceLabel() {
  return deviceMetadata().label;
}

export async function apiRequest(path, options = {}) {
  const { auth = true, deviceTracking = false, responseType = "json", timeoutMs = apiRequestTimeout(path), ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});
  if (auth && getAccessToken()) headers.set("Authorization", `Bearer ${getAccessToken()}`);
  if (auth || deviceTracking) {
    const device = deviceMetadata();
    headers.set("X-Device-ID", deviceId());
    headers.set("X-Device-Type", device.type);
  }
  if (requestOptions.body && !headers.has("Content-Type")) {
    if (requestOptions.body instanceof URLSearchParams) {
      headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (!(requestOptions.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
  }

  const finishActivity = String(path || "").includes("/api/auth/heartbeat")
    ? () => {}
    : beginApiActivity(path);
  const externalSignal = requestOptions.signal;
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => requestController.abort();
  if (externalSignal?.aborted) requestController.abort();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, Math.max(1_000, Number(timeoutMs) || apiRequestTimeout(path)));
  try {
    let response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, { ...requestOptions, headers, signal: requestController.signal });
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error("The server took too long to answer. Your work is still here; try again.", { cause: error });
        timeoutError.status = 408;
        timeoutError.retryable = true;
        throw timeoutError;
      }
      if (externalSignal?.aborted) throw error;
      if (error?.name === "AbortError") throw error;
      const connectionError = new Error("Could not connect to SharperTime. Check the connection and try again.", { cause: error });
      connectionError.retryable = true;
      throw connectionError;
    }

    if (responseType === "blob") {
      if (!response.ok) throw await responseError(response, auth);
      return await response.blob();
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detailMessage = typeof body.detail === "string" ? body.detail : body.detail?.message;
      const error = new Error(response.status === 401 && auth
        ? detailMessage || "Your session has expired. Sign in again."
        : formatApiError(body.detail ?? body.message, response.status));
      error.status = response.status;
      error.data = body;
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (response.status === 401 && auth) {
        setAccessToken("");
        window.dispatchEvent(new CustomEvent("sharperx:auth-expired", { detail: { message: error.message } }));
      }
      throw error;
    }
    const method = String(requestOptions.method || (requestOptions.body ? "POST" : "GET")).toUpperCase();
    if (auth && method !== "GET" && !String(path || "").includes("/api/auth/")) {
      window.dispatchEvent(new Event("sharperx:credits-refresh"));
    }
    return body;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromCaller);
    finishActivity();
  }
}

async function responseError(response, auth = true) {
  const body = await response.clone().json().catch(() => ({}));
  const detailMessage = typeof body.detail === "string" ? body.detail : body.detail?.message;
  const error = new Error(response.status === 401 && auth
    ? detailMessage || "Your session has expired. Sign in again."
    : formatApiError(body.detail ?? body.message, response.status));
  error.status = response.status;
  error.data = body;
  error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (response.status === 401 && auth) {
    setAccessToken("");
    window.dispatchEvent(new CustomEvent("sharperx:auth-expired", { detail: { message: error.message } }));
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
  return /\bserver\b|gpt\s*[- ]?\s*6\s*[- ]?\s*luna|\bluna\b|\bunimernet\b|\bxhigh\b/i.test(String(message))
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
