// Renders the PWA icons from assets/icon.svg (any + maskable + apple-touch).
import { chromium } from "playwright";
import fs from "node:fs";
const root = process.argv[2], svg = fs.readFileSync(root + "/assets/icon.svg", "utf8");
const b = await chromium.launch(), p = await b.newPage();
const shot = async (size, html, out) => { await p.setViewportSize({ width: size, height: size }); await p.setContent(`<html><body style="margin:0">${html}</body></html>`); await p.screenshot({ path: root + "/assets/icons/" + out, omitBackground: true }); };
fs.mkdirSync(root + "/assets/icons", { recursive: true });
const plain = size => svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
for (const s of [192, 512]) await shot(s, plain(s), `icon-${s}.png`);
// maskable: full-bleed background, artwork inside the 80% safe zone
const mask = s => `<div style="width:${s}px;height:${s}px;background:#2F4BD8;display:flex;align-items:center;justify-content:center">${svg.replace("<svg ", `<svg width="${Math.round(s * 0.8)}" height="${Math.round(s * 0.8)}" `).replace('rx="14"', 'rx="0"')}</div>`;
await shot(512, mask(512), "maskable-512.png");
await shot(180, mask(180), "apple-touch-icon.png");
await b.close();
