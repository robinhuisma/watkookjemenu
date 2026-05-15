interface Env {
  LS_API_KEY: string;
  LS_STORE_ID: string;
  PRINT_VARIANT_ID: string;
  SITE_URL: string;
}

interface FormBody {
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  company?: unknown;
  street?: unknown;
  postcode?: unknown;
  city?: unknown;
  country?: unknown;
}

// V1: Strict sanitize — strips HTML tags, C0 controls, DEL, collapses whitespace
function clean(value: unknown, max = 120): string {
  if (typeof value !== 'string') return '';
  const stripped = value
    .normalize('NFKC')
    .replace(/<[^>]*>/g, '')
    .split('')
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  return stripped
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validatePostcode(postcode: string, country: string): boolean {
  if (country === 'NL') return /^[1-9][0-9]{3} ?[A-Za-z]{2}$/.test(postcode);
  if (country === 'BE') return /^[1-9][0-9]{3}$/.test(postcode);
  if (country === 'DE') return /^[0-9]{5}$/.test(postcode);
  return postcode.length > 0;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // V2: Env preflight — fail fast if required vars are missing
  const requiredEnv = ['LS_API_KEY', 'LS_STORE_ID', 'PRINT_VARIANT_ID', 'SITE_URL'] as const;
  for (const key of requiredEnv) {
    if (!env[key]) {
      console.error(`Missing env var: ${key}`);
      return json({ error: 'Checkout tijdelijk niet beschikbaar.' }, 503);
    }
  }

  // Only accept JSON
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Content-Type must be application/json' }, 415);
  }

  let body: FormBody;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // V1: Sanitize all fields with per-field max lengths
  const firstName = clean(body.firstName, 60);
  const lastName  = clean(body.lastName, 60);
  const email     = clean(body.email, 254);
  const phone     = clean(body.phone, 30);
  const company   = clean(body.company, 120);
  const street    = clean(body.street, 120);
  const postcode  = clean(body.postcode, 16);
  const city      = clean(body.city, 80);
  const country   = clean(body.country, 2).toUpperCase();

  // Server-side validation
  const missing: string[] = [];
  if (!firstName) missing.push('firstName');
  if (!lastName) missing.push('lastName');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) missing.push('email');
  if (!phone) missing.push('phone');
  if (!street) missing.push('street');
  if (!postcode) missing.push('postcode');
  if (!city) missing.push('city');
  if (!country) missing.push('country');

  if (missing.length > 0) {
    return json({ error: `Verplichte velden ontbreken of zijn ongeldig: ${missing.join(', ')}` }, 400);
  }

  if (!validatePostcode(postcode, country)) {
    return json({ error: `Ongeldige postcode voor ${country}` }, 400);
  }

  // Build Lemon Squeezy checkout payload (custom values must all be strings per LS docs)
  const lsBody = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          email,
          name: `${firstName} ${lastName}`,
          custom: {
            firstName,
            lastName,
            phone,
            company,
            street,
            postcode,
            city,
            country,
            variant: 'print'
          }
        },
        product_options: {
          // V10: use SITE_URL env var instead of hardcoded domain
          redirect_url: `${env.SITE_URL.replace(/\/$/, '')}/bedankt/`
        },
        checkout_options: {
          embed: false
        }
      },
      relationships: {
        store: {
          data: { type: 'stores', id: env.LS_STORE_ID }
        },
        variant: {
          data: { type: 'variants', id: env.PRINT_VARIANT_ID }
        }
      }
    }
  };

  // V3: 8-second timeout on LS API call
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let lsResponse: Response;
  try {
    lsResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.LS_API_KEY}`,
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json'
      },
      body: JSON.stringify(lsBody),
      signal: controller.signal
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return json({ error: 'Lemon Squeezy reageert niet. Probeer opnieuw.' }, 504);
    }
    console.error('LS API network error:', (e as Error).message);
    return json({ error: 'Betalingssessie kon niet worden aangemaakt. Probeer opnieuw of mail geniet@watkookjemenu.nl' }, 502);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!lsResponse.ok) {
    const errorBody = await lsResponse.text();
    console.error(`LS API error ${lsResponse.status}:`, errorBody);
    return json({ error: 'Betalingssessie kon niet worden aangemaakt. Probeer opnieuw of mail geniet@watkookjemenu.nl' }, 502);
  }

  // V4: Guard against non-JSON LS response
  let lsData: any;
  try {
    lsData = await lsResponse.json();
  } catch {
    console.error('LS response was not valid JSON');
    return json({ error: 'Betalingssessie kon niet worden aangemaakt.' }, 502);
  }

  const checkoutUrl = lsData?.data?.attributes?.url;
  if (!checkoutUrl) {
    console.error('LS response missing checkout URL:', JSON.stringify(lsData));
    return json({ error: 'Geen betaallink ontvangen. Probeer opnieuw of mail geniet@watkookjemenu.nl' }, 502);
  }

  return json({ url: checkoutUrl }, 200);
};

export const onRequestGet: PagesFunction = async () => {
  return new Response('Method Not Allowed', { status: 405 });
};

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
