const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve("data");
const OUTPUT = path.resolve("data/birthday-photos.json");

const USER_AGENT =
  "WhatToPlayToday/1.0 (birthday photo collector)";

const REQUEST_DELAY = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWikipedia(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    if (response.ok) {
      return response;
    }

    if (response.status === 429) {
      const wait = attempt * 3000;

      console.log(
        `Wikipedia 429 — ждём ${wait / 1000} сек.`
      );

      await sleep(wait);
      continue;
    }

    throw new Error(`Wikipedia HTTP ${response.status}`);
  }

  throw new Error("Wikipedia HTTP 429 после повторных попыток");
}

function cleanName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getWikipediaPhoto(name) {
  const normalizedName = name
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  /*
   * Сначала пробуем найти точную Wikipedia-страницу
   * через action=query&titles.
   */
  const exactUrl =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      titles: name,
      prop: "pageimages|info",
      inprop: "url",
      piprop: "thumbnail|original",
      pithumbsize: "500",
    });

  const exactResponse = await fetchWikipedia(exactUrl);

  const exactData = await exactResponse.json();
  const exactPages = Object.values(
    exactData.query?.pages || {}
  );

  /*
   * Если Wikipedia действительно имеет страницу
   * с таким названием — используем её.
   */
  const exactPage = exactPages.find(
    (page) =>
      !page.missing &&
      String(page.title || "").toLowerCase() ===
        name.toLowerCase() &&
      (page.original?.source || page.thumbnail?.source)
  );

  if (exactPage) {
    return {
      name,
      wikipediaTitle: exactPage.title,
      wikipediaUrl: exactPage.fullurl,
      imageUrl:
        exactPage.original?.source ||
        exactPage.thumbnail?.source ||
        null,
    };
  }

  /*
   * Точного совпадения нет.
   *
   * Теперь используем поиск Wikipedia, но принимаем
   * только очень близкое совпадение имени.
   */
  const searchUrl =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      generator: "search",
      gsrsearch: `"${name}"`,
      gsrlimit: "10",
      prop: "pageimages|info",
      inprop: "url",
      piprop: "thumbnail|original",
      pithumbsize: "500",
    });

  const searchResponse = await fetchWikipedia(searchUrl);

  const searchData = await searchResponse.json();
  const pages = Object.values(
    searchData.query?.pages || {}
  );

  /*
   * Проверяем каждую найденную страницу.
   */
  for (const page of pages) {
    if (!page.original?.source && !page.thumbnail?.source) {
      continue;
    }

    const title = String(page.title || "");

    const normalizedTitle = title
      .toLowerCase()
      .replace(/[.'’]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    /*
     * Принимаем только если название страницы
     * совпадает с именем или содержит имя целиком.
     */
    if (
      normalizedTitle === normalizedName ||
      normalizedTitle.startsWith(`${normalizedName} `) ||
      normalizedTitle.startsWith(`${normalizedName}(`)
    ) {
      return {
        name,
        wikipediaTitle: title,
        wikipediaUrl: page.fullurl,
        imageUrl:
          page.original?.source ||
          page.thumbnail?.source ||
          null,
      };
    }
  }

  /*
   * Если уверенного совпадения нет —
   * лучше оставить человека без фотографии,
   * чем показать фотографию другого человека.
   */
  return null;
}

function collectBirthdays() {
  const names = new Set();

  const files = fs
    .readdirSync(DATA_DIR)
    .filter(
      (file) =>
        file.endsWith(".json") &&
        file !== "music-works.json" &&
        file !== "birthday-photos.json"
    );

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);

    let events;

    try {
      events = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    for (const event of events) {
      if (String(event.nEventID) !== "2") {
        continue;
      }

      const name = cleanName(event.sArtist);

      if (name) {
        names.add(name);
      }
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

async function main() {
  console.log("Собираем список людей...");

    const allNames = collectBirthdays();
    const names = allNames.slice(0, 50);

    console.log(`Всего найдено людей: ${allNames.length}`);
    console.log(`Тест: обрабатываем первых ${names.length}`);

  let results = {};

  if (fs.existsSync(OUTPUT)) {
    try {
      results = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
    } catch {
      results = {};
    }
  }

  let processed = 0;
  let found = 0;

  for (const name of names) {
    if (results[name]) {
      continue;
    }

    try {
      const photo = await getWikipediaPhoto(name);

      results[name] = photo;

      if (photo?.imageUrl) {
        found++;
        console.log(
          `✓ ${name} → ${photo.wikipediaTitle}`
        );
      } else {
        console.log(`— ${name} → фото не найдено`);
      }
    } catch (error) {
      console.log(
        `✗ ${name} → ${error.message}`
      );

      results[name] = null;
    }

    processed++;

    if (processed % 25 === 0) {
      fs.writeFileSync(
        OUTPUT,
        JSON.stringify(results, null, 2),
        "utf8"
      );

      console.log(
        `Сохранено. Обработано в этом запуске: ${processed}`
      );
    }

    await sleep(REQUEST_DELAY);
  }

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  console.log("");
  console.log("Готово!");
  console.log(`Всего людей: ${names.length}`);
  console.log(`Новых фотографий найдено: ${found}`);
  console.log(`Файл: ${OUTPUT}`);
}

main().catch((error) => {
  console.error("Ошибка:", error);
  process.exit(1);
});