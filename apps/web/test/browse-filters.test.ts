import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BrowsePage from "../src/app/(storefront)/browse/page";

async function browse(search: Record<string, string>) {
  const page = await BrowsePage({
    searchParams: Promise.resolve(search),
    params: Promise.resolve({}),
  });
  return { page, html: renderToStaticMarkup(page.props.children) };
}

function linkText(html: string, href: string) {
  const encoded = href.replaceAll("&", "&amp;");
  const anchor = html.split(`<a href="${encoded}"`)[1]?.split("</a>")[0];
  return anchor?.replace(/^[^>]*>/, "").replace(/<[^>]+>/g, "");
}

describe("buyer browse filter continuity", () => {
  it("keeps the submitted query available in the search box", async () => {
    const { page } = await browse({ q: "grain" });
    expect(page.props.searchQuery).toBe("grain");
  });

  it("counts categories and prices within the current search", async () => {
    const { html } = await browse({ q: "grain" });
    expect(linkText(html, "/browse?q=grain&category=Photography")).toBe("Photography1");
    expect(linkText(html, "/browse?q=grain&category=Audio")).toBe("Audio0");
    expect(linkText(html, "/browse?q=grain&price=under-30")).toBe("Under $301");
    expect(linkText(html, "/browse?q=grain&price=over-80")).toBe("Over $800");
  });

  it("keeps the other facet active when calculating a replacement filter", async () => {
    const { html } = await browse({ category: "Photography", price: "over-80" });
    expect(linkText(html, "/browse?category=Typography&price=over-80")).toBe("Typography1");
    expect(linkText(html, "/browse?category=Photography&price=under-30")).toBe("Under $301");
    expect(linkText(html, "/browse?category=Photography&price=30-to-80")).toBe("$30 to $800");
    expect(html).toContain("Nothing matches.");
  });

  it("shows no promised matches for an empty search and keeps the recovery link", async () => {
    const { html } = await browse({ q: "no-such-buyer-product" });
    expect(linkText(html, "/browse?q=no-such-buyer-product&category=Photography")).toBe(
      "Photography0",
    );
    expect(html).toContain('href="/browse">Clear the filters</a>');
  });
});
