import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "../app/node_modules/esbuild/lib/main.js";
import { buildLiveTutorPayload, selectLiveSpeechTranscript } from "../app/live-tutor-payload.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleResult = await build({
  entryPoints: [path.join(repoRoot, "app/realtime-tutor.js")],
  bundle: true,
  format: "iife",
  globalName: "RealtimeTutor",
  platform: "browser",
  write: false,
});
const bundledClient = bundleResult.outputFiles[0].text;

function makeButton(dataset = {}) {
  const listeners = new Map();
  const attributes = new Map();
  const label = { replaceChildren(...nodes) { this.textContent = nodes.map((node) => node.textContent).join(""); } };
  return {
    dataset,
    disabled: false,
    textContent: "",
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    click() { return (listeners.get("click") || []).map((callback) => callback({ currentTarget: this })); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    querySelector(selector) { return selector === "span" ? label : null; },
  };
}

function makeStream() {
  const track = {
    readyState: "live",
    enabled: true,
    label: "Test microphone",
    getSettings() { return { deviceId: "mic-1", groupId: "group-1" }; },
    stop() { this.readyState = "ended"; },
  };
  return {
    track,
    getAudioTracks() { return [track]; },
    getTracks() { return [track]; },
  };
}

function createHarness({ getUserMedia } = {}) {
  const contexts = ["ask", "practice", "exam"];
  const actions = new Map();
  const panels = contexts.map((context) => {
    const status = { textContent: "", classList: { toggle() {} } };
    const transcript = { replaceChildren() {}, append() {}, children: [], scrollTop: 0, scrollHeight: 0 };
    const panelActions = new Map();
    for (const action of ["mute", "end", "stop-speaking", "pause-speaking", "resume-speaking", "repeat", "transcripts"]) {
      const button = makeButton();
      panelActions.set(action, button);
      const list = actions.get(action) || [];
      list.push(button);
      actions.set(action, list);
    }
    return {
      dataset: { livePanel: context },
      hidden: true,
      status,
      panelActions,
      querySelector(selector) {
        if (selector === "[data-live-status]") return status;
        if (selector === "[data-live-transcript]") return transcript;
        const action = selector.match(/data-live-action='([^']+)'/)?.[1];
        return action ? panelActions.get(action) || null : null;
      },
    };
  });
  const launchButtons = contexts.map((context) => makeButton({ liveStart: context }));
  const streams = [];
  let microphoneRequests = 0;
  const speech = [];
  const utterances = [];
  const uploadedAudio = [];
  const tutorRequests = [];
  const intervalCallbacks = new Map();
  const timeoutCallbacks = new Map();
  const audioContexts = [];
  let intervalId = 0;
  let timeoutId = 0;
  let simulatedNow = 1000;
  let audioLevel = 0;
  let audioPattern = "speech";
  class FakeAnalyser {
    constructor() { this.fftSize = 2048; }
    getFloatTimeDomainData(samples) {
      if (audioPattern === "click") {
        samples.fill(0);
        samples[100] = 0.8;
        samples[101] = -0.8;
        return;
      }
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = audioLevel * Math.sin((2 * Math.PI * 12 * index) / samples.length);
      }
    }
  }
  class FakeAudioContext {
    constructor() { this.state = "running"; this.sampleRate = 48000; this.destination = {}; this.analyser = new FakeAnalyser(); this.processors = []; audioContexts.push(this); }
    createAnalyser() { return this.analyser; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor(bufferSize) {
      const processor = { bufferSize, onaudioprocess: null, connect() {}, disconnect() {} };
      this.processors.push(processor);
      return processor;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    processAudio() {
      for (const processor of this.processors) {
        if (!processor.onaudioprocess) continue;
        const input = new Float32Array(processor.bufferSize);
        if (audioPattern === "click") {
          input[100] = 0.8;
          input[101] = -0.8;
        } else {
          for (let index = 0; index < input.length; index += 1) {
            input[index] = audioLevel * Math.sin((2 * Math.PI * 12 * index) / input.length);
          }
        }
        const output = new Float32Array(processor.bufferSize);
        processor.onaudioprocess({
          inputBuffer: { getChannelData() { return input; } },
          outputBuffer: { getChannelData() { return output; } },
        });
        assert.equal(output.some((sample) => sample !== 0), false, "microphone audio must not be played back through the output");
      }
    }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
  }
  const fakeSpeechSynthesis = {
    getVoices() { return [{ voiceURI: "test-voice", lang: "en-ZA" }]; },
    addEventListener() {},
    cancel() {},
    pause() {},
    resume() {},
    speak(utterance) { speech.push(utterance.text); utterances.push(utterance); },
  };
  const navigator = {
    mediaDevices: {
      async getUserMedia() {
        microphoneRequests += 1;
        const stream = getUserMedia ? await getUserMedia() : makeStream();
        streams.push(stream);
        return stream;
      },
      async enumerateDevices() { return [{ kind: "audioinput", deviceId: "mic-1", label: "Test microphone" }]; },
    },
  };
  const window = {
    isSecureContext: true,
    AudioContext: FakeAudioContext,
    speechSynthesis: fakeSpeechSynthesis,
    SpeechSynthesisUtterance: class SpeechSynthesisUtterance { constructor(text) { this.text = text; } },
    addEventListener() {},
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === "[data-live-panel]") return panels;
      if (selector === "[data-live-start]") return launchButtons;
      if (selector === "[data-live-voice]") return [];
      const action = selector.match(/data-live-action='([^']+)'/)?.[1];
      return action ? actions.get(action) || [] : [];
    },
    createElement() { return { append() {} }; },
    createTextNode(textContent) { return { textContent }; },
  };
  const localStorage = { getItem() { return null; }, setItem() {} };
  const clock = class extends Date { static now() { return simulatedNow; } };
  const context = vm.createContext({
    window,
    navigator,
    document,
    Date: clock,
    Blob,
    setInterval(callback) { const id = ++intervalId; intervalCallbacks.set(id, callback); return id; },
    clearInterval(id) { intervalCallbacks.delete(id); },
    setTimeout(callback, delay) { const id = ++timeoutId; timeoutCallbacks.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeoutCallbacks.delete(id); },
    SpeechSynthesisUtterance: window.SpeechSynthesisUtterance,
    localStorage,
    URL,
    fetch: async () => ({ ok: true, async json() { return { session_token: "session-test", offer_endpoint: "/offer" }; } }),
    __tutorClients: [],
  });
  vm.runInContext(bundledClient, context);
  const transcripts = [];
  const replies = [];
  const tutor = context.RealtimeTutor.installRealtimeTutor({
    ensureInspection: async (type) => "inspection-" + type,
    getContext: async (type, inspectionId) => ({ type, inspection_id: inspectionId }),
    transcribeAudio: async (blob) => { uploadedAudio.push(blob); return "Can you explain two x equals four?"; },
    askTutorTurn: async (request, text) => { tutorRequests.push({ request, text }); return "Divide both sides by two."; },
    onTranscript: (type, text) => transcripts.push({ type, text }),
    onTutorReply: (type, text) => replies.push({ type, text }),
    onError() {},
  });
  return {
    contexts, panels, launchButtons, actions, streams, speech, utterances, transcripts, replies, tutor, context, uploadedAudio, tutorRequests,
    finishSpeech() {
      for (let guard = 0; guard < 20; guard += 1) {
        const utterance = utterances.at(-1);
        if (!utterance || utterance.__testFinished) break;
        utterance.__testFinished = true;
        utterance.onend?.();
        const timer = timeoutCallbacks.entries().next().value;
        if (timer) {
          timeoutCallbacks.delete(timer[0]);
          timer[1].callback();
        }
        if (utterances.at(-1) === utterance && !timeoutCallbacks.size) break;
      }
    },
    finishNextSpeechLine() { utterances.at(-1)?.onend?.(); },
    runSpeechPause() {
      const timer = timeoutCallbacks.entries().next().value;
      if (timer) { timeoutCallbacks.delete(timer[0]); timer[1].callback(); }
    },
    get pendingSpeechPauseMs() { return [...timeoutCallbacks.values()][0]?.delay || 0; },
    tickAudio(level, count = 1) {
      audioPattern = typeof level === "string" ? level : "speech";
      audioLevel = typeof level === "number" ? level : 0;
      for (let tick = 0; tick < count; tick += 1) {
        simulatedNow += 50;
        for (const audioContext of audioContexts) audioContext.processAudio();
        for (const callback of intervalCallbacks.values()) callback();
      }
    },
    whenIdle() { return Promise.resolve().then(() => tutorRequests.length ? undefined : undefined).then(() => new Promise((resolve) => setTimeout(resolve, 0))); },
    get microphoneRequests() { return microphoneRequests; },
  };
}

function nonEmptySpeech(harness) { return harness.speech.filter((text) => text.trim()); }

test("live tutor prefers the server's mathematics-normalized transcript", () => {
  assert.equal(selectLiveSpeechTranscript({ raw_transcript: "two x plus three equals seven", transcript: "2x + 3 = 7" }), "2x + 3 = 7");
  assert.equal(selectLiveSpeechTranscript({ raw_transcript: "spoken words", transcript: "" }), "spoken words");
});

test("tutor speech renders textbook mathematics naturally without speaking punctuation names", () => {
  const harness = createHarness();
  const speak = (value) => harness.context.RealtimeTutor.mathTextForSpeech(value);
  assert.match(speak("Solve \\(2x + 3 = 7\\)."), /2x plus 3 equals 7/);
  assert.doesNotMatch(speak("Solve \\(2x + 3 = 7\\)."), /open parenthesis|close parenthesis|forward slash/i);
  assert.match(speak("\\(\\frac{2x+3}{7} = 1\\)"), /fraction with numerator 2x plus 3 and denominator 7 equals 1/);
  assert.match(speak("x = 3/4"), /x equals 3 over 4/);
  assert.match(speak("2(x+1)"), /2 times the quantity x plus 1/);
});

test("tutor speaks each line slowly and inserts a pause between lines", async () => {
  const harness = createHarness();
  harness.tutor.speakReply("First, isolate x.\nThen substitute the value.", "ask");
  assert.equal(harness.speech.at(-1), "First, isolate x.");
  assert.equal(harness.utterances.at(-1)?.rate, 0.84, "the tutor speaks more slowly for a classroom pace");
  harness.finishNextSpeechLine();
  assert.equal(harness.speech.length, 1, "the next line waits until the pause has elapsed");
  assert.equal(harness.pendingSpeechPauseMs, 420, "a short teaching pause separates lines");
  harness.runSpeechPause();
  assert.equal(harness.speech.at(-1), "Then substitute the value.");
  assert.equal(harness.utterances.at(-1)?.rate, 0.84);
  harness.finishSpeech();
  harness.tutor.speakReply("2.5 + 1.5 = 4.", "ask");
  assert.equal(harness.speech.at(-1), "2.5 plus 1.5 equals 4.", "decimal points stay inside textbook numbers rather than splitting the spoken line");
  assert.equal(harness.pendingSpeechPauseMs, 0, "a decimal value stays in one utterance");
});

test("live tutoring sends a focused question through the retrieval tutor path without practice marking", () => {
  const payload = buildLiveTutorPayload({
    context_type: "practice",
    grade: 12,
    topic: "Algebra",
    inspection_id: "inspection-practice",
    question_text: "Solve 2x + 3 = 7.",
    learner_working: "2x = 4",
    conversation_history: [{ role: "tutor", text: "What operation would undo multiplication by two?" }],
  }, "Why do we divide both sides by two?");

  assert.match(payload.question, /^LATEST LEARNER REQUEST:/);
  assert.match(payload.question, /Why do we divide both sides by two\?/);
  assert.match(payload.question, /Solve 2x \+ 3 = 7\./);
  assert.match(payload.question, /Recent conversation for context/);
  assert.equal(payload.mode, "explain_try_mark");
  assert.equal(payload.math_practice_context, undefined, "a tutoring turn must not be diverted into deterministic marking");
  assert.equal(payload.grade, 12);
  assert.equal(payload.topic, "Algebra");
});

test("live audio records only between voice-button presses, transcribes, and gets one tutor reply", async () => {
  const harness = createHarness();
  const firstLaunch = harness.launchButtons[0].click()[0];
  harness.launchButtons[0].click();
  await firstLaunch;

  assert.equal(harness.microphoneRequests, 0, "opening a live tutor session must not open the microphone");
  assert.equal(harness.replies.length, 1, "the session should show one welcome message");
  assert.equal(nonEmptySpeech(harness).length, 1, "the welcome message should be spoken once; session status: " + harness.panels[0].status.textContent);
  assert.equal(harness.actions.get("pause-speaking")[0].disabled, false, "pause should be available while the tutor speaks");
  assert.equal(harness.actions.get("resume-speaking")[0].disabled, true, "resume should stay disabled until speech is paused");
  harness.tickAudio(0.04, 12);
  harness.tickAudio(0, 25);
  await harness.whenIdle();
  assert.equal(harness.uploadedAudio.length, 0, "ambient sound must not be recorded while the learner has not pressed Voice");
  harness.actions.get("pause-speaking")[0].click();
  assert.equal(harness.actions.get("resume-speaking")[0].disabled, false, "resume should become available after pausing tutor speech");
  harness.actions.get("resume-speaking")[0].click();
  harness.finishSpeech();

  assert.equal(await harness.tutor.togglePushToTalk("ask"), true, "the first Voice press starts a recording");
  assert.equal(harness.microphoneRequests, 1, "the first Voice press opens one mic stream");
  assert.equal(harness.streams[0].track.enabled, true, "the mic track is enabled during push-to-talk only");
  harness.tickAudio(0.04, 12);
  harness.tickAudio(0, 25);
  assert.equal(harness.uploadedAudio.length, 0, "silence does not end or submit the recording automatically");
  assert.equal(await harness.tutor.togglePushToTalk("ask"), false, "the second Voice press stops and sends the recording");
  assert.equal(harness.streams[0].track.enabled, false, "the mic track is disabled immediately after the second press");
  await harness.whenIdle();
  assert.equal(harness.uploadedAudio.length, 1, "one completed speech segment should use the same transcription upload path as voice notes");
  const audioBytes = new Uint8Array(await harness.uploadedAudio[0].arrayBuffer());
  assert.equal(harness.uploadedAudio[0].type, "audio/wav", "the upload must use a self-contained WAV container");
  assert.equal(new TextDecoder().decode(audioBytes.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(audioBytes.subarray(8, 12)), "WAVE");
  assert.equal(audioBytes.byteLength, 44 + (new DataView(audioBytes.buffer).getUint32(40, true)), "the WAV header must describe the captured PCM payload");
  assert.equal(harness.transcripts.length, 1, "recognized learner speech should be transcribed");
  assert.equal(harness.tutorRequests.length, 1, "one recognized turn should produce one tutor request");
  assert.equal(harness.tutorRequests[0].text, "Can you explain two x equals four?");
  assert.equal(harness.replies.length, 2, "the transcript and one tutor reply should be shown");
  assert.equal(nonEmptySpeech(harness).filter((text) => text === "Divide both sides by two.").length, 1, "a reply should be spoken once automatically");

  harness.finishSpeech();
  assert.equal(await harness.tutor.togglePushToTalk("ask"), true);
  harness.tickAudio(0.04, 12);
  harness.tickAudio(0, 25);
  await harness.tutor.togglePushToTalk("ask");
  await harness.whenIdle();
  assert.equal(harness.tutorRequests.length, 2, "the next spoken turn should be sent after its pause");
  assert.equal(harness.replies.length, 3, "each learner turn should receive one displayed reply");
  assert.equal(nonEmptySpeech(harness).filter((text) => text === "Divide both sides by two.").length, 2, "the same reply text is valid for a new learner turn and should not be auto-repeated");

  harness.actions.get("repeat")[0].click();
  assert.equal(nonEmptySpeech(harness).filter((text) => text === "Divide both sides by two.").length, 3, "manual repeat should remain available");
});

test("ask, practice, and exam contexts all accept and speak live tutor turns", async () => {
  const harness = createHarness();
  for (const context of harness.contexts) {
    const index = harness.contexts.indexOf(context);
    await harness.launchButtons[index].click()[0];
    harness.finishSpeech();
    await harness.tutor.togglePushToTalk(context);
    harness.tickAudio(0.04, 12);
    harness.tickAudio(0, 25);
    await harness.tutor.togglePushToTalk(context);
    await harness.whenIdle();
    assert.equal(harness.transcripts.at(-1).type, context);
    assert.equal(harness.replies.at(-1).type, context);
    assert.ok(nonEmptySpeech(harness).includes("Divide both sides by two."));
    await harness.tutor.stop();
  }
});

test("click noise is rejected and real speech is uploaded only after the second Voice press", async () => {
  const harness = createHarness();
  await harness.launchButtons[0].click()[0];
  harness.finishSpeech();

  await harness.tutor.togglePushToTalk("ask");
  harness.tickAudio("click", 12);
  harness.tickAudio(0, 24);
  assert.equal(harness.uploadedAudio.length, 0, "mouse clicks must not trigger a background upload");
  await harness.tutor.togglePushToTalk("ask");
  await harness.whenIdle();
  assert.equal(harness.uploadedAudio.length, 0, "impulsive mouse-click noise must not be uploaded for transcription");
  assert.equal(harness.tutorRequests.length, 0, "click noise must never trigger a tutor turn");
  assert.equal(harness.transcripts.length, 0, "click noise must not create a transcript");

  await harness.tutor.togglePushToTalk("ask");
  harness.tickAudio(0.04, 12);
  harness.tickAudio(0, 24);
  assert.equal(harness.uploadedAudio.length, 0, "a pause alone must not submit a live turn");
  await harness.tutor.togglePushToTalk("ask");
  await harness.whenIdle();
  assert.equal(harness.uploadedAudio.length, 1, "sustained speech should still reach transcription");
  assert.equal(harness.tutorRequests.length, 1, "recognized speech should trigger exactly one conversational turn");
});

test("ending a session while microphone permission is pending cancels the stale start", async () => {
  let resolveMicrophone;
  const microphonePending = new Promise((resolve) => { resolveMicrophone = resolve; });
  const harness = createHarness({ getUserMedia: () => microphonePending });
  await harness.launchButtons[0].click()[0];
  const microphoneStart = harness.tutor.togglePushToTalk("ask");
  harness.actions.get("end")[0].click();
  const stream = makeStream();
  resolveMicrophone(stream);
  await microphoneStart;

  assert.equal(harness.actions.get("end")[0].disabled, true, "a canceled start must return the session controls to the inactive state");
  assert.equal(stream.track.readyState, "ended", "a late microphone stream must be released");
  assert.equal(harness.uploadedAudio.length, 0, "a stale microphone grant must not create a recording");
});
