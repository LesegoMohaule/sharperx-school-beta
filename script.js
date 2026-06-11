const menuButton = document.querySelector("[data-menu-button]");
const nav = document.querySelector("[data-nav]");
const year = document.querySelector("[data-year]");
const API_BASE_URL = window.SHARPERX_API_BASE_URL || "https://api.sharperx.co.za";

if (year) {
  year.textContent = new Date().getFullYear().toString();
}

if (menuButton && nav) {
  menuButton.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    menuButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  nav.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      nav.classList.remove("is-open");
      menuButton.setAttribute("aria-expanded", "false");
    }
  });
}

const registrationForm = document.querySelector("[data-registration-form]");
const registrationStatus = document.querySelector("[data-registration-status]");
const loginForm = document.querySelector("[data-login-form]");
const paymentStatus = document.querySelector("[data-payment-status]");

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
  if (!response.ok) {
    throw new Error(body.detail || `Request failed with HTTP ${response.status}`);
  }
  return body;
}

async function postForm(path, values) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    body: new URLSearchParams(values),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || `Request failed with HTTP ${response.status}`);
  }
  return body;
}

registrationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(registrationForm);
  const payload = {
    full_name: form.get("full_name"),
    email: form.get("email"),
    password: form.get("password"),
    id_number: form.get("id_number"),
    phone_number: form.get("phone_number"),
    address: form.get("address"),
    confirmed_over_18: form.get("confirmed_over_18") === "on",
    popia_consent: form.get("popia_consent") === "on",
    accepted_terms: form.get("accepted_terms") === "on",
    children: [
      {
        full_name: form.get("child_full_name"),
        phone_number: form.get("child_phone_number"),
        grade: Number(form.get("child_grade")),
        school_name: form.get("school_name"),
        registered_service: "school",
      },
    ],
  };

  try {
    setStatus(registrationStatus, "Registering account...");
    const result = await postJson("/api/accounts/guardian/register", payload);
    localStorage.setItem("sharperx_access_token", result.access_token);
    setStatus(registrationStatus, "Registered. You can now buy monthly credits or open the app on the registered phone.", "success");
  } catch (error) {
    setStatus(registrationStatus, error.message, "error");
  }
});

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  try {
    setStatus(paymentStatus, "Logging in...");
    const result = await postForm("/api/auth/login", {
      email: form.get("email"),
      password: form.get("password"),
    });
    localStorage.setItem("sharperx_access_token", result.access_token);
    setStatus(paymentStatus, "Logged in. Choose monthly credits or top-up.", "success");
  } catch (error) {
    setStatus(paymentStatus, error.message, "error");
  }
});

document.querySelectorAll("[data-buy-product]").forEach((button) => {
  button.addEventListener("click", async () => {
    const token = localStorage.getItem("sharperx_access_token");
    if (!token) {
      setStatus(paymentStatus, "Register or login first.", "error");
      return;
    }

    try {
      setStatus(paymentStatus, "Creating secure checkout...");
      const result = await postJson("/api/billing/checkout", {
        product_code: button.getAttribute("data-buy-product"),
      }, token);
      if (result.checkout_url) {
        window.location.href = result.checkout_url;
      } else {
        setStatus(paymentStatus, "Checkout created. Complete payment to add credits.", "success");
      }
    } catch (error) {
      setStatus(paymentStatus, error.message, "error");
    }
  });
});
