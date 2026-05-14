import { getProductSpec, findOption } from './_print-spec';

export const onRequestGet: PagesFunction<{ PRINT_API_KEY: string; PRINT_API_BASE: string }> = async ({ env }) => {
  try {
    const spec = await getProductSpec(env);
    const options = {
      material: findOption(spec, 'material', (o: any) => o.slug.includes('170') && o.slug.includes('silk')),
      cover_material: findOption(spec, 'cover_material', (o: any) => o.slug.includes('250') && o.slug.includes('silk')),
      finish: findOption(spec, 'finish', (o: any) => o.slug.includes('mat') && o.slug.includes('lamination') && !o.slug.includes('soft')),
      binding: findOption(spec, 'binding', (o: any) => o.slug === 'wire_o' || o.slug.includes('wire')),
      binding_edge: findOption(spec, 'binding_edge', (o: any) => o.slug === 'left' || o.slug === 'links'),
      wire_o_color: findOption(spec, 'wire_o_color', (o: any) => o.slug === 'black'),
      size: findOption(spec, 'size', (o: any) => o.slug.includes('carre_l') || o.slug.includes('carré')),
      printtype: findOption(spec, 'printtype', (o: any) => o.slug === '44'),
    };
    return new Response(
      JSON.stringify({
        resolved: options,
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
