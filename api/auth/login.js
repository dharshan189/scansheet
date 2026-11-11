// ============================================================================
// ScanSheet - Vercel Serverless Function: POST /api/auth/login
// Resolves username aliases (such as admin username `ss@2718`) server-side
// and authenticates directly against Supabase Auth using the submitted password.
// Never hardcodes passwords or bypasses Supabase verification.
// ============================================================================

function getSupabaseAuthConfig() {
  const supabaseUrl = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ''
  ).trim().replace(/\/+$/, '');

  const supabasePublicKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();

  const adminLoginEmail = (
    process.env.ADMIN_EMAIL ||
    process.env.ADMIN_LOGIN_EMAIL ||
    'ss2718@scansheet.app'
  ).trim().toLowerCase();

  return { supabaseUrl, supabasePublicKey, adminLoginEmail };
}

function resolveLoginEmail(identifier, adminLoginEmail) {
  const clean = String(identifier || '').trim().toLowerCase();
  if (!clean) return '';
  if (clean === 'ss@2718') {
    return adminLoginEmail;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return clean;
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const { supabaseUrl, supabasePublicKey, adminLoginEmail } = getSupabaseAuthConfig();
  if (!supabaseUrl || !supabasePublicKey) {
    return res.status(503).json({
      error: 'Supabase environment variables are not configured on the server.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }
  body = body || {};

  const identifier = String(body.identifier || body.email || '').trim();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email/username and password are required.' });
  }

  const loginEmail = resolveLoginEmail(identifier, adminLoginEmail);
  if (!loginEmail) {
    return res.status(400).json({ error: 'Please enter a valid email address or admin username.' });
  }

  try {
    const authResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: supabasePublicKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        email: loginEmail,
        password
      })
    });

    const data = await authResp.json().catch(() => ({}));

    if (!authResp.ok || !data?.access_token || !data?.refresh_token || !data?.user) {
      return res.status(401).json({
        error: data?.error_description || data?.msg || 'Incorrect username or password.'
      });
    }

    return res.status(200).json({
      session: {
        access_token: data.access_token,
        refresh_token: data.refresh_token
      },
      user: data.user
    });
  } catch (err) {
    console.error('[Auth Login API Error]:', err);
    return res.status(500).json({ error: 'Unable to authenticate right now. Please try again.' });
  }
}

