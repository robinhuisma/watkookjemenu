import { getProductSpec, findOption } from './_print-spec';

export const onRequestGet: PagesFunction<{ PRINT_API_KEY: string; PRINT_API_BASE: string }> = async ({ env }) => {
  try {
    const spec = await getProductSpec(env);
    const options: any = {};
    const errors: any[] = [];

    function tryMatch(slug: string, matcher: (o: any) => boolean) {
      try {
        options[slug] = findOption(spec, slug, matcher);
      } catch (e: any) {
        const prop = spec.properties?.find((p: any) => p.slug === slug);
        errors.push({
          slug,
          error: e.message,
          availableOptions: prop?.options?.map((o: any) => o.slug) || []
        });
      }
    }

    tryMatch('material', (o: any) => o.slug.includes('170') && o.slug.includes('silk'));
    tryMatch('cover_material', (o: any) => o.slug.includes('250') && o.slug.includes('silk'));
    tryMatch('finish', (o: any) => o.slug.includes('mat') && o.slug.includes('lamination') && !o.slug.includes('soft'));
    tryMatch('binding', (o: any) => o.slug === 'wire_o' || o.slug.includes('wire'));
    tryMatch('binding_edge', (o: any) => o.slug === 'binding_left');
    tryMatch('wire-o_color', (o: any) => o.slug === 'black');
    tryMatch('size', (o: any) => o.slug.includes('carre_l') || o.slug.includes('carré'));
    tryMatch('printtype', (o: any) => o.slug === '44');

    return new Response(
      JSON.stringify({
        resolved: options,
        errors,
        fullSpecProperties: spec.properties?.map((p: any) => ({
          slug: p.slug,
          options: p.options?.map((o: any) => o.slug)
        }))
      }, null, 2),
      { headers: { 'content-type': 'application/json' } }
    );
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 500 });
  }
};
