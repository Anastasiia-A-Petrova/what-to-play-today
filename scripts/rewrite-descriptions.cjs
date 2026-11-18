require("dotenv").config();

const fs = require("fs");
const path = require("path");

const MODEL = "gemini-3.5-flash-lite";
const DATA_DIR = path.join(__dirname, "..", "data");

// Не более одного запроса Gemini примерно каждые 4,5 секунды.
const MIN_REQUEST_INTERVAL_MS = 4500;
let lastGeminiRequestAt = 0;

async function waitForGeminiSlot() {
  const elapsed = Date.now() - lastGeminiRequestAt;
  const wait = MIN_REQUEST_INTERVAL_MS - elapsed;

  if (wait > 0) {
    console.log(`  Пауза перед запросом Gemini: ${Math.ceil(wait / 1000)} сек.`);
    await new Promise(resolve => setTimeout(resolve, wait));
  }

  lastGeminiRequestAt = Date.now();
}

function prepareDescription(html) {
  const links = [];
  let text = String(html || "").replace(
    /<a\b[^>]*>[\s\S]*?<\/a>/gi,
    (anchor) => {
      const label = anchor
        .replace(/<a\b[^>]*>/i, "")
        .replace(/<\/a>/i, "")
        .replace(/<[^>]+>/g, "")
        .trim();

      const marker = `[[LINK_${links.length}]]`;
      links.push({ marker, html: anchor, label });

      return marker;
    }
  );

  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  return { text, links };
}

function restoreDescription(text, links) {
  let result = String(text || "").trim();

  for (const link of links) {
    const count = result.split(link.marker).length - 1;

    if (count !== 1) {
      throw new Error(
        `Потерян или продублирован маркер ${link.marker}`
      );
    }
  }

  result = result.replace(/<[^>]*>/g, "");

  result = result.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  for (const link of links) {
    result = result.replace(link.marker, link.html);
  }

  // Проверяем, не придумала ли модель лишние маркеры ссылок.
  const unexpectedMarkers = result.match(/\[\[LINK_\d+\]\]/g);

  if (unexpectedMarkers) {
    throw new Error(
      `Обнаружен неизвестный маркер ссылки: ${[...new Set(unexpectedMarkers)].join(", ")}`
    );
  }

  return result;
}

function normalizeDescription(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function makePrompt(record, prepared) {
  const isBirthday = String(record.nEventID) === "2";

  const instructions = isBirthday
    ? `Rewrite this as a concise, natural English biographical
       profile for a music-history website. Use only the facts
       explicitly stated in the source description.`
    : `Rewrite this as an original, concise English music-history
       entry. Use only the facts explicitly stated in the source
       description.`;

  return `
You are a professional music-history editor.

${instructions}

STRICT FACTUAL RULES:
- The source description is the ONLY source of factual information.
- Do not use your own knowledge, memory or assumptions.
- Do not add any fact, even if you believe it is historically correct.
- Do not add birth years, dates, locations, occupations or biographical details
  unless they explicitly appear in the source.
- Preserve every name, song title, album title, date, year and number.
- Preserve the original meaning and chronology.
- Treat allegations and accusations strictly as allegations.
- Do not turn allegations into established facts.
- Do not make the text more dramatic or add interpretations.

REWRITING RULES:
- Write genuinely original sentences, not synonym substitutions.
- Change sentence structure and phrasing substantially.
- Keep the text concise and natural.
- Do not add an introduction or conclusion.
- Do not make the text longer merely to sound different.
- Preserve all [[LINK_N]] markers exactly once.
- Keep each link marker in a position that preserves its original meaning.
- Do not create HTML or Markdown.

STYLE AND PRECISION:

- Use clear, natural and idiomatic English.
- Prefer simple, precise wording over elaborate expressions.
- Preserve the exact meaning and scope of every factual claim.
- Do not imply exclusivity, causation or comparison unless
  explicitly stated in the source.
- Preserve specific occupations, roles and professional
  descriptions. Do not replace them with broader or less
  precise synonyms. For example, keep "actress" if the
  source says "actress".
- Preserve geographical details and the exact meaning
  of sales figures and chart achievements.
- Do not omit factual details merely to make the text shorter.
- Keep the rewritten description approximately the same
  length as the original.

NATURAL ENGLISH:

- Write as a professional music editor for a general audience.
- Use standard, natural English expressions commonly found
  in music journalism.
- Avoid awkward constructions and unnatural synonyms.
- Do not rewrite simple phrases just to make them sound
  more sophisticated.
- Preserve direct quotations exactly when possible.
- Prefer familiar expressions such as "reached No. 1",
  "sold more than", "was released" and "the first artist
  in history".
- Read the final text as a native English editor would:
  every sentence must sound natural and easy to understand.

FINAL CHECK BEFORE RESPONDING:
- Every factual statement must be supported by the original description.
- No new dates, years, numbers, names or events have been introduced.
- No original factual detail has been lost.
- Every link marker appears exactly once.

Return a valid JSON object with exactly one field: "description".
Do not include commentary or any other fields.

Artist: ${record.sArtist || ""}
Band: ${record.sBand || ""}
Year field: ${record.nYear || ""}

Link markers:
${JSON.stringify(prepared.links.map(link => ({
  marker: link.marker,
  label: link.label
})))}

Original description:
${prepared.text}
`;
}

async function repairMissingMarkers(text, prepared, apiKey) {
  const missing = prepared.links.filter(link => {
    const count = String(text).split(link.marker).length - 1;
    return count !== 1;
  });

  if (missing.length === 0) {
    return text;
  }

  console.log(
    `  Восстанавливаем потерянные ссылки: ${missing.map(link => link.label).join(", ")}`
  );

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const prompt = `
You are repairing link markers in a rewritten music-history description.

The original description contains special link markers.
The rewritten description may have lost some of them.

Your task:
- Compare the original and rewritten descriptions.
- Find where each missing link belongs in the rewritten text.
- Insert each missing marker immediately around its corresponding link label.
- Do not rewrite, paraphrase, shorten or otherwise change the rewritten text.
- Do not change the position of markers that are already present exactly once.
- Every marker must appear exactly once.
- Do not add HTML or Markdown.

Original description with link markers:
${prepared.text}

Rewritten description:
${text}

Link markers and their original labels:
${JSON.stringify(prepared.links.map(link => ({
  marker: link.marker,
  label: link.label
})))}

Return a valid JSON object with exactly one field: "description".
The description must contain all the original markers exactly once.
`;

  await waitForGeminiSlot();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();

    if ([429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`RETRYABLE ${response.status}: ${error}`);
    }

    throw new Error(`Ошибка восстановления ссылок Gemini ${response.status}: ${error}`);
  }

  const data = await response.json();
  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!answer) {
    throw new Error("Gemini не вернул ответ при восстановлении ссылок");
  }

  const parsed = JSON.parse(answer);

  if (
    typeof parsed.description !== "string" ||
    !parsed.description.trim()
  ) {
    throw new Error("Некорректный ответ при восстановлении ссылок");
  }

  for (const link of prepared.links) {
    const count = parsed.description.split(link.marker).length - 1;

    if (count !== 1) {
      throw new Error(
        `Не удалось восстановить маркер ${link.marker}`
      );
    }
  }

  return parsed.description;
}

async function rewriteRecord(record) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY не найден в .env");
  }

  const prepared = prepareDescription(record.sDescription);

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let prompt = makePrompt(record, prepared);

      if (attempt > 0) {
        prompt += `

IMPORTANT RETRY INSTRUCTION:
Your previous response did not preserve all link markers correctly.

You MUST include every marker listed below exactly once:
${prepared.links.map(link => link.marker).join(", ") || "No link markers"}

Do not omit, rename, duplicate, merge or modify any marker.
Each marker represents a separate original hyperlink.
Even if two links have identical visible text, preserve both markers.
Return the complete rewritten description as valid JSON.
`;
      }

      await waitForGeminiSlot();

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: "application/json"
          }
        })
      });

      if (!response.ok) {
        const error = await response.text();

        if ([429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`RETRYABLE ${response.status}: ${error}`);
        }

        throw new Error(`${response.status}: ${error}`);
      }

      const data = await response.json();
      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!answer) {
        throw new Error("Gemini вернул пустой ответ");
      }

      const parsed = JSON.parse(answer);

      if (
        typeof parsed.description !== "string" ||
        !parsed.description.trim()
      ) {
        throw new Error("В ответе отсутствует description");
      }

      const repaired = await repairMissingMarkers(
        parsed.description,
        prepared,
        apiKey
      );

      return restoreDescription(repaired, prepared.links);

    } catch (error) {
      const retryable =
        error.message.startsWith("RETRYABLE") ||
        error.message.includes("Потерян или продублирован маркер") ||
        error.message.includes("Обнаружен неизвестный маркер ссылки");

      if (!retryable || attempt === 2) {
        throw error;
      }

      const retryMatch = error.message.match(
        /"retryDelay"\s*:\s*"(\d+)s"/
      );

      const delay = retryMatch
        ? (Number(retryMatch[1]) + 2) * 1000
        : error.message.startsWith("RETRYABLE")
          ? 3000 * (attempt + 1)
          : 1000;

      console.log(
        `  Повторная попытка ${attempt + 2}/3 через ${delay / 1000} сек.`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}


async function validateRewrite(original, rewritten) {
  const apiKey = process.env.GEMINI_API_KEY;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const prompt = `
You are an independent fact-checking editor for a music-history website.

Compare the original description with the rewritten description.

Your task is to identify factual inaccuracies introduced by rewriting.

IMPORTANT:
You are checking the rewriting process, NOT fact-checking the
historical accuracy of the original source.

STRICT RULES:

- The original description is the ONLY source of truth.
- Do not use external knowledge or your own memory.
- Do not challenge, correct or reinterpret claims already
  present in the original description.
- If a factual claim appears in both descriptions with the
  same meaning, it MUST NOT be reported as an issue.
- This rule applies even if the original claim seems ambiguous,
  contradictory, exaggerated or historically questionable.
- Report an issue ONLY if the rewritten description introduces
  a new factual claim, removes an original fact or changes
  the meaning of an original fact.
- Do not treat awkward wording or stylistic differences
  as factual inaccuracies.
- The original description is the ONLY source of truth.
- Do not use external knowledge or your own memory.
- Do not assume that additional information is correct.
- Check whether any new factual information was introduced.
- Check whether any original facts were removed or changed.
- Check all names, dates, years, numbers, locations and titles.
- Check that allegations remain allegations.
- Check that no allegation has been presented as an established fact.
- Ignore differences in wording and sentence structure.
- Ignore HTML tags and link URLs. Compare the actual text and facts.

Return a valid JSON object with exactly two fields:
{
  "passed": true,
  "issues": []
}

Set passed to false if you find at least one factual problem.
Each issue must briefly explain the problem.
If there are no factual problems, return an empty issues array.

ORIGINAL DESCRIPTION:
${JSON.stringify(original)}

REWRITTEN DESCRIPTION:
${JSON.stringify(rewritten)}
`;

  await waitForGeminiSlot();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ошибка проверки Gemini ${response.status}: ${error}`);
  }

  const data = await response.json();
  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!answer) {
    throw new Error("Проверяющий Gemini вернул пустой ответ");
  }

  const result = JSON.parse(answer);

  if (
    typeof result.passed !== "boolean" ||
    !Array.isArray(result.issues)
  ) {
    throw new Error("Некорректный формат ответа проверяющего агента");
  }

  return result;
}


async function main() {
  const date = process.argv[2] || "november-22";
  const limit = Number(process.argv[3] || 3);

  const inputFile = path.join(DATA_DIR, `${date}.json`);
  const outputDir = path.join(DATA_DIR, "rewritten");
  const outputFile = path.join(outputDir, `${date}.json`);
  const reportFile = path.join(outputDir, `${date}-report.json`);

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Не найден файл: ${inputFile}`);
  }

  const original = JSON.parse(fs.readFileSync(inputFile, "utf8"));

  if (!Array.isArray(original)) {
    throw new Error("Ожидался JSON-массив");
  }

  const selected = original.slice(0, limit);

  fs.mkdirSync(outputDir, { recursive: true });

  let result;
  let completed = [];
  let skipped = [];

  if (fs.existsSync(outputFile) && fs.existsSync(reportFile)) {
    result = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    const oldReport = JSON.parse(fs.readFileSync(reportFile, "utf8"));

    if (!Array.isArray(result) || !Array.isArray(oldReport.completed) ||
        !Array.isArray(oldReport.skipped)) {
      throw new Error("Некорректный формат существующего результата или отчёта");
    }

    if (oldReport.date !== date) {
      throw new Error("Дата в отчёте не совпадает с запрошенной датой");
    }

    completed = oldReport.completed;
    skipped = oldReport.skipped;

    console.log("Найден предыдущий результат. Продолжаем обработку.");
  } else if (fs.existsSync(outputFile) || fs.existsSync(reportFile)) {
    throw new Error(
      "Найден только один из двух файлов результата. Проверь их вручную, чтобы не потерять данные."
    );
  } else {
    result = original.map(item => ({ ...item }));
    console.log("Создаём новый результат.");
  }

  const completedIds = new Set(
    completed.map(item => String(item.id))
  );

  const pending = selected.filter(
    item => !completedIds.has(String(item.nID))
  );

  console.log(`Дата: ${date}`);
  console.log(`Всего записей: ${original.length}`);
  console.log(`Выбрано записей: ${selected.length}`);
  console.log(`Уже готово: ${completed.length}`);
  console.log(`Осталось обработать: ${pending.length}`);
  console.log("");

  function saveProgress() {
    const report = {
      date,
      status: skipped.length === 0 && completed.length === selected.length
        ? "complete"
        : "partial",
      totalRecords: original.length,
      selectedRecords: selected.length,
      completedCount: completed.length,
      skippedCount: skipped.length,
      completed,
      skipped
    };

    fs.writeFileSync(
      outputFile,
      JSON.stringify(result, null, 2),
      "utf8"
    );

    fs.writeFileSync(
      reportFile,
      JSON.stringify(report, null, 2),
      "utf8"
    );
  }

  for (const selectedItem of pending) {
    const item = result.find(
      record => String(record.nID) === String(selectedItem.nID)
    );

    if (!item) {
      console.log(`Не найдена запись ID ${selectedItem.nID}`);
      continue;
    }

    console.log(
      `Обработка ID ${item.nID}: ${item.sArtist || item.sBand}`
    );

    skipped = skipped.filter(
      entry => String(entry.id) !== String(item.nID)
    );

    try {
      const rewritten = await rewriteRecord(item);

      if (
        normalizeDescription(rewritten) ===
        normalizeDescription(item.sDescription)
      ) {
        throw new Error(
          "Описание не изменилось: Gemini вернул исходный текст."
        );
      }

      console.log("  Проверка фактов...");

      const validation = await validateRewrite(
        item.sDescription,
        rewritten
      );

      if (!validation.passed) {
        console.log("  Проверка не пройдена:");

        for (const issue of validation.issues) {
          console.log(`  - ${issue}`);
        }

        throw new Error(
          `Не пройдена проверка фактов: ${validation.issues.join("; ")}`
        );
      }

      item.sDescription = rewritten;

      completed.push({
        id: item.nID,
        artist: item.sArtist || item.sBand
      });

      console.log("  Проверка пройдена");

    } catch (error) {
      skipped.push({
        id: item.nID,
        artist: item.sArtist || item.sBand,
        reason: error.message
      });

      console.log(`  Запись пропущена: ${error.message}`);
    }

    saveProgress();
    console.log("  Прогресс сохранён.");
    console.log("");
  }

  saveProgress();

  console.log("========== ИТОГ ==========");
  console.log(`Успешно переписано: ${completed.length}`);
  console.log(`Пропущено: ${skipped.length}`);
  console.log("");
  console.log(`Результат сохранён: ${outputFile}`);
  console.log(`Отчёт сохранён: ${reportFile}`);
  console.log("Исходный файл не изменён.");

  if (skipped.length > 0) {
    console.log("");
    console.log("ВНИМАНИЕ: результат частичный. Есть записи для повторной обработки.");
  }
}


main().catch(error => {
  console.error("ОШИБКА:", error.message);
  process.exitCode = 1;
});

