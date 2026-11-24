// Removes obvious contact details from free text before it is stored or shown to a teacher (SRS FR-11).
// It is a first-line filter for what a child might say or what a speech recogniser might transcribe:
// email addresses, links, @handles and phone-number-like digit runs, including digits spoken as words.
// It cannot recognise every kind of personal information (for example a street name), so the tutor also
// never asks for personal information and restricts what the model may write.

const DIGIT_WORDS = "zero|oh|one|two|three|four|five|six|seven|eight|nine";
const PATTERNS = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,                                   // email address
  /\b(?:https?:\/\/|www\.)\S+/gi,                                     // link
  /(?<![\w])@\w{2,}/g,                                                // @handle
  /\+?\d(?:[\s().-]?\d){6,}/g,                                        // phone-number-like digit run (ends on a digit)
  new RegExp(`\\b(?:(?:${DIGIT_WORDS})[\\s,.-]+){6,}(?:${DIGIT_WORDS})\\b`, "gi"), // digits spoken as words
];

const PLACEHOLDER = "[removed]";

function scrubContactDetails(text) {
  let out = String(text ?? "");
  for (const pattern of PATTERNS) out = out.replace(pattern, PLACEHOLDER);
  return out;
}

module.exports = { scrubContactDetails, PLACEHOLDER };
