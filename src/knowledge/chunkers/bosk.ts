/**
 * Structural chunker for trimstray/the-book-of-secret-knowledge.
 *
 * The repo is a single ~208KB README.md rather than a document tree, so the
 * generic ingester handles it badly twice over: it is skipped outright by
 * MAX_FILE_SIZE, and the fixed-width chunkText() would slice commands in half.
 *
 * Document structure:
 *   ####   Chapter   — "CLI Tools", "Networks", "Shell One-liners", ...
 *   #####  Section   — "Network (DNS)"  |  "Tool: [nmap](url)"
 *   ###### Entry     — one-liner description followed by a fenced bash block
 *
 * Emits two chunk shapes:
 *   toolset  — one per curated tool-link section, flattened to "Name - desc (url)"
 *   oneliner — one per description+command pair, the highest-value retrieval unit
 */

export type BoskChunkType = "toolset" | "oneliner";

export type BoskChunk = {
  id: string;
  text: string;
  metadata: {
    source: "the-book-of-secret-knowledge";
    type: BoskChunkType;
    chapter: string;
    section: string;
    tool: string | null;
    title: string;
    code: string | null;
    links: string[];
  };
};

/** Chapters that are navigation/meta rather than reference content. */
const SKIP_CHAPTERS = /table of contents|contributing|todo|rss feed/i;

/** Strip emoji shortcodes, TOC anchors, HTML entities and tags; collapse space. */
function clean(raw: string): string {
  return raw
    .replace(/\[<sup>.*?<\/sup>\]\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]\(#[^)]*\)/g, "")
    .replace(/:[a-z0-9_+-]+:/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<sup>.*?<\/sup>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/href="([^"]+)"/g)) out.add(m[1]);
  for (const m of raw.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) out.add(m[1]);
  return [...out];
}

/** Flatten a section's <a href><b>Name</b></a> - description list into text lines. */
function renderToolLines(raw: string): string {
  const lines: string[] = [];
  for (const m of raw.matchAll(/<a href="([^"]+)"><b>(.*?)<\/b><\/a>\s*-?\s*([^<]*)/g)) {
    const name = clean(m[2]);
    if (!name) continue;
    const desc = clean(m[3]);
    lines.push(desc ? `${name} - ${desc} (${m[1]})` : `${name} (${m[1]})`);
  }
  return lines.join("\n");
}

/**
 * Parse the BOSK README into retrieval-sized chunks.
 *
 * IDs are stable, content-independent strings so re-ingesting upserts in place
 * (KnowledgeStore hashes them to UUIDs) rather than accumulating duplicates.
 */
export function parseBosk(markdown: string): BoskChunk[] {
  const chunks: BoskChunk[] = [];

  let chapter = "";
  let section = "";
  let tool: string | null = null;
  let sectionBuf: string[] = [];
  let entryTitle: string | null = null;
  let entryBuf: string[] = [];

  const push = (
    type: BoskChunkType,
    title: string,
    body: string,
    code: string | null,
    links: string[],
  ): void => {
    if (!chapter || SKIP_CHAPTERS.test(chapter)) return;
    if (!body.trim() && !code) return;
    // Retrieval text carries its own breadcrumb so hits are self-describing.
    const heading = tool ? `${chapter} > ${tool} > ${title}` : `${chapter} > ${section}`;
    // For one-liners the body is the title, which the breadcrumb already carries.
    const trimmed = body.trim();
    const parts = heading.endsWith(trimmed) ? [heading, code] : [heading, trimmed, code];
    const text = parts.filter(Boolean).join("\n\n");
    chunks.push({
      id: `bosk::${type}::${chapter}::${section}::${title}`,
      text,
      metadata: {
        source: "the-book-of-secret-knowledge",
        type,
        chapter,
        section,
        tool,
        title,
        code,
        links,
      },
    });
  };

  const flushSection = (): void => {
    if (!sectionBuf.length) return;
    const raw = sectionBuf.join("\n");
    const body = renderToolLines(raw);
    if (body) push("toolset", section, body, null, extractLinks(raw));
    sectionBuf = [];
  };

  const flushEntry = (): void => {
    if (entryTitle === null) return;
    const raw = entryBuf.join("\n");
    const code = [...raw.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .map((m) => m[1].trimEnd())
      .join("\n");
    push("oneliner", entryTitle, entryTitle, code || null, extractLinks(raw));
    entryTitle = null;
    entryBuf = [];
  };

  for (const line of markdown.split("\n")) {
    if (line.startsWith("#### ") && !line.startsWith("##### ")) {
      flushEntry();
      flushSection();
      chapter = clean(line.slice(5));
      section = "";
      tool = null;
      continue;
    }

    if (line.startsWith("##### ") && !line.startsWith("###### ")) {
      flushEntry();
      flushSection();
      const heading = line.slice(6);
      const toolMatch = heading.match(/^Tool:\s*\[(.+?)\]/);
      tool = toolMatch ? toolMatch[1] : null;
      section = tool ?? clean(heading);
      continue;
    }

    if (line.startsWith("###### ")) {
      flushEntry();
      entryTitle = clean(line.slice(7));
      entryBuf = [];
      continue;
    }

    if (entryTitle !== null) entryBuf.push(line);
    else sectionBuf.push(line);
  }

  flushEntry();
  flushSection();

  return chunks;
}

/** Heuristic: is this file the BOSK README? Checked before the generic path. */
export function isBoskDocument(relPath: string, text: string): boolean {
  if (/book.?of.?secret.?knowledge/i.test(relPath)) return true;
  return text.includes("The Book of Secret Knowledge (Chapters)");
}
