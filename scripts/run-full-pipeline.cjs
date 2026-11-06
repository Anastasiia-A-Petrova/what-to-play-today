
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const AI_DIR = path.join(DATA_DIR, "ai-music");
const PREPARED_DIR = path.join(DATA_DIR, "prepared");

const MONTHS = [
  "january", "february", "march", "april",
  "may", "june", "july", "august",
  "september", "october", "november", "december",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function getDates() {
  const dates = [];

  for (const month of MONTHS) {
    for (let day = 1; day <= 31; day++) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      const file = path.join(DATA_DIR, `${date}.json`);

      if (fs.existsSync(file)) {
        dates.push(date);
      }
    }
  }

  return dates;
}

function getNextDays(count, allDates) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());

  const year = Number(parts.find(p => p.type === "year").value);
  const month = Number(parts.find(p => p.type === "month").value);
  const day = Number(parts.find(p => p.type === "day").value);

  const currentDate = new Date(Date.UTC(year, month - 1, day));

  const selectedDates = [];
  const missingDates = [];

  for (let i = 0; i < count; i++) {
    const date = new Date(currentDate);
    date.setUTCDate(date.getUTCDate() + i);

    const slug =
      `${MONTHS[date.getUTCMonth()]}-${String(date.getUTCDate()).padStart(2, "0")}`;

    if (allDates.includes(slug)) {
      selectedDates.push(slug);
    } else {
      missingDates.push(slug);
    }
  }

  if (missingDates.length > 0) {
    console.log("⚠ Нет исходных файлов для дат:");
    console.log(missingDates.join(", "));
  }

  if (selectedDates.length === 0) {
    throw new Error("Не найдены исходные файлы для выбранного периода.");
  }

  return selectedDates;
}

function selectDates(args, allDates) {
  if (args.length === 0) {
    return allDates;
  }

  // Один аргумент: месяц или конкретная дата
  if (args.length === 1) {
    const value = args[0].toLowerCase().trim();

    if (MONTHS.includes(value)) {
      const dates = allDates.filter((date) =>
        date.startsWith(`${value}-`)
      );

      if (dates.length === 0) {
        throw new Error(`Для месяца ${value} не найдены исходные JSON-файлы.`);
      }

      return dates;
    }

    if (/^[a-z]+-\d{2}$/.test(value) && allDates.includes(value)) {
      return [value];
    }

    throw new Error(
      `Неизвестный месяц или дата: ${value}.\n` +
      `Используй название месяца (january) или дату (january-01).`
    );
  }

  // Два аргумента: диапазон дат
  if (args.length === 2) {
    const start = args[0].toLowerCase().trim();
    const end = args[1].toLowerCase().trim();

    if (!/^[a-z]+-\d{2}$/.test(start) || !allDates.includes(start)) {
      throw new Error(`Начальная дата не найдена: ${start}`);
    }

    if (!/^[a-z]+-\d{2}$/.test(end) || !allDates.includes(end)) {
      throw new Error(`Конечная дата не найдена: ${end}`);
    }

    const startIndex = allDates.indexOf(start);
    const endIndex = allDates.indexOf(end);

    if (startIndex > endIndex) {
      throw new Error(
        `Начальная дата ${start} должна быть раньше конечной даты ${end}.`
      );
    }

    return allDates.slice(startIndex, endIndex + 1);
  }

  throw new Error(
    "Слишком много аргументов.\n" +
    "Используй: [месяц] или [начальная-дата] [конечная-дата]."
  );
}

function runScript(scriptName, date) {
  const scriptPath = path.join(__dirname, scriptName);

  console.log("\n----------------------------------------");
  console.log(`Запуск: ${scriptName} (${date})`);
  console.log("----------------------------------------\n");

  const result = spawnSync(
    process.execPath,
    [scriptPath, date],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${scriptName} завершился с кодом ${result.status}`
    );
  }
}

function validateAiFile(file) {
  const data = readJson(file);

  if (!Array.isArray(data.results)) {
    throw new Error(`В AI-файле отсутствует массив results: ${file}`);
  }

  return data;
}

function validatePreparedFile(file) {
  const data = readJson(file);

  if (!Array.isArray(data.people) || !Array.isArray(data.works)) {
    throw new Error(`Некорректная структура prepared-файла: ${file}`);
  }

  return data;
}

function main() {
  const args = process.argv.slice(2);

  const refreshMissing = args.includes("--refresh-missing");

  const nextDaysIndex = args.indexOf("--next-days");

  const positionalArgs = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;

    if (
      nextDaysIndex !== -1 &&
      index === nextDaysIndex + 1
    ) {
      return false;
    }

    return true;
  });

  const allDates = getDates();

  let dates;

  if (nextDaysIndex !== -1) {
    const count = Number(args[nextDaysIndex + 1]);

    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 14
    ) {
      throw new Error(
        "Укажи количество дней от 1 до 14 после --next-days."
      );
    }

    if (positionalArgs.length > 0) {
      throw new Error(
        "--next-days нельзя использовать вместе с другими датами."
      );
    }

    dates = getNextDays(count, allDates);
  } else {
    dates = selectDates(positionalArgs, allDates);
  }

  console.log("========================================");
  console.log("WHAT TO PLAY TODAY — FULL DATA PIPELINE");
  console.log("========================================");
  console.log(`Дат найдено: ${dates.length}`);

  if (refreshMissing) {
    console.log("Режим: повторная подготовка существующих дат.");
  }

  console.log("");

  let skipped = 0;
  let completed = 0;

  for (let index = 0; index < dates.length; index++) {
    const date = dates[index];

    const sourceFile = path.join(DATA_DIR, `${date}.json`);
    const aiFile = path.join(AI_DIR, `${date}.json`);
    const preparedFile = path.join(PREPARED_DIR, `${date}.json`);

    console.log("\n\n========================================");
    console.log(`[${index + 1}/${dates.length}] ${date}`);
    console.log("========================================");

    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Не найден исходный файл: ${sourceFile}`);
    }

    if (fs.existsSync(preparedFile)) {
      validatePreparedFile(preparedFile);

      if (!refreshMissing) {
        console.log("✓ Уже подготовлено — пропускаем.");
        skipped++;
        continue;
      }

      console.log(
        "↻ Повторная подготовка: проверяем отсутствующие обложки и фото."
      );
    }

    if (!fs.existsSync(aiFile)) {
      runScript("extract-today-music.cjs", date);
    } else {
      console.log("✓ Gemini + MusicBrainz уже обработаны.");
    }

    if (!fs.existsSync(aiFile)) {
      throw new Error(`AI-файл не создан: ${aiFile}`);
    }

    validateAiFile(aiFile);

    runScript("prepare-today.cjs", date);

    if (!fs.existsSync(preparedFile)) {
      throw new Error(`Prepared-файл не создан: ${preparedFile}`);
    }

    validatePreparedFile(preparedFile);

    console.log(`\n✓ ${date} успешно обработан.`);
    completed++;
  }

  console.log("\n\n========================================");
  console.log("ОБРАБОТКА ЗАВЕРШЕНА");
  console.log("========================================");
  console.log(`Уже было готово: ${skipped}`);
  console.log(`Обработано сейчас: ${completed}`);
  console.log(`Всего проверено: ${dates.length}`);
}

try {
  main();
} catch (error) {
  console.error("\nОШИБКА PIPELINE:");
  console.error(error.message);
  console.error("\nИсправь проблему и запусти скрипт повторно.");
  process.exit(1);
}
