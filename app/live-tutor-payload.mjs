export function selectLiveSpeechTranscript(result) {
  // The speech endpoint returns both its verbatim words and a math-normalized
  // transcript. Live tutoring should reason over the normalized field (for
  // example, "2x + 3 = 7"), while retaining raw words only as a fallback.
  return String(
    result?.transcript
      || result?.raw_transcript
      || result?.text
      || result?.transcription
      || "",
  ).trim();
}

export function buildLiveTutorPayload(context, latestText) {
  // The backend recognizes this marker when it extracts the question used for
  // its curriculum/document retrieval. Keep the utterance and context in one
  // bounded block so the retrieval query stays focused on this conversation.
  const details = [`LATEST LEARNER REQUEST:\n${String(latestText || "").slice(0, 3000)}`];
  if (context.question_text) details.push(`Relevant maths question:\n${String(context.question_text).slice(0, 3000)}`);
  if (context.learner_working?.trim()) details.push(`Learner's working for coaching context only:\n${context.learner_working.slice(0, 2500)}`);
  if (context.hints_used) details.push(`Hints already shown in this practice question: ${context.hints_used}.`);
  const responseLanguage = String(context.response_language_name || "English").trim() || "English";
  details.push(`Continue this live mathematics conversation in short, clear spoken sentences in ${responseLanguage}. Keep all mathematical terms, number words used in equations, operators, and spoken equations in English. For example, say “x squared plus 3 equals 7” in English even inside a ${responseLanguage} sentence. Guide one step at a time, use textbook-style maths, and ask one brief question if a step is unclear. Coach only; do not mark or submit the learner's work.`);

  const pageLabels = { ask: "Ask", practice: "Practice", exam: "Test / exam prep" };
  const appContext = {
    page: pageLabels[context.context_type] || "Learning workspace",
    page_title: pageLabels[context.context_type] || "Learning workspace",
    grade: context.grade,
    subject: "Mathematics",
    topic: context.topic || "",
    current_question: context.question_text || "",
    question_number: context.question_paper_question_number || "",
    assessment_type: context.assessment_type || "",
    practice_progress: context.hints_used ? `Hints already used: ${context.hints_used}` : "",
    tutoring_language: context.response_language || "en-ZA",
  };

  return {
    subject: "Mathematics",
    grade: context.grade,
    topic: context.topic || (context.question_paper_document_id ? "Question paper" : null),
    question: details.join("\n\n").slice(0, 12000),
    learner_answer: null,
    mode: "explain_try_mark",
    inspection_id: context.inspection_id,
    ai_tier: "luna",
    allow_web_search: false,
    confirmed_photo_transcription: null,
    photo_reading_confirmed: false,
    question_paper_document_id: context.question_paper_document_id || null,
    question_paper_question_number: context.question_paper_question_number || null,
    conversation_history: (context.conversation_history || []).slice(-12).map((turn) => ({
      role: turn.role === "tutor" ? "tutor" : "learner",
      text: String(turn.text || "").slice(0, 2400),
    })).filter((turn) => turn.text),
    app_context: Object.fromEntries(Object.entries(appContext).filter(([, value]) => value !== "" && value != null)),
  };
}
