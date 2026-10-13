// Renders build/icon.svg → build/icon.icns (app + DMG icon) and build/tray.svg
// → assets/trayTemplate{,@2x}.png (macOS menu-bar template images).
// Uses Playwright's Chromium so the SVG renders exactly; iconutil packs the .icns.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Uses installed Google Chrome; falls back to Playwright's Chromium.
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
async function render(svgPath, size, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const svg = readFileSync(svgPath, 'utf8').replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: out, omitBackground: true });
  await page.close();
}
const iconset = join(root, 'build', 'icon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const s of [16, 32, 128, 256, 512]) {
  await render(join(root, 'build/icon.svg'), s, join(iconset, `icon_${s}x${s}.png`));
  await render(join(root, 'build/icon.svg'), s * 2, join(iconset, `icon_${s}x${s}@2x.png`));
}
await render(join(root, 'build/icon.svg'), 1024, join(root, 'build/icon.png'));
await render(join(root, 'build/tray.svg'), 16, join(root, 'assets/trayTemplate.png'));
await render(join(root, 'build/tray.svg'), 32, join(root, 'assets/trayTemplate@2x.png'));
await browser.close();
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build/icon.icns')]);
rmSync(iconset, { recursive: true, force: true });
console.log('icons: build/icon.icns, build/icon.png, assets/trayTemplate*.png');
