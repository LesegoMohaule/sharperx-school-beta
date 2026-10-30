function numericValue(raw) {
  const text = String(raw || "").trim().replace(/[−–]/g, "-").replace(/\s+/g, "");
  const pi = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)?)?(?:pi|π)(?:\/([+-]?\d+(?:\.\d*)?))?$/i);
  if (pi) {
    const coefficient = pi[1] === "" || pi[1] === undefined ? 1 : pi[1] === "+" ? 1 : pi[1] === "-" ? -1 : Number(pi[1]);
    const divisor = pi[2] === undefined ? 1 : Number(pi[2]);
    return Number.isFinite(coefficient / divisor) && divisor !== 0 ? coefficient * Math.PI / divisor : null;
  }
  const fraction = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\/([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  const value = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(text);
  return Number.isFinite(value) ? value : null;
}

function normaliseDisplayValue(value) {
  return String(value || "")
    .trim()
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, "")
    .replace(/\\(?:d?frac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gi, "$1/$2")
    .replace(/pi/gi, "π");
}

function asymptoteTokens(raw) {
  const source = normaliseDisplayValue(raw);
  if (!source || /^(?:none|no|n\/a|notapplicable)$/i.test(source)) return [];
  const expressions = source.match(/(?:[xy]=)?[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:\/[+-]?(?:\d+(?:\.\d*)?|\.\d+))?|(?:\d*(?:\.\d+)?)?(?:π|pi)(?:\/[+-]?\d+(?:\.\d*)?)?)/gi) || [];
  return expressions.flatMap((expression) => {
    const token = expression.replace(/^[xy]=/i, "");
    const value = numericValue(token);
    return value === null ? [] : [{ value, display: token }];
  });
}

/** Read asymptote coordinates the learner explicitly confirmed in graph review. */
export function confirmedCanvasGraphAsymptotes(functions) {
  const found = [];
  for (const [functionIndex, item] of (Array.isArray(functions) ? functions : []).entries()) {
    const graphType = String(item?.graphType || "").toLowerCase();
    const points = [...(Array.isArray(item?.points) ? item.points : [])];
    const structured = Array.isArray(item?.asymptotes)
      ? item.asymptotes
      : Array.isArray(item?.result?.asymptotes) ? item.result.asymptotes : [];
    for (const asymptote of structured) {
      if (!asymptote || typeof asymptote !== "object") continue;
      const rawAxis = String(asymptote.axis || asymptote.orientation || asymptote.type || "").toLowerCase();
      const axis = rawAxis === "horizontal" ? "y" : rawAxis === "vertical" ? "x" : rawAxis;
      const label = String(asymptote.label || asymptote.equation || "").trim();
      const value = asymptote.value ?? asymptote.coordinate ?? (axis === "x" ? asymptote.x : asymptote.y);
      if (axis === "x" || axis === "y") {
        const hasAxisLabel = /(?:vertical|horizontal|\b[xy]\s*=)/i.test(label);
        const pointLabel = hasAxisLabel ? label : (axis === "x" ? "Vertical asymptote" : "Horizontal asymptote");
        const equation = /\b[xy]\s*=/i.test(label) ? label : `${axis} = ${value ?? label}`;
        points.push({ label: pointLabel, value: String(value ?? equation) });
      }
    }
    for (const point of points) {
      const label = String(point?.label || "").trim();
      if (!/asymptote/i.test(label) && !/\b[xy]\s*=/i.test(label)) continue;
      const raw = String(point?.value || "").trim();
      if (!raw || /^(?:none|no asymptote|n\/a|not applicable)$/i.test(raw)) continue;
      const explicitAxis = raw.match(/\b([xy])\s*=/i)?.[1]?.toLowerCase() || label.match(/\b([xy])\s*=/i)?.[1]?.toLowerCase();
      const axis = explicitAxis || (/vertical|x-coordinate/i.test(label)
        ? "x"
        : /horizontal|y-coordinate/i.test(label)
          ? "y"
          : /tangent/i.test(graphType) ? "x" : "");
      if (!axis) continue;
      const values = asymptoteTokens(raw);
      values.forEach(({ value, display }) => {
        if (found.some((entry) => entry.axis === axis && Math.abs(entry.value - value) < 1e-9)) return;
        found.push({ axis, value, display, functionIndex, label: `${axis} = ${display}` });
      });
    }
  }
  return found;
}

/** Expand the generated graph window so confirmed asymptotes cannot be clipped. */
export function includeCanvasGraphAsymptotes(bounds, asymptotes) {
  const result = { ...bounds };
  const xSpan = Math.max(Math.abs(result.xMax - result.xMin), 1);
  const ySpan = Math.max(Math.abs(result.yMax - result.yMin), 1);
  for (const asymptote of Array.isArray(asymptotes) ? asymptotes : []) {
    if (asymptote.axis === "x") {
      const pad = xSpan * 0.08;
      if (asymptote.value <= result.xMin) result.xMin = asymptote.value - pad;
      if (asymptote.value >= result.xMax) result.xMax = asymptote.value + pad;
    } else if (asymptote.axis === "y") {
      const pad = ySpan * 0.08;
      if (asymptote.value <= result.yMin) result.yMin = asymptote.value - pad;
      if (asymptote.value >= result.yMax) result.yMax = asymptote.value + pad;
    }
  }
  return result;
}

function escapeSvgText(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[character]));
}

/** Draw labelled dashed asymptote guides in the textbook graph preview. */
export function renderCanvasGraphAsymptoteSvg(asymptotes, mapX, mapY, plot) {
  const markup = [];
  for (const asymptote of Array.isArray(asymptotes) ? asymptotes : []) {
    const coordinate = asymptote.axis === "y" ? mapY(asymptote.value) : mapX(asymptote.value);
    const inView = Number.isFinite(coordinate) && (asymptote.axis === "y"
      ? coordinate >= plot.top && coordinate <= plot.bottom
      : coordinate >= plot.left && coordinate <= plot.right);
    if (!inView) continue;
    const label = escapeSvgText(asymptote.label.replace(/-/g, "−"));
    if (asymptote.axis === "y") {
      markup.push(`<line x1="${plot.left}" y1="${coordinate.toFixed(2)}" x2="${plot.right}" y2="${coordinate.toFixed(2)}" stroke="#b42318" stroke-width="2.5" stroke-dasharray="10 7"/>`);
      markup.push(`<text x="${plot.right - 7}" y="${Math.max(plot.top + 14, coordinate - 7).toFixed(2)}" text-anchor="end" font-size="13" font-weight="700" fill="#9f1d16">${label}</text>`);
    } else if (asymptote.axis === "x") {
      markup.push(`<line x1="${coordinate.toFixed(2)}" y1="${plot.top}" x2="${coordinate.toFixed(2)}" y2="${plot.bottom}" stroke="#b42318" stroke-width="2.5" stroke-dasharray="10 7"/>`);
      markup.push(`<text x="${Math.min(plot.right - 5, coordinate + 7).toFixed(2)}" y="${plot.top + 17}" font-size="13" font-weight="700" fill="#9f1d16">${label}</text>`);
    }
  }
  return markup;
}
