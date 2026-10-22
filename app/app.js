import { API_BASE_URL, apiRequest, getAccessToken, getJson, postForm, postJson, postPairingJson, pairingWebSocketUrl, isLocalIntranetPage, setAccessToken, uploadForm } from "./api.js?v=18";
import { installRealtimeTutor } from "./realtime-tutor.js";
import qrcode from "./vendor/qrcode-generator.js?v=17";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const APP_VIEWS = new Set(["ask", "practice", "exam", "lessons", "reports"]);
let mathJaxLoadPromise = null;
const savedView = sessionStorage.getItem("sharperx_web_current_view");
const PRACTICE_SESSION_KEYS = {
  grade: "sharperx_web_practice_grade",
  topic: "sharperx_web_practice_topic_id",
  subtopic: "sharperx_web_practice_subtopic_id",
  question: "sharperx_web_practice_question_id",
  inspectionPrefix: "sharperx_web_practice_inspection_",
  photosPrefix: "sharperx_web_practice_photos_",
};

function practiceQuestionStorageKey(prefix, questionId = state.currentPracticeQuestion?.question_id || state.currentPracticeQuestion?.bank_question_id || state.currentPracticeQuestion?.id || "") {
  return questionId ? `${prefix}${encodeURIComponent(String(questionId))}` : "";
}

function updateAppViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-viewport-height", `${Math.round(height)}px`);
}

updateAppViewportHeight();
window.addEventListener("resize", updateAppViewportHeight, { passive: true });
window.visualViewport?.addEventListener("resize", updateAppViewportHeight, { passive: true });

const state = {
  user: null,
  grade: formatGrade(sessionStorage.getItem("sharperx_web_grade") || 12),
  view: APP_VIEWS.has(savedView) ? savedView : "ask",
  inspectionId: sessionStorage.getItem("sharperx_web_inspection_id") || "",
  practiceInspectionId: "",
  examInspectionId: sessionStorage.getItem("sharperx_web_exam_inspection_id") || "",
  paperDocumentId: sessionStorage.getItem("sharperx_web_paper_id") || "",
  memoDocumentId: sessionStorage.getItem("sharperx_web_memo_id") || "",
  paperFileName: sessionStorage.getItem("sharperx_web_paper_name") || "",
  selectedPaperQuestion: null,
  paperPageImage: "",
  askPhotos: [],
  topicCatalogs: new Map(),
  practiceTopics: [],
  practiceSubtopics: [],
  practiceQuestions: [],
  currentPracticeQuestion: null,
  hintIndex: 0,
  practiceVisuals: [],
  examTopics: [],
  exam: null,
  examSessionId: sessionStorage.getItem("sharperx_web_exam_session_id") || "",
  examQuestionIndex: 0,
  examAnswers: new Map(),
  examAnswerAttachments: new Map(),
  examVisuals: [],
  lessonCatalog: [],
  canvasContext: null,
  canvasQuestion: null,
  canvasReturnFocus: null,
  attachedCanvasPhotoId: "",
  practiceAnswerPhotoIds: [],
  practiceAnswerPhotoPreviews: [],
  practiceVoiceRecorder: null,
  practiceVoiceChunks: [],
  practiceVoiceTranscript: "",
  practiceVoiceMath: "",
  practiceEditorReady: false,
  practiceEditorState: null,
  practiceKeyboardMode: "Alphabet",
  reportObjectUrls: new Set(),
  recorder: null,
  audioChunks: [],
  canvas: { mode: "write", strokes: [], scale: 1, offsetX: 0, offsetY: 0, pan: false, zoom: false, eraser: false, revision: 0, transcribedPhoto: null, photoPromise: null, active: null, pointers: new Map(), pinch: null, size: { width: 0, height: 0 } },
  imageView: { scale: 1, x: 0, y: 0, pointers: new Map(), pinch: null, drag: null },
  toastTimer: 0,
};

const dbPromise = openReportsDatabase();

function setStatus(element, text, kind = "") {
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("is-error", kind === "error");
  element.classList.toggle("is-success", kind === "success");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function renderMath(target, text) {
  const raw = String(text || "").replace(/\\vspace\{[^}]*\}/g, "\n").replace(/\\\\\s+/g, "\n");
  const normalized = /\\\(|\\\[|\$\$/.test(raw) ? raw : raw.split(/\r?\n/).map((line) => {
    let result = line.replace(/(^|[^\\])\bLongrightarrow\b/g, "$1\\(\\Longrightarrow\\)");
    if (/[=^√±]/.test(result) && /\bimplies\b/i.test(result)) result = result.replace(/\bimplies\b/gi, "\\(\\Rightarrow\\)");
    result = result.replace(/(^|[^\\])\b([A-Za-z][A-Za-z0-9_]*)\s*\^\s*\{?([^\s{}]+)\}?/g, "$1\\($2^{$3}\\)");
    return result;
  }).join("\n");
  target.innerHTML = escapeHtml(normalized).replace(/\r?\n/g, "<br>");
  if (/\\\(|\\\[|\$\$/.test(normalized)) {
    ensureMathJax().then((mathJax) => {
      if (!mathJax) return;
      mathJax.typesetClear?.([target]);
      return mathJax.typesetPromise([target]);
    }).catch(() => {});
  }
}

function ensureMathJax() {
  if (window.MathJax?.typesetPromise) return Promise.resolve(window.MathJax);
  if (!mathJaxLoadPromise) {
    mathJaxLoadPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";
      script.async = true;
      script.onload = () => resolve(window.MathJax?.typesetPromise ? window.MathJax : null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
  }
  return mathJaxLoadPromise;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function lastNonEmptyLine(value) {
  const lines = String(value || "").split(/\r?\n/).filter(Boolean);
  return lines[lines.length - 1] || "";
}

function formatGrade(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(8, Math.min(12, parsed)) : 12;
}

function showWorkspace() {
  $("#authScreen").hidden = true;
  $("#workspace").hidden = false;
  document.documentElement.classList.remove("checking-session");
  $("#accountLabel").textContent = state.user?.full_name || state.user?.email || "";
  ["#globalGrade", "#practiceGrade", "#examGrade", "#lessonGrade"].forEach((selector) => {
    $(selector).value = String(state.grade);
  });
  restorePaperSession();
  registerServiceWorker();
  renderSourceLinks();
  activateView(state.view);
  restoreExamSession();
}

function clearPracticeSessionSelection() {
  realtimeTutor?.stopIfContext("practice");
  for (const key of Object.values(PRACTICE_SESSION_KEYS)) sessionStorage.removeItem(key);
  state.practiceQuestions = [];
  state.currentPracticeQuestion = null;
  state.practiceTopics = [];
  state.practiceSubtopics = [];
  $("#practiceQuestionList").replaceChildren();
  $("#practiceQuestionCard").hidden = true;
}

function showAuth() {
  $("#workspace").hidden = true;
  $("#authScreen").hidden = false;
  document.documentElement.classList.remove("checking-session");
}

async function checkSession() {
  if (!getAccessToken()) return showAuth();
  try {
    state.user = await getJson("/api/auth/me");
    showWorkspace();
  } catch (error) {
    setAccessToken("");
    showAuth();
    setStatus($("#loginStatus"), error.message || "Could not restore your session. Sign in again.", "error");
  }
}

window.addEventListener("sharperx:auth-expired", () => {
  void realtimeTutor.stop();
  state.user = null;
  if (deviceRemoteDialog?.open) closeDeviceRemoteDialog();
  showAuth();
  setStatus($("#loginStatus"), "Your session has expired. Sign in again.", "error");
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const loginForm = event.currentTarget;
  const button = $("button[type='submit']", loginForm);
  const form = new FormData(loginForm);
  button.disabled = true;
  setStatus($("#loginStatus"), "Signing in…");
  try {
    const result = await postForm("/api/auth/login", {
      email: String(form.get("email") || "").trim(),
      password: String(form.get("password") || ""),
    }, { auth: false });
    if (!result.access_token) throw new Error("Sign in could not be completed. Please try again.");
    setAccessToken(result.access_token);
    state.user = result.user || {};
    loginForm.reset();
    showWorkspace();
    showToast("Signed in");
  } catch (error) {
    setStatus($("#loginStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#logoutButton").addEventListener("click", async () => {
  try { await postJson("/api/auth/logout", {}); } catch { /* local sign-out still completes */ }
  setAccessToken("");
  state.user = null;
  clearPracticeSessionSelection();
  showAuth();
});

function activateView(viewName) {
  if (!APP_VIEWS.has(viewName)) return;
  if (realtimeTutor.activeContext && realtimeTutor.activeContext !== viewName) void realtimeTutor.stop();
  state.view = viewName;
  sessionStorage.setItem("sharperx_web_current_view", viewName);
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName));
  $$("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === viewName;
    panel.hidden = !active;
    panel.classList.toggle("is-visible", active);
  });
  if (viewName === "practice" && !state.practiceTopics.length) {
    loadPracticeTopics(formatGrade($("#practiceGrade").value), { restore: true })
      .catch((error) => setStatus($("#practiceStatus"), error.message, "error"));
  }
  if (viewName === "exam" && !state.examTopics.length && !state.examSessionId) loadExamTopics().catch((error) => setStatus($("#examStatus"), error.message, "error"));
  if (viewName === "lessons") loadLessons().catch((error) => setStatus($("#lessonStatus"), error.message, "error"));
  if (viewName === "reports") loadSavedReports();
}

$$('[data-view]').forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));

$("#globalGrade").addEventListener("change", (event) => {
  state.grade = formatGrade(event.currentTarget.value);
  sessionStorage.setItem("sharperx_web_grade", String(state.grade));
  if (formatGrade($("#practiceGrade").value) !== state.grade) clearPracticeSessionSelection();
  $("#practiceGrade").value = String(state.grade);
  $("#examGrade").value = String(state.grade);
  $("#lessonGrade").value = String(state.grade);
  if (state.view === "practice") loadPracticeTopics(state.grade).catch((error) => setStatus($("#practiceStatus"), error.message, "error"));
  if (state.view === "exam") loadExamTopics().catch((error) => setStatus($("#examStatus"), error.message, "error"));
  if (state.view === "lessons") loadLessons().catch((error) => setStatus($("#lessonStatus"), error.message, "error"));
  renderSourceLinks();
});

function appendMessage(text, { mine = false, kind = "", imageUrl = "", actions = [] } = {}) {
  const article = document.createElement("article");
  article.className = `message ${mine ? "user-message" : "assistant-message"}`;
  if (kind) {
    const label = document.createElement("span");
    label.className = "message-kind";
    label.textContent = kind;
    article.append(label);
  }
  const body = document.createElement("p");
  renderMath(body, text);
  article.append(body);
  if (imageUrl) {
    const image = document.createElement("img");
    image.className = "message-image";
    image.src = imageUrl;
    image.alt = "Uploaded question or working";
    article.append(image);
  }
  if (actions.length) {
    const actionRow = document.createElement("div");
    actionRow.className = "message-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.className = "button subtle";
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", action.onClick);
      actionRow.append(button);
    }
    article.append(actionRow);
  }
  $("#chatMessages").append(article);
  $("#chatMessages").scrollTop = $("#chatMessages").scrollHeight;
  return article;
}

function ensureInspection(context = "ask") {
  const stateKey = context === "practice" ? "practiceInspectionId" : context === "exam" ? "examInspectionId" : "inspectionId";
  const storageKey = context === "practice"
    ? practiceQuestionStorageKey(PRACTICE_SESSION_KEYS.inspectionPrefix)
    : context === "exam" ? "sharperx_web_exam_inspection_id" : "sharperx_web_inspection_id";
  if (state[stateKey]) return Promise.resolve(state[stateKey]);
  if (context === "practice" && !storageKey) throw new Error("Select a practice question before attaching work.");
  const form = new FormData();
  form.set("client_name", state.user?.full_name || state.user?.email || "SharperTime learner");
  form.set("site_address", "SharperTime mathematics workspace");
  form.set("inspection_type", "mathematics");
  return uploadForm("/api/inspections/create", form).then((result) => {
    const id = result.id || result.inspection_id;
    if (!id) throw new Error("The upload could not be started. Please try again.");
    state[stateKey] = id;
    sessionStorage.setItem(storageKey, id);
    return id;
  });
}

function restorePaperSession() {
  const hasPaper = Boolean(state.paperDocumentId && state.inspectionId);
  $("#paperTools").hidden = !hasPaper;
  if (hasPaper) {
    $("#paperFileName").textContent = state.paperFileName || "Question paper uploaded in this session";
    $("#paperStatus").textContent = "Choose another question number to use the same uploaded paper.";
    $("#paperQuestionNumber").value = "";
  }
}

async function uploadPaper(file, kind) {
  if (!file) return;
  const status = $("#paperStatus");
  setStatus(status, `Uploading ${file.name}…`);
  try {
    const inspectionId = await ensureInspection();
    const form = new FormData();
    form.set("document_type", kind === "memo" ? "ask_marking_memo" : "ask_question_paper");
    form.set("document", file, file.name);
    const result = await uploadForm(`/api/inspections/${encodeURIComponent(inspectionId)}/upload-document`, form);
    const documentId = result.id || result.document_id;
    if (!documentId) throw new Error("The file could not be processed. Please try again.");
    if (kind === "memo") {
      state.memoDocumentId = documentId;
      sessionStorage.setItem("sharperx_web_memo_id", documentId);
      setStatus(status, `Memo uploaded: ${file.name}. It will be used when marking a selected paper question.`, "success");
      appendMessage(`Marking memo uploaded: ${file.name}.`, { kind: "Uploaded memo" });
    } else {
      state.paperDocumentId = documentId;
      state.paperFileName = file.name;
      state.selectedPaperQuestion = null;
      state.paperPageImage = "";
      sessionStorage.setItem("sharperx_web_paper_id", documentId);
      sessionStorage.setItem("sharperx_web_paper_name", file.name);
      $("#paperTools").hidden = false;
      $("#paperFileName").textContent = file.name;
      $("#paperQuestionNumber").value = "";
      $("#paperSnapshotCard").hidden = true;
      setStatus(status, "Paper uploaded. Enter the question number you want to attempt or ask about.", "success");
      appendMessage(`Question paper uploaded: ${file.name}. Which question would you like to attempt or get help with? Enter its number above, for example 2(b), then choose “Show question”.`, { kind: "Uploaded question paper" });
    }
  } catch (error) {
    setStatus(status, error.message, "error");
  }
}

$("#paperInput").addEventListener("change", (event) => uploadPaper(event.currentTarget.files?.[0], "paper"));
$("#memoInput").addEventListener("change", (event) => uploadPaper(event.currentTarget.files?.[0], "memo"));

$("#showPaperQuestionButton").addEventListener("click", async () => {
  realtimeTutor.stopIfContext("ask");
  const questionNumber = $("#paperQuestionNumber").value.trim();
  if (!state.paperDocumentId || !state.inspectionId) return setStatus($("#paperStatus"), "Upload a question paper first.", "error");
  if (!questionNumber) return setStatus($("#paperStatus"), "Enter the question number shown on the paper.", "error");
  const button = $("#showPaperQuestionButton");
  button.disabled = true;
  setStatus($("#paperStatus"), `Finding question ${questionNumber} and its page…`);
  try {
    const result = await postJson(`/api/inspections/${encodeURIComponent(state.inspectionId)}/question-snapshot`, {
      document_id: state.paperDocumentId,
      question_number: questionNumber,
      memo_document_id: state.memoDocumentId || null,
    });
    const pageBase64 = result.image_png_base64 || result.question_png_base64 || result.full_page_png_base64 || result.page_png_base64 || "";
    if (!pageBase64) throw new Error("The full page containing that question could not be prepared.");
    const questionText = result.question_text || result.extracted_question_text || "";
    if (!questionText.trim()) throw new Error("The selected question text could not be read. Try a clearer paper scan or a different question number.");
    state.paperPageImage = `data:image/png;base64,${pageBase64}`;
    state.selectedPaperQuestion = {
      number: result.question_number || result.extracted_question_number || questionNumber,
      text: questionText,
      memoText: result.memo_text || "",
      focus: result.question_focus || null,
    };
    $("#paperSnapshotTitle").textContent = `Question ${state.selectedPaperQuestion.number}`;
    $("#paperSnapshotImage").src = state.paperPageImage;
    $("#paperQuestionText").textContent = questionText;
    $("#paperSnapshotCard").hidden = false;
    setStatus($("#paperStatus"), "Full source page loaded. The question text is scoped to the selected question.", "success");
    appendMessage(`Question ${state.selectedPaperQuestion.number}\n\n${questionText}\n\nYou can now attempt it or ask for hints. Submit your working when you want it marked.`, {
      kind: "Selected question",
      imageUrl: state.paperPageImage,
      actions: [{ label: "View full page", onClick: () => openImageViewer(state.paperPageImage, `Question ${state.selectedPaperQuestion.number} · full page`) }],
    });
  } catch (error) {
    setStatus($("#paperStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#paperSnapshotImage").addEventListener("click", () => openImageViewer(state.paperPageImage, "Uploaded question paper · full page"));
$("#openPaperSnapshot").addEventListener("click", () => openImageViewer(state.paperPageImage, `Question ${state.selectedPaperQuestion?.number || ""} · full page`));

$("#clearPaperButton").addEventListener("click", () => {
  realtimeTutor.stopIfContext("ask");
  state.paperDocumentId = "";
  state.memoDocumentId = "";
  state.paperFileName = "";
  state.selectedPaperQuestion = null;
  state.paperPageImage = "";
  sessionStorage.removeItem("sharperx_web_paper_id");
  sessionStorage.removeItem("sharperx_web_memo_id");
  sessionStorage.removeItem("sharperx_web_paper_name");
  $("#paperTools").hidden = true;
});

async function sendAsk(event) {
  event.preventDefault();
  realtimeTutor.stopIfContext("ask");
  const input = $("#askInput");
  const text = input.value.trim();
  const selected = state.selectedPaperQuestion;
  if (!text && !selected && state.askPhotos.length === 0) {
    input.focus();
    return showToast("Type a question or select a question from your paper first.");
  }
  const button = $("#sendAskButton");
  button.disabled = true;
  const lastAskPhoto = state.askPhotos[state.askPhotos.length - 1];
  const attachedImage = lastAskPhoto?.previewUrl || "";
  const shownText = selected
    ? (text ? `Attempt / request for Question ${selected.number}:\n${text}` : `Question ${selected.number}:\n${selected.text}`)
    : text || "Please look at the attached working.";
  appendMessage(shownText, { mine: true, imageUrl: attachedImage });
  input.value = "";
  try {
    const payload = {
      subject: "Mathematics",
      grade: state.grade,
      topic: selected ? "Question paper" : null,
      question: selected ? selected.text : text,
      learner_answer: selected ? text : null,
      mode: "explain_try_mark",
      inspection_id: state.inspectionId || null,
      ai_tier: "luna",
      allow_web_search: false,
      confirmed_photo_transcription: null,
      photo_reading_confirmed: false,
      question_paper_document_id: selected ? state.paperDocumentId : null,
      question_paper_question_number: selected ? selected.number : null,
      marking_memo_reference: selected && selected.memoText ? selected.memoText.slice(0, 30000) : null,
    };
    setStatus($("#voiceStatus"), "Sending to SharperTime…");
    const result = await postJson("/api/education/tutor/ask", payload);
    requireLunaXhigh(result, "Ask");
    const responseText = readTutorText(result);
    appendMessage(responseText, {
      kind: "Tutor response",
      actions: [{ label: "Save PDF report", onClick: () => saveReport("Ask feedback", shownText, responseText) }],
    });
    setStatus($("#voiceStatus"), "");
  } catch (error) {
    appendMessage(error.message, { kind: "Could not send" });
    setStatus($("#voiceStatus"), "");
  } finally {
    button.disabled = false;
    input.focus({ preventScroll: true });
  }
}

function readTutorText(result) {
  const candidates = [result.assistant_message, result.answer, result.response, result.feedback, result.message, result.tutor_response, result.text];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (value) return value;
  if (result.result && typeof result.result === "string") return result.result;
  return "I couldn't prepare a response. Please try again.";
}

function requireLunaXhigh(result, operation) {
  const model = String(result?.ai_model || result?.model || "").trim().toLowerCase();
  const effort = String(result?.ai_reasoning_effort || result?.reasoning_effort || "").trim().toLowerCase();
  const status = String(result?.ai_status || result?.status || "").trim().toLowerCase();
  if (model !== "gpt-6-luna" || effort !== "xhigh" || status !== "completed") {
    throw new Error(`${operation} could not be completed. Your work is still here; please retry.`);
  }
}

function practiceVoiceTranscriptMessage(role, text) {
  const transcript = $("[data-live-transcript]", $("[data-live-panel='practice']"));
  if (!transcript) return;
  const item = document.createElement("div");
  item.className = "live-tutor-transcript-item";
  const label = document.createElement("strong");
  label.textContent = role === "learner" ? "You said" : "Tutor";
  const body = document.createElement("p");
  if (role === "learner") body.textContent = text;
  else renderMath(body, text);
  item.append(label, body);
  transcript.append(item);
  while (transcript.children.length > 20) transcript.firstElementChild.remove();
  transcript.scrollTop = transcript.scrollHeight;
}

const realtimeTutor = installRealtimeTutor({
  apiBaseUrl: API_BASE_URL,
  getAccessToken,
  ensureInspection: (context) => ensureInspection(context === "practice" ? "practice" : "ask"),
  getContext: async (context, inspectionId) => {
    if (context === "practice") {
      const question = state.currentPracticeQuestion;
      if (!question) throw new Error("Choose a practice question before starting a live tutor session.");
      return {
        context_type: "practice",
        grade: formatGrade(question.grade || $("#practiceGrade").value),
        topic: question.topic || $("#practiceSubtopic").selectedOptions[0]?.textContent || "Mathematics",
        inspection_id: inspectionId,
        question_text: questionLabel(question),
        question_id: question.question_id || question.bank_question_id || question.id || null,
        bank_version: question.bank_version || "",
        marks: Number.parseInt(question.marks, 10) || 0,
        hints_used: state.hintIndex,
        learner_working: getPracticeEditorLatex().trim().slice(0, 12000),
      };
    }
    const selected = state.selectedPaperQuestion;
    const history = $$(".message", $("#chatMessages")).slice(-8).map((message) => ({
      role: message.classList.contains("user-message") ? "learner" : "tutor",
      text: $("p", message)?.textContent?.trim().slice(0, 1200) || "",
    })).filter((turn) => turn.text);
    return {
      context_type: "ask",
      grade: state.grade,
      topic: selected ? "Question paper" : null,
      inspection_id: inspectionId,
      question_text: selected?.text || $("#askInput").value.trim() || null,
      question_paper_document_id: selected ? state.paperDocumentId : null,
      question_paper_question_number: selected ? String(selected.number || "") : null,
      conversation_history: history,
    };
  },
  onTranscript: (context, text) => {
    if (context === "practice") practiceVoiceTranscriptMessage("learner", text);
    else appendMessage(text, { mine: true, kind: "Voice transcript" });
  },
  onTutorReply: (context, text) => {
    if (context === "practice") practiceVoiceTranscriptMessage("tutor", text);
    else appendMessage(text, { kind: "Live tutor" });
  },
});

$("#askForm").addEventListener("submit", sendAsk);
$$("[data-open-canvas]").forEach((button) => button.addEventListener("click", () => openCanvas(button.dataset.openCanvas)));

$$('[data-file-trigger]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.fileTrigger}`).click()));

$("#photoInput").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) return showToast("Choose an image file.");
  try {
    setStatus($("#voiceStatus"), `Uploading ${file.name}…`);
    const inspectionId = await ensureInspection();
    const form = new FormData();
    form.set("photo_type", "mathematics_question_or_working");
    form.set("photo", file, file.name);
    const result = await uploadForm(`/api/inspections/${encodeURIComponent(inspectionId)}/upload-photo`, form);
    const photoId = result.id || result.photo_id;
    const previewUrl = URL.createObjectURL(file);
    state.askPhotos.push({ id: photoId, filename: file.name, previewUrl });
    appendMessage(`Photo attached: ${file.name}. Type a question or ask SharperTime to inspect it.`, { kind: "Uploaded image", imageUrl: previewUrl });
    setStatus($("#voiceStatus"), "Photo attached to this session.", "success");
  } catch (error) {
    setStatus($("#voiceStatus"), error.message, "error");
  }
});

async function recordVoiceNote() {
  const button = $("#voiceButton");
  const status = $("#voiceStatus");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    if (state.recorder instanceof SpeechRecognition) {
      state.recorder.stop();
      state.recorder = null;
      button.classList.remove("is-recording");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-ZA";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        if (event.results[index].isFinal) finalText += event.results[index][0].transcript;
      }
      if (finalText.trim()) appendToComposer(finalText.trim());
    };
    recognition.onerror = (event) => setStatus(status, event.error === "not-allowed" ? "Allow microphone access in your browser settings." : `Voice input: ${event.error}`, "error");
    recognition.onend = () => {
      if (state.recorder === recognition) state.recorder = null;
      button.classList.remove("is-recording");
      if (!status.classList.contains("is-error")) setStatus(status, "Voice note added to your question.", "success");
    };
    try {
      state.recorder = recognition;
      recognition.start();
      button.classList.add("is-recording");
      setStatus(status, "Listening… tap Voice again to finish.");
    } catch (error) {
      state.recorder = null;
      setStatus(status, error.message, "error");
    }
    return;
  }
  await toggleMediaRecorder(button, status);
}

function appendToComposer(text) {
  const input = $("#askInput");
  input.value = [input.value.trim(), text].filter(Boolean).join(input.value.trim() ? " " : "");
  input.focus({ preventScroll: true });
}

async function toggleMediaRecorder(button, status) {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
    button.classList.remove("is-recording");
    setStatus(status, "Transcribing voice note…");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return setStatus(status, "Voice recording is not supported by this browser. You can type or attach a photo instead.", "error");
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.audioChunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) state.audioChunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      try {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(state.audioChunks, { type });
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `voice-note.${ext}`, { type });
        const form = new FormData();
        form.set("audio", file);
        const result = await uploadForm("/api/education/speech/transcribe", form);
        const transcript = result.transcript || result.text || result.transcription || "";
        if (!transcript.trim()) throw new Error("No words were recognized in that voice note.");
        appendToComposer(transcript.trim());
        setStatus(status, "Voice note transcribed. Review it, then press Send.", "success");
      } catch (error) { setStatus(status, error.message, "error"); }
    };
    state.recorder = recorder;
    recorder.start();
    button.classList.add("is-recording");
    setStatus(status, "Recording… tap Voice again to finish.");
  } catch (error) {
    setStatus(status, error.name === "NotAllowedError" ? "Allow microphone access in your browser settings." : error.message, "error");
  }
}

$("#voiceButton").addEventListener("click", recordVoiceNote);

async function openImageViewer(source, title = "Question image") {
  if (!source) return;
  $("#imageDialogTitle").textContent = title;
  const image = $("#fullImage");
  image.style.transform = "";
  const dialog = $("#imageDialog");
  if (!dialog.open) dialog.showModal();
  const imageReady = new Promise((resolve) => {
    image.onload = resolve;
    image.onerror = resolve;
    if (image.complete && image.naturalWidth) resolve();
  });
  image.src = source;
  await imageReady;
  resetImageView();
}

function resetImageView() {
  state.imageView = { scale: 1, x: 0, y: 0, pointers: new Map(), pinch: null, drag: null };
  applyImageTransform();
}

function applyImageTransform() {
  $("#fullImage").style.transform = `translate(${state.imageView.x}px, ${state.imageView.y}px) scale(${state.imageView.scale})`;
}

$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
$("#imageFitButton").addEventListener("click", resetImageView);

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch(() => {});
}

checkSession();

function normalizeTopic(topic) {
  return {
    id: String(topic.topic_id || topic.id || topic.topic || ""),
    name: String(topic.topic || topic.name || topic.topic_id || ""),
    subtopics: Array.isArray(topic.subtopics) ? topic.subtopics : [],
    count: Number(topic.question_count || 0),
  };
}

async function loadTopicCatalog(grade) {
  const normalizedGrade = formatGrade(grade);
  if (state.topicCatalogs.has(normalizedGrade)) return state.topicCatalogs.get(normalizedGrade);
  const result = await getJson(`/api/education/test-exam-preparation/topics?grade=${normalizedGrade}`);
  const topics = (result.topics || []).map(normalizeTopic);
  state.topicCatalogs.set(normalizedGrade, topics);
  return topics;
}

function replaceOptions(select, options, placeholder) {
  select.replaceChildren(new Option(placeholder, ""));
  for (const option of options) select.add(new Option(option.label, option.value));
  select.disabled = options.length === 0;
}

async function loadPracticeTopics(grade, { restore = false } = {}) {
  const topicSelect = $("#practiceTopic");
  const subtopicSelect = $("#practiceSubtopic");
  setStatus($("#practiceStatus"), "Loading topics…");
  topicSelect.disabled = true;
  subtopicSelect.disabled = true;
  try {
    const topics = await loadTopicCatalog(grade);
    state.practiceTopics = topics;
    replaceOptions(topicSelect, topics.map((topic) => ({ label: `${topic.name} · ${topic.count}`, value: topic.id })), "Select a topic");
    replaceOptions(subtopicSelect, [], "Select a topic first");
    setStatus($("#practiceStatus"), `${topics.length} topics available for Grade ${grade}.`, "success");
    if (restore && formatGrade(sessionStorage.getItem(PRACTICE_SESSION_KEYS.grade) || state.grade) === formatGrade(grade)) {
      const savedTopicId = sessionStorage.getItem(PRACTICE_SESSION_KEYS.topic) || "";
      if (savedTopicId && topics.some((topic) => String(topic.id) === savedTopicId)) {
        topicSelect.value = savedTopicId;
        await loadPracticeSubtopics(grade, savedTopicId, { restore: true });
      }
    }
  } catch (error) {
    setStatus($("#practiceStatus"), error.message, "error");
  }
}

async function loadPracticeSubtopics(grade, topicId, { restore = false } = {}) {
  const topic = state.practiceTopics?.find((item) => String(item.id) === String(topicId));
  const subtopicSelect = $("#practiceSubtopic");
  replaceOptions(subtopicSelect, [], "Loading subtopics…");
  if (!topicId) return;
  try {
    const subtopics = await getJson(`/api/education/math-question-bank/subtopics?grade=${formatGrade(grade)}&topic_id=${encodeURIComponent(topicId)}`);
    state.practiceSubtopics = subtopics || [];
    replaceOptions(subtopicSelect, state.practiceSubtopics.map((item) => ({
      label: `${item.subtopic || item.name || item.subtopic_id} · ${item.question_count ?? ""}`.replace(/\s·\s$/, ""),
      value: String(item.subtopic_id || item.id || ""),
    })), "Select a subtopic");
    setStatus($("#practiceStatus"), `${state.practiceSubtopics.length} subtopics available for ${topic?.name || "this topic"}.`, "success");
    if (restore) {
      const savedSubtopicId = sessionStorage.getItem(PRACTICE_SESSION_KEYS.subtopic) || "";
      if (savedSubtopicId && state.practiceSubtopics.some((item) => String(item.subtopic_id || item.id || "") === savedSubtopicId)) {
        subtopicSelect.value = savedSubtopicId;
        await loadPracticeQuestionList({ restore: true });
      }
    }
  } catch (error) {
    replaceOptions(subtopicSelect, [], "Subtopics could not be loaded");
    setStatus($("#practiceStatus"), error.message, "error");
  }
}

$("#practiceGrade").addEventListener("change", (event) => {
  state.grade = formatGrade(event.currentTarget.value);
  sessionStorage.setItem("sharperx_web_grade", String(state.grade));
  clearPracticeSessionSelection();
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.grade, String(state.grade));
  $("#globalGrade").value = String(state.grade);
  renderSourceLinks();
  loadPracticeTopics(state.grade);
});

$("#practiceTopic").addEventListener("change", async (event) => {
  const grade = formatGrade($("#practiceGrade").value);
  const topicId = event.currentTarget.value;
  state.practiceQuestions = [];
  state.currentPracticeQuestion = null;
  $("#practiceQuestionList").replaceChildren();
  $("#practiceQuestionCard").hidden = true;
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.grade, String(grade));
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.topic, topicId);
  sessionStorage.removeItem(PRACTICE_SESSION_KEYS.subtopic);
  sessionStorage.removeItem(PRACTICE_SESSION_KEYS.question);
  await loadPracticeSubtopics(grade, topicId);
});

$("#practiceSubtopic").addEventListener("change", (event) => {
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.grade, String(formatGrade($("#practiceGrade").value)));
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.topic, $("#practiceTopic").value);
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.subtopic, event.currentTarget.value);
  sessionStorage.removeItem(PRACTICE_SESSION_KEYS.question);
  state.practiceQuestions = [];
  state.currentPracticeQuestion = null;
  $("#practiceQuestionList").replaceChildren();
  $("#practiceQuestionCard").hidden = true;
});

async function loadAllQuestions(grade, topicId, subtopicId) {
  const pageSize = 5000;
  const questions = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({ grade: String(grade), topic_id: topicId, subtopic_id: subtopicId, limit: String(pageSize), offset: String(offset) });
    const page = await getJson(`/api/education/math-question-bank/questions?${params}`);
    if (!Array.isArray(page)) throw new Error("The question list could not be loaded. Please try again.");
    questions.push(...page);
    if (page.length < pageSize) break;
  }
  return questions;
}

async function loadPracticeQuestionList({ restore = false } = {}) {
  const grade = formatGrade($("#practiceGrade").value);
  const topicId = $("#practiceTopic").value;
  const subtopicId = $("#practiceSubtopic").value;
  if (!topicId || !subtopicId) {
    setStatus($("#practiceStatus"), "Select a topic and subtopic first.", "error");
    return;
  }
  const button = $("#loadPracticeQuestions");
  if (button) button.disabled = true;
  setStatus($("#practiceStatus"), "Loading questions…");
  try {
    state.practiceQuestions = await loadAllQuestions(grade, topicId, subtopicId);
    renderPracticeQuestionList();
    setStatus($("#practiceStatus"), `${state.practiceQuestions.length} questions loaded.`, "success");
    const savedQuestionId = restore ? sessionStorage.getItem(PRACTICE_SESSION_KEYS.question) : "";
    const selected = state.practiceQuestions.find((question) => String(question.question_id || question.bank_question_id || question.id || "") === String(savedQuestionId || ""));
    const question = selected || state.practiceQuestions[0];
    if (question) await selectPracticeQuestion(question);
  } catch (error) {
    setStatus($("#practiceStatus"), error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

$("#loadPracticeQuestions").addEventListener("click", () => loadPracticeQuestionList());

function questionLabel(question) {
  return question.accessible_text || question.question_text || question.text || "Question";
}

function displayStructuredContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(displayStructuredContent).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const parts = ["text", "hint", "guidance", "instruction", "formula_latex", "formula", "content"]
      .map((key) => value[key]).filter((item) => typeof item === "string" && item.trim());
    return parts.length ? parts.join("\n") : JSON.stringify(value);
  }
  return "";
}

function renderPracticeQuestionList() {
  const list = $("#practiceQuestionList");
  list.replaceChildren();
  state.practiceQuestions.forEach((question, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "question-list-button";
    button.dataset.questionId = question.question_id || question.bank_question_id || question.id || "";
    const title = document.createElement("strong");
    title.textContent = `Question ${index + 1} · ${question.marks || 0} marks`;
    const text = document.createElement("span");
    text.textContent = questionLabel(question);
    button.append(title, text);
    button.addEventListener("click", () => selectPracticeQuestion(question));
    list.append(button);
  });
}

function collectVisuals(question) {
  const visuals = Array.isArray(question.question_visuals) ? question.question_visuals : [];
  if (visuals.length) return visuals;
  if (question.diagram && typeof question.diagram === "object") return [{ role: "question", diagram: question.diagram }];
  return [];
}

function renderVisualReviewProgress(container) {
  container.replaceChildren();
  const status = document.createElement("div");
  status.className = "visual-review-progress";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.innerHTML = '<span class="visual-review-hourglass" aria-hidden="true">⌛</span><div class="visual-review-copy"><strong>Diagram being generated, please wait.</strong><span>Preparing a complete diagram for this question.</span></div><div class="visual-review-progress-track" aria-hidden="true"><span></span></div>';
  container.append(status);
}

const REQUIRED_QUESTION_VISUAL_REVIEW_VERSION = "2026-10-20.4";

function questionVisualCacheKey(question) {
  const id = question.question_id || question.bank_question_id || question.id;
  return id ? `sharperx_visual_${REQUIRED_QUESTION_VISUAL_REVIEW_VERSION}_${encodeURIComponent(id)}` : "";
}

function questionVisualCacheSignature(question) {
  return JSON.stringify({
    bank_version: question.bank_version || "",
    question_text: questionLabel(question),
    visuals: collectVisuals(question),
  });
}

function readCachedQuestionVisuals(question) {
  const key = questionVisualCacheKey(question);
  if (!key) return null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    if (cached?.signature !== questionVisualCacheSignature(question) || !Array.isArray(cached.visuals)) return null;
    if (missingQuestionGeometry(question, cached.visuals).length) {
      sessionStorage.removeItem(key);
      return null;
    }
    return cached.visuals;
  } catch {
    return null;
  }
}

function cacheQuestionVisuals(question, visuals) {
  const key = questionVisualCacheKey(question);
  if (!key || !Array.isArray(visuals)) return;
  try {
    sessionStorage.setItem(key, JSON.stringify({ signature: questionVisualCacheSignature(question), visuals }));
  } catch { /* The persistent API cache remains available when browser storage is full. */ }
}

function statedQuestionGeometry(question) {
  const text = questionLabel(question).replace(/\\(?:left|right)\b/g, "");
  const points = new Map();
  const coordinatePattern = /\b([A-Z])\s*\(\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*\)/g;
  for (const match of text.matchAll(coordinatePattern)) {
    points.set(match[1].toUpperCase(), { label: match[1].toUpperCase(), x: Number(match[2]), y: Number(match[3]) });
  }
  const segments = new Set();
  const segmentPattern = /\bperpendicular\s+to\s+(?:(?:line|segment)\s+)?([A-Z])\s*([A-Z])\b/gi;
  for (const match of text.matchAll(segmentPattern)) {
    segments.add([...match[1].toUpperCase() + match[2].toUpperCase()].sort().join(""));
  }
  return { points: [...points.values()], segments: [...segments] };
}

function missingQuestionGeometry(question, visuals) {
  const required = statedQuestionGeometry(question);
  if (!required.points.length && !required.segments.length) return [];

  const points = [];
  const segments = new Set();
  const number = (value) => (typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
  const list = (value) => Array.isArray(value) ? value : [];
  const pointName = (value) => {
    if (typeof value === "string") return value.trim().toUpperCase();
    if (value && typeof value === "object") return String(value.label || value.id || value.name || "").trim().toUpperCase();
    return "";
  };
  for (const visual of visuals || []) {
    const diagram = visual?.diagram || visual?.visual || visual || {};
    const shape = diagram.shape && typeof diagram.shape === "object" ? diagram.shape : {};
    const graph = diagram.graph && typeof diagram.graph === "object" ? diagram.graph : {};
    for (const candidate of [...list(shape.points), ...list(graph.points)]) {
      if (!candidate || typeof candidate !== "object") continue;
      points.push({
        label: pointName(candidate),
        x: number(candidate.x),
        y: number(candidate.y),
      });
    }
    const addCentre = (centre, fallbackLabel = "") => {
      if (Array.isArray(centre) && centre.length >= 2) {
        points.push({ label: fallbackLabel.toUpperCase(), x: number(centre[0]), y: number(centre[1]) });
      } else if (centre && typeof centre === "object") {
        points.push({
          label: pointName(centre) || fallbackLabel.toUpperCase(),
          x: number(centre.x),
          y: number(centre.y),
        });
      }
    };
    addCentre(shape.center ?? shape.centre, shape.center_label || shape.centre_label || "");
    for (const circle of [...list(shape.circles), ...list(graph.circles)]) {
      if (circle && typeof circle === "object") {
        addCentre(circle.center ?? circle.centre, circle.center_label || circle.centre_label || circle.label || "");
      }
    }
    for (const segment of [...list(shape.segments), ...list(graph.segments)]) {
      if (!segment || typeof segment !== "object") continue;
      const from = pointName(segment.from ?? segment.start);
      const to = pointName(segment.to ?? segment.end);
      if (from && to) segments.add([...from + to].sort().join(""));
    }
  }

  const missing = [];
  for (const expected of required.points) {
    const represented = points.some((point) => point.label === expected.label
      && point.x !== null && point.y !== null
      && Math.abs(point.x - expected.x) <= 1e-6
      && Math.abs(point.y - expected.y) <= 1e-6);
    if (!represented) missing.push(`point ${expected.label}(${expected.x};${expected.y})`);
  }
  for (const segment of required.segments) {
    if (!segments.has(segment)) missing.push(`segment ${segment}`);
  }
  return missing;
}

function diagramImageSource(visual, questionText = "") {
  const diagram = visual?.diagram || visual?.visual || visual || {};
  const base64 = diagram.image_base64 || diagram.png_base64 || visual?.image_base64 || "";
  if (base64) return base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  const svg = diagram.svg || diagram.svg_markup || visual?.svg;
  if (typeof svg === "string" && svg.includes("<svg")) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const url = diagram.image_url || diagram.url || visual?.image_url || visual?.url;
  if (typeof url === "string" && url.trim()) {
    try { return new URL(url, API_BASE_URL).href; } catch { return ""; }
  }
  const svgMarkup = structuredQuestionVisualSvg(visual, questionText);
  if (svgMarkup) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
  return "";
}

function structuredQuestionVisualSvg(visual, questionText = "") {
  const diagram = visual?.diagram || visual?.visual || visual || {};
  const kind = String(diagram.kind || "").toLowerCase();
  const graph = diagram.graph && typeof diagram.graph === "object" ? diagram.graph : {};
  const shape = diagram.shape && typeof diagram.shape === "object" ? diagram.shape : {};
  const graphCircles = Array.isArray(graph.circles) ? graph.circles : [];
  const shapeCircles = Array.isArray(shape.circles) ? shape.circles : [];
  const points = Array.isArray(graph.points) ? graph.points : Array.isArray(shape.points) ? shape.points : [];
  const segments = Array.isArray(graph.segments) ? graph.segments : Array.isArray(shape.segments) ? shape.segments : [];
  const isGraph = ["function_graph", "trig_graph"].includes(kind);
  const isGeometry = kind === "geometry_2d";
  if (!isGraph && !isGeometry) return "";

  const numberOrNull = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return null;
  };
  const readCentre = (circle, fallback) => {
    const value = circle?.centre ?? circle?.center ?? fallback;
    if (Array.isArray(value) && value.length >= 2) {
      const x = numberOrNull(value[0]); const y = numberOrNull(value[1]);
      return x === null || y === null ? null : { x, y, label: String(circle?.centre_label || circle?.center_label || circle?.label || "") };
    }
    if (value && typeof value === "object") {
      const x = numberOrNull(value.x); const y = numberOrNull(value.y);
      return x === null || y === null ? null : { x, y, label: String(value.label || circle?.centre_label || circle?.center_label || circle?.label || "") };
    }
    return null;
  };
  let circles = [];
  if (isGraph) {
    circles = graphCircles.map((circle) => ({
      ...readCentre(circle, null),
      radius: numberOrNull(circle?.radius),
    })).filter((circle) => circle.x !== undefined && circle.radius > 0);
  } else if (String(shape.type || "").toLowerCase() === "circle") {
    const centre = readCentre({}, shape.center);
    const rings = shapeCircles.length ? shapeCircles : [{ radius: shape.radius }];
    circles = rings.map((circle) => ({
      ...centre,
      radius: numberOrNull(circle?.radius),
      label: String(circle?.centre_label || centre?.label || ""),
    })).filter((circle) => circle.x !== undefined && circle.radius > 0);
  }
  const validPoints = points.map((point) => ({
    x: numberOrNull(point?.x), y: numberOrNull(point?.y), label: String(point?.label || "").trim(),
  })).filter((point) => point.x !== null && point.y !== null);
  if (!circles.length && !validPoints.length && !segments.length) return "";

  const contextText = String(questionText || visual?.question_text || "");
  const centreMatch = contextText.match(/\b([A-Z])\s+is\s+the\s+cent(?:re|er)\b/i);
  const defaultCentreLabel = centreMatch?.[1] || "C";
  circles = circles.map((circle) => ({ ...circle, label: circle.label || defaultCentreLabel }));
  const extentX = [];
  const extentY = [];
  circles.forEach((circle) => { extentX.push(circle.x - circle.radius, circle.x + circle.radius); extentY.push(circle.y - circle.radius, circle.y + circle.radius); });
  validPoints.forEach((point) => { extentX.push(point.x); extentY.push(point.y); });
  const fallbackMinX = extentX.length ? Math.min(...extentX) - 1 : -5;
  const fallbackMaxX = extentX.length ? Math.max(...extentX) + 1 : 5;
  const fallbackMinY = extentY.length ? Math.min(...extentY) - 1 : -5;
  const fallbackMaxY = extentY.length ? Math.max(...extentY) + 1 : 5;
  let xMin = numberOrNull(graph.x_min ?? shape.x_min) ?? fallbackMinX;
  let xMax = numberOrNull(graph.x_max ?? shape.x_max) ?? fallbackMaxX;
  let yMin = numberOrNull(graph.y_min ?? shape.y_min) ?? fallbackMinY;
  let yMax = numberOrNull(graph.y_max ?? shape.y_max) ?? fallbackMaxY;
  if (xMax <= xMin) { xMin -= 1; xMax += 1; }
  if (yMax <= yMin) { yMin -= 1; yMax += 1; }

  const width = 760; const height = 420;
  const plot = { x: 86, y: 48, width: 600, height: 310 };
  const scale = Math.min(plot.width / (xMax - xMin), plot.height / (yMax - yMin));
  const usedWidth = (xMax - xMin) * scale; const usedHeight = (yMax - yMin) * scale;
  const plotX = plot.x + (plot.width - usedWidth) / 2;
  const plotY = plot.y + (plot.height - usedHeight) / 2;
  const mapX = (x) => plotX + (x - xMin) * scale;
  const mapY = (y) => plotY + (yMax - y) * scale;
  const xAxisY = yMin <= 0 && yMax >= 0 ? mapY(0) : plotY + usedHeight;
  const yAxisX = xMin <= 0 && xMax >= 0 ? mapX(0) : plotX;
  const ticks = (source, min, max) => {
    const authored = Array.isArray(source) ? source.map(numberOrNull).filter((value) => value !== null && value >= min && value <= max) : [];
    if (authored.length) return [...new Set(authored)].sort((a, b) => a - b);
    return Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);
  };
  const xTicks = ticks(graph.x_ticks, xMin, xMax);
  const yTicks = ticks(graph.y_ticks, yMin, yMax);
  const xLabels = Array.isArray(graph.x_tick_labels) ? graph.x_tick_labels : [];
  const yLabels = Array.isArray(graph.y_tick_labels) ? graph.y_tick_labels : [];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>${escapeHtml(String(diagram.title || "Mathematical diagram"))}</title>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
  ];
  if (graph.show_grid === true) {
    xTicks.forEach((x) => parts.push(`<line x1="${mapX(x)}" y1="${plotY}" x2="${mapX(x)}" y2="${plotY + usedHeight}" stroke="#e5e7eb"/>`));
    yTicks.forEach((y) => parts.push(`<line x1="${plotX}" y1="${mapY(y)}" x2="${plotX + usedWidth}" y2="${mapY(y)}" stroke="#e5e7eb"/>`));
  }
  const axisStyle = 'stroke="#111827" stroke-width="2"';
  parts.push(`<line x1="${plotX}" y1="${xAxisY}" x2="${plotX + usedWidth}" y2="${xAxisY}" ${axisStyle}/>`,
    `<line x1="${yAxisX}" y1="${plotY + usedHeight}" x2="${yAxisX}" y2="${plotY}" ${axisStyle}/>`);
  if (graph.show_axis_tick_labels !== false && graph.show_axis_numbers !== false) {
    xTicks.forEach((value, index) => {
      const x = mapX(value); const label = String(xLabels[index] ?? Number(value.toFixed(3)));
      parts.push(`<line x1="${x}" y1="${xAxisY - 4}" x2="${x}" y2="${xAxisY + 4}" stroke="#111827"/>`,
        `<text x="${x}" y="${Math.min(height - 25, xAxisY + 21)}" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="#111827">${escapeHtml(label)}</text>`);
    });
    yTicks.forEach((value, index) => {
      const y = mapY(value); const label = String(yLabels[index] ?? Number(value.toFixed(3)));
      parts.push(`<line x1="${yAxisX - 4}" y1="${y}" x2="${yAxisX + 4}" y2="${y}" stroke="#111827"/>`,
        `<text x="${yAxisX - 9}" y="${y + 4}" text-anchor="end" font-family="Georgia,serif" font-size="12" fill="#111827">${escapeHtml(label)}</text>`);
    });
  }
  parts.push(`<text x="${plotX + usedWidth + 12}" y="${xAxisY + 5}" font-family="Georgia,serif" font-size="16" fill="#111827">${escapeHtml(String(graph.x_label || "x"))}</text>`,
    `<text x="${yAxisX - 7}" y="${Math.max(18, plotY - 8)}" font-family="Georgia,serif" font-size="16" fill="#111827">${escapeHtml(String(graph.y_label || "y"))}</text>`);

  circles.forEach((circle) => parts.push(`<circle cx="${mapX(circle.x)}" cy="${mapY(circle.y)}" r="${circle.radius * scale}" fill="none" stroke="#111827" stroke-width="2.4"/>`));
  const namedPoints = new Map();
  circles.forEach((circle) => namedPoints.set(circle.label.toUpperCase(), { x: circle.x, y: circle.y, label: circle.label, isCentre: true }));
  validPoints.forEach((point) => { if (point.label) namedPoints.set(point.label.toUpperCase(), point); });
  segments.forEach((segment) => {
    const from = String(segment?.from || segment?.start || "").toUpperCase();
    const to = String(segment?.to || segment?.end || "").toUpperCase();
    const a = namedPoints.get(from); const b = namedPoints.get(to);
    if (a && b) parts.push(`<line x1="${mapX(a.x)}" y1="${mapY(a.y)}" x2="${mapX(b.x)}" y2="${mapY(b.y)}" stroke="#111827" stroke-width="2.2"/>`);
  });
  const pair = contextText.match(/\bperpendicular\s+to\s+([A-Z])([A-Z])\b/i);
  if (pair && namedPoints.has(pair[1].toUpperCase()) && namedPoints.has(pair[2].toUpperCase()) && !segments.length) {
    const a = namedPoints.get(pair[1].toUpperCase()); const b = namedPoints.get(pair[2].toUpperCase());
    parts.push(`<line x1="${mapX(a.x)}" y1="${mapY(a.y)}" x2="${mapX(b.x)}" y2="${mapY(b.y)}" stroke="#111827" stroke-width="2.2"/>`);
  }
  const allPoints = [...circles.map((circle) => ({ x: circle.x, y: circle.y, label: circle.label })), ...validPoints];
  const drawn = new Set();
  allPoints.forEach((point) => {
    const key = `${point.x}:${point.y}`;
    if (drawn.has(key)) return;
    drawn.add(key);
    const x = mapX(point.x); const y = mapY(point.y); const label = point.label || "";
    parts.push(`<circle cx="${x}" cy="${y}" r="4.2" fill="#fff" stroke="#111827" stroke-width="2"/>`);
    if (label) parts.push(`<text x="${x + 9}" y="${y - 8}" font-family="Georgia,serif" font-size="15" fill="#111827">${escapeHtml(label)}</text>`);
  });
  parts.push("</svg>");
  return parts.join("");
}

async function preparePracticeVisuals(question) {
  const sourceVisuals = collectVisuals(question);
  const questionId = question.question_id || question.bank_question_id || question.id;
  const sessionCachedVisuals = readCachedQuestionVisuals(question);
  if (sessionCachedVisuals !== null) return { visuals: sessionCachedVisuals, reviewMessage: "" };
  if (!questionId) {
    return {
      visuals: [],
      reviewMessage: sourceVisuals.length ? "The diagram is still being prepared. Please try again shortly." : "",
    };
  }

  try {
    const prepared = await postJson(`/api/education/math-question-bank/questions/${encodeURIComponent(questionId)}/visuals/prepare`, {});
    let returnedVisuals = null;
    if (Array.isArray(prepared.question_visuals)) returnedVisuals = prepared.question_visuals;
    else if (Array.isArray(prepared.visuals)) returnedVisuals = prepared.visuals;
    else if (prepared.diagram) returnedVisuals = [{ role: "question", diagram: prepared.diagram }];

    const status = String(prepared.refinement_status || "unknown").toLowerCase();
    const visuals = returnedVisuals ?? [];
    const requirements = statedQuestionGeometry(question);
    const hasExplicitGeometry = requirements.points.length > 0 || requirements.segments.length > 0;
    const completeStatuses = ["verified", "corrected", "generated", "cached"];
    const completeBankFallback = ["unavailable", "validation_failed", "fallback"].includes(status) && visuals.length > 0;

    if (hasExplicitGeometry) {
      const missing = missingQuestionGeometry(question, visuals);
      if (missing.length) {
        return {
          visuals: [],
          reviewMessage: "The diagram is still being prepared. Please try again shortly.",
        };
      }
      if (prepared.refinement_version !== REQUIRED_QUESTION_VISUAL_REVIEW_VERSION
        || (!completeStatuses.includes(status) && !completeBankFallback)) {
        return {
          visuals: [],
          reviewMessage: "Diagram being generated, please wait.",
        };
      }
    }

    if (status === "not_required") return { visuals, reviewMessage: "" };
    if (completeStatuses.includes(status) || completeBankFallback) {
      if (prepared.refinement_version !== REQUIRED_QUESTION_VISUAL_REVIEW_VERSION || returnedVisuals === null) {
        return {
          visuals: [],
          reviewMessage: "The diagram is still being prepared. Please try again shortly.",
        };
      }
      cacheQuestionVisuals(question, visuals);
      return { visuals, reviewMessage: visuals.length ? "" : "No diagram is needed for this question." };
    }

    return { visuals: [], reviewMessage: "The diagram is still being prepared. Please try again shortly." };
  } catch {
    return {
      visuals: [],
      reviewMessage: "The diagram is still being prepared. Please try again shortly.",
    };
  }
}

async function selectPracticeQuestion(question) {
  realtimeTutor.stopIfContext("practice");
  state.currentPracticeQuestion = question;
  const questionId = String(question.question_id || question.bank_question_id || question.id || "");
  state.practiceInspectionId = sessionStorage.getItem(practiceQuestionStorageKey(PRACTICE_SESSION_KEYS.inspectionPrefix, questionId)) || "";
  const storedPhotoIds = sessionStorage.getItem(practiceQuestionStorageKey(PRACTICE_SESSION_KEYS.photosPrefix, questionId));
  try { state.practiceAnswerPhotoIds = storedPhotoIds ? JSON.parse(storedPhotoIds).filter((id) => typeof id === "string" && id) : []; }
  catch { state.practiceAnswerPhotoIds = []; }
  state.practiceAnswerPhotoPreviews.forEach((item) => URL.revokeObjectURL(item.url));
  state.practiceAnswerPhotoPreviews = [];
  renderPracticeAnswerAttachments();
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.grade, String(formatGrade($("#practiceGrade").value)));
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.topic, $("#practiceTopic").value);
  sessionStorage.setItem(PRACTICE_SESSION_KEYS.subtopic, $("#practiceSubtopic").value);
  if (questionId) sessionStorage.setItem(PRACTICE_SESSION_KEYS.question, questionId);
  else sessionStorage.removeItem(PRACTICE_SESSION_KEYS.question);
  state.hintIndex = 0;
  state.practiceVisuals = collectVisuals(question);
  $("#practiceQuestionCard").hidden = false;
  $("#practiceQuestionMeta").textContent = `Grade ${question.grade || $("#practiceGrade").value} · ${question.topic || "Mathematics"} · ${question.subtopic || $("#practiceSubtopic").selectedOptions[0]?.textContent || ""} · ${question.marks || 0} marks`;
  renderMath($("#practiceQuestionText"), questionLabel(question));
  $("#practiceHints").hidden = true;
  $("#practiceHints").textContent = "";
  $("#practiceHintButton").textContent = "Show a hint";
  practiceEditorCommand({ name: "clear" });
  $("#practiceFeedback").hidden = true;
  $("#practiceFeedback").replaceChildren();
  $("#practiceFullScreen").hidden = true;
  $("#practiceVisuals").replaceChildren();
  $$(".question-list-button").forEach((button) => button.classList.toggle("is-active", button.dataset.questionId === questionId));
  $("#practiceMarkStatus").textContent = "";
  $("#practiceVoiceReview").hidden = true;
  $("#practiceVoiceTranscript").value = "";
  $("#practiceVoiceMath").value = "";

  if (question.question_id || question.bank_question_id || question.id || collectVisuals(question).length) {
    const locallyCachedVisuals = readCachedQuestionVisuals(question);
    if (locallyCachedVisuals !== null) {
      state.practiceVisuals = locallyCachedVisuals;
      renderQuestionVisuals($("#practiceVisuals"), state.practiceVisuals, `Grade ${question.grade || state.grade} question diagram`, questionLabel(question));
    } else {
      renderVisualReviewProgress($("#practiceVisuals"));
      const visualReview = await preparePracticeVisuals(question);
      if (state.currentPracticeQuestion !== question) return;
      state.practiceVisuals = visualReview.visuals;
      renderQuestionVisuals($("#practiceVisuals"), state.practiceVisuals, `Grade ${question.grade || state.grade} question diagram`, questionLabel(question), visualReview.reviewMessage);
    }
    const hasImage = $$("img", $("#practiceVisuals")).length > 0;
    $("#practiceFullScreen").hidden = !hasImage;
  }
}

function renderQuestionVisuals(container, visuals, title, questionText = "", reviewMessage = "") {
  container.replaceChildren();
  if (reviewMessage) {
    const status = document.createElement("p");
    status.className = "visual-review-status muted";
    status.textContent = reviewMessage;
    container.append(status);
  }
  for (const visual of visuals || []) {
    const imageSource = diagramImageSource(visual, questionText);
    if (imageSource) {
      const image = document.createElement("img");
      image.src = imageSource;
      image.alt = visual.accessibility_text || visual.diagram?.accessibility_text || visual.title || title;
      image.addEventListener("click", () => openImageViewer(imageSource, image.alt));
      container.append(image);
    } else {
      const description = visual.accessibility_text || visual.diagram?.accessibility_text || visual.title || visual.diagram?.title;
      if (description) {
        const paragraph = document.createElement("p");
        paragraph.className = "visual-description";
        paragraph.textContent = description;
        container.append(paragraph);
      }
    }
  }
}

$("#practiceFullScreen").addEventListener("click", () => {
  const image = $("#practiceVisuals img");
  if (image) openImageViewer(image.src, image.alt || "Question diagram");
});

$("#practiceHintButton").addEventListener("click", () => {
  const question = state.currentPracticeQuestion;
  if (!question) return;
  const hints = Array.isArray(question.subquestion_hints) ? question.subquestion_hints.filter((hint) => hint && typeof hint === "object") : [];
  const progressive = Array.isArray(question.progressive_hints) ? question.progressive_hints : [];
  const total = hints.length || progressive.length;
  if (!total) {
    $("#practiceHints").hidden = false;
    renderMath($("#practiceHints"), "No hints are available for this question.");
    return;
  }
  const index = state.hintIndex % total;
  let content = "";
  if (hints.length) {
    const hint = hints[index];
    const partId = String(hint.subquestion_id || hint.part_id || "").trim();
    const formula = displayStructuredContent(hint.related_formula || hint.formula || question.relevant_formulas?.[0] || "Use the rule or formula named for this part of the question.");
    const steps = Array.isArray(hint.steps) ? hint.steps.map(displayStructuredContent).filter(Boolean) : [];
    content = `Hint ${index + 1} of ${total}${partId ? ` · Part (${partId})` : ""}\n${displayStructuredContent(hint.text || hint.hint || hint.guidance)}\n\nFormula: ${formula}`;
    if (steps.length) content += `\n\nSteps to try:\n${steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join("\n")}`;
    else content += "\n\nSteps to try:\n1. Write the values given in this part and identify the quantity requested.\n2. Choose the displayed rule, substitute the values, and show one step per line.";
  } else {
    content = `Hint ${index + 1} of ${total}: ${displayStructuredContent(progressive[index])}`;
  }
  $("#practiceHints").hidden = false;
  renderMath($("#practiceHints"), content);
  state.hintIndex = (index + 1) % total;
  $("#practiceHintButton").textContent = state.hintIndex === 0 ? "Show a hint" : "Show next hint";
});

$("#practiceFormulaButton").addEventListener("click", () => {
  const question = state.currentPracticeQuestion;
  const formulas = Array.isArray(question?.relevant_formulas) ? question.relevant_formulas : [];
  const partFormulas = Array.isArray(question?.subquestion_hints)
    ? question.subquestion_hints.map((hint) => hint?.related_formula).filter(Boolean)
    : [];
  const allFormulas = [...new Set([...partFormulas, ...formulas].map(displayStructuredContent).filter(Boolean))];
  const content = allFormulas.length ? allFormulas.map((formula, index) => `${allFormulas.length > 1 ? `Option ${index + 1}: ` : "Formula: "}${formula}`).join("\n\n") : "No specific formula is listed for this question. Use the relevant definition or theorem named in the question.";
  $("#practiceHints").hidden = false;
  renderMath($("#practiceHints"), content);
});

$("#practiceCanvasButton").addEventListener("click", () => openCanvas("practice", state.currentPracticeQuestion));
$("#practiceGraphCanvasButton").addEventListener("click", () => openCanvas("practice-graph", state.currentPracticeQuestion));

const practiceMathEditorFrame = $("#practiceMathEditor");
function practiceEditorCommand(command) {
  const editor = practiceMathEditorFrame?.contentWindow?.SharperMathEditor;
  if (!editor?.execute) return false;
  editor.execute(command);
  return true;
}

function initializePracticeMathEditor() {
  const editorWindow = practiceMathEditorFrame?.contentWindow;
  if (!editorWindow?.SharperMathEditor?.execute) return false;
  state.practiceEditorReady = true;
  try { editorWindow.document.querySelector(".editor-surface")?.setAttribute("inputmode", "none"); } catch { /* Same-origin editor attributes are optional. */ }
  editorWindow.SharperMathEditor.execute({ name: "loadLatex", value: "" });
  editorWindow.SharperMathEditor.execute({ name: "setLineLabels", value: "true" });
  editorWindow.SharperMathEditor.execute({ name: "setPlaceholder", value: "Enter each step on a new line. Keep your final answer last." });
  editorWindow.SharperMathEditor.execute({ name: "setFontSize", value: "23" });
  editorWindow.SharperMathEditor.execute({ name: "setPhysicalKeyboardEnabled", value: "true" });
  return true;
}

practiceMathEditorFrame.addEventListener("load", initializePracticeMathEditor);
window.addEventListener("message", (event) => {
  if (event.source !== practiceMathEditorFrame.contentWindow || event.data?.type !== "sharper-math-editor-state") return;
  state.practiceEditorState = event.data.state || null;
  if (!state.practiceEditorReady && event.data.state?.event === "ready") initializePracticeMathEditor();
  if (event.data.state?.event === "activate") {
    setPracticeKeyboardVisible(true);
    deviceRemoteNotifyFocus(practiceMathEditorFrame);
  } else if (deviceRemoteSession && deviceRemoteTargetFrame === practiceMathEditorFrame) deviceRemoteNotifyFocus(practiceMathEditorFrame);
});

function getPracticeEditorLatex() {
  try { return practiceMathEditorFrame.contentWindow.SharperMathEditor.getLatex() || ""; }
  catch { return state.practiceEditorState?.latex || ""; }
}

const keyText = (label, value = label) => ({ label, command: "insertText", value });
const keyCommand = (label, command, value = "") => ({ label, command, value });
const PRACTICE_MATH_KEYSETS = {
  Alphabet: [
    ..."qwertyuiopasdfghjklzxcvbnm".split("").map((letter) => keyText(letter)),
    keyText("Space", " "), keyText(","), keyText("."), keyText("−", "−"), keyText("="), keyText("(") , keyText(")"),
  ],
  Basic: [
    ...["7", "8", "9", "4", "5", "6", "1", "2", "3", "0"].map((value) => keyText(value)),
    ...["+", "−", "×", "÷", "=", "≠", "<", "≤", ">", "≥", "±", "≈", "(", ")", ",", ";", "π", "∞"].map((value) => keyText(value)),
    keyCommand("a⁄b", "insertFraction"), keyCommand("√□", "insertRoot"), keyCommand("ⁿ√□", "insertNthRoot"),
    keyCommand("xʸ", "insertPower"), keyCommand("□²", "insertFixedPower", "2"), keyCommand("□³", "insertFixedPower", "3"),
    keyCommand("aₙ", "insertSubscript"), keyCommand("|x|", "insertAbsolute"), keyCommand("log₍□₎", "insertLogarithm"), keyCommand("n!", "insertFactorial"),
  ],
  Advanced: [
    ...["sin", "cos", "tan", "csc", "sec", "cot", "arcsin", "arccos", "arctan"].map((name) => keyCommand(name, "insertFunction", name)),
    ...["θ", "π", "°", "x", "y", "=", "±", "∠", "⊥", "∥"].map((value) => keyText(value)),
    keyCommand("√□", "insertRoot"), keyCommand("xʸ", "insertPower"), keyCommand("a⁄b", "insertFraction"),
  ],
  Calculus: [
    keyCommand("d/dx", "insertDerivative", "1"), keyCommand("d²/dx²", "insertDerivative", "2"),
    keyCommand("lim", "insertLimit"), keyCommand("lim→+", "insertLimit", "right"), keyCommand("lim→−", "insertLimit", "left"),
    keyCommand("∫", "insertIntegral"), keyCommand("∫ᵃ_b", "insertIntegral", "definite"), keyCommand("∫dx", "insertIntegral", "dx"),
    keyCommand("Σ", "insertLargeOperator", "sum"), keyCommand("Π", "insertLargeOperator", "product"),
    ...["∞", "π", "x", "y", "e", "+", "−", "="].map((value) => keyText(value)),
  ],
  Greek: [..."αβγδεζηθικλμνξοπρστυφχψω".split("").map((value) => keyText(value)), ..."ΓΔΘΛΞΠΣΦΨΩ".split("").map((value) => keyText(value))],
  Shorthand: [...["∠", "⊥", "∥", "∴", "∵", "⇒", "⇔", "→", "↔", "≡", "≅", "≈", "∝", "∈", "∉", "⊂", "⊆", "∪", "∩", "∅", "ℝ", "ℕ", "ℤ", "ℚ", "∀", "∃", "△", "≤", "≥", "≠", "±"].map((value) => keyText(value))],
};

function renderPracticeMathKeys(mode = state.practiceKeyboardMode) {
  state.practiceKeyboardMode = mode in PRACTICE_MATH_KEYSETS ? mode : "Alphabet";
  $$("[data-keyboard-mode]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.keyboardMode === state.practiceKeyboardMode)));
  const host = $("#practiceMathKeys");
  host.replaceChildren();
  for (const key of PRACTICE_MATH_KEYSETS[state.practiceKeyboardMode]) {
    const button = document.createElement("button");
    button.type = "button";
    const label = document.createElement("span");
    label.textContent = key.label;
    button.append(label);
    button.setAttribute("aria-label", key.label === "Space" ? "Insert a space" : `Insert ${key.label}`);
    if (key.label === "Space") button.classList.add("is-space");
    if (key.label.length >= 5) button.classList.add("is-long-label");
    if (key.label.length >= 7) button.classList.add("is-extra-long-label");
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => practiceEditorCommand({ name: key.command, value: key.value }));
    host.append(button);
  }
}

renderPracticeMathKeys();
function setPracticeKeyboardVisible(visible) {
  const keyboard = $("#practiceMathKeyboard");
  const toggle = $("#practiceKeyboardToggle");
  keyboard.hidden = !visible;
  toggle.setAttribute("aria-expanded", String(visible));
}

$("#practiceKeyboardToggle").addEventListener("click", () => {
  setPracticeKeyboardVisible($("#practiceMathKeyboard").hidden);
});
$(".math-keyboard-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-keyboard-mode]");
  if (tab) renderPracticeMathKeys(tab.dataset.keyboardMode);
});
$(".math-keyboard-actions").addEventListener("pointerdown", (event) => event.preventDefault());
$(".math-keyboard-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-editor-action]");
  if (button) practiceEditorCommand({ name: button.dataset.editorAction });
});

function setPracticeVoiceTranscript(transcript) {
  state.practiceVoiceTranscript = String(transcript || "").trim();
  $("#practiceVoiceTranscript").value = state.practiceVoiceTranscript;
  $("#practiceVoiceReview").hidden = false;
  $("#practiceVoiceTranscript").focus({ preventScroll: true });
  setStatus($("#practiceVoiceStatus"), state.practiceVoiceTranscript ? "Review and edit the transcript, then use it in your working." : "No words were recognized. Try recording again.", state.practiceVoiceTranscript ? "success" : "error");
}

async function recordPracticeVoiceNote() {
  const button = $("#practiceVoiceButton");
  const status = $("#practiceVoiceStatus");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    if (state.practiceVoiceRecorder instanceof SpeechRecognition) {
      state.practiceVoiceRecorder.stop();
      button.classList.remove("is-recording");
      setStatus(status, "Voice note ready. Review the transcript below.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-ZA";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index++) transcript += event.results[index][0]?.transcript || "";
      state.practiceVoiceTranscript = transcript.trim();
      $("#practiceVoiceTranscript").value = state.practiceVoiceTranscript;
      $("#practiceVoiceReview").hidden = false;
    };
    recognition.onerror = (event) => setStatus(status, event.error === "not-allowed" ? "Allow microphone access in your browser settings." : `Voice input: ${event.error}`, "error");
    recognition.onend = () => {
      if (state.practiceVoiceRecorder === recognition) state.practiceVoiceRecorder = null;
      button.classList.remove("is-recording");
      if (state.practiceVoiceTranscript) setStatus(status, "Voice note ready. Review the transcript below.", "success");
    };
    try {
      state.practiceVoiceTranscript = "";
      $("#practiceVoiceTranscript").value = "";
      $("#practiceVoiceReview").hidden = false;
      state.practiceVoiceRecorder = recognition;
      recognition.start();
      button.classList.add("is-recording");
      setStatus(status, "Listening… select Voice again when you are finished.");
    } catch (error) {
      state.practiceVoiceRecorder = null;
      setStatus(status, error.message, "error");
    }
    return;
  }

  if (state.practiceVoiceRecorder?.state === "recording") {
    state.practiceVoiceRecorder.stop();
    button.classList.remove("is-recording");
    setStatus(status, "Transcribing voice note…");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus(status, "Voice recording is not supported by this browser. Use the editor or upload a photo of your work.", "error");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      state.practiceVoiceRecorder = null;
      try {
        const type = recorder.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const file = new File([new Blob(chunks, { type })], `practice-voice-note.${ext}`, { type });
        const form = new FormData();
        form.set("audio", file);
        const result = await uploadForm("/api/education/speech/transcribe", form);
        setPracticeVoiceTranscript(result.transcript || result.text || result.transcription || "");
      } catch (error) { setStatus(status, error.message, "error"); }
    };
    state.practiceVoiceRecorder = recorder;
    recorder.start();
    button.classList.add("is-recording");
    setStatus(status, "Recording… select Voice again when you are finished.");
  } catch (error) {
    setStatus(status, error.name === "NotAllowedError" ? "Allow microphone access in your browser settings." : error.message, "error");
  }
}

$("#practiceVoiceButton").addEventListener("click", recordPracticeVoiceNote);
$("#practiceVoiceTranscript").addEventListener("input", (event) => { state.practiceVoiceTranscript = event.currentTarget.value; });
$("#practiceVoiceMath").addEventListener("input", (event) => { state.practiceVoiceMath = event.currentTarget.value; });
$("#practiceFormatVoiceMath").addEventListener("click", async () => {
  const transcript = $("#practiceVoiceTranscript").value.trim();
  if (!transcript) return setStatus($("#practiceVoiceStatus"), "Record a voice note or enter the transcript first.", "error");
  const button = $("#practiceFormatVoiceMath");
  button.disabled = true;
  setStatus($("#practiceVoiceStatus"), "Formatting the spoken maths…");
  try {
    const result = await postJson("/api/education/speech/format-math", { text: transcript, subject: "Mathematics" });
    const formatted = String(result.mathematical_text || "").trim();
    if (!formatted) throw new Error("The mathematical form could not be prepared. Edit it below or use the transcript.");
    state.practiceVoiceMath = formatted;
    $("#practiceVoiceMath").value = formatted;
    setStatus($("#practiceVoiceStatus"), "Mathematical form ready. Review it before using it.", "success");
  } catch (error) { setStatus($("#practiceVoiceStatus"), error.message, "error"); }
  finally { button.disabled = false; }
});
function insertPracticeVoiceValue(value, command = "insertText") {
  const content = String(value || "").trim();
  if (!content) return setStatus($("#practiceVoiceStatus"), "Enter or format a voice response first.", "error");
  if (getPracticeEditorLatex().trim()) practiceEditorCommand({ name: "newLine" });
  practiceEditorCommand({ name: command, value: content });
  $("#practiceVoiceReview").hidden = true;
  setStatus($("#practiceVoiceStatus"), "Added to your working.", "success");
}
$("#practiceUseVoiceTranscript").addEventListener("click", () => insertPracticeVoiceValue($("#practiceVoiceTranscript").value));
$("#practiceUseVoiceMath").addEventListener("click", () => insertPracticeVoiceValue($("#practiceVoiceMath").value, "insertLatex"));
$("#practiceDismissVoice").addEventListener("click", () => { $("#practiceVoiceReview").hidden = true; setStatus($("#practiceVoiceStatus"), ""); });

function renderPracticeAnswerAttachments() {
  const host = $("#practiceAnswerAttachments");
  if (!host) return;
  host.replaceChildren();
  state.practiceAnswerPhotoIds.forEach((id) => {
    const preview = state.practiceAnswerPhotoPreviews.find((item) => item.id === id);
    const card = document.createElement("div");
    card.className = "practice-attachment";
    if (preview?.url) {
      const image = document.createElement("img");
      image.src = preview.url;
      image.alt = "Uploaded handwritten working";
      card.append(image);
    } else {
      const label = document.createElement("span");
      label.textContent = "Handwritten work attached";
      label.style.cssText = "display:grid;place-items:center;height:100%;padding:5px;text-align:center;font-size:10px";
      card.append(label);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove this handwritten image from the attempt");
    remove.addEventListener("click", () => {
      state.practiceAnswerPhotoIds = state.practiceAnswerPhotoIds.filter((photoId) => photoId !== id);
      state.practiceAnswerPhotoPreviews = state.practiceAnswerPhotoPreviews.filter((item) => {
        if (item.id !== id) return true;
        URL.revokeObjectURL(item.url);
        return false;
      });
      const key = practiceQuestionStorageKey(PRACTICE_SESSION_KEYS.photosPrefix);
      if (key) sessionStorage.setItem(key, JSON.stringify(state.practiceAnswerPhotoIds));
      renderPracticeAnswerAttachments();
    });
    card.append(remove);
    host.append(card);
  });
}

$("#practiceHandwritingButton").addEventListener("click", () => $("#practiceHandwritingInput").click());
$("#practiceHandwritingInput").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) return setStatus($("#practiceMarkStatus"), "Choose an image file of your handwritten work.", "error");
  if (state.practiceAnswerPhotoIds.length >= 3) return setStatus($("#practiceMarkStatus"), "The limit is three handwritten images per practice attempt.", "error");
  try {
    setStatus($("#practiceMarkStatus"), `Uploading ${file.name}…`);
    const inspectionId = await ensureInspection("practice");
    const form = new FormData();
    form.set("photo_type", "school_answer_working");
    form.set("photo", file, file.name);
    const uploaded = await uploadForm(`/api/inspections/${encodeURIComponent(inspectionId)}/upload-photo`, form);
    const photoId = String(uploaded.id || uploaded.photo_id || "");
    if (!photoId) throw new Error("The handwritten image was not attached. Please try again.");
    state.practiceAnswerPhotoIds.push(photoId);
    state.practiceAnswerPhotoPreviews.push({ id: photoId, url: URL.createObjectURL(file) });
    const key = practiceQuestionStorageKey(PRACTICE_SESSION_KEYS.photosPrefix);
    if (key) sessionStorage.setItem(key, JSON.stringify(state.practiceAnswerPhotoIds));
    renderPracticeAnswerAttachments();
    setStatus($("#practiceMarkStatus"), "Handwritten work attached to this question.", "success");
  } catch (error) { setStatus($("#practiceMarkStatus"), error.message, "error"); }
});

$("#markPracticeAnswer").addEventListener("click", async () => {
  const question = state.currentPracticeQuestion;
  const working = getPracticeEditorLatex().trim();
  if (!question) return;
  if (!working && !state.practiceAnswerPhotoIds.length) return setStatus($("#practiceMarkStatus"), "Enter your working, write on the canvas, or upload a handwritten answer before sending it for marking.", "error");
  const button = $("#markPracticeAnswer");
  button.disabled = true;
  setStatus($("#practiceMarkStatus"), "Marking your attempt…");
  try {
    const markingContext = {
      question_id: question.question_id,
      bank_version: question.bank_version || "",
      subject: "Mathematics",
      grade: question.grade || state.grade,
      topic: question.topic || "",
      question_text: questionLabel(question),
      marks: question.marks || 0,
      learner_working: working,
      learner_final_answer: lastNonEmptyLine(working) || working,
      assistance_mode: state.hintIndex ? "Hints" : "SolveItMyself",
      hints_used: state.hintIndex,
      photo_ids: [...state.practiceAnswerPhotoIds],
    };
    let result;
    if (state.practiceAnswerPhotoIds.length) {
      result = await postJson("/api/education/tutor/ask", {
        subject: "Mathematics", grade: question.grade || state.grade,
        topic: question.topic || "", question: questionLabel(question),
        learner_answer: working || "My complete working and answer are in the attached handwritten image.",
        mode: "mark_attempt", inspection_id: state.practiceInspectionId,
        ai_tier: "luna", allow_web_search: false,
        math_practice_context: markingContext,
      });
    } else {
      result = await postJson("/api/education/math-practice/mark", markingContext);
    }
    requireLunaXhigh(result, "Practice marking");
    const reportText = readMarkingText(result);
    const panel = $("#practiceFeedback");
    panel.hidden = false;
    panel.replaceChildren();
    const title = document.createElement("h3");
    const earned = result.marks_earned ?? result.awarded_marks ?? result.marks_awarded ?? result.score ?? result.marking_feedback?.marks_awarded;
    const maximum = result.total_marks ?? result.maximum_marks ?? result.max_marks ?? result.marking_feedback?.marks_available ?? question.marks;
    title.textContent = Number.isFinite(Number(earned)) ? `Result: ${earned} / ${maximum}` : "Feedback";
    const body = document.createElement("div");
    body.className = "math-content";
    renderMath(body, reportText);
    const save = document.createElement("button");
    save.className = "button secondary";
    save.type = "button";
    save.textContent = "Save PDF report";
    save.addEventListener("click", () => saveReport(`Grade ${question.grade || state.grade} practice`, `${questionLabel(question)}\n\nYour working:\n${working}`, reportText));
    panel.append(title, body, save);
    setStatus($("#practiceMarkStatus"), "Attempt marked.", "success");
  } catch (error) {
    setStatus($("#practiceMarkStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

function readMarkingText(result) {
  const parts = [];
  if (typeof result.assistant_message === "string" && result.assistant_message.trim()) parts.push(result.assistant_message.trim());
  if (result.marking_feedback && typeof result.marking_feedback === "object") {
    const summary = result.marking_feedback;
    for (const key of ["feedback", "what_was_correct", "answer_analysis"]) if (summary[key]) parts.push(String(summary[key]));
    for (const key of ["corrections", "incomplete_reasons"]) if (Array.isArray(summary[key]) && summary[key].length) parts.push(summary[key].map(String).join("\n"));
  }
  for (const key of ["feedback", "diagnosis", "correction", "solution", "worked_solution", "next_step", "worked_solution_steps"]) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
    else if (Array.isArray(value)) parts.push(value.map((item) => typeof item === "string" ? item : item.text || item.step || JSON.stringify(item)).join("\n"));
  }
  if (parts.length) return [...new Set(parts)].join("\n\n");
  return JSON.stringify(result, null, 2);
}

function openReportsDatabase() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("This browser does not support local saved reports."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sharperx-web-reports", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("reports")) request.result.createObjectStore("reports", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Saved reports could not be opened."));
  });
}

function reportTransaction(mode, operation) {
  return dbPromise.then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction("reports", mode);
    const result = operation(transaction.objectStore("reports"));
    transaction.oncomplete = () => resolve(result && result.result);
    transaction.onerror = () => reject(transaction.error || new Error("The report could not be saved."));
    transaction.onabort = () => reject(transaction.error || new Error("The report could not be saved."));
  }));
}

function safeFileName(value) {
  return String(value || "sharperx-report").normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "sharperx-report";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function saveReport(title, question, response) {
  const body = (question || "") + "\n\nFeedback and worked solution\n\n" + (response || "");
  try {
    const pdf = await apiRequest("/api/study-exports/pdf", {
      method: "POST",
      body: JSON.stringify({ title, subtitle: "Saved " + new Date().toLocaleString(), body: body.trim() }),
      responseType: "blob",
    });
    const id = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2);
    await reportTransaction("readwrite", (store) => store.put({ id, title, createdAt: new Date().toISOString(), pdf }));
    downloadBlob(pdf, safeFileName(title) + ".pdf");
    showToast("PDF report saved on this device.");
    if (state.view === "reports") loadSavedReports();
  } catch (error) {
    showToast("Could not save the report: " + error.message);
  }
}

async function loadSavedReports() {
  const host = $("#savedReports");
  if (!host) return;
  host.replaceChildren();
  try {
    const reports = await reportTransaction("readonly", (store) => store.getAll());
    reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!reports.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No saved reports on this device yet. Save a marking or tutor response as a PDF to see it here.";
      host.append(empty);
      return;
    }
    reports.forEach((report) => {
      const card = document.createElement("article");
      card.className = "saved-report-card";
      const heading = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = report.title;
      const date = document.createElement("small");
      date.textContent = new Date(report.createdAt).toLocaleString();
      heading.append(name, date);
      const actions = document.createElement("div");
      actions.className = "saved-report-actions";
      const open = document.createElement("button");
      open.className = "button subtle";
      open.type = "button";
      open.textContent = "Open";
      open.addEventListener("click", () => window.open(URL.createObjectURL(report.pdf), "_blank", "noopener"));
      const download = document.createElement("button");
      download.className = "button secondary";
      download.type = "button";
      download.textContent = "Download";
      download.addEventListener("click", () => downloadBlob(report.pdf, safeFileName(report.title) + ".pdf"));
      const remove = document.createElement("button");
      remove.className = "button subtle";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        await reportTransaction("readwrite", (store) => store.delete(report.id));
        loadSavedReports();
      });
      actions.append(open, download, remove);
      card.append(heading, actions);
      host.append(card);
    });
  } catch (error) {
    const message = document.createElement("p");
    message.className = "status is-error";
    message.textContent = error.message;
    host.append(message);
  }
}

const stanmoreLinks = {
  8: "https://stanmorephysics.com/z-grade-8/maths-grade-8/",
  9: "https://stanmorephysics.com/z-grade-99/maths-grade-9/",
  10: "https://stanmorephysics.com/maths-grade-10-exam-papers/",
  11: "https://stanmorephysics.com/maths-grade-11/",
  12: "https://stanmorephysics.com/maths-exam-papers-grade-12/",
};
const dbePastPapers = "https://www.education.gov.za/Curriculum/NationalSeniorCertificate(NSC)Examinations/NSCPastExaminationpapers.aspx";

function renderSourceLinks() {
  const host = $("#sourceLinks");
  if (!host) return;
  const grade = formatGrade($("#globalGrade").value || state.grade);
  host.replaceChildren();
  const intro = document.createElement("p");
  intro.className = "source-note";
  intro.textContent = "Open a source site, choose and download a paper yourself, then upload your copy here.";
  const links = document.createElement("div");
  links.className = "source-link-list";
  function addLink(label, href) {
    const anchor = document.createElement("a");
    anchor.className = "button subtle";
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = label;
    links.append(anchor);
  }
  addLink("Stanmore Grade " + grade, stanmoreLinks[grade]);
  if (grade === 12) addLink("DBE Grade 12 papers and memos", dbePastPapers);
  host.append(intro, links);
}

function updateExamGenerateButton() {
  $("#generateExam").disabled = $$("#examTopicChoices input[type=checkbox]:checked").length === 0;
}

async function loadExamTopics() {
  const grade = formatGrade($("#examGrade").value);
  const host = $("#examTopicChoices");
  host.replaceChildren();
  $("#generateExam").disabled = true;
  setStatus($("#examStatus"), "Loading Grade " + grade + " topics from the question bank…");
  try {
    state.examTopics = await loadTopicCatalog(grade);
    state.examTopics.forEach((topic) => {
      const card = document.createElement("fieldset");
      card.className = "topic-choice-card";
      const legend = document.createElement("legend");
      const heading = document.createElement("label");
      heading.className = "topic-choice-heading";
      const topicBox = document.createElement("input");
      topicBox.type = "checkbox";
      topicBox.dataset.topicChoice = topic.id;
      topicBox.checked = true;
      const title = document.createElement("span");
      title.textContent = topic.name + " · " + topic.count + " questions";
      heading.append(topicBox, title);
      legend.append(heading);
      card.append(legend);
      const choices = document.createElement("div");
      choices.className = "topic-subtopic-choices";
      (topic.subtopics || []).forEach((subtopic) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.subtopicChoice = String(subtopic.subtopic_id || subtopic.id || subtopic.subtopic || "");
        input.dataset.parentTopic = topic.id;
        input.checked = true;
        const text = document.createElement("span");
        text.textContent = (subtopic.subtopic || subtopic.name || subtopic.subtopic_id) + " · " + (subtopic.question_count || "");
        label.append(input, text);
        choices.append(label);
      });
      if (choices.childElementCount) card.append(choices);
      host.append(card);
    });
    host.querySelectorAll("[data-topic-choice]").forEach((input) => input.addEventListener("change", () => {
      const selector = '[data-parent-topic="' + CSS.escape(input.dataset.topicChoice) + '"]';
      host.querySelectorAll(selector).forEach((child) => { child.checked = input.checked; });
      updateExamGenerateButton();
    }));
    host.querySelectorAll("[data-subtopic-choice]").forEach((input) => input.addEventListener("change", () => {
      const topicSelector = '[data-topic-choice="' + CSS.escape(input.dataset.parentTopic) + '"]';
      const childrenSelector = '[data-parent-topic="' + CSS.escape(input.dataset.parentTopic) + '"]';
      const parent = host.querySelector(topicSelector);
      parent.checked = [...host.querySelectorAll(childrenSelector)].some((child) => child.checked);
      updateExamGenerateButton();
    }));
    updateExamGenerateButton();
    setStatus($("#examStatus"), state.examTopics.length + " Grade " + grade + " topics loaded. Choose topics and subtopics, then generate a paper.", "success");
  } catch (error) {
    setStatus($("#examStatus"), error.message, "error");
  }
}

$("#loadExamTopics").addEventListener("click", loadExamTopics);
$("#examGrade").addEventListener("change", () => {
  $("#globalGrade").value = $("#examGrade").value;
  state.grade = formatGrade($("#examGrade").value);
  sessionStorage.setItem("sharperx_web_grade", String(state.grade));
  renderSourceLinks();
  loadExamTopics();
});
$("#examType").addEventListener("change", () => { $("#examResult").hidden = true; });

function collectExamScopes() {
  const scopes = [];
  $$("#examTopicChoices [data-topic-choice]:checked").forEach((input) => {
    const topicId = input.dataset.topicChoice;
    const selector = '[data-parent-topic="' + CSS.escape(topicId) + '"]';
    const allChildren = [...$("#examTopicChoices").querySelectorAll(selector)];
    const subtopicIds = allChildren.filter((child) => child.checked).map((child) => child.dataset.subtopicChoice);
    if (allChildren.length) {
      if (subtopicIds.length) scopes.push({ topic_id: topicId, subtopic_ids: subtopicIds });
    } else scopes.push({ topic_id: topicId, subtopic_ids: [] });
  });
  return scopes;
}

$("#generateExam").addEventListener("click", async () => {
  const scopes = collectExamScopes();
  if (!scopes.length) return setStatus($("#examStatus"), "Select at least one topic and one subtopic.", "error");
  const button = $("#generateExam");
  button.disabled = true;
  setStatus($("#examStatus"), "Building and checking your assessment…");
  try {
    const result = await postJson("/api/education/test-exam-preparation/generate", {
      grade: formatGrade($("#examGrade").value),
      assessment_type: $("#examType").value,
      topic_scopes: scopes.filter((scope) => scope.subtopic_ids.length),
      topic_ids: scopes.filter((scope) => !scope.subtopic_ids.length).map((scope) => scope.topic_id),
    });
    state.exam = result;
    state.examSessionId = "";
    sessionStorage.removeItem("sharperx_web_exam_session_id");
    $("#examPaperSummary").hidden = false;
    $("#examPaperSummary").textContent = (result.title || "Assessment ready") + " · " + (result.questions || []).length + " questions · " + result.total_marks + " marks · " + result.duration_minutes + " minutes. The paper is ready.";
    $("#startExamSession").hidden = false;
    setStatus($("#examStatus"), "Paper ready. Start the session when you are ready.", "success");
  } catch (error) {
    setStatus($("#examStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#startExamSession").addEventListener("click", async () => {
  if (!state.exam || !state.exam.paper_id) return;
  const button = $("#startExamSession");
  button.disabled = true;
  try {
    let session = await postJson("/api/education/exam-sessions", {
      paper_id: state.exam.paper_id,
      mode: $("#examSessionMode").value || "guided",
      allow_pause: $("#examSessionMode").value !== "strict",
      allow_back_navigation: true,
    });
    if (session.status === "not_started") session = await postJson("/api/education/exam-sessions/" + encodeURIComponent(session.session_id) + "/start", {});
    state.examSessionId = session.session_id;
    sessionStorage.setItem("sharperx_web_exam_session_id", state.examSessionId);
    $("#examSetup").hidden = true;
    $("#examWorkspace").hidden = false;
    await renderExamSession(session);
  } catch (error) {
    setStatus($("#examStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

async function restoreExamSession() {
  if (!state.examSessionId) return;
  try {
    const session = await getJson("/api/education/exam-sessions/" + encodeURIComponent(state.examSessionId));
    if (session.status === "in_progress" || session.status === "paused") {
      $("#examSetup").hidden = true;
      $("#examWorkspace").hidden = false;
      renderExamSession(session);
    } else {
      state.examSessionId = "";
      sessionStorage.removeItem("sharperx_web_exam_session_id");
    }
  } catch {
    state.examSessionId = "";
    sessionStorage.removeItem("sharperx_web_exam_session_id");
  }
}

async function renderExamSession(session) {
  state.exam = Object.assign(state.exam || {}, session);
  const question = session.current_question;
  if (!question) throw new Error("The current assessment question could not be loaded.");
  state.examQuestionIndex = Number(session.current_question_index || 0);
  state.examCurrentQuestion = question;
  $("#examProgress").textContent = (session.paper_title || "Assessment") + " · Question " + (state.examQuestionIndex + 1) + " of " + session.question_count;
  $("#examQuestionTitle").textContent = question.display_label || "Question " + (state.examQuestionIndex + 1);
  renderMath($("#examQuestionText"), question.question_text_latex || question.question_text || "");
  $("#examAnswer").value = question.answer && question.answer.answer_text || "";
  $("#examGuidanceText").hidden = true;
  $("#examGuidanceText").replaceChildren();
  $("#examQuestionVisuals").replaceChildren();
  $("#examFullScreen").hidden = true;
  $("#previousExamQuestion").disabled = state.examQuestionIndex <= 0;
  $("#nextExamQuestion").disabled = state.examQuestionIndex >= session.question_count - 1;
  $("#examGuidanceButton").disabled = session.mode === "strict";
  state.examVisuals = collectVisuals(question);
  if (question.bank_question_id || question.question_id || question.id || state.examVisuals.length) {
    const reviewQuestion = Object.assign({}, question, { question_id: question.bank_question_id || question.question_id || question.id });
    const locallyCachedVisuals = readCachedQuestionVisuals(reviewQuestion);
    if (locallyCachedVisuals !== null) {
      state.examVisuals = locallyCachedVisuals;
      renderQuestionVisuals($("#examQuestionVisuals"), state.examVisuals, "Assessment diagram", question.question_text_latex || question.question_text || "");
    } else {
      renderVisualReviewProgress($("#examQuestionVisuals"));
      const visualReview = await preparePracticeVisuals(reviewQuestion);
      if (state.examCurrentQuestion !== question) return;
      state.examVisuals = visualReview.visuals;
      renderQuestionVisuals($("#examQuestionVisuals"), state.examVisuals, "Assessment diagram", question.question_text_latex || question.question_text || "", visualReview.reviewMessage);
    }
    $("#examFullScreen").hidden = !$("#examQuestionVisuals img");
  }
}

async function saveExamAnswer() {
  const question = state.examCurrentQuestion;
  if (!question || !state.examSessionId) throw new Error("There is no active assessment question.");
  const attachments = state.examAnswerAttachments && state.examAnswerAttachments.get(question.id) || [];
  return postJson("/api/education/exam-sessions/" + encodeURIComponent(state.examSessionId) + "/answers", {
    question_id: question.id,
    answer_text: $("#examAnswer").value,
    attachment_ids: attachments,
    is_flagged_for_review: false,
  });
}

$("#saveExamAnswer").addEventListener("click", async () => {
  try { await saveExamAnswer(); showToast("Answer saved."); }
  catch (error) { showToast(error.message); }
});
async function navigateExam(direction) {
  try {
    await saveExamAnswer();
    const session = await postJson("/api/education/exam-sessions/" + encodeURIComponent(state.examSessionId) + "/navigate", { direction });
    await renderExamSession(session);
  } catch (error) { showToast(error.message); }
}
$("#previousExamQuestion").addEventListener("click", () => navigateExam(-1));
$("#nextExamQuestion").addEventListener("click", () => navigateExam(1));
$("#examGuidanceButton").addEventListener("click", async () => {
  try {
    const result = await postJson("/api/education/exam-sessions/" + encodeURIComponent(state.examSessionId) + "/guidance", { action: "explain" });
    requireLunaXhigh(result, "Assessment guidance");
    const panel = $("#examGuidanceText");
    panel.hidden = false;
    renderMath(panel, result.guidance_latex || result.guidance || result.message || "Identify the information given and what the question asks you to find.");
    if (result.formula_latex || result.formula) {
      const formula = document.createElement("p");
      renderMath(formula, "Formula: " + (result.formula_latex || result.formula));
      panel.append(formula);
    }
  } catch (error) { showToast(error.message); }
});
$("#examCanvasButton").addEventListener("click", () => openCanvas("exam", state.examCurrentQuestion));
$("#examFullScreen").addEventListener("click", () => {
  const image = $("#examQuestionVisuals img");
  if (image) openImageViewer(image.src, image.alt || "Assessment diagram");
});
$("#submitExam").addEventListener("click", async () => {
  if (!state.examSessionId || !window.confirm("Submit and mark this assessment now? You will not be able to change your answers afterwards.")) return;
  const button = $("#submitExam");
  button.disabled = true;
  try {
    await saveExamAnswer();
    const result = await postJson("/api/education/exam-sessions/" + encodeURIComponent(state.examSessionId) + "/submit", {});
    requireLunaXhigh(result, "Assessment marking");
    const panel = $("#examResult");
    panel.hidden = false;
    panel.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = "Assessment result: " + result.total_awarded_marks + " / " + result.total_marks + " (" + result.percentage + "%)";
    const body = document.createElement("div");
    body.className = "math-content";
    const detail = (result.questions || []).map((item) => [
      item.display_label || item.question_number || "Question",
      "Your answer:\n" + (item.learner_answer || item.learner_math_content || "(no response)"),
      item.feedback || "",
      item.correct_method || item.solution || item.worked_solution || "",
      Array.isArray(item.steps) ? item.steps.map((step) => typeof step === "string" ? step : step.feedback || step.expected || step.step || "").filter(Boolean).join("\n") : "",
    ].filter(Boolean).join("\n\n")).join("\n\n");
    renderMath(body, detail);
    const save = document.createElement("button");
    save.className = "button secondary";
    save.type = "button";
    save.textContent = "Save PDF report";
    save.addEventListener("click", () => saveReport("Assessment marking", "Score " + result.total_awarded_marks + " / " + result.total_marks, detail));
    panel.append(title, body, save);
    sessionStorage.removeItem("sharperx_web_exam_session_id");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

async function loadLessons() {
  const grade = formatGrade($("#lessonGrade").value || state.grade);
  const host = $("#lessonCatalog");
  host.replaceChildren();
  setStatus($("#lessonStatus"), "Loading Grade " + grade + " lesson videos…");
  try {
    const result = await getJson("/api/lesson-videos/mathematics/catalog?grade=" + grade);
    state.lessonCatalog = result.topics || [];
    state.lessonCatalog.forEach((topic) => {
      const section = document.createElement("section");
      section.className = "lesson-topic";
      const heading = document.createElement("h2");
      heading.textContent = topic.topic || "Mathematics";
      section.append(heading);
      const grid = document.createElement("div");
      grid.className = "lesson-grid";
      (topic.lessons || []).forEach((lesson) => {
        const card = document.createElement("article");
        card.className = "lesson-card";
        if (lesson.thumbnail_url) {
          const image = document.createElement("img");
          image.loading = "lazy";
          image.src = lesson.thumbnail_url;
          image.alt = "";
          card.append(image);
        }
        const title = document.createElement("h3");
        title.textContent = lesson.title;
        const play = document.createElement("button");
        play.type = "button";
        play.className = "button primary";
        play.textContent = "View lesson";
        play.addEventListener("click", () => playLessonVideo(grade, topic, lesson, play));
        card.append(title, play);
        grid.append(card);
      });
      section.append(grid);
      host.append(section);
    });
    setStatus($("#lessonStatus"), state.lessonCatalog.length ? "Grade " + grade + " lesson catalog loaded." : "No uploaded lesson videos are available for Grade " + grade + " yet.", state.lessonCatalog.length ? "success" : "");
  } catch (error) { setStatus($("#lessonStatus"), error.message, "error"); }
}
$("#lessonGrade").addEventListener("change", () => {
  $("#globalGrade").value = $("#lessonGrade").value;
  state.grade = formatGrade($("#lessonGrade").value);
  sessionStorage.setItem("sharperx_web_grade", String(state.grade));
  renderSourceLinks();
  loadLessons();
});
async function playLessonVideo(grade, topic, lesson, button) {
  button.disabled = true;
  try {
    const params = new URLSearchParams({ grade: String(grade), topic: topic.topic || "Mathematics", subtopic: lesson.title || "Lesson", unit_id: lesson.id });
    const result = await getJson("/api/lesson-videos/mathematics/video?" + params);
    const video = result.video || {};
    const player = $("#lessonPlayer");
    player.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = video.title || lesson.title;
    const frame = document.createElement("iframe");
    frame.title = heading.textContent;
    frame.src = video.playback_url;
    frame.allow = "autoplay; fullscreen; picture-in-picture";
    frame.allowFullscreen = true;
    player.append(heading, frame);
    player.hidden = false;
    player.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}
renderSourceLinks();

const deviceRemoteButton = $("#deviceRemoteButton");
const deviceRemoteDialog = $("#deviceRemoteDialog");
let deviceRemoteSocket = null;
let deviceRemoteSession = null;
let deviceRemoteHeartbeat = 0;
let deviceRemoteCursor = null;
let deviceRemotePointer = { x: 0.5, y: 0.5, down: false, downAt: 0, startX: 0, startY: 0, target: null, dragged: false };
let deviceRemoteZoomScale = 1;
let deviceRemoteTargetFrame = null;
let deviceRemotePhoneConnected = false;
let deviceRemoteClosingAfterPair = false;
let deviceRemoteCreateRequest = 0;

function detectRunningDevice() {
  const ua = navigator.userAgent || "";
  const explicitTv = /(Android\s*(?:TV|tv)|Smart[- ]?TV|Google[- ]?TV|HbbTV|Tizen|Web0S|webOS|BRAVIA|AFT[A-Z0-9]*|NetCast|Viera|Hisense|MiTV|SMART_TV)/i.test(ua);
  const mobile = /(iPhone|iPod|Android.*Mobile|Windows Phone)/i.test(ua);
  const androidTvLike = /Android/i.test(ua) && !/Mobile|Mobi/i.test(ua);
  const cssWidth = Math.max(window.screen?.width || 0, window.screen?.height || 0, window.innerWidth || 0);
  const pixelWidth = cssWidth * Math.max(1, Number(window.devicePixelRatio) || 1);
  const bigScreen = !mobile && (cssWidth >= 1100 || pixelWidth >= 1600);
  const tvLike = explicitTv || androidTvLike;
  const largeDisplay = tvLike || bigScreen;
  document.documentElement.dataset.deviceType = tvLike ? "tv" : mobile ? "mobile" : bigScreen ? "large-screen" : "desktop";
  document.documentElement.classList.toggle("device-tv", largeDisplay);
  $("#deviceTypeStatus").textContent = explicitTv ? "Smart TV detected" : androidTvLike ? "Android TV detected" : bigScreen ? "Large screen detected" : "Phone remote available";
  // Some TV browsers report a desktop or mobile user agent and a small CSS
  // viewport. Keep the QR entry point available even when detection is unsure.
  deviceRemoteButton.hidden = false;
  return { explicitTv, androidTvLike, bigScreen, mobile, tvLike };
}

detectRunningDevice();
window.addEventListener("resize", detectRunningDevice, { passive: true });

function deviceRemoteSetStatus(message, kind = "") {
  setStatus($("#deviceRemoteStatus"), message, kind);
}

function openDeviceRemoteDialog() {
  if (deviceRemoteDialog.open) return;
  if (typeof deviceRemoteDialog.showModal === "function") {
    deviceRemoteDialog.showModal();
    return;
  }
  deviceRemoteDialog.classList.add("device-remote-fallback-open");
  document.body.classList.add("device-remote-fallback-open");
  deviceRemoteDialog.setAttribute("open", "");
}

function closeDeviceRemoteDialog() {
  if (!deviceRemoteDialog.open) return;
  if (typeof deviceRemoteDialog.close === "function") {
    deviceRemoteDialog.close();
    return;
  }
  deviceRemoteDialog.removeAttribute("open");
  deviceRemoteDialog.classList.remove("device-remote-fallback-open");
  document.body.classList.remove("device-remote-fallback-open");
  deviceRemoteDialog.dispatchEvent(new Event("close"));
}

function deviceRemoteSend(message) {
  if (deviceRemoteSocket?.readyState !== WebSocket.OPEN) return false;
  deviceRemoteSocket.send(JSON.stringify(message));
  return true;
}

function deviceRemoteGetLink(sessionId, code) {
  const page = new URL("./remote-control.html", location.href);
  page.hash = new URLSearchParams({ session_id: sessionId, code }).toString();
  return page;
}

function deviceRemoteRenderQr(url) {
  const host = $("#deviceRemoteQr");
  host.replaceChildren();
  const qr = qrcode(0, "M");
  qr.addData(url, "Byte");
  qr.make();
  host.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  const svg = host.querySelector("svg");
  if (svg) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Scan to connect a phone remote");
  }
}

function deviceRemoteCreateCursor() {
  if (deviceRemoteCursor) return deviceRemoteCursor;
  deviceRemoteCursor = document.createElement("div");
  deviceRemoteCursor.className = "device-remote-cursor";
  deviceRemoteCursor.setAttribute("aria-hidden", "true");
  deviceRemoteCursor.innerHTML = '<svg viewBox="0 0 24 32" aria-hidden="true"><path d="M2 1v25l6.7-6.8 4.8 10.4 4.2-1.9-4.7-10.2H22L2 1Z" fill="#fff" stroke="#172b29" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.body.append(deviceRemoteCursor);
  return deviceRemoteCursor;
}

function deviceRemoteNotifyFocus(target = document.activeElement) {
  if (!deviceRemoteSession) return;
  const frame = target === practiceMathEditorFrame || target?.tagName === "IFRAME" && target === practiceMathEditorFrame;
  let editable = null;
  if (frame) {
    deviceRemoteTargetFrame = practiceMathEditorFrame;
  } else {
    deviceRemoteTargetFrame = null;
    editable = target instanceof HTMLElement ? target : null;
  }
  const type = String(editable?.type || "").toLowerCase();
  const password = type === "password";
  const isTextField = editable && ((editable.matches("input, textarea") && !["checkbox", "radio", "button", "submit", "reset", "file", "color", "range", "hidden"].includes(type)) || editable.isContentEditable);
  const keyboard = Boolean(frame || (isTextField && !password));
  const value = password ? "" : frame ? (state.practiceEditorState?.latex || "") : isTextField && "value" in editable ? String(editable.value || "").slice(0, 4000) : "";
  const label = frame ? "maths editor" : editable?.getAttribute("aria-label") || editable?.getAttribute("placeholder") || editable?.name || editable?.id || (editable?.tagName === "TEXTAREA" ? "answer box" : "selected control");
  deviceRemoteSend({ type: "focus", keyboard, label: String(label).slice(0, 120), value });
}

function deviceRemoteConnectSocket(session) {
  const socketUrl = pairingWebSocketUrl("device-remote", session.session_id);
  socketUrl.searchParams.set("role", "host");
  deviceRemoteSocket = new WebSocket(socketUrl);
  deviceRemoteSocket.addEventListener("open", () => {
    deviceRemoteSocket.send(JSON.stringify({ type: "authenticate", token: session.host_token }));
    clearInterval(deviceRemoteHeartbeat);
    deviceRemoteHeartbeat = setInterval(() => deviceRemoteSend({ type: "ping" }), 30_000);
    deviceRemoteSetStatus(isLocalIntranetPage() ? "Ready. Scan the code or enter it on a phone using this Wi-Fi." : "Ready. Scan the code or enter it on your phone.");
  });
  deviceRemoteSocket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "authenticated") {
      deviceRemoteSetStatus(isLocalIntranetPage() ? "Ready. Scan the code or enter it on a phone using this Wi-Fi." : "Ready. Scan the code or enter it on your phone.");
    } else if (message.type === "phone_connected") {
      deviceRemotePhoneConnected = true;
      $("#deviceRemoteBadge").hidden = false;
      $("#deviceRemoteButton").textContent = "Phone connected";
      deviceRemoteSetStatus("Phone connected. Tap a text or maths editor on the TV to open the phone keyboard.", "success");
      const cursor = deviceRemoteCreateCursor();
      cursor.style.left = `${deviceRemotePointer.x * innerWidth}px`;
      cursor.style.top = `${deviceRemotePointer.y * innerHeight}px`;
      cursor.classList.add("is-visible");
      if (deviceRemoteDialog.open) {
        deviceRemoteClosingAfterPair = true;
        closeDeviceRemoteDialog();
      }
      deviceRemoteNotifyFocus();
      deviceRemoteShareCanvasLink();
    } else if (message.type === "phone_disconnected") {
      deviceRemotePhoneConnected = false;
      $("#deviceRemoteBadge").hidden = true;
      $("#deviceRemoteButton").textContent = "▦ Connect phone · QR";
      deviceRemoteSetStatus("Phone disconnected. Scan the code again to reconnect.", "error");
      deviceRemoteCursor?.classList.remove("is-visible");
    } else if (message.type === "pointer") {
      deviceRemoteHandlePointer(message);
    } else if (message.type === "text") {
      deviceRemoteInsertText(message);
    } else if (message.type === "key") {
      deviceRemoteHandleKey(message.key);
    }
  });
  deviceRemoteSocket.addEventListener("close", () => {
    clearInterval(deviceRemoteHeartbeat);
    deviceRemoteHeartbeat = 0;
    deviceRemotePhoneConnected = false;
    $("#deviceRemoteBadge").hidden = true;
    $("#deviceRemoteButton").textContent = "▦ Connect phone · QR";
    if (deviceRemoteSession) deviceRemoteSetStatus("The connection ended. Tap Connect phone · QR to start again.", "error");
    deviceRemoteCursor?.classList.remove("is-visible");
    deviceRemoteSocket = null;
  });
  deviceRemoteSocket.addEventListener("error", () => deviceRemoteSetStatus("Could not connect to the phone. Check the network and try again.", "error"));
}

async function startDeviceRemote() {
  try {
    openDeviceRemoteDialog();
  } catch (error) {
    showToast("Phone connection could not be opened. Reload the page and try again.");
    return;
  }
  if (!isLocalIntranetPage() && !getAccessToken()) {
    deviceRemoteSetStatus("Close this panel and sign in on the TV first. Then select Connect phone again.", "error");
    return;
  }
  if (deviceRemoteSession && deviceRemoteSocket && deviceRemoteSocket.readyState < WebSocket.CLOSING) return;
  if (deviceRemoteSession) stopDeviceRemote();
  const requestId = ++deviceRemoteCreateRequest;
  deviceRemoteSetStatus(isLocalIntranetPage() ? "Starting a local phone connection…" : "Starting phone connection…");
  try {
    const session = await postPairingJson("device-remote", "sessions");
    if (requestId !== deviceRemoteCreateRequest || !deviceRemoteDialog.open) return;
    deviceRemoteSession = session;
    $("#deviceRemoteCode").textContent = session.pairing_code;
    const page = deviceRemoteGetLink(session.session_id, session.pairing_code);
    $("#deviceRemoteLink").href = page.href;
    $("#deviceRemoteLink").textContent = page.host + page.pathname;
    deviceRemoteRenderQr(page.href);
    deviceRemoteConnectSocket(session);
  } catch (error) {
    deviceRemoteSetStatus(error.message || "Could not start the phone remote. Restart the local SharperTime page and try again.", "error");
  }
}

function stopDeviceRemote() {
  deviceRemoteCreateRequest += 1;
  clearInterval(deviceRemoteHeartbeat);
  deviceRemoteHeartbeat = 0;
  if (deviceRemoteSocket && deviceRemoteSocket.readyState < WebSocket.CLOSING) {
    if (deviceRemoteSocket.readyState === WebSocket.OPEN) deviceRemoteSend({ type: "cancel" });
    deviceRemoteSocket.close();
  }
  deviceRemoteSocket = null;
  deviceRemoteSession = null;
  deviceRemotePhoneConnected = false;
  $("#deviceRemoteBadge").hidden = true;
  $("#deviceRemoteButton").textContent = "▦ Connect phone · QR";
  deviceRemoteCursor?.classList.remove("is-visible");
  $("#deviceRemoteCode").textContent = "------";
  $("#deviceRemoteQr").replaceChildren();
  deviceRemoteSetStatus("Phone connection closed.");
}

function deviceRemoteActiveEditor() {
  if (deviceRemoteTargetFrame === practiceMathEditorFrame || document.activeElement === practiceMathEditorFrame) {
    return practiceMathEditorFrame.contentWindow?.SharperMathEditor || null;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) return active;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active;
  return null;
}

function deviceRemoteInsertText(message) {
  const editor = deviceRemoteActiveEditor();
  if (!editor || message.action === "replace") return;
  const value = String(message.value || "").slice(0, 200);
  if (editor && typeof editor.execute === "function") {
    if (message.action === "backspace") editor.execute({ name: "backspace" });
    else if (value) editor.execute({ name: "insertText", value });
    return;
  }
  if (message.action === "backspace") {
    if ("selectionStart" in editor && editor.selectionStart !== editor.selectionEnd) editor.setRangeText("", editor.selectionStart, editor.selectionEnd, "end");
    else if ("selectionStart" in editor && editor.selectionStart > 0) editor.setRangeText("", editor.selectionStart - 1, editor.selectionEnd, "end");
    else if (editor.isContentEditable) document.execCommand("delete", false);
  } else if (message.action === "delete") {
    if ("selectionStart" in editor && editor.selectionStart !== editor.selectionEnd) editor.setRangeText("", editor.selectionStart, editor.selectionEnd, "end");
    else if ("selectionStart" in editor && editor.selectionStart < editor.value.length) editor.setRangeText("", editor.selectionStart, editor.selectionStart + 1, "end");
    else if (editor.isContentEditable) document.execCommand("forwardDelete", false);
  } else if (value && "setRangeText" in editor) {
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    editor.setRangeText(value, start, end, "end");
  } else if (value && editor.isContentEditable) {
    document.execCommand("insertText", false, value);
  }
  const inputEvent = typeof InputEvent === "function"
    ? new InputEvent("input", { bubbles: true, inputType: message.action === "backspace" ? "deleteContentBackward" : "insertText", data: message.action === "backspace" ? null : value })
    : new Event("input", { bubbles: true });
  editor.dispatchEvent(inputEvent);
}

function deviceRemoteFocusNext(direction = 1) {
  const selectors = "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), iframe";
  const items = [...document.querySelectorAll(selectors)].filter((item) => item.getClientRects().length && !item.closest("[hidden]"));
  const index = items.indexOf(document.activeElement);
  const next = items[(index + direction + items.length) % items.length];
  next?.focus({ preventScroll: true });
}

function deviceRemoteHandleKey(key) {
  if (!key || key === "Disconnect") return;
  if (key === "OpenCanvas") {
    deviceRemoteOpenCanvas();
    return;
  }
  const editor = deviceRemoteActiveEditor();
  if (editor && typeof editor.execute === "function") {
    const names = { Enter: "newLine", Backspace: "backspace", Delete: "delete", ArrowLeft: "moveLeft", ArrowRight: "moveRight", ArrowUp: "moveUp", ArrowDown: "moveDown", Home: "moveHome", End: "moveEnd" };
    if (names[key]) editor.execute({ name: names[key] });
    return;
  }
  if (key === "Tab") return deviceRemoteFocusNext(1);
  if (key === "Escape") {
    const openDialog = [...document.querySelectorAll("dialog[open]")].pop();
    return openDialog?.close();
  }
  if (key === "PageDown" || key === "PageUp") {
    $("#mainPanel")?.scrollBy({ top: key === "PageDown" ? window.innerHeight * .75 : -window.innerHeight * .75, behavior: "smooth" });
    return;
  }
  if (key === "Enter" && editor instanceof HTMLInputElement) {
    editor.form?.requestSubmit?.();
    return;
  }
  if (key === "Enter" && editor instanceof HTMLTextAreaElement) return deviceRemoteInsertText({ action: "insert", value: "\n" });
  if (["Backspace", "Delete"].includes(key)) return deviceRemoteInsertText({ action: key === "Backspace" ? "backspace" : "delete", value: "" });
  if (["ArrowLeft", "ArrowRight"].includes(key) && editor && "selectionStart" in editor) {
    const next = Math.max(0, Math.min(editor.value.length, (editor.selectionStart || 0) + (key === "ArrowLeft" ? -1 : 1)));
    editor.setSelectionRange(next, next);
    return;
  }
  if (["ArrowLeft", "ArrowUp"].includes(key) && !editor) return deviceRemoteFocusNext(-1);
  if (["ArrowRight", "ArrowDown"].includes(key) && !editor) return deviceRemoteFocusNext(1);
  const target = editor instanceof HTMLElement ? editor : document.activeElement;
  if (target instanceof HTMLElement && (key === "Enter" || key === " ") && /^(BUTTON|A)$/.test(target.tagName)) target.click();
  else if (target instanceof HTMLElement) target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function deviceRemoteHandlePointer(message) {
  const action = String(message.action || "");
  const pointer = deviceRemotePointer;
  if (action === "scroll") {
    const amount = Math.max(-1200, Math.min(1200, Number(message.deltaY) || 0));
    const scrollable = deviceRemoteFindScrollTarget(pointer.x * innerWidth, pointer.y * innerHeight, "y");
    scrollable?.scrollBy({ top: amount, behavior: "smooth" });
    return;
  }
  if (action === "pan") {
    const dx = Math.max(-1, Math.min(1, Number(message.dx) || 0));
    const dy = Math.max(-1, Math.min(1, Number(message.dy) || 0));
    let scrollable = deviceRemoteFindScrollTarget(pointer.x * innerWidth, pointer.y * innerHeight);
    const mainPanel = $("#mainPanel");
    if (scrollable === document.scrollingElement && mainPanel) scrollable = mainPanel;
    scrollable?.scrollBy({ left: -dx * innerWidth * 1.7, top: -dy * innerHeight * 1.7, behavior: "auto" });
    return;
  }
  if (action === "zoom") {
    const factor = Math.max(0.75, Math.min(1.35, Number(message.factor) || 1));
    const nextScale = Math.max(0.6, Math.min(2.5, deviceRemoteZoomScale * factor));
    if (Math.abs(nextScale - deviceRemoteZoomScale) < 0.002) return;
    const anchorX = pointer.x * innerWidth;
    const anchorY = pointer.y * innerHeight;
    const ratio = nextScale / deviceRemoteZoomScale;
    const nextScrollX = (window.scrollX + anchorX) * ratio - anchorX;
    const nextScrollY = (window.scrollY + anchorY) * ratio - anchorY;
    deviceRemoteZoomScale = nextScale;
    document.documentElement.style.zoom = String(nextScale);
    requestAnimationFrame(() => window.scrollTo({ left: Math.max(0, nextScrollX), top: Math.max(0, nextScrollY), behavior: "auto" }));
    return;
  }
  if (action === "cancel") {
    if (pointer.down) deviceRemoteDispatchPointer("up");
    pointer.down = false;
    pointer.target = null;
    pointer.dragged = false;
    return;
  }
  if (action === "move") {
    const dx = Math.max(-1, Math.min(1, Number(message.dx) || 0));
    const dy = Math.max(-1, Math.min(1, Number(message.dy) || 0));
    pointer.x = Math.max(0, Math.min(1, pointer.x + dx * 1.65));
    pointer.y = Math.max(0, Math.min(1, pointer.y + dy * 1.65));
    if (pointer.down) {
      const distance = Math.hypot((pointer.x - pointer.startX) * innerWidth, (pointer.y - pointer.startY) * innerHeight);
      if (distance > 8) pointer.dragged = true;
    }
    return deviceRemoteDispatchPointer("move");
  }
  if (action === "down") {
    pointer.down = true;
    pointer.downAt = Date.now();
    pointer.startX = pointer.x;
    pointer.startY = pointer.y;
    pointer.dragged = false;
    pointer.target = deviceRemoteResolvePointerTarget(pointer.x * innerWidth, pointer.y * innerHeight);
    return deviceRemoteDispatchPointer("down");
  }
  if (action === "up") {
    deviceRemoteDispatchPointer("up");
    if (pointer.down && !pointer.dragged && Date.now() - pointer.downAt < 900 && pointer.target?.element?.click) pointer.target.element.click();
    pointer.down = false;
    pointer.target = null;
    deviceRemoteNotifyFocus();
    return;
  }
  if (action === "click") {
    const target = deviceRemoteResolvePointerTarget(pointer.x * innerWidth, pointer.y * innerHeight);
    if (message.button === 2 && target?.element) target.element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: target.clientX, clientY: target.clientY }));
    else if (target?.element) target.element.click();
    deviceRemoteNotifyFocus();
  }
}

function deviceRemoteFindScrollTarget(x, y, axis = "both") {
  const element = document.elementFromPoint(x, y);
  let current = element instanceof HTMLElement ? element : null;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = getComputedStyle(current);
    const canScrollX = current.scrollWidth > current.clientWidth + 2 && /(auto|scroll)/.test(style.overflowX);
    const canScrollY = current.scrollHeight > current.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY);
    if (axis === "x" ? canScrollX : axis === "y" ? canScrollY : canScrollX || canScrollY) return current;
    current = current.parentElement;
  }
  return document.scrollingElement;
}

function deviceRemoteResolvePointerTarget(x, y) {
  const outer = document.elementFromPoint(x, y);
  if (outer === practiceMathEditorFrame) {
    try {
      const rect = practiceMathEditorFrame.getBoundingClientRect();
      const doc = practiceMathEditorFrame.contentDocument;
      const element = doc?.elementFromPoint(x - rect.left, y - rect.top);
      if (element) return { element, clientX: x - rect.left, clientY: y - rect.top };
    } catch { /* The frame is same-origin in this app; ignore an unavailable editor. */ }
  }
  return outer ? { element: outer, clientX: x, clientY: y } : null;
}

function deviceRemoteDispatchPointer(action) {
  const pointer = deviceRemotePointer;
  const x = pointer.x * innerWidth;
  const y = pointer.y * innerHeight;
  const cursor = deviceRemoteCreateCursor();
  const topDialog = [...document.querySelectorAll("dialog[open]")].pop();
  const pointerLayer = topDialog || document.body;
  if (cursor.parentNode !== pointerLayer) pointerLayer.append(cursor);
  cursor.style.left = `${x}px`;
  cursor.style.top = `${y}px`;
  const resolved = action === "move" && pointer.down ? pointer.target : deviceRemoteResolvePointerTarget(x, y);
  const target = resolved?.element;
  if (!target || target.nodeType !== 1) return;
  if (target === workingCanvas || target.closest?.(".editor-surface")) return;
  const common = { bubbles: true, cancelable: true, pointerId: 97, pointerType: "mouse", isPrimary: true, clientX: resolved.clientX, clientY: resolved.clientY, button: 0, buttons: pointer.down ? 1 : 0 };
  if (typeof PointerEvent === "function") target.dispatchEvent(new PointerEvent(`pointer${action}`, common));
  if (action === "down") target.dispatchEvent(new MouseEvent("mousedown", common));
  else if (action === "move") target.dispatchEvent(new MouseEvent("mousemove", common));
  else if (action === "up") target.dispatchEvent(new MouseEvent("mouseup", common));
}

deviceRemoteButton.addEventListener("click", startDeviceRemote);
$("#deviceRemoteDialog [data-close-dialog]").addEventListener("click", closeDeviceRemoteDialog);
$("#stopDeviceRemote").addEventListener("click", stopDeviceRemote);
deviceRemoteDialog.addEventListener("close", () => {
  if (deviceRemoteClosingAfterPair) {
    deviceRemoteClosingAfterPair = false;
    return;
  }
  stopDeviceRemote();
});
document.addEventListener("focusin", (event) => {
  if (event.target?.closest?.("#workspace")) deviceRemoteNotifyFocus(event.target);
}, true);
document.addEventListener("input", (event) => {
  if (event.target === document.activeElement && event.target?.closest?.("#workspace")) deviceRemoteNotifyFocus(event.target);
}, true);

const workingCanvas = $("#workingCanvas");
let phoneCanvasSocket = null;
let phoneCanvasSession = null;
let phoneCanvasSubmissionSentUntil = 0;
let phoneCanvasHeartbeat = 0;
let phoneCanvasCloseTimer = 0;

function phoneCanvasSetStatus(message, kind = "") {
  setStatus($("#phoneCanvasPairStatus"), message, kind);
}

function phoneCanvasSend(message) {
  if (phoneCanvasSocket?.readyState !== WebSocket.OPEN) return false;
  phoneCanvasSocket.send(JSON.stringify(message));
  return true;
}

function phoneCanvasRemoteUrl(sessionId, code) {
  const localDevelopment = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const remoteUrl = localDevelopment
    ? new URL("https://sharperx.co.za/app/canvas-remote.html")
    : new URL("./canvas-remote.html", location.href);
  remoteUrl.hash = new URLSearchParams({ session_id: sessionId, code }).toString();
  return remoteUrl;
}

function deviceRemoteShareCanvasLink() {
  if (!phoneCanvasSession?.session_id || !phoneCanvasSession?.pairing_code) return false;
  const remoteUrl = phoneCanvasRemoteUrl(phoneCanvasSession.session_id, phoneCanvasSession.pairing_code);
  return deviceRemoteSend({ type: "canvas_link", href: remoteUrl.href });
}

function deviceRemoteOpenCanvas() {
  const dialog = $("#canvasDialog");
  if (!dialog.open) {
    if (state.view === "practice" && state.currentPracticeQuestion) {
      openCanvas("practice", state.currentPracticeQuestion);
    } else if (state.view === "exam" && state.examCurrentQuestion) {
      openCanvas("exam", state.examCurrentQuestion);
    } else if (state.view === "ask" && state.selectedPaperQuestion) {
      openCanvas("ask-write", null);
    } else {
      openCanvas("ask-write", null);
    }
  }
  const panel = $("#phoneCanvasPairPanel");
  panel.hidden = false;
  $("#usePhoneCanvas").setAttribute("aria-expanded", "true");
  if (phoneCanvasSession) {
    deviceRemoteShareCanvasLink();
    return;
  }
  startPhoneCanvas();
}

function renderPhoneCanvasQr(url) {
  const host = $("#phoneCanvasPairQr");
  host.replaceChildren();
  const code = qrcode(0, "M");
  code.addData(url, "Byte");
  code.make();
  host.innerHTML = code.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  const svg = host.querySelector("svg");
  if (svg) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Scan to connect your phone canvas");
  }
}

function phoneCanvasMapPoint(point, frame) {
  const rect = workingCanvas.getBoundingClientRect();
  const sourceWidth = Math.max(1, Number(frame?.width) || 1);
  const sourceHeight = Math.max(1, Number(frame?.height) || 1);
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  return {
    x: (rect.width - sourceWidth * scale) / 2 + (Number(point?.x) || 0) * sourceWidth * scale,
    y: (rect.height - sourceHeight * scale) / 2 + (Number(point?.y) || 0) * sourceHeight * scale,
    scale,
  };
}

function phoneCanvasSnapshot() {
  const source = state.canvas.strokes.filter((stroke) => stroke.source === "phone").reverse();
  let remaining = 4000;
  const result = [];
  for (const stroke of source) {
    if (remaining <= 0 || result.length >= 250) break;
    const points = Array.isArray(stroke.remotePoints) ? stroke.remotePoints : [];
    const count = Math.min(points.length, remaining);
    if (!count) continue;
    const selected = count === points.length
      ? points
      : Array.from({ length: count }, (_, index) => points[Math.round(index * (points.length - 1) / Math.max(1, count - 1))]);
    result.push({
      id: stroke.id,
      frame: stroke.remoteFrame,
      width: stroke.remoteWidth,
      color: stroke.color,
      tool: stroke.tool || "pen",
      points: selected,
    });
    remaining -= count;
  }
  return result.reverse();
}

function invalidateCanvasTranscription() {
  if (!state.canvas) return;
  state.canvas.revision = (state.canvas.revision || 0) + 1;
  state.canvas.transcribedPhoto = null;
  state.canvas.photoPromise = null;
  const panel = $("#canvasTranscriptionPanel");
  if (panel) panel.hidden = true;
  const status = $("#canvasTranscriptionStatus");
  if (status) {
    status.textContent = "";
    status.dataset.loading = "false";
  }
}

function applyPhoneCanvasMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "authenticated") {
    phoneCanvasSetStatus("Scan the code with your phone. Enter the pairing code if you cannot scan it.");
  } else if (message.type === "phone_connected") {
    phoneCanvasSetStatus("Phone connected. Draw on it and your work will appear here.", "success");
    const question = state.canvasQuestion;
    const questionText = question?.accessible_text || question?.question_text || question?.text || questionLabel(question || {});
    phoneCanvasSend({
      type: "setup",
      title: $("#canvasTitle").textContent,
      question: String(questionText || "").slice(0, 12_000),
      strokes: phoneCanvasSnapshot(),
    });
  } else if (message.type === "phone_disconnected") {
    phoneCanvasSetStatus("Phone disconnected. Scan the code again to reconnect.", "error");
  } else if (message.type === "stroke_start") {
    invalidateCanvasTranscription();
    const first = phoneCanvasMapPoint(message.point, message.frame);
    state.canvas.strokes.push({
      id: String(message.id || ""),
      source: "phone",
      remoteFrame: message.frame,
      remoteWidth: Number(message.width) || 2.2,
      remotePoints: [message.point],
      points: [{ x: first.x, y: first.y }],
      color: message.tool === "eraser" ? "#fff" : "#162a29",
      tool: message.tool === "eraser" ? "eraser" : "pen",
      width: (Number(message.width) || 2.2) * first.scale,
    });
    drawCanvas();
  } else if (message.type === "stroke_points") {
    const stroke = [...state.canvas.strokes].reverse().find((item) => item.source === "phone" && item.id === String(message.id || ""));
    if (!stroke || !Array.isArray(message.points)) return;
    message.points.forEach((point) => {
      const mapped = phoneCanvasMapPoint(point, message.frame);
      stroke.remotePoints.push(point);
      stroke.points.push({ x: mapped.x, y: mapped.y });
    });
    drawCanvas();
  } else if (message.type === "stroke_end") {
    state.canvas.active = null;
  } else if (message.type === "undo") {
    const targetId = String(message.id || "");
    let index = -1;
    for (let i = state.canvas.strokes.length - 1; i >= 0; i -= 1) {
      const stroke = state.canvas.strokes[i];
      if (stroke.source === "phone" && (!targetId || stroke.id === targetId)) { index = i; break; }
    }
    if (index >= 0) {
      invalidateCanvasTranscription();
      state.canvas.strokes.splice(index, 1);
    }
    drawCanvas();
  } else if (message.type === "clear") {
    invalidateCanvasTranscription();
    state.canvas.strokes = state.canvas.strokes.filter((stroke) => stroke.source !== "phone");
    drawCanvas();
  } else if (message.type === "submit") {
    phoneCanvasSetStatus("Submitting the phone canvas…");
    $("#finishCanvas").click();
  }
}

function stopPhoneCanvas({ notify = true } = {}) {
  clearTimeout(phoneCanvasCloseTimer);
  phoneCanvasCloseTimer = 0;
  clearInterval(phoneCanvasHeartbeat);
  phoneCanvasHeartbeat = 0;
  if (notify) deviceRemoteSend({ type: "canvas_unavailable" });
  if (phoneCanvasSocket && phoneCanvasSocket.readyState < WebSocket.CLOSING) {
    if (notify) phoneCanvasSend({ type: "cancel" });
    phoneCanvasSocket.close();
  }
  phoneCanvasSocket = null;
  phoneCanvasSession = null;
  phoneCanvasSubmissionSentUntil = 0;
  $("#phoneCanvasPairCode").textContent = "------";
  $("#phoneCanvasPairQr").replaceChildren();
  $("#usePhoneCanvas").setAttribute("aria-expanded", "false");
  $("#phoneCanvasPairPanel").hidden = true;
  $("#usePhoneCanvas").disabled = false;
  phoneCanvasSetStatus("Phone connection closed.");
}

async function startPhoneCanvas() {
  if (phoneCanvasSession) return;
  const button = $("#usePhoneCanvas");
  button.disabled = true;
  phoneCanvasSetStatus("Connecting…");
  try {
    const session = await postPairingJson("canvas-pairing", "sessions");
    phoneCanvasSession = session;
    $("#phoneCanvasPairCode").textContent = session.pairing_code;
    const remoteUrl = phoneCanvasRemoteUrl(session.session_id, session.pairing_code);
    const remotePage = new URL(remoteUrl.href);
    remotePage.hash = "";
    $("#phoneCanvasRemoteLink").href = remotePage.href;
    $("#phoneCanvasRemoteLink").textContent = remotePage.host + remotePage.pathname;
    renderPhoneCanvasQr(remoteUrl.href);
    deviceRemoteSend({ type: "canvas_link", href: remoteUrl.href });

    const socketUrl = pairingWebSocketUrl("canvas-pairing", session.session_id);
    socketUrl.searchParams.set("role", "host");
    phoneCanvasSocket = new WebSocket(socketUrl);
    phoneCanvasSocket.addEventListener("open", () => {
      phoneCanvasSocket.send(JSON.stringify({ type: "authenticate", token: session.host_token }));
      clearInterval(phoneCanvasHeartbeat);
      phoneCanvasHeartbeat = setInterval(() => phoneCanvasSend({ type: "ping" }), 30_000);
      phoneCanvasSetStatus(isLocalIntranetPage() ? "Waiting for your phone on this Wi-Fi…" : "Waiting for your phone…");
      button.disabled = false;
    });
    phoneCanvasSocket.addEventListener("message", (event) => {
      try { applyPhoneCanvasMessage(JSON.parse(event.data)); } catch { /* Ignore malformed remote updates. */ }
    });
    phoneCanvasSocket.addEventListener("close", () => {
      clearInterval(phoneCanvasHeartbeat);
      phoneCanvasHeartbeat = 0;
      if (phoneCanvasSession) {
        phoneCanvasSetStatus("Connection ended before the phone joined. Your code is still available; tap Use phone to try again.", "error");
      }
      phoneCanvasSession = null;
      phoneCanvasSocket = null;
      button.disabled = false;
    });
    phoneCanvasSocket.addEventListener("error", () => phoneCanvasSetStatus("Could not connect to your phone. Check that both devices are on the same Wi-Fi and try again.", "error"));
  } catch (error) {
    phoneCanvasSetStatus(error.message || "Could not start a phone connection.", "error");
    phoneCanvasSession = null;
    button.disabled = false;
  }
}

function openCanvas(mode, question) {
  if (phoneCanvasSession) stopPhoneCanvas();
  $("#phoneCanvasPairPanel").hidden = true;
  $("#usePhoneCanvas").setAttribute("aria-expanded", "false");
  state.canvasContext = mode;
  state.canvasQuestion = question || null;
  state.canvasReturnFocus = document.activeElement;
  state.canvas = { mode: mode.endsWith("graph") ? "graph" : "write", strokes: [], scale: 1, offsetX: 0, offsetY: 0, pan: false, zoom: false, eraser: false, revision: 0, transcribedPhoto: null, photoPromise: null, active: null, drag: null, pointers: new Map(), pinch: null, size: { width: 0, height: 0 } };
  $("#canvasTitle").textContent = mode.endsWith("graph") ? "Draw a graph" : mode === "ask-write" ? "Write words / maths" : "Write or draw your answer";
  $("#canvasPanButton").setAttribute("aria-pressed", "false");
  $("#canvasPanButton").setAttribute("aria-label", "Enable pan mode");
  $("#canvasPanLabel").textContent = "Pan";
  $("#canvasZoomButton").setAttribute("aria-pressed", "false");
  $("#canvasZoomButton").setAttribute("aria-label", "Enable zoom");
  $("#canvasZoomButton").textContent = "Zoom off";
  $("#canvasEraserButton").setAttribute("aria-pressed", "false");
  $("#canvasEraserButton").setAttribute("aria-label", "Enable eraser");
  $("#canvasEraserButton").textContent = "Eraser";
  $("#canvasReadMathButton").hidden = mode.endsWith("graph");
  $("#canvasTranscriptionPanel").hidden = true;
  $("#canvasTranscriptionText").value = "";
  setStatus($("#canvasTranscriptionStatus"), "");
  const askPaperQuestion = (mode === "ask-write" || mode === "ask-graph") && state.selectedPaperQuestion;
  const hasQuestionSidebar = mode.startsWith("practice") || mode === "exam" || Boolean(askPaperQuestion);
  const sidebar = $("#canvasQuestionSidebar");
  sidebar.hidden = !hasQuestionSidebar;
  $(".canvas-layout").classList.toggle("has-question", hasQuestionSidebar);
  $("#toggleQuestionSidebar").hidden = !hasQuestionSidebar;
  $("#toggleQuestionSidebar").textContent = "Hide Q";
  const image = $("#canvasQuestionImage");
  image.hidden = true;
  image.removeAttribute("src");
  const contextQuestion = question || (askPaperQuestion ? state.selectedPaperQuestion : null);
  if (hasQuestionSidebar && contextQuestion) {
    renderMath($("#canvasQuestionText"), contextQuestion.question_text_latex || contextQuestion.accessible_text || contextQuestion.question_text || contextQuestion.text || questionLabel(contextQuestion));
    const visuals = mode.startsWith("practice") ? state.practiceVisuals : mode === "exam" ? state.examVisuals : [];
    const questionText = contextQuestion && (contextQuestion.question_text_latex || contextQuestion.accessible_text || contextQuestion.question_text || contextQuestion.text || questionLabel(contextQuestion));
    const source = askPaperQuestion ? state.paperPageImage : visuals && visuals.length ? diagramImageSource(visuals[0], questionText) : "";
    if (source) { image.src = source; image.hidden = false; }
  }
  if (!$("#canvasDialog").open) $("#canvasDialog").showModal();
  requestAnimationFrame(() => {
    resizeCanvas();
    drawCanvas();
    $("#workingCanvas").focus({ preventScroll: true });
  });
}

$("#canvasQuestionImage").addEventListener("click", () => {
  const source = $("#canvasQuestionImage").src;
  if (source) openImageViewer(source, "Question page");
});

function canvasPoint(event) {
  const rect = workingCanvas.getBoundingClientRect();
  const current = state.canvas;
  return {
    x: (event.clientX - rect.left - rect.width / 2 - current.offsetX) / current.scale + rect.width / 2,
    y: (event.clientY - rect.top - rect.height / 2 - current.offsetY) / current.scale + rect.height / 2,
  };
}

function resizeCanvas() {
  const rect = workingCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const old = state.canvas.size || { width: 0, height: 0 };
  if (old.width && old.height && (old.width !== rect.width || old.height !== rect.height)) {
    if (state.canvas.strokes.length) invalidateCanvasTranscription();
    const xRatio = rect.width / old.width;
    const yRatio = rect.height / old.height;
    state.canvas.strokes.forEach((stroke) => stroke.points.forEach((point) => { point.x *= xRatio; point.y *= yRatio; }));
  }
  state.canvas.size = { width: rect.width, height: rect.height };
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  workingCanvas.width = Math.round(rect.width * ratio);
  workingCanvas.height = Math.round(rect.height * ratio);
  drawCanvas();
}

function drawCanvas() {
  const context = workingCanvas.getContext("2d");
  const rect = workingCanvas.getBoundingClientRect();
  if (!context || !rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  if (workingCanvas.width !== Math.round(rect.width * ratio) || workingCanvas.height !== Math.round(rect.height * ratio)) {
    workingCanvas.width = Math.round(rect.width * ratio);
    workingCanvas.height = Math.round(rect.height * ratio);
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, workingCanvas.width, workingCanvas.height);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, workingCanvas.width, workingCanvas.height);
  context.setTransform(ratio * state.canvas.scale, 0, 0, ratio * state.canvas.scale,
    ratio * (rect.width / 2 + state.canvas.offsetX), ratio * (rect.height / 2 + state.canvas.offsetY));
  context.translate(-rect.width / 2, -rect.height / 2);
  context.lineCap = "round";
  context.lineJoin = "round";
  state.canvas.strokes.forEach((stroke) => {
    if (!stroke.points.length) return;
    context.beginPath();
    context.strokeStyle = stroke.tool === "eraser" ? "#fff" : (stroke.color || "#162a29");
    context.lineWidth = (stroke.width || 2.2) / state.canvas.scale;
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    if (stroke.points.length === 1) context.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y + 0.1);
    stroke.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.stroke();
  });
  context.setTransform(1, 0, 0, 1, 0, 0);
}

function fitCanvasToWriting() {
  const rect = workingCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  let hasPoints = false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  state.canvas.strokes.forEach((stroke) => stroke.points.forEach((point) => {
    hasPoints = true;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }));
  if (!hasPoints) {
    state.canvas.scale = 1;
    state.canvas.offsetX = 0;
    state.canvas.offsetY = 0;
    drawCanvas();
    return;
  }
  const padding = 28;
  const width = Math.max(8, maxX - minX);
  const height = Math.max(8, maxY - minY);
  const fitScale = Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height);
  state.canvas.scale = Math.min(50, Math.max(.0001, fitScale));
  state.canvas.offsetX = (rect.width / 2 - (minX + maxX) / 2) * state.canvas.scale;
  state.canvas.offsetY = (rect.height / 2 - (minY + maxY) / 2) * state.canvas.scale;
  drawCanvas();
}

function canvasDistance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function canvasMidpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function assertCanvasSnapshotCurrent(canvas, revision) {
  if (state.canvas !== canvas || canvas.revision !== revision) {
    throw new Error("The canvas changed while it was being processed. Please try again.");
  }
}

async function ensureCanvasPhoto(canvas, revision) {
  if (canvas.transcribedPhoto) return canvas.transcribedPhoto;
  if (canvas.photoPromise) return canvas.photoPromise;
  const photoPromise = (async () => {
    fitCanvasToWriting();
    const blob = await new Promise((resolve, reject) => workingCanvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("The canvas image could not be created.")),
      "image/png",
    ));
    assertCanvasSnapshotCurrent(canvas, revision);
    const file = new File([blob], "sharpertime-canvas-" + Date.now() + ".png", { type: "image/png" });
    const uploadContext = canvas.mode.startsWith("practice") ? "practice" : canvas.mode === "exam" ? "exam" : "ask";
    const inspectionId = await ensureInspection(uploadContext);
    assertCanvasSnapshotCurrent(canvas, revision);
    const form = new FormData();
    form.set("photo_type", "school_answer_working");
    form.set("photo", file, file.name);
    const uploaded = await uploadForm("/api/inspections/" + encodeURIComponent(inspectionId) + "/upload-photo", form);
    assertCanvasSnapshotCurrent(canvas, revision);
    const photoId = uploaded.id || uploaded.photo_id;
    if (!photoId) throw new Error("The canvas image could not be saved.");
    canvas.transcribedPhoto = { inspectionId, photoId, file, blob };
    return canvas.transcribedPhoto;
  })();
  canvas.photoPromise = photoPromise;
  try {
    return await photoPromise;
  } finally {
    if (canvas.photoPromise === photoPromise) canvas.photoPromise = null;
  }
}

function setCanvasTranscriptionLoading(loading, message = "") {
  const status = $("#canvasTranscriptionStatus");
  status.textContent = message;
  status.dataset.loading = String(loading);
}

$("#canvasReadMathButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const canvas = state.canvas;
  const revision = canvas.revision;
  if (!canvas.strokes.length) {
    showToast("Write some maths on the canvas first.");
    return;
  }
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Reading…";
  $("#canvasTranscriptionPanel").hidden = false;
  $("#canvasTranscriptionText").value = "";
  setCanvasTranscriptionLoading(true, "Reading your maths, please wait…");
  try {
    const photo = await ensureCanvasPhoto(canvas, revision);
    assertCanvasSnapshotCurrent(canvas, revision);
    const result = await postJson("/api/education/photo/transcribe-math", {
      inspection_id: photo.inspectionId,
      photo_id: photo.photoId,
      subject: "Mathematics",
      grade: Math.max(8, Math.min(12, Number(state.grade) || 12)),
      context: [
        "Handwriting canvas. Recognize only the learner's handwritten mathematical expressions as editable LaTeX. Do not solve, correct, or add steps.",
        state.canvasQuestion?.question_text_latex || state.canvasQuestion?.accessible_text || state.canvasQuestion?.question_text || state.canvasQuestion?.text || "",
      ].filter(Boolean).join("\n"),
      ai_tier: "unimernet",
    });
    assertCanvasSnapshotCurrent(canvas, revision);
    const latex = String(result.editable_latex || "").trim();
    $("#canvasTranscriptionText").value = latex;
    setCanvasTranscriptionLoading(false, latex
      ? "Review and edit the recognized maths before using it."
      : "No maths was recognized. You can enter it here or submit the handwriting as-is.");
    $("#canvasTranscriptionText").focus({ preventScroll: true });
  } catch {
    if (state.canvas === canvas && canvas.revision === revision) {
      setCanvasTranscriptionLoading(false, "Could not read the maths this time. You can still submit your handwriting.");
    }
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Read maths";
  }
});

$("#canvasTranscriptionClose").addEventListener("click", () => {
  $("#canvasTranscriptionPanel").hidden = true;
  setCanvasTranscriptionLoading(false);
});

$("#canvasTranscriptionUse").addEventListener("click", () => {
  const value = $("#canvasTranscriptionText").value.trim();
  if (!value) {
    setCanvasTranscriptionLoading(false, "Enter or recognize some maths first.");
    return;
  }
  if (state.canvasContext.startsWith("practice")) {
    if (getPracticeEditorLatex().trim()) practiceEditorCommand({ name: "newLine" });
    if (!practiceEditorCommand({ name: "insertLatex", value })) {
      showToast("The maths editor is not ready yet. Please try again.");
      return;
    }
    setPracticeKeyboardVisible(true);
  } else if (state.canvasContext === "exam") {
    const answer = $("#examAnswer");
    answer.value = [answer.value.trimEnd(), value].filter(Boolean).join(answer.value.trim() ? "\n" : "");
    answer.dispatchEvent(new Event("input", { bubbles: true }));
    answer.focus({ preventScroll: true });
  } else {
    appendToComposer(value);
  }
  $("#canvasTranscriptionPanel").hidden = true;
  setCanvasTranscriptionLoading(false);
  showToast("Recognized maths added. Check it before submitting your answer.");
});

workingCanvas.addEventListener("pointerdown", (event) => {
  const current = state.canvas;
  event.preventDefault();
  workingCanvas.setPointerCapture(event.pointerId);
  current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (current.pointers.size === 2) {
    if (current.active) {
      invalidateCanvasTranscription();
      current.strokes.pop();
      current.active = null;
    }
    const pair = [...current.pointers.values()];
    current.pinch = current.zoom ? { distance: canvasDistance(pair[0], pair[1]), scale: current.scale, offsetX: current.offsetX, offsetY: current.offsetY, midpoint: canvasMidpoint(pair[0], pair[1]) } : null;
    return;
  }
  if (current.pan) {
    current.drag = { x: event.clientX, y: event.clientY, offsetX: current.offsetX, offsetY: current.offsetY };
    return;
  }
  invalidateCanvasTranscription();
  const eraser = current.eraser;
  const stroke = { points: [canvasPoint(event)], color: eraser ? "#fff" : "#162a29", tool: eraser ? "eraser" : "pen", width: eraser ? 24 : (event.pointerType === "pen" ? 2.5 : 2.2) };
  current.strokes.push(stroke);
  current.active = stroke;
  drawCanvas();
});
workingCanvas.addEventListener("pointermove", (event) => {
  const current = state.canvas;
  if (!current.pointers.has(event.pointerId)) return;
  current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const pair = [...current.pointers.values()];
  const rect = workingCanvas.getBoundingClientRect();
  if (pair.length >= 2 && current.pinch) {
    const midpoint = canvasMidpoint(pair[0], pair[1]);
    const scale = Math.min(50, Math.max(.0001, current.pinch.scale * canvasDistance(pair[0], pair[1]) / Math.max(1, current.pinch.distance)));
    const fx = current.pinch.midpoint.x - rect.left - rect.width / 2;
    const fy = current.pinch.midpoint.y - rect.top - rect.height / 2;
    current.offsetX = fx - (fx - current.pinch.offsetX) * scale / current.pinch.scale + midpoint.x - current.pinch.midpoint.x;
    current.offsetY = fy - (fy - current.pinch.offsetY) * scale / current.pinch.scale + midpoint.y - current.pinch.midpoint.y;
    current.scale = scale;
    drawCanvas();
  } else if (current.drag) {
    current.offsetX = current.drag.offsetX + event.clientX - current.drag.x;
    current.offsetY = current.drag.offsetY + event.clientY - current.drag.y;
    drawCanvas();
  } else if (current.active && pair.length === 1) {
    current.active.points.push(canvasPoint(event));
    drawCanvas();
  }
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => workingCanvas.addEventListener(eventName, (event) => {
  const current = state.canvas;
  current.pointers.delete(event.pointerId);
  if (current.pointers.size < 2) current.pinch = null;
  if (!current.pointers.size) { current.active = null; current.drag = null; }
}));
workingCanvas.addEventListener("wheel", (event) => {
  if (!state.canvas.zoom) return;
  event.preventDefault();
  const current = state.canvas;
  const rect = workingCanvas.getBoundingClientRect();
  const fx = event.clientX - rect.left - rect.width / 2;
  const fy = event.clientY - rect.top - rect.height / 2;
  const oldScale = current.scale;
  current.scale = Math.min(50, Math.max(.0001, oldScale * (event.deltaY < 0 ? 1.12 : 0.89)));
  current.offsetX = fx - (fx - current.offsetX) * current.scale / oldScale;
  current.offsetY = fy - (fy - current.offsetY) * current.scale / oldScale;
  drawCanvas();
}, { passive: false });

$("#canvasPanButton").addEventListener("click", (event) => {
  state.canvas.pan = !state.canvas.pan;
  event.currentTarget.setAttribute("aria-pressed", String(state.canvas.pan));
  event.currentTarget.setAttribute("aria-label", state.canvas.pan ? "Disable pan mode" : "Enable pan mode");
  $("#canvasPanLabel").textContent = state.canvas.pan ? "Pan on" : "Pan";
});
$("#canvasZoomButton").addEventListener("click", (event) => {
  state.canvas.zoom = !state.canvas.zoom;
  state.canvas.pinch = null;
  event.currentTarget.setAttribute("aria-pressed", String(state.canvas.zoom));
  event.currentTarget.setAttribute("aria-label", state.canvas.zoom ? "Disable zoom" : "Enable zoom");
  event.currentTarget.textContent = state.canvas.zoom ? "Zoom on" : "Zoom off";
});
$("#canvasEraserButton").addEventListener("click", (event) => {
  state.canvas.eraser = !state.canvas.eraser;
  event.currentTarget.setAttribute("aria-pressed", String(state.canvas.eraser));
  event.currentTarget.setAttribute("aria-label", state.canvas.eraser ? "Disable eraser" : "Enable eraser");
  event.currentTarget.textContent = state.canvas.eraser ? "Eraser on" : "Eraser";
});
$("#canvasDialog").addEventListener("close", () => {
  if (state.canvasReturnFocus instanceof HTMLElement) state.canvasReturnFocus.focus({ preventScroll: true });
});
$("#canvasFitButton").addEventListener("click", fitCanvasToWriting);
$("#undoCanvas").addEventListener("click", () => {
  if (state.canvas.strokes.length) invalidateCanvasTranscription();
  state.canvas.strokes.pop();
  drawCanvas();
  if (phoneCanvasSession) phoneCanvasSend({ type: "setup", strokes: phoneCanvasSnapshot() });
});
$("#clearCanvas").addEventListener("click", () => {
  if (state.canvas.strokes.length) invalidateCanvasTranscription();
  state.canvas.strokes = [];
  drawCanvas();
  if (phoneCanvasSession) phoneCanvasSend({ type: "setup", strokes: [] });
});
$("#toggleQuestionSidebar").addEventListener("click", () => {
  const sidebar = $("#canvasQuestionSidebar");
  sidebar.hidden = !sidebar.hidden;
  $(".canvas-layout").classList.toggle("has-question", !sidebar.hidden);
  $("#toggleQuestionSidebar").textContent = sidebar.hidden ? "Show Q" : "Hide Q";
});
$("#closeCanvasQuestion").addEventListener("click", () => {
  $("#canvasQuestionSidebar").hidden = true;
  $(".canvas-layout").classList.remove("has-question");
  $("#toggleQuestionSidebar").textContent = "Show Q";
});
$("#canvasDialog").addEventListener("close", () => {
  if (state.canvasReturnFocus instanceof HTMLElement) state.canvasReturnFocus.focus({ preventScroll: true });
});
if (window.ResizeObserver) {
  new ResizeObserver(() => { if ($("#canvasDialog").open) resizeCanvas(); }).observe($(".drawing-surface"));
} else {
  window.addEventListener("resize", () => { if ($("#canvasDialog").open) resizeCanvas(); });
}
window.addEventListener("resize", () => { if ($("#canvasDialog").open) resizeCanvas(); });

$("#usePhoneCanvas").addEventListener("click", async () => {
  const panel = $("#phoneCanvasPairPanel");
  if (!panel.hidden && !phoneCanvasSession) {
    await startPhoneCanvas();
    return;
  }
  panel.hidden = !panel.hidden;
  $("#usePhoneCanvas").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) await startPhoneCanvas();
});
$("#stopPhoneCanvas").addEventListener("click", () => stopPhoneCanvas());
$("#canvasDialog").addEventListener("close", () => {
  if (Date.now() < phoneCanvasSubmissionSentUntil) {
    clearTimeout(phoneCanvasCloseTimer);
    phoneCanvasCloseTimer = setTimeout(() => {
      phoneCanvasCloseTimer = 0;
      stopPhoneCanvas();
    }, Math.max(0, phoneCanvasSubmissionSentUntil - Date.now()));
  } else if (phoneCanvasSession) stopPhoneCanvas();
});

$("#finishCanvas").addEventListener("click", async () => {
  const button = $("#finishCanvas");
  const canvas = state.canvas;
  const revision = canvas.revision;
  if (state.canvasContext.startsWith("practice") && state.practiceAnswerPhotoIds.length >= 3) {
    showToast("The limit is three handwritten images per practice attempt.");
    if (phoneCanvasSession) phoneCanvasSend({ type: "submission_error", message: "This attempt already has the maximum number of handwritten images." });
    return;
  }
  button.disabled = true;
  try {
    fitCanvasToWriting();
    const photo = await ensureCanvasPhoto(canvas, revision);
    assertCanvasSnapshotCurrent(canvas, revision);
    const { file, blob, photoId } = photo;
    const previewUrl = URL.createObjectURL(blob);
    if (state.canvasContext === "ask-write" || state.canvasContext === "ask-graph") {
      state.askPhotos.push({ id: photoId, filename: file.name, previewUrl });
      appendMessage("Canvas working attached. It will be included when you press Send.", { kind: "Canvas working", imageUrl: previewUrl });
      $("#askInput").focus({ preventScroll: true });
    } else if (state.canvasContext.startsWith("practice")) {
      if (photoId && !state.practiceAnswerPhotoIds.includes(photoId)) state.practiceAnswerPhotoIds.push(photoId);
      state.practiceAnswerPhotoPreviews.push({ id: photoId, url: previewUrl });
      const key = practiceQuestionStorageKey(PRACTICE_SESSION_KEYS.photosPrefix);
      if (key) sessionStorage.setItem(key, JSON.stringify(state.practiceAnswerPhotoIds));
      renderPracticeAnswerAttachments();
      showToast("Canvas working attached. Send it for marking when ready.");
    } else if (state.canvasContext === "exam") {
      const question = state.examCurrentQuestion;
      if (question && photoId) {
        const existing = state.examAnswerAttachments.get(question.id) || [];
        state.examAnswerAttachments.set(question.id, [...new Set(existing.concat(photoId))].slice(0, 12));
      }
      showToast("Canvas working attached to this assessment answer.");
    }
    if (phoneCanvasSession && phoneCanvasSocket?.readyState === WebSocket.OPEN) {
      phoneCanvasSubmissionSentUntil = Date.now() + 1200;
      phoneCanvasSend({ type: "submitted" });
    }
    $("#canvasDialog").close();
  } catch (error) {
    if (phoneCanvasSession) phoneCanvasSend({ type: "submission_error", message: error.message || "Canvas submission failed." });
    showToast(error.message);
  } finally { button.disabled = false; }
});

function registerImageGestures() {
  const viewport = $("#imageViewport");
  const pointers = new Map();
  let pinch = null;
  let drag = null;
  viewport.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const pair = [...pointers.values()];
      pinch = { distance: canvasDistance(pair[0], pair[1]), scale: state.imageView.scale, x: state.imageView.x, y: state.imageView.y, midpoint: canvasMidpoint(pair[0], pair[1]) };
      drag = null;
    } else drag = { x: event.clientX, y: event.clientY, startX: state.imageView.x, startY: state.imageView.y };
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pair = [...pointers.values()];
    const rect = viewport.getBoundingClientRect();
    if (pair.length >= 2 && pinch) {
      const midpoint = canvasMidpoint(pair[0], pair[1]);
      const scale = Math.min(6, Math.max(0.5, pinch.scale * canvasDistance(pair[0], pair[1]) / Math.max(1, pinch.distance)));
      const fx = pinch.midpoint.x - rect.left - rect.width / 2;
      const fy = pinch.midpoint.y - rect.top - rect.height / 2;
      state.imageView.x = fx - (fx - pinch.x) * scale / pinch.scale + midpoint.x - pinch.midpoint.x;
      state.imageView.y = fy - (fy - pinch.y) * scale / pinch.scale + midpoint.y - pinch.midpoint.y;
      state.imageView.scale = scale;
      applyImageTransform();
    } else if (pair.length === 1 && drag) {
      state.imageView.x = drag.startX + event.clientX - drag.x;
      state.imageView.y = drag.startY + event.clientY - drag.y;
      applyImageTransform();
    }
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => viewport.addEventListener(eventName, (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) drag = null;
  }));
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const fx = event.clientX - rect.left - rect.width / 2;
    const fy = event.clientY - rect.top - rect.height / 2;
    const oldScale = state.imageView.scale;
    state.imageView.scale = Math.min(6, Math.max(0.5, oldScale * (event.deltaY < 0 ? 1.12 : 0.89)));
    state.imageView.x = fx - (fx - state.imageView.x) * state.imageView.scale / oldScale;
    state.imageView.y = fy - (fy - state.imageView.y) * state.imageView.scale / oldScale;
    applyImageTransform();
  }, { passive: false });
}
registerImageGestures();
