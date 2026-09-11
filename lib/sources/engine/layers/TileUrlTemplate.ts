export const DEFAULT_TILE_SUBDOMAINS: readonly string[] = ["0", "1", "2", "3"];

/**
 * Expands the XYZ placeholders supported by tile templates.
 * The optional {s} placeholder is selected consistently from tile coordinates.
 */
export function replaceTileTemplate(
  template: string,
  x: number,
  y: number,
  zoom: number,
  subdomains: readonly string[] = DEFAULT_TILE_SUBDOMAINS,
): string {
  let url = template
    .replace("{x}", String(x))
    .replace("{y}", String(y))
    .replace("{z}", String(zoom));

  if (subdomains.length > 0) {
    const subdomain = subdomains[Math.abs(x + y + zoom) % subdomains.length];
    url = url.replace("{s}", subdomain);
  }

  return url;
}
