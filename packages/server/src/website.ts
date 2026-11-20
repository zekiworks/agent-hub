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
  // The tab icon, a PNG: Safari shows no SVG tab icons (Ümit #13219).
  "logo-64.png": { source: "logo-64.png", type: "image/png" },
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

/** The word lists the message box completes words from (ui/words.ts, built by scripts/build-words.ts). */
const WORD_LISTS = new Set(["words-en.txt", "words-tr.txt"]);

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
  serve(pathname: string, headers?: Headers): Promise<Response> | undefined {
    if (pathname === "/" || pathname === "/index.html") return this.asset("index.html");
    if (pathname === "/auth") return this.asset("auth.html");
    // Browsers also ask /favicon.ico on their own (Safari for its tab and favourites icons): the same leaves, or the
    // brand's icon (Ümit #13273).
    if (pathname === "/favicon.ico") return this.brand?.icon ? this.brandImage(this.brand.icon) : this.asset("logo-64.png");
    if (pathname === "/brand/logo" || pathname === "/brand/icon") return this.brandImage(pathname === "/brand/logo" ? this.brand?.logo : this.brand?.icon);
    if (WORD_LISTS.has(pathname.slice(1))) return Promise.resolve(this.wordList(pathname.slice(1), headers));
    if (/^\/[a-z0-9-]+\.(js|css|html|svg|png)$/.test(pathname)) return this.asset(pathname.slice(1));
    return undefined;
  }

  /** Word lists, gzipped once per version: about 1.2 MB each, 0.5 MB on the wire. */
  private readonly wordLists = new Map<string, { mtime: number; etag: string; plain: Uint8Array<ArrayBuffer>; gzipped: Uint8Array<ArrayBuffer> }>();

  /**
   * A word list (ui/words.ts): gzipped when the browser takes that, and "not modified" when it has this version
   * already, so a page load costs nothing after the first.
   */
  private wordList(name: string, headers?: Headers): Response {
    const file = path.join(uiDir, name);
    const changed = mtime(file);
    if (changed < 0) return new Response("Not found", { status: 404 });
    let list = this.wordLists.get(name);
    if (!list || list.mtime !== changed) {
      const plain = new Uint8Array(readFileSync(file));
      const etag = `"${new Bun.CryptoHasher("sha256").update(plain).digest("hex").slice(0, 16)}"`;
      list = { mtime: changed, etag, plain, gzipped: Bun.gzipSync(plain) };
      this.wordLists.set(name, list);
    }
    const common = { ETag: list.etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" };
    if (headers?.get("if-none-match") === list.etag) return new Response(null, { status: 304, headers: common });
    const gzip = /\bgzip\b/.test(headers?.get("accept-encoding") ?? "");
    return new Response(gzip ? list.gzipped : list.plain, {
      headers: { ...common, "Content-Type": "text/plain; charset=utf-8", ...(gzip ? { "Content-Encoding": "gzip" } : {}) },
    });
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
        '<link id="favicon" rel="icon" type="image/png" href="/logo-64.png?v=2" />',
        `<link id="favicon" rel="icon" type="image/png" href="${this.brandUrls.icon}" />\n  <meta name="brand-icon" content="${this.brandUrls.icon}" />`
      );
    }
    if (brand.logo) {
      out = out
        .replace('<link rel="apple-touch-icon" href="/logo-180.png?v=2" />', `<link rel="apple-touch-icon" href="${this.brandUrls.logo}" />`)
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
