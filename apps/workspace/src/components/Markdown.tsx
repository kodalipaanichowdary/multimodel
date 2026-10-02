import { useMemo, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "../lib/markdown";

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return (
          <code key={i} className="rounded bg-white/10 px-1 font-mono text-[0.9em]">
            {n.v}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold text-slate-50">
            {inline(n.c)}
          </strong>
        );
      case "em":
        return <em key={i}>{inline(n.c)}</em>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">
            {inline(n.c)}
          </a>
        );
    }
  });
}

const H = ["text-base", "text-sm", "text-[13px]"] as const;

export function Markdown({ source, testid }: { source: string; testid?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-2 break-words text-[13px] leading-relaxed text-slate-300" data-testid={testid}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const Tag = `h${b.level}` as "h1" | "h2" | "h3";
            return (
              <Tag key={i} className={`${H[b.level - 1]} font-semibold text-slate-100`}>
                {inline(b.c)}
              </Tag>
            );
          }
          case "p":
            return <p key={i}>{inline(b.c)}</p>;
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-0.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal space-y-0.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-white/15 pl-3 text-slate-400">
                {inline(b.c)}
              </blockquote>
            );
          case "pre":
            return (
              <pre key={i} className="whitespace-pre-wrap break-words rounded bg-black/40 p-2 font-mono text-[12px]">
                {b.v}
              </pre>
            );
        }
      })}
    </div>
  );
}
