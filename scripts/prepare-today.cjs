const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve("data");
const AI_MUSIC_DIR = path.resolve("data/ai-music");
const MUSIC_ENRICHMENT_DIR = path.resolve("data/music-enrichment");
const BIRTHDAY_PHOTOS_FILE = path.resolve("data/birthday-photos.json");

const WIKIPEDIA_USER_AGENT =
  "WhatToPlayToday/1.0 (daily birthday photo collector)";

const WIKIPEDIA_DELAY = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWikipedia(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": WIKIPEDIA_USER_AGENT,
      },
    });

    if (response.ok) {
      return response;
    }

    if (response.status === 429) {
      const wait = attempt * 4000;

      console.log(
        `  Wikipedia 429 — ждём ${wait / 1000} сек.`
      );

      await sleep(wait);
      continue;
    }

    throw new Error(`Wikipedia HTTP ${response.status}`);
  }

  throw new Error("Wikipedia HTTP 429 после повторных попыток");
}

async function findWikipediaPhoto(name) {
  const normalizedName = name
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Сначала пробуем точное название страницы.
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

  const exactPage = exactPages.find((page) => {
    if (page.missing) {
      return false;
    }

    const title = String(page.title || "")
      .toLowerCase()
      .replace(/[.'’]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    return (
      title === normalizedName &&
      (page.original?.source || page.thumbnail?.source)
    );
  });

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

  // Затем ищем близкое название.
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

  return null;
}

/* =======================================================
   Обложки произведений
======================================================= */

const MUSICBRAINZ_URL = "https://musicbrainz.org/ws/2";
const MUSICBRAINZ_USER_AGENT =
  "WhatToPlayToday/1.0 (daily cover collector)";

const MUSICBRAINZ_DELAY = 1100;
const MUSICBRAINZ_MAX_RETRIES = 3;

async function fetchMusicBrainzJson(url) {
  for (let attempt = 1; attempt <= MUSICBRAINZ_MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": MUSICBRAINZ_USER_AGENT,
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

      if (attempt < MUSICBRAINZ_MAX_RETRIES) {
        console.log(
          `  ↻ MusicBrainz HTTP ${response.status}, повтор через ${Math.round(
            waitTime / 1000
          )} сек.`
        );

        await sleep(waitTime);
        continue;
      }
    }

    throw new Error(`HTTP ${response.status}`);
  }
}

async function checkCover(url) {
  for (let attempt = 1; attempt <= MUSICBRAINZ_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          "User-Agent": MUSICBRAINZ_USER_AGENT,
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
        if (attempt < MUSICBRAINZ_MAX_RETRIES) {
          await sleep(2000 * attempt);
          continue;
        }
      }

      return false;
    } catch {
      if (attempt < MUSICBRAINZ_MAX_RETRIES) {
        await sleep(2000 * attempt);
        continue;
      }

      return false;
    }
  }

  return false;
}

async function getCoverArtImages(releaseGroupId) {
  if (!releaseGroupId) {
    return [];
  }

  const url =
    `https://coverartarchive.org/release-group/` +
    `${releaseGroupId}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": MUSICBRAINZ_USER_AGENT,
      },
    });

    if (!response.ok) {
      if (
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        throw new Error(`HTTP ${response.status}`);
      }

      return [];
    }

    const data = await response.json();

    return Array.isArray(data.images) ? data.images : [];
  } catch (error) {
    throw error;
  }
}

function chooseBestCover(images) {
  if (!Array.isArray(images) || !images.length) {
    return null;
  }

  /*
   * Cover Art Archive может вернуть несколько изображений.
   *
   * Приоритет:
   * 1. Front
   * 2. Front среди дополнительных изображений
   * 3. Другие нормальные изображения
   * 4. CD / Medium / Label — только в крайнем случае
   */

  const usable = images.filter((image) => {
    return (
      image &&
      typeof image.image === "string" &&
      image.image.trim()
    );
  });

  if (!usable.length) {
    return null;
  }

  // Настоящая фронтальная обложка.
  const front = usable.find(
    (image) => image.front === true
  );

  if (front) {
    return front.image;
  }

  // Иногда типы приходят не так, как ожидаем,
  // поэтому дополнительно проверяем types.
  const typedFront = usable.find((image) =>
    Array.isArray(image.types) &&
    image.types.some(
      (type) => String(type).toLowerCase() === "front"
    )
  );

  if (typedFront) {
    return typedFront.image;
  }

  // Предпочитаем изображения, которые не выглядят
  // как CD / label / medium.
  const normalImage = usable.find((image) => {
    const types = Array.isArray(image.types)
      ? image.types.map((type) => String(type).toLowerCase())
      : [];

    return !types.some((type) =>
      ["medium", "cd", "label"].includes(type)
    );
  });

  if (normalImage) {
    return normalImage.image;
  }

  // Если вообще ничего другого нет —
  // лучше показать хоть какое-то изображение.
  return usable[0].image;
}

async function findCover(title, artist, type) {
  if (!title || !artist) {
    return null;
  }

  // =========================
  // ПЕСНЯ
  // =========================
  if (type === "song") {
    const query =
      `recording:"${title.replace(/"/g, '\\"')}" ` +
      `AND artist:"${artist.replace(/"/g, '\\"')}"`;

    const url =
      `${MUSICBRAINZ_URL}/recording` +
      `?query=${encodeURIComponent(query)}` +
      `&fmt=json&limit=5` +
      `&inc=releases`;

    const data = await fetchMusicBrainzJson(url);

    for (const recording of data.recordings || []) {
      const releases = recording.releases || [];

      for (const release of releases) {
        const releaseGroupId = release["release-group"]?.id;

        if (!releaseGroupId) {
          continue;
        }

        try {
          const images = await getCoverArtImages(releaseGroupId);
          const coverUrl = chooseBestCover(images);

          if (coverUrl) {
            return coverUrl;
          }
        } catch (error) {
          console.log(
            `  ↻ Cover Art Archive ${error.message}`
          );
        }
      }
    }

    return null;
  }

  // =========================
  // АЛЬБОМ
  // =========================
  if (type === "album") {
    const query =
      `releasegroup:"${title.replace(/"/g, '\\"')}" ` +
      `AND artist:"${artist.replace(/"/g, '\\"')}"`;

    const url =
      `${MUSICBRAINZ_URL}/release-group` +
      `?query=${encodeURIComponent(query)}` +
      `&fmt=json&limit=5`;

    const data = await fetchMusicBrainzJson(url);

    for (const releaseGroup of data["release-groups"] || []) {
      const releaseGroupId = releaseGroup.id;

      if (!releaseGroupId) {
        continue;
      }

      try {
        const images = await getCoverArtImages(releaseGroupId);
        const coverUrl = chooseBestCover(images);

        if (coverUrl) {
          return coverUrl;
        }
      } catch (error) {
        console.log(
          `  ↻ Cover Art Archive ${error.message}`
        );
      }
    }

    return null;
  }

  return null;
}

function getTodayDate() {
  const now = new Date();

  const month = now
    .toLocaleString("en-US", {
      month: "long",
      timeZone: "Europe/Belgrade",
    })
    .toLowerCase();

  const day = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    timeZone: "Europe/Belgrade",
  }).format(now);

  return `${month}-${day}`;
}

function getRequestedDate() {
  const argumentDate = process.argv[2];

  if (argumentDate) {
    return argumentDate.toLowerCase().trim();
  }

  return getTodayDate();
}

function readJson(filePath, fallback = []) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function getEnrichmentFile(mbid) {
  if (!mbid) {
    return null;
  }

  return path.join(MUSIC_ENRICHMENT_DIR, `${mbid}.json`);
}

function readEnrichment(mbid) {
  const filePath = getEnrichmentFile(mbid);

  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function saveEnrichment(mbid, data) {
  const filePath = getEnrichmentFile(mbid);

  if (!filePath) {
    return;
  }

  fs.mkdirSync(MUSIC_ENRICHMENT_DIR, { recursive: true });

  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

/* =======================================================
   Фильтрация произведений
======================================================= */

function isBadWork(work) {
  const title = String(work.title || "")
    .replace(/\s+/g, " ")
    .trim();

  const artist = String(work.artist || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) {
    return true;
  }

  const value = `${artist} — ${title}`.toLowerCase();

  // Явные обрывки / предложения вместо названия произведения.
  if (
    /^by\s+/i.test(title) ||
    /\b(?:by|from|the)\s+(?:english|american|british)\s+(?:band|group)\b/i.test(title) ||
    /^and\s+/i.test(title) ||
    /^or\s+/i.test(title) ||
    /^but\s+/i.test(title)
  ) {
    return true;
  }

  // Название, состоящее фактически из описания.
  if (
    /\b(?:english|american|british|canadian|australian)\s+(?:band|singer|musician|group)\b/i.test(
      title
    )
  ) {
    return true;
  }

  // Очевидные слишком длинные предложения.
  if (title.length > 120) {
    return true;
  }

  // Явные признаки того, что это не название песни/альбома.
  if (
    /\b(?:was|were|is|are|became|reached|peaked|released|recorded)\b/i.test(
      title
    ) &&
    title.split(/\s+/).length > 8
  ) {
    return true;
  }

  // Если название совпадает с исполнителем — обычно это не полезное
  // произведение для блока "What to Play Today?".
  if (
    artist &&
    title.toLowerCase() === artist.toLowerCase()
  ) {
    return true;
  }

  return false;
}

function getWorkKey(work) {
  return [
    work.title || "",
    work.artist || "",
  ]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function makeYoutubeUrl(artist, title) {
  const searchText = [artist, title]
    .filter(Boolean)
    .join(" ");

  return (
    "https://www.youtube.com/results?search_query=" +
    encodeURIComponent(searchText)
  );
}

function makeChordsUrl(artist, title) {
  const searchText = [artist, title]
    .filter(Boolean)
    .join(" ");

  return (
    "https://www.google.com/search?q=" +
    encodeURIComponent(`${searchText} chords`)
  );
}

/* =======================================================
   Данные
======================================================= */

async function main() {
    const date = getRequestedDate();
    const dateFile = path.join(DATA_DIR, `${date}.json`);

console.log(`Сегодня: ${date}`);

if (!fs.existsSync(dateFile)) {
  console.error(`Файл не найден: ${dateFile}`);
  process.exit(1);
}

const events = readJson(dateFile, []);
const birthdayPhotos = readJson(BIRTHDAY_PHOTOS_FILE, {});

const aiMusicFile = path.join(
  AI_MUSIC_DIR,
  `${date}.json`
);

if (!fs.existsSync(aiMusicFile)) {
  throw new Error(
    `Не найден AI-файл музыкальных произведений:\n${aiMusicFile}\n\nСначала запусти:\nnode .\\scripts\\extract-today-music.cjs`
  );
}

const aiMusic = readJson(aiMusicFile, {});

const sourceEventsById = new Map(
  events.map((event) => [String(event.nID), event])
);

/* =======================================================
   Именинники
======================================================= */

const people = events
  .filter((event) => String(event.nEventID) === "2")
  .map((event) => {
    const name = String(event.sArtist || "").trim();

    return {
      name,
      year: event.nYear,
      description: event.sDescription || "",
      eventId: event.nID || null,
      photo: birthdayPhotos[name]?.imageUrl || null,
      wikipediaUrl: birthdayPhotos[name]?.wikipediaUrl || null,
    };
  })
  .filter((person) => person.name);

/* =======================================================
   Получаем фотографии сегодняшних именинников
======================================================= */

let birthdayPhotosChanged = false;

for (const person of people) {
  if (birthdayPhotos[person.name]?.imageUrl) {
    continue;
  }

  console.log("");
  console.log(`Ищем фото: ${person.name}`);

  try {
    const photo = await findWikipediaPhoto(person.name);

    if (photo?.imageUrl) {
      birthdayPhotos[person.name] = photo;
      birthdayPhotosChanged = true;

      person.photo = photo.imageUrl;
      person.wikipediaUrl = photo.wikipediaUrl;

      console.log(
        `  ✓ ${person.name} → ${photo.wikipediaTitle}`
      );
    } else {
      console.log(
        `  — ${person.name} → фото не найдено`
      );
    }
  } catch (error) {
    console.log(
      `  ✗ ${person.name} → ${error.message}`
    );
  }

  await sleep(WIKIPEDIA_DELAY);
}

if (birthdayPhotosChanged) {
  fs.writeFileSync(
    BIRTHDAY_PHOTOS_FILE,
    JSON.stringify(birthdayPhotos, null, 2),
    "utf8"
  );

  console.log("");
  console.log("Файл birthday-photos.json обновлён.");
}


/* =======================================================
   Произведения
======================================================= */

const works = [];
const seenWorks = new Set();

for (const item of aiMusic.results || []) {
  const sourceEvent = sourceEventsById.get(String(item.id));

  if (!sourceEvent) {
    continue;
  }

  /*
   * Песни
   */

  for (const song of item.songs || []) {
    const validation = song.validation || {};
    const match = validation.match || {};

    const normalizedWork = {
      title: String(
        validation.normalized_title ||
        match.title ||
        song.input?.title ||
        ""
      ).trim(),

      type: "song",

      artist: Array.isArray(match.artists) && match.artists.length
        ? match.artists.join(", ")
        : Array.isArray(song.input?.performer)
          ? song.input.performer.join(", ")
          : String(song.input?.performer || "").trim(),

      year: sourceEvent.nYear,
      eventId: sourceEvent.nID || null,
      eventDescription: sourceEvent.sDescription || "",

      originalArtist: song.input?.original_artist || null,

      mbid: match.mbid || null,
      coverUrl: null,

      youtubeUrl: makeYoutubeUrl(
        Array.isArray(match.artists) && match.artists.length
          ? match.artists.join(", ")
          : Array.isArray(song.input?.performer)
            ? song.input.performer.join(", ")
            : String(song.input?.performer || "").trim(),
        String(
          validation.normalized_title ||
          match.title ||
          song.input?.title ||
          ""
        ).trim()
      ),
      chordsUrl: makeChordsUrl(
        Array.isArray(match.artists) && match.artists.length
          ? match.artists.join(", ")
          : Array.isArray(song.input?.performer)
            ? song.input.performer.join(", ")
            : String(song.input?.performer || "").trim(),
        String(
          validation.normalized_title ||
          match.title ||
          song.input?.title ||
          ""
        ).trim()
      ),
    };


    if (isBadWork(normalizedWork)) {
      continue;
    }

    const key = getWorkKey(normalizedWork);

    if (seenWorks.has(key)) {
      continue;
    }

    seenWorks.add(key);
    works.push(normalizedWork);
  }

  /*
   * Альбомы
   */

  for (const album of item.albums || []) {
    const validation = album.validation || {};
    const match = validation.match || {};

    const normalizedWork = {
      title: String(
        validation.normalized_title ||
        match.title ||
        album.input?.title ||
        ""
      ).trim(),

      type: "album",

      artist: Array.isArray(match.artists) && match.artists.length
        ? match.artists.join(", ")
        : String(album.input?.artist || "").trim(),

      year: sourceEvent.nYear,
      eventId: sourceEvent.nID || null,
      eventDescription: sourceEvent.sDescription || "",

      originalArtist: null,

      mbid: match.mbid || null,
      coverUrl: null,
      youtubeUrl: makeYoutubeUrl(
        Array.isArray(match.artists) && match.artists.length
          ? match.artists.join(", ")
          : String(album.input?.artist || "").trim(),
        String(
          validation.normalized_title ||
          match.title ||
          album.input?.title ||
          ""
        ).trim()
      ),
      chordsUrl: makeChordsUrl(
        Array.isArray(match.artists) && match.artists.length
          ? match.artists.join(", ")
          : String(album.input?.artist || "").trim(),
        String(
          validation.normalized_title ||
          match.title ||
          album.input?.title ||
          ""
        ).trim()
      ),
    };

    if (isBadWork(normalizedWork)) {
      continue;
    }

    const key = getWorkKey(normalizedWork);

    if (seenWorks.has(key)) {
      continue;
    }

    seenWorks.add(key);
    works.push(normalizedWork);
  }
}

/* =======================================================
   Получаем обложки сегодняшних произведений
======================================================= */

let coversChanged = false;
let coversFound = 0;

for (const work of works) {
  if (work.coverUrl) {
    continue;
  }

  console.log("");
  console.log(
    `Ищем обложку: ${work.artist} — ${work.title}`
  );

  // ==========================================
  // Сначала проверяем постоянный кэш
  // ==========================================

  if (work.mbid) {
    const cached = readEnrichment(work.mbid);

    if (cached?.coverUrl) {
      work.coverUrl = cached.coverUrl;

      console.log(
        `  ✓ Обложка взята из кэша`
      );

      continue;
    }
  }

  // ==========================================
  // Если кэша нет — ищем через MusicBrainz
  // ==========================================

  try {
    const coverUrl = await findCover(
      work.title,
      work.artist,
      work.type
    );

    if (coverUrl) {
      work.coverUrl = coverUrl;
      coversChanged = true;
      coversFound++;

      console.log(`  ✓ Обложка найдена`);

      // Сохраняем результат для будущих запусков
      if (work.mbid) {
        saveEnrichment(work.mbid, {
          mbid: work.mbid,
          title: work.title,
          artist: work.artist,
          type: work.type,
          coverUrl: coverUrl,
          savedAt: new Date().toISOString(),
        });
      }
    } else {
      console.log(`  — Обложка не найдена`);

      // НЕ записываем coverUrl: null.
      // Если раньше для этого MBID была хорошая обложка,
      // она должна остаться в постоянном кэше.
    }
  } catch (error) {
    console.log(
      `  ✗ Ошибка: ${error.message}`
    );
  }

  await sleep(MUSICBRAINZ_DELAY);
}

/* =======================================================
   Результат
======================================================= */

const result = {
  date,
  generatedAt: new Date().toISOString(),
  eventsCount: events.length,
  people,
  works,
};

const PREPARED_DIR = path.resolve("data", "prepared");

fs.mkdirSync(PREPARED_DIR, { recursive: true });

const preparedFile = path.join(
  PREPARED_DIR,
  `${date}.json`
);

fs.writeFileSync(
  preparedFile,
  JSON.stringify(result, null, 2),
  "utf8"
);

console.log("");
console.log(`Готовые данные сохранены: ${preparedFile}`);

/* =======================================================
   Вывод
======================================================= */

console.log("");
console.log(`Событий: ${events.length}`);
console.log(`Именинников: ${people.length}`);
console.log(
  `Фото уже есть: ${people.filter((person) => person.photo).length}`
);
console.log(`Произведений после фильтрации: ${works.length}`);
console.log(
  `Обложки уже есть: ${works.filter((work) => work.coverUrl).length}`
);

console.log("");
console.log("Именинники:");

for (const person of people) {
  console.log(
    `  ${person.photo ? "✓" : "—"} ${person.name}`
  );
}

console.log("");
console.log("Произведения:");

for (const work of works) {
  console.log(
    `  ${work.coverUrl ? "✓" : "—"} ${work.artist} — ${work.title}`
  );
}
}

main().catch((error) => {
  console.error("");
  console.error("Ошибка:", error);
  process.exit(1);
});