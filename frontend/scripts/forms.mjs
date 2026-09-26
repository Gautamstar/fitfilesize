/**
 * The form presets, from the landing page data: every page that cites a
 * form's rules. Published as /forms.json by seo-pages.mjs, and bundled into
 * the MCP package (mcp/scripts/sync-forms.mjs) as its offline copy, so both
 * describe a form the same way.
 */
export function formsFromPages(pages, siteUrl) {
  return pages
    .filter((p) => p.source)
    .map((p) => ({
      id: p.slug,
      name: p.title ?? p.heading,
      kind: p.kind,
      requirements: p.spec ?? [],
      // The same readings the website uses: a limit at 1000 bytes a KB and a
      // minimum at 1024, so a file passes a check done either way.
      limit_bytes: p.targetKb * 1000,
      ...(p.minKb ? { min_bytes: p.minKb * 1024 } : {}),
      ...(p.pixels ? { width: p.pixels.width, height: p.pixels.height } : {}),
      source: p.source.url,
      checked: p.source.checked,
      page: `${siteUrl}/${p.slug}`,
    }))
}
