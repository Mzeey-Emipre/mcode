import { describe, it, expect } from "vitest";
import { extractThreadSources } from "../lib/message-sources";

type Msg = { role: "user" | "assistant"; content: string };

const msg = (role: Msg["role"], content: string): Msg => ({ role, content });

describe("extractThreadSources", () => {
  it("collects assistant links and derives HTTPS favicons", () => {
    const sources = extractThreadSources([
      msg("assistant", "See https://github.com/milex-consulting/CaravanFE for the repo."),
    ]);
    expect(sources).toEqual([
      {
        url: "https://github.com/milex-consulting/CaravanFE",
        faviconUrl: "https://github.com/favicon.ico",
      },
    ]);
  });

  it("ignores user-pasted links", () => {
    const sources = extractThreadSources([
      msg("user", "https://example.com/from-user"),
      msg("assistant", "Try https://example.com/from-assistant"),
    ]);
    expect(sources.map((s) => s.url)).toEqual(["https://example.com/from-assistant"]);
  });

  it("dedupes by full URL in first-seen order", () => {
    const sources = extractThreadSources([
      msg("assistant", "https://a.com/x and https://b.com/y"),
      msg("assistant", "again https://a.com/x"),
    ]);
    expect(sources.map((s) => s.url)).toEqual(["https://a.com/x", "https://b.com/y"]);
  });

  it("strips trailing prose punctuation from URLs", () => {
    const sources = extractThreadSources([msg("assistant", "Open https://example.com/page.")]);
    expect(sources[0].url).toBe("https://example.com/page");
  });

  it("returns null favicon for http (non-HTTPS) hosts", () => {
    const sources = extractThreadSources([msg("assistant", "http://insecure.test/path")]);
    expect(sources[0]).toEqual({ url: "http://insecure.test/path", faviconUrl: null });
  });

  it("ignores non-http schemes", () => {
    const sources = extractThreadSources([
      msg("assistant", "mailto:x@y.com and ftp://z.com and javascript:alert(1)"),
    ]);
    expect(sources).toEqual([]);
  });

  it("bounds the result to 32 sources", () => {
    const links = Array.from({ length: 50 }, (_, i) => `https://example.com/${i}`).join(" ");
    const sources = extractThreadSources([msg("assistant", links)]);
    expect(sources).toHaveLength(32);
  });
});
