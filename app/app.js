import { API_BASE_URL, apiRequest, getAccessToken, getClientDeviceLabel, getJson, postForm, postJson, postPairingJson, pairingWebSocketUrl, isLocalIntranetPage, setAccessToken, uploadForm } from "./api.js?v=25";
import { installRealtimeTutor } from "./realtime-tutor.js";
import { buildLiveTutorPayload, selectLiveSpeechTranscript } from "./live-tutor-payload.mjs";
import { ensureMathJax, renderTextbookMath as renderMath, splitTextbookMath } from "./math-display.js";
import qrcode from "./vendor/qrcode-generator.js?v=17";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
function sanitizeLearnerFacingText(value) {
  return String(value || "")
    .replace(/gpt\s*[- ]?\s*6\s*[- ]?\s*luna/gi, "tutor")
    .replace(/\bluna\b/gi, "tutor")
    .replace(/\bunimernet\b/gi, "handwriting recognition")
    .trim();
}
const APP_VIEWS = new Set(["ask", "practice", "exam", "lessons", "reports"]);
const PAGE_VOICE_BUTTONS = Object.freeze({
  ask: "#voiceButton",
  practice: "#practiceVoiceButton",
  exam: "#examVoiceButton",
  lessons: "#lessonTutorVoiceButton",
  reports: "#reportsTutorVoiceButton",
});
const TUTOR_WELCOME_KEY_PREFIX = "sharperx_tutor_welcomed_v1_";
const savedView = sessionStorage.getItem("sharperx_web_current_view");
let voiceAttentionTimer = 0;
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
  // Desktop browser zoom changes the visual viewport scale and can report a
  // transiently tiny height. Use the layout viewport on desktop so canvas
  // sizing does not collapse when the learner presses Ctrl +/-.
  const desktop = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const height = desktop ? window.innerHeight : (window.visualViewport?.height || window.innerHeight);
  document.documentElement.style.setProperty("--app-viewport-height", `${Math.round(height)}px`);
}

updateAppViewportHeight();
window.addEventListener("resize", updateAppViewportHeight, { passive: true });
if (!matchMedia("(hover: hover) and (pointer: fine)").matches) {
  window.visualViewport?.addEventListener("resize", updateAppViewportHeight, { passive: true });
}

const state = {
  user: null,
  tutorLoginGreeting: "",
  grade: formatGrade(sessionStorage.getItem("sharperx_web_grade") || 12),
  view: APP_VIEWS.has(savedView) ? savedView : "ask",
  inspectionId: sessionStorage.getItem("sharperx_web_inspection_id") || "",
  practiceInspectionId: "",
  examInspectionId: sessionStorage.getItem("sharperx_web_exam_inspection_id") || "",
  examPaperDocumentId: sessionStorage.getItem("sharperx_web_exam_paper_id") || "",
  examMemoDocumentId: sessionStorage.getItem("sharperx_web_exam_memo_id") || "",
  examPaperFileName: sessionStorage.getItem("sharperx_web_exam_paper_name") || "",
  examMemoFileName: sessionStorage.getItem("sharperx_web_exam_memo_name") || "",
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
  practiceHintsUsed: 0,
  practiceFormulaShown: false,
  practiceVisuals: [],
  examTopics: [],
  examTermProfiles: new Map(),
  exam: null,
  examSessionId: sessionStorage.getItem("sharperx_web_exam_session_id") || "",
  examQuestionIndex: 0,
  examAnswers: new Map(),
  examAnswerAttachments: new Map(),
  examVisuals: [],
  lessonTopics: [],
  lessonSubtopics: [],
  lessonTopicGrade: "",
  lessonSelectionRequestId: 0,
  lessonVideoRequestId: 0,
  lessonVideoController: null,
  questionVideoControllers: { practice: null, exam: null },
  questionVideoRequestIds: { practice: 0, exam: 0 },
  canvasContext: null,
  canvasQuestion: null,
  canvasReturnFocus: null,
  attachedCanvasPhotoId: "",
  practiceAnswerPhotoIds: [],
  practiceAnswerPhotoPreviews: [],
  practiceEditorReady: false,
  practiceEditorState: null,
  practiceKeyboardMode: "Basic",
  reportObjectUrls: new Set(),
  recorder: null,
  voiceRecorderContext: "",
  voiceReviewContext: "",
  canvas: { mode: "write", strokes: [], scale: 1, offsetX: 0, offsetY: 0, pan: false, zoom: false, eraser: false, revision: 0, transcribedPhoto: null, photoPromise: null, active: null, pointers: new Map(), pinch: null, size: { width: 0, height: 0 }, readingConfirmed: false, readingApplied: false, confirmedReading: null, readingAlternatives: [], graphWorkflow: null },
  imageView: { scale: 1, x: 0, y: 0, pointers: new Map(), pinch: null, drag: null },
  toastTimer: 0,
  welcomeAudioTimer: 0,
  creditRefreshTimer: 0,
  creditRefreshPromise: null,
  creditRefreshInterval: 0,
  sessionHeartbeatInterval: 0,
  sessionHeartbeatInFlight: false,
  networkMonitorInterval: 0,
  apiReachabilityFailures: 0,
};

const dbPromise = openReportsDatabase();
let paperCatalogPromise = null;
let activePaperCatalog = { grade: 12, source: "stanmore", entries: [], newestFirst: true };
let apiReachabilityProbe = null;
const examSnapshotCache = new Map();
let examPaperLinksRenderVersion = 0;

function setStatus(element, text, kind = "") {
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("is-error", kind === "error");
  element.classList.toggle("is-success", kind === "success");
}

function highlightPageVoiceButton(viewName) {
  if (voiceAttentionTimer) window.clearTimeout(voiceAttentionTimer);
  voiceAttentionTimer = 0;
  $$(".voice-attention").forEach((button) => button.classList.remove("voice-attention"));
  const button = $(PAGE_VOICE_BUTTONS[viewName] || "");
  if (!button || button.disabled) return;

  button.classList.remove("voice-attention");
  void button.offsetWidth;
  button.classList.add("voice-attention");
  const rect = button.getBoundingClientRect();
  if (rect.top < 72 || rect.bottom > window.innerHeight - 12) {
    button.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }
  voiceAttentionTimer = window.setTimeout(() => {
    button.classList.remove("voice-attention");
    voiceAttentionTimer = 0;
  }, 3000);
}

Object.values(PAGE_VOICE_BUTTONS).forEach((selector) => {
  $(selector)?.addEventListener("click", () => $(selector)?.classList.remove("voice-attention"));
});

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
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

function tutorWelcomeStorageKey() {
  const user = state.user || {};
  const identity = String(user.id ?? user.user_id ?? user.email ?? user.username ?? "default").trim().toLocaleLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${TUTOR_WELCOME_KEY_PREFIX}${(hash >>> 0).toString(36)}`;
}

function currentPageTutorContext(viewName = state.view) {
  const visibleView = $(".view[data-view-panel]:not([hidden])")?.dataset.viewPanel;
  if (APP_VIEWS.has(visibleView)) viewName = visibleView;
  const context = {
    grade: state.grade,
    subject: "Mathematics",
    page: "Ask",
    page_title: "Ask",
    page_status: "The Ask page is open.",
    page_activity: "No question has been sent in this Ask session yet.",
    page_progress: "Ready for a maths question.",
  };
  if (viewName === "practice") {
    const question = state.currentPracticeQuestion;
    const questionId = String(question?.question_id || question?.bank_question_id || question?.id || "");
    const index = state.practiceQuestions.findIndex((item) => String(item.question_id || item.bank_question_id || item.id || "") === questionId);
    const working = getPracticeEditorLatex().trim();
    const workingLines = working.split(/\r?\n/).filter((line) => line.trim()).length;
    const marked = !$("#practiceFeedback").hidden;
    const restored = !question && Boolean(sessionStorage.getItem(PRACTICE_SESSION_KEYS.question));
    context.page = "Practice";
    context.page_title = `Grade ${formatGrade($("#practiceGrade").value || state.grade)} Mathematics Practice`;
    context.grade = formatGrade($("#practiceGrade").value || state.grade);
    context.topic = question?.topic || state.practiceTopics.find((item) => String(item.id) === $("#practiceTopic").value)?.name || "";
    context.current_question = question ? questionLabel(question).slice(0, 900) : "";
    context.question_number = index >= 0 ? `Question ${index + 1} of ${state.practiceQuestions.length}` : "";
    context.page_status = question
      ? `${context.question_number || "A practice question"} is open${marked ? " and marked" : "."}.`
      : restored ? "The saved practice question is being restored." : "Choose a topic and subtopic to load a practice question.";
    context.page_activity = question
      ? `${state.hintIndex} hints shown; ${state.practiceFormulaShown ? "formulae shown" : "formulae not yet opened"}; ${workingLines} working lines entered; ${state.practiceAnswerPhotoIds.length} handwritten attachments; ${marked ? "marking feedback visible" : "not yet sent for marking"}.`
      : "No question is currently selected on this practice page.";
    context.page_visible_support = marked ? $("#practiceFeedback").textContent.trim().slice(0, 1800)
      : !$("#practiceHints").hidden ? $("#practiceHints").textContent.trim().slice(0, 1800) : "";
    context.page_progress = question
      ? `${context.question_number || "Current question"}; ${workingLines ? `${workingLines} working lines entered` : "no typed working yet"}; ${marked ? "feedback is available" : "attempt not submitted"}.`
      : restored ? "Waiting for the saved question and its working to load." : "No practice question loaded yet.";
    return context;
  }
  if (viewName === "exam") {
    const question = state.examCurrentQuestion;
    const questionCount = Number(state.exam?.question_count || 0);
    const working = getMathEditorLatex("exam").trim();
    const resultVisible = !$("#examResult").hidden;
    context.page = "Test / exam prep";
    context.page_title = state.exam?.paper_title || "Test / exam prep";
    context.grade = formatGrade(question?.grade || state.exam?.grade || state.grade);
    context.topic = question?.topic || "";
    context.current_question = question ? String(question.question_text_latex || question.question_text || "").slice(0, 900) : "";
    context.question_number = question ? `Question ${state.examQuestionIndex + 1}${questionCount ? ` of ${questionCount}` : ""}` : "";
    context.assessment_type = state.exam?.assessment_type || "";
    context.page_status = resultVisible
      ? "The assessment has been marked; the score, feedback, and worked solutions are open."
      : question ? `${context.question_number} is open in the assessment.`
        : state.examSessionId ? "The saved assessment session is being restored." : "Choose an assessment to begin.";
    context.page_activity = question
      ? `${working ? "Working entered" : "No working entered yet"}; ${$("#examGuidanceText").hidden ? "no hint opened" : "hint displayed"}; ${resultVisible ? "assessment marked" : "not submitted"}.`
      : "No assessment question is currently open.";
    context.page_visible_support = resultVisible ? $("#examResult").textContent.trim().slice(0, 1800)
      : !$("#examGuidanceText").hidden ? $("#examGuidanceText").textContent.trim().slice(0, 1800) : "";
    context.page_progress = question
      ? `${context.question_number}${working ? "; answer has working" : "; answer is blank"}${resultVisible ? "; results are available" : ""}.`
      : state.examSessionId ? "Waiting for the current assessment question to load." : "Assessment not started.";
    return context;
  }
  if (viewName === "lessons") {
    const topic = state.lessonTopics.find((item) => String(item.id) === $("#lessonTopic").value);
    const lesson = state.lessonSubtopics.find((item) => lessonSubtopicValue(item) === $("#lessonSubtopic").value);
    const player = $("#lessonPlayer");
    const media = $("video", player);
    context.page = "Lesson videos";
    context.page_title = "Lesson videos";
    context.topic = topic?.name || "";
    context.lesson_topic = topic?.name || "";
    context.lesson_title = lesson ? lessonSubtopicName(lesson) : "";
    context.page_status = lesson ? `${context.lesson_title} is selected${media?.readyState >= 2 ? " and ready to play" : ""}.` : "Choose a topic and subtopic to load one lesson video.";
    context.page_activity = media ? (media.ended ? "The selected video has finished." : media.paused ? "The selected video is paused." : "The selected video is playing.") : "No lesson video is currently playing.";
    context.page_progress = media && Number.isFinite(media.duration) && media.duration > 0
      ? `Video position ${Math.floor(media.currentTime)} of ${Math.floor(media.duration)} seconds.`
      : lesson ? "The selected lesson video is ready for playback." : "No lesson selected yet.";
    return context;
  }
  if (viewName === "reports") {
    const count = $$(".saved-report-card").length;
    context.page = "Saved reports";
    context.page_title = "Saved reports";
    context.page_status = count ? `${count} saved ${count === 1 ? "report is" : "reports are"} listed on this page.` : "No saved reports are currently listed.";
    context.page_activity = "The learner is viewing saved assessment and practice reports.";
    context.page_progress = `${count} saved report${count === 1 ? "" : "s"} available on this page.`;
    return context;
  }
  const selected = state.selectedPaperQuestion;
  const askText = getMathEditorLatex("ask").trim();
  const learnerMessages = $$(".message.user-message", $("#chatMessages")).length;
  context.topic = selected ? "Question paper" : "";
  context.current_question = selected?.text || askText.slice(0, 900);
  context.question_number = selected ? String(selected.number || "") : "";
  context.page_status = selected ? `Question ${selected.number || "from the selected paper"} is open in Ask.` : "The Ask page is open for a maths question.";
  context.page_activity = `${learnerMessages} learner message${learnerMessages === 1 ? "" : "s"} in this Ask conversation${askText ? "; an unsent question is in the editor" : ""}.`;
  context.page_progress = askText ? "A question is drafted and ready to send." : learnerMessages ? "Continue the current Ask conversation." : "Ready for a maths question.";
  context.page_visible_support = "";
  return context;
}

function tutorGreetingForPage(contextType = state.view, returning = true, pageContext = null) {
  const page = pageContext && typeof pageContext === "object" ? pageContext : currentPageTutorContext();
  const title = page.page_title || page.page || "this page";
  const focus = contextType === "practice" || contextType === "exam"
    ? (page.current_question ? "I will focus on the question and work shown here." : "I can guide you through setting up this page.")
    : "I will focus on what is open here.";
  return `${returning ? "Welcome back." : "Welcome."} You are on ${title}. ${page.page_status || "This page is ready."} ${page.page_progress || ""} ${focus} You can ask me what you see here or how to use this page. Press Voice to ask.`.replace(/\s+/g, " ").trim();
}

function prepareTutorWelcome() {
  const message = $("#appWelcomeMessage");
  if (!message || !state.user) return "";
  const key = tutorWelcomeStorageKey();
  const returning = localStorage.getItem(key) === "1";
  state.tutorLoginGreeting = returning ? "returning" : "first";
  localStorage.setItem(key, "1");
  const page = currentPageTutorContext();
  const title = page.page_title || page.page || "this page";
  message.textContent = `${returning ? "Welcome back." : "Welcome to SharperTime."} You are on ${title}. ${page.page_status} ${page.page_progress} I will focus on what is open here. You can ask me what you see here or how to use this page.`;
  return message.textContent;
}

function refreshTutorWelcomeForPage() {
  const message = $("#appWelcomeMessage");
  if (!message || !state.user) return;
  const page = currentPageTutorContext();
  const title = page.page_title || page.page || "this page";
  message.textContent = `You are on ${title}. ${page.page_status || "This page is ready."} ${page.page_progress || ""} I will focus on what is open here. You can ask me what you see here or how to use this page.`.replace(/\s+/g, " ").trim();
}

function showWorkspace() {
  $("#authScreen").hidden = true;
  $("#workspace").hidden = false;
  document.documentElement.classList.remove("checking-session");
  updatePrimarySessionStatus();
  startSessionHeartbeat();
  startNetworkMonitor();
  $("#accountLabel").textContent = state.user?.full_name || state.user?.email || "";
  void refreshAiCreditBalance();
  if (!state.creditRefreshInterval) {
    state.creditRefreshInterval = window.setInterval(() => void refreshAiCreditBalance(), 60_000);
  }
  ["#globalGrade", "#practiceGrade", "#examGrade", "#lessonGrade"].forEach((selector) => {
    $(selector).value = String(state.grade);
  });
  restorePaperSession();
  registerServiceWorker();
  renderSourceLinks();
  void renderExamPaperLinks();
  updateUploadedExamStatus();
  activateView(state.view);
  restoreExamSession();
  return prepareTutorWelcome();
}

function renderAiCreditBalance(balance) {
  const badge = $("#aiCreditBalance");
  const value = $("#aiCreditsRemaining");
  if (!badge || !value) return;
  const exempt = balance?.credit_exempt === true || state.user?.role === "admin";
  const remaining = Number(balance?.ai_credits_remaining);
  value.textContent = exempt
    ? "Unlimited"
    : Number.isFinite(remaining)
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Math.max(0, remaining))
      : "—";
  badge.classList.remove("is-loading", "is-error");
  badge.setAttribute("aria-label", exempt ? "Unlimited AI credits" : "AI credits remaining: " + value.textContent);
  badge.title = exempt ? "Administrator access" : "Your remaining SharperTime AI credits";
}

async function refreshAiCreditBalance() {
  if (!state.user || !getAccessToken()) return;
  if (state.creditRefreshPromise) return state.creditRefreshPromise;
  const badge = $("#aiCreditBalance");
  badge?.classList.add("is-loading");
  state.creditRefreshPromise = getJson("/api/accounts/credits")
    .then((balance) => renderAiCreditBalance(balance))
    .catch((error) => {
      if (error?.status !== 401 && badge) {
        badge.classList.remove("is-loading");
        badge.classList.add("is-error");
        const value = $("#aiCreditsRemaining");
        if (value) value.textContent = "—";
        badge.setAttribute("aria-label", "AI credit balance unavailable");
        badge.title = "Could not refresh the AI credit balance";
      }
    })
    .finally(() => { state.creditRefreshPromise = null; });
  return state.creditRefreshPromise;
}

window.addEventListener("sharperx:credits-refresh", () => {
  clearTimeout(state.creditRefreshTimer);
  state.creditRefreshTimer = setTimeout(() => void refreshAiCreditBalance(), 180);
});
window.addEventListener("focus", () => void refreshAiCreditBalance());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshAiCreditBalance();
});

function playTutorWelcome(text, { force = false } = {}) {
  if (!text || !state.user) return;
  const sessionKey = `${tutorWelcomeStorageKey()}_spoken`;
  if (!force && sessionStorage.getItem(sessionKey) === "1") {
    state.tutorLoginGreeting = "";
    return;
  }
  sessionStorage.setItem(sessionKey, "1");
  state.tutorLoginGreeting = "";
  const status = $("#welcomeAudioStatus");
  clearTimeout(state.welcomeAudioTimer);
  if (status) status.textContent = "Playing your welcome message…";
  state.welcomeAudioTimer = setTimeout(() => {
    if (status) status.textContent = "If you don’t hear the welcome, tap Listen to welcome to play it.";
  }, 2500);
  realtimeTutor.speakReply(text, "ask", {
    onStart: () => {
      clearTimeout(state.welcomeAudioTimer);
      if (status) status.textContent = "Welcome message is playing.";
    },
    onComplete: () => {
      clearTimeout(state.welcomeAudioTimer);
      if (status) status.textContent = "Welcome message finished.";
    },
    onError: () => {
      clearTimeout(state.welcomeAudioTimer);
      if (status) status.textContent = "Audio didn’t play automatically. Tap Listen to welcome to try again.";
    },
  });
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
  stopSessionHeartbeat();
  stopNetworkMonitor();
  $("#workspace").hidden = true;
  $("#authScreen").hidden = false;
  document.documentElement.classList.remove("checking-session");
}

function updatePrimarySessionStatus(message = "") {
  const status = $("#primarySessionStatus");
  if (!status) return;
  const label = getClientDeviceLabel() || state.user?.active_device?.label || "this device";
  const text = message || `${label} · Active`;
  status.textContent = text;
  status.classList.toggle("is-error", Boolean(message));
  status.title = message || `Your SharperTime account is active on this ${label}.`;
  status.setAttribute("aria-label", message || `Signed in and active on this ${label}`);
}

function checkApiReachability() {
  if (!navigator.onLine) return Promise.resolve(false);
  if (apiReachabilityProbe) return apiReachabilityProbe;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  apiReachabilityProbe = fetch(`${API_BASE_URL}/api/health`, {
    method: "GET",
    cache: "no-store",
    signal: controller.signal,
  }).then(() => true).catch(() => false).finally(() => {
    clearTimeout(timeout);
    apiReachabilityProbe = null;
  });
  return apiReachabilityProbe;
}

function showConnectionInterrupted() {
  const message = "Connection interrupted · Check Wi-Fi or mobile data";
  if (state.user) updatePrimarySessionStatus(message);
  else if (getAccessToken()) setStatus($("#loginStatus"), message, "error");
}

function recordApiReachability(reachable) {
  if (!state.user) return;
  if (reachable) {
    state.apiReachabilityFailures = 0;
    if (($("#primarySessionStatus")?.textContent || "").startsWith("Connection interrupted")) {
      updatePrimarySessionStatus();
    }
    return;
  }
  state.apiReachabilityFailures += 1;
  if (!navigator.onLine || state.apiReachabilityFailures >= 2) showConnectionInterrupted();
}

function startNetworkMonitor() {
  if (!state.user) return;
  clearInterval(state.networkMonitorInterval);
  const check = async () => recordApiReachability(await checkApiReachability());
  void check();
  state.networkMonitorInterval = window.setInterval(check, 30_000);
}

function stopNetworkMonitor() {
  clearInterval(state.networkMonitorInterval);
  state.networkMonitorInterval = 0;
  state.apiReachabilityFailures = 0;
}

function startSessionHeartbeat() {
  if (!getAccessToken() || !state.user) return;
  const sendHeartbeat = async () => {
    if (!state.user || !getAccessToken() || state.sessionHeartbeatInFlight) return;
    state.sessionHeartbeatInFlight = true;
    try {
      // Heartbeats are advisory. A missed or rate-limited heartbeat does not
      // mean the learner lost internet access or was signed out. A 401 still
      // dispatches the normal auth-expired event from api.js.
      await postJson("/api/auth/heartbeat", {}, { timeoutMs: 8_000 });
    } catch {
      // Connectivity is checked independently; heartbeat failures stay quiet.
    } finally {
      state.sessionHeartbeatInFlight = false;
    }
  };
  clearInterval(state.sessionHeartbeatInterval);
  void sendHeartbeat();
  state.sessionHeartbeatInterval = window.setInterval(sendHeartbeat, 60_000);
}

function stopSessionHeartbeat() {
  clearInterval(state.sessionHeartbeatInterval);
  state.sessionHeartbeatInterval = 0;
  state.sessionHeartbeatInFlight = false;
}

async function checkSession() {
  if (!getAccessToken()) return showAuth();
  try {
    state.user = await getJson("/api/auth/me");
    const welcomeMessage = showWorkspace();
    playTutorWelcome(welcomeMessage);
  } catch (error) {
    showAuth();
    if (error?.status === 401 || !getAccessToken()) {
      setAccessToken("");
      setStatus($("#loginStatus"), error.message || "Your session has ended. Sign in again.", "error");
      return;
    }
    const reachable = await checkApiReachability();
    setStatus($("#loginStatus"), reachable
      ? "Could not verify your session. Please try again."
      : "Connection interrupted · Check Wi-Fi or mobile data", "error");
  }
}

window.addEventListener("sharperx:auth-expired", (event) => {
  void realtimeTutor.stop();
  if (state.user) sessionStorage.removeItem(`${tutorWelcomeStorageKey()}_spoken`);
  state.user = null;
  stopDeviceRemote();
  stopPhoneCanvas({ notify: false });
  if (deviceRemoteDialog?.open) closeDeviceRemoteDialog();
  showAuth();
  setStatus($("#loginStatus"), event.detail?.message || "Your session has ended. Sign in again.", "error");
});

window.addEventListener("storage", (event) => {
  if (event.key !== "sharperx_access_token" || event.newValue || !state.user) return;
  void realtimeTutor.stop();
  stopSessionHeartbeat();
  state.user = null;
  showAuth();
  setStatus($("#loginStatus"), "You signed out in another tab. Sign in again to continue.", "error");
});

window.addEventListener("offline", () => {
  showConnectionInterrupted();
});
window.addEventListener("online", () => {
  void checkApiReachability().then((reachable) => {
    if (state.user) {
      recordApiReachability(reachable);
      if (reachable) startSessionHeartbeat();
    } else if (getAccessToken()) {
      if (reachable) void checkSession();
      else showConnectionInterrupted();
    }
  });
});

let loginCooldownUntil = 0;
let loginCooldownTimer = 0;

function applyLoginCooldown(button, seconds, detail) {
  loginCooldownUntil = Date.now() + Math.max(1, seconds) * 1000;
  if (loginCooldownTimer) window.clearInterval(loginCooldownTimer);

  const update = () => {
    const remaining = Math.max(0, Math.ceil((loginCooldownUntil - Date.now()) / 1000));
    if (!remaining) {
      window.clearInterval(loginCooldownTimer);
      loginCooldownTimer = 0;
      loginCooldownUntil = 0;
      button.disabled = false;
      button.textContent = "Sign in";
      setStatus($("#loginStatus"), "You can try signing in again.");
      return;
    }

    button.disabled = true;
    button.textContent = `Try again in ${remaining}s`;
    const isNetworkLimit = detail === "Too many requests. Try again later.";
    const message = isNetworkLimit
      ? "Sign-in requests from this network were temporarily limited."
      : detail || "Sign-in is temporarily rate-limited.";
    setStatus($("#loginStatus"), `${message} Try again in about ${remaining} seconds.`, "error");
  };

  update();
  loginCooldownTimer = window.setInterval(update, 1000);
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  realtimeTutor.prepareSpeechFromGesture();
  const loginForm = event.currentTarget;
  const button = $("button[type='submit']", loginForm);
  if (loginCooldownUntil > Date.now()) return;
  const form = new FormData(loginForm);
  const credentials = {
    email: String(form.get("email") || "").trim(),
    password: String(form.get("password") || ""),
  };
  button.disabled = true;
  setStatus($("#loginStatus"), "Signing in…");
  try {
    let result;
    try {
      result = await postForm("/api/auth/login", credentials, { auth: false, deviceTracking: true });
    } catch (error) {
      const activeSession = error?.data?.detail;
      if (error?.status !== 409 || activeSession?.code !== "active_session") throw error;
      const device = activeSession.device_label || "another device";
      const takeOver = window.confirm(`Your account is active on ${device}.\n\nWould you like to close that session and sign in on this device?`);
      if (!takeOver) {
        setStatus($("#loginStatus"), `Your session on ${device} is still active.`, "error");
        return;
      }
      result = await postForm("/api/auth/login", { ...credentials, takeover: "true" }, { auth: false, deviceTracking: true });
    }
    if (!result.access_token) throw new Error("Sign in could not be completed. Please try again.");
    setAccessToken(result.access_token);
    state.user = result.user || {};
    loginForm.reset();
    const welcomeMessage = showWorkspace();
    playTutorWelcome(welcomeMessage);
    showToast("Signed in");
  } catch (error) {
    if (error.status === 429 && error.message === "Too many requests. Try again later.") {
      applyLoginCooldown(button, error.retryAfterSeconds || 60, error.message);
    } else if (error.status === 429) {
      const wait = error.retryAfterSeconds;
      setStatus($("#loginStatus"), `${error.message}${wait ? ` Try again in about ${wait} seconds.` : ""}`, "error");
    } else {
      setStatus($("#loginStatus"), error.message, "error");
    }
  } finally {
    if (loginCooldownUntil <= Date.now()) button.disabled = false;
  }
});

$("#logoutButton").addEventListener("click", async () => {
  if (state.user) sessionStorage.removeItem(`${tutorWelcomeStorageKey()}_spoken`);
  try { await discardSessionPaperUploads(); } catch { /* Sign-out must remain available if cleanup cannot reach the server. */ }
  try { await postJson("/api/auth/logout", {}); } catch { /* local sign-out still completes */ }
  setAccessToken("");
  state.user = null;
  clearPracticeSessionSelection();
  showAuth();
});

function activateView(viewName) {
  if (!APP_VIEWS.has(viewName)) return;
  const previousView = state.view;
  if (previousView !== viewName) realtimeTutor.stopSpeaking();
  if (realtimeTutor.activeContext && realtimeTutor.activeContext !== viewName) void realtimeTutor.stop();
  state.view = viewName;
  sessionStorage.setItem("sharperx_web_current_view", viewName);
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName));
  $$("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === viewName;
    panel.hidden = !active;
    panel.classList.toggle("is-visible", active);
  });
  highlightPageVoiceButton(viewName);
  refreshTutorWelcomeForPage();
  if (viewName === "practice" && !state.practiceTopics.length) {
    loadPracticeTopics(formatGrade($("#practiceGrade").value), { restore: true })
      .catch((error) => setStatus($("#practiceStatus"), error.message, "error"));
  }
  if (viewName === "exam") {
    void renderExamPaperLinks();
    clearExamTopicSelections();
    if (!state.examSessionId && !state.examTopics.length) loadExamTopics().catch((error) => setStatus($("#examStatus"), error.message, "error"));
  }
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
  renderExamPaperLinks();
});

function appendMessage(text, { mine = false, kind = "", imageUrl = "", actions = [], structuredText = "" } = {}) {
  const article = document.createElement("article");
  article.className = `message ${mine ? "user-message" : "assistant-message"}`;
  const messageText = mine ? String(text || "") : sanitizeLearnerFacingText(text);
  const displayKind = mine ? String(kind || "") : sanitizeLearnerFacingText(kind);
  if (displayKind) {
    const label = document.createElement("span");
    label.className = "message-kind";
    label.textContent = displayKind;
    article.append(label);
  }
  const body = document.createElement("p");
  renderMath(body, structuredText && !mine ? sanitizeLearnerFacingText(structuredText) : messageText);
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

function askConversationHistory(limit = 12) {
  return $$(".message", $("#chatMessages")).slice(-limit).map((message) => ({
    role: message.classList.contains("user-message") ? "learner" : "tutor",
    text: $("p", message)?.textContent?.trim().slice(0, 2400) || "",
  })).filter((turn) => turn.text);
}

function repairFourTermSequenceOcr(value) {
  let text = String(value || "");
  const context = [
    /\bfour\s+terms\b/i,
    /\bfirst\s+three\s+terms\b/i,
    /\blast\s+three\s+terms\b/i,
    /\barithmetic\s+sequence\b/i,
    /\bgeometric\s+sequence\b/i,
  ];
  if (!context.every((pattern) => pattern.test(text))) return text;

  text = text.replace(
    /(first\s+three\s+terms\s*,?)(.*?)(\s+form\s+an\s+arithmetic\s+sequence)/is,
    (_match, lead, _ocrTerms, tail) => `${lead.replace(/\s+$/, "")} T_1; T_2 and T_3${tail}`,
  );
  return text.replace(
    /(last\s+three\s+terms\s*,?)(.*?)(\s+form\s+a\s+geometric\s+sequence)/is,
    (_match, lead, _ocrTerms, tail) => `${lead.replace(/\s+$/, "")} T_2; T_3 and T_4${tail}`,
  );
}

function ensureInspection(context = "ask", options = {}) {
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
  return uploadForm("/api/inspections/create", form, options).then((result) => {
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

function clearPaperSessionLocal() {
  state.paperDocumentId = "";
  state.memoDocumentId = "";
  state.paperFileName = "";
  state.selectedPaperQuestion = null;
  state.paperPageImage = "";
  sessionStorage.removeItem("sharperx_web_paper_id");
  sessionStorage.removeItem("sharperx_web_memo_id");
  sessionStorage.removeItem("sharperx_web_paper_name");
  $("#paperTools").hidden = true;
}

async function deleteSessionPaperDocument(documentId, inspectionId = state.inspectionId, keepalive = false) {
  if (!documentId || !inspectionId) return;
  try {
    await apiRequest(`/api/inspections/${encodeURIComponent(inspectionId)}/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
      keepalive,
    });
  } catch (error) {
    if (error.status !== 404 || !/^(?:Inspection not found|Session paper was not found)$/i.test(error.message)) throw error;
  }
}

async function discardSessionPaperUploads({ keepalive = false } = {}) {
  const inspectionId = state.inspectionId || sessionStorage.getItem("sharperx_web_inspection_id") || "";
  const documentIds = [...new Set([
    state.paperDocumentId || sessionStorage.getItem("sharperx_web_paper_id") || "",
    state.memoDocumentId || sessionStorage.getItem("sharperx_web_memo_id") || "",
  ].filter(Boolean))];
  const results = await Promise.allSettled(documentIds.map((id) => deleteSessionPaperDocument(id, inspectionId, keepalive)));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  clearPaperSessionLocal();
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  const inspectionId = state.inspectionId || sessionStorage.getItem("sharperx_web_inspection_id") || "";
  const documentIds = [...new Set([
    state.paperDocumentId || sessionStorage.getItem("sharperx_web_paper_id") || "",
    state.memoDocumentId || sessionStorage.getItem("sharperx_web_memo_id") || "",
  ].filter(Boolean))];
  if (inspectionId && documentIds.length) {
    void Promise.allSettled(documentIds.map((id) => deleteSessionPaperDocument(id, inspectionId, true)));
  }
  clearPaperSessionLocal();
}, { once: true });

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
      const previousMemo = state.memoDocumentId;
      state.memoDocumentId = documentId;
      sessionStorage.setItem("sharperx_web_memo_id", documentId);
      if (previousMemo && previousMemo !== documentId) void deleteSessionPaperDocument(previousMemo, inspectionId).catch(() => {});
      setStatus(status, `Memo uploaded: ${file.name}. It will be used when marking a selected paper question.`, "success");
      appendMessage(`Marking memo uploaded: ${file.name}.`, { kind: "Uploaded memo" });
    } else {
      const previousPaper = state.paperDocumentId;
      state.paperDocumentId = documentId;
      state.paperFileName = file.name;
      state.selectedPaperQuestion = null;
      state.paperPageImage = "";
      sessionStorage.setItem("sharperx_web_paper_id", documentId);
      sessionStorage.setItem("sharperx_web_paper_name", file.name);
      if (previousPaper && previousPaper !== documentId) void deleteSessionPaperDocument(previousPaper, inspectionId).catch(() => {});
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
    const questionText = repairFourTermSequenceOcr(result.question_text || result.extracted_question_text || "");
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
    renderMath($("#paperQuestionText"), questionText);
    $("#paperSnapshotCard").hidden = false;
    setStatus($("#paperStatus"), "Full source page loaded. The question text is scoped to the selected question.", "success");
    appendMessage(`Question ${state.selectedPaperQuestion.number}\n\n${questionText}\n\nYou can now attempt it or ask for hints. Submit your working when you want it marked.`, {
      kind: "Selected question",
      imageUrl: state.paperPageImage,
      actions: [{ label: "View full page", onClick: () => openImageViewer(state.paperPageImage, `Question ${state.selectedPaperQuestion.number} · full page`) }],
    });
    setStatus($("#paperStatus"), "Preparing question-specific hints from the question and its diagram…");
    const hintResult = await postJson("/api/education/tutor/ask", {
      subject: "Mathematics",
      grade: state.grade,
      topic: "Question paper",
      question: questionText,
      mode: "question_hints",
      inspection_id: state.inspectionId,
      ai_tier: "luna",
      allow_web_search: false,
      question_paper_document_id: state.paperDocumentId,
      question_paper_question_number: String(state.selectedPaperQuestion.number),
      conversation_history: askConversationHistory(),
      app_context: {
        page: "Ask",
        page_title: "Ask a maths question",
        grade: state.grade,
        subject: "Mathematics",
        topic: "Question paper",
        current_question: questionText,
        question_number: String(state.selectedPaperQuestion.number),
      },
    });
    requireTutorCompletion(hintResult, "Paper hints");
    appendMessage(readTutorText(hintResult), {
      kind: "Question-specific hints",
      structuredText: readTutorDisplayText(hintResult),
    });
    setStatus($("#paperStatus"), "Question and diagram are in the chat. Add your working and send it when you want feedback or marking.", "success");
  } catch (error) {
    setStatus($("#paperStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#paperSnapshotImage").addEventListener("click", () => openImageViewer(state.paperPageImage, "Uploaded question paper · full page"));
$("#openPaperSnapshot").addEventListener("click", () => openImageViewer(state.paperPageImage, `Question ${state.selectedPaperQuestion?.number || ""} · full page`));

$("#clearPaperButton").addEventListener("click", async () => {
  realtimeTutor.stopIfContext("ask");
  const button = $("#clearPaperButton");
  button.disabled = true;
  try {
    await discardSessionPaperUploads();
  } catch (error) {
    showToast(`The paper could not be removed from the server: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

async function sendAsk(event) {
  event?.preventDefault?.();
  const readReplyAloud = realtimeTutor.activeContext === "ask";
  const text = getMathEditorLatex("ask").trim();
  const selected = state.selectedPaperQuestion;
  if (!text && !selected && state.askPhotos.length === 0) {
    mathEditorCommand("ask", { name: "focus" });
    return showToast("Type a question or select a question from your paper first.");
  }
  if (!text && selected && state.askPhotos.length === 0) {
    mathEditorCommand("ask", { name: "focus" });
    return showToast("Add your attempt or a follow-up question. The paper hints are already in the chat.");
  }
  if (readReplyAloud) realtimeTutor.stopIfContext("ask");
  realtimeTutor.prepareSpeechFromGesture();
  const button = $("#sendAskButton");
  button.disabled = true;
  const lastAskPhoto = state.askPhotos[state.askPhotos.length - 1];
  const attachedImage = lastAskPhoto?.previewUrl || "";
  const shownText = selected
    ? (text ? `Attempt / request for Question ${selected.number}:\n${text}` : `Question ${selected.number}:\n${selected.text}`)
    : text || "Please look at the attached working.";
  const conversationHistory = askConversationHistory();
  appendMessage(shownText, { mine: true, imageUrl: attachedImage });
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
      conversation_history: conversationHistory,
      app_context: {
        page: "Ask",
        page_title: "Ask a maths question",
        grade: state.grade,
        subject: "Mathematics",
        topic: selected ? "Question paper" : "",
        current_question: selected?.text || text,
        question_number: selected ? String(selected.number || "") : "",
      },
    };
    setStatus($("#voiceStatus"), "Preparing your response…");
    const result = await postJson("/api/education/tutor/ask", payload);
    requireTutorCompletion(result, "Ask");
    const responseText = readTutorText(result);
    appendMessage(responseText, {
      kind: "Tutor response",
      structuredText: readTutorDisplayText(result),
      actions: [
        { label: "Read aloud", onClick: () => realtimeTutor.speakReply(responseText, "ask") },
        { label: "Save PDF report", onClick: () => saveReport("Ask feedback", shownText, responseText) },
      ],
    });
    realtimeTutor.speakReply(responseText, "ask");
    mathEditorCommand("ask", { name: "clear" });
    setMathKeyboardVisible(false, "ask");
    setStatus($("#voiceStatus"), "");
  } catch (error) {
    appendMessage(error.message, {
      kind: error.retryable ? "Tutor temporarily unavailable" : "Could not send",
      actions: error.retryable ? [{ label: "Retry", onClick: retryLastAsk }] : [],
    });
    setStatus($("#voiceStatus"), error.retryable ? "Your question is still in the editor. Retry when the connection is ready." : "", error.retryable ? "error" : "");
  } finally {
    button.disabled = false;
  }
}

function retryLastAsk() {
  const messages = $$(".message", $("#chatMessages"));
  const failure = messages[messages.length - 1];
  const submittedQuestion = messages[messages.length - 2];
  if (failure?.classList.contains("assistant-message") && submittedQuestion?.classList.contains("user-message")) {
    failure.remove();
    submittedQuestion.remove();
  }
  return sendAsk();
}

function readTutorText(result) {
  const candidates = [result.assistant_message, result.answer, result.response, result.feedback, result.message, result.tutor_response, result.text];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  const response = value
    ? sanitizeLearnerFacingText(value)
    : result.result && typeof result.result === "string"
      ? sanitizeLearnerFacingText(result.result)
      : "I couldn't prepare a response. Please try again.";
  return String(result?.ai_status || "").toLowerCase() === "completed_needs_review"
    ? `Please check this response carefully; it could not be fully verified.\n\n${response}`
    : response;
}

function readTutorDisplayText(result) {
  const segments = Array.isArray(result?.message_segments) ? result.message_segments : [];
  const structured = segments.map((segment) => {
    const content = String(segment?.content || "").trim();
    if (!content) return "";
    if (segment.type === "display_math") return `\\[${content}\\]`;
    if (segment.type === "inline_math") return `\\(${content}\\)`;
    return segment.type === "text" ? content : "";
  }).filter(Boolean).join("\n");
  if (structured) return structured;
  return typeof result?.assistant_message_markup === "string"
    ? result.assistant_message_markup.trim()
    : "";
}

function requireTutorCompletion(result, operation) {
  const finalCheck = result?.ai_final_check && typeof result.ai_final_check === "object" ? result.ai_final_check : {};
  const provider = String(result?.ai_provider || finalCheck.provider || "").trim().toLowerCase();
  const model = String(result?.ai_model || result?.model || "").trim().toLowerCase();
  const effort = String(result?.ai_reasoning_effort || result?.reasoning_effort || "").trim().toLowerCase();
  const status = String(result?.ai_status || result?.status || "").trim().toLowerCase();
  const finalCheckModel = String(finalCheck.model || "").trim().toLowerCase();
  const finalCheckEffort = String(finalCheck.reasoning_effort || "").trim().toLowerCase();
  const retryableStatus = ["tutor_unavailable", "marking_unavailable"].includes(status);
  const needsReview = status === "completed_needs_review";
  if (result?.retryable === true || retryableStatus) {
    const serverMessage = String(result?.assistant_message || result?.message || "").trim();
    const error = new Error(serverMessage
      ? sanitizeLearnerFacingText(serverMessage)
      : `${operation} is temporarily unavailable. Your work is still here; please retry.`);
    error.status = 503;
    error.retryable = true;
    throw error;
  }
  if (
    provider !== "openai"
    || model !== "gpt-6-luna"
    || effort !== "xhigh"
    || (!needsReview && status !== "completed")
    || finalCheckModel !== "gpt-6-luna"
    || !["high", "xhigh"].includes(finalCheckEffort)
    || finalCheck.approved !== !needsReview
  ) {
    const error = new Error(`${operation} did not return a usable answer. Your work is still here; please retry.`);
    error.retryable = true;
    throw error;
  }
  if (
    !["luna_single_pass_self_check", "independent_final_approval"].includes(finalCheck.approval_stage)
  ) {
    const error = new Error(`${operation} is unavailable because the response check is missing. Your work is still here; please retry.`);
    error.retryable = true;
    throw error;
  }
}

function liveTutorTranscriptMessage(context, role, text) {
  const transcript = $("[data-live-transcript]", $(`[data-live-panel='${context}']`));
  if (!transcript) return;
  const item = document.createElement("div");
  item.className = "live-tutor-transcript-item";
  const label = document.createElement("strong");
  label.textContent = role === "learner" ? "You said" : "Tutor";
  const body = document.createElement("p");
  renderMath(body, role === "learner" ? text : sanitizeLearnerFacingText(text));
  item.append(label, body);
  transcript.append(item);
  while (transcript.children.length > 20) transcript.firstElementChild.remove();
  transcript.scrollTop = transcript.scrollHeight;
}

function liveTutorHistory(context) {
  const transcript = $(`[data-live-panel='${context}'] [data-live-transcript]`);
  return $$(".live-tutor-transcript-item", transcript).slice(-8).map((item) => ({
    role: $("strong", item)?.textContent === "Tutor" ? "tutor" : "learner",
    text: $("p", item)?.textContent?.trim().slice(0, 1200) || "",
  })).filter((turn) => turn.text);
}

const realtimeTutor = installRealtimeTutor({
  getLoginGreeting: (contextType, context) => {
    const returning = state.tutorLoginGreeting === "returning";
    state.tutorLoginGreeting = "";
    return tutorGreetingForPage(contextType || state.view, returning, context?.app_context);
  },
  ensureInspection: (context) => ensureInspection(
    context === "practice" && state.currentPracticeQuestion ? "practice"
      : context === "exam" && state.examCurrentQuestion && state.examSessionId ? "exam"
        : "ask",
  ),
  getContext: async (context, inspectionId) => {
    if (context === "practice") {
      const question = state.currentPracticeQuestion;
      return {
        context_type: question ? "practice" : "ask",
        grade: formatGrade(question?.grade || $("#practiceGrade").value),
        topic: question?.topic || $("#practiceSubtopic").selectedOptions[0]?.textContent || "Mathematics",
        inspection_id: inspectionId,
        question_text: question ? questionLabel(question) : null,
        question_id: question?.question_id || question?.bank_question_id || question?.id || null,
        bank_version: question?.bank_version || "",
        marks: Number.parseInt(question?.marks, 10) || 0,
        hints_used: state.hintIndex,
        learner_working: getPracticeEditorLatex().trim().slice(0, 12000),
        app_context: currentPageTutorContext(),
        conversation_history: liveTutorHistory("practice"),
      };
    }
    if (context === "exam") {
      const question = state.examCurrentQuestion;
      return {
        context_type: question && state.examSessionId ? "exam" : "ask",
        grade: formatGrade(question?.grade || $("#examGrade").value || state.grade),
        topic: question?.topic || "Test / exam prep",
        inspection_id: inspectionId,
        question_text: question?.question_text_latex || question?.question_text || null,
        question_id: question?.bank_question_id || question?.question_id || question?.id || null,
        marks: Number.parseInt(question?.marks, 10) || 0,
        learner_working: getMathEditorLatex("exam").trim().slice(0, 12000),
        assessment_type: state.exam?.assessment_type || $("#examType").value || "test",
        app_context: currentPageTutorContext(),
        conversation_history: liveTutorHistory("exam"),
      };
    }
    if (context === "lessons" || context === "reports") {
      const page = currentPageTutorContext();
      return {
        context_type: "ask",
        grade: page.grade || state.grade,
        topic: page.topic || null,
        inspection_id: inspectionId,
        question_text: null,
        app_context: page,
        conversation_history: liveTutorHistory(context),
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
      question_text: selected?.text || getMathEditorLatex("ask").trim() || null,
      question_paper_document_id: selected ? state.paperDocumentId : null,
      question_paper_question_number: selected ? String(selected.number || "") : null,
      app_context: currentPageTutorContext(),
      conversation_history: history,
    };
  },
  transcribeAudio: async (blob) => {
    if (!getAccessToken()) throw new Error("Sign in again before starting a live tutor session.");
    const type = blob.type || "audio/webm";
    const ext = type.includes("wav") ? "wav" : type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.set("audio", new File([blob], `live-tutor.${ext}`, { type }));
    form.set("language", "en");
    const result = await uploadForm("/api/education/speech/transcribe", form);
    const transcript = selectLiveSpeechTranscript(result);
    if (!transcript) return "";
    try {
      const formatted = await postJson("/api/education/speech/format-math", { text: transcript, subject: "Mathematics" });
      return String(formatted.mathematical_text || transcript).trim();
    } catch {
      return transcript;
    }
  },
  askTutorTurn: async (context, latestText) => {
    const payload = buildLiveTutorPayload(context, latestText);
    const result = await postJson("/api/education/tutor/ask", payload);
    requireTutorCompletion(result, "Live tutor");
    return readTutorText(result);
  },
  onTranscript: (context, text) => {
    if (context !== "ask") liveTutorTranscriptMessage(context, "learner", text);
    else appendMessage(text, { mine: true, kind: "Voice transcript" });
  },
  onTutorReply: (context, text) => {
    if (context !== "ask") liveTutorTranscriptMessage(context, "tutor", text);
    else appendMessage(text, { kind: "Live tutor" });
  },
  onPushToTalkChange: (context, recording) => {
    const button = voiceButtonFor(context);
    if (!button) return;
    button.classList.toggle("is-recording", recording);
    button.setAttribute("aria-pressed", String(recording));
    const pageVoice = context === "lessons" || context === "reports"
      || (context === "practice" && !state.currentPracticeQuestion)
      || (context === "exam" && !state.examCurrentQuestion);
    button.setAttribute("aria-label", recording ? "Stop recording and send to the live tutor"
      : pageVoice ? `Speak to the ${context === "lessons" ? "Lesson videos" : context === "reports" ? "Saved reports" : context === "practice" ? "Practice" : "Test and exam prep"} tutor`
        : context === "ask" ? "Record a voice note"
          : `Record a voice note for this ${context === "practice" ? "answer" : "assessment answer"}`);
    const label = $("span", button);
    if (label) label.textContent = recording ? "Stop & send" : "Voice";
  },
});

$("#playWelcomeMessage").addEventListener("click", () => {
  playTutorWelcome($("#appWelcomeMessage").textContent.trim(), { force: true });
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

function voiceStatusFor(context) {
  return context === "practice" ? $("#practiceVoiceStatus")
    : context === "exam" ? $("#examVoiceStatus")
      : context === "lessons" ? $("#lessonTutorVoiceStatus")
        : context === "reports" ? $("#reportsTutorVoiceStatus")
          : $("#voiceStatus");
}

function voiceButtonFor(context) {
  return context === "practice" ? $("#practiceVoiceButton")
    : context === "exam" ? $("#examVoiceButton")
      : context === "lessons" ? $("#lessonTutorVoiceButton")
        : context === "reports" ? $("#reportsTutorVoiceButton")
          : $("#voiceButton");
}

function openVoiceReview(context, transcript) {
  state.voiceReviewContext = context;
  $("#voiceReviewTitle").textContent = context === "practice"
    ? "Review your practice voice note"
    : context === "exam" ? "Review your assessment voice note" : "Review your voice note";
  $("#voiceReviewTranscript").value = String(transcript || "").trim();
  setMathEditorLatex("voiceMath", "");
  $("#voiceReviewSend").hidden = context !== "ask";
  $("#voiceReviewStatus").textContent = "Transcript ready. Edit it, then format the spoken maths if needed.";
  setStatus($("#voiceReviewStatus"), $("#voiceReviewStatus").textContent, "success");
  if (!$("#voiceReviewDialog").open) $("#voiceReviewDialog").showModal();
  requestAnimationFrame(() => $("#voiceReviewTranscript").focus({ preventScroll: true }));
}

function closeVoiceReview() {
  setMathKeyboardVisible(false, "voiceMath");
  if ($("#voiceReviewDialog").open) $("#voiceReviewDialog").close();
  state.voiceReviewContext = "";
}

function appendVoiceReviewToEditor(value, isLatex) {
  const context = state.voiceReviewContext;
  const editorName = context === "practice" ? "practice" : context === "exam" ? "exam" : "ask";
  const content = String(value || "").trim();
  if (!context || !content) return false;
  const existing = getMathEditorLatex(editorName).trim();
  if (existing) {
    mathEditorCommand(editorName, { name: "moveEnd" });
    mathEditorCommand(editorName, { name: context === "ask" ? "insertText" : "newLine", value: context === "ask" ? "\n" : "" });
  }
  mathEditorCommand(editorName, { name: isLatex ? "insertLatex" : "insertText", value: content });
  closeVoiceReview();
  mathEditorCommand(editorName, { name: "focus" });
  setStatus(voiceStatusFor(context), context === "ask" ? "Added to your question. Review it, then press Send." : context === "practice" ? "Added to your working." : "Added to this assessment answer.", "success");
  return true;
}

async function recordVoiceNote(context) {
  const button = voiceButtonFor(context);
  const status = voiceStatusFor(context);
  if (state.recorder) {
    if (state.voiceRecorderContext !== context) {
      setStatus(status, "Finish the voice note already recording before starting another.", "error");
      return;
    }
    if (state.recorder.state === "recording") {
      button.classList.remove("is-recording");
      setStatus(status, "Transcribing voice note…");
      state.recorder.stop();
    }
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus(status, "Voice recording is not supported by this browser. Use the editor or attach a photo instead.", "error");
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
      if (state.recorder === recorder) state.recorder = null;
      state.voiceRecorderContext = "";
      button.classList.remove("is-recording");
      try {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (!blob.size) throw new Error("No audio was captured. Record a short note and try again.");
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const form = new FormData();
        form.set("audio", new File([blob], `${context}-voice-note.${ext}`, { type }));
        form.set("language", "en");
        const result = await uploadForm("/api/education/speech/transcribe", form);
        const transcript = result.raw_transcript || result.transcript || result.text || result.transcription || "";
        if (!String(transcript).trim()) throw new Error("No words were recognized in that voice note.");
        setStatus(status, "Transcript ready for correction.", "success");
        openVoiceReview(context, transcript);
      } catch (error) {
        setStatus(status, error.message || "Voice note transcription failed.", "error");
      }
    };
    state.recorder = recorder;
    state.voiceRecorderContext = context;
    recorder.start();
    button.classList.add("is-recording");
    setStatus(status, "Recording… select Voice again when you are finished.");
  } catch (error) {
    state.recorder = null;
    state.voiceRecorderContext = "";
    setStatus(status, error.name === "NotAllowedError" ? "Allow microphone access in your browser settings." : error.message, "error");
  }
}

async function handleVoiceButton(context) {
  if (realtimeTutor.isActive(context)) {
    await realtimeTutor.togglePushToTalk(context);
    return;
  }
  const pageTutorContext = context === "lessons" || context === "reports"
    || (context === "practice" && !state.currentPracticeQuestion)
    || (context === "exam" && (!state.examCurrentQuestion || !state.examSessionId));
  if (pageTutorContext) {
    await realtimeTutor.start(context);
    if (realtimeTutor.isActive(context)) {
      setStatus(voiceStatusFor(context), "Tutor opened. Press Voice again when you are ready to speak.", "success");
    }
    return;
  }
  await recordVoiceNote(context);
}

$("#voiceButton").addEventListener("click", () => handleVoiceButton("ask"));
$("#practiceVoiceButton").addEventListener("click", () => handleVoiceButton("practice"));
$("#examVoiceButton").addEventListener("click", () => handleVoiceButton("exam"));
$("#lessonTutorVoiceButton").addEventListener("click", () => handleVoiceButton("lessons"));
$("#reportsTutorVoiceButton").addEventListener("click", () => handleVoiceButton("reports"));
$("#voiceReviewTranscript").addEventListener("input", () => setStatus($("#voiceReviewStatus"), "Transcript edited. Format as math if it contains spoken mathematics."));
$("#voiceReviewFormatMath").addEventListener("click", async (event) => {
  const transcript = $("#voiceReviewTranscript").value.trim();
  if (!transcript) return setStatus($("#voiceReviewStatus"), "Record a voice note or enter the transcript first.", "error");
  const button = event.currentTarget;
  button.disabled = true;
  setStatus($("#voiceReviewStatus"), "Formatting the spoken maths…");
  try {
    const result = await postJson("/api/education/speech/format-math", { text: transcript, subject: "Mathematics" });
    const formatted = String(result.mathematical_text || result.text || "").trim();
    if (!formatted) throw new Error("The mathematical form could not be prepared. Edit the transcript or use it as written.");
    setMathEditorLatex("voiceMath", formatted);
    setStatus($("#voiceReviewStatus"), "Math format ready. Check and edit it before using it.", "success");
  } catch (error) {
    setStatus($("#voiceReviewStatus"), error.message || "Math formatting failed. You can still use the edited transcript.", "error");
  } finally { button.disabled = false; }
});
$("#voiceReviewUseTranscript").addEventListener("click", () => appendVoiceReviewToEditor($("#voiceReviewTranscript").value, false));
$("#voiceReviewUseMath").addEventListener("click", () => appendVoiceReviewToEditor(getMathEditorLatex("voiceMath"), true));
$("#voiceReviewSend").addEventListener("click", () => {
  const text = getMathEditorLatex("voiceMath").trim() || $("#voiceReviewTranscript").value.trim();
  if (!text) return setStatus($("#voiceReviewStatus"), "Add or format a voice transcript before sending it.", "error");
  if (!appendVoiceReviewToEditor(text, text === getMathEditorLatex("voiceMath").trim())) return;
  $("#askForm").requestSubmit();
});
$("#voiceReviewClose").addEventListener("click", closeVoiceReview);
$("#voiceReviewDialog").addEventListener("cancel", () => { setMathKeyboardVisible(false, "voiceMath"); state.voiceReviewContext = ""; });
$("#voiceReviewDialog").addEventListener("close", () => { setMathKeyboardVisible(false, "voiceMath"); state.voiceReviewContext = ""; });

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
    subtopics: Array.isArray(topic.subtopics) ? topic.subtopics.map((subtopic) => ({
      ...subtopic,
      available_marks: Number(subtopic.available_marks || 0),
    })) : [],
    count: Number(topic.question_count || 0),
    availableMarks: Number(topic.available_marks || 0),
  };
}

async function loadTopicCatalog(grade) {
  const normalizedGrade = formatGrade(grade);
  if (state.topicCatalogs.has(normalizedGrade)) return state.topicCatalogs.get(normalizedGrade);
  const result = await getJson(`/api/education/test-exam-preparation/topics?grade=${normalizedGrade}`);
  const topics = (result.topics || []).map(normalizeTopic);
  state.examTermProfiles.set(normalizedGrade, result.term_profiles || {});
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
  renderExamPaperLinks();
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
    const params = new URLSearchParams({ grade: String(grade), topic_id: topicId, subtopic_id: subtopicId, limit: String(pageSize), offset: String(offset), include_authored_support: "false" });
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
  return question.question_text_latex || question.accessible_text || question.question_text || question.text || "Question";
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
    renderMath(text, questionLabel(question));
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
  status.innerHTML = '<span class="visual-review-hourglass" aria-hidden="true">⌛</span><div class="visual-review-copy"><strong>Checking the question diagram…</strong><span>Verifying its labels, points and geometry before showing it.</span></div><div class="visual-review-progress-track" aria-hidden="true"><span></span></div>';
  container.append(status);
}

const REQUIRED_QUESTION_VISUAL_REVIEW_VERSION = "2026-10-26.1";

function isSupportedQuestionVisualReviewVersion(value) {
  const required = String(REQUIRED_QUESTION_VISUAL_REVIEW_VERSION).match(/^(\d{4}-\d{2}-\d{2})\.(\d+)$/);
  const actual = String(value || "").match(/^(\d{4}-\d{2}-\d{2})\.(\d+)$/);
  if (!required || !actual) return false;
  return actual[1] > required[1] || (actual[1] === required[1] && Number(actual[2]) >= Number(required[2]));
}

function unverifiedQuestionVisualMessage(prepared) {
  const version = String(prepared?.refinement_version || "");
  if (version && !isSupportedQuestionVisualReviewVersion(version)) {
    return "The server returned an older diagram review, so it was hidden. Select this question again to run the current check.";
  }
  return "The diagram was not verified, so it is hidden. Select this question again to retry the check.";
}

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
      reviewMessage: sourceVisuals.length ? "The diagram check could not start for this question. Select it again to retry." : "",
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
    const lunaReviewed = completeStatuses.includes(status)
      && String(prepared.model || "").toLowerCase() === "gpt-6-luna"
      && isSupportedQuestionVisualReviewVersion(prepared.refinement_version);

    if (hasExplicitGeometry) {
      const missing = missingQuestionGeometry(question, visuals);
      if (missing.length) {
        return {
          visuals: [],
          reviewMessage: "The diagram is missing details stated in the question, so it was hidden. Select this question again to retry the check.",
        };
      }
      if (!lunaReviewed) {
        return {
          visuals: [],
          reviewMessage: unverifiedQuestionVisualMessage(prepared),
        };
      }
    }

    if (status === "not_required" && visuals.length === 0) return { visuals: [], reviewMessage: "" };
    if (lunaReviewed) {
      if (returnedVisuals === null) {
        return {
          visuals: [],
          reviewMessage: "The server finished checking this diagram but returned no diagram to show.",
        };
      }
      cacheQuestionVisuals(question, visuals);
      return { visuals, reviewMessage: visuals.length ? "" : "No diagram is needed for this question." };
    }

    return { visuals: [], reviewMessage: unverifiedQuestionVisualMessage(prepared) };
  } catch {
    return {
      visuals: [],
      reviewMessage: "The diagram check did not finish, so no diagram is being generated now. Select this question again to retry.",
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
  state.practiceHintsUsed = 0;
  state.practiceFormulaShown = false;
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
  void loadQuestionVideoPreview(question, "practice");
  $$(".question-list-button").forEach((button) => button.classList.toggle("is-active", button.dataset.questionId === questionId));
  $("#practiceMarkStatus").textContent = "";
  if (state.voiceReviewContext === "practice") closeVoiceReview();

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

function mathematicsVideoTopicId(grade, topic) {
  const suffix = String(topic || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const topicIds = {
    algebra: "algebra",
    analytical_geometry: "analytical_geometry",
    differential_calculus: "differential_calculus",
    euclidean_geometry_and_measurement: "euclidean_geometry_measurement",
    finance_growth_and_decay: "finance_growth_decay",
    functions: "functions",
    patterns_sequences_and_series: "patterns_sequences_series",
    probability: "probability",
    statistics: "statistics",
    trigonometry: "trigonometry",
  };
  const topicId = topicIds[suffix] || suffix;
  return topicId ? `g${grade}.${topicId}` : "";
}

function mathematicsVideoWords(value) {
  const ignored = new Set(["a", "an", "and", "by", "for", "from", "in", "including", "lesson", "math", "mathematics", "of", "on", "the", "to"]);
  return new Set(String(value || "").toLocaleLowerCase().match(/[a-z0-9]+/g)?.map((word) => {
    if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
    if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
    return word;
  }).filter((word) => !ignored.has(word)) || []);
}

function bestQuestionLesson(lessons, subtopic, questionText) {
  const subtopicWords = mathematicsVideoWords(subtopic);
  const questionWords = mathematicsVideoWords(questionText);
  const questionTerms = [...subtopicWords].filter((word) => questionWords.has(word));
  const matches = [];
  for (const lesson of lessons || []) {
    if (!lesson || typeof lesson.id !== "string" || !lesson.id.trim()) continue;
    const words = mathematicsVideoWords(`${lesson.title || ""} ${lesson.id}`);
    const overlap = [...subtopicWords].filter((word) => words.has(word));
    const exact = [...subtopicWords].every((word) => words.has(word));
    if (questionTerms.length
      ? !questionTerms.every((word) => words.has(word)) || !overlap.length
      : !exact) continue;
    const score = (exact ? 100 : 0) + (overlap.length * 20) + (questionTerms.filter((word) => words.has(word)).length * 25);
    matches.push({ lesson, score });
  }
  if (!matches.length) return null;
  const bestScore = Math.max(...matches.map((item) => item.score));
  const best = matches.filter((item) => item.score === bestScore);
  return best.length === 1 ? best[0].lesson : null;
}

async function loadQuestionVideoFromTopicCatalog({ grade, topic, subtopic, questionText, signal }) {
  const topicId = mathematicsVideoTopicId(grade, topic);
  if (!topicId) throw new Error("The Mathematics topic is not available in the lesson catalog.");
  const catalogParams = new URLSearchParams({ grade: String(grade), topic_id: topicId });
  const catalog = await getJson(`/api/lesson-videos/mathematics/catalog?${catalogParams}`, { signal });
  const lessons = (catalog?.topics || [])
    .filter((entry) => entry?.id === topicId)
    .flatMap((entry) => Array.isArray(entry.lessons) ? entry.lessons : []);
  const selected = bestQuestionLesson(lessons, subtopic, questionText);
  if (!selected) throw new Error("No unique lesson video in this topic matches the question.");
  const videoParams = new URLSearchParams({
    grade: String(grade), topic, subtopic, unit_id: selected.id,
  });
  const result = await getJson(`/api/lesson-videos/mathematics/video?${videoParams}`, { signal });
  if (result?.video && selected.title) {
    return { ...result, video: { ...result.video, title: selected.title } };
  }
  return result;
}

async function loadQuestionVideoPreview(question, context) {
  const container = $(context === "practice" ? "#practiceVideoPreview" : "#examVideoPreview");
  const previous = state.questionVideoControllers[context];
  previous?.abort();
  const controller = new AbortController();
  state.questionVideoControllers[context] = controller;
  const requestId = ++state.questionVideoRequestIds[context];
  container.replaceChildren();
  if (!question) return;
  const grade = formatGrade(question.grade || (context === "practice" ? $("#practiceGrade").value : state.exam?.grade) || state.grade);
  const topic = String(question.topic || question.topic_tags?.[0] || "").trim();
  const subtopic = String(question.subtopic || question.subtopic_name || "").trim();
  if (!topic || !subtopic) {
    const status = document.createElement("p");
    status.className = "question-video-preview-status";
    status.textContent = "No lesson video is linked to this question's topic and subtopic.";
    container.append(status);
    return;
  }
  const status = document.createElement("p");
  status.className = "question-video-preview-status";
  status.textContent = "Finding the lesson video for this question…";
  container.append(status);
  const questionId = String(question.question_id || question.bank_question_id || question.id || "");
  const params = new URLSearchParams({
    grade: String(grade),
    topic: topic.slice(0, 160),
    subtopic: subtopic.slice(0, 160),
    question_text: questionLabel(question).slice(0, 2400),
    unit_id: String(question.subtopic_id || questionId || "question-video").slice(0, 128),
    resolve_by_title: "true",
  });
  try {
    let result;
    try {
      result = await getJson(`/api/lesson-videos/mathematics/video?${params}`, { signal: controller.signal });
    } catch (error) {
      if (error?.status !== 404 && error?.status !== 409) throw error;
      result = await loadQuestionVideoFromTopicCatalog({
        grade, topic, subtopic, questionText: questionLabel(question), signal: controller.signal,
      });
    }
    const currentQuestion = context === "practice" ? state.currentPracticeQuestion : state.examCurrentQuestion;
    if (controller.signal.aborted || requestId !== state.questionVideoRequestIds[context] || currentQuestion !== question) return;
    const video = result?.video || {};
    const playbackUrl = String(video.playback_url || "");
    const thumbnailUrl = String(video.thumbnail_url || "");
    if (!playbackUrl || !thumbnailUrl) throw new Error("No matching lesson thumbnail is available for this question.");
    const link = document.createElement("a");
    link.className = "question-video-link";
    link.href = playbackUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Open ${video.title || subtopic} lesson video in a new tab`);
    const image = document.createElement("img");
    image.src = thumbnailUrl;
    image.alt = `${video.title || subtopic} lesson video thumbnail`;
    image.loading = "lazy";
    image.decoding = "async";
    const label = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = video.title || `Grade ${grade}: ${subtopic}`;
    const action = document.createElement("small");
    action.textContent = "▶ Open lesson video in a new tab";
    label.append(title, action);
    link.append(image, label);
    image.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "question-video-thumbnail-unavailable";
      fallback.textContent = "Thumbnail unavailable";
      image.replaceWith(fallback);
    }, { once: true });
    container.replaceChildren(link);
  } catch (error) {
    if (controller.signal.aborted || requestId !== state.questionVideoRequestIds[context]) return;
    status.classList.add("is-error");
    if (error?.status === 404) {
      status.textContent = "No lesson video in the catalog matches this question yet. Browse the Lesson videos page for available lessons.";
    } else if (error?.status === 409) {
      status.textContent = error.message || "More than one lesson matches this question. Browse the Lesson videos page to choose one.";
    } else if (error?.status === 402) {
      status.textContent = "Lesson video access is needed to preview and open the matching video.";
    } else {
      status.textContent = error?.message || "The matching lesson video could not be loaded. Try again when connected.";
    }
  }
}

function narrateTutorPage(context, text) {
  const safeText = sanitizeLearnerFacingText(text).trim();
  if (!safeText) return;
  liveTutorTranscriptMessage(context, "tutor", safeText);
  realtimeTutor.speakReply(safeText, context);
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
        renderMath(paragraph, description);
        container.append(paragraph);
      }
    }
  }
}

$("#practiceFullScreen").addEventListener("click", () => {
  const image = $("#practiceVisuals img");
  if (image) openImageViewer(image.src, image.alt || "Question diagram");
});

async function requestPracticeSupport(hintLevel, { formulaOnly = false } = {}) {
  const question = state.currentPracticeQuestion;
  if (!question) return;
  const hintButton = $("#practiceHintButton");
  const formulaButton = $("#practiceFormulaButton");
  const panel = $("#practiceHints");
  hintButton.disabled = true;
  formulaButton.disabled = true;
  panel.hidden = false;
  panel.textContent = formulaOnly
    ? "Checking the formula against curriculum references…"
    : `Preparing hint ${hintLevel} with curriculum references…`;
  try {
    const questionText = questionLabel(question);
    const visual = state.practiceVisuals.find((item) => item && (item.diagram || item.kind || item.accessibility_text)) || null;
    const result = await postJson("/api/education/tutor/ask", {
      subject: "Mathematics",
      grade: question.grade || state.grade,
      topic: question.topic || "Mathematics",
      question: questionText,
      mode: "question_hints",
      ai_tier: "luna",
      allow_web_search: false,
      requested_hint_level: formulaOnly ? 0 : hintLevel,
      question_visual_reference: visual?.diagram || visual,
      app_context: {
        ...currentPageTutorContext(),
        page: "Practice",
        page_title: "Mathematics Practice",
        grade: question.grade || state.grade,
        subject: "Mathematics",
        topic: question.topic || "",
        current_question: questionText,
        practice_hint_level: formulaOnly ? "formula" : hintLevel,
      },
    });
    requireTutorCompletion(result, formulaOnly ? "Practice formula help" : "Practice hint");
    if (!formulaOnly) {
      state.practiceHintsUsed += 1;
      state.hintIndex = hintLevel;
    } else state.practiceFormulaShown = true;
    const supportText = readTutorDisplayText(result) || readTutorText(result);
    const displayedText = `${formulaOnly ? "Formula help" : `Hint ${hintLevel} of 3`}\n\n${supportText}`;
    renderMath(panel, displayedText);
    narrateTutorPage("practice", displayedText);
    $("#practiceHintButton").textContent = state.hintIndex >= 3 ? "Show first hint again" : "Show next hint";
  } catch (error) {
    panel.textContent = error.message || "The checked practice support is unavailable. Please retry.";
  } finally {
    hintButton.disabled = false;
    formulaButton.disabled = false;
  }
}

$("#practiceHintButton").addEventListener("click", () => {
  if (!state.currentPracticeQuestion) return;
  realtimeTutor.prepareSpeechFromGesture();
  const level = state.hintIndex >= 3 ? 1 : state.hintIndex + 1;
  void requestPracticeSupport(level);
});

$("#practiceFormulaButton").addEventListener("click", () => {
  realtimeTutor.prepareSpeechFromGesture();
  void requestPracticeSupport(0, { formulaOnly: true });
});

$("#practiceCanvasButton").addEventListener("click", () => openCanvas("practice", state.currentPracticeQuestion));
$("#practiceGraphCanvasButton").addEventListener("click", () => openCanvas("practice-graph", state.currentPracticeQuestion));

const mathEditorFrames = {
  ask: $("#askMathEditor"),
  practice: $("#practiceMathEditor"),
  exam: $("#examAnswer"),
  voiceMath: $("#voiceReviewMath"),
  canvasMath: $("#canvasTranscriptionText"),
};
const mathKeyboardMounts = {
  ask: $("#askMathKeyboardMount"),
  practice: $("#practiceMathKeyboardMount"),
  exam: $("#examMathKeyboardMount"),
  voiceMath: $("#voiceReviewMathKeyboardMount"),
  canvasMath: $("#canvasMathKeyboardMount"),
};
const mathEditorSettings = {
  ask: { placeholder: "Type a question or instruction. Add your working if you want it marked.", fontSize: "18", lineLabels: false },
  practice: { placeholder: "Enter each step on a new line. Keep your final answer last.", fontSize: "23", lineLabels: true },
  exam: { placeholder: "Enter your working for this question.", fontSize: "21", lineLabels: true },
  voiceMath: { placeholder: "Review the mathematical form here.", fontSize: "18", lineLabels: false },
  canvasMath: { placeholder: "Recognized maths will appear here.", fontSize: "19", lineLabels: false },
};
const mathEditorStates = new Map();
let activeMathEditorName = "practice";
const sharedMathKeyboard = $("#practiceMathKeyboard");

function getMathEditor(name = activeMathEditorName) {
  try { return mathEditorFrames[name]?.contentWindow?.SharperMathEditor || null; }
  catch { return null; }
}

function mathEditorCommand(name, command) {
  const editor = getMathEditor(name);
  if (!editor?.execute) return false;
  editor.execute(command);
  return true;
}

function practiceEditorCommand(command) {
  return mathEditorCommand("practice", command);
}

function getMathEditorLatex(name = activeMathEditorName) {
  try { return getMathEditor(name)?.getLatex?.() || mathEditorStates.get(name)?.latex || ""; }
  catch { return mathEditorStates.get(name)?.latex || ""; }
}

function setMathEditorLatex(name, latex) {
  const value = String(latex || "");
  if (!mathEditorCommand(name, { name: "loadLatex", value })) {
    const settings = mathEditorSettings[name];
    if (settings) settings.pendingLatex = value;
  }
}

function initializeMathEditor(name) {
  const frame = mathEditorFrames[name];
  const api = getMathEditor(name);
  if (!api?.execute || frame.dataset.initialized === "true") return Boolean(api?.execute);
  frame.dataset.initialized = "true";
  const settings = mathEditorSettings[name];
  try {
    const editorSurface = frame.contentWindow.document.querySelector(".editor-surface");
    editorSurface?.setAttribute("inputmode", "none");
    if (name === "ask") editorSurface?.addEventListener("pointerdown", enterPhoneAskTypingMode, true);
  } catch { /* Same-origin editor attributes are optional. */ }
  api.execute({ name: "setLineLabels", value: String(settings.lineLabels) });
  api.execute({ name: "setPlaceholder", value: settings.placeholder });
  api.execute({ name: "setFontSize", value: settings.fontSize });
  api.execute({ name: "setPhysicalKeyboardEnabled", value: "true" });
  if (settings.pendingLatex != null) {
    api.execute({ name: "loadLatex", value: settings.pendingLatex });
    delete settings.pendingLatex;
  }
  if (name === "practice") state.practiceEditorReady = true;
  return true;
}

for (const [name, frame] of Object.entries(mathEditorFrames)) {
  frame.addEventListener("load", () => initializeMathEditor(name));
  if (frame.contentDocument?.readyState === "complete" && getMathEditor(name)?.execute) initializeMathEditor(name);
}

function getMathEditorNameForWindow(source) {
  return Object.entries(mathEditorFrames).find(([, frame]) => frame?.contentWindow === source)?.[0] || "";
}

window.addEventListener("message", (event) => {
  if (event.data?.type !== "sharper-math-editor-state") return;
  const name = getMathEditorNameForWindow(event.source);
  if (!name) return;
  mathEditorStates.set(name, event.data.state || null);
  if (name === "practice") state.practiceEditorState = event.data.state || null;
  if (name === activeMathEditorName) updateMathKeyboardPreview(event.data.state?.latex || "");
  if (event.data.state?.event === "ready") initializeMathEditor(name);
  if (event.data.state?.event === "activate") {
    activeMathEditorName = name;
    setMathKeyboardVisible(true, name);
    deviceRemoteNotifyFocus(mathEditorFrames[name]);
  } else if (deviceRemoteSession && deviceRemoteTargetFrame === mathEditorFrames[name]) {
    deviceRemoteNotifyFocus(mathEditorFrames[name]);
  }
});

function getPracticeEditorLatex() {
  return getMathEditorLatex("practice");
}

function updateMathKeyboardPreview(latex) {
  const host = $("#mathKeyboardPreview");
  const lines = String(latex || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    host.replaceChildren();
    return;
  }
  renderMath(host, lines.map((line) => `\\(${line}\\)`).join("\n"));
}

const MATH_ALPHABET_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const MATH_ALPHABET_PUNCTUATION = [",", ".", "'", "!", "?", "_", "-", ":"];
const MATH_KEYSETS = {
  Basic: ["fraction", "√□", "nthRoot", "power", "subscript", "square", "cube", "□°", "|x|", "logBase", "ln", "n!", "∞", "[", "]", "{", "}", "i", "<", ">", "≤", "≥", "≠", "≈", "∴", "π", "x", "y", "e"],
  Advanced: ["sin", "cos", "tan", "csc", "sec", "cot", "arcsin", "arccos", "arctan", "log", "ln", "□°", "π", "θ", "x", "y", "fraction", "√□", "power", "subscript"],
  Calculus: ["d/dx", "secondDerivative", "lim", "lim→", "lim→+", "lim→−", "Σ", "Π", "∫", "definiteIntegral", "∫dx", "∞", "nthRoot", "logBase", "C(n,k)", "P(n,k)", "n!", "x", "y", "e", "fraction", "power", "subscript"],
  Greek: ["α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "ο", "π", "ρ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω", "Γ", "Δ", "Θ", "Λ", "Ξ", "Π", "Σ", "Φ", "Ψ", "Ω", "ϑ", "ϕ"],
  Shorthand: ["∠", "⊥", "∥", "∴", "∵", "⇒", "⇔", "→", "↔", "≡", "≅", "≈", "∝", "∈", "∉", "⊂", "⊆", "∪", "∩", "∅", "ℝ", "ℕ", "ℤ", "ℚ", "∀", "∃", "△", "≤", "≥", "≠", "±"],
};
const MATH_NUMERIC_KEYS = ["(", ")", "%", "AC", "7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "=", "+", "±", "≈"];
const MATH_KEY_PRESENTATIONS = {
  fraction: { text: "a/b", accessibleName: "Insert a fraction", parts: ["a/b"] },
  nthRoot: { text: "n√□", accessibleName: "Insert an nth root", parts: [{ tag: "sup", text: "n" }, "√□"] },
  power: { text: "xy", accessibleName: "Insert a power", parts: ["x", { tag: "sup", text: "y" }] },
  subscript: { text: "an", accessibleName: "Insert a subscript", parts: ["a", { tag: "sub", text: "n" }] },
  square: { text: "□2", accessibleName: "Insert a square", parts: ["□", { tag: "sup", text: "2" }] },
  cube: { text: "□3", accessibleName: "Insert a cube", parts: ["□", { tag: "sup", text: "3" }] },
  logBase: { text: "log□", accessibleName: "Insert a logarithm with a base", parts: ["log", { tag: "sub", text: "□" }] },
  secondDerivative: { text: "d2/dx2", accessibleName: "Insert the second derivative", parts: ["d", { tag: "sup", text: "2" }, "/dx", { tag: "sup", text: "2" }] },
  definiteIntegral: { text: "∫ab", accessibleName: "Insert a definite integral", parts: ["∫", { tag: "sup", text: "a" }, { tag: "sub", text: "b" }] },
};
const MATH_KEY_COMMANDS = {
  fraction: ["insertFraction"], "√□": ["insertRoot"], nthRoot: ["insertNthRoot"], power: ["insertPower"], subscript: ["insertSubscript"],
  square: ["insertFixedPower", "2"], cube: ["insertFixedPower", "3"], "□°": ["insertFixedPower", "°"], "°": ["insertFixedPower", "°"],
  "|x|": ["insertAbsolute"], logBase: ["insertLogarithm"], "n!": ["insertFactorial"], "∞": ["insertInfinity"],
  "d/dx": ["insertDerivative", "1"], secondDerivative: ["insertDerivative", "2"], "lim": ["insertLimit", "plain"], "lim→": ["insertLimit", "to"],
  "lim→+": ["insertLimit", "right"], "lim→−": ["insertLimit", "left"], "∫": ["insertIntegral", "plain"], definiteIntegral: ["insertIntegral", "definite"],
  "∫dx": ["insertIntegral", "dx"], "Σ": ["insertLargeOperator", "sum"], "Π": ["insertLargeOperator", "product"],
  "C(n,k)": ["insertCombination", "C"], "P(n,k)": ["insertCombination", "P"], "×10ⁿ": ["insertScientificPower"],
  "(": ["insertLiteralBracket", "("], "[": ["insertLiteralBracket", "["], "{": ["insertLiteralBracket", "{"],
  "f(x)": ["insertText", "f(x) = "], "y=": ["insertText", "y = "], "AC": ["clear"],
};
let mathAlphabetShifted = false;

function mathKeyCommand(label) {
  const entry = MATH_KEY_COMMANDS[label];
  if (entry) return { name: entry[0], value: entry[1] || "" };
  if (["sin", "cos", "tan", "csc", "sec", "cot", "arcsin", "arccos", "arctan", "log", "ln"].includes(label)) return { name: "insertFunction", value: label };
  return { name: "insertText", value: label };
}

function createMathKey(label, ariaLabel = `Insert ${label}`) {
  const button = document.createElement("button");
  button.type = "button";
  const presentation = MATH_KEY_PRESENTATIONS[label];
  const visibleLabel = document.createElement("span");
  visibleLabel.className = "math-key-label";
  for (const part of presentation?.parts || [label]) {
    if (typeof part === "string") visibleLabel.append(document.createTextNode(part));
    else {
      const script = document.createElement(part.tag);
      script.textContent = part.text;
      visibleLabel.append(script);
    }
  }
  button.append(visibleLabel);
  button.setAttribute("aria-label", ariaLabel === `Insert ${label}` ? (presentation?.accessibleName || ariaLabel) : ariaLabel);
  const visibleLength = presentation?.text.length || label.length;
  if (visibleLength >= 5) button.classList.add("is-long-label");
  if (visibleLength >= 7) button.classList.add("is-extra-long-label");
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("click", () => mathEditorCommand(activeMathEditorName, mathKeyCommand(label)));
  return button;
}

function renderMathKeyboardKeys(mode = state.practiceKeyboardMode) {
  state.practiceKeyboardMode = mode in MATH_KEYSETS || mode === "Alphabet" ? mode : "Basic";
  $$('[data-keyboard-mode]').forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.keyboardMode === state.practiceKeyboardMode)));
  const host = $("#mathKeyboardKeys");
  const numeric = $("#mathKeyboardNumericKeys");
  const keyboardBody = $(".math-keyboard-body", sharedMathKeyboard);
  host.replaceChildren();
  host.classList.toggle("is-alphabet", state.practiceKeyboardMode === "Alphabet");
  numeric.hidden = state.practiceKeyboardMode !== "Basic";
  keyboardBody.classList.toggle("has-numeric", state.practiceKeyboardMode === "Basic");
  if (state.practiceKeyboardMode === "Alphabet") {
    MATH_ALPHABET_ROWS.forEach((letters, index) => {
      const row = document.createElement("div");
      row.className = `math-alphabet-row math-alphabet-row-${index + 1}`;
      if (index === 2) {
        const shift = document.createElement("button");
        shift.type = "button";
        shift.className = "math-key-shift";
        shift.textContent = "⇧";
        shift.setAttribute("aria-label", mathAlphabetShifted ? "Return to lowercase letters" : "Shift to uppercase letters");
        shift.setAttribute("aria-pressed", String(mathAlphabetShifted));
        shift.addEventListener("pointerdown", (event) => event.preventDefault());
        shift.addEventListener("click", () => { mathAlphabetShifted = !mathAlphabetShifted; renderMathKeyboardKeys("Alphabet"); });
        row.append(shift);
      }
      for (const letter of letters) {
        const value = mathAlphabetShifted ? letter.toUpperCase() : letter;
        row.append(createMathKey(value, `Insert letter ${value}`));
      }
      if (index === 2) row.append(createMathKey("?", "Insert question mark"));
      host.append(row);
    });
    const punctuation = document.createElement("div");
    punctuation.className = "math-alphabet-row math-alphabet-punctuation";
    for (const label of MATH_ALPHABET_PUNCTUATION) punctuation.append(createMathKey(label, `Insert ${label}`));
    host.append(punctuation);
  } else {
    for (const label of MATH_KEYSETS[state.practiceKeyboardMode]) host.append(createMathKey(label));
  }
}

for (const label of MATH_NUMERIC_KEYS) {
  const button = createMathKey(label, label === "AC" ? "Clear maths" : `Insert ${label}`);
  if (["÷", "×", "−", "=", "+", "±", "≈", "AC"].includes(label)) button.classList.add("is-operator");
  $("#mathKeyboardNumericKeys").append(button);
}

renderMathKeyboardKeys();

let phoneAskTypingReturnScrollTop = null;

function supportsPhoneAskTypingMode() {
  return document.documentElement.dataset.deviceType === "mobile" && matchMedia("(max-width: 700px)").matches;
}

function enterPhoneAskTypingMode() {
  const root = document.documentElement;
  if (!supportsPhoneAskTypingMode() || root.dataset.phoneTypingMode === "ask") return;
  phoneAskTypingReturnScrollTop = $("#mainPanel")?.scrollTop || 0;
  root.dataset.phoneTypingMode = "ask";
  try {
    const fullscreenRequest = root.requestFullscreen?.({ navigationUI: "hide" });
    fullscreenRequest?.catch(() => {});
  } catch { /* Chrome may deny fullscreen; the in-app typing layout still applies. */ }
}

function exitPhoneAskTypingMode() {
  const root = document.documentElement;
  if (root.dataset.phoneTypingMode !== "ask") return;
  delete root.dataset.phoneTypingMode;
  const returnScrollTop = phoneAskTypingReturnScrollTop;
  phoneAskTypingReturnScrollTop = null;
  if (document.fullscreenElement) {
    try { document.exitFullscreen()?.catch(() => {}); } catch { /* The normal app view is restored by CSS. */ }
  }
  requestAnimationFrame(() => {
    const mainPanel = $("#mainPanel");
    if (mainPanel && Number.isFinite(returnScrollTop)) mainPanel.scrollTop = returnScrollTop;
  });
}

function setMathKeyboardVisible(visible, editorName = activeMathEditorName) {
  activeMathEditorName = editorName;
  if (visible && editorName === "ask") enterPhoneAskTypingMode();
  const mount = mathKeyboardMounts[editorName];
  if (mount && sharedMathKeyboard.parentElement !== mount) mount.append(sharedMathKeyboard);
  sharedMathKeyboard.hidden = !visible;
  for (const toggle of $$(".math-editor-keyboard-toggle")) toggle.setAttribute("aria-expanded", String(visible && toggle.dataset.editorTarget === editorName));
  if (visible) {
    updateMathKeyboardPreview(getMathEditorLatex(editorName));
    if (document.documentElement.dataset.phoneTypingMode !== "ask") {
      requestAnimationFrame(() => sharedMathKeyboard.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
  } else if (editorName === "ask") {
    exitPhoneAskTypingMode();
  }
}

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && document.documentElement.dataset.phoneTypingMode === "ask" && !sharedMathKeyboard.hidden) {
    setMathKeyboardVisible(false, "ask");
  }
});

function toggleMathKeyboard(editorName) {
  const visible = !(activeMathEditorName === editorName && !sharedMathKeyboard.hidden);
  setMathKeyboardVisible(visible, editorName);
}

function setPracticeKeyboardVisible(visible) {
  setMathKeyboardVisible(visible, "practice");
}

for (const toggle of $$(".math-editor-keyboard-toggle")) {
  toggle.addEventListener("click", () => toggleMathKeyboard(toggle.dataset.editorTarget));
}
sharedMathKeyboard.querySelector(".math-keyboard-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-keyboard-mode]");
  if (tab) renderMathKeyboardKeys(tab.dataset.keyboardMode);
});
let mathActionRepeatDelay = 0;
let mathActionRepeatInterval = 0;
let mathActionHandledOnPointer = false;
let mathActionClickReset = 0;
const repeatingMathActions = new Set(["backspace", "moveLeft", "moveRight", "moveUp", "moveDown"]);
const mathActionButtons = sharedMathKeyboard.querySelector(".math-keyboard-actions");
mathActionButtons.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const action = event.target.closest("[data-editor-action]")?.dataset.editorAction;
  if (!action || !repeatingMathActions.has(action)) return;
  clearTimeout(mathActionClickReset);
  mathActionHandledOnPointer = true;
  mathEditorCommand(activeMathEditorName, { name: action });
  mathActionRepeatDelay = setTimeout(() => {
    mathActionRepeatInterval = setInterval(() => mathEditorCommand(activeMathEditorName, { name: action }), 70);
  }, 380);
});
window.addEventListener("pointerup", () => {
  if (!mathActionRepeatDelay && !mathActionRepeatInterval) return;
  clearTimeout(mathActionRepeatDelay);
  clearInterval(mathActionRepeatInterval);
  mathActionRepeatDelay = 0;
  mathActionRepeatInterval = 0;
  mathActionClickReset = setTimeout(() => { mathActionHandledOnPointer = false; }, 0);
});
window.addEventListener("pointercancel", () => {
  clearTimeout(mathActionRepeatDelay);
  clearInterval(mathActionRepeatInterval);
  mathActionRepeatDelay = 0;
  mathActionRepeatInterval = 0;
  mathActionHandledOnPointer = false;
});
mathActionButtons.addEventListener("click", (event) => {
  const button = event.target.closest("[data-editor-action]");
  if (!button) return;
  if (mathActionHandledOnPointer) {
    mathActionHandledOnPointer = false;
    return;
  }
  void applyMathKeyboardAction(button.dataset.editorAction);
});
sharedMathKeyboard.querySelector(".math-keyboard-footer").addEventListener("click", (event) => {
  if (event.target.closest("[data-editor-insert='space']")) mathEditorCommand(activeMathEditorName, { name: "insertText", value: " " });
  if (event.target.closest("[data-keyboard-hide]")) setMathKeyboardVisible(false);
  const button = event.target.closest("[data-editor-action]");
  if (button) mathEditorCommand(activeMathEditorName, { name: button.dataset.editorAction });
});

sharedMathKeyboard.addEventListener("click", (event) => {
  if (event.target.closest("[data-keyboard-hide]") || document.documentElement.dataset.phoneTypingMode !== "ask") return;
  requestAnimationFrame(() => {
    if (sharedMathKeyboard.hidden || document.documentElement.dataset.phoneTypingMode !== "ask") return;
    const editor = getMathEditor("ask");
    if (editor?.focusForPhysicalKeyboard) editor.focusForPhysicalKeyboard();
    else editor?.execute?.({ name: "focus" });
  });
});

async function applyMathKeyboardAction(action) {
  const editor = getMathEditor(activeMathEditorName);
  if (!editor) return;
  if (action === "copy") {
    const text = editor.getClipboardText?.("selection") || "";
    if (!text) return showToast("Select maths in the editor before copying it.");
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("Clipboard API unavailable");
      showToast("Selected maths copied.");
    } catch {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(helper);
      helper.select();
      const copied = document.execCommand("copy");
      helper.remove();
      if (!copied) showToast("Copy is unavailable in this browser.");
    }
    return;
  }
  if (action === "paste") {
    try {
      const text = await navigator.clipboard.readText();
      if (text) mathEditorCommand(activeMathEditorName, { name: "insertLatex", value: text });
      else showToast("The clipboard is empty.");
    } catch {
      showToast("Allow clipboard access or use Ctrl+V while the editor is focused.");
    }
    return;
  }
  mathEditorCommand(activeMathEditorName, { name: action });
}
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
  realtimeTutor.prepareSpeechFromGesture();
  button.disabled = true;
  setStatus($("#practiceMarkStatus"), "Marking your attempt…");
  try {
    const markingContext = {
      question_id: String(question.question_id || question.bank_question_id || question.id || ""),
      bank_version: question.bank_version || "",
      subject: "Mathematics",
      grade: question.grade || state.grade,
      topic: question.topic || "",
      question_text: questionLabel(question),
      marks: question.marks || 0,
      learner_working: working,
      learner_final_answer: lastNonEmptyLine(working) || working,
      assistance_mode: state.practiceHintsUsed ? "Hints" : "SolveItMyself",
      hints_used: state.practiceHintsUsed,
    };
    let result;
    if (working) {
      result = await postJson("/api/education/math-practice/mark", markingContext);
    } else if (state.practiceAnswerPhotoIds.length) {
      if (!state.practiceInspectionId) throw new Error("This handwritten upload is no longer attached to the selected question. Reopen the canvas and attach it again, or transcribe the work in the editor.");
      result = await postJson("/api/education/tutor/ask", {
        subject: "Mathematics", grade: question.grade || state.grade,
        topic: question.topic || "", question: questionLabel(question),
        learner_answer: working || "My complete working and answer are in the attached handwritten image.",
        mode: "mark_attempt", inspection_id: state.practiceInspectionId,
        ai_tier: "luna", allow_web_search: false,
        app_context: currentPageTutorContext(),
        math_practice_context: { ...markingContext, photo_ids: [...state.practiceAnswerPhotoIds] },
      });
    }
    requireTutorCompletion(result, "Practice marking");
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
    const answerVisuals = Array.isArray(result.solution_visuals)
      ? result.solution_visuals
      : Array.isArray(result.practice_marking?.solution_visuals) ? result.practice_marking.solution_visuals : [];
    let answerVisualPanel = null;
    if (answerVisuals.length) {
      answerVisualPanel = document.createElement("div");
      answerVisualPanel.className = "practice-answer-visuals";
      const heading = document.createElement("h4");
      heading.textContent = "Worked answer diagram";
      const images = document.createElement("div");
      images.className = "question-visuals answer-visuals";
      renderQuestionVisuals(images, answerVisuals, "Worked answer diagram", questionLabel(question));
      answerVisualPanel.append(heading, images);
    }
    const save = document.createElement("button");
    save.className = "button secondary";
    save.type = "button";
    save.textContent = "Save PDF report";
    save.addEventListener("click", () => saveReport(`Grade ${question.grade || state.grade} practice`, `${questionLabel(question)}\n\nYour working:\n${working}`, reportText));
    panel.append(title, body);
    if (answerVisualPanel) panel.append(answerVisualPanel);
    panel.append(save);
    setStatus($("#practiceMarkStatus"), "Attempt marked.", "success");
    const scoreText = Number.isFinite(Number(earned)) ? `You earned ${earned} out of ${maximum} marks. ` : "Your practice attempt has been marked. ";
    narrateTutorPage("practice", `${scoreText}${reportText}`);
  } catch (error) {
    setStatus($("#practiceMarkStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

function readMarkingText(result) {
  const parts = [];
  const marking = result.practice_marking && typeof result.practice_marking === "object" ? result.practice_marking : result;
  if (typeof result.assistant_message === "string" && result.assistant_message.trim()) parts.push(result.assistant_message.trim());
  if (result.marking_feedback && typeof result.marking_feedback === "object") {
    const summary = result.marking_feedback;
    for (const key of ["feedback", "what_was_correct", "answer_analysis"]) if (summary[key]) parts.push(String(summary[key]));
    for (const key of ["corrections", "incomplete_reasons"]) if (Array.isArray(summary[key]) && summary[key].length) parts.push(summary[key].map(String).join("\n"));
  }
  for (const key of ["status", "feedback", "what_was_correct", "answer_analysis", "diagnosis", "correction", "solution", "worked_solution", "next_step", "worked_solution_steps", "step_marks"]) {
    const value = marking[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
    else if (Array.isArray(value)) parts.push(value.map((item) => {
      if (typeof item === "string") return item;
      if (key === "step_marks" && item && typeof item === "object") return `Step ${item.step || ""}: ${item.feedback || ""} ${item.marks != null ? `${item.marks} mark${Number(item.marks) === 1 ? "" : "s"}` : ""}`.trim();
      return item?.text || item?.step || JSON.stringify(item);
    }).filter(Boolean).join("\n"));
  }
  for (const key of ["corrections", "incomplete_reasons"]) {
    if (Array.isArray(marking[key]) && marking[key].length) parts.push(marking[key].map(String).join("\n"));
  }
  if (parts.length) return sanitizeLearnerFacingText([...new Set(parts)].join("\n\n"));
  return sanitizeLearnerFacingText(JSON.stringify(result, null, 2));
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

async function mathSvgToPng(latex) {
  const mathJax = await ensureMathJax();
  if (!mathJax?.tex2svgPromise) throw new Error("Math typesetting is not ready.");
  const rendered = await mathJax.tex2svgPromise(latex, { display: true });
  const svg = rendered.querySelector("svg");
  const viewBox = (svg?.getAttribute("viewBox") || "").split(/[ ,]+/).map(Number);
  if (!svg || viewBox.length !== 4 || !viewBox.every(Number.isFinite)) throw new Error("A formula could not be rendered for the report.");
  const maxWidthPt = 540;
  const pointsPerEm = Math.min(12, maxWidthPt * 1000 / Math.max(viewBox[2], 1));
  const widthPt = Math.max(12, viewBox[2] / 1000 * pointsPerEm);
  const heightPt = Math.max(10, viewBox[3] / 1000 * pointsPerEm);
  const pixelScale = 3;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", `${Math.round(widthPt * pixelScale)}px`);
  svg.setAttribute("height", `${Math.round(heightPt * pixelScale)}px`);
  svg.style.color = "#10243b";
  svg.querySelectorAll('[fill="currentColor"]').forEach((path) => path.setAttribute("fill", "#10243b"));
  const svgUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("A formula image could not be prepared."));
      image.src = svgUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || Math.round(widthPt * pixelScale);
    canvas.height = image.naturalHeight || Math.round(heightPt * pixelScale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("A formula image could not be prepared.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png").split(",", 2)[1];
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

async function reportMathSegments(body) {
  const segments = splitTextbookMath(body);
  if (!segments.some((segment) => segment.type === "math")) return null;
  if (segments.length > 250) throw new Error("This report contains too many separate maths lines to typeset. Shorten it and save again.");
  const printable = [];
  for (const segment of segments) {
    if (segment.type === "break") printable.push({ type: "break" });
    else if (segment.type === "text") printable.push({ type: "text", text: segment.text });
    else printable.push({ type: "math_image", png_base64: await mathSvgToPng(segment.text) });
  }
  return printable;
}

async function saveReport(title, question, response) {
  const body = (question || "") + "\n\nFeedback and worked solution\n\n" + (response || "");
  try {
    const segments = await reportMathSegments(body);
    const pdf = await apiRequest("/api/study-exports/pdf", {
      method: "POST",
      body: JSON.stringify({ title, subtitle: "Saved " + new Date().toLocaleString(), body: body.trim(), ...(segments ? { segments } : {}) }),
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

function loadPaperCatalog() {
  if (!paperCatalogPromise) {
    paperCatalogPromise = fetch("./paper-catalog.json")
      .then((response) => {
        if (!response.ok) throw new Error("Paper links could not be loaded. Please reload the app.");
        return response.json();
      })
      .then((catalog) => Array.isArray(catalog.entries) ? catalog.entries : []);
  }
  return paperCatalogPromise;
}

function paperDate(name) {
  const value = String(name || "");
  const years = [];
  const yearPattern = /(?:^|[^0-9])((?:19|20)\d{2})(?!\d)/g;
  let match;
  while ((match = yearPattern.exec(value))) years.push(Number(match[1]));
  if (!years.length) return null;

  const monthNumbers = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };
  const monthPattern = /(?:^|[^a-z])(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?![a-z])/gi;
  let month = 0;
  while ((match = monthPattern.exec(value))) month = Math.max(month, monthNumbers[match[1].toLocaleLowerCase()] || 0);
  return { year: Math.max(...years), month };
}

function renderPaperCatalogItems() {
  const host = $("#paperCatalogItems");
  const query = $("#paperCatalogSearch").value.trim().toLocaleLowerCase();
  const entries = activePaperCatalog.entries
    .filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      const dateA = paperDate(a.name);
      const dateB = paperDate(b.name);
      if (dateA && !dateB) return -1;
      if (!dateA && dateB) return 1;
      if (dateA && dateB) {
        const dateOrder = (dateB.year - dateA.year) || (dateB.month - dateA.month);
        if (dateOrder) return activePaperCatalog.newestFirst ? dateOrder : -dateOrder;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  host.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("a");
    row.className = "paper-catalog-link";
    row.textContent = entry.name.replace(/\.pdf$/i, "");
    row.href = `https://www.google.com/search?${new URLSearchParams({ q: `"${entry.name}" filetype:pdf` })}`;
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    host.append(row);
  }
  $("#paperCatalogCount").textContent = `Showing ${entries.length} of ${activePaperCatalog.entries.length} filenames`;
  $("#paperCatalogEmpty").hidden = entries.length > 0;
}

async function openPaperCatalog(grade, source) {
  const dialog = $("#paperCatalogDialog");
  const normalizedGrade = formatGrade(grade);
  const title = source === "dbe"
    ? "Links to DBE Grade 12 papers and memos"
    : `Links to Stanmore Grade ${normalizedGrade} papers and memos`;
  $("#paperCatalogTitle").textContent = title;
  $("#paperCatalogSearch").value = "";
  $("#paperCatalogCount").textContent = "Loading filenames…";
  $("#paperCatalogItems").replaceChildren();
  $("#paperCatalogEmpty").hidden = true;
  activePaperCatalog = { grade: normalizedGrade, source, entries: [], newestFirst: true };
  $("#paperCatalogSort").textContent = "Newest first";
  $("#paperCatalogSort").title = "Switch to oldest-first order";
  $("#paperCatalogSort").setAttribute("aria-pressed", "true");
  if (!dialog.open) dialog.showModal();
  try {
    const catalog = await loadPaperCatalog();
    activePaperCatalog.entries = catalog
      .filter((entry) => Number(entry.grade) === Number(normalizedGrade) && entry.source === source)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    if (!activePaperCatalog.entries.length) throw new Error("No paper links are available for this grade yet.");
    renderPaperCatalogItems();
    $("#paperCatalogSearch").focus();
  } catch (error) {
    $("#paperCatalogItems").replaceChildren();
    $("#paperCatalogCount").textContent = error.message;
    $("#paperCatalogEmpty").hidden = true;
  }
}

$("#paperCatalogClose").addEventListener("click", () => $("#paperCatalogDialog").close());
$("#paperCatalogSearch").addEventListener("input", renderPaperCatalogItems);
$("#paperCatalogSort").addEventListener("click", (event) => {
  activePaperCatalog.newestFirst = !activePaperCatalog.newestFirst;
  const button = event.currentTarget;
  button.textContent = activePaperCatalog.newestFirst ? "Newest first" : "Oldest first";
  button.title = activePaperCatalog.newestFirst ? "Switch to oldest-first order" : "Switch to newest-first order";
  button.setAttribute("aria-pressed", String(activePaperCatalog.newestFirst));
  renderPaperCatalogItems();
});

function renderSourceLinks() {
  const host = $("#sourceLinks");
  if (!host) return;
  const grade = formatGrade($("#globalGrade").value || state.grade);
  host.replaceChildren();
  const intro = document.createElement("p");
  intro.className = "source-note";
  intro.textContent = "Choose a paper filename to search for a downloadable copy. Download it, then upload your PDF here.";
  const links = document.createElement("div");
  links.className = "source-link-list";
  function addLink(label, source) {
    const button = document.createElement("button");
    button.className = "button subtle";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => openPaperCatalog(grade, source));
    links.append(button);
  }
  addLink(`Links to Stanmore Grade ${grade} papers and memos`, "stanmore");
  if (grade === 12) addLink("Links to DBE Grade 12 papers and memos", "dbe");
  host.append(intro, links);
}

const EXAM_TERM_LABELS = {
  1: "Term 1 · March test",
  2: "Term 2 · June exam",
  3: "Term 3 · September test / trial exam",
  4: "Term 4 · October / November / December exam",
};

function paperCatalogTerm(entry) {
  const name = String(entry.name || "").toLocaleLowerCase();
  if (/(?:^|[^a-z])(?:february|feb|march|mar)(?:[^a-z]|$)|term[\s_-]*1(?!\d)|(?:^|[^a-z])t1(?:[^a-z]|$)/.test(name)) return 1;
  if (/(?:^|[^a-z])(?:june|jun|mid[\s_-]*year)(?:[^a-z]|$)|term[\s_-]*2(?!\d)|(?:^|[^a-z])t2(?:[^a-z]|$)/.test(name)) return 2;
  if (/(?:^|[^a-z])(?:september|sept|sep|trial|prelim)(?:[^a-z]|$)|term[\s_-]*3(?!\d)|(?:^|[^a-z])t3(?:[^a-z]|$)/.test(name)) return 3;
  if (/(?:^|[^a-z])(?:october|oct|november|nov|december|dec|final|nsc)(?:[^a-z]|$)|term[\s_-]*4(?!\d)|(?:^|[^a-z])t4(?:[^a-z]|$)/.test(name)) return 4;
  return 0;
}

async function renderExamPaperLinks() {
  const host = $("#examPaperLinks");
  if (!host) return;
  const grade = formatGrade($("#examGrade").value || state.grade);
  const renderVersion = ++examPaperLinksRenderVersion;
  host.replaceChildren();
  try {
    const entries = (await loadPaperCatalog()).filter((entry) => Number(entry.grade) === grade);
    if (renderVersion !== examPaperLinksRenderVersion || grade !== formatGrade($("#examGrade").value || state.grade)) return;
    host.replaceChildren();
    const grouped = new Map([1, 2, 3, 4].map((term) => [term, entries.filter((entry) => paperCatalogTerm(entry) === term)]));
    const ungrouped = entries.filter((entry) => !paperCatalogTerm(entry));
    for (const [term, termEntries] of grouped) {
      const details = document.createElement("details");
      details.className = "exam-term-group";
      const summary = document.createElement("summary");
      summary.textContent = `${EXAM_TERM_LABELS[term]} · ${termEntries.length} links`;
      details.append(summary);
      if (!termEntries.length) {
        const empty = document.createElement("p");
        empty.className = "exam-source-empty";
        empty.textContent = "No matching filename is listed for this term yet.";
        details.append(empty);
      }
      ["stanmore", "dbe"].forEach((source) => {
        const sourceEntries = termEntries.filter((entry) => entry.source === source);
        if (!sourceEntries.length) return;
        const sourceGroup = document.createElement("section");
        sourceGroup.className = "exam-source-group";
        const heading = document.createElement("h3");
        heading.textContent = source === "dbe" ? "DBE" : "Stanmore";
        sourceGroup.append(heading);
        sourceEntries.sort((a, b) => {
          const dateA = paperDate(a.name);
          const dateB = paperDate(b.name);
          if (dateA && dateB) return (dateB.year - dateA.year) || (dateB.month - dateA.month);
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        }).forEach((entry) => {
          const link = document.createElement("a");
          link.className = "paper-catalog-link exam-paper-link";
          link.textContent = entry.name.replace(/\.pdf$/i, "");
          link.href = `https://www.google.com/search?${new URLSearchParams({ q: `"${entry.name}" filetype:pdf` })}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          const kind = document.createElement("span");
          kind.className = "exam-paper-kind";
          kind.textContent = entry.kind || "Paper";
          link.append(kind);
          sourceGroup.append(link);
        });
        details.append(sourceGroup);
      });
      host.append(details);
    }
    if (ungrouped.length) {
      const details = document.createElement("details");
      details.className = "exam-term-group";
      const summary = document.createElement("summary");
      summary.textContent = `Other / term not stated · ${ungrouped.length} links`;
      details.append(summary);
      ["stanmore", "dbe"].forEach((source) => {
        const sourceEntries = ungrouped.filter((entry) => entry.source === source);
        if (!sourceEntries.length) return;
        const section = document.createElement("section");
        section.className = "exam-source-group";
        const heading = document.createElement("h3");
        heading.textContent = source === "dbe" ? "DBE" : "Stanmore";
        section.append(heading);
        sourceEntries.forEach((entry) => {
          const link = document.createElement("a");
          link.className = "paper-catalog-link exam-paper-link";
          link.textContent = entry.name.replace(/\.pdf$/i, "");
          link.href = `https://www.google.com/search?${new URLSearchParams({ q: `"${entry.name}" filetype:pdf` })}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          const kind = document.createElement("span");
          kind.className = "exam-paper-kind";
          kind.textContent = entry.kind || "Paper";
          link.append(kind);
          section.append(link);
        });
        details.append(section);
      });
      host.append(details);
    }
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "status";
      empty.textContent = `No past-paper links are listed for Grade ${grade}. You can still upload a PDF from your device.`;
      host.append(empty);
    }
  } catch (error) {
    if (renderVersion !== examPaperLinksRenderVersion) return;
    host.replaceChildren();
    const message = document.createElement("p");
    message.className = "status is-error";
    message.textContent = error.message;
    host.append(message);
  }
}

function updateUploadedExamStatus() {
  const status = $("#examUploadStatus");
  const strict = $("#examSessionMode").value === "strict";
  if (!state.examPaperDocumentId) {
    setStatus(status, "No past paper uploaded yet. Select a downloaded PDF to continue.");
  } else if (strict && !state.examMemoDocumentId) {
    setStatus(status, `Question paper ready: ${state.examPaperFileName || "uploaded PDF"}. Upload its English memo to start Strict Mock Exam.`, "error");
  } else {
    const memo = state.examMemoDocumentId ? ` Memo: ${state.examMemoFileName || "uploaded"}.` : " No memo uploaded; Guided Practice will use question-only support.";
    setStatus(status, `Question paper ready: ${state.examPaperFileName || "uploaded PDF"}.${memo}`, "success");
  }
  $("#startUploadedExam").disabled = !state.examPaperDocumentId || (strict && !state.examMemoDocumentId);
}

async function uploadExamSource(file, kind) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    setStatus($("#examUploadStatus"), "Choose a PDF file downloaded from the paper link.", "error");
    return;
  }
  const button = kind === "memo" ? $("#examUploadMemoButton") : $("#examUploadPaperButton");
  button.disabled = true;
  setStatus($("#examUploadStatus"), `Uploading ${file.name}…`);
  try {
    const inspectionId = await ensureInspection("exam");
    const form = new FormData();
    form.set("document_type", kind === "memo" ? "ask_marking_memo" : "ask_question_paper");
    form.set("document", file, file.name);
    const result = await uploadForm(`/api/inspections/${encodeURIComponent(inspectionId)}/upload-document`, form);
    const documentId = result.id || result.document_id;
    if (!documentId) throw new Error("The PDF upload did not return a document ID. Please try again.");
    if (kind === "memo") {
      const previousId = state.examMemoDocumentId;
      state.examMemoDocumentId = documentId;
      state.examMemoFileName = file.name;
      sessionStorage.setItem("sharperx_web_exam_memo_id", documentId);
      sessionStorage.setItem("sharperx_web_exam_memo_name", file.name);
      if (previousId && previousId !== documentId) void deleteSessionPaperDocument(previousId, inspectionId).catch(() => {});
    } else {
      const previousId = state.examPaperDocumentId;
      state.examPaperDocumentId = documentId;
      state.examPaperFileName = file.name;
      sessionStorage.setItem("sharperx_web_exam_paper_id", documentId);
      sessionStorage.setItem("sharperx_web_exam_paper_name", file.name);
      if (previousId && previousId !== documentId) void deleteSessionPaperDocument(previousId, inspectionId).catch(() => {});
    }
    updateUploadedExamStatus();
  } catch (error) {
    setStatus($("#examUploadStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
}

$("#examUploadPaperButton").addEventListener("click", () => $("#examPaperInput").click());
$("#examUploadMemoButton").addEventListener("click", () => $("#examMemoInput").click());
$("#examPaperInput").addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  void uploadExamSource(file, "paper");
});
$("#examMemoInput").addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  void uploadExamSource(file, "memo");
});
$("#examSessionMode").addEventListener("change", updateUploadedExamStatus);

function updateExamGenerateButton() {
  const scopes = collectExamScopes();
  const profile = selectedExamTermProfile();
  const target = Number(profile?.total_marks || 0);
  const tolerance = Number(profile?.total_marks_tolerance || 2);
  let availableMarks = 0;
  let availabilityKnown = true;
  $$("#examTopicChoices [data-topic-choice]:checked").forEach((topicInput) => {
    const children = [...$("#examTopicChoices").querySelectorAll('[data-parent-topic="' + CSS.escape(topicInput.dataset.topicChoice) + '"]')];
    if (children.length) {
      const selectedChildren = children.filter((child) => child.checked);
      selectedChildren.forEach((child) => {
        if (!child.hasAttribute("data-available-marks")) availabilityKnown = false;
        availableMarks += Number(child.dataset.availableMarks || 0);
      });
    } else {
      if (!topicInput.hasAttribute("data-available-marks")) availabilityKnown = false;
      availableMarks += Number(topicInput.dataset.availableMarks || 0);
    }
  });
  const insufficient = scopes.length > 0 && target > 0 && availabilityKnown && availableMarks < target - tolerance;
  $("#generateExam").disabled = scopes.length === 0 || insufficient;
  if (!scopes.length) return;
  if (insufficient) {
    setStatus($("#examStatus"), `Your checked scope has about ${availableMarks} question-bank marks; this assessment needs ${target}. Add more subtopics from your teacher's or department's scope. If you do not have the scope, ask your teacher for it.`, "error");
  } else if (availabilityKnown && target) {
    setStatus($("#examStatus"), `Your checked scope has about ${availableMarks} question-bank marks for a ${target}-mark target. The server will verify the usable questions before it builds the paper.`, "success");
  }
}

function selectedExamTermProfile() {
  const grade = Number($("#examGrade").value);
  const term = String(Number($("#examTerm").value || 1));
  return state.examTermProfiles.get(grade)?.[term] || null;
}

function updateExamTermControls() {
  const grade = Number($("#examGrade").value);
  const term = Number($("#examTerm").value || 1);
  const isExam = term === 2 || term === 4 || (term === 3 && grade === 12);
  $("#examType").value = isExam ? "exam" : "test";
  const term3 = $("#examTerm").querySelector('option[value="3"]');
  if (term3) term3.textContent = grade === 12 ? "Term 3 · Trial exam" : "Term 3 · Control test";
  const profile = selectedExamTermProfile();
  if (profile) {
    const papers = Number(profile.paper_count || 1);
    const paperMarks = Array.isArray(profile.paper_marks) ? profile.paper_marks : [];
    const duration = papers > 1 && paperMarks.length
      ? `${papers} papers · ${paperMarks.join(" + ")} marks · ${profile.paper_duration_minutes} minutes per paper (${profile.duration_minutes} minutes total)`
      : `${profile.duration_minutes} minutes`;
    $("#examTargetNote").textContent = `${profile.assessment_label}: target ${profile.total_marks} marks. ${duration}.`;
  } else {
    $("#examTargetNote").textContent = `${isExam ? "Examination" : "Control test"} · Grade ${grade} · Term ${term}. Load the topic list to check the target marks.`;
  }
  $("#examPaperSummary").hidden = true;
  $("#startExamSession").hidden = true;
  state.exam = null;
  updateExamGenerateButton();
}

function clearExamTopicSelections() {
  $("#examTopicChoices").querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
  updateExamGenerateButton();
}

async function loadExamTopics() {
  const grade = formatGrade($("#examGrade").value);
  updateExamTermControls();
  const host = $("#examTopicChoices");
  host.replaceChildren();
  $("#generateExam").disabled = true;
  setStatus($("#examStatus"), "Loading Grade " + grade + " topics from the question bank…");
  try {
    state.examTopics = await loadTopicCatalog(grade);
    updateExamTermControls();
    state.examTopics.forEach((topic) => {
      const card = document.createElement("fieldset");
      card.className = "topic-choice-card";
      const legend = document.createElement("legend");
      const heading = document.createElement("label");
      heading.className = "topic-choice-heading";
      const topicBox = document.createElement("input");
      topicBox.type = "checkbox";
      topicBox.dataset.topicChoice = topic.id;
      if (topic.availableMarks > 0) topicBox.dataset.availableMarks = String(topic.availableMarks);
      topicBox.checked = false;
      const title = document.createElement("span");
      title.textContent = topic.name + " · " + topic.count + " questions" + (topic.availableMarks ? ` · ${topic.availableMarks} bank marks` : "");
      heading.append(topicBox, title);
      legend.append(heading);
      card.append(legend);
      const subtopics = topic.subtopics || [];
      const choices = document.createElement("div");
      choices.className = "topic-subtopic-choices";
      subtopics.forEach((subtopic) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.subtopicChoice = String(subtopic.subtopic_id || subtopic.id || subtopic.subtopic || "");
        input.dataset.parentTopic = topic.id;
        if (Number(subtopic.available_marks || 0) > 0) input.dataset.availableMarks = String(Number(subtopic.available_marks));
        input.checked = false;
        const text = document.createElement("span");
        text.textContent = (subtopic.subtopic || subtopic.name || subtopic.subtopic_id)
          + (subtopic.question_count ? ` · ${subtopic.question_count} questions` : "")
          + (subtopic.available_marks ? ` · ${subtopic.available_marks} bank marks` : "");
        label.append(input, text);
        choices.append(label);
      });
      if (choices.childElementCount) {
        const details = document.createElement("details");
        details.className = "topic-subtopic-details";
        const summary = document.createElement("summary");
        summary.textContent = `Subtopics · ${choices.childElementCount}`;
        details.append(summary, choices);
        card.append(details);
      }
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
  renderExamPaperLinks();
  updateExamTermControls();
  loadExamTopics();
});
$("#examTerm").addEventListener("change", updateExamTermControls);

async function waitForUploadedPaperPreparation(startResult) {
  if (!startResult?.preparation_job_id) return startResult;
  const jobId = String(startResult.preparation_job_id);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20 * 60 * 1000) {
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
    const result = await getJson(`/api/education/guided-paper/preparation/${encodeURIComponent(jobId)}`);
    if (result.paper_id) return result;
    if (result.preparation_status === "failed") throw new Error(result.detail || result.message || "The paper and memo could not be prepared.");
    const completed = Number(result.completed_questions || 0);
    const total = Number(result.total_questions || 0);
    const progress = total ? ` ${completed} of ${total} questions checked.` : "";
    setStatus($("#examUploadStatus"), `${result.preparation_message || result.message || "Preparing paper and memo…"}${progress}`);
  }
  throw new Error("Paper preparation is taking longer than expected. Your upload is saved; try Start uploaded paper again in a little while.");
}

$("#startUploadedExam").addEventListener("click", async () => {
  if (!state.examPaperDocumentId) return;
  const button = $("#startUploadedExam");
  const mode = $("#examSessionMode").value === "strict" ? "strict" : "guided";
  button.disabled = true;
  try {
    if (!state.examInspectionId) throw new Error("Upload the question paper again so the app can reconnect to it.");
    setStatus($("#examUploadStatus"), mode === "strict"
      ? "Checking the question paper and memo for a Strict Mock Exam…"
      : "Preparing the uploaded paper for Guided Practice…");
    const started = await postJson("/api/education/guided-paper/start", {
      subject: "Mathematics",
      grade: formatGrade($("#examGrade").value),
      inspection_id: state.examInspectionId,
      title: state.examPaperFileName || "Uploaded Mathematics past paper",
      mode: mode === "strict" ? "exam" : "guided",
    });
    const prepared = await waitForUploadedPaperPreparation(started);
    if (!prepared.paper_id) throw new Error(prepared.detail || prepared.message || "The uploaded paper was not ready to start.");
    let session = await postJson("/api/education/exam-sessions", {
      paper_id: prepared.paper_id,
      mode,
      allow_pause: mode !== "strict",
      allow_back_navigation: true,
    });
    state.exam = {
      ...prepared,
      ...session,
      paper_title: prepared.title || state.examPaperFileName || "Uploaded Mathematics past paper",
      grade: formatGrade($("#examGrade").value),
      term: Number($("#examTerm").value || 1),
      assessment_type: $("#examType").value,
    };
    if (session.status === "not_started") {
      session = await postJson(`/api/education/exam-sessions/${encodeURIComponent(session.session_id)}/start`, {});
    }
    state.examSessionId = session.session_id;
    sessionStorage.setItem("sharperx_web_exam_session_id", state.examSessionId);
    $("#examResult").hidden = true;
    $("#examSetup").hidden = true;
    $("#examWorkspace").hidden = false;
    await renderExamSession(session);
  } catch (error) {
    setStatus($("#examUploadStatus"), error.message, "error");
  } finally {
    button.disabled = !state.examPaperDocumentId || ($("#examSessionMode").value === "strict" && !state.examMemoDocumentId);
  }
});

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
  const profile = selectedExamTermProfile();
  if (!profile) return setStatus($("#examStatus"), "The mark target for this grade and term is not available yet. Reload the topics and try again.", "error");
  const button = $("#generateExam");
  button.disabled = true;
  setStatus($("#examStatus"), "Building and checking your assessment…");
  try {
    const result = await postJson("/api/education/test-exam-preparation/generate?include_authored_support=false", {
      grade: formatGrade($("#examGrade").value),
      assessment_type: $("#examType").value,
      term: Number($("#examTerm").value),
      topic_scopes: scopes.filter((scope) => scope.subtopic_ids.length),
      topic_ids: scopes.filter((scope) => !scope.subtopic_ids.length).map((scope) => scope.topic_id),
    });
    const actualMarks = Number(result.total_marks || 0);
    const targetMarks = Number(result.target_total_marks || profile.total_marks);
    const tolerance = Number(result.total_marks_tolerance ?? profile.total_marks_tolerance ?? 2);
    if (Math.abs(actualMarks - targetMarks) > tolerance) {
      throw new Error(`The assessment service returned ${actualMarks} marks for a ${targetMarks}-mark target. The server needs the term-based CAPS assessment update before it can generate this paper.`);
    }
    state.exam = result;
    state.examSessionId = "";
    sessionStorage.removeItem("sharperx_web_exam_session_id");
    $("#examPaperSummary").hidden = false;
    const paperDescription = Number(result.paper_count || 1) > 1
      ? `${result.paper_count} papers (${(result.paper_marks || []).join(" + ")} marks, ${result.paper_duration_minutes} minutes each)`
      : "one paper";
    $("#examPaperSummary").textContent = `${result.title || "Assessment ready"} · ${(result.questions || []).length} questions · ${actualMarks} marks${actualMarks === targetMarks ? "" : ` (target ${targetMarks} ±${tolerance})`} · ${result.duration_minutes} minutes total · ${paperDescription}. The paper is ready.`;
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

function applyExamSessionToolRules(session) {
  const strict = String(session?.mode || "").toLowerCase() === "strict";
  const grade = Number(session?.grade || state.exam?.grade || $("#examGrade").value || 0);
  $("#examTutorTools").hidden = strict;
  if (strict) {
    realtimeTutor.stopIfContext("exam");
    $("#examLiveTutorPanel").hidden = true;
  }
  $("#examGuidanceButton").hidden = strict;
  $("#examGuidanceButton").disabled = strict;
  $("#examFormulaButton").hidden = strict && grade !== 12;
  $("#examFormulaText").hidden = true;
  $("#examVideoPreview").hidden = strict;
}

function renderExamAnswerAttachments(questionId = state.examCurrentQuestion?.id) {
  const host = $("#examAnswerAttachments");
  if (!host) return;
  host.replaceChildren();
  const attachments = state.examAnswerAttachments.get(questionId) || [];
  attachments.forEach((photoId, index) => {
    const item = document.createElement("span");
    item.className = "exam-answer-attachment";
    const label = document.createElement("span");
    label.textContent = `Photo ${index + 1} attached`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button subtle";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove handwritten photo ${index + 1}`);
    remove.addEventListener("click", () => {
      const updated = (state.examAnswerAttachments.get(questionId) || []).filter((id) => id !== photoId);
      state.examAnswerAttachments.set(questionId, updated);
      renderExamAnswerAttachments(questionId);
    });
    item.append(label, remove);
    host.append(item);
  });
}

async function requestExamFormulae() {
  const question = state.examCurrentQuestion;
  if (!question) return;
  const strict = String(state.exam?.mode || "").toLowerCase() === "strict";
  const grade = Number(state.exam?.grade || $("#examGrade").value || 0);
  if (strict && grade !== 12) return;
  const button = $("#examFormulaButton");
  const panel = $("#examFormulaText");
  button.disabled = true;
  panel.hidden = false;
  const authoredFormulas = [...(Array.isArray(question.relevant_formulas) ? question.relevant_formulas : [])]
    .concat(Array.isArray(question.formula_tags) ? question.formula_tags : [])
    .map((item) => typeof item === "string" ? item.trim() : String(item?.formula || item?.latex || item?.name || "").trim())
    .filter(Boolean);
  if (authoredFormulas.length && !state.examPaperDocumentId) {
    renderMath(panel, authoredFormulas.join("\n"));
    button.disabled = false;
    return;
  }
  panel.textContent = "Checking which formulae, theorem, or rule applies to this question…";
  try {
    if (state.examSessionId) {
      const result = await postJson(`/api/education/exam-sessions/${encodeURIComponent(state.examSessionId)}/guidance`, { action: "formula" });
      if (result.available === false) throw new Error(result.message || "Formula support is unavailable for this assessment.");
      requireTutorCompletion(result, "Relevant formulae");
      const supportText = result.guidance_latex || result.guidance || result.message || "No formula or theorem reference is needed for this question.";
      renderMath(panel, supportText);
      return;
    }
    const questionText = questionLabel(question);
    const visual = state.examVisuals.find((item) => item && (item.diagram || item.kind || item.accessibility_text)) || null;
    const result = await postJson("/api/education/tutor/ask", {
      subject: "Mathematics",
      grade,
      topic: question.topic || "Mathematics",
      question: questionText,
      mode: "question_hints",
      ai_tier: "luna",
      allow_web_search: false,
      requested_hint_level: 0,
      question_visual_reference: visual?.diagram || visual,
      app_context: {
        ...currentPageTutorContext(),
        page: "Test / exam prep",
        page_title: "Mathematics Test and Exam Prep",
        grade,
        subject: "Mathematics",
        topic: question.topic || "",
        current_question: questionText,
        assessment_type: state.exam?.assessment_type || $("#examType").value,
        assessment_term: state.exam?.term || Number($("#examTerm").value),
        assessment_mode: strict ? "strict_mock_exam" : "guided_practice",
        practice_hint_level: "formula",
        formula_only: true,
      },
    });
    requireTutorCompletion(result, "Relevant formulae");
    const supportText = readTutorDisplayText(result) || readTutorText(result);
    renderMath(panel, supportText || "No formula or theorem reference is needed for this question.");
  } catch (error) {
    panel.textContent = error.message || "The relevant formulae could not be checked. Please try again.";
  } finally {
    button.disabled = false;
  }
}

async function renderExamSourceSnapshot(question) {
  const figure = $("#examSourceSnapshot");
  const image = $("#examSourceSnapshotImage");
  const questionText = $("#examQuestionText");
  figure.hidden = true;
  image.removeAttribute("src");
  questionText.hidden = false;
  const inspectionId = state.examInspectionId || sessionStorage.getItem("sharperx_web_exam_inspection_id") || "";
  const documentId = state.examPaperDocumentId || sessionStorage.getItem("sharperx_web_exam_paper_id") || "";
  if (!inspectionId || !documentId) return;
  const number = String(question.question_number || question.display_label || "").trim().match(/\d{1,2}/)?.[0] || "";
  if (!/^\d{1,2}$/.test(number)) return;
  const cacheKey = `${documentId}:${number}`;
  try {
    let snapshot = examSnapshotCache.get(cacheKey);
    if (!snapshot) {
      snapshot = await postJson(`/api/inspections/${encodeURIComponent(inspectionId)}/question-snapshot`, {
        document_id: documentId,
        question_number: number,
      });
      examSnapshotCache.set(cacheKey, snapshot);
    }
    if (state.examCurrentQuestion !== question || !snapshot.image_png_base64) return;
    image.src = `data:image/png;base64,${snapshot.image_png_base64}`;
    image.alt = `Original paper image for Question ${number}`;
    const pages = Array.isArray(snapshot.page_numbers) ? snapshot.page_numbers.join(", ") : "";
    $("#examSourceSnapshotCaption").textContent = `Original paper · Question ${number}${pages ? ` · page${pages.includes(",") ? "s" : ""} ${pages}` : ""}`;
    image.onerror = () => {
      figure.hidden = true;
      questionText.hidden = false;
    };
    figure.hidden = false;
    questionText.hidden = true;
  } catch (error) {
    // The OCR question remains available if the PDF scan cannot be rendered.
    figure.hidden = true;
    questionText.hidden = false;
    setStatus($("#examPhotoStatus"), `The source snapshot could not be shown: ${error.message}`);
  }
}

async function renderExamSession(session) {
  state.exam = Object.assign(state.exam || {}, session);
  applyExamSessionToolRules(session);
  const question = session.current_question;
  if (!question) throw new Error("The current assessment question could not be loaded.");
  state.examQuestionIndex = Number(session.current_question_index || 0);
  state.examCurrentQuestion = question;
  $("#examProgress").textContent = (session.paper_title || "Assessment") + " · Question " + (state.examQuestionIndex + 1) + " of " + session.question_count;
  $("#examQuestionTitle").textContent = question.display_label || "Question " + (state.examQuestionIndex + 1);
  renderMath($("#examQuestionText"), question.question_text_latex || question.question_text || "");
  void renderExamSourceSnapshot(question);
  setMathEditorLatex("exam", question.answer && question.answer.answer_text || "");
  setMathKeyboardVisible(false, "exam");
  $("#examGuidanceText").hidden = true;
  $("#examGuidanceText").replaceChildren();
  $("#examFormulaText").hidden = true;
  $("#examFormulaText").replaceChildren();
  setStatus($("#examPhotoStatus"), "");
  renderExamAnswerAttachments(question.id);
  $("#examQuestionVisuals").replaceChildren();
  if (session.mode === "strict") {
    $("#examVideoPreview").replaceChildren();
    $("#examVideoPreview").hidden = true;
  } else void loadQuestionVideoPreview(question, "exam");
  $("#examFullScreen").hidden = true;
  $("#previousExamQuestion").disabled = state.examQuestionIndex <= 0;
  $("#nextExamQuestion").disabled = state.examQuestionIndex >= session.question_count - 1;
  $("#examGuidanceButton").disabled = session.mode === "strict";
  state.examVisuals = collectVisuals(question);
  if (!state.examPaperDocumentId && (question.bank_question_id || question.question_id || question.id || state.examVisuals.length)) {
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
    answer_text: getMathEditorLatex("exam"),
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
  if (String(state.exam?.mode || "").toLowerCase() === "strict") return;
  realtimeTutor.prepareSpeechFromGesture();
  try {
    const result = await postJson("/api/education/exam-sessions/" + encodeURIComponent(state.examSessionId) + "/guidance", { action: "explain" });
    requireTutorCompletion(result, "Assessment guidance");
    const panel = $("#examGuidanceText");
    panel.hidden = false;
    const guidance = result.guidance_latex || result.guidance || result.message || "Identify the information given and what the question asks you to find.";
    renderMath(panel, guidance);
    narrateTutorPage("exam", `Assessment hint. ${guidance}`);
  } catch (error) { showToast(error.message); }
});
$("#examFormulaButton").addEventListener("click", () => { void requestExamFormulae(); });
$("#examCanvasButton").addEventListener("click", () => openCanvas("exam", state.examCurrentQuestion));
$("#examGraphCanvasButton").addEventListener("click", () => openCanvas("exam-graph", state.examCurrentQuestion));
$("#examUploadPhotoButton").addEventListener("click", () => $("#examHandwritingInput").click());
$("#examHandwritingInput").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file) return;
  const question = state.examCurrentQuestion;
  if (!question || !state.examSessionId) return setStatus($("#examPhotoStatus"), "Start an assessment before attaching working.", "error");
  if (!file.type.startsWith("image/")) return setStatus($("#examPhotoStatus"), "Choose an image of your handwritten working.", "error");
  if ((state.examAnswerAttachments.get(question.id) || []).length >= 12) return setStatus($("#examPhotoStatus"), "The limit is 12 handwritten photos for one question.", "error");
  try {
    setStatus($("#examPhotoStatus"), `Uploading ${file.name}…`);
    const inspectionId = await ensureInspection("exam");
    const form = new FormData();
    form.set("photo_type", "school_answer_working");
    form.set("photo", file, file.name);
    const uploaded = await uploadForm(`/api/inspections/${encodeURIComponent(inspectionId)}/upload-photo`, form);
    const photoId = String(uploaded.id || uploaded.photo_id || "");
    if (!photoId) throw new Error("The handwritten photo was not attached. Please try again.");
    const existing = state.examAnswerAttachments.get(question.id) || [];
    state.examAnswerAttachments.set(question.id, [...new Set(existing.concat(photoId))].slice(0, 12));
    renderExamAnswerAttachments(question.id);
    setStatus($("#examPhotoStatus"), "Handwritten working attached to this question.", "success");
  } catch (error) {
    setStatus($("#examPhotoStatus"), error.message || "The handwritten photo could not be uploaded.", "error");
  }
});
$("#examFullScreen").addEventListener("click", () => {
  const image = $("#examQuestionVisuals img");
  if (image) openImageViewer(image.src, image.alt || "Assessment diagram");
});
$("#submitExam").addEventListener("click", async () => {
  if (!state.examSessionId || !window.confirm("Submit and mark this assessment now? You will not be able to change your answers afterwards.")) return;
  const strict = String(state.exam?.mode || "").toLowerCase() === "strict";
  if (!strict) realtimeTutor.prepareSpeechFromGesture();
  const button = $("#submitExam");
  button.disabled = true;
  try {
    await saveExamAnswer();
    const result = await postJson("/api/education/exam-sessions/" + encodeURIComponent(state.examSessionId) + "/submit", {});
    requireTutorCompletion(result, "Assessment marking");
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
    const narration = (result.questions || []).map((item) => [
      item.display_label || item.question_number || "Question",
      item.feedback || "",
      item.correct_method || item.solution || item.worked_solution || "",
      Array.isArray(item.steps) ? item.steps.map((step) => typeof step === "string" ? step : step.feedback || step.expected || "").filter(Boolean).join("\n") : "",
    ].filter(Boolean).join("\n\n")).join("\n\n");
    renderMath(body, detail);
    const answerVisuals = (result.questions || []).flatMap((item) =>
      (Array.isArray(item.solution_visuals) ? item.solution_visuals : []).map((visual) => ({
        item,
        visual,
      })));
    const answerVisualPanels = answerVisuals.map(({ item, visual }) => {
      const section = document.createElement("section");
      section.className = "exam-answer-visual";
      const heading = document.createElement("h3");
      heading.textContent = `${item.display_label || item.question_number || "Question"} worked answer diagram`;
      const images = document.createElement("div");
      images.className = "question-visuals answer-visuals";
      renderQuestionVisuals(images, [visual], heading.textContent, item.question_text_latex || item.question_text || "");
      section.append(heading, images);
      return section;
    });
    const save = document.createElement("button");
    save.className = "button secondary";
    save.type = "button";
    save.textContent = "Save PDF report";
    save.addEventListener("click", () => saveReport("Assessment marking", "Score " + result.total_awarded_marks + " / " + result.total_marks, detail));
    panel.append(title, body, ...answerVisualPanels, save);
    if (!strict) narrateTutorPage("exam", `Assessment marked. You scored ${result.total_awarded_marks} out of ${result.total_marks}, or ${result.percentage} percent. ${narration}`);
    sessionStorage.removeItem("sharperx_web_exam_session_id");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

function clearLessonPlayer() {
  state.lessonVideoRequestId += 1;
  state.lessonVideoController?.abort();
  state.lessonVideoController = null;
  const player = $("#lessonPlayer");
  player.replaceChildren();
  player.hidden = true;
}

function lessonSubtopicName(subtopic) {
  return String(subtopic?.subtopic || subtopic?.name || subtopic?.title || subtopic?.subtopic_id || subtopic?.id || "");
}

function lessonSubtopicId(subtopic) {
  return String(subtopic?.video_unit_id || subtopic?.unit_id || subtopic?.lesson_video_id || subtopic?.video_lesson_id || subtopic?.lesson_id || subtopic?.video_id || subtopic?.subtopic_id || subtopic?.id || lessonSubtopicName(subtopic));
}

function lessonSubtopicValue(subtopic) {
  return String(subtopic?.subtopic_id || subtopic?.id || subtopic?.lesson_id || subtopic?.video_unit_id || subtopic?.unit_id || subtopic?.video_id || lessonSubtopicName(subtopic));
}

async function loadLessons({ force = false } = {}) {
  const grade = formatGrade($("#lessonGrade").value || state.grade);
  const topicSelect = $("#lessonTopic");
  const subtopicSelect = $("#lessonSubtopic");
  if (!force && state.lessonTopicGrade === grade && state.lessonTopics.length) return;

  clearLessonPlayer();
  const selectionRequestId = ++state.lessonSelectionRequestId;
  state.lessonTopicGrade = grade;
  state.lessonTopics = [];
  state.lessonSubtopics = [];
  replaceOptions(topicSelect, [], "Loading topics…");
  replaceOptions(subtopicSelect, [], "Choose a topic first");
  setStatus($("#lessonStatus"), "Loading Grade " + grade + " topics…");
  try {
    const result = await getJson(`/api/lesson-videos/mathematics/topics?grade=${grade}`);
    const topics = (Array.isArray(result.topics) ? result.topics : []).map((topic) => ({
      id: String(topic.id || ""),
      name: String(topic.name || topic.topic || topic.id || ""),
      videoCount: Number(topic.video_count || 0),
    })).filter((topic) => topic.id && topic.name && topic.videoCount > 0);
    if (selectionRequestId !== state.lessonSelectionRequestId || grade !== formatGrade($("#lessonGrade").value)) return;
    state.lessonTopics = topics;
    replaceOptions(topicSelect, topics.map((topic) => ({ label: topic.name, value: topic.id })), "Select a topic");
    const preferredTopicId = String(topicSelect.dataset.lastTopicId || "");
    if (preferredTopicId && topics.some((topic) => String(topic.id) === String(preferredTopicId))) {
      topicSelect.value = String(preferredTopicId);
      await loadLessonSubtopics(grade, preferredTopicId);
    } else {
      setStatus($("#lessonStatus"), topics.length
        ? "Choose a topic, then select a lesson video. Only the selected video will load."
        : "No lesson videos are available for Grade " + grade + ".", topics.length ? "" : "error");
    }
  } catch (error) {
    if (selectionRequestId === state.lessonSelectionRequestId) setStatus($("#lessonStatus"), error.message, "error");
  }
}

async function loadLessonSubtopics(grade, topicId) {
  clearLessonPlayer();
  const selectionRequestId = ++state.lessonSelectionRequestId;
  const topicSelect = $("#lessonTopic");
  const subtopicSelect = $("#lessonSubtopic");
  state.lessonSubtopics = [];
  replaceOptions(subtopicSelect, [], topicId ? "Loading lesson videos…" : "Choose a topic first");
  if (!topicId) {
    setStatus($("#lessonStatus"), "Choose a topic, then select a lesson video.");
    return;
  }
  const topic = state.lessonTopics.find((item) => String(item.id) === String(topicId));
  topicSelect.dataset.lastTopicId = String(topicId);
  setStatus($("#lessonStatus"), "Loading lesson videos for " + (topic?.name || "this topic") + "…");
  try {
    const result = await getJson(`/api/lesson-videos/mathematics/catalog?grade=${formatGrade(grade)}&topic_id=${encodeURIComponent(topicId)}`);
    if (selectionRequestId !== state.lessonSelectionRequestId || topicSelect.value !== String(topicId) || grade !== formatGrade($("#lessonGrade").value)) return;
    const selectedTopic = (Array.isArray(result.topics) ? result.topics : []).find((item) => String(item.id) === String(topicId));
    state.lessonSubtopics = Array.isArray(selectedTopic?.lessons) ? selectedTopic.lessons : [];
    replaceOptions(subtopicSelect, state.lessonSubtopics.map((item) => ({ label: lessonSubtopicName(item), value: lessonSubtopicValue(item) })), "Select a lesson video");
    setStatus($("#lessonStatus"), state.lessonSubtopics.length
      ? "Choose a lesson video. Only the selected video will be loaded."
      : "No playable lesson videos are linked to this topic.", state.lessonSubtopics.length ? "" : "error");
  } catch (error) {
    if (selectionRequestId === state.lessonSelectionRequestId) {
      replaceOptions(subtopicSelect, [], "Lesson videos could not be loaded");
      setStatus($("#lessonStatus"), error.message, "error");
    }
  }
}

function lessonPlaybackSource(video) {
  const playbackUrl = String(video?.playback_url || video?.url || "");
  if (!playbackUrl) throw new Error("No lesson video is available for this subtopic yet.");
  const base = playbackUrl.startsWith("/api/") ? API_BASE_URL : window.location.href;
  const url = new URL(playbackUrl, base);
  const pathVideoId = url.pathname.match(/\/(?:play|stream)\/([^/]+)\/?$/)?.[1] || "";
  const videoId = String(video.video_id || video.asset_id || url.searchParams.get("video_id") || pathVideoId || "");
  const token = String(video.token || video.playback_token || url.searchParams.get("token") || "");
  if (videoId && token) {
    const streamUrl = new URL(`/api/lesson-videos/stream/${encodeURIComponent(videoId)}`, API_BASE_URL);
    streamUrl.searchParams.set("token", token);
    return { type: "video", url: streamUrl.href };
  }
  return { type: "embed", url: url.href };
}

async function playLessonVideo(grade, topic, lesson, { retryCount = 0, resumeAt = 0, resumePlayback = false } = {}) {
  if (!topic || !lesson) return;
  state.lessonVideoController?.abort();
  const controller = new AbortController();
  state.lessonVideoController = controller;
  const requestId = ++state.lessonVideoRequestId;
  const params = new URLSearchParams({
    grade: String(grade),
    topic: topic.name || topic.topic || "Mathematics",
    subtopic: lessonSubtopicName(lesson) || "Lesson",
    unit_id: lessonSubtopicId(lesson),
  });
  setStatus($("#lessonStatus"), retryCount ? "Refreshing the lesson connection…" : "Loading the selected lesson video…");
  try {
    const result = await getJson("/api/lesson-videos/mathematics/video?" + params, { signal: controller.signal });
    if (requestId !== state.lessonVideoRequestId) return;
    const video = result.video || {};
    const source = lessonPlaybackSource(video);
    const player = $("#lessonPlayer");
    player.replaceChildren();
    const heading = document.createElement("h2");
    const videoTitle = video.title || lessonSubtopicName(lesson) || "Mathematics lesson";
    renderMath(heading, videoTitle);
    if (source.type === "video") {
      const media = document.createElement("video");
      media.controls = true;
      media.playsInline = true;
      media.preload = "metadata";
      media.setAttribute("aria-label", videoTitle);
      let retryScheduled = false;
      let stallTimer = 0;
      const refreshPlayback = () => {
        if (requestId !== state.lessonVideoRequestId || !player.contains(media)) return;
        if (retryScheduled || retryCount >= 2) {
          setStatus($("#lessonStatus"), "This video could not resume. Select the subtopic to try again.", "error");
          return;
        }
        retryScheduled = true;
        clearTimeout(stallTimer);
        const currentTime = Number(media.currentTime) || 0;
        const wasPlaying = !media.paused || media.ended;
        setStatus($("#lessonStatus"), "The video stream paused. Refreshing its playback link…");
        window.setTimeout(() => {
          void playLessonVideo(grade, topic, lesson, { retryCount: retryCount + 1, resumeAt: currentTime, resumePlayback: wasPlaying });
        }, 500);
      };
      media.addEventListener("error", refreshPlayback);
      media.addEventListener("playing", () => {
        clearTimeout(stallTimer);
        stallTimer = 0;
      });
      media.addEventListener("waiting", () => {
        if (!media.currentTime || media.paused) return;
        clearTimeout(stallTimer);
        stallTimer = window.setTimeout(() => {
          if (!media.paused && !media.ended) refreshPlayback();
        }, 8_000);
      });
      media.addEventListener("timeupdate", () => {
        if (stallTimer && !media.paused) {
          clearTimeout(stallTimer);
          stallTimer = 0;
        }
      });
      media.addEventListener("ended", () => {
        if (Number.isFinite(media.duration) && media.duration > 4 && media.currentTime < media.duration - 1) refreshPlayback();
      });
      media.addEventListener("loadedmetadata", () => {
        if (resumeAt > 0 && Number.isFinite(media.duration)) media.currentTime = Math.min(resumeAt, Math.max(0, media.duration - 0.25));
        if (resumePlayback) void media.play().catch(() => {});
      }, { once: true });
      media.src = source.url;
      player.append(heading, media);
    } else {
      const frame = document.createElement("iframe");
      frame.title = videoTitle;
      frame.src = source.url;
      frame.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media";
      frame.allowFullscreen = true;
      frame.loading = "eager";
      player.append(heading, frame);
    }
    player.hidden = false;
    player.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus($("#lessonStatus"), "Loaded: " + videoTitle, "success");
  } catch (error) {
    if (error?.name === "AbortError" || requestId !== state.lessonVideoRequestId) return;
    setStatus($("#lessonStatus"), error?.status === 404
      ? "No lesson video is linked to this subtopic yet."
      : error.message, "error");
  }
}

$("#lessonGrade").addEventListener("change", () => {
  $("#globalGrade").value = $("#lessonGrade").value;
  $("#practiceGrade").value = $("#lessonGrade").value;
  $("#examGrade").value = $("#lessonGrade").value;
  state.grade = formatGrade($("#lessonGrade").value);
  sessionStorage.setItem("sharperx_web_grade", String(state.grade));
  state.lessonTopics = [];
  state.lessonSubtopics = [];
  state.lessonTopicGrade = "";
  renderSourceLinks();
  renderExamPaperLinks();
  void loadLessons({ force: true });
});

$("#lessonTopic").addEventListener("change", (event) => {
  void loadLessonSubtopics(formatGrade($("#lessonGrade").value), event.currentTarget.value);
});

$("#lessonSubtopic").addEventListener("change", (event) => {
  const topic = state.lessonTopics.find((item) => String(item.id) === $("#lessonTopic").value);
  const subtopic = state.lessonSubtopics.find((item) => lessonSubtopicValue(item) === event.currentTarget.value);
  clearLessonPlayer();
  if (topic && subtopic) void playLessonVideo(formatGrade($("#lessonGrade").value), topic, subtopic);
  else setStatus($("#lessonStatus"), "Choose a topic and subtopic to load one lesson video.");
});
renderSourceLinks();
void renderExamPaperLinks();
updateUploadedExamStatus();

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
  const editorName = Object.entries(mathEditorFrames).find(([, candidate]) => candidate === target)?.[0] || "";
  const frame = Boolean(editorName);
  let editable = null;
  if (frame) {
    deviceRemoteTargetFrame = mathEditorFrames[editorName];
  } else {
    deviceRemoteTargetFrame = null;
    editable = target instanceof HTMLElement ? target : null;
  }
  const type = String(editable?.type || "").toLowerCase();
  const password = type === "password";
  const isTextField = editable && ((editable.matches("input, textarea") && !["checkbox", "radio", "button", "submit", "reset", "file", "color", "range", "hidden"].includes(type)) || editable.isContentEditable);
  const keyboard = Boolean(frame || (isTextField && !password));
  const value = password ? "" : frame ? getMathEditorLatex(editorName).slice(0, 4000) : isTextField && "value" in editable ? String(editable.value || "").slice(0, 4000) : "";
  const label = frame ? `${editorName === "voiceMath" ? "voice maths" : editorName === "canvasMath" ? "recognized maths" : editorName} editor` : editable?.getAttribute("aria-label") || editable?.getAttribute("placeholder") || editable?.name || editable?.id || (editable?.tagName === "TEXTAREA" ? "answer box" : "selected control");
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
  const targetName = Object.entries(mathEditorFrames).find(([, frame]) => frame === deviceRemoteTargetFrame || frame === document.activeElement)?.[0];
  if (targetName) return getMathEditor(targetName);
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
  const editorName = Object.entries(mathEditorFrames).find(([, frame]) => frame === outer)?.[0];
  if (editorName) {
    try {
      const frame = mathEditorFrames[editorName];
      const rect = frame.getBoundingClientRect();
      const doc = frame.contentDocument;
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
let phoneCanvasRemoteOrigin = "";
let phoneCanvasConnected = false;
let phoneCanvasSubmissionSentUntil = 0;
let phoneCanvasHeartbeat = 0;
let phoneCanvasCloseTimer = 0;
let phoneCanvasReconnectTimer = 0;
let phoneCanvasReconnectAttempts = 0;
let phoneCanvasStableTimer = 0;

function canvasSupportsDirectInput() {
  const touchPoints = Number(navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0);
  return touchPoints > 0 || (window.matchMedia?.("(pointer: coarse)").matches && "ontouchstart" in window);
}

function canvasCanSelectWithMouse(event) {
  return event?.pointerType === "mouse" && phoneCanvasConnected && state.canvas?.stage === "regions";
}

function syncCanvasInputMode() {
  const phoneOnly = !canvasSupportsDirectInput() && !phoneCanvasConnected;
  const pairingPanelOpen = !$("#phoneCanvasPairPanel").hidden;
  $("#canvasDialog").classList.toggle("phone-pairing-required", phoneOnly);
  // The pairing panel already tells the learner how to connect. Keep the
  // canvas-only notice from covering the drawing area while that panel is open.
  $("#canvasPhoneOnlyNotice").hidden = !phoneOnly || pairingPanelOpen;
}

function phoneCanvasSetStatus(message, kind = "") {
  setStatus($("#phoneCanvasPairStatus"), message, kind);
}

async function copyPhoneCanvasPairServer() {
  const address = $("#phoneCanvasPairServerAddress").textContent.trim();
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    phoneCanvasSetStatus("Computer address copied. Paste it into the companion app.", "success");
  } catch {
    phoneCanvasSetStatus(`Computer address: ${address}`);
  }
}

function phoneCanvasSend(message) {
  if (phoneCanvasSocket?.readyState !== WebSocket.OPEN) return false;
  phoneCanvasSocket.send(JSON.stringify(message));
  return true;
}

function phoneCanvasRemoteUrl(sessionId, code) {
  const remoteUrl = phoneCanvasRemoteOrigin
    ? new URL("/app/canvas-remote.html", phoneCanvasRemoteOrigin)
    : new URL("./canvas-remote.html", location.href);
  remoteUrl.hash = new URLSearchParams({ session_id: sessionId, code }).toString();
  return remoteUrl;
}

async function resolvePhoneCanvasRemoteOrigin() {
  if (!isLocalIntranetPage()) return "";
  const hostname = location.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return location.origin;
  const response = await fetch(new URL("/api/local-network-info", location.origin), { cache: "no-store" });
  if (!response.ok) throw new Error("Could not find this computer’s Wi-Fi address for phone pairing.");
  const network = await response.json().catch(() => ({}));
  const address = Array.isArray(network.ipv4_addresses) ? network.ipv4_addresses[0] : "";
  if (!address) throw new Error("Connect this computer and phone to the same Wi-Fi, then try phone pairing again.");
  return `${location.protocol}//${address}${location.port ? `:${location.port}` : ""}`;
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
  syncCanvasInputMode();
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

function phoneCanvasPoint(point) {
  return {
    x: Number.isFinite(Number(point?.x)) ? Number(point.x) : 0,
    y: Number.isFinite(Number(point?.y)) ? Number(point.y) : 0,
  };
}

function setPhoneCanvasConnected(connected) {
  phoneCanvasConnected = connected;
  $("#phoneCanvasPairPanel").classList.toggle("is-connected", connected);
  syncCanvasInputMode();
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
  if (state.canvas.stage === "writing" && state.canvas.regions?.length) {
    state.canvas.regions.forEach(releaseCanvasRegionSnapshot);
    state.canvas.regions = [];
    renderCanvasRegionSnapshots();
  }
  state.canvas.revision = (state.canvas.revision || 0) + 1;
  state.canvas.transcribedPhoto = null;
  state.canvas.photoPromise = null;
  state.canvas.readingConfirmed = false;
  state.canvas.readingApplied = false;
  state.canvas.confirmedReading = null;
  const panel = $("#canvasTranscriptionPanel");
  if (panel) panel.hidden = true;
  const readingPanel = $("#canvasReadingReview");
  if (readingPanel && state.canvas.stage !== "regions") readingPanel.hidden = true;
  const readingResults = $("#canvasReadingResults");
  if (readingResults) readingResults.hidden = true;
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
    setPhoneCanvasConnected(true);
    phoneCanvasSetStatus("Phone connected. Draw on it and your work will appear here.", "success");
    const question = state.canvasQuestion;
    const questionText = question?.accessible_text || question?.question_text || question?.text || questionLabel(question || {});
    phoneCanvasSend({
      type: "setup",
      title: $("#canvasTitle").textContent,
      question: String(questionText || "").slice(0, 12_000),
      mode: state.canvas.mode,
      strokes: phoneCanvasSnapshot(),
      stage: state.canvas.stage,
      region_kind: state.canvas.regionKind,
      regions: (state.canvas.regions || []).map((region) => canvasRegionSetupPayload(region)),
    });
  } else if (message.type === "phone_disconnected") {
    setPhoneCanvasConnected(false);
    phoneCanvasSetStatus("Phone disconnected. Scan the code again to reconnect.", "error");
  } else if (message.type === "stroke_start") {
    if (message.tool === "region-kind") {
      if (state.canvas.stage === "regions" && ["words", "maths", "drawings"].includes(message.region_kind)) {
        state.canvas.regionKind = message.region_kind;
        updateCanvasStage();
      }
      return;
    }
    if (message.tool === "region") {
      if (state.canvas.stage !== "regions") return;
      invalidateCanvasTranscription();
      const first = phoneCanvasMapPoint(message.point, message.frame);
      const world = canvasRegionScreenToWorld(first);
      const sourcePoint = phoneCanvasPoint(message.point);
      state.canvas.draftRegion = {
        id: String(message.id || ""),
        kind: ["words", "maths", "drawings"].includes(message.region_kind) ? message.region_kind : state.canvas.regionKind,
        start: world,
        end: world,
        source: "phone",
        remoteBounds: { frame: message.frame, start: sourcePoint, end: sourcePoint },
      };
      drawCanvasRegionOverlay();
      return;
    }
    if (state.canvas.stage !== "writing") return;
    invalidateCanvasTranscription();
    const firstScreen = phoneCanvasMapPoint(message.point, message.frame);
    const first = canvasRegionScreenToWorld(firstScreen);
    state.canvas.strokes.push({
      id: String(message.id || ""),
      source: "phone",
      remoteFrame: message.frame,
      remoteWidth: Number(message.width) || 2.2,
      remotePoints: [message.point],
      points: [{ x: first.x, y: first.y }],
      color: message.tool === "eraser" ? "#fff" : "#162a29",
      tool: message.tool === "eraser" ? "eraser" : "pen",
      width: (Number(message.width) || 2.2) * firstScreen.scale,
    });
    drawCanvas();
  } else if (message.type === "stroke_points") {
    if (state.canvas.draftRegion?.id === String(message.id || "")) {
      if (state.canvas.stage !== "regions") return;
      if (Array.isArray(message.points) && message.points.length) {
        const point = phoneCanvasMapPoint(message.points[message.points.length - 1], message.frame);
        state.canvas.draftRegion.end = canvasRegionScreenToWorld(point);
        state.canvas.draftRegion.remoteBounds.end = phoneCanvasPoint(message.points[message.points.length - 1]);
        drawCanvasRegionOverlay();
      }
      return;
    }
    if (state.canvas.stage !== "writing") return;
    const stroke = [...state.canvas.strokes].reverse().find((item) => item.source === "phone" && item.id === String(message.id || ""));
    if (!stroke || !Array.isArray(message.points)) return;
    message.points.forEach((point) => {
      const mapped = phoneCanvasMapPoint(point, message.frame);
      stroke.remotePoints.push(point);
      stroke.points.push(canvasRegionScreenToWorld(mapped));
    });
    drawCanvas();
  } else if (message.type === "stroke_end") {
    if (state.canvas.draftRegion?.id === String(message.id || "")) {
      const draft = state.canvas.draftRegion;
      state.canvas.draftRegion = null;
      addCanvasRegion(draft.start, draft.end, draft.kind, draft.id, draft.remoteBounds);
      drawCanvasRegionOverlay();
      syncPhoneCanvasSetup();
    } else state.canvas.active = null;
  } else if (message.type === "undo") {
    const targetId = String(message.id || "");
    if (state.canvas.stage === "regions") {
      const index = state.canvas.regions.findIndex((region) => region.id === targetId);
      if (index >= 0) {
        releaseCanvasRegionSnapshot(state.canvas.regions[index]);
        state.canvas.regions.splice(index, 1);
        invalidateCanvasTranscription();
        renderCanvasRegionSnapshots();
      }
      drawCanvasRegionOverlay();
      syncPhoneCanvasSetup();
      return;
    }
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
    if (state.canvas.stage === "regions") {
      invalidateCanvasTranscription();
      state.canvas.regions.forEach(releaseCanvasRegionSnapshot);
      state.canvas.regions = [];
      state.canvas.draftRegion = null;
      renderCanvasRegionSnapshots();
      drawCanvasRegionOverlay();
      syncPhoneCanvasSetup();
      return;
    }
    invalidateCanvasTranscription();
    state.canvas.strokes = state.canvas.strokes.filter((stroke) => stroke.source !== "phone");
    drawCanvas();
  } else if (message.type === "submit") {
    if (state.canvas.stage === "writing" && state.canvas.mode === "graph") {
      if (!state.canvas.strokes.length) {
        const messageText = "Draw the graph before asking for a review.";
        setCanvasReadingStatus(messageText, "error");
        phoneCanvasSetStatus(messageText, "error");
        phoneCanvasSend({ type: "submission_error", message: messageText });
        return;
      }
      $("#canvasReadWritingButton").click();
      return;
    }
    if (state.canvas.stage === "writing" && state.canvas.mode !== "graph") {
      $("#canvasReadWritingButton").click();
      if (state.canvas.stage === "regions") {
        const messageText = "Choose Words, Maths, or Drawings, mark each area, then tap Transcribe.";
        phoneCanvasSetStatus(messageText);
        phoneCanvasSend({ type: "selection_ready", message: messageText });
      }
      return;
    }
    if (state.canvas.stage === "regions") {
      if (!state.canvas.regions.length) {
        const messageText = "Mark at least one area before transcribing.";
        phoneCanvasSetStatus(messageText, "error");
        phoneCanvasSend({ type: "submission_error", message: messageText });
        return;
      }
      const messageText = "Preparing your selected work for transcription…";
      phoneCanvasSetStatus(messageText);
      phoneCanvasSend({ type: "processing", message: messageText });
      $("#canvasReadWritingButton").click();
      return;
    }
    phoneCanvasSend({ type: "submission_error", message: "The canvas is not ready to transcribe. Return to the canvas and try again." });
  }
}

function stopPhoneCanvas({ notify = true } = {}) {
  clearTimeout(phoneCanvasCloseTimer);
  phoneCanvasCloseTimer = 0;
  clearTimeout(phoneCanvasReconnectTimer);
  phoneCanvasReconnectTimer = 0;
  clearTimeout(phoneCanvasStableTimer);
  phoneCanvasStableTimer = 0;
  phoneCanvasReconnectAttempts = 0;
  clearInterval(phoneCanvasHeartbeat);
  phoneCanvasHeartbeat = 0;
  if (notify) deviceRemoteSend({ type: "canvas_unavailable" });
  if (phoneCanvasSocket && phoneCanvasSocket.readyState < WebSocket.CLOSING) {
    if (notify) phoneCanvasSend({ type: "cancel" });
    phoneCanvasSocket.close();
  }
  phoneCanvasSocket = null;
  phoneCanvasSession = null;
  setPhoneCanvasConnected(false);
  phoneCanvasSubmissionSentUntil = 0;
  $("#phoneCanvasPairCode").textContent = "------";
  $("#phoneCanvasPairQr").replaceChildren();
  $("#usePhoneCanvas").setAttribute("aria-expanded", "false");
  $("#phoneCanvasPairPanel").hidden = true;
  syncCanvasInputMode();
  $("#usePhoneCanvas").disabled = false;
  phoneCanvasSetStatus("Phone connection closed.");
}

function connectPhoneCanvasSocket(session) {
  clearTimeout(phoneCanvasReconnectTimer);
  phoneCanvasReconnectTimer = 0;
  const button = $("#usePhoneCanvas");
  const socketUrl = pairingWebSocketUrl("canvas-pairing", session.session_id);
  socketUrl.searchParams.set("role", "host");
  const socket = new WebSocket(socketUrl);
  phoneCanvasSocket = socket;
  const isCurrentSocket = () => phoneCanvasSession === session && phoneCanvasSocket === socket;
  socket.addEventListener("open", () => {
    if (!isCurrentSocket()) return socket.close();
    socket.send(JSON.stringify({ type: "authenticate", token: session.host_token }));
    clearTimeout(phoneCanvasStableTimer);
    phoneCanvasStableTimer = window.setTimeout(() => {
      if (isCurrentSocket()) phoneCanvasReconnectAttempts = 0;
      phoneCanvasStableTimer = 0;
    }, 30_000);
    clearInterval(phoneCanvasHeartbeat);
    phoneCanvasHeartbeat = setInterval(() => phoneCanvasSend({ type: "ping" }), 30_000);
    phoneCanvasSetStatus(isLocalIntranetPage() ? "Waiting for your phone on this Wi-Fi…" : "Waiting for your phone…");
    button.disabled = false;
  });
  socket.addEventListener("message", (event) => {
    if (!isCurrentSocket()) return;
    try { applyPhoneCanvasMessage(JSON.parse(event.data)); } catch { /* Ignore malformed remote updates. */ }
  });
  socket.addEventListener("close", (event) => {
    if (!isCurrentSocket()) return;
    clearInterval(phoneCanvasHeartbeat);
    phoneCanvasHeartbeat = 0;
    clearTimeout(phoneCanvasStableTimer);
    phoneCanvasStableTimer = 0;
    phoneCanvasSocket = null;
    setPhoneCanvasConnected(false);
    button.disabled = false;
    // These close codes mean the session is invalid or another host socket
    // replaced this one. Retrying cannot restore it.
    if ([1008, 4001, 4002].includes(event.code)) {
      phoneCanvasSession = null;
      phoneCanvasSetStatus("The phone connection expired. Tap Use phone to create a new code.", "error");
      return;
    }
    if (phoneCanvasReconnectAttempts >= 12) {
      phoneCanvasSession = null;
      phoneCanvasSetStatus("Could not restore the phone connection. Tap Use phone to create a new code.", "error");
      return;
    }
    const delay = Math.min(10_000, 750 * (2 ** Math.min(phoneCanvasReconnectAttempts, 4)));
    phoneCanvasReconnectAttempts += 1;
    phoneCanvasSetStatus("Connection interrupted. Reconnecting to your phone…");
    phoneCanvasReconnectTimer = window.setTimeout(() => {
      phoneCanvasReconnectTimer = 0;
      if (phoneCanvasSession === session && !phoneCanvasSocket) connectPhoneCanvasSocket(session);
    }, delay);
  });
  socket.addEventListener("error", () => {
    if (isCurrentSocket()) phoneCanvasSetStatus("Phone connection interrupted. Reconnecting…");
  });
}

async function startPhoneCanvas() {
  if (state.canvas?.mode === "graph" && (!Number.isSafeInteger(state.canvas.graphFunctionCount) || state.canvas.graphFunctionCount < 1)) {
    setStatus($("#canvasGraphCountStatus"), "Enter a whole number greater than 0 before opening the phone canvas.", "error");
    $("#canvasGraphFunctionCount").focus({ preventScroll: true });
    return;
  }
  if (phoneCanvasSession) return;
  const button = $("#usePhoneCanvas");
  button.disabled = true;
  phoneCanvasSetStatus("Connecting…");
  try {
    phoneCanvasRemoteOrigin = await resolvePhoneCanvasRemoteOrigin();
    const session = await postPairingJson("canvas-pairing", "sessions");
    phoneCanvasSession = session;
    setPhoneCanvasConnected(false);
    $("#phoneCanvasPairCode").textContent = session.pairing_code;
    const pairingAddress = isLocalIntranetPage() ? (phoneCanvasRemoteOrigin || window.location.origin) : API_BASE_URL;
    $("#phoneCanvasPairServerAddress").textContent = pairingAddress;
    $("#phoneCanvasPairServerRow").hidden = !isLocalIntranetPage();
    const remoteUrl = phoneCanvasRemoteUrl(session.session_id, session.pairing_code);
    const remotePage = new URL(remoteUrl.href);
    remotePage.hash = "";
    $("#phoneCanvasRemoteLink").href = remotePage.href;
    $("#phoneCanvasRemoteLink").textContent = remotePage.host + remotePage.pathname;
    renderPhoneCanvasQr(remoteUrl.href);
    deviceRemoteSend({ type: "canvas_link", href: remoteUrl.href });

    phoneCanvasReconnectAttempts = 0;
    connectPhoneCanvasSocket(session);
  } catch (error) {
    phoneCanvasSetStatus(error.message || "Could not start a phone connection.", "error");
    phoneCanvasSession = null;
    setPhoneCanvasConnected(false);
    button.disabled = false;
  }
}

function openCanvas(mode, question) {
  if (phoneCanvasSession) stopPhoneCanvas();
  setPhoneCanvasConnected(false);
  $("#phoneCanvasPairPanel").hidden = true;
  $("#usePhoneCanvas").setAttribute("aria-expanded", "false");
  syncCanvasInputMode();
  state.canvasContext = mode;
  state.canvasQuestion = question || null;
  state.canvasReturnFocus = document.activeElement;
  const graphMode = mode.endsWith("graph");
  state.canvas = { mode: graphMode ? "graph" : "write", stage: graphMode ? "graph-setup" : "writing", graphFunctionCount: 0, regions: [], regionKind: "words", draftRegion: null, strokes: [], scale: 1, offsetX: 0, offsetY: 0, pan: false, zoom: false, eraser: false, revision: 0, transcribedPhoto: null, photoPromise: null, active: null, drag: null, pointers: new Map(), pinch: null, size: { width: 0, height: 0 }, writingViewport: null, readingConfirmed: false, readingApplied: false, confirmedReading: null, readingAlternatives: [], graphWorkflow: null, questionAwareGraph: Boolean(question) || mode.startsWith("practice") || mode.startsWith("exam") || (mode === "ask-graph" && Boolean(state.selectedPaperQuestion)) };
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
  $("#canvasReadWritingButton").textContent = graphMode ? "Review graph" : "Next";
  $("#canvasGraphCountPanel").hidden = !graphMode;
  $("#canvasGraphFunctionCount").value = "";
  setStatus($("#canvasGraphCountStatus"), "");
  $(".canvas-layout").hidden = graphMode;
  $("#canvasHelpText").hidden = graphMode;
  $("#canvasGraphStartButton").disabled = false;
  $$(".canvas-region-tool").forEach((item) => { item.hidden = true; item.setAttribute("aria-pressed", "false"); });
  $("#canvasBackWritingButton").hidden = true;
  $("#canvasReadWritingButton").hidden = graphMode;
  $("#canvasTranscriptionPanel").hidden = true;
  $("#canvasReadingReview").hidden = true;
  $("#canvasReadingResults").hidden = true;
  $("#canvasReadingWords").value = "";
  $("#canvasReadingAlternatives").replaceChildren();
  $("#canvasReadingAlternatives").hidden = true;
  $("#canvasReadingDrawing").value = "";
  $("#canvasReadingComment").value = "";
  $("#canvasReviewProgress").hidden = true;
  $("#canvasReadingStatus").dataset.loading = "false";
  $("#canvasReadingConfirm").disabled = true;
  $("#canvasReadingConfirm").textContent = "Confirm and use";
  $("#canvasReadingImageOnly").disabled = false;
  $("#canvasReadingImageOnly").hidden = false;
  $("#canvasGraphType").value = "";
  $("#canvasGraphType").disabled = false;
  $("#canvasGraphDetails").value = "";
  $("#canvasGraphDetails").disabled = false;
  $("#canvasGraphDetails").hidden = false;
  $("#canvasGraphEquationLabel").hidden = false;
  $("#canvasGraphReviewFields").hidden = !mode.endsWith("graph");
  $("#canvasGraphGuidedPanel").hidden = true;
  $("#canvasGraphPreviewPanel").hidden = true;
  $("#canvasGraphPreview").replaceChildren();
  $("#canvasGraphPreviewStatus").textContent = "";
  $("#canvasGraphPointHistory").replaceChildren();
  $("#canvasGraphPointInput").value = "";
  placeCanvasGraphConfirmButton(state.canvas);
  $("#finishCanvas").textContent = "Review and use";
  mathEditorCommand("canvasMath", { name: "clear" });
  setMathKeyboardVisible(false, "canvasMath");
  setStatus($("#canvasTranscriptionStatus"), "");
  const askPaperQuestion = (mode === "ask-write" || mode === "ask-graph") && state.selectedPaperQuestion;
  const hasQuestionSidebar = mode.startsWith("practice") || mode.startsWith("exam") || Boolean(askPaperQuestion);
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
    const visuals = mode.startsWith("practice") ? state.practiceVisuals : mode.startsWith("exam") ? state.examVisuals : [];
    const questionText = contextQuestion && (contextQuestion.question_text_latex || contextQuestion.accessible_text || contextQuestion.question_text || contextQuestion.text || questionLabel(contextQuestion));
    const source = askPaperQuestion ? state.paperPageImage : visuals && visuals.length ? diagramImageSource(visuals[0], questionText) : "";
    if (source) { image.src = source; image.hidden = false; }
  }
  if (!$("#canvasDialog").open) {
    document.documentElement.classList.add("canvas-dialog-open");
    document.body.classList.add("canvas-dialog-open");
    $("#canvasDialog").showModal();
  }
  syncCanvasInputMode();
  requestAnimationFrame(() => {
    resizeCanvas();
    drawCanvas();
    $("#workingCanvas").focus({ preventScroll: true });
  });
}

function updateCanvasStage() {
  const canvas = state.canvas;
  const selecting = canvas.stage === "regions";
  const graphSetup = canvas.stage === "graph-setup";
  const reviewPending = ["transcribing", "review"].includes(canvas.stage);
  $("#canvasDialog").classList.toggle("canvas-selecting-regions", selecting);
  $("#canvasGraphCountPanel").hidden = !graphSetup;
  $(".canvas-layout").hidden = graphSetup;
  $("#canvasHelpText").hidden = graphSetup || selecting || reviewPending;
  $$(".canvas-region-tool").forEach((button) => {
    button.hidden = !selecting;
    button.setAttribute("aria-pressed", String(button.dataset.canvasRegionKind === canvas.regionKind));
  });
  $("#canvasBackWritingButton").hidden = !selecting;
  $("#canvasReadWritingButton").hidden = selecting || ["graph-setup", "transcribing", "review"].includes(canvas.stage);
  $("#canvasReadWritingButton").textContent = canvas.mode === "graph" ? "Review graph" : "Next";
  if (selecting) $("#canvasHelpText").textContent = "Choose Words, Maths, or Drawings, then mark each area on the canvas. Select all the work you want reviewed.";
  else if (canvas.mode === "graph") $("#canvasHelpText").textContent = `Draw the graph with your phone or touch screen. The graph should contain ${canvas.graphFunctionCount} function${canvas.graphFunctionCount === 1 ? "" : "s"}.`;
  else $("#canvasHelpText").textContent = "Write or draw, select Next, then mark Words, Maths, or Drawings on this canvas before transcribing. On other devices, pair your phone.";
  const finishButton = $("#finishCanvas");
  finishButton.textContent = canvas.stage === "regions" ? "Transcribe"
    : canvas.stage === "transcribing" ? "Processing…"
      : canvas.stage === "review" && canvas.readingConfirmed ? "Add to answer"
        : canvas.stage === "review" && canvas.mode === "graph" && canvas.graphWorkflow ? "Continue graph review"
        : "Review and use";
  finishButton.disabled = canvas.stage === "transcribing" || canvas.graphWorkflow?.stage === "reconstructing";
  drawCanvas();
  syncPhoneCanvasSetup();
  requestAnimationFrame(resizeCanvas);
}

function enterCanvasRegionSelection() {
  const canvas = state.canvas;
  if (!canvas || canvas.mode === "graph") return;
  canvas.writingViewport = { scale: canvas.scale, offsetX: canvas.offsetX, offsetY: canvas.offsetY };
  canvas.stage = "regions";
  canvas.regionKind = "words";
  fitCanvasToWriting();
  $("#canvasReadingReview").hidden = false;
  $("#canvasReadingResults").hidden = true;
  renderCanvasRegionSnapshots();
  setCanvasReadingStatus("Choose Words, Maths, or Drawings, then mark each area on the computer canvas. Select all of the work you want transcribed.");
  updateCanvasStage();
}

function syncPhoneCanvasSetup() {
  if (!phoneCanvasConnected) return;
  const regions = (state.canvas.regions || []).map((region) => canvasRegionSetupPayload(region));
  phoneCanvasSend({ type: "setup", stage: state.canvas.stage, mode: state.canvas.mode, region_kind: state.canvas.regionKind, strokes: phoneCanvasSnapshot(), regions });
}

function canvasRegionSetupPayload(region) {
  const frame = region.remoteBounds?.frame;
  const start = region.remoteBounds?.start;
  const end = region.remoteBounds?.end;
  if (frame && start && end) {
    return {
      id: region.id,
      kind: region.kind,
      coordinate_space: "frame",
      frame,
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }
  const rect = workingCanvas.getBoundingClientRect();
  const screen = canvasRegionScreenRect(region);
  return {
    id: region.id,
    kind: region.kind,
    coordinate_space: "screen",
    x: screen.x / Math.max(1, rect.width),
    y: screen.y / Math.max(1, rect.height),
    width: screen.width / Math.max(1, rect.width),
    height: screen.height / Math.max(1, rect.height),
  };
}

function canvasRegionScreenRect(region) {
  const rect = workingCanvas.getBoundingClientRect();
  const saved = region.captureRect;
  const view = region.captureViewport;
  if (saved && view
    && Math.abs(view.scale - state.canvas.scale) < 1e-8
    && Math.abs(view.offsetX - state.canvas.offsetX) < 1e-6
    && Math.abs(view.offsetY - state.canvas.offsetY) < 1e-6
    && Math.abs(view.width - rect.width) < 1e-4
    && Math.abs(view.height - rect.height) < 1e-4) return saved;
  return canvasWorldRectToScreenRect(region, rect);
}

function canvasWorldRectToScreenRect(bounds, rect = workingCanvas.getBoundingClientRect()) {
  const x1 = (bounds.x - rect.width / 2) * state.canvas.scale + rect.width / 2 + state.canvas.offsetX;
  const y1 = (bounds.y - rect.height / 2) * state.canvas.scale + rect.height / 2 + state.canvas.offsetY;
  const x2 = (bounds.x + bounds.width - rect.width / 2) * state.canvas.scale + rect.width / 2 + state.canvas.offsetX;
  const y2 = (bounds.y + bounds.height - rect.height / 2) * state.canvas.scale + rect.height / 2 + state.canvas.offsetY;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function drawCanvasRegionOverlay() {
  const overlay = $("#canvasRegionOverlay");
  const rect = workingCanvas.getBoundingClientRect();
  if (!overlay || !rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  overlay.width = Math.round(rect.width * ratio);
  overlay.height = Math.round(rect.height * ratio);
  const context = overlay.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const colors = { words: "#0e5fae", maths: "#a04a0a", drawings: "#147a5a" };
  const draw = (region, draft = false) => {
    const bounds = draft
      ? { x: Math.min(region.start.x, region.end.x), y: Math.min(region.start.y, region.end.y), width: Math.abs(region.end.x - region.start.x), height: Math.abs(region.end.y - region.start.y) }
      : region;
    const screen = draft && region.screenStart && region.screenEnd
      ? canvasLocalRect(region.screenStart, region.screenEnd)
      : canvasRegionScreenRect(region);
    const { x, y, width, height } = screen;
    const color = colors[region.kind] || colors.words;
    context.save();
    context.fillStyle = `${color}18`;
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.setLineDash(draft ? [6, 4] : []);
    context.fillRect(x, y, width, height);
    context.strokeRect(x, y, width, height);
    context.setLineDash([]);
    context.font = "700 12px sans-serif";
    context.fillStyle = color;
    context.fillText(region.kind === "maths" ? "Maths" : region.kind === "drawings" ? "Drawing" : "Words", x + 5, Math.max(14, y - 5));
    context.restore();
  };
  (state.canvas.regions || []).forEach((region) => draw(region));
  if (state.canvas.draftRegion) draw(state.canvas.draftRegion, true);
}

function canvasLocalRect(start, end) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

function addCanvasRegion(start, end, kind = state.canvas.regionKind, id = "", remoteBounds = null, captureRect = null) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width * state.canvas.scale < 12 || height * state.canvas.scale < 12) {
    syncPhoneCanvasSetup();
    return false;
  }
  const rect = workingCanvas.getBoundingClientRect();
  const proposed = {
    id: id || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    kind, x, y, width, height, remoteBounds, captureRect,
    captureViewport: captureRect ? { scale: state.canvas.scale, offsetX: state.canvas.offsetX, offsetY: state.canvas.offsetY, width: rect.width, height: rect.height } : null,
  };
  const overlapsOtherKind = state.canvas.regions.some((region) => {
    if (region.kind === kind) return false;
    return Math.max(region.x, x) < Math.min(region.x + region.width, x + width)
      && Math.max(region.y, y) < Math.min(region.y + region.height, y + height);
  });
  if (overlapsOtherKind) {
    setStatus($("#canvasReadingStatus"), "Areas for different types of work cannot overlap. Move this box and try again.", "warning");
    syncPhoneCanvasSetup();
    return false;
  }
  state.canvas.regions.push(proposed);
  invalidateCanvasTranscription();
  drawCanvasRegionOverlay();
  renderCanvasRegionSnapshots();
  void captureCanvasRegionSnapshot(proposed).catch((error) => {
    if ((state.canvas?.regions || []).includes(proposed)) {
      setCanvasReadingStatus(error instanceof Error ? error.message : "The selected area could not be prepared.", "error");
      renderCanvasRegionSnapshots();
    }
  });
  syncPhoneCanvasSetup();
  return true;
}

function releaseCanvasRegionSnapshot(region) {
  if (region?.snapshotUrl) URL.revokeObjectURL(region.snapshotUrl);
  if (region) {
    region.snapshotUrl = "";
    region.snapshotBlob = null;
    region.snapshotPromise = null;
  }
}

function renderCanvasRegionSnapshots() {
  const list = $("#canvasRegionSnapshots");
  if (!list) return;
  const cards = list.querySelector(".canvas-region-snapshot-list");
  if (!cards) return;
  const regions = state.canvas?.regions || [];
  cards.replaceChildren();
  list.hidden = !regions.length;
  regions.forEach((region, index) => {
    const card = document.createElement("div");
    card.className = "canvas-region-snapshot";
    const label = document.createElement("div");
    label.className = "canvas-region-snapshot-label";
    const type = region.kind === "maths" ? "Maths" : region.kind === "drawings" ? "Drawing" : "Words";
    label.textContent = `${type} area ${index + 1}`;
    card.append(label);
    if (region.snapshotUrl) {
      const image = document.createElement("img");
      image.src = region.snapshotUrl;
      image.alt = `Captured ${type.toLowerCase()} area ${index + 1}`;
      card.append(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "canvas-region-snapshot-placeholder";
      placeholder.textContent = "Preparing selected area…";
      card.append(placeholder);
    }
    cards.append(card);
  });
}

async function captureCanvasRegionSnapshot(region) {
  if (!region) return null;
  if (region.snapshotBlob) return region.snapshotBlob;
  if (region.snapshotPromise) return region.snapshotPromise;
  const rect = workingCanvas.getBoundingClientRect();
  // Resolve the saved world-space box against the current canvas transform.
  // A cached screen rectangle becomes stale after browser zoom or resize.
  const screen = canvasRegionScreenRect(region);
  const scaleX = workingCanvas.width / Math.max(1, rect.width);
  const scaleY = workingCanvas.height / Math.max(1, rect.height);
  const left = Math.max(0, Math.min(workingCanvas.width, Math.floor(screen.x * scaleX)));
  const top = Math.max(0, Math.min(workingCanvas.height, Math.floor(screen.y * scaleY)));
  const right = Math.max(left, Math.min(workingCanvas.width, Math.ceil((screen.x + screen.width) * scaleX)));
  const bottom = Math.max(top, Math.min(workingCanvas.height, Math.ceil((screen.y + screen.height) * scaleY)));
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) throw new Error("The selected area is too small. Draw a larger box around the work.");
  const scale = Math.min(1, 2200 / Math.max(width, height));
  const crop = document.createElement("canvas");
  crop.width = Math.max(1, Math.round(width * scale));
  crop.height = Math.max(1, Math.round(height * scale));
  const context = crop.getContext("2d", { alpha: false });
  if (!context) throw new Error("The selected area could not be prepared.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, crop.width, crop.height);
  context.drawImage(workingCanvas, left, top, width, height, 0, 0, crop.width, crop.height);
  const snapshotPromise = new Promise((resolve, reject) => crop.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("The selected area could not be prepared.")),
    "image/jpeg",
    0.9,
  ));
  region.snapshotPromise = snapshotPromise;
  try {
    const blob = await snapshotPromise;
    if (!(state.canvas?.regions || []).includes(region)) return null;
    region.snapshotBlob = blob;
    region.snapshotUrl = URL.createObjectURL(blob);
    renderCanvasRegionSnapshots();
    return blob;
  } finally {
    if (region.snapshotPromise === snapshotPromise) region.snapshotPromise = null;
  }
}

function canvasRegionScreenToWorld(point) {
  const rect = workingCanvas.getBoundingClientRect();
  return { x: (point.x - rect.width / 2 - state.canvas.offsetX) / state.canvas.scale + rect.width / 2, y: (point.y - rect.height / 2 - state.canvas.offsetY) / state.canvas.scale + rect.height / 2 };
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
    // Keep all ink and selection boxes in one stable world coordinate system.
    // Re-project the view uniformly instead of rewriting every saved point;
    // rewriting points on each resize causes cumulative drift under browser zoom.
    const uniformScale = Math.min(rect.width / old.width, rect.height / old.height);
    const nextScale = state.canvas.scale * uniformScale;
    state.canvas.offsetX = uniformScale * state.canvas.offsetX + nextScale * (rect.width - old.width) / 2;
    state.canvas.offsetY = uniformScale * state.canvas.offsetY + nextScale * (rect.height - old.height) / 2;
    state.canvas.scale = nextScale;
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
  drawCanvasRegionOverlay();
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

async function ensureCanvasPhoto(canvas, revision, onProgress = null) {
  if (canvas.transcribedPhoto) return canvas.transcribedPhoto;
  if (canvas.photoPromise) return canvas.photoPromise;
  const photoPromise = (async () => {
    // Region selection already fits the writing before the learner marks an
    // area. Keep that viewport fixed so the captured preview and canvas remain
    // aligned while the selected image is being uploaded and read.
    if (canvas.mode === "graph") fitCanvasToWriting();
    onProgress?.("Preparing the canvas image…");
    // Canvas pixels are transparent outside the ink. Export on white so the
    // recognition service receives the same clear paper-like image a learner
    // would upload as a handwriting photo.
    const exportCanvas = document.createElement("canvas");
    const maxEdge = 2200;
    const scale = Math.min(1, maxEdge / Math.max(workingCanvas.width, workingCanvas.height));
    exportCanvas.width = Math.max(1, Math.round(workingCanvas.width * scale));
    exportCanvas.height = Math.max(1, Math.round(workingCanvas.height * scale));
    const exportContext = exportCanvas.getContext("2d", { alpha: false });
    if (!exportContext) throw new Error("The canvas image could not be created.");
    exportContext.fillStyle = "#ffffff";
    exportContext.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    exportContext.drawImage(workingCanvas, 0, 0, exportCanvas.width, exportCanvas.height);
    const blob = await new Promise((resolve, reject) => exportCanvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("The canvas image could not be created.")),
      "image/jpeg",
      0.9,
    ));
    assertCanvasSnapshotCurrent(canvas, revision);
    const file = new File([blob], "sharpertime-canvas-" + Date.now() + ".jpg", { type: "image/jpeg" });
    const uploadContext = (state.canvasContext || "").startsWith("practice") ? "practice" : (state.canvasContext || "").startsWith("exam") ? "exam" : "ask";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      onProgress?.("Saving the canvas image…");
      const inspectionId = await ensureInspection(uploadContext, { signal: controller.signal });
      assertCanvasSnapshotCurrent(canvas, revision);
      const form = new FormData();
      form.set("photo_type", "school_answer_working");
      form.set("photo", file, file.name);
      onProgress?.("Uploading the canvas image…");
      const uploaded = await uploadForm("/api/inspections/" + encodeURIComponent(inspectionId) + "/upload-photo", form, { signal: controller.signal });
      assertCanvasSnapshotCurrent(canvas, revision);
      const photoId = uploaded.id || uploaded.photo_id;
      if (!photoId) throw new Error("The canvas image could not be saved.");
      canvas.transcribedPhoto = { inspectionId, photoId, file, blob };
      return canvas.transcribedPhoto;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Saving the canvas image took too long. Check your connection and try again.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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

function setCanvasReadingStatus(message, kind = "", loading = false) {
  const status = $("#canvasReadingStatus");
  setStatus(status, message, kind);
  status.dataset.kind = kind;
  status.dataset.loading = String(loading);
  const progress = $("#canvasReviewProgress");
  if (progress) {
    progress.hidden = !loading;
    progress.setAttribute("aria-valuetext", message || "Processing canvas");
  }
  if (loading && phoneCanvasConnected) {
    phoneCanvasSetStatus(message || "Transcribing your selected work…");
    phoneCanvasSend({ type: "processing", message: message || "Transcribing your selected work…" });
  }
}

function currentCanvasQuestionText() {
  const question = state.canvasQuestion || ((state.canvasContext || "").startsWith("ask-") ? state.selectedPaperQuestion : null);
  return question?.question_text_latex || question?.accessible_text || question?.question_text || question?.text || "";
}

function canvasRegionNormalizedBounds(region) {
  const rect = workingCanvas.getBoundingClientRect();
  const screen = canvasRegionScreenRect(region);
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const left = clamp(screen.x / Math.max(1, rect.width));
  const top = clamp(screen.y / Math.max(1, rect.height));
  const right = clamp((screen.x + screen.width) / Math.max(1, rect.width));
  const bottom = clamp((screen.y + screen.height) / Math.max(1, rect.height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

async function uploadCanvasRegionCrop(photo, region, signal, revision) {
  assertCanvasSnapshotCurrent(state.canvas, revision);
  const blob = region.snapshotBlob || await captureCanvasRegionSnapshot(region);
  if (!blob) throw new Error("The selected image area is no longer available. Please select it again.");
  const file = new File([blob], "sharpertime-" + region.kind + "-" + Date.now() + ".jpg", { type: "image/jpeg" });
  const form = new FormData();
  form.set("photo_type", "school_answer_working");
  form.set("photo", file, file.name);
  const uploaded = await uploadForm(`/api/inspections/${encodeURIComponent(photo.inspectionId)}/upload-photo`, form, { signal });
  assertCanvasSnapshotCurrent(state.canvas, revision);
  const photoId = uploaded.id || uploaded.photo_id;
  if (!photoId) throw new Error("The selected area could not be saved.");
  return photoId;
}

function canvasRegionContext(kind, questionText, functionCount) {
  const instruction = kind === "words"
    ? "Read only the handwritten words in this selected area. Do not transcribe equations, solve, correct, or add content. For a genuinely uncertain handwritten word, include the best whole-word reading in the uncertainty's observed field and 2 to 5 plausible whole-word replacements in alternatives. Do not invent alternatives for clear words."
    : kind === "maths"
      ? "Recognize only the handwritten mathematical expressions in this selected area as editable LaTeX. Do not solve, correct, or add steps."
      : "Describe only the visible drawing, graph, shape or diagram in this selected area, including its labels and relationships. Do not solve the question or invent missing labels or coordinates.";
  return [
    `Handwriting canvas. ${instruction}`,
    "This step reads or describes the learner's work only. Do not provide an answer or mark the work.",
    functionCount ? `The learner expects ${functionCount} function${functionCount === 1 ? "" : "s"} in the graph.` : "",
    questionText ? `Current question (context only): ${questionText}` : "",
  ].filter(Boolean).join("\n");
}

async function reviewCanvasReading() {
  const canvas = state.canvas;
  const revision = canvas.revision;
  const button = canvas.mode !== "graph" && canvas.regions.length
    ? $("#finishCanvas")
    : $("#canvasReadWritingButton");
  const toolbarButtons = $$(".canvas-toolbar button:not([data-close-dialog])");
  const priorButtonStates = toolbarButtons.map((item) => [item, item.disabled]);
  if (!canvas.strokes.length) {
    setCanvasReadingStatus("Write or draw something on the canvas first.", "error");
    return;
  }
  const graphMode = canvas.mode === "graph";
  const regions = graphMode
    ? [{ id: "graph-sketch", kind: "drawings", x: 0, y: 0, width: workingCanvas.clientWidth, height: workingCanvas.clientHeight }]
    : canvas.regions.slice();
  if (!graphMode && !regions.length) {
    setCanvasReadingStatus("Mark at least one area first. Choose Words, Maths, or Drawings.", "error");
    return;
  }
  canvas.readingConfirmed = false;
  canvas.confirmedReading = null;
  toolbarButtons.forEach((item) => { item.disabled = true; });
  button.setAttribute("aria-busy", "true");
  const oldLabel = button.textContent;
  if (button.id !== "finishCanvas") button.textContent = "Reading…";
  $("#canvasReadingReview").hidden = false;
  $("#canvasReadingResults").hidden = true;
  $("#canvasTranscriptionPanel").hidden = true;
  $("#canvasReadingWords").value = "";
  $("#canvasReadingAlternatives").replaceChildren();
  $("#canvasReadingAlternatives").hidden = true;
  $("#canvasReadingDrawing").value = "";
  $("#canvasGraphType").value = "";
  $("#canvasGraphDetails").value = "";
  $("#canvasReadingComment").value = "";
  canvas.readingResult = null;
  canvas.readingPhoto = null;
  canvas.readingAlternatives = [];
  ["#canvasReadingWords", "#canvasReadingDrawing", "#canvasReadingComment", "#canvasGraphType", "#canvasGraphDetails"].forEach((selector) => {
    $(selector).disabled = true;
  });
  $("#canvasReadingConfirm").disabled = true;
  $("#canvasReadingImageOnly").disabled = true;
  $("#canvasReadingImageOnly").hidden = graphMode;
  setCanvasReadingStatus("Preparing your canvas…", "", true);
  try {
    const photo = await ensureCanvasPhoto(canvas, revision, (message) => setCanvasReadingStatus(message, "", true));
    canvas.readingPhoto = photo;
    assertCanvasSnapshotCurrent(canvas, revision);
    const questionText = currentCanvasQuestionText();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    const collected = { words: [], formulas: [], drawings: [], uncertainties: [], wordAlternatives: [], hasUncertainty: false };
    try {
      for (let index = 0; index < regions.length; index += 1) {
        const region = regions[index];
        const label = region.kind === "maths" ? "maths" : region.kind === "drawings" ? "drawing" : "words";
        setCanvasReadingStatus(`Reading ${label} area ${index + 1} of ${regions.length}…`, "", true);
        const bounds = graphMode
          ? { x: 0, y: 0, width: 1, height: 1 }
          : canvasRegionNormalizedBounds(region);
        if (!graphMode && (bounds.width < 0.002 || bounds.height < 0.002)) {
          throw new Error("A selected box is outside the visible canvas. Redraw it around the writing you want transcribed.");
        }
        const photoId = graphMode
          ? photo.photoId
          : await uploadCanvasRegionCrop(photo, region, controller.signal, revision);
        const requestBounds = { x: 0, y: 0, width: 1, height: 1 };
        assertCanvasSnapshotCurrent(canvas, revision);
        const result = await postJson("/api/education/photo/transcribe-math", {
          inspection_id: photo.inspectionId,
          photo_id: photoId,
          subject: "Mathematics",
          grade: Math.max(8, Math.min(12, Number(state.grade) || 12)),
          context: canvasRegionContext(region.kind, questionText, canvas.graphFunctionCount),
          // Read the selected snapshot with the vision transcriber in one pass.
          // Canvas transcription does not use the slower local formula service.
          ai_tier: "luna",
          math_regions: region.kind === "maths" ? [requestBounds] : [],
          drawing_regions: region.kind === "drawings" ? [requestBounds] : [],
        }, { signal: controller.signal });
        assertCanvasSnapshotCurrent(canvas, revision);
        const segments = Array.isArray(result.segments)
          ? result.segments.filter((segment) => segment && String(segment.type || "").toLowerCase() === "text").map((segment) => String(segment.content || "").trim()).filter(Boolean)
          : [];
        if (region.kind === "words") {
          const words = sanitizeLearnerFacingText(String(result.transcription || result.recognized_text || segments.join("\n")).trim());
          if (words) collected.words.push(words);
          if (Array.isArray(result.uncertainties)) {
            for (const item of result.uncertainties) {
              const observed = typeof item?.observed === "string" ? item.observed.trim() : "";
              const alternatives = Array.isArray(item?.alternatives) ? item.alternatives : [];
              for (const alternative of alternatives) {
                const candidate = typeof alternative === "string" ? sanitizeLearnerFacingText(alternative.trim()) : "";
                if (candidate && candidate !== observed) collected.wordAlternatives.push({ observed, alternative: candidate, regionText: words });
              }
            }
          }
          if (Array.isArray(result.transcription_alternatives || result.word_alternatives)) {
            const alternatives = result.transcription_alternatives || result.word_alternatives;
            for (const item of alternatives) {
              const candidate = typeof item === "string" ? item.trim() : String(item?.text || item?.content || "").trim();
              if (candidate && candidate !== words) collected.wordAlternatives.push({ observed: words, alternative: sanitizeLearnerFacingText(candidate), regionText: words });
            }
          }
        } else if (region.kind === "maths") {
          const formula = String(result.editable_latex || "").trim();
          if (formula) collected.formulas.push(formula);
        } else {
          const drawing = sanitizeLearnerFacingText(String(result.drawing_description || result.transcription || "").trim());
          if (drawing) collected.drawings.push(drawing);
        }
        if (Array.isArray(result.uncertainties)) collected.uncertainties.push(...result.uncertainties.map(formatCanvasUncertainty).filter(Boolean));
        collected.hasUncertainty ||= Boolean(result.has_uncertainty);
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("The review took too long. Your canvas is still here; please try again.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    assertCanvasSnapshotCurrent(canvas, revision);
    const recognizedText = collected.words.join("\n");
    $("#canvasReadingWords").value = recognizedText;
    canvas.readingAlternatives = collected.wordAlternatives.filter((choice, index, list) =>
      choice.alternative && list.findIndex((item) => item.observed === choice.observed && item.alternative === choice.alternative) === index,
    ).slice(0, 20);
    renderCanvasReadingAlternatives(canvas);
    const drawingDescription = collected.drawings.join("\n");
    $("#canvasReadingDrawing").value = drawingDescription;
    const graphType = drawingDescription.match(/\bGraph type\s*:\s*([^\n;,.]+)/i)?.[1]?.trim() || "";
    $("#canvasGraphType").value = graphMode ? graphType : "";
    $("#canvasGraphDetails").value = "";
    $("#canvasReadingComment").value = "";
    const recognizedFormula = collected.formulas.join("\\\\");
    setMathEditorLatex("canvasMath", recognizedFormula);
    const uncertainty = collected.uncertainties.slice(0, 5);
    const warning = collected.hasUncertainty || uncertainty.length
      ? uncertainty.length
        ? `Check the uncertain parts carefully: ${uncertainty.join(" · ")}`
        : "Some parts could not be read confidently. Check the reading before using it."
      : "Check the transcription and drawing description. Edit them, then confirm before use.";
    setCanvasReadingStatus(warning, collected.hasUncertainty || uncertainty.length ? "warning" : "success");
    if (recognizedFormula) {
      $("#canvasTranscriptionPanel").hidden = false;
      setCanvasTranscriptionLoading(false, "Check and edit the recognized maths before confirming.");
    }
    canvas.readingResult = collected;
    if (graphMode) {
      canvas.graphWorkflow = {
        stage: "confirm-type",
        functionCount: canvas.graphFunctionCount,
        functionIndex: 1,
        currentType: "",
        points: [],
        promptQueue: [],
        activePrompt: null,
        extraPointCount: 0,
        currentResult: null,
        functions: [],
      };
      $("#canvasGraphFunctionHeading").textContent = `Function 1 of ${canvas.graphFunctionCount}: confirm its type`;
      $("#canvasGraphGuidedStatus").textContent = "Confirm or correct the type for this function. You will then enter exact key values.";
      $("#canvasGraphPointPrompt").textContent = "Confirm the graph type above to begin collecting key points.";
      $("#canvasGraphPointHistory").replaceChildren();
      $("#canvasGraphPointInput").value = "";
      $("#canvasGraphGuidedPanel").hidden = false;
      $("#canvasGraphPreviewPanel").hidden = true;
      $("#canvasReadingConfirm").textContent = "Confirm type";
      $("#canvasGraphType").disabled = false;
      $("#canvasGraphDetails").disabled = canvas.questionAwareGraph;
      const equationLabel = $("#canvasGraphEquationLabel");
      if (equationLabel) equationLabel.hidden = canvas.questionAwareGraph;
      $("#canvasGraphDetails").hidden = canvas.questionAwareGraph;
    } else {
      $("#canvasGraphGuidedPanel").hidden = true;
      $("#canvasGraphPreviewPanel").hidden = true;
      $("#canvasReadingConfirm").textContent = "Confirm and use";
    }
    placeCanvasGraphConfirmButton(canvas);
    canvas.stage = "review";
    updateCanvasStage();
    if (phoneCanvasConnected) {
      const readyMessage = "Transcription is ready. Review and edit it on the computer, then confirm before attaching it.";
      phoneCanvasSetStatus(readyMessage, "success");
      phoneCanvasSend({ type: "review_ready", message: readyMessage });
    }
    $("#canvasReadingResults").hidden = false;
    $("#canvasReadingConfirm").disabled = false;
    $("#canvasReadingImageOnly").disabled = graphMode;
    mathEditorCommand("canvasMath", { name: "focus" });
    requestAnimationFrame(() => $("#canvasReadingReview").scrollIntoView({ behavior: "smooth", block: "start" }));
  } catch (error) {
    if (state.canvas === canvas) {
      $("#canvasReadingWords").value = "";
      $("#canvasReadingDrawing").value = "";
      const message = canvas.revision !== revision
        ? "The canvas changed while it was being reviewed. Press Transcribe again to process the latest writing."
        : error?.message?.startsWith("A selected box is outside")
          ? error.message
          : graphMode
            ? "We could not review the graph this time. Your drawing is still here; check your connection and try again."
            : "The selected areas could not be transcribed. Your writing and boxes are still here; check your connection and tap Transcribe to retry.";
      setCanvasReadingStatus(message, "error");
      canvas.readingResult = null;
      // A failed recognition request must return both the browser and paired
      // phone to an editable stage so the learner can retry without redrawing.
      canvas.stage = graphMode ? "writing" : "regions";
      updateCanvasStage();
      if (phoneCanvasConnected) {
        phoneCanvasSetStatus(message, "error");
        phoneCanvasSend({ type: "submission_error", message });
      }
    }
  } finally {
    if (state.canvas === canvas) {
      ["#canvasReadingWords", "#canvasReadingDrawing", "#canvasReadingComment", "#canvasGraphType", "#canvasGraphDetails"].forEach((selector) => {
        $(selector).disabled = false;
      });
      $("#canvasReadingConfirm").disabled = !canvas.readingResult;
      $("#canvasReadingImageOnly").disabled = canvas.mode === "graph";
    }
    priorButtonStates.forEach(([item, wasDisabled]) => { item.disabled = wasDisabled; });
    // The toolbar snapshot may have captured a disabled finish button from
    // the transcribing stage. Reapply the current stage after restoring it so
    // the completed review can be opened or attached.
    if (state.canvas === canvas) updateCanvasStage();
    button.removeAttribute("aria-busy");
    if (button.id !== "finishCanvas") button.textContent = oldLabel;
  }
}

function formatCanvasUncertainty(item) {
  if (typeof item === "string") return sanitizeLearnerFacingText(item);
  if (!item || typeof item !== "object") return "";
  if (Array.isArray(item)) return item.map(formatCanvasUncertainty).filter(Boolean).join("; ");

  const line = Number.isFinite(Number(item.line)) && Number(item.line) > 0 ? `Line ${Number(item.line)}: ` : "";
  const observed = typeof item.observed === "string" ? sanitizeLearnerFacingText(item.observed) : "";
  const note = [item.note, item.message, item.text, item.description, item.detail, item.reason]
    .find((value) => typeof value === "string" && value.trim());
  const safeNote = typeof note === "string" ? sanitizeLearnerFacingText(note) : "";
  const alternatives = Array.isArray(item.alternatives)
    ? item.alternatives.filter((value) => typeof value === "string" && value.trim()).map(sanitizeLearnerFacingText)
    : [];
  const details = [];
  if (safeNote) details.push(safeNote);
  if (observed && !safeNote.includes(observed)) details.push(`read as “${observed}”`);
  if (alternatives.length) details.push(`possible readings: ${alternatives.join(" / ")}`);
  if (!details.length) {
    const fallback = Object.entries(item)
      .filter(([, value]) => typeof value === "string" || typeof value === "number")
      .map(([key, value]) => `${key}: ${sanitizeLearnerFacingText(value)}`)
      .filter((value) => !/^line:\s*\d+$/i.test(value));
    details.push(...fallback);
  }
  return sanitizeLearnerFacingText(`${line}${details.join("; ")}`).slice(0, 300);
}

function renderCanvasReadingAlternatives(canvas) {
  const container = $("#canvasReadingAlternatives");
  container.replaceChildren();
  const choices = canvas.readingAlternatives || [];
  if (!choices.length) {
    container.hidden = true;
    return;
  }
  const label = document.createElement("span");
  label.className = "canvas-reading-alternatives-label";
  label.textContent = "Possible readings · select one to replace the uncertain word";
  container.append(label);
  choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "canvas-reading-alternative";
    button.dataset.readingAlternative = String(index);
    button.textContent = `Use “${choice.alternative}”`;
    button.setAttribute("aria-label", `Use alternative reading ${choice.alternative}`);
    container.append(button);
  });
  container.hidden = false;
}

$("#canvasReadingAlternatives").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reading-alternative]");
  if (!button) return;
  const choice = state.canvas?.readingAlternatives?.[Number(button.dataset.readingAlternative)];
  if (!choice) return;
  const field = $("#canvasReadingWords");
  const current = field.value;
  const observed = String(choice.observed || "").trim();
  if (observed && current.includes(observed)) {
    field.value = current.replace(observed, choice.alternative);
  } else if (choice.regionText && current.includes(choice.regionText)) {
    field.value = current.replace(choice.regionText, choice.alternative);
  } else if (current.trim() && state.canvas?.readingAlternatives?.length === 1) {
    field.value = choice.alternative;
  } else {
    setCanvasReadingStatus("That word has changed in the editor. You can select and replace it manually.", "warning");
    return;
  }
  setCanvasReadingStatus(`Possible reading selected: ${choice.alternative}. Check the full sentence before confirming.`);
});

function parseCanvasGraphExpression(equation) {
  let source = String(equation || "").trim().replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, "");
  if (!source) return null;
  const tokens = [];
  const tokenPattern = /\s*(?:((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)|([a-z][a-z0-9_]*)|([()+\-*/^]))/iy;
  let offset = 0;
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break;
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(source);
    if (!match) return null;
    offset = tokenPattern.lastIndex;
    if (match[1]) tokens.push({ type: "number", value: Number(match[1]) });
    else if (match[2]) tokens.push({ type: "name", value: match[2].toLowerCase() });
    else tokens.push({ type: match[3], value: match[3] });
  }
  let cursor = 0;
  const peek = () => tokens[cursor];
  const consume = (type) => {
    if (peek()?.type !== type) return false;
    cursor += 1;
    return true;
  };
  const functions = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs,
    exp: Math.exp, ln: Math.log, log: Math.log10, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  };
  const expression = () => {
    let left = term();
    while (peek()?.type === "+" || peek()?.type === "-") {
      const operator = tokens[cursor++].type;
      const right = term();
      const prior = left;
      left = (x) => operator === "+" ? prior(x) + right(x) : prior(x) - right(x);
    }
    return left;
  };
  const term = () => {
    let left = unary();
    while (peek()?.type === "*" || peek()?.type === "/") {
      const operator = tokens[cursor++].type;
      const right = unary();
      const prior = left;
      left = (x) => operator === "*" ? prior(x) * right(x) : prior(x) / right(x);
    }
    return left;
  };
  const unary = () => {
    if (consume("+")) return unary();
    if (consume("-")) { const value = unary(); return (x) => -value(x); }
    return power();
  };
  const power = () => {
    let left = primary();
    if (consume("^")) {
      const right = unary();
      const prior = left;
      left = (x) => Math.pow(prior(x), right(x));
    }
    return left;
  };
  const primary = () => {
    const token = peek();
    if (!token) throw new Error("Missing graph expression value");
    if (token.type === "number") { cursor += 1; return () => token.value; }
    if (token.type === "name") {
      cursor += 1;
      if (token.value === "x") return (x) => x;
      if (token.value === "pi") return () => Math.PI;
      if (token.value === "e") return () => Math.E;
      const fn = functions[token.value];
      if (!fn || !consume("(")) throw new Error("Unsupported graph expression");
      const argument = expression();
      if (!consume(")")) throw new Error("Unclosed graph expression");
      return (x) => fn(argument(x));
    }
    if (consume("(")) {
      const value = expression();
      if (!consume(")")) throw new Error("Unclosed graph expression");
      return value;
    }
    throw new Error("Unsupported graph expression");
  };
  try {
    const evaluate = expression();
    return cursor === tokens.length ? (x) => {
      const value = evaluate(x);
      return Number.isFinite(value) ? value : null;
    } : null;
  } catch { return null; }
}

function canvasGraphTickLabels(min, max, count = 6) {
  return Array.from({ length: count }, (_, index) => min + (max - min) * index / (count - 1));
}

function renderCanvasGraphPreview(functions) {
  const evaluators = functions.map((item) => item.result.circle ? null : parseCanvasGraphExpression(item.result.equation));
  if (!evaluators.length || evaluators.some((evaluate, index) => !evaluate && !functions[index].result.circle)) return "";
  const results = functions.map((item) => item.result);
  let xMin = Math.min(...results.map((item) => Number(item.x_min)));
  let xMax = Math.max(...results.map((item) => Number(item.x_max)));
  let yMin = Math.min(...results.map((item) => Number(item.y_min)));
  let yMax = Math.max(...results.map((item) => Number(item.y_max)));
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMax <= xMin || yMax <= yMin) return "";
  const width = 720; const height = 390;
  const plot = { left: 60, right: 690, top: 24, bottom: 340 };
  const mapX = (x) => plot.left + (x - xMin) / (xMax - xMin) * (plot.right - plot.left);
  const mapY = (y) => plot.bottom - (y - yMin) / (yMax - yMin) * (plot.bottom - plot.top);
  const xTicks = canvasGraphTickLabels(xMin, xMax);
  const yTicks = canvasGraphTickLabels(yMin, yMax);
  const colors = ["#0e5fae", "#168363", "#7c3aed", "#c2410c", "#be185d", "#475569", "#0891b2", "#4d7c0f"];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Reconstructed graph preview">`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<defs><clipPath id="canvas-graph-plot-clip"><rect x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/></clipPath></defs>`,
  ];
  xTicks.forEach((x) => {
    const px = mapX(x);
    parts.push(`<line x1="${px}" y1="${plot.top}" x2="${px}" y2="${plot.bottom}" stroke="#e5edf5"/>`);
    parts.push(`<text x="${px}" y="${plot.bottom + 20}" text-anchor="middle" font-size="11" fill="#52657a">${escapeHtml(Number(x.toPrecision(3)).toString())}</text>`);
  });
  yTicks.forEach((y) => {
    const py = mapY(y);
    parts.push(`<line x1="${plot.left}" y1="${py}" x2="${plot.right}" y2="${py}" stroke="#e5edf5"/>`);
    parts.push(`<text x="${plot.left - 8}" y="${py + 4}" text-anchor="end" font-size="11" fill="#52657a">${escapeHtml(Number(y.toPrecision(3)).toString())}</text>`);
  });
  const xAxisY = yMin <= 0 && yMax >= 0 ? mapY(0) : plot.bottom;
  const yAxisX = xMin <= 0 && xMax >= 0 ? mapX(0) : plot.left;
  parts.push(`<line x1="${plot.left}" y1="${xAxisY}" x2="${plot.right}" y2="${xAxisY}" stroke="#142d48" stroke-width="2"/>`);
  parts.push(`<line x1="${yAxisX}" y1="${plot.top}" x2="${yAxisX}" y2="${plot.bottom}" stroke="#142d48" stroke-width="2"/>`);
  parts.push(`<text x="${plot.right - 2}" y="${Math.min(height - 4, xAxisY + 17)}" text-anchor="end" font-size="13" fill="#142d48">x</text>`);
  parts.push(`<text x="${yAxisX + 7}" y="${plot.top + 13}" font-size="13" fill="#142d48">y</text>`);
  functions.forEach((item, functionIndex) => {
    const evaluate = evaluators[functionIndex];
    if (item.result.circle) {
      const { x: centerX, y: centerY, radius, semicircle } = item.result.circle;
      let path = "";
      const steps = semicircle ? 320 : 640;
      for (let sample = 0; sample <= steps; sample += 1) {
        const angle = (semicircle ? Math.PI : Math.PI * 2) * sample / steps;
        const x = centerX + radius * Math.cos(angle);
        const y = centerY + radius * Math.sin(angle);
        path += `${sample ? "L" : "M"}${mapX(x).toFixed(2)},${mapY(y).toFixed(2)} `;
      }
      if (path) parts.push(`<path d="${path.trim()}" fill="none" stroke="${colors[functionIndex % colors.length]}" stroke-width="3" stroke-linecap="round" clip-path="url(#canvas-graph-plot-clip)"/>`);
    } else if (evaluate) {
      let path = ""; let drawing = false; let previousY = null;
      const allowedY = (yMax - yMin) * 3;
      for (let sample = 0; sample <= 640; sample += 1) {
        const x = xMin + (xMax - xMin) * sample / 640;
        const y = evaluate(x);
        const visible = y !== null && y >= yMin - allowedY && y <= yMax + allowedY &&
          (previousY === null || Math.abs(y - previousY) < (yMax - yMin) * 0.7);
        if (visible) {
          path += `${drawing ? "L" : "M"}${mapX(x).toFixed(2)},${mapY(y).toFixed(2)} `;
          drawing = true;
          previousY = y;
        } else {
          drawing = false;
          previousY = null;
        }
      }
      if (path) parts.push(`<path d="${path.trim()}" fill="none" stroke="${colors[functionIndex % colors.length]}" stroke-width="3" stroke-linecap="round" clip-path="url(#canvas-graph-plot-clip)"/>`);
    }
    const points = Array.isArray(item.result.critical_points) ? item.result.critical_points : [];
    points.forEach((point) => {
      const x = Number(point.x); const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < xMin || x > xMax || y < yMin || y > yMax) return;
      const px = mapX(x); const py = mapY(y); const label = sanitizeLearnerFacingText(String(point.label || "")).slice(0, 64);
      parts.push(`<circle cx="${px}" cy="${py}" r="4.5" fill="#fff" stroke="${colors[functionIndex % colors.length]}" stroke-width="2.5"/>`);
      if (label) parts.push(`<text x="${px + 8}" y="${py - 8}" font-size="12" fill="#142d48">${escapeHtml(label)}</text>`);
    });
  });
  parts.push("</svg>");
  return parts.join("");
}

function canvasGraphInitialPrompts(graphType) {
  const type = String(graphType || "").toLowerCase();
  if (type.includes("circle")) return [
    { label: "Centre", prompt: "Enter the circle centre coordinates (x, y).", kind: "coordinate" },
    { label: "Radius", prompt: "Enter the positive circle radius.", kind: "scalar" },
  ];
  if (type.includes("parabola") || type.includes("quadratic")) return [
    { label: "Vertex", prompt: "Enter the vertex coordinates (x, y). Use exact values from the question or your working; do not estimate from an unscaled sketch.", kind: "coordinate" },
    { label: "Point on curve", prompt: "Enter one other known point on the curve (x, y).", kind: "coordinate" },
  ];
  if (type.includes("line") || type.includes("linear")) return [
    { label: "Point 1", prompt: "Enter the first known point on the line (x, y).", kind: "coordinate" },
    { label: "Point 2", prompt: "Enter a different known point on the line (x, y).", kind: "coordinate" },
  ];
  if (type.includes("cubic")) return [
    { label: "Inflection point", prompt: "Enter the cubic's point of inflection (x, y).", kind: "coordinate" },
    { label: "Point on curve 1", prompt: "Enter a known point on the curve, preferably a turning point (x, y).", kind: "coordinate" },
    { label: "Point on curve 2", prompt: "Enter a second distinct point on the curve (x, y).", kind: "coordinate" },
  ];
  if (type.includes("exponential")) return [
    { label: "Horizontal asymptote", prompt: "Enter the horizontal asymptote as y = c.", kind: "scalar" },
    { label: "Y-intercept", prompt: "Enter the y-intercept coordinates (x, y).", kind: "coordinate" },
    { label: "Point on curve", prompt: "Enter another known point on the curve (x, y).", kind: "coordinate" },
  ];
  if (type.includes("hyperbola") || type.includes("hyperbolic") || type.includes("reciprocal")) return [
    { label: "Vertical asymptote", prompt: "Enter the vertical asymptote as x = a.", kind: "scalar" },
    { label: "Horizontal asymptote", prompt: "Enter the horizontal asymptote as y = b.", kind: "scalar" },
    { label: "Point on curve", prompt: "Enter a known point on one branch (x, y).", kind: "coordinate" },
  ];
  if (type.includes("tangent")) return [
    { label: "Asymptote 1", prompt: "Enter the x-coordinate of the first vertical asymptote.", kind: "scalar" },
    { label: "Asymptote 2", prompt: "Enter the x-coordinate of the next vertical asymptote.", kind: "scalar" },
    { label: "Centre crossing", prompt: "Enter the point where the curve crosses its midline (x, y).", kind: "coordinate" },
  ];
  if (type.includes("sine") || type.includes("cosine") || type.includes("trigonometric")) return [
    { label: "Midline point", prompt: "Enter a point on the sinusoid's midline (x, y).", kind: "coordinate" },
    { label: "Maximum or minimum", prompt: "Enter a neighbouring maximum or minimum (x, y).", kind: "coordinate" },
    { label: "Period", prompt: "Enter the period of one full cycle.", kind: "scalar" },
  ];
  if (type.includes("absolute")) return [
    { label: "Vertex", prompt: "Enter the absolute-value graph's vertex (x, y).", kind: "coordinate" },
    { label: "Point on graph", prompt: "Enter one other point on the graph (x, y).", kind: "coordinate" },
  ];
  if (type.includes("square-root") || type.includes("square root")) return [
    { label: "Endpoint", prompt: "Enter the square-root graph's endpoint (x, y).", kind: "coordinate" },
    { label: "Point on graph", prompt: "Enter one other point on the graph (x, y).", kind: "coordinate" },
  ];
  return [1, 2, 3].map((index) => ({ label: `Key point ${index}`, prompt: `Enter key point ${index} as coordinates (x, y).`, kind: "coordinate" }));
}

function parseCanvasGraphNumber(raw) {
  const text = String(raw || "").replace(/[−–]/g, "-").trim();
  const fraction = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\/\s*((?:\d+(?:\.\d*)?|\.\d+))$/);
  const value = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseCanvasGraphCoordinate(value) {
  let text = String(value || "").trim();
  const startsWrapped = text.startsWith("(");
  const endsWrapped = text.endsWith(")");
  if (startsWrapped !== endsWrapped) return null;
  if (startsWrapped) text = text.slice(1, -1).trim();
  const parts = text.split(/[,;]/);
  if (parts.length !== 2) return null;
  const x = parseCanvasGraphNumber(parts[0]);
  const y = parseCanvasGraphNumber(parts[1]);
  return x === null || y === null ? null : { x, y };
}

function placeCanvasGraphConfirmButton(canvas = state.canvas) {
  const button = $("#canvasReadingConfirm");
  const home = $("#canvasReadingConfirmHome");
  const workflow = canvas?.mode === "graph" ? canvas.graphWorkflow : null;
  let target = home;
  if (workflow?.stage === "confirm-type") target = $("#canvasGraphTypeAction");
  else if (["collecting", "retry"].includes(workflow?.stage)) target = $("#canvasGraphPointAction");
  else if (["reconstructing", "preview", "all-ready"].includes(workflow?.stage)) target = $("#canvasGraphPreviewAction");
  if (target && button.parentElement !== target) target.append(button);
}

function canvasGraphEquationMatchesPoints(equation, points) {
  const evaluate = parseCanvasGraphExpression(equation);
  if (!evaluate) return false;
  for (const point of points) {
    const coordinate = parseCanvasGraphCoordinate(point.value);
    if (!coordinate) continue;
    const actual = evaluate(coordinate.x);
    const tolerance = Math.max(1e-4, Math.abs(coordinate.y) * 1e-3);
    if (actual === null || Math.abs(actual - coordinate.y) > tolerance) return false;
  }
  return true;
}

function validateCanvasGraphEntry(prompt, rawValue) {
  const value = String(rawValue || "").trim();
  if (prompt.kind === "coordinate") {
    if (!parseCanvasGraphCoordinate(value)) return "Enter one finite coordinate pair, for example (2, -4).";
  } else if (parseCanvasGraphNumber(value.replace(/^[xy]\s*=\s*/i, "")) === null) {
    return "Enter one finite number, such as 2 or -3/4.";
  }
  if (prompt.label.toLowerCase() === "radius" && parseCanvasGraphNumber(value) <= 0) return "A radius must be greater than zero.";
  return "";
}

function setCanvasGraphPrompt(canvas, prompt) {
  const workflow = canvas.graphWorkflow;
  workflow.stage = "collecting";
  workflow.activePrompt = prompt;
  $("#canvasGraphPointPrompt").textContent = prompt.prompt;
  $("#canvasGraphPointInputLabel").textContent = prompt.kind === "coordinate" ? `${prompt.label} (x, y)` : prompt.label;
  $("#canvasGraphPointInput").placeholder = prompt.kind === "coordinate" ? `${prompt.label}: (x, y)` : `${prompt.label}: enter a value`;
  $("#canvasGraphPointInput").value = "";
  $("#canvasReadingConfirm").textContent = "Add key point";
  $("#canvasGraphGuidedPanel").hidden = false;
  $("#canvasGraphPreviewPanel").hidden = !workflow.functions.length;
  $("#canvasGraphFunctionHeading").textContent = `Function ${workflow.functionIndex} of ${workflow.functionCount}: key details`;
  placeCanvasGraphConfirmButton(canvas);
  setCanvasReadingStatus("Enter the requested exact value, then add it to the graph details.");
  requestAnimationFrame(() => $("#canvasGraphPointInput").focus({ preventScroll: true }));
}

function updateCanvasGraphHistory(canvas) {
  const history = $("#canvasGraphPointHistory");
  history.replaceChildren();
  const workflow = canvas.graphWorkflow;
  (workflow?.points || []).forEach((point) => {
    const item = document.createElement("span");
    item.textContent = `${point.label}: ${point.value}`;
    history.append(item);
  });
}

function renderConfirmedCanvasGraph(canvas, includeCurrent = false) {
  const workflow = canvas.graphWorkflow;
  const functions = workflow.functions.slice();
  if (includeCurrent && workflow.currentResult) functions.push({ graphType: workflow.currentType, result: workflow.currentResult });
  const svg = renderCanvasGraphPreview(functions);
  const panel = $("#canvasGraphPreviewPanel");
  const target = $("#canvasGraphPreview");
  panel.hidden = !svg;
  target.innerHTML = svg;
  $("#canvasGraphPreviewStatus").textContent = svg
    ? "Review the reconstructed curve and the key points you confirmed."
    : "The graph details were reconstructed, but this preview could not be displayed. Check the type and points before continuing.";
  return Boolean(svg);
}

async function reconstructCanvasGraphFunction(canvas) {
  const workflow = canvas.graphWorkflow;
  const photo = canvas.readingPhoto;
  if (!photo || !workflow?.currentType) {
    setCanvasReadingStatus("The graph image or function type is missing. Go back and review the sketch.", "error");
    return;
  }
  workflow.stage = "reconstructing";
  workflow.activePrompt = null;
  placeCanvasGraphConfirmButton(canvas);
  $("#canvasGraphPreviewPanel").hidden = true;
  updateCanvasStage();
  $("#canvasReadingConfirm").disabled = true;
  setCanvasReadingStatus(`Building function ${workflow.functionIndex} of ${workflow.functionCount} from its confirmed type and points…`, "", true);
  try {
    const circleType = workflow.currentType.toLowerCase().includes("circle");
    let result;
    if (circleType) {
      const centerEntry = workflow.points.find((point) => point.label.toLowerCase() === "centre");
      const radiusEntry = workflow.points.find((point) => point.label.toLowerCase() === "radius");
      const center = parseCanvasGraphCoordinate(centerEntry?.value);
      const radius = parseCanvasGraphNumber(radiusEntry?.value);
      if (!center || radius === null || radius <= 0) throw new Error("Invalid circle details");
      const margin = Math.max(0.5, radius * 0.2);
      result = {
        status: "ready",
        graph_type: workflow.currentType,
        equation: "",
        x_min: center.x - radius - margin,
        x_max: center.x + radius + margin,
        y_min: center.y - radius - margin,
        y_max: center.y + radius + margin,
        critical_points: [{ label: "Centre", x: center.x, y: center.y }],
        circle: { x: center.x, y: center.y, radius, semicircle: workflow.currentType.toLowerCase().includes("semi") },
      };
    } else result = await postJson("/api/education/photo/reconstruct-graph", {
      inspection_id: photo.inspectionId,
      photo_id: photo.photoId,
      grade: Math.max(1, Math.min(12, Number(state.grade) || 12)),
      context: [
        currentCanvasQuestionText(),
        `This is function ${workflow.functionIndex} of ${workflow.functionCount} on one shared graph. Use only the confirmed function type and learner-supplied key points. Never estimate exact coordinates from the sketch.`,
        canvas.questionAwareGraph ? "This is a learner task. Do not disclose or add a requested equation to the answer; return the graph preview only." : "",
      ].filter(Boolean).join("\n"),
      confirmed_graph_type: workflow.currentType,
      drawing_description: $("#canvasReadingDrawing").value.trim(),
      points: workflow.points.map(({ label, value }) => ({ label, value })),
      user_equation: canvas.questionAwareGraph ? "" : $("#canvasGraphDetails").value.trim(),
    });
    workflow.currentResult = result;
    if (String(result.status || "").toLowerCase() === "needs_point") {
      workflow.extraPointCount += 1;
      if (workflow.extraPointCount > 4) {
        workflow.stage = "retry";
        $("#canvasGraphPointPrompt").textContent = "More information is needed. Add another exact key point or correct the function type and try again.";
        $("#canvasReadingConfirm").textContent = "Retry preview";
        setCanvasReadingStatus("More exact graph information is needed before a preview can be made.", "warning");
        return;
      }
      setCanvasGraphPrompt(canvas, {
        label: sanitizeLearnerFacingText(String(result.next_point_label || "Additional key point")).slice(0, 80),
        prompt: canvas.questionAwareGraph
          ? `Enter the ${sanitizeLearnerFacingText(String(result.next_point_label || "additional key point")).toLowerCase()} you worked out as coordinates (x, y).`
          : sanitizeLearnerFacingText(String(result.next_point_prompt || "Enter one additional key point as coordinates (x, y).")),
        kind: "coordinate",
      });
      return;
    }
    if (String(result.status || "").toLowerCase() !== "ready" || (!result.circle && !String(result.equation || "").trim())) {
      workflow.stage = "retry";
      $("#canvasGraphType").disabled = false;
      $("#canvasGraphFunctionHeading").textContent = `Function ${workflow.functionIndex} of ${workflow.functionCount}`;
      $("#canvasGraphPointPrompt").textContent = "This graph needs more learner-provided details. Add a key point or correct the function type, then try again.";
      $("#canvasGraphPointInput").value = "";
      $("#canvasReadingConfirm").textContent = workflow.points.length ? "Add key point" : "Retry preview";
      setCanvasReadingStatus("The graph is not determined yet. Check its type and confirmed points.", "warning");
      return;
    }
    if (!result.circle && !canvasGraphEquationMatchesPoints(result.equation, workflow.points)) {
      workflow.stage = "retry";
      $("#canvasGraphType").disabled = false;
      $("#canvasGraphGuidedPanel").hidden = false;
      $("#canvasGraphPointPrompt").textContent = "The preview does not match every exact point you entered. Check the function type and points, then retry.";
      $("#canvasGraphPointInput").value = "";
      $("#canvasReadingConfirm").textContent = "Retry preview";
      setCanvasReadingStatus("The preview does not pass through all confirmed points. Check the details before continuing.", "error");
      return;
    }
    workflow.stage = "preview";
    $("#canvasGraphGuidedPanel").hidden = true;
    $("#canvasGraphType").disabled = false;
    if (!renderConfirmedCanvasGraph(canvas, true)) {
      workflow.stage = "retry";
      $("#canvasGraphGuidedPanel").hidden = false;
      $("#canvasGraphType").disabled = false;
      $("#canvasGraphPointPrompt").textContent = "The returned function could not be plotted. Check the function type and exact points, then retry or add another point.";
      $("#canvasReadingConfirm").textContent = "Retry preview";
      setCanvasReadingStatus("The graph preview could not be displayed. Check the confirmed details before continuing.", "error");
      return;
    }
    $("#canvasGraphPreviewPanel").hidden = false;
    $("#canvasGraphFunctionHeading").textContent = `Review function ${workflow.functionIndex} of ${workflow.functionCount}`;
    $("#canvasReadingConfirm").textContent = workflow.functionIndex < workflow.functionCount ? "Confirm function" : "Finish functions";
    setCanvasReadingStatus("Review the graph preview, then confirm this function before continuing.", "success");
  } catch {
    workflow.stage = "retry";
    $("#canvasGraphType").disabled = false;
    $("#canvasGraphGuidedPanel").hidden = false;
    $("#canvasGraphPointPrompt").textContent = "Graph preview could not be made. Your confirmed points are saved; retry or add another point.";
    $("#canvasReadingConfirm").textContent = workflow.points.length ? "Add key point" : "Retry preview";
    setCanvasReadingStatus("Graph preview could not be made. Your confirmed points are saved.", "error");
  } finally {
    if (state.canvas === canvas) {
      placeCanvasGraphConfirmButton(canvas);
      $("#canvasReadingConfirm").disabled = false;
      updateCanvasStage();
    }
    setCanvasReadingStatus($("#canvasReadingStatus").textContent, $("#canvasReadingStatus").dataset.kind || "", false);
  }
}

async function advanceCanvasGraphWorkflow() {
  const canvas = state.canvas;
  const workflow = canvas?.graphWorkflow;
  if (!canvas || !workflow) return;
  if (workflow.stage === "confirm-type") {
    const graphType = $("#canvasGraphType").value.trim();
    if (!graphType || /\bunclear\b/i.test(graphType)) {
      setCanvasReadingStatus("Choose a clear graph type for this function before continuing.", "error");
      return;
    }
    workflow.currentType = graphType;
    workflow.points = [];
    workflow.extraPointCount = 0;
    $("#canvasGraphType").disabled = true;
    $("#canvasGraphPointHistory").replaceChildren();
    $("#canvasGraphGuidedStatus").textContent = "Enter exact values given in the question or already established in your work. Do not estimate from an unnumbered sketch.";
    const prompts = canvasGraphInitialPrompts(graphType);
    workflow.promptQueue = prompts.slice(1);
    setCanvasGraphPrompt(canvas, prompts[0]);
    return;
  }
  if (workflow.stage === "collecting") {
    const prompt = workflow.activePrompt;
    if (!prompt) return reconstructCanvasGraphFunction(canvas);
    const value = $("#canvasGraphPointInput").value.trim();
    const error = validateCanvasGraphEntry(prompt, value);
    if (error) {
      setCanvasReadingStatus(error, "error");
      return;
    }
    setCanvasReadingStatus("");
    workflow.points.push({ label: prompt.label, value });
    updateCanvasGraphHistory(canvas);
    if (workflow.promptQueue.length) {
      setCanvasGraphPrompt(canvas, workflow.promptQueue.shift());
      return;
    }
    await reconstructCanvasGraphFunction(canvas);
    return;
  }
  if (workflow.stage === "retry") {
    const editedType = $("#canvasGraphType").value.trim();
    if (editedType && !/\bunclear\b/i.test(editedType)) workflow.currentType = editedType;
    const value = $("#canvasGraphPointInput").value.trim();
    if (value) {
      const prompt = { label: "Additional key point", kind: "coordinate" };
      const error = validateCanvasGraphEntry(prompt, value);
      if (error) { setCanvasReadingStatus(error, "error"); return; }
      workflow.points.push({ label: prompt.label, value });
      updateCanvasGraphHistory(canvas);
    }
    await reconstructCanvasGraphFunction(canvas);
    return;
  }
  if (workflow.stage === "preview") {
    workflow.functions.push({ graphType: workflow.currentType, points: workflow.points.slice(), result: workflow.currentResult });
    if (workflow.functionIndex < workflow.functionCount) {
      workflow.functionIndex += 1;
      workflow.stage = "confirm-type";
      workflow.currentType = "";
      workflow.currentResult = null;
      workflow.points = [];
      workflow.promptQueue = [];
      $("#canvasGraphType").disabled = false;
      $("#canvasGraphType").value = "";
      $("#canvasGraphDetails").value = "";
      $("#canvasGraphGuidedPanel").hidden = false;
      $("#canvasGraphFunctionHeading").textContent = `Function ${workflow.functionIndex} of ${workflow.functionCount}: confirm its type`;
      $("#canvasGraphGuidedStatus").textContent = "Choose or correct this function's graph type. Then enter its exact key details.";
      $("#canvasGraphPointHistory").replaceChildren();
      $("#canvasGraphPointPrompt").textContent = "Confirm the graph type above to begin collecting key points.";
      $("#canvasGraphPointInput").value = "";
      $("#canvasGraphPreviewPanel").hidden = false;
      renderConfirmedCanvasGraph(canvas);
      $("#canvasReadingConfirm").textContent = "Confirm type";
      placeCanvasGraphConfirmButton(canvas);
      setCanvasReadingStatus(`Function ${workflow.functionIndex - 1} confirmed. Continue with function ${workflow.functionIndex} of ${workflow.functionCount}.`);
      return;
    }
    const summary = workflow.functions.map((item, index) => {
      const details = item.points.map((point) => `${point.label}: ${point.value}`).join(", ");
      return `Function ${index + 1}: ${item.graphType}${details ? `; confirmed details: ${details}` : ""}`;
    }).join("\n");
    canvas.confirmedReading = {
      words: "",
      formula: "",
      drawing: $("#canvasReadingDrawing").value.trim(),
      comment: $("#canvasReadingComment").value.trim(),
      graphType: workflow.functions.map((item) => item.graphType).join("; "),
      graphDetails: summary,
    };
    canvas.readingConfirmed = true;
    $("#canvasReadingConfirm").textContent = "Use graph";
    workflow.stage = "all-ready";
    placeCanvasGraphConfirmButton(canvas);
    updateCanvasStage();
    setCanvasReadingStatus("All function previews are confirmed. Use the graph to attach it to your work.", "success");
    return;
  }
  if (workflow.stage === "all-ready") {
    $("#canvasReadingReview").hidden = true;
    $("#finishCanvas").click();
  }
}

async function advanceCanvasGraphWorkflowSafely() {
  try {
    await advanceCanvasGraphWorkflow();
  } catch (error) {
    console.error("Graph review could not continue", error);
    setCanvasReadingStatus("Graph review could not continue. Your confirmed details are still here; check them and try again.", "error");
  }
}

function appendConfirmedCanvasReading(reading) {
  if (!reading || state.canvas.readingApplied) return;
  const context = state.canvasContext || "";
  const editor = context.startsWith("practice") ? "practice" : context.startsWith("exam") ? "exam" : "ask";
  const getCurrent = () => editor === "practice" ? getPracticeEditorLatex() : getMathEditorLatex(editor);
  const send = (name, value = "") => editor === "practice"
    ? practiceEditorCommand({ name, value })
    : mathEditorCommand(editor, { name, value });
  let current = String(getCurrent() || "");
  let added = false;
  const addPart = (value, command = "insertText") => {
    const text = String(value || "").trim();
    if (!text || current.includes(text)) return;
    if (current.trim() || added) send("newLine");
    send(command, text);
    current += `${current ? "\n" : ""}${text}`;
    added = true;
  };
  addPart(reading.words);
  addPart(reading.formula, "insertLatex");
  addPart(reading.graphType ? `Learner-confirmed graph type: ${reading.graphType}` : "");
  addPart(reading.graphDetails ? `Learner-confirmed equation and key graph information: ${reading.graphDetails}` : "");
  addPart(reading.drawing ? `Confirmed drawing description: ${reading.drawing}` : "");
  addPart(reading.comment ? `Learner's note: ${reading.comment}` : "");
  state.canvas.readingApplied = true;
}

$("#canvasReadWritingButton").addEventListener("click", (event) => {
  const canvas = state.canvas;
  if (!canvas || canvas.readingConfirmed) return;
  if (canvas.stage === "graph-setup") {
    setStatus($("#canvasGraphCountStatus"), "Enter a whole number greater than 0 before drawing the graph.", "error");
    $("#canvasGraphFunctionCount").focus({ preventScroll: true });
    event.stopImmediatePropagation();
    return;
  }
  if (canvas.stage === "writing" && canvas.mode !== "graph") {
    if (!canvas.strokes.length) {
      setStatus($("#canvasReadingStatus"), "Write or draw something on the canvas first.", "error");
      return;
    }
    enterCanvasRegionSelection();
    event.stopImmediatePropagation();
    return;
  }
  if (canvas.stage === "regions" && !canvas.regions.length) {
    setCanvasReadingStatus("Mark at least one area first. Choose Words, Maths, or Drawings.", "error");
    event.stopImmediatePropagation();
    return;
  }
  if (canvas.stage === "writing" && canvas.mode === "graph" && !canvas.strokes.length) {
    $("#canvasReadingReview").hidden = false;
    setCanvasReadingStatus("Draw the graph before asking for a review.", "error");
    event.stopImmediatePropagation();
    return;
  }
  if (canvas.stage === "regions" || canvas.stage === "writing") {
    canvas.stage = "transcribing";
    updateCanvasStage();
  }
  event.stopImmediatePropagation();
  void reviewCanvasReading();
});
$$('.canvas-region-tool').forEach((button) => button.addEventListener("click", () => {
  state.canvas.regionKind = button.dataset.canvasRegionKind;
  setStatus($("#canvasReadingStatus"), `Mark the ${state.canvas.regionKind} area on the canvas.`);
  updateCanvasStage();
}));
$("#canvasBackWritingButton").addEventListener("click", () => {
  const viewport = state.canvas.writingViewport;
  state.canvas.stage = "writing";
  if (viewport) {
    state.canvas.scale = viewport.scale;
    state.canvas.offsetX = viewport.offsetX;
    state.canvas.offsetY = viewport.offsetY;
  }
  $("#canvasReadingReview").hidden = true;
  updateCanvasStage();
});
$("#canvasGraphStartButton").addEventListener("click", () => {
  const input = $("#canvasGraphFunctionCount");
  const count = input.valueAsNumber;
  if (!Number.isSafeInteger(count) || count < 1) {
    setStatus($("#canvasGraphCountStatus"), "Enter a whole number greater than 0.", "error");
    input.focus({ preventScroll: true });
    return;
  }
  setStatus($("#canvasGraphCountStatus"), "");
  state.canvas.graphFunctionCount = count;
  state.canvas.stage = "writing";
  updateCanvasStage();
});

$("#canvasReadingConfirm").addEventListener("click", async () => {
  if (state.canvas?.mode === "graph" && state.canvas.graphWorkflow) {
    await advanceCanvasGraphWorkflowSafely();
    return;
  }
  const reading = {
    words: $("#canvasReadingWords").value.trim(),
    formula: getMathEditorLatex("canvasMath").trim(),
    drawing: $("#canvasReadingDrawing").value.trim(),
    comment: $("#canvasReadingComment").value.trim(),
    graphType: $("#canvasGraphType").value.trim(),
    graphDetails: $("#canvasGraphDetails").value.trim(),
  };
  if (!reading.words && !reading.formula && !reading.drawing && !reading.comment) {
    setStatus($("#canvasReadingStatus"), "There is no confirmed reading to use. Edit a field or choose Use image as drawn.", "error");
    return;
  }
  state.canvas.confirmedReading = reading;
  state.canvas.readingConfirmed = true;
  $("#canvasReadingConfirm").disabled = true;
  $("#finishCanvas").textContent = "Adding…";
  $("#finishCanvas").click();
});
for (const selector of ["#canvasGraphType", "#canvasGraphPointInput"]) {
  $(selector).addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("#canvasReadingConfirm").click();
  });
}

$("#canvasReadingImageOnly").addEventListener("click", () => {
  state.canvas.confirmedReading = null;
  state.canvas.readingConfirmed = true;
  $("#canvasReadingConfirm").disabled = true;
  $("#finishCanvas").textContent = "Adding…";
  $("#finishCanvas").click();
});

$("#canvasReadingClose").addEventListener("click", () => {
  $("#canvasReadingReview").hidden = true;
  if (state.canvas.mode === "graph") state.canvas.stage = "writing";
  else state.canvas.stage = "regions";
  updateCanvasStage();
  setStatus($("#canvasReadingStatus"), "Review cancelled. The canvas is still here.");
});

workingCanvas.addEventListener("pointerdown", (event) => {
  if (!canvasSupportsDirectInput() && !canvasCanSelectWithMouse(event)) {
    event.preventDefault();
    return;
  }
  const current = state.canvas;
  if (!current || !["writing", "regions"].includes(current.stage)) return;
  event.preventDefault();
  workingCanvas.setPointerCapture(event.pointerId);
  current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (current.pointers.size === 2) {
    if (current.active) {
      invalidateCanvasTranscription();
      current.strokes.pop();
      current.active = null;
    }
    current.draftRegion = null;
    current.drag = null;
    const pair = [...current.pointers.values()];
    current.pinch = current.zoom ? { distance: canvasDistance(pair[0], pair[1]), scale: current.scale, offsetX: current.offsetX, offsetY: current.offsetY, midpoint: canvasMidpoint(pair[0], pair[1]) } : null;
    return;
  }
  if (current.pan) {
    current.drag = { x: event.clientX, y: event.clientY, offsetX: current.offsetX, offsetY: current.offsetY };
    return;
  }
  if (current.stage === "regions") {
    const point = canvasPoint(event);
    const rect = workingCanvas.getBoundingClientRect();
    const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    current.draftRegion = { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, kind: current.regionKind, start: point, end: point, screenStart: screenPoint, screenEnd: screenPoint };
    drawCanvasRegionOverlay();
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
  if (!canvasSupportsDirectInput() && !canvasCanSelectWithMouse(event)) return;
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
  } else if (current.draftRegion && pair.length === 1) {
    current.draftRegion.end = canvasPoint(event);
    const rect = workingCanvas.getBoundingClientRect();
    current.draftRegion.screenEnd = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    drawCanvasRegionOverlay();
  } else if (current.active && pair.length === 1) {
    current.active.points.push(canvasPoint(event));
    drawCanvas();
  }
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => workingCanvas.addEventListener(eventName, (event) => {
  const current = state.canvas;
  current.pointers.delete(event.pointerId);
  if (current.pointers.size < 2) current.pinch = null;
  if (current.pointers.size === 1 && current.pan) {
    const remaining = [...current.pointers.values()][0];
    current.drag = { x: remaining.x, y: remaining.y, offsetX: current.offsetX, offsetY: current.offsetY };
  }
  if (!current.pointers.size) {
    current.active = null;
    current.drag = null;
    if (current.draftRegion) {
      const draft = current.draftRegion;
        if (event.type === "pointerup") {
          draft.end = canvasPoint(event);
          const rect = workingCanvas.getBoundingClientRect();
          draft.screenEnd = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }
      current.draftRegion = null;
        addCanvasRegion(draft.start, draft.end, draft.kind, draft.id, null, canvasLocalRect(draft.screenStart, draft.screenEnd));
      drawCanvasRegionOverlay();
      syncPhoneCanvasSetup();
    }
  }
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
  document.documentElement.classList.remove("canvas-dialog-open");
  document.body.classList.remove("canvas-dialog-open");
  if (state.canvasReturnFocus instanceof HTMLElement) state.canvasReturnFocus.focus({ preventScroll: true });
});
$("#canvasFitButton").addEventListener("click", fitCanvasToWriting);
$("#undoCanvas").addEventListener("click", () => {
  if (state.canvas.stage === "regions") {
    if (state.canvas.regions.length) {
      releaseCanvasRegionSnapshot(state.canvas.regions.pop());
      invalidateCanvasTranscription();
      drawCanvasRegionOverlay();
      renderCanvasRegionSnapshots();
      syncPhoneCanvasSetup();
    }
    return;
  }
  if (state.canvas.strokes.length) invalidateCanvasTranscription();
  state.canvas.strokes.pop();
  drawCanvas();
  if (phoneCanvasSession) phoneCanvasSend({ type: "setup", strokes: phoneCanvasSnapshot() });
});
$("#clearCanvas").addEventListener("click", () => {
  if (state.canvas.stage === "regions") {
    if (state.canvas.regions.length) invalidateCanvasTranscription();
    state.canvas.regions.forEach(releaseCanvasRegionSnapshot);
    state.canvas.regions = [];
    state.canvas.draftRegion = null;
    drawCanvasRegionOverlay();
    renderCanvasRegionSnapshots();
    syncPhoneCanvasSetup();
    return;
  }
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
  if (state.canvas?.mode === "graph" && (!Number.isSafeInteger(state.canvas.graphFunctionCount) || state.canvas.graphFunctionCount < 1)) {
    setStatus($("#canvasGraphCountStatus"), "Enter a whole number greater than 0 before opening the phone canvas.", "error");
    $("#canvasGraphFunctionCount").focus({ preventScroll: true });
    return;
  }
  const panel = $("#phoneCanvasPairPanel");
  if (!panel.hidden && !phoneCanvasSession) {
    await startPhoneCanvas();
    return;
  }
  panel.hidden = !panel.hidden;
  $("#usePhoneCanvas").setAttribute("aria-expanded", String(!panel.hidden));
  syncCanvasInputMode();
  if (!panel.hidden) await startPhoneCanvas();
});
$("#canvasPhoneOnlyConnect").addEventListener("click", () => $("#usePhoneCanvas").click());
$("#stopPhoneCanvas").addEventListener("click", () => stopPhoneCanvas());
$("#copyPhoneCanvasPairServer").addEventListener("click", copyPhoneCanvasPairServer);
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
  if (canvas.stage === "graph-setup") {
    setStatus($("#canvasGraphCountStatus"), "Enter a whole number greater than 0 before drawing the graph.", "error");
    $("#canvasGraphFunctionCount").focus({ preventScroll: true });
    return;
  }
  if (!canvas.strokes.length) {
    showToast("Write or draw something before using the canvas.");
    if (phoneCanvasSession) phoneCanvasSend({ type: "submission_error", message: "Write or draw something before using the canvas." });
    return;
  }
  if (state.canvasContext.startsWith("practice") && state.practiceAnswerPhotoIds.length >= 3) {
    showToast("The limit is three handwritten images per practice attempt.");
    if (phoneCanvasSession) phoneCanvasSend({ type: "submission_error", message: "This attempt already has the maximum number of handwritten images." });
    return;
  }
  if (!canvas.readingConfirmed) {
    if (canvas.stage === "graph-setup") {
      setStatus($("#canvasGraphCountStatus"), "Enter a whole number greater than 0 before drawing the graph.", "error");
      $("#canvasGraphFunctionCount").focus({ preventScroll: true });
      return;
    }
    if (canvas.stage === "writing" && canvas.mode !== "graph") {
      enterCanvasRegionSelection();
      return;
    }
    if (canvas.stage === "review") {
      $("#canvasReadingReview").hidden = false;
      $("#canvasReadingResults").hidden = false;
      if (canvas.mode === "graph" && canvas.graphWorkflow) {
        await advanceCanvasGraphWorkflowSafely();
        return;
      }
      $("#canvasReadingReview").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (canvas.stage === "transcribing") return;
    if (canvas.stage === "regions" && !canvas.regions.length) {
      setCanvasReadingStatus("Mark at least one area first. Choose Words, Maths, or Drawings.", "error");
      return;
    }
    canvas.stage = "transcribing";
    updateCanvasStage();
    await reviewCanvasReading();
    return;
  }
  button.disabled = true;
  button.textContent = "Adding…";
  $("#canvasReadingReview").hidden = false;
  $("#canvasReadingResults").hidden = false;
  $("#canvasReadingConfirm").disabled = true;
  setCanvasReadingStatus("Adding your confirmed work…", "", true);
  try {
    const photo = await ensureCanvasPhoto(canvas, revision, (message) => setCanvasReadingStatus(message, "", true));
    assertCanvasSnapshotCurrent(canvas, revision);
    appendConfirmedCanvasReading(canvas.confirmedReading);
    const { file, blob, photoId } = photo;
    const previewUrl = URL.createObjectURL(blob);
    if (state.canvasContext === "ask-write" || state.canvasContext === "ask-graph") {
      state.askPhotos.push({ id: photoId, filename: file.name, previewUrl });
      appendMessage("Canvas working attached. It will be included when you press Send.", { kind: "Canvas working", imageUrl: previewUrl });
      mathEditorCommand("ask", { name: "focus" });
    } else if (state.canvasContext.startsWith("practice")) {
      if (photoId && !state.practiceAnswerPhotoIds.includes(photoId)) state.practiceAnswerPhotoIds.push(photoId);
      state.practiceAnswerPhotoPreviews.push({ id: photoId, url: previewUrl });
      const key = practiceQuestionStorageKey(PRACTICE_SESSION_KEYS.photosPrefix);
      if (key) sessionStorage.setItem(key, JSON.stringify(state.practiceAnswerPhotoIds));
      renderPracticeAnswerAttachments();
      showToast("Canvas working attached. Send it for marking when ready.");
    } else if (state.canvasContext.startsWith("exam")) {
      const question = state.examCurrentQuestion;
      if (question && photoId) {
        const existing = state.examAnswerAttachments.get(question.id) || [];
        state.examAnswerAttachments.set(question.id, [...new Set(existing.concat(photoId))].slice(0, 12));
        renderExamAnswerAttachments(question.id);
      }
      showToast("Canvas working attached to this assessment answer.");
    }
    if (phoneCanvasSession && phoneCanvasSocket?.readyState === WebSocket.OPEN) {
      phoneCanvasSubmissionSentUntil = Date.now() + 1200;
      phoneCanvasSend({ type: "submitted" });
    }
    $("#canvasDialog").close();
  } catch {
    canvas.readingConfirmed = true;
    $("#canvasReadingConfirm").disabled = false;
    setCanvasReadingStatus("Your work could not be attached. It is still here; check your connection and try again.", "error");
    if (phoneCanvasSession) phoneCanvasSend({ type: "submission_error", message: "Your work could not be attached. It is still available on the computer; check the connection and try again." });
    showToast("Your work could not be attached. It is still here; check your connection and try again.");
  } finally {
    if (state.canvas === canvas && $("#canvasDialog").open) {
      button.disabled = false;
      updateCanvasStage();
      if (canvas.readingConfirmed) $("#canvasReadingConfirm").disabled = false;
    }
  }
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
