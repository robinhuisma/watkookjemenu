import { getProductSpec, findOption } from './_print-spec';

interface Env {
  PRINT_API_KEY: string;
  LS_WEBHOOK_SECRET: string;
  PDF_URL: string;
  PRINT_VARIANT_ID: string;
  BILLING_COUNTRY: string;
  BILLING_FIRSTNAME: string;
  BILLING_LASTNAME: string;
  BILLING_CITY: string;
  BILLING_POSTCODE: string;
  BILLING_STREET: string;
  BILLING_EMAIL: string;
  BILLING_VATNR: string;
  BILLING_COMPANY: string;
  BILLING_PHONE: string;
  PRINT_API_BASE: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Verifieer webhook signature
  const signature = request.headers.get('X-Signature') || '';
  const rawBody = await request.text();

  if (!await verifySignature(rawBody, signature, env.LS_WEBHOOK_SECRET)) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  if (payload.meta?.event_name !== 'order_created') {
    return new Response('OK', { status: 200 });
  }

  const order = payload.data.attributes;
  const orderItems = order.first_order_item;
  const variantId = orderItems?.variant_id?.toString();

  if (variantId !== env.PRINT_VARIANT_ID) {
    return new Response('OK - digital order, no print', { status: 200 });
  }

  // 2. Adres extraheren
  const customFields = order.first_order_item.custom_data || {};
  const shippingAddr = {
    firstName: customFields.firstName || customFields['naam-ontvanger']?.split(' ')[0] || order.user_name.split(' ')[0],
    lastName: customFields.lastName || customFields['naam-ontvanger']?.split(' ').slice(1).join(' ') || order.user_name.split(' ').slice(1).join(' '),
    fullstreet: customFields.street || customFields['straat-huisnummer'] || '',
    postcode: (customFields.postcode || '').replace(/\s/g, ''),
    city: customFields.city || customFields.woonplaats || '',
    country: (customFields.country || customFields.land || 'NL').substring(0, 2).toUpperCase(),
    email: order.user_email,
    telephone: customFields.phone || customFields.telefoon || ''
  };

  if (!shippingAddr.fullstreet || !shippingAddr.postcode || !shippingAddr.city) {
    console.error('Incompleet adres voor order', order.identifier, shippingAddr);
    return new Response('Incomplete shipping address', { status: 400 });
  }

  // 3. Productspec ophalen + juiste options vinden
  let options: Record<string, any>;
  try {
    const spec = await getProductSpec(env);
    options = {
      material: findOption(spec, 'material', (o: any) =>
        o.slug.includes('170') && o.slug.includes('silk')
      ),
      cover_material: findOption(spec, 'cover_material', (o: any) =>
        o.slug.includes('250') && o.slug.includes('silk')
      ),
      finish: findOption(spec, 'finish', (o: any) =>
        o.slug.includes('mat') && o.slug.includes('lamination') && !o.slug.includes('soft')
      ),
      binding: findOption(spec, 'binding', (o: any) => o.slug === 'wire_o' || o.slug.includes('wire')),
      binding_edge: findOption(spec, 'binding_edge', (o: any) => o.slug === 'binding_left'),
      'wire-o_color': findOption(spec, 'wire-o_color', (o: any) => o.slug === 'black'),
      size: findOption(spec, 'size', (o: any) => o.slug.includes('carre_l') || o.slug.includes('carré')),
      printtype: findOption(spec, 'printtype', (o: any) => o.slug === '44' || o.slug.includes('44')),
      printingmethod: findOption(spec, 'printingmethod', (o: any) => o.slug === 'offset' || o.slug === 'digital'),
      cover_last_sheet: 'no',
      sample: 'none',
      copies: 1,
      pages: '112',
      clean_cut: 'yes',
      spot_finish: 'none',
      'wire-o_cover': 'none',
      urgency: findOption(spec, 'urgency', (o: any) => o.slug === 'standard' || o.slug === 'normal'),
      standard_bundle: 'no',
      rounded_corners: 'none',
      individually_sealed: 'none',
      delivery: findOption(spec, 'delivery', (o: any) => o.slug.includes('25') || o.slug.includes('box'))
    };
  } catch (e) {
    console.error('Option resolution failed for', order.identifier, e);
    return new Response(`Option lookup failed: ${e}`, { status: 500 });
  }

  // 4. Print.com order plaatsen
  const printRequest = {
    deDuplicationId: `LS-${order.identifier}`,
    customerReference: `WKJMN - LS ${order.identifier}`,
    poNumber: order.identifier,
    paymentMethod: 'psp',
    items: [{
      customerReference: 'Wat kook je me nu?',
      sku: 'wire-o-magazines',
      fileUrl: env.PDF_URL,
      options,
      shipments: [{ address: shippingAddr, copies: 1 }]
    }],
    billingAddress: {
      country: env.BILLING_COUNTRY,
      firstName: env.BILLING_FIRSTNAME,
      lastName: env.BILLING_LASTNAME,
      vatNr: env.BILLING_VATNR,
      city: env.BILLING_CITY,
      companyName: env.BILLING_COMPANY,
      postcode: env.BILLING_POSTCODE,
      telephone: env.BILLING_PHONE,
      fullstreet: env.BILLING_STREET,
      email: env.BILLING_EMAIL
    }
  };

  const printResponse = await fetch(`${env.PRINT_API_BASE}/orders`, {
    method: 'POST',
    headers: {
      'authorization': `PrintApiKey ${env.PRINT_API_KEY}`,
      'content-type': 'application/json',
      'pdc-request-source': 'watkookjemenu-cloudflare'
    },
    body: JSON.stringify(printRequest)
  });

  if (!printResponse.ok) {
    const errorText = await printResponse.text();
    console.error(`Print.com order failed: ${order.identifier}`, errorText, JSON.stringify(options));
    return new Response(`Print.com error: ${errorText}`, { status: 500 });
  }

  const printResult = await printResponse.json();
  console.log(`✓ Order ${order.identifier} → Print.com ${printResult.orderNumber} → ${shippingAddr.city}`);

  return new Response(JSON.stringify({
    success: true,
    lsOrder: order.identifier,
    printOrder: printResult.orderNumber,
    options
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expectedSig = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return expectedSig === signature;
}
