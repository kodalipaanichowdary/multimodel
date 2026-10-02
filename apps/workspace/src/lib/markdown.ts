/**
 * Minimal markdown -> AST. Rendered as React elements (never innerHTML), so
 * artifact content cannot inject markup. Supports: # headings, paragraphs,
 * - / 1. lists, > quotes, ``` fences, `code`, **bold**, *italic*, [text](http…).
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "pre"; v: string };

const SAFE_URL = /^https?:\/\//i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({ t: "code", v: m[1] });
    } else if ((m = rest.match(/^\*\*(.+?)\*\*/))) {
      flush();
      out.push({ t: "strong", c: parseInline(m[1]) });
    } else if ((m = rest.match(/^\*([^*\s][^*]*?)\*/))) {
      flush();
      out.push({ t: "em", c: parseInline(m[1]) });
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/)) && SAFE_URL.test(m[2])) {
      flush();
      out.push({ t: "link", href: m[2], c: parseInline(m[1]) });
    } else {
      buf += src[i];
      i++;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if (line.startsWith("```")) {
      flushPara();
      const body: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) body.push(lines[i]);
      blocks.push({ t: "pre", v: body.join("\n") });
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara();
      blocks.push({ t: "h", level: m[1].length as 1 | 2 | 3, c: parseInline(m[2]) });
    } else if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+\./.test(line);
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items: Inline[][] = [];
      while (i < lines.length && (m = lines[i].match(re))) {
        items.push(parseInline(m[1]));
        i++;
      }
      i--;
      blocks.push({ t: ordered ? "ol" : "ul", items });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      blocks.push({ t: "quote", c: parseInline(m[1]) });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line.trim());
    }
  }
  flushPara();
  return blocks;
}
