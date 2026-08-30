const menuButton = document.querySelector("[data-menu-button]");
const nav = document.querySelector("[data-nav]");
const year = document.querySelector("[data-year]");
const API_BASE_URL = window.SHARPERX_API_BASE_URL || "https://api.46.225.173.118.nip.io";
const RECAPTCHA_SITE_KEY = window.SHARPERX_RECAPTCHA_SITE_KEY || "";
const GOOGLE_MAPS_API_KEY = window.SHARPERX_GOOGLE_MAPS_API_KEY || "";
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

async function postJson(path, payload, token = null) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed with HTTP ${response.status}`);
  return body;
}

async function getJson(path, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed with HTTP ${response.status}`);
  return body;
}

async function postForm(path, values) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    body: new URLSearchParams(values),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed with HTTP ${response.status}`);
  return body;
}

function token() {
  return localStorage.getItem("sharperx_access_token") || "";
}

function validatePassword(password) {
  return password.length >= 10 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
}

function generateStrongPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?";
  const required = ["A", "a", "7", "!"];
  const bytes = new Uint32Array(18);
  crypto.getRandomValues(bytes);
  const chars = bytes.map((value) => alphabet[value % alphabet.length]);
  return [...required, ...chars].sort(() => Math.random() - 0.5).join("");
}

document.querySelector("[data-strong-password]")?.addEventListener("click", () => {
  const password = document.querySelector("[name='password']");
  const confirm = document.querySelector("[name='confirm_password']");
  const value = generateStrongPassword();
  if (password) password.value = value;
  if (confirm) confirm.value = value;
});

function captchaResponse() {
  if (!window.grecaptcha || !RECAPTCHA_SITE_KEY) return "";
  return grecaptcha.getResponse();
}

function setupCaptcha() {
  const container = document.querySelector("[data-captcha-container]");
  if (!container) return;
  if (!RECAPTCHA_SITE_KEY) {
    container.textContent = "Captcha site key is not configured yet.";
    container.classList.add("captcha-warning");
    return;
  }
  const script = document.createElement("script");
  script.src = "https://www.google.com/recaptcha/api.js";
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
  const widget = document.createElement("div");
  widget.className = "g-recaptcha";
  widget.dataset.sitekey = RECAPTCHA_SITE_KEY;
  container.appendChild(widget);
}

function setupGoogleAddressAutocomplete() {
  const input = document.querySelector("[data-address-search]");
  if (!input || !GOOGLE_MAPS_API_KEY) return;
  window.initSharperXAddressAutocomplete = () => {
    const autocomplete = new google.maps.places.Autocomplete(input, {
      componentRestrictions: { country: "za" },
      fields: ["address_components", "place_id"],
      types: ["address"],
    });
    autocomplete.addListener("place_changed", () => fillAddressFromPlace(autocomplete.getPlace()));
  };
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&libraries=places&callback=initSharperXAddressAutocomplete`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

function fillAddressFromPlace(place) {
  const components = place.address_components || [];
  const byType = (type, short = false) => {
    const item = components.find((component) => component.types.includes(type));
    return item ? (short ? item.short_name : item.long_name) : "";
  };
  const street = [byType("street_number"), byType("route")].filter(Boolean).join(" ");
  setField("address_line_1", street);
  setField("suburb", byType("sublocality_level_1") || byType("sublocality") || byType("neighborhood"));
  setField("city", byType("locality") || byType("postal_town") || byType("administrative_area_level_2"));
  setField("province", byType("administrative_area_level_1"));
  setField("postal_code", byType("postal_code"));
  setField("country", byType("country"));
  setField("google_place_id", place.place_id || "");
}

function setField(name, value) {
  const field = document.querySelector(`[name='${name}']`);
  if (field && value) field.value = value;
}

const registrationForm = document.querySelector("[data-registration-form]");
const registrationStatus = document.querySelector("[data-registration-status]");
const otpForm = document.querySelector("[data-otp-form]");
const otpStatus = document.querySelector("[data-otp-status]");

registrationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(registrationForm);
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirm_password") || "");
  if (!validatePassword(password)) {
    setStatus(registrationStatus, "Password must be at least 10 characters with uppercase, lowercase, number and symbol.", "error");
    return;
  }
  if (password !== confirmPassword) {
    setStatus(registrationStatus, "Passwords do not match.", "error");
    return;
  }

  const payload = Object.fromEntries(form.entries());
  payload.popia_consent = form.get("popia_consent") === "on";
  payload.accepted_terms = form.get("accepted_terms") === "on";
  payload.marketing_consent = false;
  payload.captcha_token = captchaResponse();

  try {
    setStatus(registrationStatus, "Creating account...");
    const result = await postJson("/api/accounts/guardian/register", payload);
    setStatus(registrationStatus, result.email_sent
      ? "Account created. Enter the OTP sent to your email."
      : "Account created, but server email is not configured. Contact support to verify your email.", result.email_sent ? "success" : "error");
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

const loginForm = document.querySelector("[data-login-form]");
const loginStatus = document.querySelector("[data-login-status]");
loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  try {
    setStatus(loginStatus, "Logging in...");
    const result = await postForm("/api/auth/login", {
      email: form.get("email"),
      password: form.get("password"),
    });
    localStorage.setItem("sharperx_access_token", result.access_token);
    window.location.href = "account.html";
  } catch (error) {
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
if (resetForm && pageParams.get("reset_token")) resetForm.classList.remove("is-hidden");
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
    setStatus(resetStatus, "Password changed. Login with your new password.", "success");
  } catch (error) {
    setStatus(resetStatus, error.message, "error");
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
      if (target) target.textContent = typeof value === "number" ? value.toLocaleString() : String(value ?? "");
    }
  } catch (error) {
    setStatus(document.querySelector("[data-payment-status]"), error.message, "error");
  }
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

document.querySelector("[data-logout]")?.addEventListener("click", () => {
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

setupCaptcha();
setupGoogleAddressAutocomplete();
loadAccountDashboard();
setupOfficeViewer();
