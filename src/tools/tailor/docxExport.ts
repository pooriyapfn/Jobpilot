import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

// Strips a leading/trailing ```markdown fence, which models sometimes add
// even when told to return raw markdown.
export const stripCodeFence = (markdown: string): string =>
  markdown
    .trim()
    .replace(/^```(?:markdown)?\n/, "")
    .replace(/\n```$/, "")
    .trim();

const parseInlineRuns = (text: string): TextRun[] => {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map(
    (part) =>
      new TextRun(
        part.startsWith("**") && part.endsWith("**")
          ? { text: part.slice(2, -2), bold: true }
          : { text: part },
      ),
  );
};

// Renders resume markdown into a single-column, plain-formatting .docx —
// no tables/text-boxes/columns/images, standard heading structure, so ATS
// parsers can read it the same way a human would.
export const markdownToDocx = (markdown: string): Promise<Buffer> => {
  const lines = stripCodeFence(markdown).split("\n");
  const children: Paragraph[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("### ")) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: line.slice(4).trim(), bold: true, size: 22 })],
          spacing: { before: 160, after: 60 },
        }),
      );
    } else if (line.startsWith("## ")) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: line.slice(3).trim().toUpperCase(), bold: true, size: 24, color: "000000" })],
          border: { bottom: { color: "999999", space: 2, style: "single", size: 6 } },
          spacing: { before: 280, after: 120 },
        }),
      );
    } else if (line.startsWith("# ")) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: line.slice(2).trim(), bold: true, size: 32 })],
          spacing: { after: 60 },
        }),
      );
    } else if (line.startsWith("* ") || line.startsWith("- ")) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: parseInlineRuns(line.slice(2).trim()),
          spacing: { after: 80 },
        }),
      );
    } else if (/^\*\*.+\*\*$/.test(line) && !line.slice(2, -2).includes("**")) {
      // A whole-line bold, e.g. "**Senior Software Engineer**" subtitle
      children.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: line.slice(2, -2), bold: true, size: 24 })],
          spacing: { after: 80 },
        }),
      );
    } else {
      children.push(
        new Paragraph({
          children: parseInlineRuns(line),
          spacing: { after: 100 },
        }),
      );
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 } },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
};
