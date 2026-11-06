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
  "musicbrainz-validation.json"
);

const API_BASE = "https://musicbrainz.org/ws/2";

const USER_AGENT =
  "what-to-play-today/1.0 (music metadata validation)";

const DELAY_MS = 1100;

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

async function musicBrainzSearch(type, query) {
  const url =
    `${API_BASE}/${type}` +
    `?query=${encodeURIComponent(query)}` +
    `&fmt=json` +
    `&limit=5`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `MusicBrainz HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  return response.json();
}

function getArtistNames(item) {
  const names = [];

  if (item.artist) {
    names.push(item.artist);
  }

  if (Array.isArray(item["artist-credit"])) {
    for (const credit of item["artist-credit"]) {
      if (credit && typeof credit === "object" && credit.name) {
        names.push(credit.name);
      }

      if (
        credit &&
        typeof credit === "object" &&
        credit.artist &&
        credit.artist.name
      ) {
        names.push(credit.artist.name);
      }
    }
  }

  return [...new Set(names.filter(Boolean))];
}

function scoreMatch(item, title, artist) {
  const targetTitle = normalize(title);
  const targetArtist = normalize(artist);

  const itemTitle = normalize(
    item.title ||
    item.recording ||
    item.release
  );

  const artistNames = getArtistNames(item).map(normalize);

  let score = 0;

  if (itemTitle === targetTitle) {
    score += 100;
  } else if (
    itemTitle.includes(targetTitle) ||
    targetTitle.includes(itemTitle)
  ) {
    score += 50;
  }

  if (targetArtist) {
    if (artistNames.includes(targetArtist)) {
      score += 100;
    } else if (
      artistNames.some(name =>
        name.includes(targetArtist) ||
        targetArtist.includes(name)
      )
    ) {
      score += 50;
    }
  }

  return score;
}

function bestMatch(items, title, artist) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return items
    .map(item => ({
      item,
      score: scoreMatch(item, title, artist)
    }))
    .sort((a, b) => b.score - a.score)[0];
}

function getNormalizedPerformers(performers, item) {
  if (!Array.isArray(performers) || performers.length === 0) {
    return [];
  }

  if (!item || !Array.isArray(item["artist-credit"])) {
    return [...new Set(performers.filter(Boolean))];
  }

  const artistEntities = [];

  for (const credit of item["artist-credit"]) {
    if (!credit?.artist?.id) continue;

    if (
      artistEntities.some(
        entity => entity.mbid === credit.artist.id
      )
    ) {
      continue;
    }

    artistEntities.push({
      mbid: credit.artist.id,
      name: credit.artist.name || credit.name || "",
      creditName: credit.name || ""
    });
  }

  const normalized = [];
  const usedMbids = new Set();

  for (const performer of performers) {
    if (!performer) continue;

    const target = normalize(performer);

    const entity = artistEntities.find(entity => {
      const name = normalize(entity.name);
      const creditName = normalize(entity.creditName);

      return (
        target === name ||
        target === creditName ||
        target.includes(name) ||
        name.includes(target) ||
        target.includes(creditName) ||
        creditName.includes(target)
      );
    });

    if (!entity) {
      if (!normalized.includes(performer)) {
        normalized.push(performer);
      }
      continue;
    }

    if (usedMbids.has(entity.mbid)) {
      continue;
    }

    usedMbids.add(entity.mbid);
    normalized.push(entity.name);
  }

  return normalized;
}

async function validateSong(song, eventArtist) {
  const title = song.title;
  const performers = Array.isArray(song.performer)
    ? song.performer
    : [];

  const artist =
    performers[0] ||
    eventArtist ||
    "";

  const titleQ = escapeLucene(title);
  const artistQ = escapeLucene(artist);

  const query =
    `recording:"${titleQ}" AND artist:"${artistQ}"`;

  console.log(`    🎵 ${title} — ${artist}`);

  const data = await musicBrainzSearch(
    "recording",
    query
  );

  const match = bestMatch(
    data.recordings,
    title,
    artist
  );

  if (!match || match.score < 100) {
    return {
      input: {
        title,
        performer: performers,
        original_artist: song.original_artist || null
      },
      musicbrainz: {
        found: false,
        query,
        candidates: (data.recordings || [])
          .slice(0, 5)
          .map(item => ({
            title: item.title,
            artists: getArtistNames(item),
            mbid: item.id
          }))
      }
    };
  }

  const item = match.item;

  const normalizedPerformers =
    getNormalizedPerformers(
      performers,
      item
    );

  return {
    input: {
      title,
      performer: performers,
      original_artist: song.original_artist || null
    },
    musicbrainz: {
      found: true,
      confidence: match.score,
      mbid: item.id,
      title: item.title,
      artists: getArtistNames(item),
      performers: normalizedPerformers,
      query
    }
  };
}

async function validateAlbum(album, eventArtist) {
  const title = album.title;
  const artist =
    album.artist ||
    eventArtist ||
    "";

  const titleQ = escapeLucene(title);
  const artistQ = escapeLucene(artist);

  const query =
    `release:"${titleQ}" AND artist:"${artistQ}"`;

  console.log(`    💿 ${title} — ${artist}`);

  const data = await musicBrainzSearch(
    "release",
    query
  );

  const match = bestMatch(
    data.releases,
    title,
    artist
  );

  if (!match || match.score < 100) {
    return {
      input: {
        title,
        artist
      },
      musicbrainz: {
        found: false,
        query,
        candidates: (data.releases || [])
          .slice(0, 5)
          .map(item => ({
            title: item.title,
            artists: getArtistNames(item),
            mbid: item.id,
            date: item.date || null
          }))
      }
    };
  }

  const item = match.item;

  return {
    input: {
      title,
      artist
    },
    musicbrainz: {
      found: true,
      confidence: match.score,
      mbid: item.id,
      title: item.title,
      artists: getArtistNames(item),
      date: item.date || null,
      status: item.status || null,
      query
    }
  };
}

async function main() {
  console.log("🎵 MUSICBRAINZ VALIDATOR");
  console.log("========================");

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(
      `❌ Не найден файл:\n${INPUT_FILE}`
    );
    process.exit(1);
  }

  const input = JSON.parse(
    fs.readFileSync(INPUT_FILE, "utf8")
  );

  console.log(`Записей Gemini: ${input.results.length}`);
  console.log("");

  const output = {
    source_file: "test-gemini-real-result.json",
    validator: "MusicBrainz",
    validated_at: new Date().toISOString(),
    results: []
  };

  let songsTotal = 0;
  let songsFound = 0;

  let albumsTotal = 0;
  let albumsFound = 0;

  let requestNumber = 0;

  for (const record of input.results) {
    console.log(
      `\n[${record.id}] ${record.event_artist}`
    );

    const result = {
      id: record.id,
      event_artist: record.event_artist,
      songs: [],
      albums: []
    };

    for (const song of record.songs || []) {
      songsTotal++;

      requestNumber++;
      if (requestNumber > 1) {
        await sleep(DELAY_MS);
      }

      try {
        const validated = await validateSong(
          song,
          record.event_artist
        );

        if (validated.musicbrainz.found) {
          songsFound++;
          console.log("      ✓ найдено");
        } else {
          console.log("      ⚠ не найдено");
        }

        result.songs.push(validated);
      } catch (error) {
        console.log(
          `      ❌ ошибка: ${error.message}`
        );

        result.songs.push({
          input: song,
          error: error.message
        });
      }
    }

    for (const album of record.albums || []) {
      albumsTotal++;

      requestNumber++;
      if (requestNumber > 1) {
        await sleep(DELAY_MS);
      }

      try {
        const validated = await validateAlbum(
          album,
          record.event_artist
        );

        if (validated.musicbrainz.found) {
          albumsFound++;
          console.log("      ✓ найдено");
        } else {
          console.log("      ⚠ не найдено");
        }

        result.albums.push(validated);
      } catch (error) {
        console.log(
          `      ❌ ошибка: ${error.message}`
        );

        result.albums.push({
          input: album,
          error: error.message
        });
      }
    }

    output.results.push(result);
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log("\n========================");
  console.log("🎉 ВАЛИДАЦИЯ ЗАВЕРШЕНА");
  console.log("========================");

  console.log(
    `Песен:   ${songsFound}/${songsTotal} найдено`
  );

  console.log(
    `Альбомов: ${albumsFound}/${albumsTotal} найдено`
  );

  console.log("");
  console.log(
    `Результат: ${OUTPUT_FILE}`
  );
}

main().catch(error => {
  console.error("\n❌ КРИТИЧЕСКАЯ ОШИБКА");
  console.error(error);
  process.exit(1);
});