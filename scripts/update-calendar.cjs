const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DATA_DIR = path.resolve("data");
const PREPARED_DIR = path.join(DATA_DIR, "prepared");

const DAYS_TO_PREPARE = 7;

const MONTHS = [
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

function getTodayDate() {
  const now = new Date();

  const month = MONTHS[now.getMonth()];
  const day = String(now.getDate()).padStart(2, "0");

  return {
    month,
    day,
    slug: `${month}-${day}`,
  };
}

function getDateSlug(offset) {
  const now = new Date();

  now.setDate(now.getDate() + offset);

  const month = MONTHS[now.getMonth()];
  const day = String(now.getDate()).padStart(2, "0");

  return `${month}-${day}`;
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function runScript(scriptName, date) {
  console.log("");
  console.log("========================================");
  console.log(`Запускаем ${scriptName} для ${date}`);
  console.log("========================================");
  console.log("");

  execFileSync(
    process.execPath,
    [path.join(__dirname, scriptName), date],
    {
      stdio: "inherit",
    }
  );
}

function main() {
  const today = getTodayDate();

  console.log(`Сегодня: ${today.slug}`);
  console.log(`Проверяем следующие ${DAYS_TO_PREPARE} дней...`);
  console.log("");

  let preparedCount = 0;

  for (let offset = 0; offset < DAYS_TO_PREPARE; offset++) {
    const date = getDateSlug(offset);

    const sourceFile = path.join(DATA_DIR, `${date}.json`);
    const aiFile = path.join(DATA_DIR, "ai-music", `${date}.json`);
    const preparedFile = path.join(PREPARED_DIR, `${date}.json`);

    console.log(`\n📅 ${date}`);

    if (!fileExists(sourceFile)) {
      console.log(`  — Исходные данные не найдены: ${date}.json`);
      continue;
    }

    if (fileExists(preparedFile)) {
      console.log("  ✓ Уже подготовлено — пропускаем");
      continue;
    }

    if (!fileExists(aiFile)) {
      runScript("extract-today-music.cjs", date);
    } else {
      console.log("  ✓ AI-данные уже существуют");
    }

    runScript("prepare-today.cjs", date);

    preparedCount++;
  }

  console.log("");
  console.log("========================================");
  console.log("Обновление календаря завершено");
  console.log(`Новых дат подготовлено: ${preparedCount}`);
  console.log("========================================");
}

main();
