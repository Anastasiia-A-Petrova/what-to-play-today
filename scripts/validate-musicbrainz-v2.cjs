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
  "musicbrainz-validation-v2.json"
);

const API_BASE = "https://musicbrainz.org/ws/2";

const USER_AGENT =
  "what-to-play-today/1.0 (music metadata validation)";

// MusicBrainz просит не создавать слишком частые запросы.
const REQUEST_DELAY_MS = 1200;

// Сколько раз повторяем временные ошибки.
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

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
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

      if (credit.artist && credit.artist.name) {
        names.push(credit.artist.name);
      }
    }
  }

  return [...new Set(names.filter(Boolean))];
}

function getItemTitle(item) {
  return (
    item.title ||
    item.recording ||
    item.release ||
    ""
  );
}

function titleMatches(itemTitle, targetTitle) {
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

function artistMatches(itemArtists, targetArtist) {
  const target = normalize(targetArtist);

  if (!target) {
    return false;
  }

  return itemArtists.some(name => {
    const candidate = normalize(name);

    return (
      candidate === target ||
      candidate.includes(target) ||
      target.includes(candidate)
    );
  });
}

function calculateMatch(item, title, artist) {
  const itemTitle = getItemTitle(item);
  const itemArtists = getArtistNames(item);

  const exactTitle =
    normalize(itemTitle) === normalize(title);

  const titleOk =
    titleMatches(itemTitle, title);

  const artistOk =
    artistMatches(itemArtists, artist);

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

function rankCandidates(items, title, artist) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map(item => ({
      item,
      match: calculateMatch(
        item,
        title,
        artist
      )
    }))
    .sort(
      (a, b) =>
        b.match.score - a.match.score
    );
}

async function requestMusicBrainz(type, query) {
  const url =
    `${API_BASE}/${type}` +
    `?query=${encodeURIComponent(query)}` +
    `&fmt=json` +
    `&limit=10`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json"
        }
      });

      if (response.ok) {
        return {
          ok: true,
          data: await response.json(),
          url
        };
      }

      const body = await response.text();

      const temporary =
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;

      lastError = {
        status: response.status,
        body: body.slice(0, 500)
      };

      if (!temporary) {
        return {
          ok: false,
          temporary: false,
          error: lastError,
          url
        };
      }

      if (attempt < MAX_RETRIES) {
        const delay =
          RETRY_DELAYS[attempt - 1];

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

      if (attempt < MAX_RETRIES) {
        const delay =
          RETRY_DELAYS[attempt - 1];

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
    temporary: true,
    error: lastError,
    url
  };
}

async function searchEntity(
  type,
  title,
  artist
) {
  const titleQ = escapeLucene(title);
  const artistQ = escapeLucene(artist);

  // ------------------------------------------------
  // ПОПЫТКА 1
  // Точный title + artist
  // ------------------------------------------------

  const exactQuery =
    `${type === "recording" ? "recording" : "release"}:"${titleQ}" ` +
    `AND artist:"${artistQ}"`;

  console.log(
    `      🔎 Точный поиск`
  );

  let response =
    await requestMusicBrainz(
      type,
      exactQuery
    );

  if (!response.ok) {
    return {
      status: response.temporary
        ? "ERROR"
        : "NOT_FOUND",
      error: response.error,
      query: exactQuery,
      search_level: "exact"
    };
  }

  let items =
    type === "recording"
      ? response.data.recordings || []
      : response.data.releases || [];

  let ranked =
    rankCandidates(
      items,
      title,
      artist
    );

  // Точное совпадение title + artist.
  const exactMatch =
    ranked.find(
      candidate =>
        candidate.match.exactTitle &&
        candidate.match.artistOk
    );

  if (exactMatch) {
    return {
      status: "CONFIRMED",
      search_level: "exact",
      query: exactQuery,
      match: exactMatch,
      candidates: ranked.slice(0, 10)
    };
  }

  // ------------------------------------------------
  // ПОПЫТКА 2
  // Только название
  // ------------------------------------------------

  const titleQuery =
    `${type === "recording" ? "recording" : "release"}:"${titleQ}"`;

  console.log(
    `      🔎 Поиск только по названию`
  );

  await sleep(REQUEST_DELAY_MS);

  response =
    await requestMusicBrainz(
      type,
      titleQuery
    );

  if (!response.ok) {
    return {
      status: response.temporary
        ? "ERROR"
        : "NOT_FOUND",
      error: response.error,
      query: titleQuery,
      search_level: "title_only"
    };
  }

  items =
    type === "recording"
      ? response.data.recordings || []
      : response.data.releases || [];

  ranked =
    rankCandidates(
      items,
      title,
      artist
    );

  const exactTitleMatches =
    ranked.filter(
      candidate =>
        candidate.match.exactTitle
    );

  const artistMatchesOnly =
    exactTitleMatches.filter(
      candidate =>
        candidate.match.artistOk
    );

  // Есть точное название + артист.
  if (artistMatchesOnly.length > 0) {
    return {
      status: "CONFIRMED",
      search_level: "title_only",
      query: titleQuery,
      match: artistMatchesOnly[0],
      candidates: ranked.slice(0, 10)
    };
  }

  // Есть точное название, но артист другой.
  if (exactTitleMatches.length > 0) {
    return {
      status: "AMBIGUOUS",
      search_level: "title_only",
      query: titleQuery,
      match: exactTitleMatches[0],
      candidates: ranked.slice(0, 10)
    };
  }

  // Вообще ничего подходящего.
  return {
    status: "NOT_FOUND",
    search_level: "title_only",
    query: titleQuery,
    candidates: ranked.slice(0, 10)
  };
}

function simplifyCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  const item =
    candidate.item || {};

  return {
    title: getItemTitle(item),
    artists: getArtistNames(item),
    canonicalArtist: getCanonicalArtistName(item),
    mbid: item.id || null,
    score: candidate.match
      ? candidate.match.score
      : null
  };
}

async function validateSong(
  song,
  eventArtist
) {
  const title = song.title;

  const performers =
    Array.isArray(song.performer)
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
      performer: performers,
      original_artist:
        song.original_artist || null
    },

    validation: {
      type: "recording",
      status: result.status,
      search_level:
        result.search_level || null,
      query: result.query || null,

      match:
        simplifyCandidate(result.match),

      candidates:
        (result.candidates || [])
          .map(simplifyCandidate),

      error:
        result.error || null
    }
  };
}

async function validateAlbum(
  album,
  eventArtist
) {
  const title = album.title;

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
      type: "release",
      status: result.status,
      search_level:
        result.search_level || null,
      query: result.query || null,

      match:
        simplifyCandidate(result.match),

      candidates:
        (result.candidates || [])
          .map(simplifyCandidate),

      error:
        result.error || null
    }
  };
}

function collectConflicts(results) {
  const map = new Map();

  for (const record of results) {
    for (const song of record.songs) {
      const key =
        normalize(song.input.title);

      if (!key) continue;

      if (!map.has(key)) {
        map.set(key, {
          title: song.input.title,
          songs: [],
          albums: []
        });
      }

      map.get(key).songs.push({
        id: record.id,
        event_artist:
          record.event_artist,
        validation:
          song.validation
      });
    }

    for (const album of record.albums) {
      const key =
        normalize(album.input.title);

      if (!key) continue;

      if (!map.has(key)) {
        map.set(key, {
          title: album.input.title,
          songs: [],
          albums: []
        });
      }

      map.get(key).albums.push({
        id: record.id,
        event_artist:
          record.event_artist,
        validation:
          album.validation
      });
    }
  }

  return [...map.values()]
    .filter(
      item =>
        item.songs.length > 0 &&
        item.albums.length > 0
    );
}

async function main() {
  console.log(
    "🎵 MUSICBRAINZ VALIDATOR v2"
  );
  console.log(
    "============================"
  );

  if (!fs.existsSync(INPUT_FILE)) {
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
    "Повторяем временные ошибки автоматически."
  );

  console.log("");

  const output = {
    source_file:
      "test-gemini-real-result.json",

    validator:
      "MusicBrainz Validator v2",

    validated_at:
      new Date().toISOString(),

    summary: {
      songs: {
        total: 0,
        confirmed: 0,
        ambiguous: 0,
        not_found: 0,
        errors: 0
      },

      albums: {
        total: 0,
        confirmed: 0,
        ambiguous: 0,
        not_found: 0,
        errors: 0
      }
    },

    results: []
  };

  for (
    const record of input.results
  ) {
    console.log(
      `\n[${record.id}] ${record.event_artist}`
    );

    const result = {
      id: record.id,

      event_artist:
        record.event_artist,

      songs: [],

      albums: []
    };

    for (
      const song of record.songs || []
    ) {
      output.summary.songs.total++;

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
          validated.validation.status;

        if (
          status === "CONFIRMED"
        ) {
          output.summary.songs.confirmed++;
          console.log(
            "      ✓ CONFIRMED"
          );
        } else if (
          status === "AMBIGUOUS"
        ) {
          output.summary.songs.ambiguous++;
          console.log(
            "      ⚠ AMBIGUOUS"
          );
        } else if (
          status === "NOT_FOUND"
        ) {
          output.summary.songs.not_found++;
          console.log(
            "      ❓ NOT_FOUND"
          );
        } else {
          output.summary.songs.errors++;
          console.log(
            "      ❌ ERROR"
          );
        }

        result.songs.push(
          validated
        );

      } catch (error) {
        output.summary.songs.errors++;

        console.log(
          `      ❌ ERROR: ${error.message}`
        );

        result.songs.push({
          input: song,
          validation: {
            type: "recording",
            status: "ERROR",
            error: {
              message: error.message
            }
          }
        });
      }
    }

    for (
      const album of record.albums || []
    ) {
      output.summary.albums.total++;

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
          validated.validation.status;

        if (
          status === "CONFIRMED"
        ) {
          output.summary.albums.confirmed++;
          console.log(
            "      ✓ CONFIRMED"
          );
        } else if (
          status === "AMBIGUOUS"
        ) {
          output.summary.albums.ambiguous++;
          console.log(
            "      ⚠ AMBIGUOUS"
          );
        } else if (
          status === "NOT_FOUND"
        ) {
          output.summary.albums.not_found++;
          console.log(
            "      ❓ NOT_FOUND"
          );
        } else {
          output.summary.albums.errors++;
          console.log(
            "      ❌ ERROR"
          );
        }

        result.albums.push(
          validated
        );

      } catch (error) {
        output.summary.albums.errors++;

        console.log(
          `      ❌ ERROR: ${error.message}`
        );

        result.albums.push({
          input: album,
          validation: {
            type: "release",
            status: "ERROR",
            error: {
              message: error.message
            }
          }
        });
      }
    }

    output.results.push(result);
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
    "🎉 ВАЛИДАЦИЯ ЗАВЕРШЕНА"
  );
  console.log(
    "============================"
  );

  console.log("");
  console.log(
    "🎵 ПЕСНИ"
  );

  console.log(
    `   Всего:       ${output.summary.songs.total}`
  );

  console.log(
    `   ✓ Confirmed:  ${output.summary.songs.confirmed}`
  );

  console.log(
    `   ⚠ Ambiguous: ${output.summary.songs.ambiguous}`
  );

  console.log(
    `   ❓ Not found: ${output.summary.songs.not_found}`
  );

  console.log(
    `   ❌ Errors:    ${output.summary.songs.errors}`
  );

  console.log("");
  console.log(
    "💿 АЛЬБОМЫ"
  );

  console.log(
    `   Всего:       ${output.summary.albums.total}`
  );

  console.log(
    `   ✓ Confirmed:  ${output.summary.albums.confirmed}`
  );

  console.log(
    `   ⚠ Ambiguous: ${output.summary.albums.ambiguous}`
  );

  console.log(
    `   ❓ Not found: ${output.summary.albums.not_found}`
  );

  console.log(
    `   ❌ Errors:    ${output.summary.albums.errors}`
  );

  console.log("");

  console.log(
    `⚠ Конфликтов song/album: ` +
    `${output.conflicts.length}`
  );

  console.log("");

  console.log(
    `📄 Результат:\n${OUTPUT_FILE}`
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
