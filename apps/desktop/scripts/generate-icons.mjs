/**
 * Regenerates desktop dock/taskbar icons from build/icon.svg.
 * Run from apps/desktop: bun run generate:icons
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import png2icons from "png2icons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, "..", "build");
const svgPath = join(buildDir, "icon.svg");
const pngPath = join(buildDir, "icon.png");
const icoPath = join(buildDir, "icon.ico");
const icnsPath = join(buildDir, "icon.icns");

const svg = readFileSync(svgPath, "utf8");

/** Renders the SVG source to a PNG buffer at the given pixel size. */
function renderPng(size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  return resvg.render().asPng();
}

const png512 = renderPng(512);
writeFileSync(pngPath, png512);

const icoSizes = [16, 32, 48, 256];
const icoBuffer = await pngToIco(icoSizes.map((size) => renderPng(size)));
writeFileSync(icoPath, icoBuffer);

const icnsBuffer = png2icons.createICNS(renderPng(1024), png2icons.BILINEAR, 0);
writeFileSync(icnsPath, icnsBuffer);

console.log("Generated icon.png, icon.ico, and icon.icns from icon.svg");
