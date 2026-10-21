import { getAccessToken, postForm, postPairingJson, pairingWebSocketUrl, isLocalIntranetPage, setAccessToken } from "./api.js?v=18";

const $ = (selector, root = document) => root.querySelector(selector);
let session = null;
let socket = null;
let heartbeat = 0;
let activePointerId = null;
let lastPadPoint = null;
const padPointers = new Map();
let padGestureMode = "";
let pinchLastDistance = 0;
let panEnabled = false;
let pinchZoomEnabled = false;
let keyboardMode = "letters";
let remoteBuffer = "";
let hostFocused = false;

function setPairStatus(message, kind = "") {
  const status = $("#remotePairStatus");
  status.textContent = message || "";
  status.classList.toggle("is-error", kind === "error");
  status.classList.toggle("is-success", kind === "success");
}

function setConnectionStatus(message, kind = "") {
  const status = $("#remoteConnectionStatus");
  status.textContent = message || "";
  status.classList.toggle("is-error", kind === "error");
  status.classList.toggle("is-success", kind === "success");
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function setMode(mode) {
  const keyboard = mode === "keyboard";
  $("#remoteKeyboard").hidden = !keyboard;
  $("#remoteTouchpad").hidden = keyboard;
  $("#remoteTouchpadMode").setAttribute("aria-pressed", String(!keyboard));
  $("#remoteKeyboardMode").setAttribute("aria-pressed", String(keyboard));
  if (keyboard) renderKeyboard();
}

function renderKeyboard() {
  const host = $("#remoteKeyboardKeys");
  host.replaceChildren();
  const rows = keyboardMode === "letters"
    ? ["qwertyuiop", "asdfghjkl", "⇧zxcvbnm⌫"]
    : ["1234567890", "+−×÷=()", "π∞√^%.,⌫"];
  rows.forEach((row) => {
    const element = document.createElement("div");
    element.className = "remote-key-row";
    [...row].forEach((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "remote-key" + (["⇧", "⌫"].includes(value) ? " wide" : "");
      button.textContent = value;
      button.setAttribute("aria-label", value === "⌫" ? "Backspace" : value === "⇧" ? "Show numbers and maths symbols" : value);
      button.addEventListener("click", () => {
        if (value === "⇧") {
          keyboardMode = "symbols";
          renderKeyboard();
          return;
        }
        if (value === "⌫") {
          send({ type: "key", key: "Backspace" });
          remoteBuffer = remoteBuffer.slice(0, -1);
          updateBuffer();
          return;
        }
        typeText(value);
      });
      element.append(button);
    });
    host.append(element);
  });

  const controls = document.createElement("div");
  controls.className = "remote-key-row";
  const modeButton = document.createElement("button");
  modeButton.type = "button";
  modeButton.className = "remote-key wide";
  modeButton.textContent = keyboardMode === "letters" ? "123 / maths" : "ABC";
  modeButton.addEventListener("click", () => {
    keyboardMode = keyboardMode === "letters" ? "symbols" : "letters";
    renderKeyboard();
  });
  const space = document.createElement("button");
  space.type = "button";
  space.className = "remote-key space";
  space.textContent = "Space";
  space.addEventListener("click", () => typeText(" "));
  const minus = document.createElement("button");
  minus.type = "button";
  minus.className = "remote-key wide";
  minus.textContent = "−";
  minus.addEventListener("click", () => typeText("−"));
  controls.append(modeButton, space, minus);
  host.append(controls);
}

function updateBuffer() {
  const input = $("#remoteTextBuffer");
  input.value = remoteBuffer;
  input.scrollTop = input.scrollHeight;
}

function typeText(value) {
  if (!hostFocused || !value) return;
  if (send({ type: "text", action: "insert", value: String(value).slice(0, 200) })) {
    remoteBuffer += value;
    updateBuffer();
  }
}

function handleRemoteMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "authenticated") {
    setConnectionStatus("Connected to SharperTime.", "success");
    return;
  }
  if (message.type === "host_connected") {
    $("#remotePairScreen").hidden = true;
    $("#remoteWorkspace").hidden = false;
    setConnectionStatus("Connected. Select an editor on the TV or use the touchpad.", "success");
    return;
  }
  if (message.type === "host_disconnected") {
    setConnectionStatus("The TV page disconnected. Reopen the pairing code to reconnect.", "error");
    return;
  }
  if (message.type === "canvas_link") {
    try {
      const canvasUrl = new URL(String(message.href || ""), location.href);
      const expectedPath = new URL("./canvas-remote.html", location.href).pathname;
      if (canvasUrl.origin !== location.origin || canvasUrl.pathname !== expectedPath) throw new Error("Invalid canvas link");
      $("#remoteCanvasOpen").href = canvasUrl.href;
      $("#remoteCanvasOpen").hidden = false;
      $("#remoteCanvasStatus").textContent = "Canvas ready. Open it here to write or draw; your work will appear on the TV for submission.";
    } catch {
      $("#remoteCanvasStatus").textContent = "Could not open the canvas link. Start phone canvas again from the TV.";
    }
    return;
  }
  if (message.type === "canvas_unavailable") {
    $("#remoteCanvasOpen").hidden = true;
    $("#remoteCanvasStatus").textContent = "The TV canvas has closed. Open another canvas on the TV when you are ready.";
    return;
  }
  if (message.type === "session_closed") {
    disconnect(false);
    setPairStatus("This remote connection has ended. Scan a new code to connect again.", "error");
    return;
  }
  if (message.type === "focus") {
    hostFocused = Boolean(message.keyboard);
    remoteBuffer = String(message.value || "");
    updateBuffer();
    if (hostFocused) {
      $("#remoteKeyboardHelp").textContent = `Keyboard ready for ${message.label || "the selected editor"}.`;
      setMode("keyboard");
    } else {
      $("#remoteKeyboardHelp").textContent = message.label ? `${message.label} is selected. Choose a text or maths editor to type.` : "Select a text field or maths editor on the TV to begin.";
      setMode("touchpad");
    }
  }
}

function connectSocket(nextSession) {
  clearInterval(heartbeat);
  const url = pairingWebSocketUrl("device-remote", nextSession.session_id);
  url.searchParams.set("role", "phone");
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "authenticate", token: nextSession.phone_token }));
    heartbeat = setInterval(() => send({ type: "ping" }), 30_000);
  });
  socket.addEventListener("message", (event) => {
    try { handleRemoteMessage(JSON.parse(event.data)); } catch { /* Ignore malformed updates. */ }
  });
  socket.addEventListener("close", () => {
    clearInterval(heartbeat);
    heartbeat = 0;
    if (!$("#remoteWorkspace").hidden) setConnectionStatus("Connection ended. Scan a fresh code to reconnect.", "error");
  });
  socket.addEventListener("error", () => setConnectionStatus("Could not connect. Check the Wi-Fi connection and try again.", "error"));
}

async function connectRemote(event) {
  event?.preventDefault();
  const code = $("#remotePairCode").value.replace(/\D/g, "").slice(0, 6);
  if (code.length !== 6) return setPairStatus("Enter the six-digit code shown on the TV.", "error");
  if (!isLocalIntranetPage() && !getAccessToken()) {
    $("#remoteSignInForm").hidden = false;
    return setPairStatus("Sign in with the same SharperTime account used on the TV.");
  }
  const button = $("#remotePairForm button[type='submit']");
  button.disabled = true;
  setPairStatus("Connecting to SharperTime…");
  try {
    const joined = await postPairingJson("device-remote", "join", {
      code,
      ...(session?.session_id ? { session_id: session.session_id } : {}),
    });
    session = { ...joined, code };
    sessionStorage.setItem("sharperx_phone_remote_session", JSON.stringify(session));
    $("#remotePairScreen").hidden = true;
    $("#remoteWorkspace").hidden = false;
    setConnectionStatus("Joining the TV page…");
    connectSocket(session);
  } catch (error) {
    if (!isLocalIntranetPage() && !getAccessToken()) {
      $("#remoteSignInForm").hidden = false;
      setPairStatus("Your sign-in has expired. Sign in to continue.", "error");
    } else setPairStatus(error.message || "Could not connect. Check the code and try again.", "error");
  } finally {
    button.disabled = false;
  }
}

$("#remoteSignInForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  const values = new FormData(form);
  button.disabled = true;
  setPairStatus("Signing in…");
  try {
    const result = await postForm("/api/auth/login", {
      email: String(values.get("email") || "").trim(),
      password: String(values.get("password") || ""),
    }, { auth: false });
    if (!result.access_token) throw new Error("Sign-in could not be completed.");
    setAccessToken(result.access_token);
    form.reset();
    form.hidden = true;
    setPairStatus("Signed in. Connecting to SharperTime…");
    await connectRemote(new Event("submit", { cancelable: true }));
  } catch (error) {
    setPairStatus(error.message || "Sign-in could not be completed.", "error");
  } finally {
    button.disabled = false;
  }
});

function disconnect(closeSocket = true) {
  clearInterval(heartbeat);
  heartbeat = 0;
  if (closeSocket && socket?.readyState === WebSocket.OPEN) socket.close();
  socket = null;
  session = null;
  hostFocused = false;
  sessionStorage.removeItem("sharperx_phone_remote_session");
  $("#remoteWorkspace").hidden = true;
  $("#remotePairScreen").hidden = false;
  $("#remotePairForm").hidden = false;
}

function sendKey(key) {
  if (!hostFocused) return;
  send({ type: "key", key });
  if (key === "Enter") remoteBuffer += "\n";
  else if (key === "Backspace") remoteBuffer = remoteBuffer.slice(0, -1);
  updateBuffer();
}

$("#remotePairForm").addEventListener("submit", connectRemote);
$("#remoteTouchpadMode").addEventListener("click", () => setMode("touchpad"));
$("#remoteKeyboardMode").addEventListener("click", () => setMode("keyboard"));
$("#remoteDisconnect").addEventListener("click", () => {
  send({ type: "key", key: "Disconnect" });
  disconnect();
  setPairStatus("Disconnected. Scan the TV code again to reconnect.");
});
$("#remoteStartCanvas").addEventListener("click", () => {
  if (!send({ type: "key", key: "OpenCanvas" })) {
    $("#remoteCanvasStatus").textContent = "The TV is disconnected. Reconnect the phone remote and try again.";
    return;
  }
  $("#remoteCanvasStatus").textContent = "Opening the TV canvas and preparing the phone connection…";
});
$("#remoteLeftClick").addEventListener("click", () => send({ type: "pointer", action: "click", button: 0 }));
$("#remoteRightClick").addEventListener("click", () => send({ type: "pointer", action: "click", button: 2 }));
$("#remoteScrollUp").addEventListener("click", () => send({ type: "pointer", action: "scroll", deltaY: -560 }));
$("#remoteScrollDown").addEventListener("click", () => send({ type: "pointer", action: "scroll", deltaY: 560 }));
$("#remotePanToggle").addEventListener("click", (event) => {
  panEnabled = !panEnabled;
  event.currentTarget.setAttribute("aria-pressed", String(panEnabled));
  event.currentTarget.setAttribute("aria-label", panEnabled ? "Disable pan mode" : "Enable pan mode");
  $("#remotePanLabel").textContent = panEnabled ? "Pan on" : "Pan off";
  updatePadHint();
  cancelPadGesture();
});
$("#remoteZoomToggle").addEventListener("click", (event) => {
  pinchZoomEnabled = !pinchZoomEnabled;
  event.currentTarget.setAttribute("aria-pressed", String(pinchZoomEnabled));
  event.currentTarget.setAttribute("aria-label", pinchZoomEnabled ? "Disable pinch zoom" : "Enable pinch zoom");
  $("#remoteZoomLabel").textContent = pinchZoomEnabled ? "Pinch zoom on" : "Pinch zoom off";
  updatePadHint();
  cancelPadGesture();
});
$("#remoteKeyboardKeys").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remote-key]");
  if (button) sendKey(button.dataset.remoteKey);
});
document.querySelectorAll("[data-remote-key]").forEach((button) => button.addEventListener("click", () => sendKey(button.dataset.remoteKey)));

const pad = $("#remotePad");
function updatePadHint() {
  const hint = panEnabled ? "Drag to pan the screen" : pinchZoomEnabled ? "Touch to point · pinch to zoom" : "Touch and move to point";
  $("#remotePad").textContent = hint;
  $("#remotePad").setAttribute("aria-label", hint);
}

function pointFromEvent(event) {
  const rect = pad.getBoundingClientRect();
  return { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, pointerType: event.pointerType };
}

function pointerDistance(points) {
  const pair = [...points.values()].slice(0, 2);
  return pair.length < 2 ? 0 : Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
}

function pointerMidpoint(points) {
  const pair = [...points.values()].slice(0, 2);
  if (pair.length < 2) return pair[0] || null;
  return { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2, width: pair[0].width, height: pair[0].height };
}

function cancelPadGesture() {
  if (padGestureMode === "pointer" && activePointerId !== null) send({ type: "pointer", action: "cancel" });
  activePointerId = null;
  lastPadPoint = null;
  pinchLastDistance = 0;
  padGestureMode = "";
  padPointers.clear();
  pad.classList.remove("is-down");
}

pad.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const point = pointFromEvent(event);
  padPointers.set(event.pointerId, point);
  pad.setPointerCapture(event.pointerId);
  pad.classList.add("is-down");
  if (padPointers.size === 1) {
    if (panEnabled) {
      padGestureMode = "pan";
      lastPadPoint = point;
    } else {
      padGestureMode = "pointer";
      activePointerId = event.pointerId;
      lastPadPoint = point;
      send({ type: "pointer", action: "down" });
    }
    return;
  }

  const nonMousePointers = [...padPointers.values()].every((item) => item.pointerType !== "mouse");
  if (pinchZoomEnabled && nonMousePointers) {
    if (padGestureMode === "pointer" && activePointerId !== null) send({ type: "pointer", action: "cancel" });
    activePointerId = null;
    padGestureMode = "zoom";
    pinchLastDistance = pointerDistance(padPointers);
    lastPadPoint = null;
  } else if (panEnabled) {
    if (padGestureMode === "pointer" && activePointerId !== null) send({ type: "pointer", action: "cancel" });
    activePointerId = null;
    padGestureMode = "pan";
    lastPadPoint = pointerMidpoint(padPointers);
  }
});
pad.addEventListener("pointermove", (event) => {
  if (!padPointers.has(event.pointerId)) return;
  event.preventDefault();
  padPointers.set(event.pointerId, pointFromEvent(event));
  if (padGestureMode === "zoom" && padPointers.size >= 2) {
    const distance = pointerDistance(padPointers);
    if (pinchLastDistance > 0 && distance > 0) {
      const factor = distance / pinchLastDistance;
      if (Math.abs(factor - 1) >= 0.012) send({ type: "pointer", action: "zoom", factor: Math.max(0.75, Math.min(1.35, factor)) });
    }
    pinchLastDistance = distance;
    return;
  }

  if (padGestureMode === "pan") {
    const point = padPointers.size >= 2 ? pointerMidpoint(padPointers) : padPointers.get(event.pointerId);
    if (!lastPadPoint) lastPadPoint = point;
    const dx = (point.x - lastPadPoint.x) / Math.max(1, lastPadPoint.width);
    const dy = (point.y - lastPadPoint.y) / Math.max(1, lastPadPoint.height);
    lastPadPoint = point;
    if (dx || dy) send({ type: "pointer", action: "pan", dx, dy });
    return;
  }

  if (padGestureMode === "pointer" && activePointerId === event.pointerId && lastPadPoint) {
    const dx = (event.clientX - lastPadPoint.x) / Math.max(1, lastPadPoint.width);
    const dy = (event.clientY - lastPadPoint.y) / Math.max(1, lastPadPoint.height);
    lastPadPoint = pointFromEvent(event);
    send({ type: "pointer", action: "move", dx, dy });
  }
});
function finishPadPointer(event) {
  if (!padPointers.has(event.pointerId)) return;
  padPointers.delete(event.pointerId);
  if (padGestureMode === "pointer" && activePointerId === event.pointerId) send({ type: "pointer", action: "up" });
  if (padGestureMode === "zoom") {
    pinchLastDistance = padPointers.size >= 2 ? pointerDistance(padPointers) : 0;
  } else if (padGestureMode === "pan" && padPointers.size) {
    lastPadPoint = padPointers.size >= 2 ? pointerMidpoint(padPointers) : [...padPointers.values()][0];
  }
  if (!padPointers.size) {
    activePointerId = null;
    lastPadPoint = null;
    pinchLastDistance = 0;
    padGestureMode = "";
    pad.classList.remove("is-down");
  }
}
pad.addEventListener("pointerup", finishPadPointer);
pad.addEventListener("pointercancel", finishPadPointer);

const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const scannedCode = (fragment.get("code") || "").replace(/\D/g, "").slice(0, 6);
const scannedSessionId = fragment.get("session_id") || "";
history.replaceState(null, "", location.pathname + location.search);
if (!isLocalIntranetPage() && !getAccessToken()) $("#remoteSignInForm").hidden = false;
if (scannedCode) {
  $("#remotePairCode").value = scannedCode;
  session = scannedSessionId ? { session_id: scannedSessionId } : null;
  connectRemote(new Event("submit", { cancelable: true }));
} else {
  try {
    const saved = JSON.parse(sessionStorage.getItem("sharperx_phone_remote_session") || "null");
    if (saved?.phone_token && saved?.session_id) {
      session = saved;
      connectSocket(saved);
      $("#remotePairScreen").hidden = true;
      $("#remoteWorkspace").hidden = false;
    }
  } catch { sessionStorage.removeItem("sharperx_phone_remote_session"); }
}

renderKeyboard();
