/**
 * Разбор отчёта Apple. Формат взят с живого файла, скачанного по API 2026-08-26, а не из
 * документации: колонок там четырнадцать, и половина к делу не относится.
 *
 * Опасность здесь одна и тихая — перепутать переустановку с установкой. Обе приходят событием
 * `Install` и различаются только колонкой `Download Type`; сложенные вместе, они превращают
 * возвращённого пользователя в нового и завышают приток ровно настолько, насколько продукт
 * переустанавливают.
 */
import { describe, expect, it } from "vitest";
import { appleError, parseDownloads, parseInstallDeletion } from "../src/stores/analytics-reports";

const HEADER =
  "Date\tApp Name\tApp Apple Identifier\tEvent\tDownload Type\tApp Version\tDevice\t" +
  "Platform Version\tSource Type\tPage Type\tApp Download Date\tTerritory\tCounts\tUnique Devices";

const row = (day: string, event: string, type: string, territory: string, counts: number) =>
  [day, "Life2Film", "6761656888", event, type, "1.4", "iPhone", "iOS 26.6", "App referrer",
   "Store sheet", day, territory, String(counts), String(counts)].join("\t");

const tsv = (...rows: string[]) => [HEADER, ...rows].join("\n");

describe("parseInstallDeletion", () => {
  it("установки отсюда не берёт — их отдаёт отчёт загрузок, где приватность режет меньше", () => {
    // У life2film за месяц: 15 из 34 дневных файлов этого отчёта пустые, 75 первых установок
    // против ~74 за одну неделю в App Downloads. Брать установки отсюда — занижать их в разы.
    const { rows, skipped } = parseInstallDeletion(
      tsv(
        row("2026-10-21", "Install", "First-time download", "US", 2),
        row("2026-10-21", "Install", "Manual update", "US", 30),
        row("2026-10-21", "Delete", "", "US", 1),
      ),
      "life2film",
    );
    expect(rows).toEqual([expect.objectContaining({ metric: "deletes", value: 1 })]);
    expect(skipped).toBe(0);
  });

  it("забирает удаления — то, чего в наших событиях нет и быть не может", () => {
    const { rows } = parseInstallDeletion(tsv(row("2026-08-17", "Delete", "", "MA", 1)), "life2film");
    expect(rows).toEqual([
      {
        day: "2026-08-17",
        source: "life2film",
        provider: "appstore",
        metric: "deletes",
        campaign: "",
        country: "MA",
        value: 1,
      },
    ]);
  });

  it("держит дни раздельно — это суточная таблица, а не итог за период", () => {
    const { rows } = parseInstallDeletion(
      tsv(
        row("2026-08-17", "Delete", "", "US", 1),
        row("2026-08-18", "Delete", "", "US", 1),
      ),
      "life2film",
    );
    expect(rows.map((r) => r.day).sort()).toEqual(["2026-08-17", "2026-08-18"]);
  });

  it("читает колонки по имени, а не по позиции — Apple их дописывает", () => {
    // Те же данные, но колонки переставлены и добавлена новая.
    const shuffled = [
      "Territory\tCounts\tEvent\tDate\tDownload Type\tSomething New",
      "US\t7\tDelete\t2026-08-17\t\tvalue",
    ].join("\n");
    const { rows } = parseInstallDeletion(shuffled, "life2film");
    expect(rows[0]).toMatchObject({ metric: "deletes", value: 7, country: "US" });
  });

  it("падает, если исчезла колонка, без которой строка бессмысленна", () => {
    expect(() => parseInstallDeletion("App Name\tCounts\nLife2Film\t5", "life2film")).toThrow();
  });

  it("считает незнакомое событие пропущенным, а не роняет прогон", () => {
    const { rows, skipped } = parseInstallDeletion(
      tsv(
        row("2026-08-17", "SomethingApplAdded", "", "US", 9),
        row("2026-08-17", "Delete", "", "US", 1),
      ),
      "life2film",
    );
    expect(skipped).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("пропускает строку с нечисловым счётчиком вместо того, чтобы записать NaN", () => {
    const broken = [HEADER, row("2026-08-17", "Delete", "", "US", 1).replace(/\t1\t1$/, "\t-\t-")].join("\n");
    const { rows, skipped } = parseInstallDeletion(broken, "life2film");
    expect(rows).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("переживает пустой файл и файл из одного заголовка", () => {
    expect(parseInstallDeletion("", "life2film").rows).toEqual([]);
    expect(parseInstallDeletion(HEADER, "life2film").rows).toEqual([]);
  });
});

const DL_HEADER =
  "Date\tApp Name\tApp Apple Identifier\tDownload Type\tApp Version\tDevice\tPlatform Version\t" +
  "Source Type\tPage Type\tPre-Order\tTerritory\tCounts";

const dl = (day: string, type: string, territory: string, counts: number) =>
  [day, "Life2Film", "6761656888", type, "1.14", "iPhone", "iOS 26.6", "App Store search",
   "Product page", "", territory, String(counts)].join("\t");

describe("parseDownloads", () => {
  it("разделяет первую установку и переустановку", () => {
    const { rows } = parseDownloads(
      [DL_HEADER, dl("2026-10-21", "First-time download", "US", 3), dl("2026-10-21", "Redownload", "US", 2)].join("\n"),
      "life2film",
    );
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r.value]));
    expect(byMetric).toEqual({ installs: 3, redownloads: 2 });
  });

  it("не считает обновление установкой — у life2film 1.14 так дала 151 «установку» за неделю", () => {
    const { rows, skipped } = parseDownloads(
      [
        DL_HEADER,
        dl("2026-10-21", "First-time download", "US", 2),
        dl("2026-10-21", "Manual update", "US", 30),
        dl("2026-10-21", "Auto-update", "US", 40),
        dl("2026-10-21", "Auto-download", "US", 1),
        dl("2026-10-21", "Restore", "US", 1),
      ].join("\n"),
      "life2film",
    );
    expect(rows).toEqual([expect.objectContaining({ metric: "installs", value: 2, provider: "appstore" })]);
    expect(skipped).toBe(0);
  });

  it("суммирует строки одного дня и страны: Apple режет их по устройству, версии и источнику", () => {
    const { rows } = parseDownloads(
      [
        DL_HEADER,
        dl("2026-10-21", "First-time download", "US", 1),
        dl("2026-10-21", "First-time download", "US", 4),
        dl("2026-10-21", "First-time download", "FR", 2),
      ].join("\n"),
      "life2film",
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.country === "US")?.value).toBe(5);
  });

  it("незнакомый тип загрузки пропускает со счётом", () => {
    const { rows, skipped } = parseDownloads([DL_HEADER, dl("2026-10-21", "Beamed from Mars", "US", 1)].join("\n"), "life2film");
    expect(rows).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("падает без колонки типа: без неё установку не отличить от обновления", () => {
    expect(() => parseDownloads("Date\tTerritory\tCounts\n2026-10-21\tUS\t5", "life2film")).toThrow();
  });
});

describe("appleError", () => {
  it("сводит ответ Apple к коду и заголовку — сырой ответ съедал заметки всех приложений", () => {
    // Форма живого ответа 30.10.2026 на приложение чужой команды.
    const body = JSON.stringify(
      { errors: [{ id: "71760a24", status: "403", code: "FORBIDDEN_ERROR",
        title: "This request is forbidden for security reasons", detail: "The API key in use does not allow this request" }] },
      null, 2,
    );
    expect(appleError(body)).toBe("FORBIDDEN_ERROR: This request is forbidden for security reasons");
  });

  it("не-JSON отдаёт одной короткой строкой", () => {
    expect(appleError("<html>\n  <body>502 Bad Gateway</body>\n</html>")).toBe(
      "<html> <body>502 Bad Gateway</body> </html>",
    );
    expect(appleError("x".repeat(500))).toHaveLength(120);
  });
});
