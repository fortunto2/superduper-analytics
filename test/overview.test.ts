import { describe, expect, it } from "vitest";
import { domainFamily } from "../src/overview";

describe("группировка доменов", () => {
  it("сводит поддомены к одной семье", () => {
    expect(domainFamily("books.superduperai.co")).toBe("superduperai.co");
    expect(domainFamily("marafon.miralinka.com")).toBe("miralinka.com");
    expect(domainFamily("app.carettafriends.com")).toBe("carettafriends.com");
  });

  it("оставляет домен второго уровня как есть", () => {
    expect(domainFamily("rustman.org")).toBe("rustman.org");
    expect(domainFamily("akbuzat.net")).toBe("akbuzat.net");
  });

  it("не путает разные продукты на одном суффиксе", () => {
    expect(domainFamily("life2film.com")).not.toBe(domainFamily("miralinka.com"));
  });
});
