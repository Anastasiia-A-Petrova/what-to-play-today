require("dotenv").config();

const {
  validateMusic
} = require("./musicbrainz-validator-v3.cjs");

const fs = require("fs");
const path = require("path");

const MODEL = "gemini-3.5-flash-lite";

const DATA_DIR = path.join(__dirname, "..", "data");
const OUTPUT_DIR = path.join(DATA_DIR, "ai-music");

const BATCH_SIZE = 5;
const MAX_RETRIES = 5;
const RETRY_DELAYS = [3000, 6000, 12000, 24000, 48000];

function getTodayDate() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const parts = formatter.formatToParts(now);

  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value.toLowerCase();
  const day = parts.find(p => p.type === "day").value;

  return {
    year,
    month,
    day,
    slug: `${month}-${day}`,
  };
}

function getRequestedDate() {
  const argumentDate = process.argv[2];

  if (argumentDate) {
    const [month, day] = argumentDate.toLowerCase().trim().split("-");

    return {
      month,
      day,
      slug: argumentDate.toLowerCase().trim(),
    };
  }

  return getTodayDate();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function makePrompt(batch) {
  return `
Ты извлекаешь музыкальные произведения из текстов музыкальной хроники.

Твоя задача — извлечь ТОЛЬКО конкретные песни и альбомы, которые действительно упоминаются в исходном тексте.

НЕ извлекай:
- людей сами по себе;
- музыкальные группы сами по себе;
- концерты;
- туры;
- фильмы;
- телепередачи;
- события;
- места;
- жанры;
- инструменты;
- другие объекты, которые не являются конкретной песней или альбомом.

Важно:

1. event_artist — главный человек, группа или артист, вокруг которого построено событие.
   Это НЕ обязательно исполнитель каждой найденной песни.

2. Для songs:
   - title — конкретное название песни;
   - performer — исполнитель этой версии песни;
   - original_artist — оригинальный исполнитель ТОЛЬКО если исходный текст явно говорит, что это кавер/версия чужой песни. Иначе null.

3. Для albums:
   - title — конкретное название альбома;
   - artist — исполнитель/группа, выпустившая альбом.

4. Не добавляй произведения, которых нет в исходном тексте, даже если ты знаешь их по общему музыкальному контексту.

4.1. Название песни или альбома извлекай МАКСИМАЛЬНО ПОЛНО из исходного текста.
Не сокращай название и не выбрасывай из него слова.

Например:

Если в тексте написано:
"Motown Chartbusters Vol 4 went to No.1"

ПРАВИЛЬНО:
title: "Motown Chartbusters Vol 4"

НЕПРАВИЛЬНО:
title: "Vol 4"

Если в тексте написано полное название произведения, используй именно это полное название.

4.2. Не заменяй название произведения другим названием из своих знаний.
Опирайся прежде всего на исходный description.

4.3. Не объединяй разные варианты имени одного и того же исполнителя.

Например:

ПРАВИЛЬНО:
performer: ["Beastie Boys"]

НЕПРАВИЛЬНО:
performer: ["The Beastie Boys", "Beastie Boys"]

ПРАВИЛЬНО:
artist: "Gerry and the Pacemakers"

НЕПРАВИЛЬНО:
artist: "Gerry & the Pacemakers, Gerry and the Pacemakers"

Если в исходном тексте используется один вариант имени исполнителя, не добавляй к нему второй вариант только потому, что знаешь его.

4.4. Если произведение исполняют несколько РАЗНЫХ артистов совместно, сохрани их как отдельных исполнителей.

Например:

"The Monster" by Eminem featuring Rihanna

→

title: "The Monster"
performer: ["Eminem", "Rihanna"]

Не путай реальную коллаборацию с разными вариантами имени одного и того же артиста.

5. Если в тексте говорится о кавере, указывай именно исполнителя версии, которая описывается в тексте, а оригинального исполнителя помещай в original_artist.

6. Если человек является автором/участником группы, но конкретная песня принадлежит группе, исполнителем песни должна быть группа.

Примеры:

Leona Lewis записала "Bleeding Love", а Take That выпустили "Rule The World".

→
Leona Lewis:
Bleeding Love

Take That:
Rule The World

Если написано, что Coolio записал "Gangsta's Paradise", основанную на песне Stevie Wonder "Pastime Paradise":

→
Gangsta's Paradise
performer: ["Coolio"]
original_artist: "Stevie Wonder"

Если написано, что Ken Boothe записал кавер "Everything I Own", оригинал David Gates:

→
title: "Everything I Own"
performer: ["Ken Boothe"]
original_artist: "David Gates"

Если William Reid связан с The Jesus and Mary Chain и текст говорит о песне "April Skies":

→
title: "April Skies"
performer: ["The Jesus and Mary Chain"]

НЕ:
performer: ["William Reid"]

Если отдельно упомянут альбом "Darklands":

→
album:
title: "Darklands"
artist: "The Jesus and Mary Chain"

Не разделяй автоматически конструкцию вида "A / B".
Если текст явно представляет "A / B" как одно название релиза, сохрани его целиком.

Но если конкретное название отдельно описывается как отдельная песня, извлеки его отдельно.

Каждый входной объект должен получить РОВНО один результат с тем же id.

Если в записи нет конкретных песен или альбомов, верни пустые массивы.

Верни ТОЛЬКО валидный JSON следующего формата:

{
  "results": [
    {
      "id": "ID",
      "event_artist": "Главный артист",
      "songs": [
        {
          "title": "Название песни",
          "performer": ["Исполнитель"],
          "original_artist": null
        }
      ],
      "albums": [
        {
          "title": "Название альбома",
          "artist": "Исполнитель"
        }
      ]
    }
  ]
}

Данные для обработки:

${JSON.stringify(batch, null, 2)}
`;
}

async function requestGemini(batch) {
  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY не найден в .env");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: makePrompt(batch),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        if ([429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`RETRYABLE ${response.status}: ${errorText}`);
        }

        throw new Error(`${response.status}: ${errorText}`);
      }

      const data = await response.json();

      const text =
        data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error("Gemini не вернул текстовый ответ");
      }

      const result = JSON.parse(text);

      if (!result.results || !Array.isArray(result.results)) {
        throw new Error("Некорректный формат ответа Gemini");
      }

      return result.results;
    } catch (error) {
      const isRetryable =
        error.message.startsWith("RETRYABLE");

      if (!isRetryable || attempt === MAX_RETRIES - 1) {
        throw error;
      }

      const delay = RETRY_DELAYS[attempt];

      console.log(
        `  ↻ Gemini временная ошибка. Повтор через ${delay / 1000} сек.`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  const today = getRequestedDate();

  console.log("================================");
  console.log("🎵 EXTRACT TODAY MUSIC");
  console.log("================================");
  console.log(`Сегодня: ${today.slug}`);
  console.log("");

  const inputFile = path.join(DATA_DIR, `${today.slug}.json`);

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Не найден исходный файл:\n${inputFile}`);
  }

  const events = readJson(inputFile);

  console.log(`Исходных записей: ${events.length}`);
  console.log(`Источник: ${inputFile}`);
  console.log("");

  const input = events.map(event => ({
    id: String(event.nID),
    event_artist: event.sArtist || "",
    description: event.sDescription || "",
  }));

  const allResults = [];

  for (let i = 0; i < input.length; i += BATCH_SIZE) {
    const batch = input.slice(i, i + BATCH_SIZE);

    console.log(
      `Обрабатываем ${i + 1}-${Math.min(i + BATCH_SIZE, input.length)} из ${input.length}...`
    );

    const results = await requestGemini(batch);

    allResults.push(...results);

    console.log(`  ✓ Получено результатов: ${results.length}`);

    if (i + BATCH_SIZE < input.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /*
   * Проверяем, что Gemini не потерял записи.
   */
  const inputIds = new Set(input.map(item => item.id));
  const resultIds = new Set(allResults.map(item => String(item.id)));

  const missingIds = [...inputIds].filter(id => !resultIds.has(id));

  if (missingIds.length > 0) {
    console.warn("");
    console.warn("⚠ Gemini не вернул результаты для ID:");
    console.warn(missingIds.join(", "));
  }

    /*
    * Gemini завершил extraction.
    * Теперь сразу передаём результат в MusicBrainz V3.
    */

    const inputById = new Map(
      input.map(item => [
        String(item.id),
        item
      ])
    );

    const resultsWithSource = allResults.map(result => {
      const sourceEvent =
        inputById.get(String(result.id));

      return {
        ...result,

        source_event: sourceEvent
          ? {
              event_artist:
                sourceEvent.event_artist,

              description:
                sourceEvent.description,
            }
          : null,
      };
    });

    const geminiOutput = {
      date: today.slug,
      source: path.basename(inputFile),
      model: MODEL,
      generatedAt: new Date().toISOString(),
      results: resultsWithSource,
    };

    console.log("");
    console.log("================================");
    console.log("🔎 MUSICBRAINZ VALIDATION");
    console.log("================================");
    console.log("");

    const validatedOutput =
    await validateMusic(geminiOutput);

    /*
    * Сохраняем уже финальный результат:
    * Gemini + MusicBrainz.
    */

    const output = {
    date: today.slug,
    source: path.basename(inputFile),
    model: MODEL,
    generatedAt: geminiOutput.generatedAt,
    validatedAt: validatedOutput.validated_at,

    summary:
        validatedOutput.summary,

    results:
        validatedOutput.results,

    conflicts:
        validatedOutput.conflicts,
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const outputFile = path.join(
    OUTPUT_DIR,
    `${today.slug}.json`
    );

    fs.writeFileSync(
    outputFile,
    JSON.stringify(output, null, 2),
    "utf8"
    );

  console.log("");
  console.log("================================");
  console.log("🎉 EXTRACTION ЗАВЕРШЁН");
  console.log("================================");
  console.log(`Записей: ${allResults.length}`);
  console.log(`Файл: ${outputFile}`);
}

main().catch(error => {
  console.error("");
  console.error("❌ ОШИБКА:");
  console.error(error.message);
  process.exit(1);
});