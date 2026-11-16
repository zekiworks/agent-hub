// The website's files: built `public/<asset>` when at least as new as its `ui/` source, else the source (scripts
// bundled on the fly), so an edited `ui/` file shows without `bun run build`.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { json } from "./http";

const packageRoot = path.resolve(import.meta.dir, "..");
const uiDir = path.join(packageRoot, "ui");
const publicDir = path.join(packageRoot, "public");

const UI_ASSETS: Record<string, { source: string; type: string }> = {
  "index.html": { source: "index.html", type: "text/html; charset=utf-8" },
  "styles.css": { source: "styles.css", type: "text/css; charset=utf-8" },
  "app.js": { source: "app.ts", type: "application/javascript; charset=utf-8" },
  "auth.html": { source: "auth.html", type: "text/html; charset=utf-8" },
  "auth.js": { source: "auth.ts", type: "application/javascript; charset=utf-8" },
};

function mtime(file: string): number {
  return existsSync(file) ? statSync(file).mtimeMs : -1;
}

/**
 * When a source last changed; -1 if it is missing. A script counts as changed when any `ui/*.ts` did, since its
 * bundle includes the modules it imports.
 */
function sourceMtime(source: string): number {
  const own = mtime(path.join(uiDir, source));
  if (own < 0 || !source.endsWith(".ts")) return own;
  const scripts = readdirSync(uiDir).filter((name) => name.endsWith(".ts"));
  return Math.max(own, ...scripts.map((name) => mtime(path.join(uiDir, name))));
}

/** This bus's name and pictures (`serve --brand-name/--brand-logo/--brand-icon`); without them it is "Agent Bus". */
export interface Brand {
  name: string;
  /** The header's mark (any image file); also the home-screen icon. */
  logo?: string;
  /** The browser tab's icon (a small PNG). */
  icon?: string;
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

export class Website {
  /** Scripts bundled from `ui/`, by asset, with the source time they were bundled at. */
  private readonly bundled = new Map<string, { mtime: number; code: string }>();

  constructor(private readonly brand?: Brand) {}

  /** The response to GET `pathname` when it is a page or one of its files; undefined otherwise. */
  serve(pathname: string): Promise<Response> | undefined {
    if (pathname === "/" || pathname === "/index.html") return this.asset("index.html");
    if (pathname === "/auth") return this.asset("auth.html");
    if (pathname === "/brand/logo" || pathname === "/brand/icon") return this.brandImage(pathname === "/brand/logo" ? this.brand?.logo : this.brand?.icon);
    if (/^\/[a-z]+\.(js|css|html)$/.test(pathname)) return this.asset(pathname.slice(1));
    return undefined;
  }

  private async brandImage(file: string | undefined): Promise<Response> {
    if (!file || !existsSync(file)) return new Response("Not found", { status: 404 });
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return new Response(Bun.file(file), { headers: { "Content-Type": type, "Cache-Control": "max-age=86400" } });
  }

  /**
   * The pages carry "Agent Bus" and its ⇄ mark; a configured brand replaces them: the title, the header's name (first
   * word strong, the rest regular, as Hilde Reader's "Hilde Reader"), its mark and the icons.
   */
  private branded(html: string): string {
    const brand = this.brand;
    if (!brand) return html;
    const name = escapeHtml(brand.name);
    const [first = name, ...rest] = name.split(" ");
    const wordmark = rest.length > 0 ? `${first}<span class="brand-rest"> ${rest.join(" ")}</span>` : first;
    const icons =
      (brand.icon ? `<link rel="icon" type="image/png" href="/brand/icon" />\n  <meta name="brand-icon" content="/brand/icon" />\n  ` : "") +
      (brand.logo ? `<link rel="apple-touch-icon" href="/brand/logo" />\n  ` : "");
    let out = html
      .replace(/<meta name="application-name" content="[^"]*" \/>/, `<meta name="application-name" content="${name}" />`)
      .replace(/(<title>(?:[^<]* · )?)Agent Bus(<\/title>)/, `$1${name}$2`)
      .replace('<span class="brand-name">Agent Bus</span>', `<span class="brand-name">${wordmark}</span>`)
      .replace("<link rel=\"stylesheet\"", `${icons}<link rel="stylesheet"`);
    if (brand.logo) out = out.replace('<span class="brand-mark">⇄</span>', '<img class="brand-logo" src="/brand/logo" alt="" />');
    return out;
  }

  private async asset(asset: string): Promise<Response> {
    const spec = UI_ASSETS[asset];
    if (!spec) return new Response("Not found", { status: 404 });
    const sourcePath = path.join(uiDir, spec.source);
    const builtPath = path.join(publicDir, asset);
    const changed = sourceMtime(spec.source);
    const headers = { "Content-Type": spec.type, "Cache-Control": "no-cache" };
    const fresh = existsSync(builtPath) && statSync(builtPath).mtimeMs >= changed;
    if (asset.endsWith(".html")) {
      if (!fresh && changed < 0) return json({ error: `Website asset ${asset} not found` }, 404);
      return new Response(this.branded(await Bun.file(fresh ? builtPath : sourcePath).text()), { headers });
    }
    if (fresh) return new Response(Bun.file(builtPath), { headers });
    if (changed < 0) return json({ error: `Website asset ${asset} not found` }, 404);
    if (!spec.source.endsWith(".ts")) return new Response(Bun.file(sourcePath), { headers });
    let cached = this.bundled.get(asset);
    if (!cached || cached.mtime !== changed) {
      const result = await Bun.build({ entrypoints: [sourcePath], target: "browser", format: "esm" });
      const output = result.outputs[0];
      if (!result.success || !output) {
        const detail = result.logs.map((log) => log.message).join("; ");
        return json({ error: `Failed to bundle the website: ${detail}` }, 500);
      }
      cached = { mtime: changed, code: await output.text() };
      this.bundled.set(asset, cached);
    }
    return new Response(cached.code, { headers });
  }
}
