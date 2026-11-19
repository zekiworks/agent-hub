// The website's files: built `public/<asset>` when at least as new as its `ui/` source, else the source (scripts
// bundled on the fly), so an edited `ui/` file shows without `bun run build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  // Agent Hub's logo (Can #12890): the header's mark and tab icon, and the phone's home-screen icon.
  "logo.svg": { source: "logo.svg", type: "image/svg+xml" },
  "logo-180.png": { source: "logo-180.png", type: "image/png" },
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

/** This bus's name and pictures (`serve --brand-name/--brand-logo/--brand-icon`); without them it is "Agent Hub". */
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

/** `url?v=<first 8 hex of the file's sha256>`, or `url` alone when there is no file. */
function versioned(url: string, file: string | undefined): string {
  if (!file || !existsSync(file)) return url;
  return `${url}?v=${new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex").slice(0, 8)}`;
}

export class Website {
  /** Scripts bundled from `ui/`, by asset, with the source time they were bundled at. */
  private readonly bundled = new Map<string, { mtime: number; code: string }>();

  /**
   * The brand pictures' addresses carry the start of their content's hash: they are cached for a day, so a new logo
   * under the same address kept showing the old one (Can #12780).
   */
  private readonly brandUrls: { logo: string; icon: string };

  constructor(private readonly brand?: Brand) {
    this.brandUrls = { logo: versioned("/brand/logo", brand?.logo), icon: versioned("/brand/icon", brand?.icon) };
  }

  /** The response to GET `pathname` when it is a page or one of its files; undefined otherwise. */
  serve(pathname: string): Promise<Response> | undefined {
    if (pathname === "/" || pathname === "/index.html") return this.asset("index.html");
    if (pathname === "/auth") return this.asset("auth.html");
    if (pathname === "/brand/logo" || pathname === "/brand/icon") return this.brandImage(pathname === "/brand/logo" ? this.brand?.logo : this.brand?.icon);
    if (/^\/[a-z0-9-]+\.(js|css|html|svg|png)$/.test(pathname)) return this.asset(pathname.slice(1));
    return undefined;
  }

  private async brandImage(file: string | undefined): Promise<Response> {
    if (!file || !existsSync(file)) return new Response("Not found", { status: 404 });
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return new Response(Bun.file(file), { headers: { "Content-Type": type, "Cache-Control": "max-age=86400" } });
  }

  /**
   * The pages carry "Agent Hub" and its logo (the two copper leaves, logo.svg; Can #12890); a configured brand replaces
   * them: the title, the header's name (first word strong, the rest regular), its mark and the icons.
   */
  private branded(html: string): string {
    const brand = this.brand;
    if (!brand) return html;
    const name = escapeHtml(brand.name);
    const [first = name, ...rest] = name.split(" ");
    const wordmark = rest.length > 0 ? `${first}<span class="brand-rest"> ${rest.join(" ")}</span>` : first;
    let out = html
      .replace(/<meta name="application-name" content="[^"]*" \/>/, `<meta name="application-name" content="${name}" />`)
      .replace(/(<title>(?:[^<]* · )?)Agent Hub(<\/title>)/, `$1${name}$2`)
      .replace('<span class="brand-name">Agent<span class="brand-rest"> Hub</span></span>', `<span class="brand-name">${wordmark}</span>`);
    if (brand.icon) {
      out = out.replace(
        '<link id="favicon" rel="icon" type="image/svg+xml" href="/logo.svg" />',
        `<link id="favicon" rel="icon" type="image/png" href="${this.brandUrls.icon}" />\n  <meta name="brand-icon" content="${this.brandUrls.icon}" />`
      );
    }
    if (brand.logo) {
      out = out
        .replace('<link rel="apple-touch-icon" href="/logo-180.png" />', `<link rel="apple-touch-icon" href="${this.brandUrls.logo}" />`)
        .replace('<img class="brand-mark" src="/logo.svg" alt="" />', `<img class="brand-logo" src="${this.brandUrls.logo}" alt="" />`);
    }
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
