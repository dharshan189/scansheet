// ============================================================================
// ScanSheet - Vercel Serverless Function: GET /api/admin/overview
// Verifies the caller's Supabase Auth JWT and server-side admin role in
// public.profiles before returning shared user counts, user directory, and metrics.
// Never trusts client-side localStorage roles or user counts.
// ============================================================================

function getSupabaseServerConfig() {
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

  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  return { supabaseUrl, supabasePublicKey, serviceRoleKey };
}

function parseContentRangeTotal(contentRange, fallbackLength) {
  if (!contentRange || typeof contentRange !== 'string') return fallbackLength;
  const slashIdx = contentRange.lastIndexOf('/');
  if (slashIdx === -1) return fallbackLength;
  const totalPart = contentRange.slice(slashIdx + 1).trim();
  const parsed = Number.parseInt(totalPart, 10);
  return Number.isFinite(parsed) ? parsed : fallbackLength;
}

async function fetchJson(url, headers = {}) {
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers
    }
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  return { resp, data, text };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const { supabaseUrl, supabasePublicKey, serviceRoleKey } = getSupabaseServerConfig();
  if (!supabaseUrl || !supabasePublicKey) {
    return res.status(503).json({
      error: 'Supabase environment variables are not configured on the server.'
    });
  }

  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/i) : null;
  const accessToken = match?.[1]?.trim();

  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication token required.' });
  }

  try {
    // 1. Verify caller's JWT with Supabase Auth server
    const { resp: userResp, data: authUser } = await fetchJson(
      `${supabaseUrl}/auth/v1/user`,
      {
        apikey: supabasePublicKey,
        Authorization: `Bearer ${accessToken}`
      }
    );

    if (!userResp.ok || !authUser?.id) {
      return res.status(401).json({ error: 'Invalid or expired authentication session.' });
    }

    // Headers for reading shared data (prefer server-side service role if configured,
    // otherwise caller's verified JWT enforced by PostgreSQL FORCE RLS + is_admin()).
    const dbHeaders = serviceRoleKey
      ? {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      : {
          apikey: supabasePublicKey,
          Authorization: `Bearer ${accessToken}`
        };

    // 2. Verify caller's authoritative role from public.profiles on the server
    const profileQuery = `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(authUser.id)}&select=id,email,role`;
    const { resp: profileResp, data: profileRows } = await fetchJson(profileQuery, dbHeaders);
    const callerProfile = Array.isArray(profileRows) ? profileRows[0] : null;

    if (!profileResp.ok || !callerProfile || callerProfile.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    // 3. Read shared users from Supabase backend
    const { resp: profilesResp, data: profilesData, text: profilesErrText } = await fetchJson(
      `${supabaseUrl}/rest/v1/profiles?select=id,email,name,picture,role,auth_provider,created_at&order=created_at.desc`,
      {
        ...dbHeaders,
        Prefer: 'count=exact'
      }
    );

    if (!profilesResp.ok || !Array.isArray(profilesData)) {
      return res.status(502).json({
        error: profilesData?.message || profilesErrText || 'Failed to load user profiles from database.'
      });
    }

    let users = profilesData.map(row => ({
      id: row.id,
      email: row.email,
      name: row.name || row.email?.split('@')[0] || 'User',
      picture: row.picture || null,
      role: row.role === 'admin' ? 'admin' : 'user',
      authProvider: row.auth_provider || 'email',
      createdAt: row.created_at
    }));

    let totalUsers = parseContentRangeTotal(
      profilesResp.headers.get('content-range'),
      users.length
    );
    let source = 'supabase-profiles-rls';

    // If service_role key is configured on the server, cross-check Supabase Auth Admin users directly
    if (serviceRoleKey) {
      const { resp: authListResp, data: authListData } = await fetchJson(
        `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`,
        {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      );

      if (authListResp.ok && Array.isArray(authListData?.users)) {
        const profileById = new Map(users.map(u => [u.id, u]));
        users = authListData.users.map(u => {
          const prof = profileById.get(u.id);
          const meta = u.user_metadata || {};
          return {
            id: u.id,
            email: prof?.email || u.email || '',
            name: prof?.name || meta.full_name || meta.name || u.email?.split('@')[0] || 'User',
            picture: prof?.picture || meta.avatar_url || null,
            role: prof?.role === 'admin' ? 'admin' : 'user',
            authProvider: prof?.authProvider || u.app_metadata?.provider || 'email',
            createdAt: prof?.createdAt || u.created_at
          };
        }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        totalUsers = typeof authListData.total === 'number'
          ? authListData.total
          : users.length;
        source = 'supabase-auth-admin';
      }
    }

    // 4. Read shared conversion history metrics from PostgreSQL
    const { resp: statsResp, data: statsData } = await fetchJson(
      `${supabaseUrl}/rest/v1/conversion_history?select=id,status,created_at`,
      {
        ...dbHeaders,
        Prefer: 'count=exact'
      }
    );

    const stats = { totalProjects: 0, dailyUploads: 0, filesGenerated: 0 };
    if (statsResp.ok && Array.isArray(statsData)) {
      const todayStr = new Date().toDateString();
      stats.totalProjects = parseContentRangeTotal(
        statsResp.headers.get('content-range'),
        statsData.length
      );
      for (const row of statsData) {
        if (row.created_at && new Date(row.created_at).toDateString() === todayStr) {
          stats.dailyUploads++;
        }
        if (row.status === 'completed') {
          stats.filesGenerated++;
        }
      }
    }

    return res.status(200).json({
      totalUsers,
      users,
      stats,
      verifiedAdmin: {
        id: authUser.id,
        email: authUser.email,
        role: 'admin'
      },
      source
    });
  } catch (err) {
    console.error('[Admin Overview API Error]:', err);
    return res.status(500).json({ error: 'Unable to verify admin authorization with Supabase.' });
  }
}

