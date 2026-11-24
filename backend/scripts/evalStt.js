// Child-speech accuracy and latency check for choosing a speech-to-text service (SRS section on selecting one
// STT/TTS/LLM configuration "after a small child-speech accuracy and latency check using permitted samples").
//
//   node scripts/evalStt.js <folder> [--providers xai,groq] [--runs 1]
//
// The folder holds recordings with the expected text beside each one:
//     cat1.webm  +  cat1.txt   (the text of what the child was asked to say, for example "I see a cat")
// Only use recordings that a parent has permitted for this purpose. The script sends each recording to the chosen
// provider(s) using the same adapters as the app, and prints per provider:
//   - how many recordings failed or heard nothing,
//   - average word accuracy (the same word matching the scorer uses: plurals and one small spelling slip allowed),
//   - exact-match rate, and latency (mean, median, 95th percentile) in milliseconds.
// Nothing is stored. The results table contains what the children said, so keep the output private.

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const speech = require("../src/services/tutorSpeechService");
const { tokens, wordsMatch } = require("../src/services/tutorScoringService");

const MIME = { ".webm": "audio/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".flac": "audio/flac" };
const STOP = new Set(["a", "an", "the"]);

function wordAccuracy(expected, heard) {
  const target = tokens(expected).filter((w) => !STOP.has(w));
  const said = tokens(heard);
  if (!target.length) return null;
  return target.filter((w) => said.some((s) => wordsMatch(w, s))).length / target.length;
}

const percentile = (list, p) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const fmt = (n, digits = 0) => (n === null ? "n/a" : n.toFixed(digits));

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith("--"));
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  if (!folder || !fs.existsSync(folder)) {
    console.error("Usage: node scripts/evalStt.js <folder of recordings with .txt files> [--providers xai,groq] [--runs 1]");
    process.exitCode = 1;
    return;
  }
  const providers = option("providers", process.env.TUTOR_STT_PROVIDER || "xai").split(",").map((p) => p.trim()).filter(Boolean);
  const runs = Math.max(1, Number(option("runs", 1)) || 1);

  const samples = fs.readdirSync(folder)
    .filter((f) => MIME[path.extname(f).toLowerCase()] && fs.existsSync(path.join(folder, `${path.parse(f).name}.txt`)))
    .map((f) => ({ file: f, mime: MIME[path.extname(f).toLowerCase()], expected: fs.readFileSync(path.join(folder, `${path.parse(f).name}.txt`), "utf8").trim() }));
  if (!samples.length) {
    console.error("No recordings with a matching .txt file were found.");
    process.exitCode = 1;
    return;
  }
  console.log(`${samples.length} recordings, ${runs} run(s) each, providers: ${providers.join(", ")}\n`);

  for (const provider of providers) {
    process.env.TUTOR_STT_PROVIDER = provider;
    if (!speech.status().stt.enabled) {
      console.log(`${provider}: not configured (needs its API key in backend/.env)\n`);
      continue;
    }
    const rows = [];
    for (const sample of samples) {
      const audio = fs.readFileSync(path.join(folder, sample.file));
      for (let i = 0; i < runs; i += 1) {
        const started = Date.now();
        try {
          const out = await speech.transcribe(audio, sample.mime);
          rows.push({ ...sample, heard: out.transcript, ms: Date.now() - started, accuracy: wordAccuracy(sample.expected, out.transcript), status: "ok" });
        } catch (error) {
          rows.push({ ...sample, heard: "", ms: Date.now() - started, accuracy: 0, status: error.code || "error" });
        }
      }
    }
    const ok = rows.filter((r) => r.status === "ok");
    const accs = rows.map((r) => r.accuracy).filter((a) => a !== null);
    const times = ok.map((r) => r.ms);
    console.log(`== ${provider}`);
    console.log(`   recordings: ${rows.length}, answered: ${ok.length}, failed or silent: ${rows.length - ok.length}`);
    console.log(`   word accuracy: ${fmt(mean(accs) * 100, 1)}% (failures count as 0), exact matches: ${rows.filter((r) => r.accuracy === 1).length}/${rows.length}`);
    console.log(`   latency ms: mean ${fmt(mean(times))}, median ${fmt(percentile(times, 50))}, p95 ${fmt(percentile(times, 95))}  (SRS target: response within 4 s end to end)`);
    for (const r of rows.filter((x) => x.accuracy < 1)) console.log(`   - ${r.file}: expected "${r.expected}" heard "${r.heard}" (${r.status})`);
    console.log();
  }
}

main().catch((error) => {
  console.error("Evaluation failed:", error.message);
  process.exitCode = 1;
});
