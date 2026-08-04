/**
 * Фид отдаёт числа одного сайта наружу, за пределы Access. Эти тесты про то, что он не отдаёт
 * ничего сверх — потому что цена ошибки здесь не «неверная цифра», а чужие данные.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalisePath, sourceForKey } from "../src/feed";

describe("who a key belongs to", () => {
  const keys = "miralinka:abc123,rustman:def456";

  it("maps each key to its own source and nothing else", () => {
    expect(sourceForKey(keys, "abc123")).toBe("miralinka");
    expect(sourceForKey(keys, "def456")).toBe("rustman");
  });

  it("refuses a prefix — a key that matches by its beginning is a guess, not a match", () => {
    expect(sourceForKey(keys, "abc")).toBeUndefined();
    expect(sourceForKey(keys, "abc1234")).toBeUndefined();
  });

  it("refuses empty everything rather than defaulting to the first source", () => {
    expect(sourceForKey(keys, "")).toBeUndefined();
    expect(sourceForKey(keys, undefined)).toBeUndefined();
    expect(sourceForKey(undefined, "abc123")).toBeUndefined();
    expect(sourceForKey("", "abc123")).toBeUndefined();
    // Пара без ключа не должна открывать источник пустой строкой.
    expect(sourceForKey("miralinka:", "")).toBeUndefined();
  });
});

describe("one shape of a path", () => {
  it("reduces a Search Console URL to the path our slot holds", () => {
    expect(normalisePath("https://miralinka.com/turkey/slug")).toBe("/turkey/slug");
    expect(normalisePath("https://www.miralinka.com/turkey/slug")).toBe("/turkey/slug");
  });

  it("folds the markdown twin onto the page it is a twin of", () => {
    // Иначе одна статья разъезжается на две строки: у одной показы, у другой просмотры.
    expect(normalisePath("/turkey/slug.md")).toBe("/turkey/slug");
    expect(normalisePath("https://miralinka.com/turkey/slug.md")).toBe("/turkey/slug");
  });

  it("drops a trailing slash everywhere except the root", () => {
    expect(normalisePath("/about/")).toBe("/about");
    expect(normalisePath("https://miralinka.com/")).toBe("/");
    expect(normalisePath("https://miralinka.com")).toBe("/");
  });

  it("drops query and hash, which the store never had anyway", () => {
    expect(normalisePath("https://miralinka.com/a?utm_source=x")).toBe("/a");
    expect(normalisePath("/a#top")).toBe("/a");
  });
});

describe("the endpoint", () => {
  it("answers 404 without a key — never 401, which would confirm it exists", async () => {
    expect((await SELF.fetch("https://analytics.example/feed")).status).toBe(404);
    expect((await SELF.fetch("https://analytics.example/feed?key=nope")).status).toBe(404);
  });

  it("answers for the source the key names, and takes no source parameter at all", async () => {
    const key = env.FEED_KEYS?.split(":")[1] ?? "";
    const res = await SELF.fetch(`https://analytics.example/feed?key=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; pages: unknown[] };
    // Подстановка чужого имени не должна ничего менять — параметра просто нет.
    const other = await SELF.fetch(`https://analytics.example/feed?key=${key}&source=superduperai`);
    expect(((await other.json()) as { source: string }).source).toBe(body.source);
    expect(body.source).toBe("miralinka");
  });

  it("stays outside the Access-protected prefix, or the admin could never reach it", async () => {
    // /v1/* отвечает 401 без ключа; фид обязан жить не там.
    expect((await SELF.fetch("https://analytics.example/v1/overview")).status).toBe(401);
  });
});
