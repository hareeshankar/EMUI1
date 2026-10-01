// Vercel serverless function: find & replace text in a PDF.
// POST { pdf: <base64>, replacements: [{ find, replace }], caseSensitive?: boolean }
// -> { pdf: <base64>, count: <number of replacements> }
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
    // pdfjs-dist ships ESM-only in newer versions, so load it dynamically.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // On Vercel the worker file must be bundled explicitly (see vercel.json includeFiles) and pointed at by path.
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      disableFontFace: true
    }).promise;

    const out = await PDFDocument.load(bytes);
    const font = await out.embedFont(StandardFonts.Helvetica);
    const pages = out.getPages();
    let count = 0;

    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      const page = pages[p - 1];
      for (const item of content.items) {
        if (!item.str || !item.width) continue;
        for (const { find, replace } of rules) {
          const hay = caseSensitive ? item.str : item.str.toLowerCase();
          const needle = caseSensitive ? find : find.toLowerCase();
          let idx = hay.indexOf(needle);
          while (idx !== -1) {
            const perChar = item.width / item.str.length;
            const x = item.transform[4] + perChar * idx;
            const y = item.transform[5];
            const w = perChar * find.length;
            const size = item.height || Math.abs(item.transform[3]) || 12;
            page.drawRectangle({
              x: x - 0.5,
              y: y - size * 0.25,
              width: w + 1,
              height: size * 1.2,
              color: rgb(1, 1, 1)
            });
            const text = String(replace == null ? "" : replace);
            if (text) {
              // WinAnsi only; drop unsupported characters
              const safe = text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
              page.drawText(safe, { x, y, size, font, color: rgb(0, 0, 0) });
            }
            count++;
            idx = hay.indexOf(needle, idx + needle.length);
          }
        }
      }
    }

    const edited = await out.save();
    return res.status(200).json({ pdf: Buffer.from(edited).toString("base64"), count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to process PDF: " + err.message });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: "4mb" } } };
