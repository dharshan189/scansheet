/**
 * ScanSheet - Supabase Client & Configuration Layer
 * Connects securely to Supabase PostgreSQL & Auth using environment variables.
 * Enforces native persistent sessions, automatic token refresh, and URL recovery detection.
 */

class SupabaseService {
  constructor() {
    this.client = null;
    this.config = {
      url: null,
      anonKey: null
    };
    this.initPromise = null;
  }

  /**
   * Initialize Supabase client
   * Resolves credentials from /api/config, window.__ENV__, or localStorage overrides
   */
  async init() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // 1. Check window.__ENV__ or global overrides
        let url = window.__ENV__?.SUPABASE_URL || window.SUPABASE_URL || null;
        let anonKey = window.__ENV__?.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || null;

        // 2. Fetch from backend /api/config if not defined in window
        if (!url || !anonKey) {
          try {
            const resp = await fetch('/api/config', { cache: 'no-store' });
            if (resp.ok) {
              const data = await resp.json();
              url = data.supabaseUrl || url;
              anonKey = data.supabaseAnonKey || anonKey;
              if (data.ocrServerUrl && !window.PADDLE_OCR_API_URL) {
                const trimmed = data.ocrServerUrl.replace(/\/+$/, '');
                window.PADDLE_OCR_API_URL = trimmed.endsWith('/api/scan') ? trimmed : `${trimmed}/api/scan`;
              }
            }
          } catch (netErr) {
            // Backend config not reachable (e.g. static host without serverless function)
          }
        }

        // 3. Check for developer localStorage configuration fallback
        if (!url || !anonKey) {
          try {
            const localCfg = localStorage.getItem('scansheet_supabase_config');
            if (localCfg) {
              const parsed = JSON.parse(localCfg);
              url = parsed.url || url;
              anonKey = parsed.anonKey || anonKey;
            }
          } catch (_) {}
        }

        if (url && anonKey && typeof window !== 'undefined' && window.supabase?.createClient) {
          this.config = { url, anonKey };
          this.client = window.supabase.createClient(url, anonKey, {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true,
              storage: window.localStorage
            }
          });
          console.log('[Supabase] Initialized successfully with persistent session management.');
        } else {
          if (!url || !anonKey) {
            console.info('[Supabase] Environment credentials not set. Running in local/offline fallback mode.');
          }
        }
      } catch (err) {
        console.warn('[Supabase] Initialization error:', err);
      }
      return this.client;
    })();

    return this.initPromise;
  }

  /**
   * Set custom Supabase client (e.g., during testing or dynamic reconfiguration)
   */
  setClient(client, config = {}) {
    this.client = client;
    if (config.url) this.config.url = config.url;
    if (config.anonKey) this.config.anonKey = config.anonKey;
  }

  /**
   * Get active Supabase client instance
   * @returns {Object|null}
   */
  getClient() {
    return this.client;
  }

  /**
   * Check if Supabase client is configured and active
   * @returns {boolean}
   */
  isConfigured() {
    return this.client !== null;
  }
}

export const SupabaseConfig = new SupabaseService();
