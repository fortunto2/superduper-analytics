/**
 * Слоты для чисел: позиция важнее значения.
 *
 * Ошибка, от которой здесь защищаются, не в том, что метрика не посчитается — а в том, что она
 * посчитается неправильно и молча. Переставленные имена переименовывают три месяца истории;
 * ноль «не прислали» в среднем неотличим от нуля «прислали ноль»; имя из запроса, попавшее в
 * SQL без проверки, — это инъекция.
 */
import { describe, expect, it } from "vitest";
import { checkRegistry, MAX_METRICS, RegistryFile } from "../cli/registry";
import { METRIC_SLOTS, metricDoubles, metricSlot } from "../src/registry";
import { toDataPoint } from "../src/sinks/analytics-engine";
import { DOUBLE_SLOTS, MAX_DOUBLES, type EnrichedEvent } from "../src/schema";

const base: EnrichedEvent = {
  source: "facealarm",
  platform: "ios",
  name: "photo_taken",
  ua_kind: "app",
  ts: 1_787_356_471_844,
};

const registry = (metrics: string[]) =>
  RegistryFile.parse({
    sites: [{ id: "facealarm", url: "https://face-alarm.com" }],
    apps: [],
    metrics,
  });

describe("словарь метрик", () => {
  it("нумерует слоты после фиксированных, считая от 1", () => {
    const first = METRIC_SLOTS[0];
    if (first === undefined) throw new Error("реестр без метрик — тест потерял смысл");
    expect(metricSlot(first)).toBe(DOUBLE_SLOTS.length + 1);
  });

  it("не даёт слот имени, которого нет в реестре — это не ошибка, а «только в JSON»", () => {
    expect(metricSlot("render_seconds_that_nobody_registered")).toBeUndefined();
  });

  it("помещается в бюджет doubles с учётом занятых фиксированными", () => {
    expect(METRIC_SLOTS.length).toBeLessThanOrEqual(MAX_DOUBLES - DOUBLE_SLOTS.length);
    expect(MAX_METRICS).toBe(MAX_DOUBLES - 1);
  });
});

describe("запись в слоты", () => {
  it("кладёт значение на позицию своего имени, а не в порядке присылки", () => {
    const [second, first] = [METRIC_SLOTS[1], METRIC_SLOTS[0]];
    if (first === undefined || second === undefined) throw new Error("нужно две метрики в реестре");
    // Порядок ключей в объекте намеренно обратный порядку слотов.
    const doubles = metricDoubles({ [second]: 22, [first]: 11 });
    expect(doubles[0]).toBe(11);
    expect(doubles[1]).toBe(22);
  });

  it("отсутствующая метрика становится нулём, а не дыркой в массиве", () => {
    const doubles = metricDoubles(undefined);
    expect(doubles).toHaveLength(METRIC_SLOTS.length);
    expect(doubles.every((v) => v === 0)).toBe(true);
  });

  it("длина doubles одинакова у события с метриками и без — форма строки не зависит от содержимого", () => {
    const withMetrics = toDataPoint({ ...base, metrics: { [METRIC_SLOTS[0] ?? "x"]: 243 } });
    const without = toDataPoint(base);
    expect(withMetrics.doubles).toHaveLength(DOUBLE_SLOTS.length + METRIC_SLOTS.length);
    expect(without.doubles?.length).toBe(withMetrics.doubles?.length);
  });

  it("собственное время события остаётся на первой позиции", () => {
    expect(toDataPoint({ ...base, metrics: { [METRIC_SLOTS[0] ?? "x"]: 1 } }).doubles?.[0]).toBe(base.ts);
  });

  it("метрика без слота не ломает запись и просто не попадает в doubles", () => {
    const point = toDataPoint({ ...base, metrics: { unregistered_thing: 999 } });
    expect(point.doubles?.slice(DOUBLE_SLOTS.length).every((v) => v === 0)).toBe(true);
  });
});

describe("append-only в реестре", () => {
  const committed = ["days_since_first", "items_total"];

  it("пропускает дописывание в конец", () => {
    expect(checkRegistry(registry([...committed, "render_seconds"]), committed)).toEqual([]);
  });

  it("ловит перестановку — она переименовывает историю молча", () => {
    const problems = checkRegistry(registry(["items_total", "days_since_first"]), committed);
    expect(problems.join(" ")).toContain("position 1 changed");
  });

  it("ловит удаление: значения в double остаются, а имя к ним теряется", () => {
    const problems = checkRegistry(registry(["days_since_first"]), committed);
    expect(problems.join(" ")).toContain("removed from position 2");
  });

  it("ловит дубликат имени", () => {
    const problems = checkRegistry(registry(["days_since_first", "days_since_first"]), undefined);
    expect(problems.join(" ")).toContain("duplicate");
  });

  it("без сгенерированного файла проверка порядка не выполняется — чистый клон должен собираться", () => {
    expect(checkRegistry(registry(["anything_at_all"]), undefined)).toEqual([]);
  });

  it("отвергает имя не в snake_case на уровне схемы", () => {
    expect(() => registry(["Days Since First"])).toThrow();
    expect(() => registry(["days-since-first"])).toThrow();
  });

  it("отвергает список длиннее, чем есть слотов", () => {
    const tooMany = Array.from({ length: MAX_METRICS + 1 }, (_, i) => `metric_${i}`);
    expect(() => registry(tooMany)).toThrow();
  });
});
