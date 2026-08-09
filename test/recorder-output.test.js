const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRecorderOutput } = require("../src/agora/recorder-output");

test("parses well-formed JSON output", () => {
  const input = JSON.stringify({
    summary: "Summary text",
    decisions: [{ title: "D1", content: "Decided X" }],
    nextActions: [{ title: "A1", description: "Do Y" }],
  });
  const result = parseRecorderOutput(input);
  assert.equal(result.summary, "Summary text");
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].title, "D1");
  assert.equal(result.nextActions.length, 1);
  assert.equal(result.nextActions[0].title, "A1");
});

test("parses JSON wrapped in a code block", () => {
  const json = JSON.stringify({ summary: "S", decisions: [], nextActions: [] });
  const input = "Here is the output:\n```json\n" + json + "\n```\nThanks.";
  const result = parseRecorderOutput(input);
  assert.equal(result.summary, "S");
});

test("parses JSON with surrounding prose", () => {
  const json = JSON.stringify({ summary: "Prose summary", decisions: [], nextActions: [] });
  const input = "Sure, here it is: " + json + " Let me know if you need more.";
  const result = parseRecorderOutput(input);
  assert.equal(result.summary, "Prose summary");
});

test("falls back to raw text for unparsable input without throwing", () => {
  const input = "This is not JSON at all, just plain text.";
  assert.doesNotThrow(() => parseRecorderOutput(input));
  const result = parseRecorderOutput(input);
  assert.equal(result.summary, input);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.nextActions, []);
});

test("never throws on empty or malformed input", () => {
  assert.doesNotThrow(() => parseRecorderOutput(""));
  assert.doesNotThrow(() => parseRecorderOutput(null));
  assert.doesNotThrow(() => parseRecorderOutput(undefined));
  assert.doesNotThrow(() => parseRecorderOutput("{ broken json"));
  assert.doesNotThrow(() => parseRecorderOutput("[1,2,3]"));
});
