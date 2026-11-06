const fs = require("fs");
const path = require("path");

const MUSIC_ENRICHMENT_DIR = path.resolve("data/music-enrichment");

const USER_AGENT =
  "WhatToPlayToday/1.0 (daily cover collector)";

const DELAY = 1200;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractReleaseGroupId(coverUrl) {
  if (!coverUrl || typeof coverUrl !== "string") {
    return null;
  }

  const match = coverUrl.match(
    /coverartarchive\.org\/release-group\/([0-9a-f-]+)/i
  );

  return match ? match[1] : null;
}

async function getCoverArtImages(releaseGroupId) {
  if (!releaseGroupId) {
    return [];
  }

  const url =
    `https://coverartarchive.org/release-group/` +
    `${releaseGroupId}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });

      if (!response.ok) {
        if ([429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`HTTP ${response.status}`);
        }

        return [];
      }

      const data = await response.json();

      return Array.isArray(data.images)
        ? data.images
        : [];
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw error;
      }

      console.log(
        `    ↻ ${error.message}, повтор через 3 сек.`
      );

      await sleep(3000);
    }
  }

  return [];
}

function chooseBestCover(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }

  const usable = images.filter(
    image =>
      image &&
      typeof image.image === "string" &&
      image.image.trim()
  );

  if (!usable.length) {
    return null;
  }

  // 1. Явно отмеченная Front
  const front = usable.find(
    image => image.front === true
  );

  if (front) {
    return front.image;
  }

  // 2. Front в массиве types
  const typedFront = usable.find(image =>
    Array.isArray(image.types) &&
    image.types.some(
      type =>
        String(type).toLowerCase() === "front"
    )
  );

  if (typedFront) {
    return typedFront.image;
  }

  // 3. Любая картинка, кроме CD / medium / label
  const normalImage = usable.find(image => {
    const types = Array.isArray(image.types)
      ? image.types.map(type =>
          String(type).toLowerCase()
        )
      : [];

    return !types.some(type =>
      ["medium", "cd", "label"].includes(type)
    );
  });

  if (normalImage) {
    return normalImage.image;
  }

  // 4. Крайний случай
  return usable[0].image;
}

function readCache(filePath) {
  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch {
    return null;
  }
}

function saveCache(filePath, data) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

async function main() {
  if (!fs.existsSync(MUSIC_ENRICHMENT_DIR)) {
    console.log(
      "Папка data/music-enrichment не найдена."
    );
    return;
  }

  const allFiles = fs
    .readdirSync(MUSIC_ENRICHMENT_DIR)
    .filter(file => file.endsWith(".json"));

  const limit = Number(process.argv[2]);

  const files =
    Number.isFinite(limit) && limit > 0
      ? allFiles.slice(0, limit)
      : allFiles;

  console.log("");
  console.log("================================");
  console.log("Обновление кэша обложек");
  console.log("================================");
  console.log(`Всего файлов: ${allFiles.length}`);
  console.log(`Проверяем: ${files.length}`);
  console.log("");

  let checked = 0;
  let changed = 0;
  let kept = 0;
  let noReplacement = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = path.join(
      MUSIC_ENRICHMENT_DIR,
      file
    );

    const cached = readCache(filePath);

    if (!cached) {
      console.log(`⚠ ${file} — битый JSON`);
      errors++;
      continue;
    }

    const releaseGroupId =
      extractReleaseGroupId(cached.coverUrl);

    checked++;

    console.log(
      `[${checked}/${files.length}] ` +
      `${cached.artist || "?"} — ${cached.title || "?"}`
    );

    console.log(
      `  Release Group: ${releaseGroupId || "не найден"}`
    );

    if (!releaseGroupId) {
      console.log(
        "  — Не удалось определить Release Group из старого URL"
      );

      noReplacement++;
      continue;
    }

    const oldCover = cached.coverUrl;

    try {
      const images =
        await getCoverArtImages(releaseGroupId);

      console.log(
        `  Изображений в CAA: ${images.length}`
      );

      const newCover =
        chooseBestCover(images);

      if (!newCover) {
        console.log(
          "  — Подходящей обложки нет"
        );

        noReplacement++;
      } else if (newCover === oldCover) {
        console.log(
          "  = Оставляем текущую обложку"
        );

        kept++;
      } else {
        console.log("  ✓ Найдена другая обложка");
        console.log(`    старая: ${oldCover}`);
        console.log(`    новая:  ${newCover}`);

        cached.coverUrl = newCover;
        cached.savedAt =
          new Date().toISOString();

        saveCache(filePath, cached);

        changed++;
      }
    } catch (error) {
      errors++;

      console.log(
        `  ✗ Ошибка: ${error.message}`
      );

      console.log(
        "    Старый кэш НЕ изменён."
      );
    }

    await sleep(DELAY);
  }

  console.log("");
  console.log("================================");
  console.log("ГОТОВО");
  console.log("================================");
  console.log(`Проверено:              ${checked}`);
  console.log(`Заменено:               ${changed}`);
  console.log(`Оставлено:              ${kept}`);
  console.log(`Нет подходящей:         ${noReplacement}`);
  console.log(`Ошибок:                 ${errors}`);
  console.log("================================");
}

main().catch(error => {
  console.error("");
  console.error("Критическая ошибка:");
  console.error(error);
  process.exit(1);
});