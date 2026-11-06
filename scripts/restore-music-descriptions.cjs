const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve("data");
const MUSIC_WORKS_FILE = path.resolve("data/music-works.json");

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

const musicWorks = readJson(MUSIC_WORKS_FILE, []);

let updated = 0;
let notFound = 0;

for (const item of musicWorks) {
  const date = item.date;

  if (!date) {
    continue;
  }

  const sourceFile = path.join(DATA_DIR, `${date}.json`);

  if (!fs.existsSync(sourceFile)) {
    notFound++;
    continue;
  }

  const events = readJson(sourceFile, []);

  const sourceEvent = events.find(
    (event) => String(event.nID) === String(item.nID)
  );

  if (!sourceEvent) {
    notFound++;
    continue;
  }

  const description = sourceEvent.sDescription || "";

  if (item.description !== description) {
    item.description = description;
    updated++;
  }
}

fs.writeFileSync(
  MUSIC_WORKS_FILE,
  JSON.stringify(musicWorks, null, 2),
  "utf8"
);

console.log("");
console.log("Готово.");
console.log(`Обновлено описаний: ${updated}`);
console.log(`Не найдено исходных событий: ${notFound}`);
console.log(`Всего записей: ${musicWorks.length}`);