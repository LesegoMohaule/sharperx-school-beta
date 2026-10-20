import { API_BASE_URL, getAccessToken, postJson } from "./api.js?v=15";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#phoneCanvas");
const context = canvas.getContext("2d");
let socket = null;
let pairSession = null;
let strokes = [];
let activeStroke = null;
let pendingPoints = [];
let pointerId = null;
let flushFrame = 0;
let localFrame = { width: 0, height: 0 };
let hostConnected = false;
let submittedToAnswer = false;
let heartbeat = 0;

function setPairStatus(message, kind = "") {
  const status = $("#phonePairStatus");
  status.textContent = message || "";
  status.classList.toggle("is-error", kind === "error");
  status.classList.toggle("is-success", kind === "success");
}

function setCanvasStatus(message, kind = "") {
  const status = $("#phoneCanvasConnectionStatus");
  status.textContent = message || "";
  status.style.color = kind === "error" ? "var(--error)" : kind === "success" ? "var(--teal-dark)" : "var(--ink-soft)";
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function clampedPoint(point) {
  const x = Math.max(0, Math.min(1, Number(point.x) || 0));
  const y = Math.max(0, Math.min(1, Number(point.y) || 0));
  return { x: Math.round(x * 10_000) / 10_000, y: Math.round(y * 10_000) / 10_000 };
}

function pointerPoint(event, frame = localFrame) {
  const rect = canvas.getBoundingClientRect();
  return clampedPoint({ x: (event.clientX - rect.left) / Math.max(1, frame.width), y: (event.clientY - rect.top) / Math.max(1, frame.height) });
}

function fitFor(frame, width, height) {
  const scale = Math.min(width / Math.max(1, frame.width), height / Math.max(1, frame.height));
  return { scale, x: (width - frame.width * scale) / 2, y: (height - frame.height * scale) / 2 };
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  localFrame = { width: rect.width, height: rect.height };
  drawCanvas();
}

function drawCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, rect.width, rect.height);
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const frame = stroke.frame || localFrame;
    const fit = fitFor(frame, rect.width, rect.height);
    context.beginPath();
    context.strokeStyle = stroke.color || "#162a29";
    context.lineWidth = Math.max(1, (stroke.width || 2.2) * fit.scale);
    context.lineCap = "round";
    context.lineJoin = "round";
    const first = stroke.points[0];
    context.moveTo(fit.x + first.x * frame.width * fit.scale, fit.y + first.y * frame.height * fit.scale);
    for (const point of stroke.points.slice(1)) context.lineTo(fit.x + point.x * frame.width * fit.scale, fit.y + point.y * frame.height * fit.scale);
    if (stroke.points.length === 1) context.lineTo(fit.x + first.x * frame.width * fit.scale + .1, fit.y + first.y * frame.height * fit.scale + .1);
    context.stroke();
  }
}

function flushPoints() {
  flushFrame = 0;
  if (!activeStroke || !pendingPoints.length) return;
  const points = pendingPoints;
  pendingPoints = [];
  send({ type: "stroke_points", id: activeStroke.id, frame: activeStroke.frame, points });
}

function queuePoint(point) {
  if (!activeStroke) return;
  activeStroke.points.push(point);
  pendingPoints.push(point);
  if (!flushFrame) flushFrame = requestAnimationFrame(flushPoints);
  drawCanvas();
}

function finishStroke() {
  if (!activeStroke) return;
  if (flushFrame) cancelAnimationFrame(flushFrame);
  flushPoints();
  send({ type: "stroke_end", id: activeStroke.id });
  activeStroke = null;
  pointerId = null;
  $("#phoneCanvasSubmit").disabled = strokes.length === 0 || !hostConnected;
}

canvas.addEventListener("pointerdown", (event) => {
  if (!hostConnected || event.button !== 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  const rect = canvas.getBoundingClientRect();
  const frame = { width: rect.width, height: rect.height };
  const point = pointerPoint(event, frame);
  activeStroke = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    frame,
    points: [point],
    width: event.pointerType === "pen" ? 2.5 : 2.2,
    color: "#162a29",
  };
  pointerId = event.pointerId;
  strokes.push(activeStroke);
  send({ type: "stroke_start", id: activeStroke.id, frame, point, width: activeStroke.width });
  $("#phoneCanvasSubmit").disabled = false;
  drawCanvas();
});

canvas.addEventListener("pointermove", (event) => {
  if (!activeStroke || event.pointerId !== pointerId) return;
  event.preventDefault();
  const events = event.getCoalescedEvents?.() || [event];
  for (const item of events) queuePoint(pointerPoint(item, activeStroke.frame));
});

["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => canvas.addEventListener(type, finishStroke));

function connectSocket(session) {
  const socketUrl = new URL(`${API_BASE_URL}/api/canvas-pairing/ws/${encodeURIComponent(session.session_id)}`);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("role", "phone");
  socket = new WebSocket(socketUrl);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "authenticate", token: session.phone_token }));
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send({ type: "ping" }), 30_000);
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "authenticated") {
      $("#pairScreen").hidden = true;
      $("#phoneCanvasWorkspace").hidden = false;
      hostConnected = false;
      setCanvasStatus("Waiting for the computer canvas…");
      $("#phoneCanvasSubmit").disabled = true;
      resizeCanvas();
    } else if (message.type === "host_connected") {
      hostConnected = true;
      setCanvasStatus("Connected — draw here to update your computer", "success");
      $("#phoneCanvasSubmit").disabled = strokes.length === 0;
    } else if (message.type === "setup") {
      if ("title" in message || "question" in message) {
        $("#phoneCanvasQuestion").textContent = [message.title, message.question].filter(Boolean).join("\n\n");
      }
      if (Array.isArray(message.strokes)) {
        strokes = message.strokes.map((stroke) => ({
          id: String(stroke.id || ""),
          frame: { width: Number(stroke.frame?.width) || localFrame.width, height: Number(stroke.frame?.height) || localFrame.height },
          width: Number(stroke.width) || 2.2,
          color: stroke.color || "#162a29",
          points: Array.isArray(stroke.points) ? stroke.points.map((point) => clampedPoint(point)) : [],
        }));
        drawCanvas();
        $("#phoneCanvasSubmit").disabled = strokes.length === 0 || !hostConnected;
      }
    } else if (message.type === "host_disconnected" || message.type === "session_closed") {
      if (submittedToAnswer) {
        if (message.type === "session_closed") socket.close();
        return;
      }
      hostConnected = false;
      $("#phoneCanvasSubmit").disabled = true;
      setCanvasStatus("Computer disconnected. Reopen the connection on the computer.", "error");
      if (message.type === "session_closed") socket.close();
    } else if (message.type === "submitted") {
      submittedToAnswer = true;
      hostConnected = false;
      $("#phoneCanvasSubmit").disabled = true;
      setCanvasStatus("Canvas submitted to your answer.", "success");
      $("#phoneCanvasHelp").textContent = "Your writing has been attached to the question on your computer.";
    } else if (message.type === "submission_error") {
      hostConnected = true;
      $("#phoneCanvasSubmit").disabled = strokes.length === 0;
      setCanvasStatus(message.message || "Canvas could not be submitted. Try again.", "error");
    }
  });
  socket.addEventListener("close", () => {
    clearInterval(heartbeat);
    heartbeat = 0;
    hostConnected = false;
    if (!$("#phoneCanvasWorkspace").hidden && !submittedToAnswer) {
      $("#phoneCanvasSubmit").disabled = true;
      setCanvasStatus("Connection ended. Your phone drawing is still on this screen.", "error");
    }
  });
  socket.addEventListener("error", () => setPairStatus("Could not connect to the computer. Check your internet connection and try again.", "error"));
}

async function connectPhone(event) {
  event?.preventDefault();
  const code = $("#phonePairCode").value.replace(/\D/g, "").slice(0, 6);
  if (code.length !== 6) return setPairStatus("Enter the six-digit code shown on your computer.", "error");
  if (!getAccessToken()) {
    $("#phoneSignInLink").target = "_blank";
    return setPairStatus("Sign in to your SharperTime account on this phone, then tap Connect phone again.", "error");
  }
  submittedToAnswer = false;
  const button = $("#phonePairForm button[type='submit']");
  button.disabled = true;
  setPairStatus("Connecting…");
  try {
    const joinRequest = pairSession?.session_id ? { code, session_id: pairSession.session_id } : { code };
    const joined = await postJson("/api/canvas-pairing/join", joinRequest);
    pairSession = joined;
    sessionStorage.setItem("sharperx_phone_canvas_session", JSON.stringify({ ...joined, code }));
    connectSocket(joined);
  } catch (error) {
    setPairStatus(error.message || "Could not connect to the computer. Check the code and try again.", "error");
  } finally {
    button.disabled = false;
  }
}

$("#phonePairForm").addEventListener("submit", connectPhone);
$("#phoneCanvasUndo").addEventListener("click", () => {
  if (activeStroke) finishStroke();
  const removed = strokes.pop();
  if (removed) send({ type: "undo", id: removed.id });
  drawCanvas();
  $("#phoneCanvasSubmit").disabled = strokes.length === 0 || !hostConnected;
});
$("#phoneCanvasClear").addEventListener("click", () => {
  if (activeStroke) finishStroke();
  strokes = [];
  send({ type: "clear" });
  drawCanvas();
  $("#phoneCanvasSubmit").disabled = true;
});
$("#phoneCanvasSubmit").addEventListener("click", () => {
  if (!strokes.length || !hostConnected) return;
  $("#phoneCanvasSubmit").disabled = true;
  setCanvasStatus("Submitting your canvas…");
  if (!send({ type: "submit" })) {
    $("#phoneCanvasSubmit").disabled = false;
    setCanvasStatus("Connection ended. Reconnect from your computer to submit this canvas.", "error");
  }
});
$("#phoneCanvasDisconnect").addEventListener("click", () => {
  clearInterval(heartbeat);
  heartbeat = 0;
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  sessionStorage.removeItem("sharperx_phone_canvas_session");
  pairSession = null;
  strokes = [];
  activeStroke = null;
  $("#phoneCanvasWorkspace").hidden = true;
  $("#pairScreen").hidden = false;
  setPairStatus("Disconnected. Enter a new code to connect again.");
});

const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const scannedCode = fragment.get("code") || "";
const scannedSessionId = fragment.get("session_id") || "";
history.replaceState(null, "", location.pathname + location.search);
if (scannedCode) {
  $("#phonePairCode").value = scannedCode.replace(/\D/g, "").slice(0, 6);
  pairSession = scannedSessionId ? { session_id: scannedSessionId } : null;
  connectPhone(new Event("submit", { cancelable: true }));
} else {
  try {
    const saved = JSON.parse(sessionStorage.getItem("sharperx_phone_canvas_session") || "null");
    if (saved?.phone_token && saved?.session_id) {
      pairSession = saved;
      $("#phonePairCode").value = saved.code || "";
      strokes = [];
      connectSocket(saved);
    }
  } catch { sessionStorage.removeItem("sharperx_phone_canvas_session"); }
}

new ResizeObserver(resizeCanvas).observe($(".phone-canvas-wrap"));
window.addEventListener("resize", resizeCanvas, { passive: true });
