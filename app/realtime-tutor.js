import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const VOICE_KEY = "sharperx_device_voice_uri";

function readLatexArgument(source, start) {
  let index = start;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] === "{") {
    let depth = 1;
    let cursor = index + 1;
    for (; cursor < source.length && depth; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
    }
    return { value: source.slice(index + 1, Math.max(index + 1, cursor - 1)), next: cursor };
  }
  if (source[index] === "\\") {
    const command = source.slice(index).match(/^\\[A-Za-z]+/);
    if (command) return { value: command[0], next: index + command[0].length };
  }
  return { value: source[index] || "", next: Math.min(source.length, index + 1) };
}

function speakLatex(source, depth = 0) {
  if (depth > 8) return source;
  let result = "";
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "\\") {
      const commandMatch = source.slice(index).match(/^\\([A-Za-z]+|[^A-Za-z])/);
      if (!commandMatch) { index += 1; continue; }
      const command = commandMatch[1];
      index += commandMatch[0].length;
      if (["frac", "dfrac", "tfrac"].includes(command)) {
        const numerator = readLatexArgument(source, index);
        const denominator = readLatexArgument(source, numerator.next);
        const numeratorText = speakLatex(numerator.value, depth + 1).trim();
        const denominatorText = speakLatex(denominator.value, depth + 1).trim();
        const simpleFraction = /^[A-Za-z0-9.]+$/.test(numerator.value.trim()) && /^[A-Za-z0-9.]+$/.test(denominator.value.trim());
        result += simpleFraction
          ? `${numeratorText} over ${denominatorText}`
          : `the fraction with numerator ${numeratorText} and denominator ${denominatorText}`;
        index = denominator.next;
      } else if (command === "sqrt") {
        let degree = "2";
        if (source[index] === "[") {
          const close = source.indexOf("]", index + 1);
          if (close >= 0) { degree = source.slice(index + 1, close); index = close + 1; }
        }
        const radicand = readLatexArgument(source, index);
        const radicandText = speakLatex(radicand.value, depth + 1).trim();
        const simpleRadicand = /^[A-Za-z0-9.]+$/.test(radicand.value.trim());
        result += `${degree === "2" ? "square root" : `${speakLatex(degree, depth + 1)} root`} of ${simpleRadicand ? radicandText : `the quantity ${radicandText}`}`;
        index = radicand.next;
      } else if (["text", "mathrm", "operatorname", "mathit"].includes(command)) {
        const argument = readLatexArgument(source, index);
        result += speakLatex(argument.value, depth + 1);
        index = argument.next;
      } else if (["left", "right", "displaystyle", "textstyle", "quad", "qquad", ";", ",", "!", " "].includes(command)) {
        if (["quad", "qquad", ";", ","].includes(command)) result += " ";
      } else {
        const words = {
          times: " times ", cdot: " times ", ast: " times ", div: " divided by ", pm: " plus or minus ",
          le: " is less than or equal to ", leq: " is less than or equal to ", ge: " is greater than or equal to ",
          leqslant: " is less than or equal to ", geq: " is greater than or equal to ", geqslant: " is greater than or equal to ",
          neq: " is not equal to ", ne: " is not equal to ", notin: " does not belong to ", in: " belongs to ",
          approx: " is approximately equal to ", pi: " pi ", theta: " theta ", alpha: " alpha ", beta: " beta ",
          Delta: " delta ", infinity: " infinity ", sin: " sine ", cos: " cosine ", tan: " tangent ",
          log: " log ", ln: " natural log ", int: " integral of ", sum: " the sum of ", lim: " the limit of ",
          to: " to ", rightarrow: " tends to ", Rightarrow: " implies ", Leftrightarrow: " if and only if ",
          infty: " infinity ", forall: " for all ", exists: " there exists ", circ: " degrees ",
          cdots: " ", ldots: " ", over: " over ", "%": " percent ",
        };
        result += words[command] ?? (command.length === 1 ? command : ` ${command} `);
      }
      continue;
    }
    if (character === "^" || character === "_") {
      const argument = readLatexArgument(source, index + 1);
      const value = speakLatex(argument.value, depth + 1).trim();
      if (character === "^" && value === "2") result += " squared";
      else if (character === "^" && value === "3") result += " cubed";
      else if (character === "^") result += ` to the power of ${/^[A-Za-z0-9.]+$/.test(argument.value.trim()) ? value : `the quantity ${value}`}`;
      else result += ` sub ${/^[A-Za-z0-9.]+$/.test(argument.value.trim()) ? value : `the quantity ${value}`}`;
      index = argument.next;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

export function mathTextForSpeech(value) {
  let text = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\\\(|\\\)|\\\[|\\\]|\$\$?/g, " ")
    .replace(/\\begin\{(?:aligned|align\*?|array|matrix|cases)\}|\\end\{(?:aligned|align\*?|array|matrix|cases)\}/g, " ")
    .replace(/\\\\/g, ". ");
  text = speakLatex(text)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/(^|\s)[*_]{1,3}(?=\S)|[*_]{1,3}(?=\s|$)/g, "$1")
    .replace(/\\%/g, " percent ")
    .replace(/\bLongrightarrow\b|\\Rightarrow/g, " implies ")
    .replace(/\\forall/g, " for all ")
    .replace(/\\exists/g, " there exists ")
    .replace(/\\in/g, " belongs to ")
    .replace(/\\notin/g, " does not belong to ")
    .replace(/\\,/g, " ")
    .replace(/√/g, " square root of ")
    .replace(/[×·⋅]/g, " times ")
    .replace(/÷/g, " divided by ")
    .replace(/−/g, " minus ")
    .replace(/≠/g, " is not equal to ")
    .replace(/≈/g, " is approximately equal to ")
    .replace(/≤/g, " is less than or equal to ")
    .replace(/≥/g, " is greater than or equal to ")
    .replace(/±/g, " plus or minus ")
    .replace(/⇔/g, " if and only if ")
    .replace(/⇒/g, " implies ")
    .replace(/→/g, " tends to ")
    .replace(/∉/g, " does not belong to ")
    .replace(/∈/g, " belongs to ")
    .replace(/∞/g, " infinity ")
    .replace(/π/g, " pi ")
    .replace(/θ/g, " theta ")
    .replace(/α/g, " alpha ")
    .replace(/β/g, " beta ")
    .replace(/Δ/g, " delta ")
    .replace(/°/g, " degrees ");

  const lines = text.split(/\r?\n/).map((line) => {
    const isMath = /(?:=|\^|_|\b(?:squared|cubed|over|times|divided by|plus|minus|equals|is less than|is greater than|is not equal|is approximately|sine|cosine|tangent|square root|to the power of)\b|\\(?:sin|cos|tan|frac|sqrt|int|sum)\b|\d\s*[+\-*/]\s*\d|[A-Za-z)]\s*=\s*[A-Za-z0-9(]|\b[A-Za-z]\s+[+\-*/]\s+[A-Za-z0-9(]|\b[A-Za-z]\s*[+*/]\s*[A-Za-z0-9(]|\b[A-Za-z]\s*-\s*\d)/.test(line);
    if (!isMath) return line;
    return line
      .replace(/([\w)])\s*\+\s*([\w(])/g, "$1 plus $2")
      .replace(/([\w)])\s*-\s*([\w(])/g, "$1 minus $2")
      .replace(/([\w)])\s*[×*]\s*([\w(])/g, "$1 times $2")
      .replace(/([\w)])\s*÷\s*([\w(])/g, "$1 divided by $2")
      .replace(/([\w)])\s*=\s*([\w(])/g, "$1 equals $2")
      .replace(/²/g, " squared")
      .replace(/³/g, " cubed")
      .replace(/\(/g, " open parenthesis ")
      .replace(/\)/g, " close parenthesis ");
  });
  return lines.join(" ").replace(/[{}$#&]/g, " ").replace(/\s+/g, " ").trim();
}

function splitSpeechChunks(text) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const next = `${current}${current ? " " : ""}${sentence.trim()}`;
    if (next.length > 320 && current) { chunks.push(current); current = sentence.trim(); }
    else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function installRealtimeTutor({ apiBaseUrl, getAccessToken, ensureInspection, getContext, onTranscript, onTutorReply, onError }) {
  const voiceBaseUrl = (window.SHARPERTIME_VOICE_BASE_URL || `${apiBaseUrl}/voice`).replace(/\/$/, "");
  let client = null;
  let activeContext = "";
  let lastSpeechText = "";
  let isSpeaking = false;
  let stopping = false;
  let muted = false;
  let currentUtteranceId = 0;

  const panels = [...document.querySelectorAll("[data-live-panel]")];
  const launchButtons = [...document.querySelectorAll("[data-live-start]")];
  const voiceSelects = [...document.querySelectorAll("[data-live-voice]")];
  const savedVoice = localStorage.getItem(VOICE_KEY) || "";

  function panel(context) { return panels.find((item) => item.dataset.livePanel === context); }

  function setStatus(context, message, kind = "") {
    const target = panel(context)?.querySelector("[data-live-status]");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("is-error", kind === "error");
    target.classList.toggle("is-success", kind === "success");
  }

  function setPanels(context = "", sessionActive = Boolean(context)) {
    panels.forEach((item) => { item.hidden = !context || item.dataset.livePanel !== context; });
    launchButtons.forEach((button) => {
      const isActive = sessionActive && button.dataset.liveStart === context;
      button.setAttribute("aria-pressed", String(isActive));
      button.disabled = sessionActive && button.dataset.liveStart !== context;
      const label = button.dataset.liveStart === "ask" ? "Talk to tutor" : "Talk through this question";
      button.querySelector("span")?.replaceChildren(document.createTextNode(isActive ? "Session active" : label));
    });
    document.querySelectorAll("[data-live-action='mute']").forEach((button) => {
      button.disabled = !sessionActive;
      button.setAttribute("aria-pressed", String(Boolean(context && muted)));
      button.textContent = muted ? "Unmute microphone" : "Mute microphone";
    });
    document.querySelectorAll("[data-live-action='end'],[data-live-action='stop-speaking']").forEach((button) => { button.disabled = !sessionActive; });
    document.querySelectorAll("[data-live-action='repeat']").forEach((button) => { button.disabled = !sessionActive || !lastSpeechText; });
  }

  function readAvailableVoices() {
    if (!window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    voiceSelects.forEach((select) => {
      const selected = select.value || savedVoice;
      select.replaceChildren();
      const automatic = document.createElement("option");
      automatic.value = "";
      automatic.textContent = "Device default voice";
      select.append(automatic);
      voices.forEach((voice) => {
        const option = document.createElement("option");
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        select.append(option);
      });
      select.value = voices.some((voice) => voice.voiceURI === selected) ? selected : "";
      select.disabled = voices.length === 0;
    });
  }

  function selectedVoice() {
    const uri = voiceSelects.find((select) => select.dataset.livePanelVoice === activeContext)?.value
      || voiceSelects.find((select) => select.value)?.value || localStorage.getItem(VOICE_KEY) || "";
    return window.speechSynthesis?.getVoices().find((voice) => voice.voiceURI === uri) || null;
  }

  function stopSpeaking() {
    currentUtteranceId += 1;
    isSpeaking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function speak(text) {
    const speechText = mathTextForSpeech(text);
    lastSpeechText = speechText;
    document.querySelectorAll("[data-live-action='repeat']").forEach((button) => { button.disabled = !activeContext || !speechText; });
    if (!speechText || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      setStatus(activeContext, "Tutor reply is shown in the transcript. This browser has no speech voice available.");
      return;
    }
    stopSpeaking();
    const utteranceId = currentUtteranceId;
    const voice = selectedVoice();
    const chunks = splitSpeechChunks(speechText);
    isSpeaking = true;
    setStatus(activeContext, "Tutor is speaking. You can interrupt or stop the voice.");
    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = voice?.lang || "en-ZA";
      utterance.rate = 0.96;
      if (voice) utterance.voice = voice;
      utterance.onend = () => {
        if (utteranceId !== currentUtteranceId) return;
        if (index === chunks.length - 1) {
          isSpeaking = false;
          if (activeContext) setStatus(activeContext, muted ? "Microphone muted. Unmute to continue." : "Listening. Ask another question whenever you are ready.", "success");
        }
      };
      utterance.onerror = (event) => {
        if (utteranceId === currentUtteranceId && event.error !== "canceled" && event.error !== "interrupted") {
          isSpeaking = false;
          setStatus(activeContext, "The reply is visible, but this device could not play its voice.");
        }
      };
      window.speechSynthesis.speak(utterance);
    });
  }

  function showSessionMessage(kind, text) {
    if (!text) return;
    if (kind === "transcript") onTranscript(activeContext, text);
    else if (kind === "tutor_reply") {
      onTutorReply(activeContext, text);
      speak(text);
    } else if (kind === "thinking") setStatus(activeContext, "Thinking through your question…");
    else if (kind === "error") {
      setStatus(activeContext, text || "The voice session needs to reconnect. Try again or type your question.", "error");
      onError?.(activeContext, text);
    }
  }

  function handleServerMessage(message) {
    const payload = message?.data && typeof message.data === "object" ? message.data : message;
    if (payload?.type) showSessionMessage(payload.type, String(payload.text || payload.message || ""));
  }

  async function createSession(context) {
    const token = getAccessToken();
    if (!token) throw new Error("Sign in again before starting a live tutor session.");
    const response = await fetch(`${voiceBaseUrl}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(context),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.session_token) {
      throw new Error(body.detail || body.message || "The live tutor service is not available yet. Please type your question or try again later.");
    }
    return body;
  }

  async function start(contextType) {
    if (client) {
      if (activeContext === contextType) await stop();
      return;
    }
    if (window.isSecureContext === false) {
      setStatus(contextType, "Microphone access needs HTTPS or localhost. On this computer, open http://localhost:5501/app/; hotspot devices need a trusted HTTPS link. You can still type here.", "error");
      panel(contextType).hidden = false;
      return;
    }
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      setStatus(contextType, "Live audio is not supported by this browser. You can still type or record a voice note.", "error");
      panel(contextType).hidden = false;
      return;
    }
    activeContext = contextType;
    stopping = false;
    muted = false;
    if (contextType === "practice") panel(contextType)?.querySelector("[data-live-transcript]")?.replaceChildren();
    setPanels(activeContext);
    setStatus(activeContext, "Preparing your tutoring session…");
    try {
      const inspectionId = await ensureInspection(contextType);
      const context = await getContext(contextType, inspectionId);
      const session = await createSession(context);
      const sessionClient = new PipecatClient({
        transport: new SmallWebRTCTransport({
          iceServers: session.ice_servers?.length
            ? session.ice_servers
            : window.SHARPERTIME_VOICE_ICE_SERVERS || [{ urls: "stun:stun.l.google.com:19302" }],
        }),
        enableCam: false,
        enableMic: true,
        callbacks: {
          onConnected: () => setStatus(activeContext, "Connected. Start speaking when you are ready.", "success"),
          onDisconnected: () => {
            if (!stopping) {
              stopSpeaking();
              client = null;
              activeContext = "";
              setPanels(contextType, false);
              setStatus(contextType, "The live connection ended. Your written conversation is still here.");
            }
          },
          onTransportStateChanged: (transportState) => {
            const status = {
              initializing: "Requesting microphone access…",
              connecting: "Connecting to the live tutor…",
              disconnecting: "Ending the live session…",
              error: "The audio connection failed. Check your connection and try again.",
            }[transportState];
            if (status) setStatus(activeContext || contextType, status, transportState === "error" ? "error" : "");
          },
          onUserStartedSpeaking: () => {
            if (isSpeaking) stopSpeaking();
            if (activeContext && !muted) setStatus(activeContext, "Listening to you…");
          },
          onServerMessage: handleServerMessage,
          onError: (message) => showSessionMessage("error", message?.data?.message || message?.message || "The live audio connection reported an error."),
        },
      });
      client = sessionClient;
      await sessionClient.connect({
        webrtcRequestParams: {
          endpoint: session.offer_endpoint ? new URL(session.offer_endpoint, `${voiceBaseUrl}/`).href : `${voiceBaseUrl}/offer`,
          requestData: { session_token: session.session_token },
        },
      });
      setStatus(activeContext, "Listening. Ask a question or talk through a step.", "success");
    } catch (error) {
      const failedContext = activeContext || contextType;
      if (client) {
        stopping = true;
        try { await client.disconnect(); } catch { /* failed connection already closed */ }
      }
      client = null;
      stopSpeaking();
      setPanels(failedContext, false);
      activeContext = "";
      setStatus(failedContext, error.message || "Could not start the live tutor. Try again or use the text box.", "error");
    }
  }

  async function stop() {
    const oldContext = activeContext;
    stopping = true;
    stopSpeaking();
    muted = false;
    if (client) {
      try { await client.disconnect(); } catch { /* transport may already be closed */ }
    }
    client = null;
    activeContext = "";
    setPanels("");
    if (oldContext) setStatus(oldContext, "Session ended. You can continue by typing here.");
    stopping = false;
  }

  launchButtons.forEach((button) => button.addEventListener("click", () => start(button.dataset.liveStart)));
  panels.forEach((item) => {
    const context = item.dataset.livePanel;
    item.querySelector("[data-live-action='mute']")?.addEventListener("click", (event) => {
      if (!client) return;
      muted = !muted;
      client.enableMic(!muted);
      event.currentTarget.setAttribute("aria-pressed", String(muted));
      event.currentTarget.textContent = muted ? "Unmute microphone" : "Mute microphone";
      setStatus(context, muted ? "Microphone muted. Unmute when you are ready to speak." : "Listening. Ask a question whenever you are ready.");
    });
    item.querySelector("[data-live-action='stop-speaking']")?.addEventListener("click", () => {
      stopSpeaking();
      if (activeContext) setStatus(activeContext, "Tutor voice stopped. The reply remains in your transcript.");
    });
    item.querySelector("[data-live-action='repeat']")?.addEventListener("click", () => lastSpeechText && speak(lastSpeechText));
    item.querySelector("[data-live-action='end']")?.addEventListener("click", stop);
    item.querySelector("[data-live-voice]")?.addEventListener("change", (event) => {
      localStorage.setItem(VOICE_KEY, event.currentTarget.value || "");
      voiceSelects.forEach((select) => { if (select !== event.currentTarget) select.value = event.currentTarget.value; });
    });
  });
  if (window.speechSynthesis) {
    readAvailableVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", readAvailableVoices);
    window.addEventListener("beforeunload", stopSpeaking);
  }
  setPanels("");

  return {
    stop,
    stopIfContext(contextType) { if (activeContext === contextType) void stop(); },
    get activeContext() { return activeContext; },
  };
}
