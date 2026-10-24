import { API_BASE_URL, getAccessToken, postForm, postPairingJson, pairingWebSocketUrl, isLocalIntranetPage, setAccessToken } from "./api.js?v=24";
import { renderTextbookMath } from "./math-display.js";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#phoneCanvas");
const context = canvas.getContext("2d");
const minimap = $("#phoneCanvasMinimap");
const minimapContext = minimap.getContext("2d");
let socket = null;
let pairSession = null;
let strokes = [];
let activeStroke = null;
let pendingPoints = [];
let pointerId = null;
let pointers = new Map();
let panMode = false;
let zoomMode = false;
let eraserMode = false;
let panDrag = null;
let pinch = null;
let view = { scale: 1, offsetX: 0, offsetY: 0 };
let flushFrame = 0;
let localFrame = { width: 0, height: 0 };
let hostConnected = false;
let hostInputEnabled = false;
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
  status.style.color = kind === "error" ? "var(--error)" : kind === "success" ? "var(--brand-navy)" : "var(--ink-soft)";
}

function updateCanvasControls() {
  const canEdit = hostConnected && hostInputEnabled && !submittedToAnswer;
  ["#phoneCanvasUndo", "#phoneCanvasClear", "#phoneCanvasEraser", "#phoneCanvasPan", "#phoneCanvasZoomToggle", "#phoneCanvasFit"]
    .forEach((selector) => { $(selector).disabled = !canEdit; });
  $("#phoneCanvasSubmit").hidden = !hostInputEnabled;
  $("#phoneCanvasSubmit").disabled = !canEdit || strokes.length === 0;
}

function setPhoneSignInVisible(visible) {
  $("#phoneSignInPrompt").hidden = !visible;
  $("#phoneSignInForm").hidden = !visible;
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function canvasPoint(point) {
  const rawX = Number(point?.x);
  const rawY = Number(point?.y);
  const x = Number.isFinite(rawX) ? rawX : 0;
  const y = Number.isFinite(rawY) ? rawY : 0;
  return { x, y };
}

function pointerPoint(event, frame = localFrame) {
  const rect = canvas.getBoundingClientRect();
  const baseX = (event.clientX - rect.left - rect.width / 2 - view.offsetX) / view.scale + rect.width / 2;
  const baseY = (event.clientY - rect.top - rect.height / 2 - view.offsetY) / view.scale + rect.height / 2;
  const fit = fitFor(frame, rect.width, rect.height);
  return canvasPoint({
    x: (baseX - fit.x) / Math.max(1, frame.width * fit.scale),
    y: (baseY - fit.y) / Math.max(1, frame.height * fit.scale),
  });
}

function fitFor(frame, width, height) {
  const scale = Math.min(width / Math.max(1, frame.width), height / Math.max(1, frame.height));
  return { scale, x: (width - frame.width * scale) / 2, y: (height - frame.height * scale) / 2 };
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const pixelWidth = Math.round(rect.width * ratio);
  const pixelHeight = Math.round(rect.height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  localFrame = { width: rect.width, height: rect.height };
  drawCanvas();
}

function strokeCanvasPoint(stroke, point, width, height) {
  const frame = stroke.frame || localFrame;
  const fit = fitFor(frame, width, height);
  return {
    x: fit.x + point.x * frame.width * fit.scale,
    y: fit.y + point.y * frame.height * fit.scale,
    scale: fit.scale,
  };
}

function drawCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, rect.width, rect.height);
  context.save();
  context.translate(rect.width / 2 + view.offsetX, rect.height / 2 + view.offsetY);
  context.scale(view.scale, view.scale);
  context.translate(-rect.width / 2, -rect.height / 2);
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const first = strokeCanvasPoint(stroke, stroke.points[0], rect.width, rect.height);
    context.beginPath();
    context.strokeStyle = stroke.tool === "eraser" ? "#fff" : (stroke.color || "#132a45");
    context.lineWidth = Math.max(1, (stroke.width || (stroke.tool === "eraser" ? 24 : 2.2)) * first.scale);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.moveTo(first.x, first.y);
    for (const point of stroke.points.slice(1)) {
      const mapped = strokeCanvasPoint(stroke, point, rect.width, rect.height);
      context.lineTo(mapped.x, mapped.y);
    }
    if (stroke.points.length === 1) context.lineTo(first.x + .1, first.y + .1);
    context.stroke();
  }
  context.restore();
  drawMinimap(rect);
}

function drawMinimap(canvasRect) {
  const rect = minimap.getBoundingClientRect();
  if (!rect.width || !rect.height || !minimapContext) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const pixelWidth = Math.round(rect.width * ratio);
  const pixelHeight = Math.round(rect.height * ratio);
  if (minimap.width !== pixelWidth) minimap.width = pixelWidth;
  if (minimap.height !== pixelHeight) minimap.height = pixelHeight;
  const map = minimapContext;
  map.setTransform(ratio, 0, 0, ratio, 0, 0);
  map.clearRect(0, 0, rect.width, rect.height);
  map.fillStyle = "rgba(255,255,255,.96)";
  map.fillRect(0, 0, rect.width, rect.height);

  let hasPoints = false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      const mapped = strokeCanvasPoint(stroke, point, canvasRect.width, canvasRect.height);
      hasPoints = true;
      minX = Math.min(minX, mapped.x);
      maxX = Math.max(maxX, mapped.x);
      minY = Math.min(minY, mapped.y);
      maxY = Math.max(maxY, mapped.y);
    }
  }
  if (!hasPoints) {
    map.fillStyle = "#60738a";
    map.font = "11px sans-serif";
    map.textAlign = "center";
    map.textBaseline = "middle";
    map.fillText("Writing preview", rect.width / 2, rect.height / 2);
    return;
  }

  if (maxX - minX < 8) { minX -= 4; maxX += 4; }
  if (maxY - minY < 8) { minY -= 4; maxY += 4; }
  const padding = 9;
  const scale = Math.min((rect.width - padding * 2) / (maxX - minX), (rect.height - padding * 2) / (maxY - minY));
  const drawWidth = (maxX - minX) * scale;
  const drawHeight = (maxY - minY) * scale;
  const originX = (rect.width - drawWidth) / 2 - minX * scale;
  const originY = (rect.height - drawHeight) / 2 - minY * scale;
  const toMini = (x, y) => ({ x: originX + x * scale, y: originY + y * scale });

  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const first = strokeCanvasPoint(stroke, stroke.points[0], canvasRect.width, canvasRect.height);
    const start = toMini(first.x, first.y);
    map.beginPath();
    map.strokeStyle = stroke.tool === "eraser" ? "#fff" : (stroke.color || "#132a45");
    map.lineWidth = Math.max(1, (stroke.width || 2.2) * first.scale * scale);
    map.lineCap = "round";
    map.lineJoin = "round";
    map.moveTo(start.x, start.y);
    for (const point of stroke.points.slice(1)) {
      const mapped = strokeCanvasPoint(stroke, point, canvasRect.width, canvasRect.height);
      const miniPoint = toMini(mapped.x, mapped.y);
      map.lineTo(miniPoint.x, miniPoint.y);
    }
    if (stroke.points.length === 1) map.lineTo(start.x + .2, start.y + .2);
    map.stroke();
  }

  const viewLeft = ((-view.offsetX - canvasRect.width / 2) / view.scale) + canvasRect.width / 2;
  const viewTop = ((-view.offsetY - canvasRect.height / 2) / view.scale) + canvasRect.height / 2;
  const viewTopLeft = toMini(viewLeft, viewTop);
  map.save();
  map.setLineDash([3, 2]);
  map.strokeStyle = "#0e5fae";
  map.lineWidth = 1.5;
  map.strokeRect(viewTopLeft.x, viewTopLeft.y, canvasRect.width / view.scale * scale, canvasRect.height / view.scale * scale);
  map.restore();
}

function fitToWriting() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  let hasPoints = false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      const mapped = strokeCanvasPoint(stroke, point, rect.width, rect.height);
      hasPoints = true;
      minX = Math.min(minX, mapped.x);
      maxX = Math.max(maxX, mapped.x);
      minY = Math.min(minY, mapped.y);
      maxY = Math.max(maxY, mapped.y);
    }
  }
  if (!hasPoints) {
    view = { scale: 1, offsetX: 0, offsetY: 0 };
    drawCanvas();
    return;
  }
  const padding = 28;
  const width = Math.max(8, maxX - minX);
  const height = Math.max(8, maxY - minY);
  view.scale = Math.min(50, Math.max(.0001, Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height)));
  view.offsetX = (rect.width / 2 - (minX + maxX) / 2) * view.scale;
  view.offsetY = (rect.height / 2 - (minY + maxY) / 2) * view.scale;
  drawCanvas();
}

function setPanMode(enabled) {
  panMode = enabled;
  const button = $("#phoneCanvasPan");
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", enabled ? "Disable pan mode" : "Enable pan mode");
  $("#phoneCanvasPanLabel").textContent = enabled ? "Pan on" : "Pan";
  canvas.style.cursor = enabled ? "grab" : "crosshair";
}

function setZoomMode(enabled) {
  zoomMode = enabled;
  pinch = null;
  const button = $("#phoneCanvasZoomToggle");
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", enabled ? "Disable pinch-to-zoom" : "Enable pinch-to-zoom");
  button.textContent = enabled ? "Zoom on" : "Zoom off";
}

function setEraserMode(enabled) {
  eraserMode = enabled;
  const button = $("#phoneCanvasEraser");
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", enabled ? "Disable eraser" : "Enable eraser");
  button.textContent = enabled ? "Eraser on" : "Eraser";
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
  $("#phoneCanvasSubmit").disabled = !hostInputEnabled || strokes.length === 0 || !hostConnected;
}

canvas.addEventListener("pointerdown", (event) => {
  if (!hostConnected || !hostInputEnabled || event.button !== 0) return;
  event.preventDefault();
  try { canvas.setPointerCapture(event.pointerId); } catch {}
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const pair = [...pointers.values()];
  const rect = canvas.getBoundingClientRect();
  if (pair.length >= 2) {
    if (activeStroke) finishStroke();
    panDrag = null;
    if (zoomMode) {
      const midpoint = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
      pinch = { distance: Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y), scale: view.scale, offsetX: view.offsetX, offsetY: view.offsetY, midpoint };
    } else {
      pinch = null;
    }
    return;
  }
  if (panMode) {
    panDrag = { x: event.clientX, y: event.clientY, offsetX: view.offsetX, offsetY: view.offsetY };
    return;
  }
  // Use the live canvas box here: during a phone rotation the ResizeObserver
  // can run just after the first touch, and a stale portrait frame clamps the
  // landscape points to an edge (which looks like straight lines).
  const frame = { width: rect.width, height: rect.height };
  localFrame = frame;
  const point = pointerPoint(event, frame);
  activeStroke = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    frame,
    points: [point],
    width: eraserMode ? 24 : (event.pointerType === "pen" ? 2.5 : 2.2),
    color: eraserMode ? "#fff" : "#132a45",
    tool: eraserMode ? "eraser" : "pen",
  };
  pointerId = event.pointerId;
  strokes.push(activeStroke);
  send({ type: "stroke_start", id: activeStroke.id, frame, point, width: activeStroke.width, tool: activeStroke.tool });
  $("#phoneCanvasSubmit").disabled = false;
  drawCanvas();
});

canvas.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId)) return;
  event.preventDefault();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const pair = [...pointers.values()];
  const rect = canvas.getBoundingClientRect();
  if (pair.length >= 2 && pinch) {
    const midpoint = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
    const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
    const oldScale = pinch.scale;
    const scale = Math.min(50, Math.max(.0001, oldScale * distance / Math.max(1, pinch.distance)));
    const focusX = pinch.midpoint.x - rect.left - rect.width / 2;
    const focusY = pinch.midpoint.y - rect.top - rect.height / 2;
    view.offsetX = focusX - (focusX - pinch.offsetX) * scale / oldScale + midpoint.x - pinch.midpoint.x;
    view.offsetY = focusY - (focusY - pinch.offsetY) * scale / oldScale + midpoint.y - pinch.midpoint.y;
    view.scale = scale;
    drawCanvas();
    return;
  }
  if (panDrag && pair.length === 1) {
    view.offsetX = panDrag.offsetX + event.clientX - panDrag.x;
    view.offsetY = panDrag.offsetY + event.clientY - panDrag.y;
    drawCanvas();
    return;
  }
  if (!activeStroke || event.pointerId !== pointerId || pair.length !== 1) return;
  let events = event.getCoalescedEvents?.();
  if (!events?.length) events = [event];
  const last = events[events.length - 1];
  if (last.clientX !== event.clientX || last.clientY !== event.clientY) events = [...events, event];
  for (const item of events) queuePoint(pointerPoint(item, activeStroke.frame));
});

["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => canvas.addEventListener(type, (event) => {
  if (activeStroke && event.pointerId === pointerId) finishStroke();
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1 && panMode) {
    const remaining = [...pointers.values()][0];
    panDrag = { x: remaining.x, y: remaining.y, offsetX: view.offsetX, offsetY: view.offsetY };
  }
  if (!pointers.size) panDrag = null;
}));

function connectSocket(session) {
  const socketUrl = pairingWebSocketUrl("canvas-pairing", session.session_id);
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
      document.body.classList.add("phone-canvas-active");
      hostConnected = false;
      setCanvasStatus("Waiting for the computer canvas…");
      updateCanvasControls();
      requestAnimationFrame(resizeCanvas);
    } else if (message.type === "host_connected") {
      hostConnected = true;
      setCanvasStatus("Connected — draw here to update your computer", "success");
      updateCanvasControls();
    } else if (message.type === "setup") {
      hostInputEnabled = message.stage === "writing";
      const graphMode = message.mode === "graph";
      updateCanvasControls();
      $("#phoneCanvasSubmit").textContent = graphMode ? "Review" : "Next";
      if (!hostInputEnabled) setCanvasStatus(graphMode ? "Set the function count or review the graph on your computer." : "Select work areas and transcribe on the computer.");
      $("#phoneCanvasHelp").textContent = hostInputEnabled
        ? graphMode ? "Draw the graph here, then select Review. Graph recognition and review continue on the computer."
          : "Write or draw here, then select Next. Choose work areas and transcribe on the computer."
        : graphMode ? "Your graph is on the computer. Review it there before attaching it."
          : "Your writing is ready on the computer. Select Words, Maths, or Drawings there, then transcribe.";
      $("#phoneCanvasSubmit").disabled = !hostInputEnabled || strokes.length === 0 || !hostConnected;
      if ("title" in message || "question" in message) {
        const question = $("#phoneCanvasQuestion");
        const questionText = [message.title, message.question].filter(Boolean).join("\n\n").trim();
        renderTextbookMath(question, questionText);
        const questionToggle = $("#phoneCanvasQuestionToggle");
        const workspace = $("#phoneCanvasWorkspace");
        questionToggle.hidden = !questionText;
        workspace.classList.remove("question-hidden");
        questionToggle.textContent = "Hide Q";
        questionToggle.setAttribute("aria-expanded", "true");
      }
      if (Array.isArray(message.strokes)) {
        strokes = message.strokes.map((stroke) => ({
          id: String(stroke.id || ""),
          frame: { width: Number(stroke.frame?.width) || localFrame.width, height: Number(stroke.frame?.height) || localFrame.height },
          width: Number(stroke.width) || 2.2,
          color: stroke.color || "#132a45",
          tool: stroke.tool === "eraser" ? "eraser" : "pen",
          points: Array.isArray(stroke.points) ? stroke.points.map((point) => canvasPoint(point)) : [],
        }));
        drawCanvas();
        $("#phoneCanvasSubmit").disabled = !hostInputEnabled || strokes.length === 0 || !hostConnected;
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
      hostInputEnabled = false;
      updateCanvasControls();
      setCanvasStatus("Canvas submitted to your answer.", "success");
      $("#phoneCanvasHelp").textContent = "Your writing has been attached to the question on your computer.";
    } else if (message.type === "selection_ready") {
      hostInputEnabled = false;
      updateCanvasControls();
      setCanvasStatus("Select work areas and transcribe on the computer.");
      $("#phoneCanvasHelp").textContent = "Continue on the computer to select Words, Maths, or Drawings and review the transcription.";
    } else if (message.type === "processing") {
      hostInputEnabled = false;
      updateCanvasControls();
      setCanvasStatus("Your work is being read on the computer…");
    } else if (message.type === "review_ready") {
      hostInputEnabled = false;
      updateCanvasControls();
      setCanvasStatus("Review and edit the transcription on your computer, then confirm it.", "success");
    } else if (message.type === "submission_error") {
      hostConnected = true;
      updateCanvasControls();
      $("#phoneCanvasSubmit").textContent = "Next";
      setCanvasStatus(message.message || "Canvas could not be submitted. Try again.", "error");
    }
  });
  socket.addEventListener("close", () => {
    clearInterval(heartbeat);
    heartbeat = 0;
    hostConnected = false;
    updateCanvasControls();
    if (!$("#phoneCanvasWorkspace").hidden && !submittedToAnswer) {
      setCanvasStatus("Connection ended. Your phone drawing is still on this screen.", "error");
    }
  });
  socket.addEventListener("error", () => setPairStatus("Could not connect to the computer. Check that both devices are on the same Wi-Fi and try again.", "error"));
}

async function connectPhone(event) {
  event?.preventDefault();
  const code = $("#phonePairCode").value.replace(/\D/g, "").slice(0, 6);
  if (code.length !== 6) return setPairStatus("Enter the six-digit code shown on your computer.", "error");
  if (!isLocalIntranetPage() && !getAccessToken()) {
    setPhoneSignInVisible(true);
    return setPairStatus("Sign in with the same SharperTime account used on the computer.");
  }
  submittedToAnswer = false;
  const button = $("#phonePairForm button[type='submit']");
  button.disabled = true;
  setPairStatus("Connecting…");
  try {
    const joinRequest = pairSession?.session_id ? { code, session_id: pairSession.session_id } : { code };
    const joined = await postPairingJson("canvas-pairing", "join", joinRequest);
    pairSession = joined;
    sessionStorage.setItem("sharperx_phone_canvas_session", JSON.stringify({ ...joined, code }));
    connectSocket(joined);
  } catch (error) {
    if (!isLocalIntranetPage() && !getAccessToken()) {
      setPhoneSignInVisible(true);
      setPairStatus("Your sign-in has expired. Sign in to continue.", "error");
    } else setPairStatus(error.message || "Could not connect to the computer. Check the code and try again.", "error");
  } finally {
    button.disabled = false;
  }
}

$("#phoneSignInForm").addEventListener("submit", async (event) => {
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
    if (!result.access_token) throw new Error("Sign-in could not be completed. Please try again.");
    setAccessToken(result.access_token);
    form.reset();
    setPhoneSignInVisible(false);
    setPairStatus("Signed in. Connecting to the computer canvas…");
    await connectPhone();
  } catch (error) {
    setPairStatus(error.message || "Sign-in could not be completed. Please try again.", "error");
  } finally {
    button.disabled = false;
  }
});

$("#phonePairForm").addEventListener("submit", connectPhone);
const nativeCanvasLink = $("#openNativeCanvas");
const phonePairCode = $("#phonePairCode");
function updateNativeCanvasLink() {
  const code = phonePairCode.value.replace(/\D/g, "").slice(0, 6);
  const androidPhone = /Android/i.test(navigator.userAgent) && /Mobile/i.test(navigator.userAgent);
  const showLink = androidPhone && code.length === 6;
  nativeCanvasLink.hidden = !showLink;
  if (showLink) {
    const pairingApi = isLocalIntranetPage() ? window.location.origin : API_BASE_URL;
    nativeCanvasLink.href = `sharpertimecanvas://pair?code=${encodeURIComponent(code)}&api=${encodeURIComponent(pairingApi)}`;
  }
}
phonePairCode.addEventListener("input", updateNativeCanvasLink);
nativeCanvasLink.addEventListener("click", (event) => {
  updateNativeCanvasLink();
  if (nativeCanvasLink.hidden) event.preventDefault();
});
updateNativeCanvasLink();
$("#phoneCanvasPan").addEventListener("click", () => setPanMode(!panMode));
$("#phoneCanvasZoomToggle").addEventListener("click", () => setZoomMode(!zoomMode));
$("#phoneCanvasEraser").addEventListener("click", () => setEraserMode(!eraserMode));
$("#phoneCanvasFit").addEventListener("click", fitToWriting);
$("#phoneCanvasQuestionToggle").addEventListener("click", (event) => {
  const workspace = $("#phoneCanvasWorkspace");
  const hidden = workspace.classList.toggle("question-hidden");
  event.currentTarget.textContent = hidden ? "Show Q" : "Hide Q";
  event.currentTarget.setAttribute("aria-expanded", String(!hidden));
  requestAnimationFrame(resizeCanvas);
});
$("#phoneCanvasUndo").addEventListener("click", () => {
  if (!hostInputEnabled) return;
  if (activeStroke) finishStroke();
  const removed = strokes.pop();
  if (removed) send({ type: "undo", id: removed.id });
  drawCanvas();
  $("#phoneCanvasSubmit").disabled = !hostInputEnabled || strokes.length === 0 || !hostConnected;
});
$("#phoneCanvasClear").addEventListener("click", () => {
  if (!hostInputEnabled) return;
  if (activeStroke) finishStroke();
  strokes = [];
  send({ type: "clear" });
  drawCanvas();
  $("#phoneCanvasSubmit").disabled = true;
});
$("#phoneCanvasSubmit").addEventListener("click", () => {
  if (!strokes.length || !hostConnected || !hostInputEnabled) return;
  $("#phoneCanvasSubmit").disabled = true;
  setCanvasStatus("Sending your writing to the computer…");
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
  document.body.classList.remove("phone-canvas-active");
  setPairStatus("Disconnected. Enter a new code to connect again.");
});

const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const scannedCode = fragment.get("code") || "";
const scannedSessionId = fragment.get("session_id") || "";
history.replaceState(null, "", location.pathname + location.search);
if (!isLocalIntranetPage() && !getAccessToken()) setPhoneSignInVisible(true);
if (scannedCode) {
  $("#phonePairCode").value = scannedCode.replace(/\D/g, "").slice(0, 6);
  pairSession = scannedSessionId ? { session_id: scannedSessionId } : null;
  const cleanCode = $("#phonePairCode").value;
  const androidPhone = /Android/i.test(navigator.userAgent) && /Mobile/i.test(navigator.userAgent);
  if (androidPhone && cleanCode.length === 6) {
    const pairingApi = isLocalIntranetPage() ? window.location.origin : API_BASE_URL;
    window.location.href = `sharpertimecanvas://pair?code=${encodeURIComponent(cleanCode)}&api=${encodeURIComponent(pairingApi)}`;
    window.setTimeout(() => {
      if (document.visibilityState === "visible" && !$("#pairScreen").hidden)
        connectPhone(new Event("submit", { cancelable: true }));
    }, 1400);
  } else {
    connectPhone(new Event("submit", { cancelable: true }));
  }
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

function updatePhoneViewport() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--phone-viewport-height", `${Math.round(height)}px`);
  requestAnimationFrame(resizeCanvas);
}

new ResizeObserver(resizeCanvas).observe($(".phone-canvas-wrap"));
window.addEventListener("resize", updatePhoneViewport, { passive: true });
window.addEventListener("orientationchange", updatePhoneViewport, { passive: true });
window.visualViewport?.addEventListener("resize", updatePhoneViewport, { passive: true });
updatePhoneViewport();
