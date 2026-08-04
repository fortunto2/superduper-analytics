/**
 * Фид отдаёт числа одного сайта в чужую админку. Проверяется главное: наружу он не торчит
 * вовсе, а пути из двух источников сходятся в один.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalisePath } from "../src/feed";

describe("наружу фида нет", () => {
  it("по HTTP его нет ни на каком адресе — он живёт только в привязке сервиса", async () => {
    // Первая версия была GET /feed с ключом. Ключ убран вместе с эндпоинтом: то, чего нет,
    // нельзя ни подобрать, ни забыть отозвать.
    expect((await SELF.fetch("https://analytics.example/feed")).status).toBe(404);
    expect((await SELF.fetch("https://analytics.example/feed?source=miralinka")).status).toBe(404);
  });

  it("и не появился под ключевым префиксом, где его достал бы Access, но не чужой сервер", async () => {
    expect((await SELF.fetch("https://analytics.example/v1/feed")).status).toBe(401);
  });
});

describe("один вид пути для склейки", () => {
  it("сводит адрес из Search Console к пути, который лежит в нашем слоте", () => {
    expect(normalisePath("https://miralinka.com/turkey/slug")).toBe("/turkey/slug");
    expect(normalisePath("https://www.miralinka.com/turkey/slug")).toBe("/turkey/slug");
  });

  it("схлопывает markdown-двойник на ту же страницу", () => {
    // Иначе одна статья разъезжается на две строки: у одной показы, у другой просмотры.
    expect(normalisePath("/turkey/slug.md")).toBe("/turkey/slug");
    expect(normalisePath("https://miralinka.com/turkey/slug.md")).toBe("/turkey/slug");
  });

  it("снимает хвостовой слэш везде, кроме корня", () => {
    expect(normalisePath("/about/")).toBe("/about");
    expect(normalisePath("https://miralinka.com/")).toBe("/");
    expect(normalisePath("https://miralinka.com")).toBe("/");
  });

  it("отбрасывает строку запроса и якорь, которых в хранилище и не было", () => {
    expect(normalisePath("https://miralinka.com/a?utm_source=x")).toBe("/a");
    expect(normalisePath("/a#top")).toBe("/a");
  });
});
