// Scraped postings arrive as HTML, escaped HTML, or plain text. Everything the app shows goes through here.
// Output is plain text with light markers the app renders: "## Heading", "- bullet", blank line between paragraphs.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", bull: "•",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", eacute: "é",
};

export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });

const TAG = /<\/?[a-z][^>]*>/i;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/i;

const stripHtml = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi, (_, t: string) => `\n\n## ${t.replace(/<[^>]+>/g, " ").trim()}\n\n`)
    .replace(/<\/?(?:b|i|u|em|strong|a|span|code|small|sub|sup|font|mark)\b[^>]*>/gi, "") // inline: no gap
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|header|footer|blockquote)\s*>/gi, "\n\n")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

/** Plain, readable text from scraped content. Idempotent: clean text comes back unchanged apart from whitespace. */
export const cleanText = (raw: string | undefined | null): string => {
  if (!raw) return "";
  let s = raw;
  // Descriptions are often HTML that was escaped once (or twice): decode until tags show up or nothing changes.
  for (let i = 0; i < 2 && !TAG.test(s) && ENTITY.test(s); i++) {
    const decoded = decodeEntities(s);
    if (decoded === s) break;
    s = decoded;
  }
  if (TAG.test(s)) s = stripHtml(s);
  s = decodeEntities(s);
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^- +(?=\n)/gm, "")
    .trim();
};

/** A short plain-text preview: no markers, one line of whitespace, cut at a word boundary. */
export const previewText = (raw: string | undefined | null, max = 240): string => {
  const flat = cleanText(raw).replace(/^(## |- )/gm, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30)).trimEnd() + "…";
};
