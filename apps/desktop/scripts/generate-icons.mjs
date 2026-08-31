/**
 * Regenerates desktop dock/taskbar icons from build/icon.svg.
 * Run from apps/desktop: bun run generate:icons
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import png2icons from "png2icons";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const buildDir = NodePath.join(__dirname, "..", "build");
const svgPath = NodePath.join(buildDir, "icon.svg");
const pngPath = NodePath.join(buildDir, "icon.png");
const icoPath = NodePath.join(buildDir, "icon.ico");
const icnsPath = NodePath.join(buildDir, "icon.icns");

const svg = NodeFS.readFileSync(svgPath, "utf8");

/** Renders the SVG source to a PNG buffer at the given pixel size. */
function renderPng(size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  return resvg.render().asPng();
}

const png512 = renderPng(512);
NodeFS.writeFileSync(pngPath, png512);

const icoSizes = [16, 32, 48, 256];
const icoBuffer = await pngToIco(icoSizes.map((size) => renderPng(size)));
NodeFS.writeFileSync(icoPath, icoBuffer);

const icnsBuffer = png2icons.createICNS(renderPng(1024), png2icons.BILINEAR, 0);
NodeFS.writeFileSync(icnsPath, icnsBuffer);

console.log("Generated icon.png, icon.ico, and icon.icns from icon.svg");
