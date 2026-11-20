import { sanitizeHtml } from "./sanitize-html";

export type DetailTocItem = { id: string; label: string };

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Derive the in-page table of contents from rendered markdown, stamping a
 * stable `id` onto every `<h2>` so the TOC links and scroll-spy have anchors.
 *
 * Deterministic, so the ids match between the build-time render and client
 * hydration. Headings are read from the parsed tree because a `<` inside a
 * quoted attribute survives sanitizing and must stay attribute text.
 */
export function buildDetailToc(markdownHtml: string): {
  html: string;
  toc: DetailTocItem[];
} {
  if (!markdownHtml) return { html: markdownHtml, toc: [] };

  const toc: DetailTocItem[] = [];
  const used = new Map<string, number>();

  const html = sanitizeHtml(markdownHtml, undefined, (root) => {
    for (const heading of Array.from(root.querySelectorAll("h2"))) {
      const label = heading.textContent?.trim() ?? "";
      if (!label) continue;

      const existing = heading.getAttribute("id") || undefined;
      let id = existing ?? slugify(label);
      if (!id) continue;
      if (!existing) {
        const seen = used.get(id) ?? 0;
        used.set(id, seen + 1);
        if (seen > 0) id = `${id}-${seen}`;
        heading.setAttribute("id", id);
      }

      toc.push({ id, label });
    }
  });

  return { html, toc };
}
