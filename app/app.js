import { API_BASE_URL, apiRequest, getAccessToken, getJson, postForm, postJson, setAccessToken, uploadForm } from "./api.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  user: null,
  grade: 12,
  view: "ask",
  inspectionId: sessionStorage.getItem("sharperx_web_inspection_id") || "",
  practiceInspectionId: sessionStorage.getItem("sharperx_web_practice_inspection_id") || "",
  examInspectionId: sessionStorage.getItem("sharperx_web_exam_inspection_id") || "",
  paperDocumentId: sessionStorage.getItem("sharperx_web_paper_id") || "",
  memoDocumentId: sessionStorage.getItem("sharperx_web_memo_id") || "",
  paperFileName: sessionStorage.getItem("sharperx_web_paper_name") || "",
  selectedPaperQuestion: null,
  paperPageImage: "",
  askPhotos: [],
  topicCatalogs: new Map(),
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
  reportObjectUrls: new Set(),
  recorder: null,
  audioChunks: [],
  canvas: { mode: "write", strokes: [], scale: 1, offsetX: 0, offsetY: 0, pan: false, active: null, pointers: new Map(), pinch: null, size: { width: 0, height: 0 } },
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
  if (window.MathJax?.typesetPromise) {
    window.MathJax.typesetClear?.([target]);
    window.MathJax.typesetPromise([target]).catch(() => {});
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatGrade(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(8, Math.min(12, parsed)) : 12;
}

function showWorkspace() {
  $("#authScreen").hidden = true;
  $("#workspace").hidden = false;
  $("#accountLabel").textContent = state.user?.full_name || state.user?.email || "";
  $("#globalGrade").value = String(state.grade);
  restorePaperSession();
  loadSavedReports();
  registerServiceWorker();
  renderSourceLinks();
  restoreExamSession();
}

function showAuth() {
  $("#workspace").hidden = true;
  $("#authScreen").hidden = false;
}

async function checkSession() {
  if (!getAccessToken()) return showAuth();
  try {
    state.user = await getJson("/api/auth/me");
    showWorkspace();
  } catch (error) {
    setAccessToken("");
    showAuth();
    setStatus($("#loginStatus"), "Your session has expired. Sign in again.", "error");
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#loginForm button[type='submit']");
  const form = new FormData(event.currentTarget);
  button.disabled = true;
  setStatus($("#loginStatus"), "Signing in…");
  try {
    const result = await postForm("/api/auth/login", {
      email: String(form.get("email") || "").trim(),
      password: String(form.get("password") || ""),
    }, { auth: false });
    if (!result.access_token) throw new Error("The server did not return a sign-in token.");
    setAccessToken(result.access_token);
    state.user = result.user || {};
    event.currentTarget.reset();
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
  showAuth();
});

function activateView(viewName) {
  state.view = viewName;
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName));
  $$("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === viewName;
    panel.hidden = !active;
    panel.classList.toggle("is-visible", active);
  });
  if (viewName === "practice") loadPracticeTopics(formatGrade($("#practiceGrade").value)).catch((error) => setStatus($("#practiceStatus"), error.message, "error"));
  if (viewName === "exam" && !state.examTopics.length) loadExamTopics().catch((error) => setStatus($("#examStatus"), error.message, "error"));
  if (viewName === "lessons") loadLessons().catch((error) => setStatus($("#lessonStatus"), error.message, "error"));
  if (viewName === "reports") loadSavedReports();
}

$$('[data-view]').forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));

$("#globalGrade").addEventListener("change", (event) => {
  state.grade = formatGrade(event.currentTarget.value);
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
  const storageKey = context === "practice" ? "sharperx_web_practice_inspection_id" : context === "exam" ? "sharperx_web_exam_inspection_id" : "sharperx_web_inspection_id";
  if (state[stateKey]) return Promise.resolve(state[stateKey]);
  const form = new FormData();
  form.set("client_name", state.user?.full_name || state.user?.email || "SharperTime learner");
  form.set("site_address", "SharperTime mathematics workspace");
  form.set("inspection_type", "mathematics");
  return uploadForm("/api/inspections/create", form).then((result) => {
    const id = result.id || result.inspection_id;
    if (!id) throw new Error("The server did not return a workspace id for uploads.");
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
    if (!documentId) throw new Error("The server accepted the file but did not return its document id.");
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
    if (!pageBase64) throw new Error("The server did not return the full page containing that question.");
    const questionText = result.question_text || result.extracted_question_text || "";
    if (!questionText.trim()) throw new Error("The server could not read the selected question text. Try a clearer paper scan or a different question number.");
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
  const input = $("#askInput");
  const text = input.value.trim();
  const selected = state.selectedPaperQuestion;
  if (!text && !selected && state.askPhotos.length === 0) {
    input.focus();
    return showToast("Type a question or select a question from your paper first.");
  }
  const button = $("#sendAskButton");
  button.disabled = true;
  const attachedImage = state.askPhotos.at(-1)?.previewUrl || "";
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
    };
    if (selected && selected.memoText) payload.question = `${selected.text}\n\nMarking reference is available on the server. Use it to verify marking without reproducing it verbatim.`;
    setStatus($("#voiceStatus"), "Sending to SharperTime…");
    const result = await postJson("/api/education/tutor/ask", payload);
    const responseText = readTutorText(result);
    appendMessage(responseText, {
      kind: result.answer_type || result.mode || "Tutor response",
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
  return JSON.stringify(result, null, 2);
}

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

async function loadPracticeTopics(grade) {
  const topicSelect = $("#practiceTopic");
  const subtopicSelect = $("#practiceSubtopic");
  setStatus($("#practiceStatus"), "Loading topics from the server question bank…");
  topicSelect.disabled = true;
  subtopicSelect.disabled = true;
  try {
    const topics = await loadTopicCatalog(grade);
    state.practiceTopics = topics;
    replaceOptions(topicSelect, topics.map((topic) => ({ label: `${topic.name} · ${topic.count}`, value: topic.id })), "Select a topic");
    replaceOptions(subtopicSelect, [], "Select a topic first");
    setStatus($("#practiceStatus"), `${topics.length} server topics available for Grade ${grade}.`, "success");
  } catch (error) {
    setStatus($("#practiceStatus"), error.message, "error");
  }
}

$("#practiceGrade").addEventListener("change", (event) => {
  state.grade = formatGrade(event.currentTarget.value);
  $("#globalGrade").value = String(state.grade);
  renderSourceLinks();
  loadPracticeTopics(state.grade);
  $("#practiceQuestionList").replaceChildren();
  $("#practiceQuestionCard").hidden = true;
});

$("#practiceTopic").addEventListener("change", async (event) => {
  const grade = formatGrade($("#practiceGrade").value);
  const topicId = event.currentTarget.value;
  const topic = state.practiceTopics?.find((item) => item.id === topicId);
  const subtopicSelect = $("#practiceSubtopic");
  replaceOptions(subtopicSelect, [], "Loading subtopics…");
  if (!topicId) return;
  try {
    const subtopics = await getJson(`/api/education/math-question-bank/subtopics?grade=${grade}&topic_id=${encodeURIComponent(topicId)}`);
    state.practiceSubtopics = subtopics || [];
    replaceOptions(subtopicSelect, state.practiceSubtopics.map((item) => ({
      label: `${item.subtopic || item.name || item.subtopic_id} · ${item.question_count ?? ""}`.replace(/\s·\s$/, ""),
      value: String(item.subtopic_id || item.id || ""),
    })), "Select a subtopic");
    setStatus($("#practiceStatus"), `${state.practiceSubtopics.length} subtopics available for ${topic?.name || "this topic"}.`, "success");
  } catch (error) {
    replaceOptions(subtopicSelect, [], "Subtopics could not be loaded");
    setStatus($("#practiceStatus"), error.message, "error");
  }
});

async function loadAllQuestions(grade, topicId, subtopicId) {
  const pageSize = 5000;
  const questions = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({ grade: String(grade), topic_id: topicId, subtopic_id: subtopicId, limit: String(pageSize), offset: String(offset) });
    const page = await getJson(`/api/education/math-question-bank/questions?${params}`);
    if (!Array.isArray(page)) throw new Error("The server returned an invalid question list.");
    questions.push(...page);
    if (page.length < pageSize) break;
  }
  return questions;
}

$("#loadPracticeQuestions").addEventListener("click", async () => {
  const grade = formatGrade($("#practiceGrade").value);
  const topicId = $("#practiceTopic").value;
  const subtopicId = $("#practiceSubtopic").value;
  if (!topicId || !subtopicId) return setStatus($("#practiceStatus"), "Select a topic and subtopic first.", "error");
  const button = $("#loadPracticeQuestions");
  button.disabled = true;
  setStatus($("#practiceStatus"), "Loading every question for this server subtopic…");
  try {
    state.practiceQuestions = await loadAllQuestions(grade, topicId, subtopicId);
    renderPracticeQuestionList();
    setStatus($("#practiceStatus"), `${state.practiceQuestions.length} questions loaded from the server question bank.`, "success");
    if (state.practiceQuestions[0]) await selectPracticeQuestion(state.practiceQuestions[0]);
  } catch (error) {
    setStatus($("#practiceStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

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
    button.dataset.questionId = question.question_id || question.id || "";
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

function diagramImageSource(visual) {
  const diagram = visual?.diagram || visual?.visual || visual || {};
  const base64 = diagram.image_base64 || diagram.png_base64 || visual?.image_base64 || "";
  if (base64) return base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  const svg = diagram.svg || diagram.svg_markup || visual?.svg;
  if (typeof svg === "string" && svg.includes("<svg")) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const url = diagram.image_url || diagram.url || visual?.image_url || visual?.url;
  if (typeof url === "string" && url.trim()) {
    try { return new URL(url, API_BASE_URL).href; } catch { return ""; }
  }
  return "";
}

async function preparePracticeVisuals(question) {
  let visuals = collectVisuals(question);
  if (!visuals.length || !question.question_id) return visuals;
  try {
    const prepared = await postJson(`/api/education/math-question-bank/questions/${encodeURIComponent(question.question_id)}/visuals/prepare`, {});
    if (Array.isArray(prepared.question_visuals) && prepared.question_visuals.length) visuals = prepared.question_visuals;
    else if (Array.isArray(prepared.visuals) && prepared.visuals.length) visuals = prepared.visuals;
    else if (prepared.diagram) visuals = [{ role: "question", diagram: prepared.diagram }];
  } catch {
    // If visual review is unavailable, preserve and display the bank's validated source visual.
  }
  return visuals;
}

async function selectPracticeQuestion(question) {
  state.currentPracticeQuestion = question;
  state.hintIndex = 0;
  state.practiceVisuals = collectVisuals(question);
  $("#practiceQuestionCard").hidden = false;
  $("#practiceQuestionMeta").textContent = `Grade ${question.grade || $("#practiceGrade").value} · ${question.topic || "Mathematics"} · ${question.subtopic || $("#practiceSubtopic").selectedOptions[0]?.textContent || ""} · ${question.marks || 0} marks`;
  renderMath($("#practiceQuestionText"), questionLabel(question));
  $("#practiceHints").hidden = true;
  $("#practiceHints").textContent = "";
  $("#practiceAnswer").value = "";
  $("#practiceFeedback").hidden = true;
  $("#practiceFeedback").replaceChildren();
  $("#practiceFullScreen").hidden = true;
  $("#practiceVisuals").replaceChildren();
  $$(".question-list-button").forEach((button) => button.classList.toggle("is-active", button.dataset.questionId === String(question.question_id || question.id || "")));
  $("#practiceMarkStatus").textContent = "";

  if (collectVisuals(question).length) {
    $("#practiceVisuals").innerHTML = '<p class="muted">Preparing the question diagram…</p>';
    state.practiceVisuals = await preparePracticeVisuals(question);
    renderQuestionVisuals($("#practiceVisuals"), state.practiceVisuals, `Grade ${question.grade || state.grade} question diagram`);
    const hasImage = $$("img", $("#practiceVisuals")).length > 0;
    $("#practiceFullScreen").hidden = !hasImage;
  }
}

function renderQuestionVisuals(container, visuals, title) {
  container.replaceChildren();
  for (const visual of visuals || []) {
    const imageSource = diagramImageSource(visual);
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
  const hints = Array.isArray(question.progressive_hints) ? question.progressive_hints : [];
  const selected = hints.slice(0, Math.max(1, ++state.hintIndex)).map(displayStructuredContent).filter(Boolean);
  const content = selected.length
    ? selected.join("\n\n")
    : "Underline what the question asks you to find. List the given values, then choose a matching rule or theorem and apply it one step at a time. Check the result against the question's conditions.";
  $("#practiceHints").hidden = false;
  renderMath($("#practiceHints"), content);
});

$("#practiceFormulaButton").addEventListener("click", () => {
  const formulas = state.currentPracticeQuestion?.relevant_formulas || [];
  const content = formulas.length ? formulas.map(displayStructuredContent).filter(Boolean).join("\n\n") : "No specific formula is listed for this question. Identify the values and relationships in the question, then select the rule that applies.";
  $("#practiceHints").hidden = false;
  renderMath($("#practiceHints"), content);
});

$("#practiceCanvasButton").addEventListener("click", () => openCanvas("practice", state.currentPracticeQuestion));

$("#markPracticeAnswer").addEventListener("click", async () => {
  const question = state.currentPracticeQuestion;
  const working = $("#practiceAnswer").value.trim();
  if (!question) return;
  if (!working) return setStatus($("#practiceMarkStatus"), "Enter your working or answer before sending it for marking.", "error");
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
      learner_final_answer: working.split(/\r?\n/).filter(Boolean).at(-1) || working,
      assistance_mode: "SolveItMyself",
      hints_used: state.hintIndex,
    };
    let result;
    if (state.attachedCanvasPhotoId) {
      result = await postJson("/api/education/tutor/ask", {
        subject: "Mathematics", grade: question.grade || state.grade,
        topic: question.topic || "", question: questionLabel(question),
        learner_answer: working || "My handwritten working is in the attached canvas image.",
        mode: "mark_attempt", inspection_id: state.practiceInspectionId,
        ai_tier: "luna", allow_web_search: false,
        math_practice_context: markingContext,
      });
      state.attachedCanvasPhotoId = "";
      state.practiceCanvasPreview = "";
    } else {
      result = await postJson("/api/education/math-practice/mark", markingContext);
    }
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
    const id = globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2);
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
  setStatus($("#examStatus"), "The server is building and checking your assessment…");
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
    $("#examPaperSummary").textContent = (result.title || "Assessment ready") + " · " + (result.questions || []).length + " questions · " + result.total_marks + " marks · " + result.duration_minutes + " minutes. The server checked this paper.";
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
  if (!question) throw new Error("The server did not return the current assessment question.");
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
  if (state.examVisuals.length) {
    state.examVisuals = await preparePracticeVisuals(Object.assign({}, question, { question_id: question.bank_question_id || question.id }));
    renderQuestionVisuals($("#examQuestionVisuals"), state.examVisuals, "Assessment diagram");
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

const workingCanvas = $("#workingCanvas");
function openCanvas(mode, question) {
  state.canvasContext = mode;
  state.canvasQuestion = question || null;
  state.canvasReturnFocus = document.activeElement;
  state.canvas = { mode: mode.endsWith("graph") ? "graph" : "write", strokes: [], scale: 1, offsetX: 0, offsetY: 0, pan: false, active: null, drag: null, pointers: new Map(), pinch: null, size: { width: 0, height: 0 } };
  $("#canvasTitle").textContent = mode === "ask-graph" ? "Draw a graph" : mode === "ask-write" ? "Write words / maths" : "Write or draw your answer";
  $("#canvasPanButton").setAttribute("aria-pressed", "false");
  $("#canvasPanButton").textContent = "☝ Pan";
  const askPaperQuestion = (mode === "ask-write" || mode === "ask-graph") && state.selectedPaperQuestion;
  const hasQuestionSidebar = mode === "practice" || mode === "exam" || Boolean(askPaperQuestion);
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
    const visuals = mode === "practice" ? state.practiceVisuals : mode === "exam" ? state.examVisuals : [];
    const source = askPaperQuestion ? state.paperPageImage : visuals && visuals.length ? diagramImageSource(visuals[0]) : "";
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
    context.strokeStyle = stroke.color || "#162a29";
    context.lineWidth = (stroke.width || 2.2) / state.canvas.scale;
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    if (stroke.points.length === 1) context.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y + 0.1);
    stroke.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.stroke();
  });
  context.setTransform(1, 0, 0, 1, 0, 0);
}

function canvasDistance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function canvasMidpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

workingCanvas.addEventListener("pointerdown", (event) => {
  const current = state.canvas;
  event.preventDefault();
  workingCanvas.setPointerCapture(event.pointerId);
  current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (current.pointers.size === 2) {
    if (current.active) { current.strokes.pop(); current.active = null; }
    const pair = [...current.pointers.values()];
    current.pinch = { distance: canvasDistance(pair[0], pair[1]), scale: current.scale, offsetX: current.offsetX, offsetY: current.offsetY, midpoint: canvasMidpoint(pair[0], pair[1]) };
    return;
  }
  if (current.pan) {
    current.drag = { x: event.clientX, y: event.clientY, offsetX: current.offsetX, offsetY: current.offsetY };
    return;
  }
  const stroke = { points: [canvasPoint(event)], color: "#162a29", width: event.pointerType === "pen" ? 2.5 : 2.2 };
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
    const scale = Math.min(4, Math.max(0.45, current.pinch.scale * canvasDistance(pair[0], pair[1]) / Math.max(1, current.pinch.distance)));
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
  event.preventDefault();
  const current = state.canvas;
  const rect = workingCanvas.getBoundingClientRect();
  const fx = event.clientX - rect.left - rect.width / 2;
  const fy = event.clientY - rect.top - rect.height / 2;
  const oldScale = current.scale;
  current.scale = Math.min(4, Math.max(0.45, oldScale * (event.deltaY < 0 ? 1.12 : 0.89)));
  current.offsetX = fx - (fx - current.offsetX) * current.scale / oldScale;
  current.offsetY = fy - (fy - current.offsetY) * current.scale / oldScale;
  drawCanvas();
}, { passive: false });

$("#canvasPanButton").addEventListener("click", (event) => {
  state.canvas.pan = !state.canvas.pan;
  event.currentTarget.setAttribute("aria-pressed", String(state.canvas.pan));
  event.currentTarget.textContent = state.canvas.pan ? "☝ Pan on" : "☝ Pan";
});
$("#canvasDialog").addEventListener("close", () => {
  if (state.canvasReturnFocus instanceof HTMLElement) state.canvasReturnFocus.focus({ preventScroll: true });
});
$("#canvasFitButton").addEventListener("click", () => { state.canvas.scale = 1; state.canvas.offsetX = 0; state.canvas.offsetY = 0; drawCanvas(); });
$("#undoCanvas").addEventListener("click", () => { state.canvas.strokes.pop(); drawCanvas(); });
$("#clearCanvas").addEventListener("click", () => { state.canvas.strokes = []; drawCanvas(); });
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
new ResizeObserver(() => { if ($("#canvasDialog").open) resizeCanvas(); }).observe($(".drawing-surface"));
window.addEventListener("resize", () => { if ($("#canvasDialog").open) resizeCanvas(); });

$("#finishCanvas").addEventListener("click", async () => {
  const button = $("#finishCanvas");
  button.disabled = true;
  try {
    const blob = await new Promise((resolve, reject) => workingCanvas.toBlob((value) => value ? resolve(value) : reject(new Error("The canvas image could not be created.")), "image/png"));
    const file = new File([blob], "sharpertime-canvas-" + Date.now() + ".png", { type: "image/png" });
    const uploadContext = state.canvasContext === "practice" ? "practice" : state.canvasContext === "exam" ? "exam" : "ask";
    const inspectionId = await ensureInspection(uploadContext);
    const form = new FormData();
    form.set("photo_type", state.canvasContext + "_handwritten_working");
    form.set("photo", file, file.name);
    const uploaded = await uploadForm("/api/inspections/" + encodeURIComponent(inspectionId) + "/upload-photo", form);
    const photoId = uploaded.id || uploaded.photo_id;
    const previewUrl = URL.createObjectURL(blob);
    if (state.canvasContext === "ask-write" || state.canvasContext === "ask-graph") {
      state.askPhotos.push({ id: photoId, filename: file.name, previewUrl });
      appendMessage("Canvas working attached. It will be included when you press Send.", { kind: "Canvas working", imageUrl: previewUrl });
      $("#askInput").focus({ preventScroll: true });
    } else if (state.canvasContext === "practice") {
      state.attachedCanvasPhotoId = photoId;
      state.practiceCanvasPreview = previewUrl;
      showToast("Canvas working attached. Send it for marking when ready.");
    } else if (state.canvasContext === "exam") {
      const question = state.examCurrentQuestion;
      if (question && photoId) {
        const existing = state.examAnswerAttachments.get(question.id) || [];
        state.examAnswerAttachments.set(question.id, [...new Set(existing.concat(photoId))].slice(0, 12));
      }
      showToast("Canvas working attached to this assessment answer.");
    }
    $("#canvasDialog").close();
  } catch (error) {
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
