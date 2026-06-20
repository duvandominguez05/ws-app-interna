// Genera icon-costura-192.png e icon-costura-512.png desde icon-costura.svg
// usando puppeteer. Correr una sola vez con: node generar-icono-costura.js
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
  const svgPath = path.join(__dirname, 'public', 'icon-costura.svg');
  const svg = fs.readFileSync(svgPath, 'utf8');

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  for (const size of [192, 512]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:transparent;}
      svg{display:block;width:${size}px;height:${size}px;}
    </style></head><body>${svg}</body></html>`;
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const out = path.join(__dirname, 'public', `icon-costura-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true, type: 'png', clip: { x: 0, y: 0, width: size, height: size } });
    console.log('generado:', out);
  }

  await browser.close();
})();
