const fs = require("fs");
const path = require("path");

const INPUT = path.join(__dirname, "..", "data", "music-works.json");
const OUTPUT = INPUT;

const MUSICBRAINZ_URL = "https://musicbrainz.org/ws/2";
const USER_AGENT = "WhatToPlayToday/1.0 (music app)";

const REQUEST_DELAY = 1100;
const MAX_RETRIES = 3;
const SAVE_EVERY = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (response.ok) {
      return response.json();
    }

    if (
      response.status === 429 ||
      response.status === 500 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      let waitTime = 3000 * attempt;

      const retryAfter = response.headers.get("retry-after");

      if (retryAfter) {
        const seconds = Number(retryAfter);

        if (Number.isFinite(seconds)) {
          waitTime = Math.max(seconds * 1000, waitTime);
        }
      }

      if (attempt < MAX_RETRIES) {
        console.log(
          `  ↻ MusicBrainz HTTP ${response.status}, повтор через ${Math.round(
            waitTime / 1000
          )} сек.`
        );

        await sleep(waitTime);
        continue;
      }
    }

    throw new Error(`HTTP ${response.status}: ${url}`);
  }
}

async function checkCover(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          "User-Agent": USER_AGENT,
        },
      });

      if (response.ok) {
        return true;
      }

      if (
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        if (attempt < MAX_RETRIES) {
          await sleep(2000 * attempt);
          continue;
        }
      }

      return false;
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(2000 * attempt);
        continue;
      }

      return false;
    }
  }

  return false;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function findCover(title, artist) {
  if (!title || !artist) {
    return null;
  }

  const query =
    `recording:"${title.replace(/"/g, '\\"')}" ` +
    `AND artist:"${artist.replace(/"/g, '\\"')}"`;

  const url =
    `${MUSICBRAINZ_URL}/recording` +
    `?query=${encodeURIComponent(query)}` +
    `&fmt=json&limit=5` +
    `&inc=releases`;

  const data = await fetchJson(url);

  for (const recording of data.recordings || []) {
    const releases = recording.releases || [];

    for (const release of releases) {
      const releaseGroupId = release["release-group"]?.id;

      if (!releaseGroupId) {
        continue;
      }

      const coverUrl =
        `https://coverartarchive.org/release-group/` +
        `${releaseGroupId}/front-500`;

      const exists = await checkCover(coverUrl);

      if (exists) {
        return coverUrl;
      }
    }
  }

  return null;
}

function saveData(data) {
  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

async function main() {
  const data = JSON.parse(fs.readFileSync(INPUT, "utf8"));

  const cache = new Map();

  let checked = 0;
  let found = 0;
  let skipped = 0;

  const totalWorks = data.reduce(
    (sum, item) => sum + (item.works || []).length,
    0
  );

  console.log(`Всего произведений: ${totalWorks}`);
  console.log("");

  for (const item of data) {
    for (const work of item.works || []) {
      if (!work.title || !work.artist) {
        skipped++;
        continue;
      }

      const key =
        `${normalize(work.title)}|${normalize(work.artist)}`;

      // Если обложка уже найдена ранее — ничего не делаем.
      if (work.coverUrl) {
        skipped++;
        continue;
      }

      // Если это такое же произведение уже встречалось,
      // используем результат из памяти.
      if (cache.has(key)) {
        const cachedCover = cache.get(key);

        work.coverUrl = cachedCover;

        if (cachedCover) {
          found++;
        }

        skipped++;
        continue;
      }

      checked++;

      console.log(
      `[${checked}] ${work.artist} — ${work.title}`
      );

      try {
        const coverUrl = await findCover(
          work.title,
          work.artist
        );

        cache.set(key, coverUrl);
        work.coverUrl = coverUrl;

        if (coverUrl) {
          found++;
          console.log(`  ✓ Обложка найдена`);
        } else {
          console.log(`  — Обложка не найдена`);
        }
      } catch (error) {
        console.log(`  ✗ Ошибка: ${error.message}`);

        // Ошибку не считаем отсутствием обложки.
        // Такую запись можно будет обработать повторно
        // при следующем запуске.
        cache.set(key, null);
        work.coverUrl = null;
      }

      if (checked % SAVE_EVERY === 0) {
        saveData(data);

        console.log(
          `  💾 Сохранено. Проверено: ${checked}, найдено: ${found}`
        );
      }

      await sleep(REQUEST_DELAY);
    }
  }

  saveData(data);

  console.log("");
  console.log("================================");
  console.log(`Проверено: ${checked}`);
  console.log(`Обложек найдено: ${found}`);
  console.log(`Пропущено: ${skipped}`);
  console.log(`Файл обновлён: ${OUTPUT}`);
  console.log("================================");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});