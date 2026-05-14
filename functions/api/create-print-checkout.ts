interface Env {
  LS_API_KEY: string;
  LS_STORE_ID: string;
  PRINT_VARIANT_ID: string;
}

interface FormBody {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company?: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
}

// Basic XSS-safe sanitize: strip tags, trim whitespace
function sanitize(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').trim();
}

function validateNLPostcode(postcode: string): boolean {
  return /^[1-9][0-9]{3} ?[A-Za-z]{2}$/.test(postcode);
}

function validatePostcode(postcode: string, country: string): boolean {
  if (country === 'NL') return validateNLPostcode(postcode);
  if (country === 'BE') return /^[1-9][0-9]{3}$/.test(postcode);
  if (country === 'DE') return /^[0-9]{5}$/.test(postcode);
  // Other countries: accept any non-empty value
  return postcode.length > 0;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
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

  // Sanitize all fields
  const firstName = sanitize(body.firstName);
  const lastName = sanitize(body.lastName);
  const email = sanitize(body.email);
  const phone = sanitize(body.phone);
  const company = sanitize(body.company);
  const street = sanitize(body.street);
  const postcode = sanitize(body.postcode);
  const city = sanitize(body.city);
  const country = sanitize(body.country).toUpperCase();

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

  // Build Lemon Squeezy checkout — custom values must be strings per LS docs
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
          redirect_url: 'https://watkookjemenu.nl/bedankt/'
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

  let lsResponse: Response;
  try {
    lsResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.LS_API_KEY}`,
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json'
      },
      body: JSON.stringify(lsBody)
    });
  } catch (e) {
    // Network error reaching LS
    console.error('LS API network error:', (e as Error).message);
    return json({ error: 'Betalingssessie kon niet worden aangemaakt. Probeer opnieuw of mail geniet@watkookjemenu.nl' }, 502);
  }

  if (!lsResponse.ok) {
    const errorBody = await lsResponse.text();
    // Log error details server-side only — never expose to client
    console.error(`LS API error ${lsResponse.status}:`, errorBody);
    return json({ error: 'Betalingssessie kon niet worden aangemaakt. Probeer opnieuw of mail geniet@watkookjemenu.nl' }, 502);
  }

  const lsData: any = await lsResponse.json();
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
