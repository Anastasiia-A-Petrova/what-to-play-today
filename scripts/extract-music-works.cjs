const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.resolve("data");
const outputPath = path.resolve("data/music-works.json");

/* =======================================================
   Вспомогательные функции
======================================================= */

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(title) {
  return title
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’.,;:!?]+/, "")
    .replace(/[\s"'“”‘’.,;:!?]+$/, "")
    .trim();
}

function cleanArtist(artist) {
  let value = String(artist || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’.,;:!?]+/, "")
    .replace(/[\s"'“”‘’.,;:!?]+$/, "")
    .trim();

  value = value.replace(
    /\.\s+(?:He|She|They|Their|His|Her|It|In|From|Best|Member|Who|Which|That|The)\b.*$/i,
    ""
  );

  value = value.replace(
    /\s+and\s*$/i,
    ""
  );

  if (
    /^(?:Her|His|Their|Its|member)\b/i.test(value)
  ) {
    return "";
  }

  if (
    /^(?:a\s+)?US\s+Vice\s+President\b/i.test(value)
  ) {
    return "";
  }

  if (
    /^Melody Maker['’]s Readers Poll\b/i.test(value)
  ) {
    return "";
  }

  return value
    .replace(/[\s"'“”‘’.,;:!?]+$/, "")
    .trim();
}

function isBadTitle(title) {
  if (!title || title.length < 2 || title.length > 120) {
    return true;
  }

  const lower = title.toLowerCase();

  /*
   * Фразы, которые явно являются частью обычного предложения,
   * а не названием произведения.
   */
  if (
    /\b(?:the|a|an)\s+(?:singer|singer's|singers|artist|artists)\b/i.test(
      title
    )
  ) {
    return true;
  }

  if (
    /\b(?:second|third|first|fourth|fifth|sixth)\s+no\.?\s*\d+/i.test(
      title
    )
  ) {
    return true;
  }

  if (/^[a-z]/.test(title)) {
    return true;
  }

  const bad = [
    "the",
    "a",
    "an",
    "and",
    "was",
    "were",
    "is",
    "are",
    "chart",
    "charts",
    "overall",
    "that",
    "which",
    "by",
    "of 2008",
    "by english band",
  ];

  if (bad.includes(lower)) {
    return true;
  }

  // Очевидные куски обычного предложения.
  if (
    /\b(?:debuted|released|recorded|reached|peaked|became|was|were|is|are|had|has|have|beat|with|from|who|which|that)\b/i.test(
      title
    )
  ) {
    return true;
  }

  /*
   * Название явно продолжается новым предложением:
   *
   * "Stone". Written by ...
   * "The Way You Do the Things You Do". Rogers also ...
   *
   * Не применяем правило ко всем точкам подряд,
   * чтобы не ломать названия вроде "P.S. I Love You".
   */
  if (
    /\.\s+(?:Written|Recorded|Produced|Rogers|Dudgeon|He|She|They|Their|The singer|The band|The group)\b/i.test(
      title
    )
  ) {
    return true;
  }

  /*
   * В название попало описание чарта/альбома:
   *
   * "... and 1977 UK No.1 album ..."
   * "... US No.1 for ..."
   * "... hit for ..."
   */
  if (
    /\b(?:19|20)\d{2}\b.*\b(?:No\.?\s*\d+|album|single|hit)\b/i.test(
      title
    )
  ) {
    return true;
  }

  if (
    /\b(?:No\.?\s*\d+|US|UK)\s+(?:No\.?\s*\d+\s+)?(?:album|single|hit)\b/i.test(
      title
    )
  ) {
    return true;
  }

  if (
    /\.\s+(?:Written|Recorded|Produced|Rogers|Dudgeon|He|She|They|Their|The singer|The band|The group)\b/i.test(
      title
    )
  ) {
    return true;
  }

  if (
    /\b(?:brought|appeared|sold|started|continued|reached|peaking|peaked|charted)\s+(?:the|a|an|many|over|at|on)\b/i.test(
      title
    )
  ) {
    return true;
  }

  if (
    /\.\s+(?:As|The|He|She|They|Their|His|Her|It|In|From|For|With|Who|Which|That|When|Where)\b/i.test(
      title
    )
  ) {
    return true;
  }

  return false;
}

function addTitle(results, title, type, artist = null) {
  title = cleanTitle(title);
  artist = cleanArtist(artist);

  if (isBadTitle(title)) {
    return;
  }

  const key = `${type}:${artist.toLowerCase()}:${title.toLowerCase()}`;

  if (
    !results.some(
      (item) =>
        `${item.type}:${String(item.artist || "").toLowerCase()}:${item.title.toLowerCase()}` ===
        key
    )
  ) {
    results.push({
      title,
      type,
      artist: artist || null,
    });
  }
}

/* =======================================================
   Кавычки
======================================================= */

function readQuotedTitle(text, start) {
  const quote = text[start];

  if (quote !== "'" && quote !== "“") {
    return null;
  }

  let i = start + 1;

  while (i < text.length) {
    const char = text[i];

    if (char === "”") {
      return {
        title: text.slice(start + 1, i),
        end: i + 1,
      };
    }

    if (char === "'") {
      const prev = text[i - 1] || "";
      const next = text[i + 1] || "";

      /*
       * Апостроф внутри слова:
       * Gangsta's
       * Cassidy's
       */
      if (/[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) {
        i++;
        continue;
      }

      /*
       * Апостроф внутри названия:
       *
       * Shakin' Goin' On
       *
       * После апострофа пробел, затем слово,
       * начинающееся с заглавной буквы.
       */
      if (/[A-Za-z]/.test(prev)) {
        let j = i + 1;

        while (j < text.length && /\s/.test(text[j])) {
          j++;
        }

        /*
         * Если следующее слово начинается с заглавной,
         * это почти наверняка внутренний апостроф:
         *
         * Shakin' Goin'
         *
         * А если с маленькой:
         *
         * On' and
         *
         * это закрывающая кавычка.
         */
        if (/[A-ZА-ЯЁ]/.test(text[j] || "")) {
          i++;
          continue;
        }
      }

      return {
        title: text.slice(start + 1, i),
        end: i + 1,
      };
    }

    i++;
  }

  return null;
}

function extractAllQuotedTitles(text) {
  const results = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "'" && text[i] !== "“") {
      continue;
    }

    const parsed = readQuotedTitle(text, i);

    if (!parsed) {
      continue;
    }

    results.push({
      title: cleanTitle(parsed.title),
      start: i,
      end: parsed.end,
    });

    i = parsed.end - 1;
  }

  return results;
}

/* =======================================================
   Исполнители из текста
======================================================= */

/*
 * Здесь мы НЕ пытаемся определить исполнителя по любому
 * упоминанию группы в тексте.
 *
 * Исполнитель переопределяется только при наличии
 * явной связи с конкретным произведением.
 */

function normalizeArtistCandidate(value) {
  return cleanArtist(
    String(value || "")
      .replace(
        /^(?:the\s+)?(?:american|british|english|scottish|canadian|jamaican|australian|irish|folk|pop|rock|new wave|alternative|glam rock|country|reggae|soul|blues)\s+/i,
        ""
      )
      .replace(
        /^(?:singer|singer-songwriter|musician|vocalist|artist)\s+/i,
        ""
      )
  );
}

function findGroupInContext(text, position) {
  /*
   * Смотрим назад достаточно далеко, чтобы захватить:
   *
   * The Jesus and Mary Chain.
   * The band's ... album Darklands
   *
   * или:
   *
   * group The Blow Monkeys who had ...
   * ... 'Digging Your Scene' and ... 'It Doesn't...'
   */

  const start = Math.max(0, position - 900);
  const context = text.slice(start, position);

  /*
   * Ищем последнее явное объявление группы.
   *
   * Например:
   * British new wave group The Blow Monkeys
   * Scottish alternative rock band The Jesus and Mary Chain
   * American pop music group Dawn
   */
  const regex =
    /\b(?:band|group|duo|trio)\s+((?:The|A|An)\s+)?([A-Z][A-Za-z0-9&.'’-]*(?:\s+(?:[A-Z][A-Za-z0-9&.'’-]*|and|&)){0,7})/g;

  let lastMatch = null;

  for (const match of context.matchAll(regex)) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return null;
  }

  return cleanArtist(
    `${lastMatch[1] || ""}${lastMatch[2]}`
      .replace(/\.\s*The$/i, "")
  );

}

/*
 * Обрезаем описание исполнителя:
 *
 * American folk duo Friend & Lover
 * British new wave group The Blow Monkeys
 * Scottish alternative rock band The Jesus and Mary Chain
 *
 * -> Friend & Lover
 * -> The Blow Monkeys
 * -> The Jesus and Mary Chain
 */

function cleanExplicitArtist(value) {
  let artist = cleanArtist(value);

  const groupMatch = artist.match(
    /\b(?:band|group|duo|trio)\s+((?:The|A|An)\s+)?([A-Z][A-Za-z0-9&.'’-]*(?:\s+(?:[A-Z][A-Za-z0-9&.'’-]*|and|&)){0,7})/
  );

  if (groupMatch) {
    return cleanArtist(
      `${groupMatch[1] || ""}${groupMatch[2]}`
    );
  }

  artist = artist
    .replace(
      /^(?:the\s+)?(?:american|british|english|scottish|canadian|jamaican|australian|irish|french|german|folk|pop|rock|new wave|alternative|glam rock|country|reggae|soul|blues|jazz|punk|heavy metal|indie)(?:\s+[A-Za-z-]+){0,4}\s+/i,
      ""
    )
    .trim();

  artist = artist.split(
    /\s+(?:who|which|that|had|has|have|was|were|is|are|with|from|when|where|for|to|on|in)\b/i
  )[0];

  return cleanArtist(artist);
}

/*
 * Находит ЯВНО указанную группу/исполнителя в пределах
 * предложения перед названием.
 *
 * Например:
 *
 * "the Scottish alternative rock band The Jesus and Mary Chain.
 *  The band's ... album Darklands ..."
 *
 * -> The Jesus and Mary Chain
 *
 * "from British new wave group The Blow Monkeys who had
 *  the 1986 hit 'Digging Your Scene'"
 *
 * -> The Blow Monkeys
 */

function findExplicitArtistBeforeTitle(text, titleStart) {
  const before = text.slice(
    Math.max(0, titleStart - 350),
    titleStart
  );

  const sentenceParts = before.split(/[.!?]/);
  const sentence = sentenceParts[sentenceParts.length - 1];

  const bandMatches = [
    ...before.matchAll(
      /\b(?:band|group)\s+((?:The|A|An)\s+)?([A-Z][A-Za-z0-9&.'’-]*(?:\s+(?:[A-Z][A-Za-z0-9&.'’-]*|and|&)){0,7})\b/gi
    ),
  ];

  const bandMatch =
    bandMatches[bandMatches.length - 1];

  if (bandMatch) {
    return cleanArtist(
      `${bandMatch[1] || ""}${bandMatch[2]}`
    );
  }

  /*
   * "... group The Blow Monkeys ..."
   * "... band The Jesus and Mary Chain ..."
   * "... duo Friend & Lover ..."
   */
  const groupMatch = sentence.match(
    /\b(?:band|group|duo|trio)\s+((?:The|A|An)\s+)?([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,7})/
  );

  if (groupMatch) {
    return cleanArtist(
      `${groupMatch[1] || ""}${groupMatch[2]}`
    );
  }

  /*
   * "The Who song 'Join Together'"
   * "Stevie Wonder song 'Pastime Paradise'"
   */
  const songArtist = sentence.match(
    /((?:The\s+)?[A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,5})\s+song\s*$/
  );

  if (songArtist) {
    return cleanArtist(songArtist[1]);
  }

  /*
   * "recorded with Marcia Griffiths as Bob and Marcia ..."
   */
  const asArtist = sentence.match(
    /\bas\s+([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,5})\s*$/
  );

  if (asArtist) {
    return cleanArtist(asArtist[1]);
  }

  return null;
}

/*
 * Исполнитель после названия:
 *
 * 'Reach out of the Darkness' recorded by American folk duo Friend & Lover
 *
 * -> Friend & Lover
 */

function findExplicitArtistAfterTitle(text, titleEnd) {
  const after = text.slice(
    titleEnd,
    Math.min(text.length, titleEnd + 250)
  );

  /*
   * Явно указанная группа/дуэт после названия:
   *
   * recorded by American folk duo Friend & Lover
   *
   * Важно:
   * ищем "duo/group/band/trio" только внутри
   * конструкции recorded/performed/etc. by/with.
   */
  const groupMatch = after.match(
    /\b(?:recorded|performed|covered|sung|sang|written|co-written)\s+(?:by|with)\s+(?:(?:the|an|a|american|british|english|scottish|canadian|jamaican|australian|irish|folk|pop|rock|new wave|alternative|country|reggae|soul|blues)\s+){0,8}(?:band|group|duo|trio)\s+((?:The|A|An)\s+)?([A-Z][A-Za-z0-9&.'’-]*(?:\s+(?:[A-Z][A-Za-z0-9&.'’-]*|and|&)){0,7})(?=\s+(?:charted|recorded|performed|covered|sang|sung|wrote|co-wrote|released|was|were|which|who|that)\b|[.,;]|$)/i
  );

  if (groupMatch) {
    return cleanArtist(
      `${groupMatch[1] || ""}${groupMatch[2]}`
    );
  }

  /*
   * Обычная конструкция:
   *
   * recorded by Nick Gilder
   * performed by Stevie Wonder
   */
  const match = after.match(
    /\b(?:recorded|performed|covered|sung|sang|written|co-written)\s+(?:by|with)\s+((?:(?:the|an|a|american|british|english|scottish|canadian|jamaican|australian|irish|folk|pop|rock|new wave|alternative|country|reggae|soul|blues)\s+){0,8}[A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,6})/
  );

  if (!match) {
    return null;
  }

  return cleanExplicitArtist(match[1]);
}
/*
 * Исполнитель непосредственно перед названием:
 *
 * Stevie Wonder song 'Pastime Paradise'
 *
 * Важно: здесь мы НЕ ищем просто любое имя рядом.
 */

function findArtistNearTitle(text, titleStart, titleEnd) {
  /*
   * 1. Самый надёжный вариант:
   *
   * 'Reach out of the Darkness' recorded by Friend & Lover
   */
  const explicitAfter =
    findExplicitArtistAfterTitle(
      text,
      titleEnd
    );

  if (explicitAfter) {
    return explicitAfter;
  }

  /*
   * 2. Явный исполнитель непосредственно перед названием:
   *
   * Stevie Wonder song 'Pastime Paradise'
   */
  const explicitBefore =
    findExplicitArtistBeforeTitle(
      text,
      titleStart
    );

  if (explicitBefore) {
    return explicitBefore;
  }

  /*
   * 3. Группа, объявленная раньше в тексте.
   */
  return findGroupInContext(
    text,
    titleStart
  );
}

/* =======================================================
   Песни после музыкальных слов
======================================================= */

function extractContextSongs(text, results) {
  const regex =
    /\b(?:single|singles|song|songs|hit|hits|classic|track|tracks|recording|recordings|version|versions)\b[^'“]{0,120}(['“])/gi;

  for (const match of text.matchAll(regex)) {
    const quoteStart =
      match.index + match[0].length - 1;

    const parsed = readQuotedTitle(
      text,
      quoteStart
    );

    if (!parsed) {
      continue;
    }

    const artist = findArtistNearTitle(
      text,
      quoteStart,
      parsed.end
    );

    addTitle(
      results,
      parsed.title,
      "song",
      artist
    );
  }
}

/* =======================================================
   Possessive songs
======================================================= */

function extractPossessiveSongs(text, results) {
  /*
   * Старый вариант был слишком жадным и мог получить:
   *
   * "the singer's second No.1. 'The Puppy Song'"
   *
   * как исполнителя.
   *
   * Теперь допускаем только короткое имя перед 's.
   */

  const regex =
    /\b([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Z][A-Za-z0-9&.'’-]*){0,4})['’]s\s+(['“])/g;

  for (const match of text.matchAll(regex)) {
    const quoteStart =
      match.index + match[0].length - 1;

    const parsed = readQuotedTitle(
      text,
      quoteStart
    );

    if (!parsed) {
      continue;
    }

    const artist = cleanArtist(match[1]);

    addTitle(
      results,
      parsed.title,
      "song",
      artist
    );
  }
}

/* =======================================================
   Списки песен
======================================================= */

function extractListedSongs(text, results) {
  const regex =
    /\b(?:singles|songs|tracks|hits)\b[^.]{0,120}?\b(?:include|included|such as|were|are|featured)\b/gi;

  for (const match of text.matchAll(regex)) {
    const start =
      match.index + match[0].length;

    const fragment =
      text.slice(start, start + 400);

    for (const item of extractAllQuotedTitles(fragment)) {
      const absoluteStart =
        start + item.start;

      const artist =
        findArtistNearTitle(
          text,
          absoluteStart,
          start + item.end
        );

      addTitle(
        results,
        item.title,
        "song",
        artist
      );
    }
  }
}

/* =======================================================
   Альбомы
======================================================= */

function extractAlbums(text, results) {
  /*
   * Обычные конструкции:
   *
   * new album The Wonder Of You
   * second album Darklands
   * studio album Talking Book
   */

  const regex =
    /\b(?:new|debut|sixth|fifth|fourth|third|second|first|self-titled|studio|double)?\s*album\s+([A-Z][A-Za-z0-9&'’!?:-]*(?:\s+[A-Za-z0-9&'’!?:-]+){0,7}?)(?=\s*(?:,|\.|;|\(|\)|$|\s+(?:which|that|and|was|were|is|are|went|reached|became|featured|contained|included|peaked|debuted|also|beat|to|brought|appeared|sold|started|continued|in)\b))/g;

  for (const match of text.matchAll(regex)) {
    let title = match[1].trim();

    title = title
      .replace(/[,;:\s]+$/, "")
      .trim();

    if (!title) {
      continue;
    }

    const titleStart =
      match.index + match[0].lastIndexOf(title);

    const artist =
      findArtistNearTitle(
        text,
        titleStart,
        titleStart + title.length
      );

    addTitle(
      results,
      title,
      "album",
      artist
    );
  }
}

function extractAlbumQuotedTitles(text, results) {
  const regex =
    /\balbum\s+(['“])/gi;

  for (const match of text.matchAll(regex)) {
    const quoteStart =
      match.index + match[0].length - 1;

    const parsed = readQuotedTitle(
      text,
      quoteStart
    );

    if (!parsed) {
      continue;
    }

    const artist =
      findArtistNearTitle(
        text,
        quoteStart,
        parsed.end
      );

    addTitle(
      results,
      parsed.title,
      "album",
      artist
    );
  }
}

function extractChartAlbumTitles(text, results) {
  const regex =
    /\balbum\s+chart\s+with\s+(['“])/gi;

  for (const match of text.matchAll(regex)) {
    const quoteStart =
      match.index + match[0].length - 1;

    const parsed =
      readQuotedTitle(text, quoteStart);

    if (!parsed) {
      continue;
    }

    addTitle(
      results,
      parsed.title,
      "album",
      null
    );
  }
}

/* =======================================================
   Специальный случай со списком
======================================================= */

function extractBrokenSongTitles(text, results) {
  const regex =
    /(['“])([^'“]{2,120}?)\s+and\s+(?:the\s+)?(?:\d{4}\s+)?(?:UK|US)\s+No\.\d+\s+(?:&\s*(?:US|UK)\s+No\.\d+\s+)?single\s+(['“])/gi;

  for (const match of text.matchAll(regex)) {
    const firstTitle =
      cleanTitle(match[2]);

    if (!firstTitle) {
      continue;
    }

    const artist =
      findArtistNearTitle(
        text,
        match.index,
        match.index + match[0].length
      );

    addTitle(
      results,
      firstTitle,
      "song",
      artist
    );
  }
}

/* =======================================================
   Главный экстрактор
======================================================= */

function extractMusicWorks(
  html,
  fallbackArtist
) {
  const text = stripHtml(html);

  const results = [];

  /*
   * Важный принцип:
   *
   * fallbackArtist — главный исполнитель события.
   *
   * Мы НЕ собираем все группы из текста и НЕ назначаем
   * их автоматически произведениям.
   */

  extractAlbums(
    text,
    results
  );

  extractAlbumQuotedTitles(
    text,
    results
  );

  extractChartAlbumTitles(
    text,
    results
  );

  extractContextSongs(
    text,
    results
  );

  extractListedSongs(
    text,
    results
  );

  /*
   * Если в тексте нет явной связи с другим исполнителем,
   * произведение принадлежит исполнителю события.
   */
  for (const work of results) {
    if (!work.artist) {
      work.artist = cleanArtist(fallbackArtist);
    }
  }

  return results.filter(
    (work) =>
      !/^Melody Maker/i.test(work.artist || "") &&
      !(
        work.artist === "Hicks and His Hot Licks" &&
        ["I Scare Myself", "Canned Music"].includes(work.title)
      )
  );
}

/* =======================================================
   Читаем исходные события
======================================================= */

function isMojibake(value) {
  return /(?:вЂ|Г[РС]|ВЈ|вЂЂ)/i.test(
    String(value || "")
  );
}

const files = fs
  .readdirSync(dataDir)
  .filter((file) => file.endsWith(".json"))
  .filter((file) => file !== "music-works.json")
  .filter((file) => file !== "birthday-photos.json")
  .filter((file) => !file.startsWith("prepared"))
  .sort();

const result = [];

let totalEvents = 0;
let totalWorks = 0;

for (const file of files) {
  const filePath = path.join(dataDir, file);

  const events = JSON.parse(
    fs.readFileSync(filePath, "utf8")
  );

  for (const event of events) {
    totalEvents++;

    const fallbackArtist =
      event.sArtist && !isMojibake(event.sArtist)
        ? event.sArtist
        : event.sBand || "";

    const works = extractMusicWorks(
      event.sDescription || "",
      fallbackArtist
    );

    if (works.length === 0) {
      continue;
    }

    totalWorks += works.length;

    result.push({
      date: file.replace(".json", ""),
      nID: event.nID,
      year: event.nYear,
      artist: fallbackArtist,
      works,
      description: stripHtml(
        event.sDescription || ""
      ),
    });
  }
}

/* =======================================================
   Сохраняем
======================================================= */

fs.writeFileSync(
  outputPath,
  JSON.stringify(result, null, 2),
  "utf8"
);

console.log(`Обработано файлов: ${files.length}`);
console.log(`Всего событий: ${totalEvents}`);
console.log(
  `Событий с музыкальными произведениями: ${result.length}`
);
console.log(
  `Всего найденных произведений: ${totalWorks}`
);
console.log(`Результат: ${outputPath}`);
