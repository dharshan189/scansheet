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
    this.initError = null;
    this.initPromise = null;
  }

  /**
   * Initialize Supabase client
   * Resolves public credentials strictly from /api/config (or server-injected window.__ENV__).
   * Never loads or trusts auth project configuration from localStorage.
   */
  async init() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        this.initError = null;

        // 1. Optional server-injected environment overrides
        let url = (window.__ENV__?.SUPABASE_URL || '').trim() || null;
        let anonKey = (window.__ENV__?.SUPABASE_ANON_KEY || '').trim() || null;

        // 2. Fetch public runtime config from backend /api/config
        if (!url || !anonKey) {
          try {
            const resp = await fetch('/api/config', { cache: 'no-store' });
            const contentType = resp.headers.get('content-type') || '';
            if (resp.ok && contentType.includes('application/json')) {
              const data = await resp.json();
              url = (data.supabaseUrl || '').trim() || url;
              anonKey = (data.supabaseAnonKey || '').trim() || anonKey;
              if (data.ocrServerUrl && !window.PADDLE_OCR_API_URL) {
                const trimmed = data.ocrServerUrl.trim().replace(/\/+$/, '');
                window.PADDLE_OCR_API_URL = trimmed.endsWith('/api/scan') ? trimmed : `${trimmed}/api/scan`;
              }
            } else {
              this.initError = `Config endpoint /api/config returned status ${resp.status}.`;
            }
          } catch (netErr) {
            this.initError = 'Could not reach backend /api/config endpoint.';
          }
        }

        if (!url || !anonKey) {
          this.initError = this.initError ||
            'Supabase public environment variables (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) are not set on the server.';
          console.warn('[Supabase]', this.initError);
          return null;
        }

        if (typeof window === 'undefined' || !window.supabase?.createClient) {
          this.initError = 'Supabase SDK library failed to load.';
          console.error('[Supabase]', this.initError);
          return null;
        }

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
      } catch (err) {
        this.initError = err?.message || 'Supabase initialization failed.';
        console.warn('[Supabase] Initialization error:', err);
      }
      return this.client;
    })();

    return this.initPromise;
  }

  /**
   * Return sanitized public Supabase config (URL + public key)
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Return human-readable non-secret error if initialization failed
   */
  getInitError() {
    return this.initError;
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
