---
name: tutor-lesson
version: 1
---
You write one short English speaking lesson for a young child who is learning English as a second language.

The learner: {{age_rules}}
Topic: {{topic_label}}
Number of items: {{count}}, in exactly this order: {{mix}}

Write a tiny story setup first: one friendly, original character with a single made-up first name (letters only, for example "Momo") and an intro of at most two very short sentences. Never use a character from any book, film, show or game.

Then write the items. Item types:
- listen_repeat: give "say", a short sentence the child repeats. Example: "I see a cat"
- name_picture: give "pictureKey", one key from the allowed picture list below. The app shows the picture and asks the child to name it.
- answer_question: give "prompt", one short question ending with "?". Then EITHER
  (a) a closed question: "acceptedAnswers" is a list of objects with "text" (a full short answer) and "targetWords" (the key words in it), and "choices" is a list of 2 or 3 single words the child could tap instead (include the correct one), OR
  (b) an open question about a category: give "answerCategory" (one of: {{category_names}}) and "answerTemplate", an answer sentence containing {w} where the child's word goes. Example: "I like {w}"

Hard rules:
- Use ONLY words from the three lists below, plus the character's name. Do not use any other word, even a common one.
- Keep sentences very short. Questions at most {{max_question_words}} words, answers at most {{max_answer_words}} words, "say" at most {{max_say_words}} words.
- Letters, spaces, apostrophes and the marks . , ? ! only. No digits, emoji or links.
- Never ask about the child's name, age, family, home, school, phone, photos or anything personal. Keep everything friendly, safe and about the topic.
- The questions must have answers a child can give from what they see or like, not facts they must already know.

Allowed words (base): {{base_words}}
Allowed words (topic): {{topic_vocab}}
Words to practise today (use several of them if they fit): {{practice_words}}
Allowed picture keys: {{picture_keys}}

Reply with JSON only, no other text, in this shape:
{"story":{"character":"Momo","intro":"Momo is a little dragon. Momo likes animals."},"items":[{"activityType":"listen_repeat","say":"I see a cat"},{"activityType":"name_picture","pictureKey":"dog"},{"activityType":"answer_question","prompt":"Do you like dogs?","acceptedAnswers":[{"text":"Yes I do","targetWords":["yes"]}],"choices":["yes","no"]},{"activityType":"answer_question","prompt":"What animal do you like?","answerCategory":"animal","answerTemplate":"I like {w}"}]}
