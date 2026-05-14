// _print-spec.ts — caches de wire-o-magazines productspec
export async function getProductSpec(env: { PRINT_API_KEY: string; PRINT_API_BASE: string }) {
  const response = await fetch(
    `${env.PRINT_API_BASE}/products/wire-o-magazines?view=reseller`,
    { headers: { authorization: `PrintApiKey ${env.PRINT_API_KEY}` } }
  );

  if (!response.ok) throw new Error(`Spec fetch failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export function findOption(spec: any, propertySlug: string, matcher: (opt: any) => boolean): string {
  const prop = spec.properties?.find((p: any) => p.slug === propertySlug);
  if (!prop) throw new Error(`Property ${propertySlug} not found`);
  const opt = prop.options?.find(matcher);
  if (!opt) throw new Error(`No matching option for ${propertySlug}`);
  return opt.slug;
}
