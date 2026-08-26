/**
 * Граф сети. Ошибка здесь тихая ровно одна: не узнать своих.
 *
 * `www.` перед хостом, лишний регистр, переход внутри одного продукта — каждое из этих трёх
 * либо теряет ребро совсем, либо рисует несуществующее. Пустой граф при этом выглядит как
 * честный ответ «сеть не кормит себя», а не как сломанное сопоставление.
 */
import { describe, expect, it } from "vitest";
import {
  buildReferrerQuery,
  buildStoreClickQuery,
  fetchNetwork,
  hostIndex,
  parseEdges,
  parseStoreClicks,
} from "../src/network";
import { RETENTION_DAYS } from "../src/schema";

const env = { DATASET: "superduper_events", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };
const index = new Map([
  ["miralinka.com", "miralinka"],
  ["carettafriends.com", "turtle-careta"],
]);
const payload = (rows: { target: string; ref: string; views: number }[]) => ({ data: rows });

describe("hostIndex", () => {
  it("строится из реестра, поэтому новый сайт попадает в граф без правки кода", () => {
    const built = hostIndex();
    expect(built.size).toBeGreaterThan(5);
    expect(built.get("life2film.com")).toBe("life2film");
  });

  it("хранит хосты без www — какой из вариантов отдаёт сайт, аналитику не касается", () => {
    for (const host of hostIndex().keys()) expect(host.startsWith("www.")).toBe(false);
  });
});

describe("parseEdges", () => {
  it("узнаёт свой сайт в реферере и делает из него ребро", () => {
    const edges = parseEdges(payload([{ target: "turtle-careta", ref: "miralinka.com", views: 5 }]), index);
    expect(edges).toEqual([{ from: "miralinka", to: "turtle-careta", views: 5 }]);
  });

  it("узнаёт свой сайт с www и в верхнем регистре", () => {
    const edges = parseEdges(payload([{ target: "turtle-careta", ref: "WWW.Miralinka.com", views: 2 }]), index);
    expect(edges[0]?.from).toBe("miralinka");
  });

  it("выбрасывает чужие источники — граф про нас, а не про Google", () => {
    const edges = parseEdges(payload([{ target: "miralinka", ref: "www.google.com", views: 502 }]), index);
    expect(edges).toEqual([]);
  });

  it("выбрасывает переход внутри одного продукта: это навигация, а не переток", () => {
    const edges = parseEdges(payload([{ target: "miralinka", ref: "miralinka.com", views: 40 }]), index);
    expect(edges).toEqual([]);
  });

  it("сортирует по весу — сверху то, что реально работает", () => {
    const edges = parseEdges(
      payload([
        { target: "turtle-careta", ref: "miralinka.com", views: 2 },
        { target: "miralinka", ref: "carettafriends.com", views: 9 },
      ]),
      index,
    );
    expect(edges.map((e) => e.views)).toEqual([9, 2]);
  });

  it("переживает пустой и битый ответ", () => {
    expect(parseEdges(null, index)).toEqual([]);
    expect(parseEdges({ data: "nope" }, index)).toEqual([]);
  });
});

describe("parseStoreClicks", () => {
  it("различает магазины по имени события, а не по догадке о платформе", () => {
    const clicks = parseStoreClicks({
      data: [
        { source: "turtle-careta", name: "app_store_opened", placement: "hero", clicks: 4 },
        { source: "turtle-careta", name: "play_store_opened", placement: "home", clicks: 1 },
      ],
    });
    expect(clicks.map((c) => c.store)).toEqual(["appstore", "play"]);
    expect(clicks[0]?.placement).toBe("hero");
  });
});

describe("SQL", () => {
  const sql = buildReferrerQuery("superduper_events", 28);

  it("считает только просмотры: цель с рефером — то же посещение, посчитанное дважды", () => {
    expect(sql).toContain("blob3 = 'page_viewed'");
  });

  it("weights by the sample interval and excludes bots", () => {
    expect(sql).toContain("sum(_sample_interval) AS views");
    expect(sql).toContain("blob9 != 'bot'");
  });

  it("НЕ вписывает наши хосты в запрос — иначе он разъедется с реестром", () => {
    expect(sql).not.toContain("miralinka");
    expect(sql).not.toContain("IN (");
  });

  it("берёт оба магазина одним запросом", () => {
    const store = buildStoreClickQuery("superduper_events", 7);
    expect(store).toContain("app_store_opened");
    expect(store).toContain("play_store_opened");
    expect(store).toContain("blob15 AS placement");
  });

  it("отказывается от окна за пределами хранения", () => {
    expect(() => buildReferrerQuery("d", RETENTION_DAYS + 1)).toThrow();
    expect(() => buildStoreClickQuery("d", 0)).toThrow();
  });
});

describe("fetchNetwork", () => {
  it("говорит, что не настроен, вместо вызова API без токена", async () => {
    const result = await fetchNetwork({ DATASET: "d" }, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("not_configured");
  });

  it("отказывает в окне длиннее срока хранения", async () => {
    const result = await fetchNetwork(env, RETENTION_DAYS + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("beyond_retention");
  });
});
