import test from "node:test";
import assert from "node:assert/strict";
import { confirmedCanvasGraphAsymptotes, includeCanvasGraphAsymptotes, renderCanvasGraphAsymptoteSvg } from "../app/canvas-graph-asymptotes.mjs";

test("confirmed horizontal asymptote is retained as an exact graph feature", () => {
  const asymptotes = confirmedCanvasGraphAsymptotes([{
    graphType: "Exponential",
    points: [{ label: "Horizontal asymptote", value: "y = -1" }],
  }]);
  assert.deepEqual(asymptotes.map(({ axis, value, label }) => ({ axis, value, label })), [
    { axis: "y", value: -1, label: "y = -1" },
  ]);
  const markup = renderCanvasGraphAsymptoteSvg(asymptotes, (x) => 30 + x, (y) => 150 - y * 20, {
    left: 0, right: 200, top: 0, bottom: 200,
  }).join("");
  assert.match(markup, /stroke-dasharray="10 7"/);
  assert.match(markup, /y = −1/);
});

test("vertical, rational and multiple confirmed asymptotes are parsed", () => {
  const asymptotes = confirmedCanvasGraphAsymptotes([{
    graphType: "Reciprocal",
    points: [
      { label: "Vertical asymptote", value: "x = -1/2, x = 1/2" },
      { label: "Horizontal asymptote", value: "\\frac{3}{4}" },
      { label: "Horizontal asymptote", value: "none" },
    ],
  }]);
  assert.deepEqual(asymptotes.map(({ axis, value }) => [axis, value]), [
    ["x", -0.5], ["x", 0.5], ["y", 0.75],
  ]);
});

test("confirmed trigonometric asymptotes accept pi values and extend graph bounds", () => {
  const asymptotes = confirmedCanvasGraphAsymptotes([{
    graphType: "Tangent",
    points: [{ label: "Asymptote 1", value: "π/2" }, { label: "Asymptote 2", value: "-π/2" }],
  }]);
  assert.deepEqual(asymptotes.map(({ axis }) => axis), ["x", "x"]);
  assert.ok(Math.abs(asymptotes[0].value - Math.PI / 2) < 1e-9);
  const bounds = includeCanvasGraphAsymptotes({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 }, asymptotes);
  assert.ok(bounds.xMax > Math.PI / 2);
  assert.ok(bounds.xMin < -Math.PI / 2);
  assert.equal(bounds.yMin, -1);
  assert.equal(bounds.yMax, 1);
});

test("structured worked graphs draw their explicit asymptote metadata", () => {
  const asymptotes = confirmedCanvasGraphAsymptotes([{
    graphType: "Exponential solution graph",
    asymptotes: [{ axis: "horizontal", value: -1, label: "y = -1" }],
    points: [],
  }]);
  assert.equal(asymptotes.length, 1);
  assert.deepEqual([asymptotes[0].axis, asymptotes[0].value], ["y", -1]);
  const markup = renderCanvasGraphAsymptoteSvg(asymptotes, (x) => x + 20, (y) => 100 - y * 20, {
    left: 0, right: 200, top: 0, bottom: 200,
  }).join("");
  assert.match(markup, /stroke-dasharray="10 7"/);
  assert.match(markup, /y = −1/);
});
