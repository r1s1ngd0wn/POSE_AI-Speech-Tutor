// Live check of the learner report: builds a synthetic child history (no database), asks the configured
// tutor LLM to phrase the report several times, and shows how often its text survives the checks that
// compare it with the computed facts. Nothing is stored.
//
//   TUTOR_LLM_PROVIDER=local node scripts/tryReport.js [runs=5]

require("dotenv").config();
const report = require("../src/services/tutorReportService");
const progress = require("../src/services/tutorProgressService");
const tutorLlm = require("../src/services/tutorLlm");

const T0 = Date.parse("2026-11-02T03:00:00.000Z");
const at = (d) => new Date(T0 + d * 86400000).toISOString();
const child = { id: "synthetic", parentId: "p", nickname: "Mimi", ageBand: "B" };

function lesson(i, stars, topicId) {
  const criteria = [{ id: "clarity", band: 3 }, { id: "accuracy", band: 4 }, { id: "participation", band: 5 }];
  return {
    id: `s${i}`, childId: child.id, topicId, status: "completed", startedAt: at(i), items: stars.map((_, k) => ({ id: `i${k}` })),
    attempts: stars.map((s) => ({ response: { mode: "speech", firstAttemptMs: 2500 }, result: { completed: true, stars: s, activityType: "listen_repeat", criteria } })),
  };
}

async function main() {
  const runs = Number(process.argv[2]) || 5;
  const status = tutorLlm.status();
  if (!status.enabled) {
    console.error("The tutor LLM is not configured. Set TUTOR_LLM_PROVIDER=local (or openrouter plus its key and model).");
    process.exitCode = 1;
    return;
  }
  const p = progress.emptyProgress(child.id);
  const word = (form, box) => ({ form, box, seen: 4, correct: box, lastSeenAt: at(5), nextDueAt: at(5) });
  p.words = { cat: word("cat", 4), dog: word("dog", 4), bird: word("bird", 2), rabbit: word("rabbit", 1), apple: word("apple", 1) };
  p.streak = { current: 2, longest: 3, lastDay: progress.dayNumber(at(4)) };
  const sessions = [[1, 2, 2, 2, 2], [2, 2, 2, 2, 2], [2, 2, 3, 2, 2], [3, 2, 3, 3, 2], [3, 3, 3, 2, 3]].map((s, i) => lesson(i, s, ["animals", "food"][i % 2]));

  console.log(`Provider: ${status.provider}  Model: ${status.model || "(first loaded)"}  Runs: ${runs}`);
  let ai = 0;
  const reasons = new Map();
  let sample;
  for (let i = 0; i < runs; i += 1) {
    const started = Date.now();
    const r = await report.buildReport({ child, progress: p, sessions, now: at(5) });
    const used = r.narrative.source === "ai";
    if (used) { ai += 1; sample ??= r.narrative; }
    for (const reason of r.meta.rejected) reasons.set(reason, (reasons.get(reason) || 0) + 1);
    if (r.meta.llmError) reasons.set(`call: ${r.meta.llmError}`, (reasons.get(`call: ${r.meta.llmError}`) || 0) + 1);
    console.log(`#${i + 1}: ${used ? "model text accepted" : "fell back to template"} (${Date.now() - started} ms)`);
  }
  console.log(`\nModel narrative accepted: ${ai}/${runs}`);
  if (reasons.size) {
    console.log("Reasons it was rejected:");
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${count} x ${reason}`);
  }
  if (sample) console.log("\nSample accepted narrative:\n" + JSON.stringify(sample, null, 2));
}

main().catch((error) => {
  console.error("Report check failed:", error.message);
  process.exitCode = 1;
});
