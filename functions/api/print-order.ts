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
  PRINT_ORDER_DEDUPE: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Fail fast if KV binding is missing — better a 503 than a non-idempotent Print.com call
  if (!env.PRINT_ORDER_DEDUPE) {
    console.error('Missing KV binding: PRINT_ORDER_DEDUPE');
    return new Response('Fulfilment temporarily unavailable', { status: 503 });
  }

  // 1. Verify webhook signature
  const signature = request.headers.get('X-Signature') || '';
  const rawBody = await request.text();

  if (!await verifySignature(rawBody, signature, env.LS_WEBHOOK_SECRET)) {
    return new Response('Invalid signature', { status: 401 });
  }

  // V5: Guard against malformed webhook body
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (payload.meta?.event_name !== 'order_created') {
    return new Response('OK', { status: 200 });
  }

  const order = payload.data.attributes;
  const orderItems = order.first_order_item;
  const variantId = orderItems?.variant_id?.toString();

  if (variantId !== env.PRINT_VARIANT_ID) {
    return new Response('OK - digital order, no print', { status: 200 });
  }

  // B2: KV is eventually consistent. Lock biedt praktische bescherming tegen
  // LS webhook-retries, maar is geen strikt atomaire garantie tegen
  // gelijktijdige duplicate webhooks. Voor strikte garantie: D1 met
  // UNIQUE(order_identifier) of Durable Object.
  const dedupeKey = `ls-order:${order.identifier}`;
  const lockKey = `${dedupeKey}:lock`;

  // Check success cache first
  const existing = await env.PRINT_ORDER_DEDUPE.get(dedupeKey);
  if (existing) {
    console.log(`Duplicate webhook for ${order.identifier}, returning cached result`);
    return new Response(existing, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  // Check in-flight lock
  const existingLock = await env.PRINT_ORDER_DEDUPE.get(lockKey);
  if (existingLock) {
    console.log(`Webhook already processing for ${order.identifier}`);
    return new Response(JSON.stringify({
      success: true,
      duplicate: true,
      status: 'processing',
      lsOrder: order.identifier
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' }
    });
  }

  // Set lock (TTL 30 min covers LS retry window)
  await env.PRINT_ORDER_DEDUPE.put(
    lockKey,
    JSON.stringify({ status: 'processing', at: new Date().toISOString() }),
    { expirationTtl: 1800 }
  );

  // B1: LS sends custom_data under meta.custom_data, not first_order_item.custom_data
  // Both locations checked for backwards compatibility
  const customFields =
    payload.meta?.custom_data ||
    order.first_order_item?.custom_data ||
    {};

  const shippingAddr = {
    firstName: customFields.firstName || order.user_name.split(' ')[0],
    lastName:  customFields.lastName  || order.user_name.split(' ').slice(1).join(' '),
    fullstreet: customFields.street   || customFields['straat-huisnummer'] || '',
    postcode:  (customFields.postcode || '').replace(/\s/g, ''),
    city:      customFields.city      || customFields.woonplaats || '',
    country:   (customFields.country  || customFields.land || 'NL').substring(0, 2).toUpperCase(),
    email:     order.user_email,
    telephone: customFields.phone     || customFields.telefoon || ''
  };

  if (!shippingAddr.fullstreet || !shippingAddr.postcode || !shippingAddr.city) {
    // V7: No PII in logs — only flag which fields are missing
    console.error('Incomplete shipping address', {
      order: order.identifier,
      missing: {
        street:   !shippingAddr.fullstreet,
        postcode: !shippingAddr.postcode,
        city:     !shippingAddr.city
      }
    });
    await env.PRINT_ORDER_DEDUPE.delete(lockKey);
    return new Response('Incomplete shipping address', { status: 400 });
  }

  // 3. Resolve product spec options from Print.com API
  let options: Record<string, any>;
  try {
    const spec = await getProductSpec(env);
    options = {
      material:          findOption(spec, 'material',          (o: any) => o.slug.includes('170') && o.slug.includes('silk')),
      cover_material:    findOption(spec, 'cover_material',    (o: any) => o.slug.includes('250') && o.slug.includes('silk')),
      finish:            findOption(spec, 'finish',            (o: any) => o.slug.includes('mat') && o.slug.includes('lamination') && !o.slug.includes('soft')),
      binding:           findOption(spec, 'binding',           (o: any) => o.slug === 'wire_o' || o.slug.includes('wire')),
      binding_edge:      findOption(spec, 'binding_edge',      (o: any) => o.slug === 'binding_left'),
      'wire-o_color':    findOption(spec, 'wire-o_color',      (o: any) => o.slug === 'black'),
      size:              findOption(spec, 'size',              (o: any) => o.slug.includes('carre_l') || o.slug.includes('carré')),
      printtype:         findOption(spec, 'printtype',         (o: any) => o.slug === '44' || o.slug.includes('44')),
      printingmethod:    findOption(spec, 'printingmethod',    (o: any) => o.slug === 'offset' || o.slug === 'digital'),
      cover_last_sheet:  'no',
      sample:            'none',
      copies:            1,
      pages:             '112',
      clean_cut:         'yes',
      spot_finish:       'none',
      'wire-o_cover':    'none',
      urgency:           findOption(spec, 'urgency',           (o: any) => o.slug === 'standard' || o.slug === 'normal'),
      standard_bundle:   'no',
      rounded_corners:   'none',
      individually_sealed: 'none',
      delivery:          findOption(spec, 'delivery',          (o: any) => o.slug.includes('25') || o.slug.includes('box'))
    };
  } catch (e) {
    console.error('Option resolution failed for', order.identifier, e);
    await env.PRINT_ORDER_DEDUPE.delete(lockKey);
    return new Response(`Option lookup failed: ${e}`, { status: 500 });
  }

  // 4. Place Print.com order
  const printRequest = {
    deDuplicationId:   `LS-${order.identifier}`,
    customerReference: `WKJMN - LS ${order.identifier}`,
    poNumber:          order.identifier,
    paymentMethod:     'psp',
    items: [{
      customerReference: 'Wat kook je me nu?',
      sku:               'wire-o-magazines',
      fileUrl:           env.PDF_URL,
      options,
      shipments: [{ address: shippingAddr, copies: 1 }]
    }],
    billingAddress: {
      country:     env.BILLING_COUNTRY,
      firstName:   env.BILLING_FIRSTNAME,
      lastName:    env.BILLING_LASTNAME,
      vatNr:       env.BILLING_VATNR,
      city:        env.BILLING_CITY,
      companyName: env.BILLING_COMPANY,
      postcode:    env.BILLING_POSTCODE,
      telephone:   env.BILLING_PHONE,
      fullstreet:  env.BILLING_STREET,
      email:       env.BILLING_EMAIL
    }
  };

  try {
    const printResponse = await fetch(`${env.PRINT_API_BASE}/orders`, {
      method: 'POST',
      headers: {
        'authorization':      `PrintApiKey ${env.PRINT_API_KEY}`,
        'content-type':       'application/json',
        'pdc-request-source': 'watkookjemenu-cloudflare'
      },
      body: JSON.stringify(printRequest)
    });

    if (!printResponse.ok) {
      const errorText = await printResponse.text();
      console.error(`Print.com order failed: ${order.identifier}`, errorText, JSON.stringify(options));
      // Release lock on error so LS can retry
      await env.PRINT_ORDER_DEDUPE.delete(lockKey);
      return new Response(`Print.com error: ${errorText}`, { status: 500 });
    }

    const printResult: any = await printResponse.json();
    console.log(`✓ Order ${order.identifier} → Print.com ${printResult.orderNumber} → ${shippingAddr.city}`);

    // Cache successful result (90 days) and release lock
    const cachedResult = JSON.stringify({
      success:    true,
      lsOrder:    order.identifier,
      printOrder: printResult.orderNumber,
      at:         new Date().toISOString()
    });

    await env.PRINT_ORDER_DEDUPE.put(dedupeKey, cachedResult, { expirationTtl: 60 * 60 * 24 * 90 });
    await env.PRINT_ORDER_DEDUPE.delete(lockKey);

    return new Response(cachedResult, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

  } catch (e) {
    // Release lock on any unexpected exception
    await env.PRINT_ORDER_DEDUPE.delete(lockKey);
    throw e;
  }
};

// V6: Timing-safe hex comparison to prevent timing attacks on HMAC verification
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

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
  return timingSafeEqualHex(expectedSig, signature);
}
