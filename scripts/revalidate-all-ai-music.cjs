const fs = require("fs");
const path = require("path");

const {
  validateMusic
} = require("./musicbrainz-validator-v3.cjs");

const inputDir = path.join(
  __dirname,
  "..",
  "data",
  "ai-music"
);

const outputDir = path.join(
  __dirname,
  "..",
  "data",
  "ai-music-revalidated"
);

const files = [
  "october-29.json",
  "october-30.json",
  "october-31.json",
  "november-01.json",
  "november-02.json",
  "november-03.json",
  "november-04.json"
];

async function revalidateFile(fileName) {
  const inputFile = path.join(
    inputDir,
    fileName
  );

  const outputFile = path.join(
    outputDir,
    fileName
  );

  console.log("");
  console.log("================================");
  console.log(`Файл: ${fileName}`);
  console.log("================================");
  console.log("");

  const source = JSON.parse(
    fs.readFileSync(
      inputFile,
      "utf8"
    )
  );

  const results = [];

  for (const item of source.results || []) {
    const songs = [];

    for (const song of item.songs || []) {
      const input = song.input;

      if (!input) {
        console.log(
          `⚠ Пропуск песни без input: ${item.event_artist}`
        );
        continue;
      }

      const validated = await validateMusic({
        results: [
          {
            songs: [input],
            albums: []
          }
        ]
      });

      songs.push(
        validated.results?.[0]?.songs?.[0] || {
          input,
          validation: null
        }
      );
    }

    const albums = [];

    for (const album of item.albums || []) {
      const input = album.input;

      if (!input) {
        console.log(
          `⚠ Пропуск альбома без input: ${item.event_artist}`
        );
        continue;
      }

      const validated = await validateMusic({
        results: [
          {
            songs: [],
            albums: [input]
          }
        ]
      });

      albums.push(
        validated.results?.[0]?.albums?.[0] || {
          input,
          validation: null
        }
      );
    }

    results.push({
      ...item,
      songs,
      albums
    });
  }

  const output = {
    ...source,
    results
  };

  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      output,
      null,
      2
    ),
    "utf8"
  );

  console.log("");
  console.log(`✓ Готово: ${outputFile}`);
}

async function main() {
  fs.mkdirSync(
    outputDir,
    {
      recursive: true
    }
  );

  console.log("");
  console.log("MASS REVALIDATION");
  console.log("=================");
  console.log("");
  console.log(
    `Файлов: ${files.length}`
  );
  console.log(
    "Gemini НЕ запускается."
  );
  console.log(
    "Используется только существующий .input."
  );
  console.log("");

  for (const fileName of files) {
    await revalidateFile(fileName);
  }

  console.log("");
  console.log("================================");
  console.log("ВСЕ ФАЙЛЫ ПЕРЕВАЛИДИРОВАНЫ");
  console.log("================================");
  console.log("");
  console.log(
    `Результаты: ${outputDir}`
  );
}

main().catch(error => {
  console.error("");
  console.error("❌ ОШИБКА:");
  console.error(error);
  process.exit(1);
});