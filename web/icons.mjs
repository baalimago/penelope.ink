// Renders www/favicon.svg into the page's other icons: `node icons.mjs` after changing it.
import { readFile, writeFile } from "node:fs/promises";

import { chromium } from "playwright";

const WWW = new URL("./www/", import.meta.url);
const svg = await readFile(new URL("favicon.svg", WWW), "utf8");
const browser = await chromium.launch();
const render = async (size, background = "transparent") => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:${background}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const png = await page.screenshot({ omitBackground: background === "transparent" });
  await page.close();
  return png;
};

// An .ico of PNG images: the directory, then each image.
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size % 256, at);
    head.writeUInt8(size % 256, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

try {
  for (const size of [192, 512]) await writeFile(new URL(`icon-${size}.png`, WWW), await render(size));
  // iOS rounds the corners itself and wants no transparency.
  await writeFile(new URL("apple-touch-icon.png", WWW), await render(180, "#fff5b4"));
  const small = await Promise.all([16, 32, 48].map(async (size) => ({ size, png: await render(size) })));
  await writeFile(new URL("favicon.ico", WWW), ico(small));
} finally {
  await browser.close();
}
