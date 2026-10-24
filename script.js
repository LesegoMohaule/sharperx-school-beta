const menuButton = document.querySelector("[data-menu-button]");
const nav = document.querySelector("[data-nav]");
const year = document.querySelector("[data-year]");
const API_BASE_URL = window.SHARPERX_API_BASE_URL || "https://api.46.225.173.118.nip.io";
const pageParams = new URLSearchParams(window.location.search);

if (year) year.textContent = new Date().getFullYear().toString();

if (menuButton && nav) {
  menuButton.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    menuButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      menuButton.setAttribute("aria-expanded", "false");
    });
  });
}

function setupOfficeViewer() {
  const viewers = document.querySelectorAll("[data-office-viewer]");
  const publicPage = ["http:", "https:"].includes(window.location.protocol) &&
    !["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!viewers.length || !publicPage) return;

  viewers.forEach((viewer) => {
    const deckUrl = new URL("assets/media/sharpertime-google-africa-applied-ai-lab-pitch-deck.pptx", window.location.href);
    viewer.src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(deckUrl.href)}`;
    viewer.addEventListener("load", () => viewer.closest(".office-viewer-wrap")?.classList.add("has-preview"), { once: true });
  });
}

function setStatus(element, message, type = "") {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("is-error", type === "error");
  element.classList.toggle("is-success", type === "success");
}

function requestError(response, body) {
  const detail = body?.detail;
  const message = typeof detail === "string"
    ? detail
    : detail?.message || (Array.isArray(detail) ? detail.map((item) => item.msg).join(" ") : `Request failed with HTTP ${response.status}`);
  const error = new Error(message);
  error.status = response.status;
  error.body = body;
  error.retryAfter = Number(response.headers.get("Retry-After") || 0);
  if (response.status === 429 && error.retryAfter > 0) {
    const wait = error.retryAfter < 60
      ? `${error.retryAfter} seconds`
      : `${Math.ceil(error.retryAfter / 60)} minutes`;
    error.message = `${message} Try again in about ${wait}.`;
  }
  return error;
}

function getDeviceId() {
  const storageKey = "sharperx_web_device_id";
  let id = localStorage.getItem(storageKey);
  if (!id) {
    if (window.crypto?.randomUUID) {
      id = window.crypto.randomUUID();
    } else if (window.crypto?.getRandomValues) {
      const random = new Uint8Array(16);
      window.crypto.getRandomValues(random);
      id = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } else {
      id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    localStorage.setItem(storageKey, id);
  }
  return id;
}

let recaptchaScriptPromise = null;

async function getRecaptchaToken(action) {
  const siteKey = window.SHARPERX_RECAPTCHA_SITE_KEY;
  if (!siteKey) return null;

  if (!window.grecaptcha?.execute) {
    recaptchaScriptPromise ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("The registration security check could not load."));
      document.head.append(script);
    });
    await recaptchaScriptPromise;
  }

  await new Promise((resolve) => window.grecaptcha.ready(resolve));
  return window.grecaptcha.execute(siteKey, { action });
}

async function postJson(path, payload, token = null, extraHeaders = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw requestError(response, body);
  return body;
}

async function getJson(path, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw requestError(response, body);
  return body;
}

async function postForm(path, values, accessToken = null) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "X-Device-ID": getDeviceId(),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: new URLSearchParams(values),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw requestError(response, body);
  return body;
}

function token() {
  return localStorage.getItem("sharperx_access_token") || "";
}

function validatePassword(password) {
  return password.length >= 15 && password.length <= 128;
}

function generateStrongPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

document.querySelector("[data-strong-password]")?.addEventListener("click", () => {
  const password = document.querySelector("[name='password']");
  const value = generateStrongPassword();
  if (password) password.value = value;
});

const registrationForm = document.querySelector("[data-registration-form]");
const registrationStatus = document.querySelector("[data-registration-status]");
const otpForm = document.querySelector("[data-otp-form]");
const otpStatus = document.querySelector("[data-otp-status]");

registrationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (registrationForm.dataset.registrationClosed === "true") {
    setStatus(registrationStatus, "SharperTime is launching soon. Registration is not open yet.", "error");
    return;
  }
  const form = new FormData(registrationForm);
  const password = String(form.get("password") || "");
  if (!validatePassword(password)) {
    setStatus(registrationStatus, "Use at least 15 characters. A memorable passphrase is fine.", "error");
    return;
  }
  const payload = {
    name: String(form.get("name") || "").trim(),
    surname: String(form.get("surname") || "").trim(),
    email: String(form.get("email") || "").trim(),
    password,
  };

  try {
    setStatus(registrationStatus, "Creating account...");
    const captchaToken = await getRecaptchaToken("register");
    const result = await postJson(
      "/api/accounts/guardian/register",
      payload,
      null,
      captchaToken ? { "X-Captcha-Token": captchaToken } : {},
    );
    setStatus(registrationStatus, result.email_sent
      ? "Account created. Enter the OTP sent to your email."
      : "Account created, but we could not send the code. Request another code in about a minute, or contact support if email delivery still fails.", result.email_sent ? "success" : "error");
    otpForm?.classList.remove("is-hidden");
    const otpEmail = otpForm?.querySelector("[name='email']");
    if (otpEmail) otpEmail.value = payload.email;
  } catch (error) {
    setStatus(registrationStatus, error.message, "error");
  }
});

otpForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(otpForm);
  try {
    setStatus(otpStatus, "Verifying email...");
    await postJson("/api/auth/email/verify", Object.fromEntries(form.entries()));
    setStatus(otpStatus, "Email verified. You can login now.", "success");
  } catch (error) {
    setStatus(otpStatus, error.message, "error");
  }
});

const verifyEmailForm = document.querySelector("[data-verify-email-form]");
const verifyEmailStatus = document.querySelector("[data-verify-email-status]");
verifyEmailForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(verifyEmailForm);
  try {
    setStatus(verifyEmailStatus, "Verifying email...");
    await postJson("/api/auth/email/verify", Object.fromEntries(form.entries()));
    setStatus(verifyEmailStatus, "Email verified. You can sign in now.", "success");
  } catch (error) {
    setStatus(verifyEmailStatus, error.message, "error");
  }
});

document.querySelectorAll("[data-resend-email-code], [data-resend-otp]").forEach((button) => {
  button.addEventListener("click", async () => {
    const form = button.closest("form");
    const email = form?.querySelector("[name='email']")?.value?.trim();
    const status = form?.querySelector("[data-verify-email-status], [data-otp-status]");
    if (!email) {
      setStatus(status, "Enter your email address first.", "error");
      return;
    }
    try {
      setStatus(status, "Requesting a code...");
      await postJson("/api/auth/email/request-otp", { email });
      setStatus(status, "If this address needs verification, a code has been sent. You can request up to five codes per hour.", "success");
    } catch (error) {
      setStatus(status, error.message, "error");
    }
  });
});

const loginForm = document.querySelector("[data-login-form]");
const loginStatus = document.querySelector("[data-login-status]");
loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  const credentials = {
    email: String(form.get("email") || "").trim(),
    password: form.get("password"),
  };
  const verifyEmail = () => {
    if (!verifyEmailForm) return;
    verifyEmailForm.classList.remove("is-hidden");
    const emailInput = verifyEmailForm.querySelector("[name='email']");
    if (emailInput) emailInput.value = credentials.email;
  };

  const completeLogin = async (takeover) => {
    const result = await postForm("/api/auth/login", {
      ...credentials,
      takeover: takeover ? "true" : "false",
    });
    localStorage.setItem("sharperx_access_token", result.access_token);
    window.location.href = "account.html";
  };

  try {
    setStatus(loginStatus, "Logging in...");
    await completeLogin(false);
  } catch (error) {
    if (error.status === 403 && String(error.message).toLowerCase().includes("verified")) {
      verifyEmail();
    }
    if (error.status === 409 && error.body?.detail?.code === "active_session") {
      const device = error.body.detail.device_label || "another device";
      const shouldReplace = window.confirm(`Your account is active on ${device}. Close that sign-in and continue here?`);
      if (shouldReplace) {
        try {
          setStatus(loginStatus, `Closing the other session and signing in on this device...`);
          await completeLogin(true);
          return;
        } catch (takeoverError) {
          setStatus(loginStatus, takeoverError.message, "error");
          return;
        }
      }
      setStatus(loginStatus, "Sign-in here was canceled. Your other device stays signed in.", "error");
      return;
    }
    setStatus(loginStatus, error.message, "error");
  }
});

const forgotForm = document.querySelector("[data-forgot-form]");
const forgotStatus = document.querySelector("[data-forgot-status]");
document.querySelector("[data-show-forgot]")?.addEventListener("click", () => {
  forgotForm?.classList.toggle("is-hidden");
});
forgotForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(forgotForm);
  try {
    setStatus(forgotStatus, "Sending reset link...");
    await postJson("/api/auth/password/forgot", { email: form.get("email") });
    setStatus(forgotStatus, "If the account exists, a reset link has been sent.", "success");
  } catch (error) {
    setStatus(forgotStatus, error.message, "error");
  }
});

const resetForm = document.querySelector("[data-reset-form]");
const resetStatus = document.querySelector("[data-reset-status]");
if (resetForm && pageParams.get("reset_token")) {
  resetForm.classList.remove("is-hidden");
  window.history.replaceState({}, "", window.location.pathname);
}
resetForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(resetForm);
  try {
    setStatus(resetStatus, "Saving new password...");
    await postJson("/api/auth/password/reset", {
      token: pageParams.get("reset_token"),
      password: form.get("password"),
      confirm_password: form.get("confirm_password"),
    });
    resetForm.reset();
    setStatus(resetStatus, "Password changed. All signed-in devices have been signed out. Log in with your new password.", "success");
  } catch (error) {
    setStatus(resetStatus, error.message, "error");
  }
});

const passwordChangeForm = document.querySelector("[data-password-change-form]");
const passwordChangeStatus = document.querySelector("[data-password-change-status]");
if (passwordChangeForm && token()) passwordChangeForm.classList.remove("is-hidden");
passwordChangeForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(passwordChangeForm);
  const password = String(form.get("password") || "");
  if (!validatePassword(password)) {
    setStatus(passwordChangeStatus, "Use at least 15 characters. A memorable passphrase is fine.", "error");
    return;
  }
  try {
    setStatus(passwordChangeStatus, "Changing password and signing out other devices...");
    await postJson("/api/auth/password/change", {
      current_password: form.get("current_password"),
      password,
      confirm_password: form.get("confirm_password"),
    }, token());
    setStatus(passwordChangeStatus, "Password changed. All devices have been signed out. Returning to sign in...", "success");
    localStorage.removeItem("sharperx_access_token");
    window.setTimeout(() => { window.location.href = "login.html"; }, 1500);
  } catch (error) {
    setStatus(passwordChangeStatus, error.message, "error");
  }
});

async function loadAccountDashboard() {
  const dashboard = document.querySelector("[data-account-dashboard]");
  if (!dashboard) return;
  const accessToken = token();
  if (!accessToken) {
    setStatus(document.querySelector("[data-payment-status]"), "Login first to see your balance.", "error");
    return;
  }
  try {
    const balance = await getJson("/api/accounts/credits", accessToken);
    for (const [key, value] of Object.entries(balance)) {
      const target = document.querySelector(`[data-balance='${key}']`);
      if (!target) continue;
      if (key === "ai_credits_remaining" && balance.credit_exempt) {
        target.textContent = "Unlimited";
      } else if (key === "ai_credits_remaining" && typeof value === "number") {
        target.textContent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
      } else {
        target.textContent = typeof value === "number" ? value.toLocaleString() : String(value ?? "");
      }
    }
  } catch (error) {
    setStatus(document.querySelector("[data-payment-status]"), error.message, "error");
  }
}

function startAccountSessionHeartbeat() {
  if (!document.querySelector("[data-account-dashboard]")) return;
  const accessToken = token();
  if (!accessToken) return;
  const sendHeartbeat = async () => {
    try {
      await postJson("/api/auth/heartbeat", {}, accessToken);
    } catch (error) {
      if (error.status === 401) {
        localStorage.removeItem("sharperx_access_token");
        setStatus(document.querySelector("[data-payment-status]"), "This sign-in session has ended. Please log in again.", "error");
      }
    }
  };
  sendHeartbeat();
  window.setInterval(sendHeartbeat, 30_000);
}

document.querySelectorAll("[data-buy-product]").forEach((button) => {
  button.addEventListener("click", async () => {
    const accessToken = token();
    const status = document.querySelector("[data-payment-status]");
    if (!accessToken) {
      setStatus(status, "Login first.", "error");
      return;
    }
    try {
      setStatus(status, "Creating secure PayFast checkout...");
      const result = await postJson("/api/billing/checkout", {
        product_code: button.getAttribute("data-buy-product"),
      }, accessToken);
      window.location.href = result.checkout_url;
    } catch (error) {
      setStatus(status, error.message, "error");
    }
  });
});

document.querySelector("[data-logout]")?.addEventListener("click", async () => {
  const accessToken = token();
  if (accessToken) {
    try {
      await postJson("/api/auth/logout", {}, accessToken);
    } catch {
      // Always clear this browser's credential, even if the network is unavailable.
    }
  }
  localStorage.removeItem("sharperx_access_token");
  window.location.href = "login.html";
});

const paymentStatus = document.querySelector("[data-payment-status]");
if (pageParams.get("payment") === "success") {
  setStatus(paymentStatus, "Payment received. Access updates after PayFast confirms it.", "success");
} else if (pageParams.get("payment") === "cancelled") {
  setStatus(paymentStatus, "Payment was cancelled.", "error");
} else if (pageParams.get("payment") === "manual") {
  setStatus(paymentStatus, "Manual payment reference created. Contact support if access is not allocated.", "success");
}

loadAccountDashboard();
startAccountSessionHeartbeat();
setupOfficeViewer();
