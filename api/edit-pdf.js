// Vercel serverless function: find & replace text in a PDF.
// POST { pdf: <base64>, replacements: [{ find, replace }], caseSensitive?: boolean }
// -> { pdf: <base64>, count: <number of replacements> }
//
// How it works: pdf.js reads the text with positions, pdf-lib paints a white box over each match and
// writes the replacement on top. Matches are found per LINE, so a phrase that pdf.js splits into
// several pieces ("08:00," + " Fri 14-Aug") is still found and replaced as one.
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const { pdf, replacements, caseSensitive } = req.body || {};
  if (typeof pdf !== "string" || !Array.isArray(replacements) || !replacements.length) {
    return res.status(400).json({ error: "Expected { pdf: base64, replacements: [{find, replace}] }" });
  }
  const rules = replacements.filter(r => r && typeof r.find === "string" && r.find);
  if (!rules.length) return res.status(400).json({ error: "No valid 'find' strings" });

  try {
    const bytes = Buffer.from(pdf, "base64");
    const result = await editPdf(bytes, rules, !!caseSensitive);
    return res.status(200).json({ pdf: Buffer.from(result.bytes).toString("base64"), count: result.count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to process PDF: " + err.message });
  }
};

async function editPdf(bytes, rules, caseSensitive) {
  // pdfjs-dist ships ESM-only in newer versions, so load it dynamically.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // On Vercel the worker file must be bundled explicitly (see vercel.json includeFiles) and pointed at by path.
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;

  const out = await PDFDocument.load(bytes);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const pages = out.getPages();
  let count = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const page = pages[p - 1];
    const items = content.items.filter(it => it.str && it.width > 0);
    for (const line of groupLines(items)) {
      // one string per line, with a map from every character back to the piece and offset it came from
      const chars = [];
      let text = "";
      line.forEach((it, k) => {
        if (k > 0) {
          const prev = line[k - 1], gap = it.transform[4] - (prev.transform[4] + prev.width);
          if (gap > charWidth(prev) * 0.25 && !text.endsWith(" ") && !it.str.startsWith(" ")) { text += " "; chars.push(null); }   // a visual gap is a space
        }
        for (let i = 0; i < it.str.length; i++) { chars.push({ it, i }); text += it.str[i]; }
      });
      const hay = caseSensitive ? text : text.toLowerCase();
      for (const { find, replace } of rules) {
        const needle = caseSensitive ? find : find.toLowerCase();
        let idx = hay.indexOf(needle);
        while (idx !== -1) {
          const span = spanOf(chars, idx, idx + needle.length);
          if (span) {
            const size = span.size;
            page.drawRectangle({ x: span.x0 - 0.5, y: span.y - size * 0.25, width: span.x1 - span.x0 + 1, height: size * 1.2, color: rgb(1, 1, 1) });
            const txt = String(replace == null ? "" : replace);
            if (txt) {
              const safe = txt.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");   // WinAnsi only
              // shrink the font a little if the replacement is wider than the space it replaces
              let fs = size; const room = span.x1 - span.x0;
              while (fs > 4 && font.widthOfTextAtSize(safe, fs) > room + size * 0.6) fs -= 0.5;
              page.drawText(safe, { x: span.x0, y: span.y, size: fs, font, color: rgb(0, 0, 0) });
            }
            count++;
          }
          idx = hay.indexOf(needle, idx + needle.length);
        }
      }
    }
  }
  return { bytes: await out.save(), count };
}

function charWidth(it) { return it.width / Math.max(1, it.str.length); }

// group pieces into visual lines: same baseline (within half the text height), ordered left to right
function groupLines(items) {
  const sorted = items.slice().sort((a, b) => (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));
  const lines = [];
  for (const it of sorted) {
    const y = it.transform[5], h = it.height || Math.abs(it.transform[3]) || 10;
    const line = lines.find(l => Math.abs(l.y - y) < h * 0.5);
    if (line) line.items.push(it); else lines.push({ y, items: [it] });
  }
  return lines.map(l => l.items.sort((a, b) => a.transform[4] - b.transform[4]));
}

// the box covered by characters [a, b) of a line: left edge of the first, right edge of the last
function spanOf(chars, a, b) {
  const first = chars.slice(a, b).find(c => c), last = chars.slice(a, b).reverse().find(c => c);
  if (!first || !last) return null;
  const x0 = first.it.transform[4] + charWidth(first.it) * first.i;
  const x1 = last.it.transform[4] + charWidth(last.it) * (last.i + 1);
  const size = first.it.height || Math.abs(first.it.transform[3]) || 12;
  return { x0, x1, y: first.it.transform[5], size };
}

module.exports.editPdf = editPdf;
module.exports.config = { api: { bodyParser: { sizeLimit: "4mb" } } };
