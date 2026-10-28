import { TUTOR_LANGUAGES, languageForValue } from "./tutor-languages.mjs";

const VOICE_KEY = "sharperx_device_voice_uri";
const TRANSCRIPTS_KEY = "sharperx_live_auto_transcription";
const LETTER_NAMES = {
  a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "eff", g: "jee", h: "aitch",
  i: "eye", j: "jay", k: "kay", l: "ell", m: "em", n: "en", o: "oh", p: "pee",
  q: "cue", r: "ar", s: "ess", t: "tee", u: "you", v: "vee", w: "double you",
  x: "ex", y: "why", z: "zed",
};

function sanitizeTutorText(value) {
  return String(value || "")
    .replace(/gpt\s*[- ]?\s*6\s*[- ]?\s*luna/gi, "tutor")
    .replace(/\bluna\b/gi, "tutor")
    .replace(/\bunimernet\b/gi, "handwriting recognition")
    .trim();
}
const LANGUAGE_KEY = "sharperx_live_tutor_language";

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

const SPEECH_SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const SPEECH_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function integerToSpeechWords(value) {
  if (value < 20) return SPEECH_SMALL_NUMBERS[value];
  if (value < 100) return `${SPEECH_TENS[Math.floor(value / 10)]}${value % 10 ? ` ${SPEECH_SMALL_NUMBERS[value % 10]}` : ""}`;
  if (value < 1000) {
    const remainder = value % 100;
    return `${SPEECH_SMALL_NUMBERS[Math.floor(value / 100)]} hundred${remainder ? ` and ${integerToSpeechWords(remainder)}` : ""}`;
  }

  const scale = value >= 1000000 ? 1000000 : 1000;
  const scaleName = scale === 1000000 ? "million" : "thousand";
  const remainder = value % scale;
  const joiner = remainder && remainder < 100 ? " and " : " ";
  return `${integerToSpeechWords(Math.floor(value / scale))} ${scaleName}${remainder ? `${joiner}${integerToSpeechWords(remainder)}` : ""}`;
}

function numberToSpeechWords(value) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, decimalPart] = unsigned.split(".");
  const integerValue = Number(integerPart);
  // Keep unusually large values intact rather than reading them inaccurately.
  if (!Number.isSafeInteger(integerValue) || integerValue > 999999999) return value;
  const whole = integerToSpeechWords(integerValue);
  const decimal = decimalPart ? ` point ${decimalPart.split("").map((digit) => SPEECH_SMALL_NUMBERS[Number(digit)]).join(" ")}` : "";
  return `${negative ? "negative " : ""}${whole}${decimal}`;
}

function normalizeSpeechNumbers(value) {
  // Separate a coefficient from its variable first: 2x becomes “two x”.
  const separatedCoefficients = value.replace(/(\d+(?:\.\d+)?)(?=[A-Za-z])/g, "$1 ");
  return separatedCoefficients.replace(/(^|[^A-Za-z0-9.])(-?\d+(?:\.\d+)?)(?![A-Za-z0-9])/g, (_, prefix, number) => `${prefix}${numberToSpeechWords(number)}`);
}

function normalizeRecurringDecimals(value) {
  return String(value || "").replace(
    /(?<![\d.])(-?\d+)\.(\d*)((?:(?:\\(?:overline|bar|dot)\s*\{\d+\})|(?:\d[\u0305\u0307]))+)(?!\d)/g,
    (_, whole, nonRecurring, markedDigits) => {
      const recurring = markedDigits
        .replace(/\\(?:overline|bar|dot)\s*\{(\d+)\}/g, "$1")
        .replace(/[\u0305\u0307]/g, "");
      return `${whole}.${nonRecurring}${nonRecurring ? ", " : ""}${recurring} recurring`;
    },
  );
}

function normalizeAlgebraLetterNames(value) {
  return value
    .replace(/\bax\b/gi, "ay times ex")
    .replace(/\ba\s+x\b/gi, "ay times ex")
    .replace(/(^|\b(?:equals|plus|minus|times|over|divided by)\s+)a(?=\s+(?:squared|cubed|to the power|plus|minus|times|over|equals)\b|\s*[,.;!?]|$)/gi, "$1ay")
    .replace(/\bthe point\s+a\b/gi, "the point ay")
    .replace(/\b([xyq])\b/gi, (letter) => LETTER_NAMES[letter.toLowerCase()]);
}

function normalizeEquationCalls(value) {
  const pattern = /\bEq\s*\(/g;
  let output = "";
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value))) {
    const open = match.index + match[0].lastIndexOf("(");
    let depth = 1;
    let comma = -1;
    let close = -1;
    for (let index = open + 1; index < value.length; index += 1) {
      const character = value[index];
      if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") {
        depth -= 1;
        if (depth === 0) { close = index; break; }
      } else if (character === "," && depth === 1 && comma < 0) comma = index;
    }
    if (close < 0 || comma < 0) continue;
    output += value.slice(cursor, match.index);
    const left = normalizeEquationCalls(value.slice(open + 1, comma)).trim();
    const right = normalizeEquationCalls(value.slice(comma + 1, close)).trim();
    output += `the equation ${left} equals ${right}`;
    cursor = close + 1;
    pattern.lastIndex = cursor;
  }
  return output ? output + value.slice(cursor) : value;
}

export function mathTextForSpeech(value) {
  let text = normalizeRecurringDecimals(String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\\begin\{(?:aligned|align\*?|array|matrix|cases)\}|\\end\{(?:aligned|align\*?|array|matrix|cases)\}/g, " ")
    .replace(/\\\\/g, ". "))
    .replace(/\\\(|\\\)|\\\[|\\\]|\$\$?/g, " ")
    .replace(/\bsection\s+([a-z])\b/gi, (_, letter) => `Section ${LETTER_NAMES[letter.toLowerCase()] || letter}`)
    .replace(/(^|\n)\s*([a-z])\.\s*(?=(?:solve|find|calculate|determine|simplify|factorise|factorize|show|prove)\b)/gi,
      (_, prefix, letter) => `${prefix}Part ${LETTER_NAMES[letter.toLowerCase()] || letter}. `)
    .replace(/\bheads\s*\/\s*tails\b/gi, "heads or tails");
  text = normalizeEquationCalls(text);
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

  const speakGroups = (value) => {
    let output = value;
    for (let pass = 0; pass < 8; pass += 1) {
      const before = output;
      output = output
        .replace(/\(([^()]*)\)/g, (_, inner) => ` the quantity ${inner.trim()} `)
        .replace(/\[([^\[\]]*)\]/g, (_, inner) => ` the quantity ${inner.trim()} `)
        .replace(/\{([^{}]*)\}/g, (_, inner) => ` the quantity ${inner.trim()} `);
      if (output === before) break;
    }
    return output.replace(/[()[\]{}]/g, " ");
  };

  const lines = text.split(/\r?\n/).map((line) => {
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
    const isMath = /(?:=|<|>|\^|_|\b(?:squared|cubed|over|times|divided by|plus|minus|equals|is less than|is greater than|is not equal|is approximately|sine|cosine|tangent|square root|to the power of)\b|\\(?:sin|cos|tan|frac|sqrt|int|sum)\b|\b(?:sin|cos|tan)\s*\(|\(\s*[+-]?\d+(?:\.\d+)?\s*[;,]\s*[+-]?\d+(?:\.\d+)?\s*\)|\d\s*[+\-*/]\s*\d|[A-Za-z)]\s*=\s*[A-Za-z0-9(]|\b[A-Za-z]\s+[+\-*/]\s+[A-Za-z0-9(]|\b[A-Za-z]\s*[+*/]\s*[A-Za-z0-9(]|\b[A-Za-z]\s*-\s*\d)/.test(line);
    if (!isMath) return normalizeSpeechNumbers(line.replace(/[()[\]{}]/g, " "));
    const spokenMath = speakLatex(line)
      .replace(/\b(sin|cos|tan)\s*\(([^()]*)\)/gi, (_, fn, argument) => `${({ sin: "sine", cos: "cosine", tan: "tangent" })[fn.toLowerCase()]} of ${argument}`)
      .replace(/\b(sine|cosine|tangent)\s*\(([^()]*)\)/gi, "$1 of $2")
      .replace(/\(\s*([+-]?\d+(?:\.\d+)?)\s*[;,]\s*([+-]?\d+(?:\.\d+)?)\s*\)/g, "the point $1, $2");
    const spoken = speakGroups(spokenMath
      .replace(/([\w)])\s*\+\s*([\w(])/g, "$1 plus $2")
      .replace(/([\w)])\s*-\s*([\w(])/g, "$1 minus $2")
      .replace(/([\w)])\s*[×*]\s*([\w(])/g, "$1 times $2")
      .replace(/([\w)])\s*÷\s*([\w(])/g, "$1 divided by $2")
      .replace(/([\w)])\s*\/\s*([\w(])/g, "$1 over $2")
      .replace(/([\w)])\s*=\s*([\w(])/g, "$1 equals $2")
      .replace(/([\w)])\s*<\s*([\w(])/g, "$1 is less than $2")
      .replace(/([\w)])\s*>\s*([\w(])/g, "$1 is greater than $2")
      .replace(/²/g, " squared")
      .replace(/³/g, " cubed"));
    return normalizeSpeechNumbers(normalizeAlgebraLetterNames(spoken.replace(/([A-Za-z0-9])\s+(?=the quantity|the fraction|square root of)/g, "$1 times ")));
  });
  return lines.join("\n").replace(/[{}$#&]/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function splitSpeechChunks(text) {
  const chunks = [];
  for (const line of text.split(/\n+/)) {
    const decimalMarker = "\uE000";
    const safeLine = line.replace(/(\d)\.(\d)/g, `$1${decimalMarker}$2`);
    const sentences = safeLine.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    for (const sentence of sentences.map((part) => part.split(decimalMarker).join(".").trim()).filter(Boolean)) {
      if (sentence.length <= 320) {
        chunks.push(sentence);
        continue;
      }
      let current = "";
      for (const word of sentence.split(/\s+/)) {
        if (current && `${current} ${word}`.length > 320) {
          chunks.push(current);
          current = word;
        } else current = `${current}${current ? " " : ""}${word}`;
      }
      if (current) chunks.push(current);
    }
  }
  return chunks;
}

function stopMicrophoneStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function encodeMonoPcmWav(frames, sampleRate) {
  const sampleCount = frames.reduce((total, frame) => total + frame.length, 0);
  if (!sampleCount) return null;
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + (sampleCount * bytesPerSample));
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * bytesPerSample, true);
  let offset = 44;
  frames.forEach((frame) => {
    for (let index = 0; index < frame.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, frame[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  });
  return new Blob([buffer], { type: "audio/wav" });
}

function createSpeechCapture(stream, { onSpeechStart, onSpeechEnd, onUtterance, onNoSpeech, onSilenceTimeout, isEnabled, onPushToTalkChange }) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Live voice recording is not supported by this browser. Use the Voice note button instead.");

  const audioContext = new AudioContextClass();
  if (!audioContext.createScriptProcessor || !audioContext.createGain) {
    void audioContext.close().catch(() => {});
    throw new Error("Live voice recording is not supported by this browser. Use the Voice note button instead.");
  }
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;
  source.connect(analyser);
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);
  const samples = new Float32Array(analyser.fftSize);
  const MIN_VOICE_FRAMES = 4;
  const SILENCE_TIMEOUT_MS = 10_000;
  const microphoneTrack = stream.getAudioTracks()[0];
  let utteranceFrames = [];
  let closed = false;
  let pushToTalkActive = false;
  let voiceFrames = 0;
  let lastSpeechAt = 0;
  let noiseFloor = 0.003;
  let calibrationFrames = 0;
  if (microphoneTrack) microphoneTrack.enabled = false;

  function setPushToTalk(active) {
    if (closed || pushToTalkActive === active) return false;
    pushToTalkActive = active;
    if (microphoneTrack) microphoneTrack.enabled = active;
    onPushToTalkChange?.(active);
    return true;
  }

  function finishUtterance({ submit = true } = {}) {
    if (!pushToTalkActive) return false;
    setPushToTalk(false);
    onSpeechEnd?.();
    const frames = utteranceFrames;
    const capturedVoiceFrames = voiceFrames;
    utteranceFrames = [];
    voiceFrames = 0;
    if (submit && frames.length && capturedVoiceFrames >= MIN_VOICE_FRAMES) {
      const blob = encodeMonoPcmWav(frames, audioContext.sampleRate);
      if (blob?.size > 800) onUtterance?.(blob);
      else onNoSpeech?.();
    } else if (submit) onNoSpeech?.();
    return true;
  }

  function discardSilentUtterance() {
    if (!finishUtterance({ submit: false })) return false;
    onSilenceTimeout?.();
    return true;
  }

  processor.onaudioprocess = (event) => {
    event.outputBuffer?.getChannelData(0)?.fill(0);
    if (closed || !pushToTalkActive || isEnabled?.() === false) return;
    const input = event.inputBuffer?.getChannelData(0);
    if (input?.length) utteranceFrames.push(new Float32Array(input));
  };

  const monitor = setInterval(() => {
    // Audio levels are inspected only while the learner has explicitly
    // started push-to-talk. Ten seconds without speech stops and discards the
    // clip; it never submits a silent recording.
    if (closed || !pushToTalkActive || isEnabled?.() === false) return;
    analyser.getFloatTimeDomainData(samples);
    let squareTotal = 0;
    let peak = 0;
    let activeSamples = 0;
    let zeroCrossings = 0;
    const activityFloor = Math.max(0.0015, noiseFloor * 0.35);
    let previousSample = samples[0] || 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      squareTotal += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      if (Math.abs(sample) > activityFloor) activeSamples += 1;
      if ((sample >= 0) !== (previousSample >= 0)) zeroCrossings += 1;
      previousSample = sample;
    }
    const level = Math.sqrt(squareTotal / samples.length);
    const startThreshold = Math.max(0.006, Math.min(0.025, noiseFloor * 3));
    const activityRatio = activeSamples / samples.length;
    const speechLikeFrame = level >= startThreshold
      && activityRatio >= 0.1
      && zeroCrossings >= 3
      && peak < level * 10;
    if (speechLikeFrame) {
      voiceFrames += 1;
      lastSpeechAt = performance.now();
      if (voiceFrames === 1) onSpeechStart?.();
    } else {
      calibrationFrames += 1;
      noiseFloor = calibrationFrames < 20
        ? (noiseFloor * 0.8) + (level * 0.2)
        : (noiseFloor * 0.995) + (Math.min(level, startThreshold) * 0.005);
      if (performance.now() - lastSpeechAt >= SILENCE_TIMEOUT_MS) {
        discardSilentUtterance();
      }
    }
  }, 50);

  return {
    async ready() { if (audioContext.state === "suspended") await audioContext.resume(); },
    get isPushToTalkActive() { return pushToTalkActive; },
    startPushToTalk() {
      if (closed || pushToTalkActive || isEnabled?.() === false) return false;
      utteranceFrames = [];
      voiceFrames = 0;
      calibrationFrames = 0;
      lastSpeechAt = performance.now();
      return setPushToTalk(true);
    },
    stopPushToTalk() { return finishUtterance(); },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(monitor);
      processor.onaudioprocess = null;
      utteranceFrames = [];
      pushToTalkActive = false;
      if (microphoneTrack) microphoneTrack.enabled = false;
      onPushToTalkChange?.(false);
      [source, processor, silentOutput].forEach((node) => {
        try { node.disconnect(); } catch { /* already disconnected */ }
      });
      void audioContext.close().catch(() => {});
    },
    setMuted(value) {
      if (value && pushToTalkActive) finishUtterance({ submit: false });
      if (microphoneTrack) microphoneTrack.enabled = pushToTalkActive && !value;
    },
  };
}

export function installRealtimeTutor({ ensureInspection, getContext, transcribeAudio, askTutorTurn, onTranscript, onTutorReply, onError, onPushToTalkChange, getLoginGreeting }) {
  let capture = null;
  let microphoneStream = null;
  let activeContext = "";
  let sessionInspectionId = "";
  let starting = false;
  let startGeneration = 0;
  let turnQueue = Promise.resolve();
  let lastSpeechText = "";
  let lastTutorReplyText = "";
  let lastTutorResponse = "";
  let learnerTurnPendingReply = true;
  let isSpeaking = false;
  let isSpeechPaused = false;
  let transcriptsEnabled = localStorage.getItem(TRANSCRIPTS_KEY) !== "false";
  let muted = false;
  let currentUtteranceId = 0;
  let lastSpeechContext = "";
  let speechTimer = null;
  let continueSpeechQueue = null;
  let currentChunkSpeaking = false;
  let pushToTalkStarting = false;
  let availableVoices = [];
  let responseLanguageGeneration = 0;

  const panels = [...document.querySelectorAll("[data-live-panel]")];
  const launchButtons = [...document.querySelectorAll("[data-live-start]")];
  const voiceSelects = [...document.querySelectorAll("[data-live-voice]")];
  const languageSelects = [...document.querySelectorAll("[data-live-language]")];
  const savedLanguage = localStorage.getItem(LANGUAGE_KEY) || "en-ZA";

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
      button.disabled = starting || (sessionActive && button.dataset.liveStart !== context);
      const label = "Talk to tutor";
      button.querySelector("span")?.replaceChildren(document.createTextNode(isActive ? "Session active" : label));
    });
    document.querySelectorAll("[data-live-action='mute']").forEach((button) => {
      button.disabled = !sessionActive;
      button.setAttribute("aria-pressed", String(Boolean(context && muted)));
      button.textContent = muted ? "Unmute microphone" : "Mute microphone";
    });
    document.querySelectorAll("[data-live-action='end']").forEach((button) => { button.disabled = !sessionActive; });
    document.querySelectorAll("[data-live-action='stop-speaking']").forEach((button) => { button.disabled = !sessionActive && !isSpeaking; });
    document.querySelectorAll("[data-live-action='pause-speaking']").forEach((button) => { button.disabled = !isSpeaking || isSpeechPaused; });
    document.querySelectorAll("[data-live-action='resume-speaking']").forEach((button) => { button.disabled = !isSpeaking || !isSpeechPaused; });
    document.querySelectorAll("[data-live-action='repeat']").forEach((button) => { button.disabled = !lastSpeechText; });
    document.querySelectorAll("[data-live-action='transcripts']").forEach((button) => {
      button.setAttribute("aria-pressed", String(transcriptsEnabled));
      button.textContent = `Show transcript: ${transcriptsEnabled ? "On" : "Off"}`;
    });
  }

  function voiceMatchesLanguage(voice, language) {
    const voiceCode = String(voice?.lang || "").replace(/_/g, "-").split("-", 1)[0].toLowerCase();
    return Boolean(voiceCode && voiceCode === String(language?.code || "").toLowerCase());
  }

  function renderVoiceSelects({ resetSelection = false } = {}) {
    const language = selectedLanguage();
    const matchingVoices = availableVoices.filter((voice) => voiceMatchesLanguage(voice, language));
    voiceSelects.forEach((select) => {
      const selected = resetSelection ? "" : (select.value || localStorage.getItem(VOICE_KEY) || "");
      const status = select.closest("label")?.querySelector("[data-live-voice-status]");
      select.replaceChildren();
      if (!matchingVoices.length) {
        const unavailable = document.createElement("option");
        unavailable.value = "";
        unavailable.textContent = `No ${language.label} voice installed`;
        unavailable.disabled = true;
        select.append(unavailable);
        select.value = "";
        select.disabled = true;
        select.setAttribute("aria-label", `No ${language.label} speech voice is installed on this device`);
        if (status) status.textContent = `The tutor can reply in ${language.label}, but this device needs a ${language.label} speech voice to play it aloud. Add one in the device's speech or text-to-speech settings.`;
        return;
      }

      const automatic = document.createElement("option");
      automatic.value = "";
      automatic.textContent = `Automatic ${language.label} voice`;
      select.append(automatic);
      matchingVoices.forEach((voice) => {
        const option = document.createElement("option");
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        select.append(option);
      });
      select.value = matchingVoices.some((voice) => voice.voiceURI === selected) ? selected : "";
      select.disabled = false;
      select.setAttribute("aria-label", `Choose a voice for ${language.label}`);
      if (status) status.textContent = `${matchingVoices.length} ${language.label} voice${matchingVoices.length === 1 ? "" : "s"} available on this device.`;
    });
  }

  function readAvailableVoices() {
    availableVoices = window.speechSynthesis?.getVoices() || [];
    const options = TUTOR_LANGUAGES;
    localStorage.setItem(LANGUAGE_KEY, "en-ZA");
    languageSelects.forEach((select) => {
      const selected = select.value || localStorage.getItem(LANGUAGE_KEY) || savedLanguage;
      select.replaceChildren();
      options.forEach((language) => {
        const option = document.createElement("option");
        option.value = language.value;
        option.textContent = language.label;
        option.disabled = Boolean(language.disabled);
        select.append(option);
      });
      const selectedOption = [...select.options].find((option) => option.value.toLowerCase() === selected.toLowerCase() && !option.disabled);
      const fallback = [...select.options].find((option) => option.value === "en-ZA");
      select.value = selectedOption?.value || fallback?.value || "en-ZA";
    });
    renderVoiceSelects();
  }

  function selectedLanguage() {
    const current = languageSelects.find((select) => select.closest("[data-live-panel]")?.dataset.livePanel === (activeContext || lastSpeechContext))?.value
      || languageSelects.find((select) => select.value)?.value
      || localStorage.getItem(LANGUAGE_KEY)
      || "en-ZA";
    return languageForValue(current);
  }

  function selectedVoice(context = activeContext || lastSpeechContext) {
    const language = selectedLanguage();
    const select = voiceSelects.find((item) => item.closest("[data-live-panel]")?.dataset.livePanel === context);
    const uri = select ? select.value : (localStorage.getItem(VOICE_KEY) || "");
    const explicit = uri ? availableVoices.find((voice) => voice.voiceURI === uri) : null;
    if (explicit && voiceMatchesLanguage(explicit, language)) return explicit;
    return availableVoices.find((voice) => voice.lang?.toLowerCase() === language.locale.toLowerCase())
      || availableVoices.find((voice) => voiceMatchesLanguage(voice, language))
      || null;
  }

  function primeSpeechFromGesture() {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
    try {
      stopSpeaking();
      window.speechSynthesis.resume();
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0;
      window.speechSynthesis.speak(unlock);
      window.speechSynthesis.resume();
    } catch { /* Speech output is optional; the tutor reply remains visible. */ }
  }

  function stopSpeaking() {
    currentUtteranceId += 1;
    isSpeaking = false;
    isSpeechPaused = false;
    currentChunkSpeaking = false;
    continueSpeechQueue = null;
    if (speechTimer !== null) clearTimeout(speechTimer);
    speechTimer = null;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setPanels(activeContext || "", Boolean(activeContext));
  }

  function pauseSpeaking(context = activeContext) {
    if (!isSpeaking || !window.speechSynthesis) return;
    window.speechSynthesis.pause();
    isSpeechPaused = true;
    setPanels(context, context === activeContext);
    if (context) setStatus(context, "Tutor speech paused. Press Resume speaking when you are ready.");
  }

  function resumeSpeaking(context = activeContext) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.resume();
    if (isSpeaking) {
      isSpeechPaused = false;
      if (!currentChunkSpeaking && continueSpeechQueue) {
        if (speechTimer !== null) clearTimeout(speechTimer);
        speechTimer = null;
        continueSpeechQueue();
      }
    }
    setPanels(context, context === activeContext);
    if (context && isSpeaking) setStatus(context, "Tutor is speaking.", "success");
  }

  function speak(text, context = activeContext || lastSpeechContext, callbacks = {}) {
    const speechText = mathTextForSpeech(text);
    lastSpeechText = speechText;
    lastSpeechContext = context || "";
    document.querySelectorAll("[data-live-action='repeat']").forEach((button) => { button.disabled = !speechText; });
    if (context && context !== activeContext) setPanels(context, false);
    if (!speechText || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      if (context) setStatus(context, "Tutor reply is shown in the transcript. This browser has no speech voice available.");
      callbacks.onError?.("speech-unavailable");
      return;
    }
    stopSpeaking();
    const utteranceId = currentUtteranceId;
    const language = selectedLanguage();
    const voice = selectedVoice(context);
    if (!voice) {
      if (context) setStatus(context, `The tutor reply is in ${language.label}, but no matching speech voice is installed on this device. The reply remains available in the transcript.`);
      callbacks.onError?.("voice-unavailable");
      return;
    }
    const chunks = splitSpeechChunks(speechText);
    isSpeaking = true;
    isSpeechPaused = false;
    setPanels(context || "", Boolean(context && context === activeContext));
    if (context) setStatus(context, "Tutor is speaking. You can interrupt or stop the voice.");
    let index = 0;
    const speakNext = () => {
      if (utteranceId !== currentUtteranceId || !isSpeaking) return;
      if (isSpeechPaused) return;
      const chunk = chunks[index++];
      if (!chunk) {
        isSpeaking = false;
        isSpeechPaused = false;
        currentChunkSpeaking = false;
        continueSpeechQueue = null;
        if (activeContext === context && context) {
          setStatus(context, muted ? "Microphone muted. Unmute to continue." : "Your turn. Press Voice, speak, then press Voice again to send.", "success");
        } else if (context) {
          setStatus(context, "Tutor reply spoken. Press Repeat tutor to hear it again.", "success");
          setPanels(context, false);
        }
        setPanels(activeContext || context || "", Boolean(activeContext));
        callbacks.onComplete?.();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = language.locale;
      utterance.rate = 0.84;
      if (voice) utterance.voice = voice;
      currentChunkSpeaking = true;
      utterance.onstart = () => {
        if (utteranceId === currentUtteranceId) callbacks.onStart?.();
      };
      utterance.onend = () => {
        if (utteranceId !== currentUtteranceId) return;
        currentChunkSpeaking = false;
        if (index < chunks.length) {
          speechTimer = setTimeout(() => {
            speechTimer = null;
            speakNext();
          }, 420);
        } else speakNext();
      };
      utterance.onerror = (event) => {
        if (utteranceId === currentUtteranceId && event.error !== "canceled" && event.error !== "interrupted") {
          isSpeaking = false;
          isSpeechPaused = false;
          currentChunkSpeaking = false;
          continueSpeechQueue = null;
          if (context) setStatus(context, "The reply is visible, but this device could not play its voice. Press Repeat tutor to try again.");
          setPanels(activeContext || context || "", Boolean(activeContext));
          callbacks.onError?.(event.error || "speech-error");
        }
      };
      window.speechSynthesis.speak(utterance);
    };
    continueSpeechQueue = speakNext;
    speakNext();
    window.speechSynthesis.resume();
  }

  function handleLanguageChange(event) {
    const language = languageForValue(event.currentTarget.value);
    localStorage.setItem(LANGUAGE_KEY, language.value);
    languageSelects.forEach((select) => { select.value = "en-ZA"; });
    localStorage.removeItem(VOICE_KEY);
    voiceSelects.forEach((select) => { select.value = ""; });
    renderVoiceSelects({ resetSelection: true });
    responseLanguageGeneration += 1;
    if (isSpeaking) stopSpeaking();
    if (activeContext) setStatus(activeContext, `Tutor language: ${language.label}.`);
  }

  function showSessionMessage(kind, text) {
    if (!text) return;
    if (kind === "transcript") {
      learnerTurnPendingReply = true;
      if (transcriptsEnabled) onTranscript(activeContext, text);
      if (activeContext) setStatus(activeContext, "I heard you. Thinking through your question…");
    }
    else if (kind === "tutor_reply") {
      const safeText = sanitizeTutorText(text);
      const replyKey = safeText.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      if (!replyKey || (replyKey === lastTutorReplyText && !learnerTurnPendingReply)) return;
      lastTutorReplyText = replyKey;
      lastTutorResponse = safeText;
      learnerTurnPendingReply = false;
      if (transcriptsEnabled) onTutorReply(activeContext, safeText);
      speak(safeText);
    } else if (kind === "thinking") setStatus(activeContext, "Thinking through your question…");
    else if (kind === "error") {
      const safeText = sanitizeTutorText(text);
      setStatus(activeContext, safeText || "The voice session needs to reconnect. Try again or type your question.", "error");
      onError?.(activeContext, safeText);
    }
  }

  async function handleUtterance(blob, contextType, inspectionId, generation) {
    if (generation !== startGeneration || activeContext !== contextType || muted) return;
    if (!transcribeAudio || !askTutorTurn) throw new Error("Live transcription is not configured. Use the Voice note button instead.");
    setStatus(contextType, "Transcribing your speech…");
    const language = selectedLanguage();
    const transcript = String(await transcribeAudio(blob, language) || "").trim();
    if (generation !== startGeneration || activeContext !== contextType) return;
    if (!transcript) {
      setStatus(contextType, "I couldn't hear clear words. Please speak a little closer to the microphone and try again.", "error");
      return;
    }
    learnerTurnPendingReply = true;
    if (transcriptsEnabled) onTranscript?.(contextType, transcript);
    setStatus(contextType, "I heard you. Thinking through your question…", "success");
    let reply = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const responseLanguage = selectedLanguage();
      const languageGeneration = responseLanguageGeneration;
      const context = {
        ...await getContext(contextType, inspectionId),
        response_language: responseLanguage.value,
        response_language_name: responseLanguage.label,
      };
      if (generation !== startGeneration || activeContext !== contextType) return;
      reply = String(await askTutorTurn(context, transcript) || "").trim();
      if (generation !== startGeneration || activeContext !== contextType) return;
      if (languageGeneration === responseLanguageGeneration) break;
      reply = "";
    }
    if (!reply) throw new Error("The tutor did not return a reply. Please try speaking again.");
    showSessionMessage("tutor_reply", reply);
  }

  function createCaptureForSession(stream, contextType, inspectionId, generation) {
    return createSpeechCapture(stream, {
      isEnabled: () => generation === startGeneration && activeContext === contextType && !muted,
      onPushToTalkChange: (recording) => onPushToTalkChange?.(contextType, recording),
      onSpeechStart: () => {
        if (generation === startGeneration && activeContext === contextType) {
          setStatus(contextType, "Listening. Press Voice again when you have finished speaking.");
        }
      },
      onSpeechEnd: () => {
        if (generation === startGeneration && activeContext === contextType) setStatus(contextType, "Transcribing your speech…");
      },
      onNoSpeech: () => {
        if (generation === startGeneration && activeContext === contextType) setStatus(contextType, "I didn't hear clear speech. Click Voice, speak, then click it again to try once more.", "error");
      },
      onSilenceTimeout: () => {
        if (generation !== startGeneration || activeContext !== contextType) return;
        const expiredCapture = capture;
        const expiredStream = microphoneStream;
        capture = null;
        microphoneStream = null;
        expiredCapture?.close();
        stopMicrophoneStream(expiredStream);
        setStatus(contextType, "10 seconds of silence. Microphone stopped; recording discarded and not sent. Press Voice to try again.", "success");
      },
      onUtterance: (blob) => {
        turnQueue = turnQueue.then(() => handleUtterance(blob, contextType, inspectionId, generation)).catch((error) => {
          if (generation === startGeneration && activeContext === contextType) {
            setStatus(contextType, error.message || "The tutor could not process that turn. Please try again.", "error");
            onError?.(contextType, error);
          }
        });
      },
      onError: (error) => {
        if (generation === startGeneration && activeContext === contextType) {
          setStatus(contextType, error.message || "The microphone recorder stopped unexpectedly.", "error");
          onError?.(contextType, error);
        }
      },
    });
  }

  async function togglePushToTalk(contextType) {
    if (activeContext !== contextType || starting || pushToTalkStarting) return false;
    if (muted) {
      setStatus(contextType, "Microphone muted. Unmute before starting a recording.", "error");
      return false;
    }
    if (capture?.isPushToTalkActive) {
      capture.stopPushToTalk();
      const completedCapture = capture;
      const completedStream = microphoneStream;
      capture = null;
      microphoneStream = null;
      completedCapture.close();
      stopMicrophoneStream(completedStream);
      return false;
    }
    if (isSpeaking) stopSpeaking();
    const sessionGeneration = startGeneration;
    pushToTalkStarting = true;
    let sessionStream = null;
    try {
      if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
        throw new Error("Microphone recording needs a supported browser on HTTPS or localhost. You can still type or record a voice note.");
      }
      setStatus(contextType, "Opening the microphone for this recording…");
      sessionStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (activeContext !== contextType || sessionGeneration !== startGeneration || muted) {
        stopMicrophoneStream(sessionStream);
        return false;
      }
      const microphoneTrack = sessionStream.getAudioTracks()[0];
      if (!microphoneTrack || microphoneTrack.readyState !== "live") throw new Error("The browser did not provide an active microphone. Check microphone access and try again.");
      microphoneStream = sessionStream;
      capture = createCaptureForSession(sessionStream, contextType, sessionInspectionId, sessionGeneration);
      await capture.ready();
      if (!capture || activeContext !== contextType || sessionGeneration !== startGeneration || muted) return false;
      const recording = capture.startPushToTalk();
      if (recording) setStatus(contextType, "Recording. Speak, then press Voice again to transcribe and get a tutor reply.", "success");
      else setStatus(contextType, "Could not start microphone recording. Press Voice to try again.", "error");
      return recording;
    } catch (error) {
      capture?.close();
      capture = null;
      if (microphoneStream === sessionStream) microphoneStream = null;
      stopMicrophoneStream(sessionStream);
      setStatus(contextType, error.message || "Could not start microphone recording. Try again.", "error");
      return false;
    } finally {
      pushToTalkStarting = false;
    }
  }

  async function start(contextType) {
    if (document.documentElement.classList.contains("strict-mock-exam-active")) return;
    if (starting) return;
    if (activeContext) {
      if (activeContext === contextType) await stop();
      return;
    }
    if (window.isSecureContext === false) {
      setStatus(contextType, "Microphone access needs HTTPS or localhost. On this computer, open http://localhost:5501/app/; hotspot devices need a trusted HTTPS link. You can still type here.", "error");
      panel(contextType).hidden = false;
      return;
    }
    const generation = ++startGeneration;
    const isCurrentStart = () => generation === startGeneration && starting && activeContext === contextType;
    starting = true;
    activeContext = contextType;
    muted = false;
    lastTutorReplyText = "";
    learnerTurnPendingReply = true;
    turnQueue = Promise.resolve();
    primeSpeechFromGesture();
    if (contextType === "practice" || contextType === "exam") panel(contextType)?.querySelector("[data-live-transcript]")?.replaceChildren();
    setPanels(activeContext);
    setStatus(activeContext, "Preparing your tutoring session…");
    try {
      const inspectionId = await ensureInspection(contextType);
      if (!isCurrentStart()) return;
      sessionInspectionId = inspectionId;
      const context = await getContext(contextType, inspectionId);
      if (!isCurrentStart()) return;
      setStatus(activeContext, "Microphone stays off until you press Voice. Press it again when you have finished speaking.", "success");
      const pageGreeting = String(getLoginGreeting?.(contextType, context) || "").trim();
      const language = selectedLanguage();
      context.response_language = language.value;
      context.response_language_name = language.label;
      const greeting = pageGreeting || (contextType === "ask"
        ? "I'm ready to help with the question on this page. Press Voice to speak, then press it again when you have finished."
        : "Let's work through the question on this page. Press Voice to speak, then press it again when you have finished.");
      lastTutorReplyText = greeting.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      lastTutorResponse = greeting;
      learnerTurnPendingReply = false;
      if (transcriptsEnabled) onTutorReply?.(contextType, greeting);
      speak(greeting, contextType);
    } catch (error) {
      const isCurrent = isCurrentStart();
      if (!isCurrent) return;
      const failedContext = contextType;
      stopSpeaking();
      setPanels(failedContext, false);
      activeContext = "";
      setStatus(failedContext, error.message || "Could not start the live tutor. Try again or use the text box.", "error");
    } finally {
      if (generation === startGeneration) {
        starting = false;
        setPanels(activeContext || "", Boolean(activeContext));
      }
    }
  }

  async function stop() {
    const oldContext = activeContext;
    startGeneration += 1;
    starting = false;
    stopSpeaking();
    muted = false;
    pushToTalkStarting = false;
    capture?.close();
    capture = null;
    stopMicrophoneStream(microphoneStream);
    microphoneStream = null;
    sessionInspectionId = "";
    activeContext = "";
    setPanels("");
    if (oldContext) setStatus(oldContext, "Session ended. You can continue by typing here.");
  }

  launchButtons.forEach((button) => button.addEventListener("click", () => start(button.dataset.liveStart)));
  panels.forEach((item) => {
    const context = item.dataset.livePanel;
    item.querySelector("[data-live-action='mute']")?.addEventListener("click", (event) => {
      muted = !muted;
      capture?.setMuted(muted);
      if (muted && capture) {
        capture.close();
        capture = null;
        stopMicrophoneStream(microphoneStream);
        microphoneStream = null;
      }
      event.currentTarget.setAttribute("aria-pressed", String(muted));
      event.currentTarget.textContent = muted ? "Unmute microphone" : "Mute microphone";
      setStatus(context, muted ? "Microphone muted. Unmute, then press Voice when you are ready to speak." : "Microphone ready. Press Voice to speak, then press it again to send.");
    });
    item.querySelector("[data-live-action='stop-speaking']")?.addEventListener("click", () => {
      stopSpeaking();
      if (activeContext) setStatus(activeContext, "Tutor voice stopped. The reply remains in your transcript.");
    });
    item.querySelector("[data-live-action='pause-speaking']")?.addEventListener("click", () => pauseSpeaking(context));
    item.querySelector("[data-live-action='resume-speaking']")?.addEventListener("click", () => resumeSpeaking(context));
    item.querySelector("[data-live-action='repeat']")?.addEventListener("click", () => lastSpeechText && speak(lastSpeechText, activeContext || lastSpeechContext));
    item.querySelector("[data-live-action='transcripts']")?.addEventListener("click", () => {
      transcriptsEnabled = !transcriptsEnabled;
      localStorage.setItem(TRANSCRIPTS_KEY, String(transcriptsEnabled));
      setPanels(activeContext, Boolean(activeContext));
      setStatus(context, transcriptsEnabled
        ? "Transcript display is on. The microphone records only while you press Voice."
        : "Transcript display is off. The microphone still records only while you press Voice.");
    });
    item.querySelector("[data-live-action='end']")?.addEventListener("click", stop);
    item.querySelector("[data-live-voice]")?.addEventListener("change", (event) => {
      localStorage.setItem(VOICE_KEY, event.currentTarget.value || "");
      voiceSelects.forEach((select) => { if (select !== event.currentTarget) select.value = event.currentTarget.value; });
    });
    item.querySelector("[data-live-language]")?.addEventListener("change", (event) => {
      handleLanguageChange(event);
    });
  });
  readAvailableVoices();
  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener?.("voiceschanged", readAvailableVoices);
    window.addEventListener("beforeunload", stopSpeaking);
  }
  setPanels("");

  return {
    start,
    stop,
    stopSpeaking,
    isActive(contextType) { return Boolean(activeContext && activeContext === contextType); },
    togglePushToTalk,
    prepareSpeechFromGesture() { primeSpeechFromGesture(); },
    speakReply(text, context, callbacks) { speak(text, context, callbacks); },
    stopIfContext(contextType) { if (!contextType || activeContext === contextType) void stop(); },
    get activeContext() { return activeContext; },
  };
}
