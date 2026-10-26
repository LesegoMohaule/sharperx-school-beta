const MATH_WORDS = /^(?:[A-Za-z]|[A-Z]{2,5}|lim|log|ln|sin|cos|tan|sqrt|frac|angle|theta|pi|alpha|beta|gamma|delta|lambda|mu|sigma|omega|eq|mod|infty|pm|cdot|times|div|leq|le|geq|ge|neq|ne|approx|to|in|notin|cup|cap|Rightarrow|Leftarrow|Longrightarrow|Longleftarrow|Leftrightarrow|leftrightarrow|Longleftrightarrow|longrightarrow|longleftarrow|longleftrightarrow|therefore|because|quad|qquad|text|mathrm|operatorname|begin|end|aligned)$/;
const EXPLICIT_MATH = /(\\begin\{(?:aligned|gathered|cases|array)\}[\s\S]*?\\end\{(?:aligned|gathered|cases|array)\}|\\\((?:.|\n)*?\\\)|\\\[(?:.|\n)*?\\\]|\$\$(?:.|\n)*?\$\$|\$(?:[^$\n]+)\$)/g;
let mathJaxLoadPromise = null;

const FORMULA_ATOM = String.raw`(?:\\(?:frac|sqrt|lim|log|ln|sin|cos|tan|angle)\s*(?:_\{[^{}\r\n]*\})?(?:\{[^{}\r\n]*\})?|√\s*(?:\([^()\r\n]*\)|[A-Za-z0-9.]+)|∠\s*[A-Z]{1,5}|\d+\s+\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?(?:[A-Za-z](?:\d+)?)?(?:\([^()\r\n]*\))?(?:\^\{[^{}\r\n]*\})?|[A-Za-z](?:[A-Za-z0-9]*)(?:_\{[^{}\r\n]*\})?(?:\^\{[^{}\r\n]*\})?(?:\([^()\r\n]*\))?|\([^()\r\n]*\))`;
const FORMULA_RUN = new RegExp(`${FORMULA_ATOM}(?:\\s*(?:<=|>=|\\\\leq?|\\\\geq?|\\\\neq|=|<|>|≤|≥|≠|≈|±|[+\\-−×÷*/^_→])\\s*${FORMULA_ATOM})+`, "g");
const STANDALONE_LATEX = /\\(?:frac|sqrt|lim|log|ln|sin|cos|tan|angle)(?:_\{[^{}\r\n]*\})?(?:\{[^{}\r\n]*\})?(?:\{[^{}\r\n]*\})?/g;
const ANGLE_RUN = /∠\s*[A-Z]{1,5}(?:\s*(?:=|≤|≥|<|>)\s*\d+(?:\.\d+)?°?)?/g;
const FRACTION_RUN = /(?:^|[^A-Za-z0-9])(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+)(?=$|[^A-Za-z0-9])/g;
const ROOT_RUN = /(?:√\s*(?:\([^()\r\n]*\)|[A-Za-z0-9.]+)|\\sqrt\s*\{[^{}\r\n]*\})/g;
const LOG_RUN = /(?:^|[^A-Za-z\\])log\s*_\s*\{?\d+\}?\s*[A-Za-z0-9.]+/gi;
const SCRIPT_RUN = /(?:^|[^A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9]*\^\{?[^{}\s]+\}?|[A-Za-z][A-Za-z0-9]*_\{?[^{}\s]+\}?)/g;

function hasMathCue(value) {
  return /[=<>≤≥≠≈±×÷*/^_→√∠∞∑∫!%⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]|\\(?:frac|sqrt|lim|log|ln|sin|cos|tan|angle)\b/i.test(value)
    || /\d\s+\d+\s*\/\s*\d/.test(value);
}

function isMathOnly(value) {
  const text = String(value || "").trim().replace(/^[-*•]\s+/, "");
  if (!text || !/^[\w\sπθΔΩαβγλμσφωΑ-Ωα-ω∞∠√∑∫°′″.,;:()\[\]{}\\$%#&+\-−×÷*/^_=<>≤≥≠≈±→⇔⇒⟹⟶⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+$/.test(text)) return false;
  const words = text.match(/[A-Za-z]+/g) || [];
  if (!words.every((word) => MATH_WORDS.test(word))) return false;
  return hasMathCue(text)
    || /^\d+(?:[.,]\d+)?$/.test(text)
    || /^\d+[A-Za-z]$/.test(text)
    || /^\d+\s+[A-Za-z]$/.test(text)
    || /^[A-Za-z]$/.test(text);
}

function readBalanced(text, start, open = "(", close = ")") {
  if (text[start] !== open) return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (!depth) return { value: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function normalizeScripts(value) {
  let text = value;
  text = text.replace(/([A-Za-z0-9πθΔΩ])\^\s*\(([^()]+)\)/g, "$1^{$2}");
  text = text.replace(/([A-Za-z0-9πθΔΩ])_\s*\(([^()]+)\)/g, "$1_{$2}");
  text = text.replace(/([A-Za-z0-9πθΔΩ])\^\s*([+-]?\d+(?:\.\d+)?|[A-Za-z])/g, "$1^{$2}");
  text = text.replace(/([A-Za-z0-9πθΔΩ])_\s*([+-]?\d+|[A-Za-z])/g, "$1_{$2}");
  return text.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹ⁿⁱ⁻⁺⁽⁾]+)/g, (script) => {
    const map = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "ⁿ": "n", "ⁱ": "i", "⁻": "-", "⁺": "+", "⁽": "(", "⁾": ")" };
    return `^{${[...script].map((character) => map[character] || character).join("")}}`;
  }).replace(/([₀₁₂₃₄₅₆₇₈₉ₙᵢₓ₋₊₍₎]+)/g, (script) => {
    const map = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "ₙ": "n", "ᵢ": "i", "ₓ": "x", "₋": "-", "₊": "+", "₍": "(", "₎": ")" };
    return `_{${[...script].map((character) => map[character] || character).join("")}}`;
  });
}

function normalizeLatexEnvironment(value) {
  const text = normalizeScripts(value).replace(/−/g, "-");
  return text.replace(
    /((?:[A-Za-z]+_\{[^{}]+\}|[A-Za-z]|\d+(?:\.\d+)?))\s*\/\s*((?:[A-Za-z]+_\{[^{}]+\}|[A-Za-z]|\d+(?:\.\d+)?))/g,
    (_match, numerator, denominator) => `\\frac{${numerator}}{${denominator}}`,
  );
}

function normalizeRoots(value) {
  let text = value.replace(/\\?sqrt\s*\(/gi, "√(");
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "√") {
      output += text[index];
      continue;
    }
    let cursor = index + 1;
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (text[cursor] === "(") {
      const group = readBalanced(text, cursor);
      if (group) {
        output += `\\sqrt{${formatMathExpression(group.value)}}`;
        index = group.end - 1;
        continue;
      }
    }
    if (text[cursor] === "{") {
      const group = readBalanced(text, cursor, "{", "}");
      if (group) {
        output += `\\sqrt{${formatMathExpression(group.value)}}`;
        index = group.end - 1;
        continue;
      }
    }
    const atom = text.slice(cursor).match(/^[A-Za-z0-9.]+/);
    output += `\\sqrt{${atom ? atom[0] : ""}}`;
    if (atom) index = cursor + atom[0].length - 1;
  }
  return output;
}

function formatMathExpression(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/\\\(|\\\)|\\\[|\\\]|\$/g, "");
  text = normalizeScripts(text);
  text = normalizeRoots(text);
  text = text.replace(/(^|[^A-Za-z\\])lim\s*_?\s*\{?\s*([A-Za-z])\s*(?:→|->|\\to|to)\s*([^}\s),;]+)\s*\}?/gi, "$1\\lim_{$2\\to $3}");
  text = text.replace(/(^|[^A-Za-z\\])lim\s+([A-Za-z])\s*(?:→|->|to)\s*([0-9A-Za-z.+-]+)/gi, "$1\\lim_{$2\\to $3}");
  text = text.replace(/(^|[^A-Za-z\\])log\s*_?\s*\{?(\d+)\}?\s+(?=[A-Za-z0-9(])/gi, "$1\\log_{$2} ");
  text = text.replace(/(^|[^A-Za-z\\])(sin|cos|tan|log|ln|lim)\b/gi, (_match, prefix, word) => `${prefix}\\${word.toLowerCase()}`);
  text = text.replace(/(^|[^A-Za-z\\])angle\s+([A-Z]{2,5})/g, "$1\\angle $2");
  text = text.replace(/<=>/g, "\\Leftrightarrow ").replace(/<->/g, "\\leftrightarrow ").replace(/->/g, "\\to ").replace(/=>/g, "\\Rightarrow ");
  text = text.replace(/<=/g, "\\leq ").replace(/>=/g, "\\geq ").replace(/!=/g, "\\neq ");
  text = text.replace(/([A-Za-z0-9)])\s*\*\s*([A-Za-z0-9(])/g, "$1\\times $2");
  text = text.replace(/\(\s*(\d+(?:\.\d+)?)\s*\)\s*\/\s*\(\s*([^()]+?)\s*\)/g, "\\frac{$1}{$2}");
  text = text.replace(/\(\s*([^()]+?)\s*\)\s*\/\s*(\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9]*)/g, "\\frac{$1}{$2}");
  text = text.replace(/\b(\d+)\s+(\d+)\s*\/\s*(\d+)\b/g, "$1\\,\\frac{$2}{$3}");
  text = text.replace(/(^|[^A-Za-z0-9{}])([A-Za-z0-9]+(?:\^\{[^{}]+\})?)\s*\/\s*([A-Za-z0-9]+)(?![A-Za-z0-9{])/g, "$1\\frac{$2}{$3}");
  text = text
    .replace(/π/g, "\\pi ").replace(/θ/g, "\\theta ").replace(/Δ/g, "\\Delta ").replace(/Ω/g, "\\Omega ")
    .replace(/α/g, "\\alpha ").replace(/β/g, "\\beta ").replace(/γ/g, "\\gamma ").replace(/λ/g, "\\lambda ").replace(/μ/g, "\\mu ").replace(/σ/g, "\\sigma ").replace(/ω/g, "\\omega ")
    .replace(/∠/g, "\\angle ").replace(/°/g, "^{\\circ}").replace(/±/g, "\\pm ").replace(/·/g, "\\cdot ").replace(/[×✕]/g, "\\times ").replace(/÷/g, "\\div ")
    .replace(/≤/g, "\\leq ").replace(/≥/g, "\\geq ").replace(/≠/g, "\\neq ").replace(/≈/g, "\\approx ").replace(/∞/g, "\\infty ")
    .replace(/∈/g, "\\in ").replace(/∪/g, "\\cup ").replace(/∩/g, "\\cap ").replace(/⇒/g, "\\Rightarrow ").replace(/⟹/g, "\\Longrightarrow ").replace(/⇔/g, "\\Leftrightarrow ").replace(/⟺/g, "\\Longleftrightarrow ").replace(/→/g, "\\to ").replace(/−/g, "-");
  text = text.replace(/\s*=\s*/g, " = ").replace(/[ \t]+/g, " ").trim();
  return text;
}

function lineSegments(line) {
  const trimmed = line.trim();
  if (isMathOnly(trimmed)) {
    const prefix = line.slice(0, line.indexOf(trimmed));
    const suffix = line.slice(line.indexOf(trimmed) + trimmed.length);
    return [
      ...(prefix ? [{ type: "text", text: prefix }] : []),
      { type: "math", text: formatMathExpression(trimmed) },
      ...(suffix ? [{ type: "text", text: suffix }] : []),
    ];
  }

  const matches = [];
  const collect = (regex) => {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(line))) {
      if (!hasMathCue(match[0])) continue;
      let start = match.index;
      let end = start + match[0].length;
      const mixedPrefix = line.slice(0, start).match(/(\d+)\s+$/);
      if (mixedPrefix && /^(?:\d+\s*\/\s*\d+)/.test(line.slice(start, end))) start -= mixedPrefix[0].length;
      matches.push({ start, end, text: line.slice(start, end) });
    }
  };
  collect(FORMULA_RUN);
  collect(STANDALONE_LATEX);
  collect(ANGLE_RUN);
  collect(FRACTION_RUN);
  collect(ROOT_RUN);
  collect(LOG_RUN);
  collect(SCRIPT_RUN);
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged = [];
  for (const match of matches) {
    const previous = merged[merged.length - 1];
    if (previous && match.start <= previous.end) {
      if (match.end > previous.end) {
        previous.end = match.end;
        previous.text = line.slice(previous.start, previous.end);
      }
    } else merged.push({ ...match });
  }
  if (!merged.length) return [{ type: "text", text: line }];

  const result = [];
  let cursor = 0;
  for (const match of merged) {
    if (match.start > cursor) result.push({ type: "text", text: line.slice(cursor, match.start) });
    result.push({ type: "math", text: formatMathExpression(match.text) });
    cursor = match.end;
  }
  if (cursor < line.length) result.push({ type: "text", text: line.slice(cursor) });
  return result;
}

export function splitTextbookMath(value) {
  const mathTokens = [];
  const normalizedValue = String(value || "")
    .replace(/\\begin\s*aligned/g, "\\begin{aligned}")
    .replace(/\\end\s*aligned/g, "\\end{aligned}")
    .replace(/\\(\d+(?:\.\d+)?pt\])/g, "\\\\[$1")
    .replace(/\\begin\{(aligned|gathered|cases|array)\}([\s\S]*?)\\end\{(aligned|gathered|cases|array)\}/g,
      (_match, startEnvironment, content, endEnvironment) => `\\begin{${startEnvironment}}${normalizeLatexEnvironment(content)}\\end{${endEnvironment}}`);
  EXPLICIT_MATH.lastIndex = 0;
  const withMathTokens = normalizedValue.replace(EXPLICIT_MATH, (token) => {
    const isRawEnvironment = token.startsWith("\\begin{");
    const latex = isRawEnvironment ? token : token.startsWith("\\(") || token.startsWith("\\[") ? token.slice(2, -2)
      : token.startsWith("$$") ? token.slice(2, -2) : token.slice(1, -1);
    const index = mathTokens.push({ type: "math", text: latex.trim(), display: isRawEnvironment || token.startsWith("\\[") || token.startsWith("$$") }) - 1;
    return `\uE000${index}\uE001`;
  });
  const protectedText = withMathTokens.replace(/\\vspace\{[^}]*\}/g, "\n").replace(/\\\\\s+/g, "\n");
  const parsed = [];
  const lines = protectedText.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) parsed.push({ type: "break" });
    else parsed.push(...lineSegments(line));
    if (index < lines.length - 1) parsed.push({ type: "break" });
  });

  const result = [];
  const marker = /\uE000(\d+)\uE001/g;
  for (const segment of parsed) {
    if (segment.type !== "text") {
      result.push(segment);
      continue;
    }
    let cursor = 0;
    marker.lastIndex = 0;
    let match;
    while ((match = marker.exec(segment.text))) {
      if (match.index > cursor) result.push({ type: "text", text: segment.text.slice(cursor, match.index) });
      result.push(mathTokens[Number(match[1])]);
      cursor = match.index + match[0].length;
    }
    if (cursor < segment.text.length) result.push({ type: "text", text: segment.text.slice(cursor) });
  }
  return result;
}

export function textbookMathMarkup(value) {
  return splitTextbookMath(value).map((segment) => {
    if (segment.type === "break") return "\n";
    if (segment.type === "math") return segment.display ? `\\[${segment.text}\\]` : `\\(${segment.text}\\)`;
    return segment.text;
  }).join("");
}

export function containsTextbookMath(value) {
  return splitTextbookMath(value).some((segment) => segment.type === "math");
}

export function ensureMathJax() {
  if (window.MathJax?.typesetPromise) return Promise.resolve(window.MathJax);
  if (!window.MathJax) {
    window.MathJax = {
      tex: { inlineMath: [["\\(", "\\)"], ["$", "$"]], displayMath: [["\\[", "\\]"], ["$$", "$$"]] },
      options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"] },
      svg: { fontCache: "local" },
    };
  }
  if (!mathJaxLoadPromise) {
    mathJaxLoadPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
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
  }[character]));
}

export function renderTextbookMath(target, value) {
  const markup = textbookMathMarkup(value);
  window.MathJax?.typesetClear?.([target]);
  target.innerHTML = escapeHtml(markup).replace(/\r?\n/g, "<br>");
  if (!containsTextbookMath(markup)) return;
  ensureMathJax().then((mathJax) => {
    if (!mathJax) return;
    mathJax.typesetClear?.([target]);
    return mathJax.typesetPromise([target]);
  }).catch(() => {});
}
