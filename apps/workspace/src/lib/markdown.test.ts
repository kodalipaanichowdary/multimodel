import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseInline, parseMarkdown } from "./markdown";
import { Markdown } from "../components/Markdown";

describe("parseMarkdown", () => {
  it("parses the mock report structure", () => {
    const src = "# Title\n\n**Task:** x\n\n## Plan\n1. **a** — b\n2. c\n\n- one\n- two\n\n> note\n";
    expect(parseMarkdown(src).map((b) => b.t)).toEqual(["h", "p", "h", "ol", "ul", "quote"]);
  });

  it("fenced code is literal", () => {
    const [b] = parseMarkdown("```\n**not bold**\n<b>x</b>\n```");
    expect(b).toEqual({ t: "pre", v: "**not bold**\n<b>x</b>" });
  });

  it("inline: code, strong, em, safe links only", () => {
    expect(parseInline("a `c` **b** *i*").map((n) => n.t)).toEqual(["text", "code", "text", "strong", "text", "em"]);
    expect(parseInline("[x](https://e.com)")[0]).toMatchObject({ t: "link", href: "https://e.com" });
    expect(parseInline("[x](javascript:alert(1))").every((n) => n.t === "text")).toBe(true);
  });
});

describe("Markdown render", () => {
  it("never emits raw HTML from content", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: "<script>alert(1)</script>\n\n# <img src=x onerror=1>" }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders headings and lists as elements", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: "# Report\n\n- a\n- b" }));
    expect(html).toMatch(/<h1[^>]*>Report<\/h1>/);
    expect(html.match(/<li>/g)).toHaveLength(2);
  });
});
