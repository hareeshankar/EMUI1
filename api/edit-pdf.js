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
    const srcPage = await doc.getPage(p);
    const content = await srcPage.getTextContent();
    const paint = await readPaint(srcPage, pdfjs.OPS);   // filled shapes and text colours, so the patch can match them
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
      const done = [];   // character ranges already replaced on this line, so overlapping rules don't patch twice
      for (const { find, replace } of rules) {
        const needle = caseSensitive ? find : find.toLowerCase();
        let idx = hay.indexOf(needle);
        while (idx !== -1) {
          const overlaps = done.some(([a, b]) => idx < b && idx + needle.length > a);
          const span = overlaps ? null : spanOf(chars, idx, idx + needle.length, font);
          if (span) {
            done.push([idx, idx + needle.length]);
            const size = span.size;
            const shape = shapeAt(paint.fills, (span.x0 + span.x1) / 2, span.y + size * 0.35);
            const bg = shape ? shape.color : [255, 255, 255];
            const fg = textColourAt(paint.texts, span.x0, span.y, size);
            const txt = String(replace == null ? "" : replace);
            const safe = txt.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");   // WinAnsi only
            // room for the new text: up to the next piece of text on the line, or the edge of the cell it sits in
            let limit = nextTextX(chars, idx + needle.length, font);
            if (shape) limit = Math.min(limit, shape.x1 - 0.5);
            let fs = size;
            while (fs > 4 && safe && font.widthOfTextAtSize(safe, fs) > limit - span.x0) fs -= 0.5;
            const tw = safe ? font.widthOfTextAtSize(safe, fs) : 0;
            // the patch covers the old text and the new text, and never goes beyond the shape it sits on
            let r = { x0: span.x0 - 0.5, x1: Math.max(span.x1, span.x0 + tw) + 0.5, y0: span.y - size * 0.25, y1: span.y + size * 0.95 };
            if (shape) r = { x0: Math.max(r.x0, shape.x0), x1: Math.min(r.x1, shape.x1), y0: Math.max(r.y0, shape.y0), y1: Math.min(r.y1, shape.y1) };
            if (r.x1 > r.x0 && r.y1 > r.y0) page.drawRectangle({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, color: rgb(bg[0] / 255, bg[1] / 255, bg[2] / 255) });
            if (safe) page.drawText(safe, { x: span.x0, y: span.y, size: fs, font, color: rgb(fg[0] / 255, fg[1] / 255, fg[2] / 255) });
            count++;
          }
          idx = hay.indexOf(needle, idx + needle.length);
        }
      }
    }
  }
  return { bytes: await out.save(), count };
}

// Walk the page's drawing instructions and note (a) every filled shape with its colour and box, in paint order,
// and (b) where each piece of text starts and what colour it was drawn in.
async function readPaint(srcPage, OPS) {
  const ol = await srcPage.getOperatorList();
  const fills = [], texts = [];
  let ctm = [1, 0, 0, 1, 0, 0], fill = [0, 0, 0], tm = [1, 0, 0, 1, 0, 0], pending = null;
  const stack = [];
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save) stack.push({ ctm, fill });
    else if (fn === OPS.restore) { const s = stack.pop(); if (s) { ctm = s.ctm; fill = s.fill; } }
    else if (fn === OPS.transform) ctm = mul(a, ctm);
    else if (fn === OPS.setFillRGBColor) fill = typeof a === "string" ? hexToRgb(a) : [a[0], a[1], a[2]];
    else if (fn === OPS.constructPath) {
      const mm = a[2];
      if (mm && mm.length === 4 && isFinite(mm[0])) {
        const c = [pt(ctm, mm[0], mm[1]), pt(ctm, mm[2], mm[3]), pt(ctm, mm[0], mm[3]), pt(ctm, mm[2], mm[1])];
        pending = { x0: Math.min(...c.map(q => q[0])), y0: Math.min(...c.map(q => q[1])), x1: Math.max(...c.map(q => q[0])), y1: Math.max(...c.map(q => q[1])) };
      } else pending = null;
    }
    else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke) {
      if (pending) fills.push({ ...pending, color: fill });
      pending = null;
    }
    else if (fn === OPS.endPath || fn === OPS.stroke || fn === OPS.closeStroke) pending = null;
    else if (fn === OPS.beginText) tm = [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.setTextMatrix) tm = a.slice ? Array.from(a) : a;
    else if (fn === OPS.moveText) tm = [tm[0], tm[1], tm[2], tm[3], tm[0] * a[0] + tm[2] * a[1] + tm[4], tm[1] * a[0] + tm[3] * a[1] + tm[5]];
    else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const o = pt(mul(tm, ctm), 0, 0);
      texts.push({ x: o[0], y: o[1], color: fill });
    }
  }
  return { fills, texts };
}

// the topmost filled shape under a point (its box and colour); null if nothing is painted there
function shapeAt(fills, x, y) {
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i];
    if (x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) return f;
  }
  return null;
}

// where the next piece of text after character index b begins on this line (Infinity if the match ends the line)
function nextTextX(chars, b, font) {
  for (let i = b; i < chars.length; i++) {
    const c = chars[i]; if (!c) continue;
    if (c.it.str[c.i] === " ") continue;
    return c.it.transform[4] + offsetIn(c.it, c.i, font) - charWidth(c.it) * 0.3;
  }
  return Infinity;
}

// colour of the text run that starts nearest to (left of) the match on the same baseline; black if unknown
function textColourAt(texts, x, y, size) {
  let best = null, bestDx = Infinity;
  for (const t of texts) {
    if (Math.abs(t.y - y) > size * 0.5) continue;
    const dx = x - t.x;
    if (dx >= -1 && dx < bestDx) { bestDx = dx; best = t; }
  }
  return best ? best.color : [0, 0, 0];
}

function hexToRgb(h) { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

function offsetIn(it, n, font) {
  const safe = t => t.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
  try {
    const whole = font.widthOfTextAtSize(safe(it.str), 10);
    if (whole > 0) return it.width * font.widthOfTextAtSize(safe(it.str.slice(0, n)), 10) / whole;
  } catch (e) { /* fall back to even spacing */ }
  return charWidth(it) * n;
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
// Character positions use proportional widths (a "1" is narrower than an "M"), scaled to the piece's real width.
function spanOf(chars, a, b, font) {
  const first = chars.slice(a, b).find(c => c), last = chars.slice(a, b).reverse().find(c => c);
  if (!first || !last) return null;
  const x0 = first.it.transform[4] + offsetIn(first.it, first.i, font);
  const x1 = last.it.transform[4] + offsetIn(last.it, last.i + 1, font);
  const size = first.it.height || Math.abs(first.it.transform[3]) || 12;
  return { x0, x1, y: first.it.transform[5], size };
}

module.exports.editPdf = editPdf;
module.exports.config = { api: { bodyParser: { sizeLimit: "4mb" } } };
