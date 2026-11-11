// ============================================================================
// ScanSheet - Vercel Serverless Function: GET /api/config
// Safely exposes public Supabase configuration & external OCR server URL.
// Never exposes SECRET_ROLE_KEY or database connection strings to the client.
// ============================================================================

export default function handler(req, res) {
  // CORS & Cache prevention headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const supabaseUrl = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ''
  ).trim();
  const supabaseAnonKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();
  const ocrServerUrl = (process.env.OCR_SERVER_URL || '').trim();

  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
    ocrServerUrl,
    configured: Boolean(supabaseUrl && supabaseAnonKey)
  });
}

