// Draws a QR code as an SVG element (the device-linking code on the sign-in page).
import { qrcodegen } from "./qrcodegen";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Light modules around the code that scanners need, in modules. */
const QUIET_ZONE = 4;

export function qrSvg(text: string, pixels: number): SVGSVGElement {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const n = qr.size + 2 * QUIET_ZONE;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) parts.push(`M${x + QUIET_ZONE},${y + QUIET_ZONE}h1v1h-1z`);
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("width", String(pixels));
  svg.setAttribute("height", String(pixels));
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code");
  // Scanners need dark on light whatever the page's theme is.
  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(n));
  background.setAttribute("height", String(n));
  background.setAttribute("fill", "#fff");
  const modules = document.createElementNS(SVG_NS, "path");
  modules.setAttribute("d", parts.join(""));
  modules.setAttribute("fill", "#000");
  svg.append(background, modules);
  return svg;
}
