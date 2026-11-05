import { describe, expect, it } from "vitest";
import { pageScope, propertyFor, searchBody, usableProperties } from "../src/search/console";

describe("a Search Console property wider than the site", () => {
  it("narrows a domain property to the site's own pages", () => {
    expect(pageScope("https://live2play.superduperai.co", "sc-domain:superduperai.co")).toBe(
      "://live2play.superduperai.co/",
    );
    // The apex site on its own domain property is narrowed too, or it keeps its subdomains.
    expect(pageScope("https://superduperai.co", "sc-domain:superduperai.co")).toBe("://superduperai.co/");
  });

  it("leaves an exact URL property alone, so clean sites keep property-level numbers", () => {
    expect(pageScope("https://life2film.com", "https://life2film.com/")).toBeUndefined();
  });

  it("keeps the path for a site that lives under one on a shared host", () => {
    expect(pageScope("https://fortunto2.github.io/pocketmap-site", "https://fortunto2.github.io/")).toBe(
      "://fortunto2.github.io/pocketmap-site/",
    );
  });

  it("does not let the apex scope catch a subdomain", () => {
    const scope = pageScope("https://superduperai.co", "sc-domain:superduperai.co")!;
    expect("https://live2play.superduperai.co/x".includes(scope)).toBe(false);
    expect("https://superduperai.co/tools/".includes(scope)).toBe(true);
  });

  it("filters by page even when grouping by query", () => {
    expect(searchBody("2026-11-01", "query", 100, "://rusty.superduperai.co/")).toMatchObject({
      dimensions: ["query"],
      dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: "://rusty.superduperai.co/" }] }],
    });
    expect(searchBody("2026-11-01", "query", 100)).not.toHaveProperty("dimensionFilterGroups");
  });
});

describe("properties the service account cannot read", () => {
  it("drops an unverified URL property so the working domain property is chosen", () => {
    const listed = usableProperties([
      { siteUrl: "https://airsignal.app/", permissionLevel: "siteUnverifiedUser" },
      { siteUrl: "sc-domain:airsignal.app", permissionLevel: "siteFullUser" },
    ]);
    expect(listed).toEqual(["sc-domain:airsignal.app"]);
    expect(propertyFor("https://airsignal.app", listed)).toBe("sc-domain:airsignal.app");
  });
});
