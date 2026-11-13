// Live check of lesson generation: asks the configured tutor LLM for lessons and reports how much of
// what it wrote survives validation. Nothing is stored.
//
//   TUTOR_LLM_PROVIDER=local node scripts/tryLessons.js [runsPerTopic=2] [topic] [band]
//   (set in backend/.env or the shell; "local" uses LM Studio, "openrouter" needs a key)
//
// A low "kept" rate means the model ignores the word list; the lesson still works because rejected
// items are replaced from the vetted fallback lesson, but the content is then less personal.

require("dotenv").config();
const lessons = require("../src/services/tutorLessonService");
const tutorLlm = require("../src/services/tutorLlm");

async function main() {
  const runs = Number(process.argv[2]) || 2;
  const onlyTopic = process.argv[3];
  const onlyBand = process.argv[4];
  const status = tutorLlm.status();
  if (!status.enabled) {
    console.error("The tutor LLM is not configured. Set TUTOR_LLM_PROVIDER=local (or openrouter plus its key and model).");
    process.exitCode = 1;
    return;
  }
  console.log(`Provider: ${status.provider}  Model: ${status.model || "(first loaded)"}  Runs per topic and band: ${runs}`);

  const totals = { lessons: 0, items: 0, ai: 0, failedCalls: 0, ms: 0, tokensIn: 0, tokensOut: 0 };
  const reasons = new Map();
  const rejectedWords = new Map();
  let sample = null;

  for (const topicId of lessons.topicIds.filter((t) => !onlyTopic || t === onlyTopic)) {
    for (const ageBand of ["A", "B"].filter((b) => !onlyBand || b === onlyBand)) {
      for (let i = 0; i < runs; i += 1) {
        const started = Date.now();
        const lesson = await lessons.generateLesson({ topicId, ageBand });
        totals.ms += Date.now() - started;
        totals.lessons += 1;
        totals.items += lesson.items.length;
        totals.ai += lesson.meta.aiItems;
        totals.tokensIn += lesson.meta.usage?.prompt_tokens || 0;
        totals.tokensOut += lesson.meta.usage?.completion_tokens || 0;
        if (lesson.meta.llmError) {
          totals.failedCalls += 1;
          reasons.set(`call failed: ${lesson.meta.llmError}`, (reasons.get(`call failed: ${lesson.meta.llmError}`) || 0) + 1);
        }
        for (const r of lesson.meta.rejected) {
          for (const reason of r.reasons) {
            const listed = reason.match(/words? not allowed: (.*)$/);
            if (listed) for (const w of listed[1].split(", ")) rejectedWords.set(`${r.index === "story" ? "story" : "item"}: ${w}`, (rejectedWords.get(`${r.index === "story" ? "story" : "item"}: ${w}`) || 0) + 1);
            const key = reason.replace(/words not allowed: .*/, "words not allowed").replace(/\(\d+ words, max \d+\)/, "(too many words)");
            reasons.set(key, (reasons.get(key) || 0) + 1);
          }
        }
        sample ??= lesson.meta.aiItems > 0 ? lesson : null;
        console.log(`${topicId} ${ageBand} #${i + 1}: ${lesson.meta.aiItems}/${lesson.items.length} kept from the model${lesson.meta.llmError ? ` (${lesson.meta.llmError})` : ""}, ${Date.now() - started} ms`);
      }
    }
  }

  console.log(`\nKept from the model: ${totals.ai}/${totals.items} items (${Math.round((100 * totals.ai) / Math.max(1, totals.items))}%)`);
  console.log(`Calls that failed outright: ${totals.failedCalls}/${totals.lessons}`);
  console.log(`Average time per lesson: ${Math.round(totals.ms / Math.max(1, totals.lessons))} ms`);
  if (totals.tokensIn) console.log(`Average tokens per lesson: ${Math.round(totals.tokensIn / totals.lessons)} in, ${Math.round(totals.tokensOut / totals.lessons)} out`);
  if (reasons.size) {
    console.log("\nMost common rejection reasons:");
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${count} x ${reason}`);
  }
  if (rejectedWords.size) {
    console.log("\nWords the allowlist rejected most:");
    console.log("  " + [...rejectedWords].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w, c]) => `${w} (${c})`).join(", "));
  }
  if (sample) {
    console.log("\nSample lesson:");
    console.log(JSON.stringify({ story: sample.story, items: sample.items.map(({ id, source, activityType, prompt, acceptedAnswers }) => ({ id, source, activityType, prompt, answers: acceptedAnswers.slice(0, 3).map((a) => a.text) })) }, null, 2));
  }
}

main().catch((error) => {
  console.error("Lesson check failed:", error.message);
  process.exitCode = 1;
});
