// Draws the app icon (the seven level bars on the masthead navy) at the sizes phones ask for.
// Usage: node tools/make-icons.js   (needs Playwright with Chromium)
const { chromium } = require("playwright");
const path = require("path");
const bars = ["#E3E8ED", "#D6E7FA", "#B5D3F5", "#8DBBEE", "#2E9C88", "#3FAF98", "#9C84F0"];
const svg = size => {
  const pad = size * 0.2, w = size - pad * 2, gap = w * 0.035, bw = (w - gap * 6) / 7;
  const rects = bars.map((c, i) => { const h = w * (0.22 + i * 0.13); return `<rect x="${pad + i * (bw + gap)}" y="${pad + w - h}" width="${bw}" height="${h}" rx="${bw * 0.28}" fill="${c}"/>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#0E2130"/>${rects}</svg>`;
};
(async () => {
  const browser = await chromium.launch();
  for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0">${svg(size)}</body>`);
    await page.screenshot({ path: path.join(__dirname, "..", "docs", name) });
    await page.close();
  }
  await browser.close();
  console.log("icons written to docs/");
})();
