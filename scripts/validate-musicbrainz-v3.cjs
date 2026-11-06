const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(
  __dirname,
  "..",
  "test-gemini-real-result.json"
);

const OUTPUT_FILE = path.join(
  __dirname,
  "..",
  "musicbrainz-validation-v3.json"
);

const API_BASE = "https://musicbrainz.org/ws/2";

const USER_AGENT =
  "what-to-play-today/1.0 (music metadata validation)";

const REQUEST_DELAY_MS = 1200;

const MAX_RETRIES = 5;

const RETRY_DELAYS = [
  3000,
  6000,
  12000,
  24000,
  48000
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------------------------------------
// НОРМАЛИЗАЦИЯ
// --------------------------------------------------

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')

    // Born in the U.S.A. -> born in the usa
    .replace(/\./g, "")

    // Запятые и прочая пунктуация нам не должны
    // мешать при сравнении названий.
    .replace(/[,;:!?()[\]{}]/g, " ")

    .replace(/\s+/g, " ")
    .trim();
}

function escapeLucene(text) {
  return String(text || "")
    .replace(/([+\-!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function getArtistNames(item) {
  const names = [];

  if (item.artist) {
    names.push(item.artist);
  }

  if (Array.isArray(item["artist-credit"])) {
    for (const credit of item["artist-credit"]) {
      if (!credit || typeof credit !== "object") {
        continue;
      }

      if (credit.name) {
        names.push(credit.name);
      }

      if (
        credit.artist &&
        credit.artist.name
      ) {
        names.push(
          credit.artist.name
        );
      }
    }
  }

  return [
    ...new Set(
      names.filter(Boolean)
    )
  ];
}

function getItemTitle(item) {
  return (
    item.title ||
    item.recording ||
    item.release ||
    ""
  );
}

// --------------------------------------------------
// СРАВНЕНИЕ НАЗВАНИЙ
// --------------------------------------------------

function titleMatches(
  itemTitle,
  targetTitle
) {
  const a = normalize(itemTitle);
  const b = normalize(targetTitle);

  if (!a || !b) {
    return false;
  }

  if (a === b) {
    return true;
  }

  return (
    a.includes(b) ||
    b.includes(a)
  );
}

function artistMatches(
  itemArtists,
  targetArtist
) {
  const target =
    normalize(targetArtist);

  if (!target) {
    return false;
  }

  return itemArtists.some(name => {
    const candidate =
      normalize(name);

    return (
      candidate === target ||
      candidate.includes(target) ||
      target.includes(candidate)
    );
  });
}

function calculateMatch(
  item,
  title,
  artist
) {
  const itemTitle =
    getItemTitle(item);

  const itemArtists =
    getArtistNames(item);

  const exactTitle =
    normalize(itemTitle) ===
    normalize(title);

  const titleOk =
    titleMatches(
      itemTitle,
      title
    );

  const artistOk =
    artistMatches(
      itemArtists,
      artist
    );

  let score = 0;

  if (exactTitle) {
    score += 100;
  } else if (titleOk) {
    score += 60;
  }

  if (artistOk) {
    score += 100;
  }

  return {
    score,
    exactTitle,
    titleOk,
    artistOk,
    itemTitle,
    itemArtists
  };
}

function rankCandidates(
  items,
  title,
  artist
) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map(item => ({
      item,

      match:
        calculateMatch(
          item,
          title,
          artist
        )
    }))
    .sort(
      (a, b) =>
        b.match.score -
        a.match.score
    );
}

// --------------------------------------------------
// MUSICBRAINZ REQUEST
// --------------------------------------------------

async function requestMusicBrainz(
  type,
  query
) {
  const url =
    `${API_BASE}/${type}` +
    `?query=${encodeURIComponent(query)}` +
    `&fmt=json` +
    `&limit=10`;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      const response =
        await fetch(url, {
          headers: {
            "User-Agent":
              USER_AGENT,

            "Accept":
              "application/json"
          }
        });

      if (response.ok) {
        return {
          ok: true,

          data:
            await response.json(),

          url
        };
      }

      const body =
        await response.text();

      const temporary =
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;

      lastError = {
        status:
          response.status,

        body:
          body.slice(0, 500)
      };

      if (!temporary) {
        return {
          ok: false,
          temporary: false,
          error: lastError,
          url
        };
      }

      if (
        attempt <
        MAX_RETRIES
      ) {
        const delay =
          RETRY_DELAYS[
            attempt - 1
          ];

        console.log(
          `      ⏳ MusicBrainz HTTP ${response.status}, ` +
          `повтор через ${delay / 1000} сек. ` +
          `(попытка ${attempt + 1}/${MAX_RETRIES})`
        );

        await sleep(delay);
      }

    } catch (error) {
      lastError = {
        status: null,
        body: error.message
      };

      if (
        attempt <
        MAX_RETRIES
      ) {
        const delay =
          RETRY_DELAYS[
            attempt - 1
          ];

        console.log(
          `      ⏳ Сетевая ошибка, ` +
          `повтор через ${delay / 1000} сек. ` +
          `(попытка ${attempt + 1}/${MAX_RETRIES})`
        );

        await sleep(delay);
      }
    }
  }

  return {
    ok: false,

    // В v3 это не ошибка данных.
    temporary: true,

    error: lastError,
    url
  };
}

// --------------------------------------------------
// ПОЛУЧЕНИЕ ЭЛЕМЕНТОВ ИЗ ОТВЕТА
// --------------------------------------------------

function getResponseItems(
  response,
  type
) {
  return type === "recording"
    ? response.data.recordings || []
    : response.data.releases || [];
}

// --------------------------------------------------
// ПОИСК
// --------------------------------------------------

async function runSearch(
  type,
  query,
  title,
  artist
) {
  const response =
    await requestMusicBrainz(
      type,
      query
    );

  if (!response.ok) {
    return {
      ok: false,
      temporary:
        response.temporary,
      error:
        response.error
    };
  }

  const items =
    getResponseItems(
      response,
      type
    );

  return {
    ok: true,

    ranked:
      rankCandidates(
        items,
        title,
        artist
      )
  };
}

// --------------------------------------------------
// ОСНОВНАЯ ВАЛИДАЦИЯ
// --------------------------------------------------

async function searchEntity(
  type,
  title,
  artist
) {
  const field =
    type === "recording"
      ? "recording"
      : "release";

  const titleQ =
    escapeLucene(title);

  const artistQ =
    escapeLucene(artist);

  // ==================================================
  // 1. TITLE + ARTIST
  // ==================================================

  const exactQuery =
    `${field}:"${titleQ}" ` +
    `AND artist:"${artistQ}"`;

  console.log(
    "      🔎 Title + artist"
  );

  let search =
    await runSearch(
      type,
      exactQuery,
      title,
      artist
    );

  if (!search.ok) {
    return {
      status:
        search.temporary
          ? "RETRY_LATER"
          : "NOT_FOUND",

      error:
        search.error,

      query:
        exactQuery,

      search_level:
        "exact"
    };
  }

  let ranked =
    search.ranked;

  // Ищем НЕ первый результат,
  // а лучший подходящий среди всех.
  let match =
    ranked.find(
      candidate =>
        candidate.match.titleOk &&
        candidate.match.artistOk
    );

  if (match) {
    return {
      status:
        "CONFIRMED",

      search_level:
        "exact",

      query:
        exactQuery,

      match,

      candidates:
        ranked.slice(0, 10)
    };
  }

  // ==================================================
  // 2. TITLE ONLY
  // ==================================================

  await sleep(
    REQUEST_DELAY_MS
  );

  const titleQuery =
    `${field}:"${titleQ}"`;

  console.log(
    "      🔎 Title only"
  );

  search =
    await runSearch(
      type,
      titleQuery,
      title,
      artist
    );

  if (!search.ok) {
    return {
      status:
        search.temporary
          ? "RETRY_LATER"
          : "NOT_FOUND",

      error:
        search.error,

      query:
        titleQuery,

      search_level:
        "title_only"
    };
  }

  ranked =
    search.ranked;

  // КЛЮЧЕВОЕ ИЗМЕНЕНИЕ v3:
  // ищем нужного артиста СРЕДИ ВСЕХ
  // кандидатов, а не доверяем первому.
  match =
    ranked.find(
      candidate =>
        candidate.match.titleOk &&
        candidate.match.artistOk
    );

  if (match) {
    return {
      status:
        "CONFIRMED",

      search_level:
        "title_only",

      query:
        titleQuery,

      match,

      candidates:
        ranked.slice(0, 10)
    };
  }

  // Название существует,
  // но нужного исполнителя нет.
  const titleMatch =
    ranked.find(
      candidate =>
        candidate.match.titleOk
    );

  if (titleMatch) {
    return {
      status:
        "ACCEPT_UNVERIFIED",

      search_level:
        "title_only",

      query:
        titleQuery,

      match:
        titleMatch,

      candidates:
        ranked.slice(0, 10)
    };
  }

  // ==================================================
  // 3. МЯГКИЙ ПОИСК
  //
  // Без кавычек. Нужен для:
  //
  // Janet Jackson's Rhythm Nation 1814
  // Diana Ross and The Supremes Greatest Hits
  // и подобных вариантов.
  // ==================================================

  await sleep(
    REQUEST_DELAY_MS
  );

  const looseQuery =
    `${field}:${titleQ} ` +
    `AND artist:"${artistQ}"`;

  console.log(
    "      🔎 Loose title + artist"
  );

  search =
    await runSearch(
      type,
      looseQuery,
      title,
      artist
    );

  if (!search.ok) {
    return {
      status:
        search.temporary
          ? "RETRY_LATER"
          : "NOT_FOUND",

      error:
        search.error,

      query:
        looseQuery,

      search_level:
        "loose"
    };
  }

  ranked =
    search.ranked;

  // Здесь допускаем несовпадение
  // названия, если MusicBrainz
  // уверенно дал нужного артиста.
  match =
    ranked.find(
      candidate =>
        candidate.match.artistOk &&
        candidate.match.titleOk
    );

  if (match) {
    return {
      status:
        "NORMALIZED",

      search_level:
        "loose",

      query:
        looseQuery,

      match,

      candidates:
        ranked.slice(0, 10)
    };
  }

  // ==================================================
  // 4. FALLBACK ДЛЯ НАЗВАНИЙ С ИМЕНЕМ АРТИСТА
  //
  // Janet Jackson's Rhythm Nation 1814
  //          ↓
  // Rhythm Nation 1814
  // ==================================================

  const normalizedArtist =
    normalize(artist);

  const normalizedTitle =
    normalize(title);

  let shortenedTitle =
    title;

  if (
    normalizedArtist &&
    normalizedTitle.startsWith(
      normalizedArtist
    )
  ) {
    const words =
      String(title)
        .split(/\s+/);

    const artistWords =
      String(artist)
        .split(/\s+/);

    shortenedTitle =
      words
        .slice(
          artistWords.length
        )
        .join(" ")
        .replace(
          /^['’]s\s+/i,
          ""
        )
        .trim();
  }

  if (
    shortenedTitle &&
    normalize(shortenedTitle) !==
      normalize(title)
  ) {
    await sleep(
      REQUEST_DELAY_MS
    );

    console.log(
      `      🔎 Short title: ${shortenedTitle}`
    );

    const shortTitleQ =
      escapeLucene(
        shortenedTitle
      );

    const shortQuery =
      `${field}:"${shortTitleQ}" ` +
      `AND artist:"${artistQ}"`;

    search =
      await runSearch(
        type,
        shortQuery,
        shortenedTitle,
        artist
      );

    if (!search.ok) {
      return {
        status:
          search.temporary
            ? "RETRY_LATER"
            : "NOT_FOUND",

        error:
          search.error,

        query:
          shortQuery,

        search_level:
          "short_title"
      };
    }

    ranked =
      search.ranked;

    match =
      ranked.find(
        candidate =>
          candidate.match.artistOk &&
          candidate.match.titleOk
      );

    if (match) {
      return {
        status:
          "NORMALIZED",

        search_level:
          "short_title",

        query:
          shortQuery,

        original_title:
          title,

        normalized_title:
          getItemTitle(
            match.item
          ),

        match,

        candidates:
          ranked.slice(0, 10)
      };
    }
  }

  // ==================================================
  // 5. COMPOUND TITLE: A / B
  // ==================================================

  if (
    type === "recording" &&
    /\s\/\s/.test(title)
  ) {
    console.log(
      "      🔀 Проверяем части составного названия"
    );

    const parts =
      title
        .split(/\s\/\s/)
        .map(part =>
          part.trim()
        )
        .filter(Boolean);

    const partResults = [];

    for (
      const part of parts
    ) {
      await sleep(
        REQUEST_DELAY_MS
      );

      const partQ =
        escapeLucene(part);

      const partQuery =
        `recording:"${partQ}" ` +
        `AND artist:"${artistQ}"`;

      console.log(
        `         → ${part}`
      );

      const partSearch =
        await runSearch(
          "recording",
          partQuery,
          part,
          artist
        );

      if (!partSearch.ok) {
        partResults.push({
          title: part,

          status:
            partSearch.temporary
              ? "RETRY_LATER"
              : "NOT_FOUND",

          error:
            partSearch.error || null
        });

        continue;
      }

      const partMatch =
        partSearch.ranked.find(
          candidate =>
            candidate.match.titleOk &&
            candidate.match.artistOk
        );

      if (partMatch) {
        partResults.push({
          title: part,

          status:
            "CONFIRMED",

          match:
            partMatch
        });
      } else {
        partResults.push({
          title: part,

          status:
            "NOT_FOUND"
        });
      }
    }

    const confirmedParts =
      partResults.filter(
        part =>
          part.status ===
          "CONFIRMED"
      );

    if (
      confirmedParts.length > 0
    ) {
      return {
        status:
          "SPLIT",

        search_level:
          "compound",

        query:
          title,

        split_parts:
          partResults,

        candidates: []
      };
    }

    if (
      partResults.some(
        part =>
          part.status ===
          "RETRY_LATER"
      )
    ) {
      return {
        status:
          "RETRY_LATER",

        search_level:
          "compound",

        query:
          title,

        split_parts:
          partResults
      };
    }
  }

  // ==================================================
  // НИЧЕГО НЕ ПОМОГЛО
  // ==================================================

  return {
    status:
      "REVIEW",

    search_level:
      "loose",

    query:
      looseQuery,

    candidates:
      ranked.slice(0, 10)
  };
}

// --------------------------------------------------
// УПРОЩЕНИЕ КАНДИДАТОВ
// --------------------------------------------------

function simplifyCandidate(
  candidate
) {
  if (!candidate) {
    return null;
  }

  const item =
    candidate.item || {};

  return {
    title:
      getItemTitle(item),

    artists:
      getArtistNames(item),

    mbid:
      item.id || null,

    score:
      candidate.match
        ? candidate.match.score
        : null
  };
}

function simplifySplitParts(
  parts
) {
  if (!Array.isArray(parts)) {
    return [];
  }

  return parts.map(part => ({
    title:
      part.title,

    status:
      part.status,

    match:
      simplifyCandidate(
        part.match
      ),

    error:
      part.error || null
  }));
}

// --------------------------------------------------
// SONG
// --------------------------------------------------

async function validateSong(
  song,
  eventArtist
) {
  const title =
    song.title;

  const performers =
    Array.isArray(
      song.performer
    )
      ? song.performer
      : [];

  const artist =
    performers[0] ||
    eventArtist ||
    "";

  console.log(
    `    🎵 ${title} — ${artist}`
  );

  const result =
    await searchEntity(
      "recording",
      title,
      artist
    );

  return {
    input: {
      title,

      performer:
        performers,

      original_artist:
        song.original_artist ||
        null
    },

    validation: {
      type:
        "recording",

      status:
        result.status,

      search_level:
        result.search_level ||
        null,

      query:
        result.query ||
        null,

      original_title:
        result.original_title ||
        null,

      normalized_title:
        result.normalized_title ||
        (
          result.match
            ? getItemTitle(
                result.match.item
              )
            : null
        ),

      match:
        simplifyCandidate(
          result.match
        ),

      candidates:
        (
          result.candidates ||
          []
        ).map(
          simplifyCandidate
        ),

      split_parts:
        simplifySplitParts(
          result.split_parts
        ),

      error:
        result.error ||
        null
    }
  };
}

// --------------------------------------------------
// ALBUM
// --------------------------------------------------

async function validateAlbum(
  album,
  eventArtist
) {
  const title =
    album.title;

  const artist =
    album.artist ||
    eventArtist ||
    "";

  console.log(
    `    💿 ${title} — ${artist}`
  );

  const result =
    await searchEntity(
      "release",
      title,
      artist
    );

  return {
    input: {
      title,
      artist
    },

    validation: {
      type:
        "release",

      status:
        result.status,

      search_level:
        result.search_level ||
        null,

      query:
        result.query ||
        null,

      original_title:
        result.original_title ||
        null,

      normalized_title:
        result.normalized_title ||
        (
          result.match
            ? getItemTitle(
                result.match.item
              )
            : null
        ),

      match:
        simplifyCandidate(
          result.match
        ),

      candidates:
        (
          result.candidates ||
          []
        ).map(
          simplifyCandidate
        ),

      error:
        result.error ||
        null
    }
  };
}

// --------------------------------------------------
// CONFLICTS
// --------------------------------------------------

function collectConflicts(
  results
) {
  const map =
    new Map();

  for (
    const record of results
  ) {
    for (
      const song of
      record.songs
    ) {
      const key =
        normalize(
          song.input.title
        );

      if (!key) {
        continue;
      }

      if (!map.has(key)) {
        map.set(key, {
          title:
            song.input.title,

          songs: [],
          albums: []
        });
      }

      map.get(key)
        .songs
        .push({
          id:
            record.id,

          event_artist:
            record.event_artist,

          validation:
            song.validation
        });
    }

    for (
      const album of
      record.albums
    ) {
      const key =
        normalize(
          album.input.title
        );

      if (!key) {
        continue;
      }

      if (!map.has(key)) {
        map.set(key, {
          title:
            album.input.title,

          songs: [],
          albums: []
        });
      }

      map.get(key)
        .albums
        .push({
          id:
            record.id,

          event_artist:
            record.event_artist,

          validation:
            album.validation
        });
    }
  }

  return [
    ...map.values()
  ].filter(
    item =>
      item.songs.length > 0 &&
      item.albums.length > 0
  );
}

// --------------------------------------------------
// SUMMARY
// --------------------------------------------------

function createSummary() {
  return {
    total: 0,
    confirmed: 0,
    normalized: 0,
    accept_unverified: 0,
    split: 0,
    review: 0,
    retry_later: 0
  };
}

function addStatus(
  summary,
  status
) {
  if (
    status === "CONFIRMED"
  ) {
    summary.confirmed++;

  } else if (
    status === "NORMALIZED"
  ) {
    summary.normalized++;

  } else if (
    status ===
    "ACCEPT_UNVERIFIED"
  ) {
    summary.accept_unverified++;

  } else if (
    status === "SPLIT"
  ) {
    summary.split++;

  } else if (
    status === "RETRY_LATER"
  ) {
    summary.retry_later++;

  } else {
    summary.review++;
  }
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  console.log(
    "🎵 MUSICBRAINZ VALIDATOR v3"
  );

  console.log(
    "============================"
  );

  if (
    !fs.existsSync(
      INPUT_FILE
    )
  ) {
    console.error(
      `❌ Не найден файл:\n${INPUT_FILE}`
    );

    process.exit(1);
  }

  const input =
    JSON.parse(
      fs.readFileSync(
        INPUT_FILE,
        "utf8"
      )
    );

  console.log(
    `Записей Gemini: ${input.results.length}`
  );

  console.log(
    "v3: validation + normalization + split detection"
  );

  console.log("");

  const output = {
    source_file:
      "test-gemini-real-result.json",

    validator:
      "MusicBrainz Validator v3",

    validated_at:
      new Date().toISOString(),

    summary: {
      songs:
        createSummary(),

      albums:
        createSummary()
    },

    results: []
  };

  for (
    const record of
    input.results
  ) {
    console.log(
      `\n[${record.id}] ${record.event_artist}`
    );

    const result = {
      id:
        record.id,

      event_artist:
        record.event_artist,

      songs: [],
      albums: []
    };

    // SONGS
    for (
      const song of
      record.songs || []
    ) {
      output.summary
        .songs
        .total++;

      await sleep(
        REQUEST_DELAY_MS
      );

      try {
        const validated =
          await validateSong(
            song,
            record.event_artist
          );

        const status =
          validated
            .validation
            .status;

        addStatus(
          output.summary.songs,
          status
        );

        console.log(
          `      → ${status}`
        );

        if (
          status === "SPLIT"
        ) {
          for (
            const part of
            validated
              .validation
              .split_parts
          ) {
            console.log(
              `         ${part.status === "CONFIRMED" ? "✓" : "?"} ` +
              `${part.title}`
            );
          }
        }

        result.songs.push(
          validated
        );

      } catch (error) {
        output.summary
          .songs
          .retry_later++;

        console.log(
          `      ❌ ${error.message}`
        );

        result.songs.push({
          input: song,

          validation: {
            type:
              "recording",

            status:
              "RETRY_LATER",

            error: {
              message:
                error.message
            }
          }
        });
      }
    }

    // ALBUMS
    for (
      const album of
      record.albums || []
    ) {
      output.summary
        .albums
        .total++;

      await sleep(
        REQUEST_DELAY_MS
      );

      try {
        const validated =
          await validateAlbum(
            album,
            record.event_artist
          );

        const status =
          validated
            .validation
            .status;

        addStatus(
          output.summary.albums,
          status
        );

        console.log(
          `      → ${status}`
        );

        result.albums.push(
          validated
        );

      } catch (error) {
        output.summary
          .albums
          .retry_later++;

        console.log(
          `      ❌ ${error.message}`
        );

        result.albums.push({
          input: album,

          validation: {
            type:
              "release",

            status:
              "RETRY_LATER",

            error: {
              message:
                error.message
            }
          }
        });
      }
    }

    output.results.push(
      result
    );
  }

  output.conflicts =
    collectConflicts(
      output.results
    );

  fs.writeFileSync(
    OUTPUT_FILE,

    JSON.stringify(
      output,
      null,
      2
    ),

    "utf8"
  );

  console.log("");
  console.log(
    "============================"
  );

  console.log(
    "🎉 V3 ЗАВЕРШЁН"
  );

  console.log(
    "============================"
  );

  console.log("");

  printSummary(
    "🎵 ПЕСНИ",
    output.summary.songs
  );

  console.log("");

  printSummary(
    "💿 АЛЬБОМЫ",
    output.summary.albums
  );

  console.log("");

  console.log(
    `⚠ Song/album conflicts: ${output.conflicts.length}`
  );

  console.log("");

  console.log(
    `📄 Результат:\n${OUTPUT_FILE}`
  );
}

function printSummary(
  title,
  summary
) {
  console.log(title);

  console.log(
    `   Всего:              ${summary.total}`
  );

  console.log(
    `   ✓ Confirmed:         ${summary.confirmed}`
  );

  console.log(
    `   🔧 Normalized:        ${summary.normalized}`
  );

  console.log(
    `   ⚠ Accept unverified: ${summary.accept_unverified}`
  );

  console.log(
    `   🔀 Split:             ${summary.split}`
  );

  console.log(
    `   👀 Review:            ${summary.review}`
  );

  console.log(
    `   🔁 Retry later:       ${summary.retry_later}`
  );
}

main().catch(error => {
  console.error("");
  console.error(
    "❌ КРИТИЧЕСКАЯ ОШИБКА"
  );

  console.error(error);

  process.exit(1);
});