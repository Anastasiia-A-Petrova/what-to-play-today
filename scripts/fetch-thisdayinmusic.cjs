const fs = require("fs");

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(month, day) {
  const url = `https://www.thisdayinmusic.com/on-this-day-in-music-${month}-${day}/`;

  console.log(`Получаем: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

function extractEvents(html) {
  const matches =
    html.match(/<!--<pre>\s*(\{.*?\})\s*<\/pre>-->/gs) || [];

  return matches.map((block) => {
    const jsonText = block
      .replace(/<!--<pre>\s*/, "")
      .replace(/\s*<\/pre>-->/, "")
      .trim();

    return JSON.parse(jsonText);
  });
}

/* =======================================================
   Работа с текстом
======================================================= */

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/^[\s"'“”‘’]+/, "")
    .replace(/[\s"'“”‘’]+$/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([?!,:;])/g, "$1")
    .replace(/\.$/, "")
    .trim();
}

/*
 * Явно плохие названия.
 *
 * Здесь специально НЕ делаем огромный blacklist.
 * Лучше пропустить редкое ложное название,
 * чем случайно потерять настоящую песню.
 */
function isBadTitle(title) {
  const value = cleanTitle(title);
  const lower = value.toLowerCase();

  if (!value) return true;

  // Явные обрывки предложений и названий.
  if (
    /^[a-z]\s+(?:first|second|third|fourth|fifth)\b/i.test(value) ||
    /^(?:and|or|but|the|a|an)\s*$/i.test(value) ||
    /\b(?:single|album|song|track|recording)\s*,$/i.test(value) ||
    /\b(?:and|or|but)\s*$/i.test(value)
  ) {
    return true;
  }

  if (value.length < 2 || value.length > 120) {
    return true;
  }

  // Не должно быть нескольких предложений внутри названия.
  if (/[.!?].+[A-Z]/.test(value)) {
    return true;
  }

  // Явные служебные фразы.
  const badExact = [
    "also",
    "album",
    "the album",
    "the song",
    "the single",
    "a song",
    "a single",
    "of the same name",
    "overall in the country",
    "best male",
    "best female",
    "best pop",
    "best song",
    "queen of gospel music",
    "king of rock",
  ];

  if (badExact.includes(lower)) {
    return true;
  }

  // Начало почти никогда не является названием произведения.
  const badStarts = [
    "the album ",
    "the song ",
    "the single ",
    "a song ",
    "a single ",
    "that the ",
    "which the ",
    "and the ",
    "overall ",
    "also ",
    "from the ",
    "to the ",
    "in the ",
    "known as ",
    "called ",
    "described as ",
    "said ",
  ];

  if (badStarts.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }

  /*
   * Фразы, которые источник использует как описание человека,
   * а не как название произведения.
   */
  if (
    /^(?:the\s+)?(?:queen|king|prince|princess)\s+of\b/i.test(
      value
    )
  ) {
    return true;
  }

  /*
   * Слишком явно похожие на обычное предложение фразы.
   */
  if (
    /^(?:never|always|sometimes|very|really|also|still|just|overall)\b/i.test(
      value
    )
  ) {
    return true;
  }

  return false;
}

/*
 * Добавляем произведение только один раз.
 */
function addWork(works, title, type, artist = "") {
  const clean = cleanTitle(title);

  if (isBadTitle(clean)) {
    return;
  }

  const normalizedTitle = clean.toLowerCase();

  const exists = works.some(
    (work) =>
      work.type === type &&
      work.title.toLowerCase() === normalizedTitle
  );

  if (exists) {
    return;
  }

  const searchText = artist
    ? `${artist} ${clean}`
    : clean;

  works.push({
    title: clean,
    type,
    artist,

    /*
     * Пока используем обычный поиск.
     * Позже сюда без переделки парсера можно
     * подставить конкретный YouTube videoId.
     */
    youtubeUrl:
      `https://www.youtube.com/results?search_query=` +
      encodeURIComponent(searchText),

    chordsUrl:
      `https://www.google.com/search?q=` +
      encodeURIComponent(`${searchText} chords`),
  });
}

/* =======================================================
   Кавычки
======================================================= */

/*
 * Находит:
 *
 * "Song"
 * “Song”
 * 'Song'
 *
 * При этом:
 *
 * I'm
 * Can't
 * Heaven's
 * You've
 *
 * не считаются отдельными кавычками.
 */
function extractQuotedTitles(text) {
  const result = [];

  const source = String(text || "");

  /*
   * Двойные кавычки.
   */
  const doubleRegex = /"([^"\n]{2,120})"/g;

  let match;

  while ((match = doubleRegex.exec(source)) !== null) {
    result.push({
      title: match[1],
      index: match.index,
      end: doubleRegex.lastIndex,
      quoteType: "double",
    });
  }

  /*
   * Типографские кавычки.
   */
  const curlyRegex = /“([^”\n]{2,120})”/g;

  while ((match = curlyRegex.exec(source)) !== null) {
    result.push({
      title: match[1],
      index: match.index,
      end: curlyRegex.lastIndex,
      quoteType: "curly",
    });
  }

  /*
   * Одинарные кавычки.
   *
   * Они самые сложные.
   */
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "'") {
      continue;
    }

    const previous = source[i - 1] || "";
    const next = source[i + 1] || "";

    /*
     * Апостроф внутри слова:
     *
     * I'm
     * Can't
     * Heaven's
     * You've
     */
    if (
      /[A-Za-z0-9]/.test(previous) &&
      /[A-Za-z0-9]/.test(next)
    ) {
      continue;
    }

    /*
     * Possessive:
     *
     * Reed's
     * Diddley's
     * Waters'
     */
    if (
      /[A-Za-z0-9]/.test(previous) &&
      (
        /\s/.test(next) ||
        /[,.;:!?)]/.test(next)
      )
    ) {
      continue;
    }

    /*
     * Ищем закрывающую кавычку.
     */
    let j = i + 1;

    while (j < source.length) {
      if (source[j] !== "'") {
        j++;
        continue;
      }

      const beforeClose = source[j - 1] || "";
      const afterClose = source[j + 1] || "";

      /*
       * Апостроф внутри самого названия:
       *
       * Heaven's
       * I'm
       * Can't
       */
      if (
        /[A-Za-z0-9]/.test(beforeClose) &&
        /[A-Za-z0-9]/.test(afterClose)
      ) {
        j++;
        continue;
      }

      const title = cleanTitle(
        source.slice(i + 1, j)
      );

      if (
        title.length >= 2 &&
        title.length <= 120
      ) {
        result.push({
          title,
          index: i,
          end: j + 1,
          quoteType: "single",
        });
      }

      i = j;
      break;
    }
  }

  return result.sort(
    (a, b) => a.index - b.index
  );
}

/* =======================================================
   Специальные конструкции This Day In Music
======================================================= */

/*
 * Обрабатывает:
 *
 * single 'Love Shack'
 * song 'Grace'
 * hit 'Carnival'
 * classic 'Knocking On Heaven's Door'
 * track '...'
 *
 * Это намного надёжнее, чем брать любые кавычки подряд.
 */
function extractExplicitSongTitles(
  text,
  works,
  artist
) {
  const patterns = [
    /*
     * single 'Title'
     * song 'Title'
     * hit 'Title'
     * classic 'Title'
     * track 'Title'
     *
     * Поддерживаем обычные и типографские кавычки.
     */
    /\b(?:single|song|hit|classic|track|recording)\s+(?:"([^"\n]{2,120})"|'([^'\n]{2,120})'|“([^”\n]{2,120})”)/gi,

    /*
     * singles: 'Title'
     * songs: 'Title'
     */
    /\b(?:singles|songs|hits|tracks)\s*:\s*(?:"([^"\n]{2,120})"|'([^'\n]{2,120})'|“([^”\n]{2,120})”)/gi,

    /*
     * album contained 'Title'
     */
    /\b(?:contained|included|featured)\s+(?:the\s+)?(?:single|song|hit|track)?\s*(?:"([^"\n]{2,120})"|'([^'\n]{2,120})'|“([^”\n]{2,120})”)/gi,
  ];

  for (const regex of patterns) {
    let match;

    while ((match = regex.exec(text)) !== null) {
      /*
       * В каждой конструкции название может оказаться
       * в одной из трёх групп:
       *
       * 1 — "Title"
       * 2 — 'Title'
       * 3 — “Title”
       */
      const title =
        match[1] ||
        match[2] ||
        match[3];

      addWork(
        works,
        title,
        "song",
        artist
      );
    }
  }
}

/*
 * Обычные quoted titles.
 *
 * Но перед добавлением проверяем контекст.
 */
function extractContextualQuotedSongs(
  text,
  works,
  artist
) {
  const quotes = extractQuotedTitles(text);

  for (const quote of quotes) {
    const before = text
      .slice(
        Math.max(0, quote.index - 100),
        quote.index
      )
      .toLowerCase();

    /*
     * Музыкальный контекст.
     *
     * Если рядом есть хотя бы один из этих маркеров,
     * вероятность песни очень высокая.
     */
    const hasMusicContext =
      /\b(?:single|singles|song|songs|hit|hits|classic|track|tracks|recorded|recording|cover|covered|released|release|collaboration)\b/i.test(
        before
      );

    /*
     * Фразы, которые явно описывают человека,
     * а не музыкальное произведение.
     */
    const isDescription =
      /\b(?:known as|called|described as|named|said|says|told|quoted)\b/i.test(
        before
      );

    if (isDescription && !hasMusicContext) {
      continue;
    }

    /*
     * Если контекст музыкальный — принимаем.
     */
    if (hasMusicContext) {
      addWork(
        works,
        quote.title,
        "song",
        artist
      );
    }
  }
}

/*
 * Специальный случай:
 *
 * 'Rock Lobster and the 1990 UK No.2 ...
 * single 'Love Shack'
 *
 * На сайте отсутствует закрывающая кавычка
 * после Rock Lobster.
 */
function extractMalformedSingleQuotes(
  text,
  works,
  artist
) {
  const regex =
    /\bsingle\s+'([^']+?)\s+and\s+the\s+\d{4}\s+[^']*?\bsingle\s+'([^']+)'/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    /*
     * Первое название обрезаем перед
     * "and the YEAR".
     */
    const firstTitle = match[1]
      .replace(
        /\s+and\s+the\s+\d{4}\s+.*$/i,
        ""
      )
      .trim();

    addWork(
      works,
      firstTitle,
      "song",
      artist
    );

    addWork(
      works,
      match[2],
      "song",
      artist
    );
  }
}

/* =======================================================
   Альбомы
======================================================= */

function extractAlbums(
  text,
  works,
  artist
) {
  const patterns = [
    /*
     * studio album Black Ice
     * sixth studio album Quadrophenia
     * debut studio album Tigerlily
     */
    /\b(?:\w+\s+)?studio\s+album\s+([A-Z][^.,;]+?)(?=\s+(?:peaked|reached|contained|which|that|and|on|at|was|were|became|with|in)\b|[.,;]|$)/gi,

    /*
     * from the album Blizzard of Ozz
     */
    /\bfrom\s+the\s+album\s+([A-Z][^.,;]+?)(?=\s+(?:contributed|which|that|and|was|were|became|peaked|reached|contained|with|on)\b|[.,;]|$)/gi,
  ];

  for (const regex of patterns) {
    let match;

    while ((match = regex.exec(text)) !== null) {
      const title = cleanTitle(match[1]);

      /*
       * Ограничиваем разумную длину.
       */
      if (
        title.split(/\s+/).length <= 15
      ) {
        addWork(
          works,
          title,
          "album",
          artist
        );
      }
    }
  }
}

/* =======================================================
   Главный парсер
======================================================= */

function extractSongs(
  text,
  works,
  artist = ""
) {
  /*
   * 1. Самые надёжные конструкции.
   */
  extractExplicitSongTitles(
    text,
    works,
    artist
  );

  /*
   * 2. Исправляем кривые кавычки.
   */
  extractMalformedSingleQuotes(
    text,
    works,
    artist
  );

  /*
   * 3. Остальные quoted titles
   * только при музыкальном контексте.
   */
  extractContextualQuotedSongs(
    text,
    works,
    artist
  );
}

function extractMusicWorks(
  description,
  artist = ""
) {
  const text = stripHtml(description);
  const works = [];

  extractSongs(
    text,
    works,
    artist
  );

  extractAlbums(
    text,
    works,
    artist
  );

  return works;
}

/* =======================================================
   Индекс произведений
======================================================= */

function buildMusicWorksIndex() {
  const files = fs
    .readdirSync("data")
    .filter(
      (file) =>
        file.endsWith(".json") &&
        !file.startsWith("music-works")
    )
    .sort();

  const result = [];

  for (const file of files) {
    const date = file.replace(".json", "");

    const events = JSON.parse(
      fs.readFileSync(`data/${file}`, "utf8")
    );

    for (const event of events) {
      const description = event.sDescription || "";
      const artist = event.sArtist || "";

      const works = extractMusicWorks(
        description,
        artist
      );

      if (!works.length) continue;

      result.push({
        date,
        nID: event.nID,
        year: event.nYear,
        artist: event.sArtist || "",
        works,
        description,
      });
    }
  }

  fs.writeFileSync(
    "data/music-works.json",
    JSON.stringify(result, null, 2),
    "utf8"
  );

  const workCount = result.reduce(
    (total, event) => total + event.works.length,
    0
  );

  console.log("");
  console.log("Индекс музыкальных произведений создан.");
  console.log(`Событий с произведениями: ${result.length}`);
  console.log(`Найдено произведений: ${workCount}`);
  console.log("Файл: data/music-works.json");
}

/* =======================================================
   Загрузка дат
======================================================= */

async function fetchDate(month, day) {
  const fileName = `${month}-${String(day).padStart(2, "0")}.json`;
  const filePath = `data/${fileName}`;

  if (fs.existsSync(filePath)) {
    console.log(`Пропускаем ${fileName} — файл уже существует.`);
    return;
  }

  try {
    const html = await fetchPage(month, day);
    const events = extractEvents(html);

    fs.writeFileSync(
      filePath,
      JSON.stringify(events, null, 2),
      "utf8"
    );

    console.log(`  Найдено событий: ${events.length}`);
    console.log(`  Сохранено: ${filePath}`);
  } catch (error) {
    console.error(
      `  ОШИБКА ${month}-${day}: ${error.message}`
    );
  }
}

async function main() {
  fs.mkdirSync("data", { recursive: true });

  for (let monthIndex = 0; monthIndex < months.length; monthIndex++) {
    const month = months[monthIndex];
    const monthNumber = monthIndex + 1;

    const daysInMonth = new Date(
      2024,
      monthNumber,
      0
    ).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      await fetchDate(month, day);

      await sleep(500);
    }
  }

  buildMusicWorksIndex();

  console.log("");
  console.log("Готово!");
}

main().catch((error) => {
  console.error("Критическая ошибка:", error);
  process.exit(1);
});