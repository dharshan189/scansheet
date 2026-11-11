/**
 * ScanSheet - Authentication Architecture & Gate Controller
 * Step 2: Auth State, Intended Action Session & Validation
 * Connects exclusively to Supabase Auth & PostgreSQL with server-verified sessions and roles.
 */

import { SupabaseConfig } from './supabase-client.js';

export const Auth = {
  // Current authenticated user (null when logged out)
  currentUser: null,

  // Reference to Supabase client instance
  supabase: null,

  // Holds the action the user was attempting before the login gate was triggered (e.g. 'upload')
  intendedAction: null,
  INTENDED_ACTION_KEY: 'scansheet_intended_action',

  // Registered listeners for auth state transitions
  listeners: [],

  // Listeners for Supabase password recovery link events
  recoveryListeners: [],

  ADMIN_USERNAME: 'ss@2718',

  GOOGLE_CLIENT_ID: '667093541029-m5nejkck6smbhlh657ddrlobpl1sa6em.apps.googleusercontent.com',

  // EmailJS Integration Settings (Signup Email OTP pre-verification)
  EMAILJS_CONFIG: {
    SERVICE_ID: 'service_d3n4rm3',
    TEMPLATE_ID: 'template_iczl86x',
    PUBLIC_KEY: 'zOal8flFg5NHjdCes',
    OTP_VALIDITY_SECONDS: 110 // 1 minute 50 seconds (110s)
  },

  // Holds pending registration data awaiting OTP verification (in memory only)
  pendingRegistration: null,

  // Admin Supabase Realtime channel & reconnect lifecycle state
  _adminRealtimeChannel: null,
  _adminRealtimeWanted: false,
  _adminRealtimeConnecting: false,
  _adminRealtimeReconnectTimer: null,
  _adminRealtimeRetryAttempt: 0,
  _adminRealtimeHasSubscribedOnce: false,
  _adminRealtimeNeedsResync: false,
  _adminRealtimeCallbacks: null,

  /**
   * Returns a safe user-facing error message when Supabase client is unavailable
   * @returns {string}
   */
  getCloudUnavailableMessage() {
    return (
      SupabaseConfig.getInitError() ||
      'Cloud authentication is unavailable because Supabase environment variables are not configured.'
    );
  },

  /**
   * Helper to decode JWT ID token from Google Identity Services
   * @param {string} token
   * @returns {Object|null}
   */
  decodeJwt(token) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error('Failed to parse JWT payload', e);
      return null;
    }
  },

  /**
   * Helper to map Supabase User entity to ScanSheet user model.
   * Never reads role from mutable user_metadata; role starts as 'user' and is
   * resolved solely from public.profiles on the server.
   * @param {Object} user
   * @returns {Object|null}
   */
  mapSupabaseUser(user) {
    if (!user) return null;
    const meta = user.user_metadata || {};
    return {
      id: user.id,
      name: meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : 'User'),
      email: user.email || '',
      role: 'user',
      picture: meta.avatar_url || meta.picture || null,
      authProvider: user.app_metadata?.provider || 'email',
      createdAt: user.created_at || new Date().toISOString()
    };
  },

  /**
   * Synchronize authoritative user profile and role from public.profiles table
   * @param {string} userId
   * @param {Object} [targetUser]
   * @returns {Promise<Object|null>}
   */
  async syncProfileWithDatabase(userId, targetUser = null) {
    if (!this.supabase || !userId) return null;
    try {
      const { data: profile, error } = await this.supabase
        .from('profiles')
        .select('id, email, name, picture, role, auth_provider, created_at')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        console.warn('[Auth] Profile sync notice:', error.message);
        return null;
      }

      const target = targetUser || (this.currentUser && this.currentUser.id === userId ? this.currentUser : null);
      if (profile && target && target.id === userId) {
        target.role = profile.role === 'admin' ? 'admin' : 'user';
        if (profile.name) target.name = profile.name;
        if (profile.picture) target.picture = profile.picture;
        if (profile.auth_provider) target.authProvider = profile.auth_provider;
        if (profile.created_at) target.createdAt = profile.created_at;
      }
      return profile || null;
    } catch (err) {
      console.warn('[Auth] Profile sync error:', err?.message || err);
      return null;
    }
  },

  /**
   * Initialize authentication system and restore verified Supabase session if active
   */
  async init() {
    try {
      // Initialize EmailJS SDK if available
      if (window.emailjs && typeof window.emailjs.init === 'function') {
        try {
          window.emailjs.init({ publicKey: this.EMAILJS_CONFIG.PUBLIC_KEY });
        } catch (ejErr) {
          console.warn('EmailJS SDK initialization notice:', ejErr);
        }
      }

      // Connect to Supabase Auth & PostgreSQL via backend /api/config
      const client = await SupabaseConfig.init();
      if (!client) {
        this.supabase = null;
        this.currentUser = null;
        this.notifyListeners();
        return null;
      }

      this.supabase = client;

      try {
        const { data: { session }, error: sessErr } = await this.supabase.auth.getSession();
        if (sessErr) {
          console.warn('[Auth] Session restoration error:', sessErr.message);
          this.currentUser = null;
        } else if (session?.user) {
          // Verify token authenticity against Supabase Auth server
          const { data: { user: verifiedUser }, error: userErr } = await this.supabase.auth.getUser();
          if (userErr || !verifiedUser) {
            console.warn('[Auth] Session rejected by server:', userErr?.message || 'No user');
            await this.supabase.auth.signOut().catch(() => {});
            this.currentUser = null;
          } else {
            this.currentUser = this.mapSupabaseUser(verifiedUser);
            await this.syncProfileWithDatabase(verifiedUser.id);
          }
        } else {
          this.currentUser = null;
        }
      } catch (sbErr) {
        console.warn('[Auth] Supabase verification notice:', sbErr);
        this.currentUser = null;
      }

      this.notifyListeners();

      // Subscribe to native Supabase auth transitions (deferring DB lookups to avoid auth-lock re-entrancy)
      this.supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          this.stopAdminRealtime();
          this.currentUser = null;
          this.notifyListeners();
          return;
        }

        if (
          event === 'SIGNED_IN' ||
          event === 'TOKEN_REFRESHED' ||
          event === 'USER_UPDATED' ||
          event === 'PASSWORD_RECOVERY'
        ) {
          if (!session?.user) return;
          const userId = session.user.id;
          const hydrated = this.mapSupabaseUser(session.user);
          const accessToken = session.access_token || null;

          setTimeout(async () => {
            if (accessToken && this.supabase?.realtime?.setAuth) {
              try {
                await this.supabase.realtime.setAuth(accessToken);
              } catch (_) {}
            }

            await this.syncProfileWithDatabase(userId, hydrated);

            const prev = this.currentUser;
            const changed = !prev || prev.id !== hydrated.id || prev.role !== hydrated.role || prev.name !== hydrated.name;
            this.currentUser = hydrated;

            if (hydrated.role !== 'admin') {
              await this.stopAdminRealtime();
            }

            if (event !== 'TOKEN_REFRESHED' || changed) {
              if (changed || event === 'USER_UPDATED') {
                this.notifyListeners();
              }
            }
            if (event === 'PASSWORD_RECOVERY') {
              this.notifyRecoveryListeners();
            }
          }, 0);
        }
      });
    } catch (e) {
      console.error('Failed to initialize authentication:', e);
      this.currentUser = null;
      this.notifyListeners();
    }
    return this.currentUser;
  },

  /**
   * Check if user is currently authenticated with a verified Supabase user
   * @returns {boolean}
   */
  isAuthenticated() {
    return this.currentUser !== null;
  },

  /**
   * Get current authenticated user profile
   * @returns {Object|null}
   */
  getUser() {
    return this.currentUser;
  },

  /**
   * Get current Supabase JWT access token (if signed in)
   * @returns {Promise<string|null>}
   */
  async getAccessToken() {
    if (!this.supabase?.auth) return null;
    try {
      const { data: { session } } = await this.supabase.auth.getSession();
      return session?.access_token || null;
    } catch (_) {
      return null;
    }
  },

  /**
   * Store intended action to resume seamlessly after authentication
   * @param {string|null} action
   */
  setIntendedAction(action) {
    this.intendedAction = action;
    try {
      if (action) {
        sessionStorage.setItem(this.INTENDED_ACTION_KEY, action);
      } else {
        sessionStorage.removeItem(this.INTENDED_ACTION_KEY);
      }
    } catch (_) {}
  },

  /**
   * Retrieve and clear the intended action
   * @returns {string|null}
   */
  consumeIntendedAction() {
    let action = this.intendedAction;
    this.intendedAction = null;
    try {
      if (!action) {
        action = sessionStorage.getItem(this.INTENDED_ACTION_KEY);
      }
      sessionStorage.removeItem(this.INTENDED_ACTION_KEY);
    } catch (_) {}
    return action || null;
  },

  /**
   * Subscribe to authentication state changes
   * @param {Function} callback
   */
  onAuthStateChanged(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
      callback(this.currentUser);
    }
  },

  /**
   * Notify all registered listeners
   */
  notifyListeners() {
    this.listeners.forEach(cb => {
      try {
        cb(this.currentUser);
      } catch (err) {
        console.error('Error in auth listener:', err);
      }
    });
  },

  /**
   * Subscribe to Supabase password recovery redirect events
   * @param {Function} callback
   */
  onPasswordRecovery(callback) {
    if (typeof callback === 'function') {
      this.recoveryListeners.push(callback);
    }
  },

  /**
   * Notify password recovery listeners
   */
  notifyRecoveryListeners() {
    this.recoveryListeners.forEach(cb => {
      try {
        cb();
      } catch (err) {
        console.error('Error in recovery listener:', err);
      }
    });
  },

  /**
   * Authenticate user with Email (or admin username `ss@2718`) and Password via Supabase Auth
   * @param {Object} credentials
   * @param {string} credentials.email
   * @param {string} credentials.password
   * @returns {Promise<{success: boolean, error?: string, user?: Object}>}
   */
  async login({ email, password }) {
    const cleanIdentifier = (email || '').trim().toLowerCase();
    const cleanPass = password || '';
    const isAdminAlias = cleanIdentifier === this.ADMIN_USERNAME;

    if (!cleanIdentifier) {
      return { success: false, error: 'Email address or username is required.' };
    }

    if (!isAdminAlias && !this.isValidEmail(cleanIdentifier)) {
      return { success: false, error: 'Please enter a valid email address or username.' };
    }

    if (!cleanPass) {
      return { success: false, error: 'Password is required.' };
    }

    if (!this.supabase?.auth || typeof this.supabase.auth.signInWithPassword !== 'function') {
      return { success: false, error: this.getCloudUnavailableMessage() };
    }

    try {
      let signedInUser = null;

      if (isAdminAlias) {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          cache: 'no-store',
          body: JSON.stringify({
            identifier: cleanIdentifier,
            password: cleanPass
          })
        });
        const payload = await resp.json().catch(() => ({}));

        if (!resp.ok || !payload?.session?.access_token || !payload?.session?.refresh_token) {
          return {
            success: false,
            error: payload?.error || 'Incorrect username or password.'
          };
        }

        const { data: sessionData, error: sessionErr } = await this.supabase.auth.setSession({
          access_token: payload.session.access_token,
          refresh_token: payload.session.refresh_token
        });

        if (sessionErr || !sessionData?.user) {
          return {
            success: false,
            error: sessionErr?.message || 'Could not establish verified authentication session.'
          };
        }
        signedInUser = sessionData.user;
      } else {
        const { data, error } = await this.supabase.auth.signInWithPassword({
          email: cleanIdentifier,
          password: cleanPass
        });

        if (error) {
          return { success: false, error: error.message || 'Incorrect email or password.' };
        }
        signedInUser = data?.user || null;
      }

      if (!signedInUser) {
        return { success: false, error: 'Login failed. No authenticated user returned.' };
      }

      this.currentUser = this.mapSupabaseUser(signedInUser);
      await this.syncProfileWithDatabase(signedInUser.id);
      this.notifyListeners();
      return { success: true, user: this.currentUser };
    } catch (sbErr) {
      return { success: false, error: sbErr?.message || 'Unable to sign in. Please try again.' };
    }
  },

  /**
   * Authenticate or register user with Google via Supabase Auth
   * Supports One Tap ID token (signInWithIdToken) or OAuth redirect (signInWithOAuth).
   * @param {Object} [options]
   * @param {string} [options.idToken]
   * @returns {Promise<{success: boolean, error?: string, user?: Object, redirecting?: boolean}>}
   */
  async loginWithGoogle({ idToken } = {}) {
    if (!this.supabase?.auth) {
      return { success: false, error: this.getCloudUnavailableMessage() };
    }

    if (idToken) {
      try {
        const { data, error } = await this.supabase.auth.signInWithIdToken({
          provider: 'google',
          token: idToken
        });
        if (error) {
          return { success: false, error: error.message || 'Google authentication failed.' };
        }
        if (data?.user) {
          this.currentUser = this.mapSupabaseUser(data.user);
          await this.syncProfileWithDatabase(data.user.id);
          this.notifyListeners();
          return { success: true, user: this.currentUser };
        }
        return { success: false, error: 'Google authentication returned no session.' };
      } catch (err) {
        return { success: false, error: err?.message || 'Google sign-in failed.' };
      }
    }

    // Verify whether Google OAuth is enabled in Supabase project settings before redirecting
    try {
      const { url, anonKey } = SupabaseConfig.getConfig();
      if (url && anonKey) {
        const settingsResp = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/settings`, {
          headers: { apikey: anonKey, Accept: 'application/json' },
          cache: 'no-store'
        });
        if (settingsResp.ok) {
          const settings = await settingsResp.json();
          if (settings?.external && settings.external.google === false) {
            return {
              success: false,
              error: 'Google Sign-In is not enabled in Supabase Authentication Providers yet. Please sign in with Email or enable Google in Supabase.'
            };
          }
        }
      }
    } catch (_) {
      // Proceed to OAuth attempt if preflight check is blocked by network
    }

    try {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await this.supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo }
      });

      if (error) {
        return { success: false, error: error.message || 'Could not start Google sign-in.' };
      }

      return { success: true, redirecting: true };
    } catch (oauthErr) {
      return { success: false, error: oauthErr?.message || 'Google OAuth failed.' };
    }
  },

  /**
   * Fetch server-verified Admin Dashboard overview (totalUsers, users, stats)
   * from /api/admin/overview using the caller's verified Supabase JWT.
   * Never reads from browser-local storage.
   * @returns {Promise<{success: boolean, authorized: boolean, totalUsers: number, users: Array, stats: Object, error?: string}>}
   */
  async fetchAdminOverview() {
    const emptyStats = { totalProjects: 0, dailyUploads: 0, filesGenerated: 0 };
    if (!this.supabase?.auth) {
      return {
        success: false,
        authorized: false,
        totalUsers: 0,
        users: [],
        stats: emptyStats,
        error: this.getCloudUnavailableMessage()
      };
    }

    const token = await this.getAccessToken();
    if (!token) {
      return {
        success: false,
        authorized: false,
        totalUsers: 0,
        users: [],
        stats: emptyStats,
        error: 'Authentication required for admin access.'
      };
    }

    try {
      const resp = await fetch('/api/admin/overview', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        cache: 'no-store'
      });

      const payload = await resp.json().catch(() => ({}));

      if (resp.status === 401 || resp.status === 403) {
        if (resp.status === 403 && this.currentUser && this.currentUser.role === 'admin') {
          this.currentUser.role = 'user';
          this.notifyListeners();
        }
        return {
          success: false,
          authorized: false,
          totalUsers: 0,
          users: [],
          stats: emptyStats,
          error: payload.error || 'Admin access denied.'
        };
      }

      if (!resp.ok) {
        return {
          success: false,
          authorized: true,
          totalUsers: 0,
          users: [],
          stats: emptyStats,
          error: payload.error || `Server error (${resp.status}) while loading admin metrics.`
        };
      }

      return {
        success: true,
        authorized: true,
        totalUsers: typeof payload.totalUsers === 'number' ? payload.totalUsers : (payload.users?.length || 0),
        users: Array.isArray(payload.users) ? payload.users : [],
        stats: payload.stats || emptyStats,
        source: payload.source
      };
    } catch (err) {
      return {
        success: false,
        authorized: false,
        totalUsers: 0,
        users: [],
        stats: emptyStats,
        error: err?.message || 'Unable to reach admin backend endpoint.'
      };
    }
  },

  /**
   * Fetch all registered users from server-authorized Admin endpoint
   * @returns {Promise<Array>}
   */
  async fetchRegisteredUsers() {
    const overview = await this.fetchAdminOverview();
    if (!overview.success) {
      throw new Error(overview.error || 'Failed to load registered users.');
    }
    return overview.users;
  },

  /**
   * Clear existing Supabase Realtime channel without changing wanted state
   */
  async _teardownAdminChannel() {
    const channel = this._adminRealtimeChannel;
    this._adminRealtimeChannel = null;
    if (channel && this.supabase && typeof this.supabase.removeChannel === 'function') {
      try {
        await this.supabase.removeChannel(channel);
      } catch (err) {
        console.warn('[Realtime] Channel cleanup notice:', err?.message || err);
      }
    }
  },

  /**
   * Handle Supabase Realtime channel status transitions and error recovery
   * @param {string} status
   * @param {Error|any} [err]
   */
  _handleAdminRealtimeStatus(status, err) {
    if (status === 'SUBSCRIBED') {
      this._adminRealtimeConnecting = false;
      this._adminRealtimeRetryAttempt = 0;
      if (this._adminRealtimeReconnectTimer) {
        clearTimeout(this._adminRealtimeReconnectTimer);
        this._adminRealtimeReconnectTimer = null;
      }

      const isReconnect = this._adminRealtimeHasSubscribedOnce || this._adminRealtimeNeedsResync;
      this._adminRealtimeHasSubscribedOnce = true;
      this._adminRealtimeNeedsResync = false;

      this._adminRealtimeCallbacks?.onStatusChange?.('SUBSCRIBED', { reconnected: isReconnect });

      // After reconnecting, immediately pull authoritative counts from backend
      if (isReconnect) {
        this._adminRealtimeCallbacks?.onDataChanged?.({ reason: 'reconnected' });
      }
      return;
    }

    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      this._adminRealtimeConnecting = false;
      if (!this._adminRealtimeWanted) {
        return;
      }

      this._adminRealtimeNeedsResync = true;
      if (err) {
        console.warn(`[Realtime] Admin subscription ${status}:`, err?.message || err);
      } else {
        console.warn(`[Realtime] Admin subscription status: ${status}`);
      }
      this._adminRealtimeCallbacks?.onStatusChange?.(status, { error: err });
      this._scheduleAdminRealtimeReconnect();
    }
  },

  /**
   * Schedule exponential-backoff Realtime reconnect while Admin Dashboard remains open
   */
  _scheduleAdminRealtimeReconnect() {
    if (!this._adminRealtimeWanted || this._adminRealtimeReconnectTimer) {
      return;
    }
    const delayMs = Math.min(15000, 1000 * Math.pow(2, this._adminRealtimeRetryAttempt));
    this._adminRealtimeRetryAttempt = Math.min(this._adminRealtimeRetryAttempt + 1, 5);

    this._adminRealtimeReconnectTimer = setTimeout(async () => {
      this._adminRealtimeReconnectTimer = null;
      if (!this._adminRealtimeWanted || !this.currentUser || this.currentUser.role !== 'admin') {
        return;
      }
      const callbacks = this._adminRealtimeCallbacks;
      await this._teardownAdminChannel();
      await this.startAdminRealtime(callbacks || {});
    }, delayMs);
  },

  /**
   * Start real-time PostgreSQL change subscription for verified Admin Dashboard.
   * Subscribes to public.profiles and public.conversion_history under RLS.
   * @param {Object} [callbacks]
   * @param {Function} [callbacks.onDataChanged]
   * @param {Function} [callbacks.onStatusChange]
   * @returns {Promise<boolean>}
   */
  async startAdminRealtime({ onDataChanged, onStatusChange } = {}) {
    if (!this.supabase || typeof this.supabase.channel !== 'function') {
      onStatusChange?.('UNAVAILABLE', { error: new Error('Supabase Realtime client unavailable.') });
      return false;
    }
    if (!this.currentUser || this.currentUser.role !== 'admin') {
      return false;
    }

    // Reuse healthy active channel instead of duplicating subscriptions
    if (
      this._adminRealtimeWanted &&
      this._adminRealtimeChannel &&
      (this._adminRealtimeConnecting || this._adminRealtimeChannel.state === 'joined')
    ) {
      this._adminRealtimeCallbacks = { onDataChanged, onStatusChange };
      return true;
    }

    await this._teardownAdminChannel();
    if (this._adminRealtimeReconnectTimer) {
      clearTimeout(this._adminRealtimeReconnectTimer);
      this._adminRealtimeReconnectTimer = null;
    }

    this._adminRealtimeWanted = true;
    this._adminRealtimeConnecting = true;
    this._adminRealtimeCallbacks = { onDataChanged, onStatusChange };
    onStatusChange?.('CONNECTING', {});

    const token = await this.getAccessToken();
    if (!token || !this._adminRealtimeWanted || this.currentUser?.role !== 'admin') {
      this._adminRealtimeConnecting = false;
      if (this._adminRealtimeWanted) {
        onStatusChange?.('CHANNEL_ERROR', { error: new Error('Missing admin session token.') });
      }
      return false;
    }

    if (this.supabase.realtime && typeof this.supabase.realtime.setAuth === 'function') {
      try {
        await this.supabase.realtime.setAuth(token);
      } catch (err) {
        console.warn('[Realtime] setAuth notice:', err?.message || err);
      }
    }

    if (!this._adminRealtimeWanted || this.currentUser?.role !== 'admin') {
      this._adminRealtimeConnecting = false;
      return false;
    }

    const channel = this.supabase.channel(`scansheet-admin-sync-${Date.now()}`);
    this._adminRealtimeChannel = channel;

    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
        if (this._adminRealtimeChannel !== channel || !this._adminRealtimeWanted) return;
        this._adminRealtimeCallbacks?.onDataChanged?.({
          reason: 'db_change',
          table: 'profiles',
          eventType: payload?.eventType,
          payload
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversion_history' }, (payload) => {
        if (this._adminRealtimeChannel !== channel || !this._adminRealtimeWanted) return;
        this._adminRealtimeCallbacks?.onDataChanged?.({
          reason: 'db_change',
          table: 'conversion_history',
          eventType: payload?.eventType,
          payload
        });
      })
      .subscribe((status, err) => {
        if (this._adminRealtimeChannel !== channel) return;
        this._handleAdminRealtimeStatus(status, err);
      });

    return true;
  },

  /**
   * Ensure Admin Realtime stays connected after network recovery or tab wake
   */
  async ensureAdminRealtimeConnected() {
    if (!this._adminRealtimeWanted || !this.currentUser || this.currentUser.role !== 'admin') {
      return false;
    }

    const state = this._adminRealtimeChannel?.state;
    if (state === 'joined' || this._adminRealtimeConnecting) {
      return true;
    }

    this._adminRealtimeNeedsResync = true;
    if (this._adminRealtimeReconnectTimer) {
      clearTimeout(this._adminRealtimeReconnectTimer);
      this._adminRealtimeReconnectTimer = null;
    }
    const callbacks = this._adminRealtimeCallbacks || {};
    await this._teardownAdminChannel();
    return this.startAdminRealtime(callbacks);
  },

  /**
   * Cleanly unsubscribe and tear down Admin Realtime subscription
   */
  async stopAdminRealtime() {
    this._adminRealtimeWanted = false;
    this._adminRealtimeConnecting = false;
    this._adminRealtimeHasSubscribedOnce = false;
    this._adminRealtimeNeedsResync = false;
    this._adminRealtimeRetryAttempt = 0;
    this._adminRealtimeCallbacks = null;
    if (this._adminRealtimeReconnectTimer) {
      clearTimeout(this._adminRealtimeReconnectTimer);
      this._adminRealtimeReconnectTimer = null;
    }
    await this._teardownAdminChannel();
  },

  /**
   * Fetch system-wide conversion metrics from server-authorized Admin endpoint
   * @returns {Promise<{totalProjects: number, dailyUploads: number, filesGenerated: number}>}
   */
  async fetchAdminStats() {
    const overview = await this.fetchAdminOverview();
    if (!overview.success) {
      throw new Error(overview.error || 'Failed to load admin stats.');
    }
    return overview.stats;
  },

  /**
   * Local user counting is disabled; returns 0 (always use fetchAdminOverview().totalUsers)
   * @returns {number}
   */
  getUsersCount() {
    return 0;
  },

  /**
   * Register new user account directly in Supabase Auth
   * @param {Object} data
   * @param {string} data.name
   * @param {string} data.email
   * @param {string} data.password
   * @param {string} data.confirmPassword
   * @returns {Promise<{success: boolean, error?: string, requiresConfirmation?: boolean, user?: Object}>}
   */
  async signup({ name, email, password, confirmPassword }) {
    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPass = password || '';
    const cleanConfirm = confirmPassword || '';

    if (!cleanName) {
      return { success: false, error: 'Full name is required.' };
    }

    if (!cleanEmail) {
      return { success: false, error: 'Email address is required.' };
    }

    if (!this.isValidEmail(cleanEmail)) {
      return { success: false, error: 'Please enter a valid email address.' };
    }

    if (!cleanPass) {
      return { success: false, error: 'Password is required.' };
    }

    if (cleanPass.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }

    if (cleanPass !== cleanConfirm) {
      return { success: false, error: 'Passwords do not match.' };
    }

    if (!this.supabase?.auth || typeof this.supabase.auth.signUp !== 'function') {
      return { success: false, error: this.getCloudUnavailableMessage() };
    }

    try {
      const { data, error } = await this.supabase.auth.signUp({
        email: cleanEmail,
        password: cleanPass,
        options: {
          emailRedirectTo: window.location.origin + window.location.pathname,
          data: {
            full_name: cleanName,
            name: cleanName
          }
        }
      });

      if (error) {
        return { success: false, error: error.message || 'Could not register account in Supabase.' };
      }

      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return {
          success: false,
          error: 'An account with this email already exists. Please log in or reset your password.'
        };
      }

      if (data?.session?.user) {
        this.currentUser = this.mapSupabaseUser(data.session.user);
        await this.syncProfileWithDatabase(data.session.user.id);
        this.notifyListeners();
        return { success: true, user: this.currentUser };
      }

      if (data?.user) {
        return {
          success: true,
          requiresConfirmation: true,
          user: this.mapSupabaseUser(data.user),
          message: 'Account created! Please check your email and click the confirmation link to activate your account.'
        };
      }

      return { success: false, error: 'Signup completed without a user response.' };
    } catch (sbErr) {
      return { success: false, error: sbErr?.message || 'Supabase account registration failed.' };
    }
  },

  /**
   * Generates a random 6-digit numeric OTP code
   * @returns {string}
   */
  generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  },

  /**
   * Sends OTP email to recipient via EmailJS
   * @param {string} email Destination email address
   * @param {string} name User full name
   * @param {string} otp 6-digit code
   * @returns {Promise<{success: boolean, response?: any}>}
   */
  async sendOtpEmail(email, name, otp) {
    const fullMessage = `OTP for Scansheet Registration.\nThis OTP is System generated.\nValid for 1 minute 50 seconds.\n\nYour OTP is: ${otp}`;
    const templateParams = {
      from_name: 'ScanSheet',
      to_email: email,
      email: email,
      recipient_email: email,
      user_email: email,
      reply_to: email,
      to_name: name || 'User',
      user_name: name || 'User',
      name: name || 'User',
      otp_code: otp,
      otp: otp,
      code: otp,
      passcode: otp,
      verification_code: otp,
      pin: otp,
      valid_time: '1 minute 50 seconds',
      subject: 'OTP for Scansheet Registration',
      title: 'OTP for Scansheet Registration',
      message: fullMessage,
      body: fullMessage,
      content: fullMessage,
      text: fullMessage
    };

    // Attempt 1: Official EmailJS SDK if available
    if (window.emailjs && typeof window.emailjs.send === 'function') {
      try {
        const response = await window.emailjs.send(
          this.EMAILJS_CONFIG.SERVICE_ID,
          this.EMAILJS_CONFIG.TEMPLATE_ID,
          templateParams,
          this.EMAILJS_CONFIG.PUBLIC_KEY
        );
        return { success: true, response };
      } catch (sdkError) {
        console.warn('EmailJS SDK send notice:', sdkError);
      }
    }

    // Attempt 2: Direct REST API Endpoint
    try {
      const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: this.EMAILJS_CONFIG.SERVICE_ID,
          template_id: this.EMAILJS_CONFIG.TEMPLATE_ID,
          user_id: this.EMAILJS_CONFIG.PUBLIC_KEY,
          template_params: templateParams
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `Email service error (status ${response.status})`);
      }

      return { success: true };
    } catch (apiError) {
      console.error('EmailJS REST API dispatch error:', apiError);
      throw new Error(apiError.message || 'Unable to deliver verification email.');
    }
  },

  /**
   * Initiates account registration by validating details and sending a 110s OTP
   * @param {Object} data
   * @param {string} data.name
   * @param {string} data.email
   * @param {string} data.password
   * @param {string} data.confirmPassword
   * @returns {Promise<{success: boolean, error?: string, email?: string, expiresAt?: number}>}
   */
  async initiateSignup({ name, email, password, confirmPassword }) {
    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPass = password || '';
    const cleanConfirm = confirmPassword || '';

    if (!cleanName) {
      return { success: false, error: 'Full name is required.' };
    }

    if (!cleanEmail) {
      return { success: false, error: 'Email address is required.' };
    }

    if (!this.isValidEmail(cleanEmail)) {
      return { success: false, error: 'Please enter a valid email address.' };
    }

    if (!cleanPass) {
      return { success: false, error: 'Password is required.' };
    }

    if (cleanPass.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }

    if (cleanPass !== cleanConfirm) {
      return { success: false, error: 'Passwords do not match.' };
    }

    if (!this.supabase?.auth || typeof this.supabase.auth.signUp !== 'function') {
      return { success: false, error: this.getCloudUnavailableMessage() };
    }

    const otp = this.generateOtp();
    const expiresAt = Date.now() + (this.EMAILJS_CONFIG.OTP_VALIDITY_SECONDS * 1000);

    this.pendingRegistration = {
      name: cleanName,
      email: cleanEmail,
      password: cleanPass,
      otp,
      expiresAt
    };

    try {
      await this.sendOtpEmail(cleanEmail, cleanName, otp);
      return {
        success: true,
        email: cleanEmail,
        expiresAt
      };
    } catch (err) {
      this.pendingRegistration = null;
      return {
        success: false,
        error: `Could not send verification email: ${err.message || 'Please check your connection.'}`
      };
    }
  },

  /**
   * Verifies the 6-digit OTP code and creates the real Supabase Auth user
   * @param {string} enteredOtp
   * @returns {Promise<{success: boolean, error?: string, expired?: boolean, requiresConfirmation?: boolean, user?: Object}>}
   */
  async verifyOtp(enteredOtp) {
    if (!this.pendingRegistration) {
      return { success: false, error: 'No pending registration found. Please register again.' };
    }

    const cleanOtp = (enteredOtp || '').toString().trim();
    if (!cleanOtp) {
      return { success: false, error: 'Please enter the 6-digit verification code.' };
    }

    if (Date.now() > this.pendingRegistration.expiresAt) {
      return {
        success: false,
        error: 'OTP has expired. Please click Resend Code to get a new one.',
        expired: true
      };
    }

    if (cleanOtp !== this.pendingRegistration.otp) {
      return {
        success: false,
        error: 'Invalid verification code. Please check your email and try again.'
      };
    }

    const pending = this.pendingRegistration;
    const result = await this.signup({
      name: pending.name,
      email: pending.email,
      password: pending.password,
      confirmPassword: pending.password
    });

    if (result.success) {
      this.pendingRegistration = null;
    } else if (result.error && result.error.toLowerCase().includes('already exists')) {
      this.pendingRegistration = null;
    }

    return result;
  },

  /**
   * Resends a fresh 6-digit OTP and restarts the 1m 50s validity timer
   * @returns {Promise<{success: boolean, error?: string, email?: string, expiresAt?: number}>}
   */
  async resendOtp() {
    if (!this.pendingRegistration) {
      return { success: false, error: 'No registration in progress. Please fill in the sign up form.' };
    }

    const newOtp = this.generateOtp();
    const expiresAt = Date.now() + (this.EMAILJS_CONFIG.OTP_VALIDITY_SECONDS * 1000);

    this.pendingRegistration.otp = newOtp;
    this.pendingRegistration.expiresAt = expiresAt;

    try {
      await this.sendOtpEmail(this.pendingRegistration.email, this.pendingRegistration.name, newOtp);
      return {
        success: true,
        email: this.pendingRegistration.email,
        expiresAt
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to resend code: ${err.message || 'Please try again.'}`
      };
    }
  },

  /**
   * Initiates password recovery flow using Supabase Auth resetPasswordForEmail
   * @param {string} email
   * @returns {Promise<{success: boolean, error?: string, mode?: string, email?: string}>}
   */
  async initiatePasswordRecovery(email) {
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanEmail) {
      return { success: false, error: 'Registered email address is required.' };
    }

    if (!this.isValidEmail(cleanEmail)) {
      return { success: false, error: 'Please enter a valid email address.' };
    }

    if (!this.supabase?.auth || typeof this.supabase.auth.resetPasswordForEmail !== 'function') {
      return { success: false, error: this.getCloudUnavailableMessage() };
    }

    try {
      const { error } = await this.supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: window.location.origin + window.location.pathname
      });
      if (error) {
        return { success: false, error: error.message || 'Failed to send recovery email.' };
      }
      return {
        success: true,
        mode: 'supabase_link',
        email: cleanEmail
      };
    } catch (sbErr) {
      return { success: false, error: sbErr?.message || 'Failed to send recovery email.' };
    }
  },

  /**
   * Legacy recovery OTP methods preserved safely (cloud recovery uses Supabase email links)
   */
  async verifyRecoveryOtp() {
    return {
      success: false,
      error: 'Please use the password reset link sent to your email.'
    };
  },

  async resendRecoveryOtp() {
    return {
      success: false,
      error: 'Please request a new password reset link from Forgot Password.'
    };
  },

  /**
   * Updates user password in Supabase Auth using an active verified recovery session
   * @param {Object} params
   * @param {string} params.newPassword
   * @param {string} params.confirmPassword
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async resetPassword({ newPassword, confirmPassword }) {
    const cleanPass = newPassword || '';
    const cleanConfirm = confirmPassword || '';

    if (!cleanPass || !cleanConfirm) {
      return { success: false, error: 'Both password fields are required.' };
    }

    if (cleanPass.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }

    if (cleanPass !== cleanConfirm) {
      return { success: false, error: 'Passwords do not match.' };
    }

    if (!this.supabase?.auth || typeof this.supabase.auth.updateUser !== 'function') {
      return { success: false, error: this.getCloudUnavailableMessage() };
    }

    try {
      const { data: { user }, error: sessionErr } = await this.supabase.auth.getUser();
      if (sessionErr || !user) {
        return {
          success: false,
          error: 'Recovery session expired or invalid. Open the reset link from your email again.'
        };
      }

      const { error } = await this.supabase.auth.updateUser({ password: cleanPass });
      if (error) {
        return { success: false, error: error.message || 'Failed to update password.' };
      }
      return { success: true };
    } catch (sbErr) {
      return { success: false, error: sbErr?.message || 'Failed to update password.' };
    }
  },

  /**
   * Validates a recovery link token from URL when Supabase client is configured
   * @param {string} token
   * @returns {boolean}
   */
  handleRecoveryLink(token) {
    return Boolean(token && this.supabase?.auth);
  },

  /**
   * Sign out current user from Supabase Auth
   */
  async logout() {
    await this.stopAdminRealtime();
    if (this.supabase?.auth && typeof this.supabase.auth.signOut === 'function') {
      try {
        await this.supabase.auth.signOut();
      } catch (err) {
        console.warn('[Supabase] SignOut notice:', err);
      }
    }
    this.currentUser = null;
    this.setIntendedAction(null);
    this.notifyListeners();
  },

  /**
   * Helper email format validator
   * @param {string} email
   * @returns {boolean}
   */
  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
};
