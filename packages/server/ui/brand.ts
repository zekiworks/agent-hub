// This bus's name ("Agent Hub", or `serve --brand-name`), which the server writes into the page's
// <meta name="application-name">, and its tab icon: `--brand-icon`, else Agent Hub's logo (logo-64.png; Can #12890).
export const BRAND =
  document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content || "Agent Hub";

export const BRAND_ICON = document.querySelector<HTMLMetaElement>('meta[name="brand-icon"]')?.content || "/logo-64.png?v=2";
