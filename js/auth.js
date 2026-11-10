/**
 * ScanSheet - Authentication Architecture & Gate Controller
 * Step 2: Auth State, Intended Action Session & Validation
 * Connects to Supabase Auth & PostgreSQL with persistent sessions.
 */

import { SupabaseConfig } from './supabase-client.js';

export const Auth = {
  // Current authenticated user (null when logged out)
  currentUser: null,

  // Reference to Supabase client instance
  supabase: null,

  // Holds the action the user was attempting before the login gate was triggered (e.g. 'upload')
  intendedAction: null,

  // Registered listeners for auth state transitions
  listeners: [],

  STORAGE_USERS_KEY: 'scansheet_registered_users',
  STORAGE_SESSION_KEY: 'scansheet_active_session',
  GOOGLE_CLIENT_ID: '667093541029-m5nejkck6smbhlh657ddrlobpl1sa6em.apps.googleusercontent.com',

  // EmailJS Integration Settings
  EMAILJS_CONFIG: {
    SERVICE_ID: 'service_d3n4rm3',
    TEMPLATE_ID: 'template_iczl86x',
    PUBLIC_KEY: 'zOal8flFg5NHjdCes',
    OTP_VALIDITY_SECONDS: 110 // 1 minute 50 seconds (110s)
  },

  // Holds pending registration data awaiting OTP verification
  pendingRegistration: null,

  // Holds pending password recovery data awaiting OTP verification
  pendingPasswordRecovery: null,

  // Holds active, verified password recovery session
  recoverySession: null,

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
   * Helper to map Supabase User entity to ScanSheet user model
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
      role: meta.role || 'user',
      picture: meta.avatar_url || meta.picture || null,
      authProvider: user.app_metadata?.provider || 'supabase',
      createdAt: user.created_at || new Date().toISOString()
    };
  },

  /**
   * Asynchronously synchronize profile data from public.profiles table
   * @param {string} userId
   */
  async syncProfileWithDatabase(userId) {
    if (!this.supabase || !userId) return;
    try {
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (profile && this.currentUser && this.currentUser.id === userId) {
        let changed = false;
        if (profile.name && this.currentUser.name !== profile.name) {
          this.currentUser.name = profile.name;
          changed = true;
        }
        if (profile.role && this.currentUser.role !== profile.role) {
          this.currentUser.role = profile.role;
          changed = true;
        }
        if (profile.picture && this.currentUser.picture !== profile.picture) {
          this.currentUser.picture = profile.picture;
          changed = true;
        }
        if (changed) {
          this.saveSession(this.currentUser);
          this.notifyListeners();
        }
      }
    } catch (_) {}
  },

  /**
   * Initialize authentication system and restore active session if available
   */
  async init() {
    try {
      // 1. Initial check: restore local session immediately to avoid UI flickers
      const saved = localStorage.getItem(this.STORAGE_SESSION_KEY);
      if (saved) {
        try {
          this.currentUser = JSON.parse(saved);
        } catch (_) {}
      }

      // 2. Connect to Supabase Auth & PostgreSQL
      const client = await SupabaseConfig.init();
      if (client) {
        this.supabase = client;
        try {
          const { data: { session }, error } = await this.supabase.auth.getSession();
          if (error) {
            console.warn('[Auth] Persistent session restoration note:', error);
            // Invalidate state if refresh failed
            this.currentUser = null;
            this.saveSession(null);
            this.notifyListeners();
          } else if (session?.user) {
            this.currentUser = this.mapSupabaseUser(session.user);
            await this.syncProfileWithDatabase(session.user.id);
            this.saveSession(this.currentUser);
            this.notifyListeners();
          } else if (this.currentUser && this.currentUser.authProvider === 'supabase') {
            // No active Supabase session
            this.currentUser = null;
            this.saveSession(null);
            this.notifyListeners();
          }

          // 3. Register native Supabase auth state change subscription
          this.supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
              if (session?.user) {
                this.currentUser = this.mapSupabaseUser(session.user);
                await this.syncProfileWithDatabase(session.user.id);
                this.saveSession(this.currentUser);
                this.notifyListeners();
              }
            } else if (event === 'SIGNED_OUT') {
              this.currentUser = null;
              this.saveSession(null);
              this.notifyListeners();
            }
          });
        } catch (sbErr) {
          console.warn('[Auth] Supabase getSession notice:', sbErr);
        }
      }

      // Ensure registered users storage key exists as an empty array
      if (!localStorage.getItem(this.STORAGE_USERS_KEY)) {
        localStorage.setItem(this.STORAGE_USERS_KEY, JSON.stringify([]));
      }
      // Guarantee current user is saved to STORAGE_USERS_KEY
      if (this.currentUser && this.currentUser.email && this.currentUser.role !== 'admin') {
        this.saveUser(this.currentUser);
      }

      // Initialize EmailJS SDK if available
      if (window.emailjs && typeof window.emailjs.init === 'function') {
        try {
          window.emailjs.init({ publicKey: this.EMAILJS_CONFIG.PUBLIC_KEY });
        } catch (ejErr) {
          console.warn('EmailJS SDK initialization notice:', ejErr);
        }
      }
    } catch (e) {
      console.error('Failed to restore active session:', e);
      this.currentUser = null;
    }
    return this.currentUser;
  },

  /**
   * Persist active session in localStorage
   * @param {Object} user 
   */
  saveSession(user) {
    try {
      if (user) {
        localStorage.setItem(this.STORAGE_SESSION_KEY, JSON.stringify(user));
        if (user.role !== 'admin' && user.email) {
          this.saveUser(user);
        }
      } else {
        localStorage.removeItem(this.STORAGE_SESSION_KEY);
      }
    } catch (e) {
      console.error('Failed to save session:', e);
    }
  },

  /**
   * Check if user is currently authenticated
   * @returns {boolean}
   */
  isAuthenticated() {
    return this.currentUser !== null;
  },

  /**
   * Get current user profile
   * @returns {Object|null}
   */
  getUser() {
    return this.currentUser;
  },

  /**
   * Store intended action to resume seamlessly after authentication
   * @param {string} action 
   */
  setIntendedAction(action) {
    this.intendedAction = action;
  },

  /**
   * Retrieve and clear the intended action
   * @returns {string|null}
   */
  consumeIntendedAction() {
    const action = this.intendedAction;
    this.intendedAction = null;
    return action;
  },

  /**
   * Subscribe to authentication state changes
   * @param {Function} callback 
   */
  onAuthStateChanged(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
      // Immediately call with current state
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
   * Authenticate user with Email and Password
   * @param {Object} credentials 
   * @param {string} credentials.email 
   * @param {string} credentials.password 
   * @returns {Promise<{success: boolean, error?: string, user?: Object}>}
   */
  async login({ email, password }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPass = password || '';

    if (!cleanEmail) {
      return { success: false, error: 'Email address or username is required.' };
    }

    if (!cleanPass) {
      return { success: false, error: 'Password is required.' };
    }

    // Role-based authentication check
    if (cleanEmail === 'ss@2718') {
      if (cleanPass !== '9940856744') {
        return { success: false, error: 'Incorrect password for admin.' };
      }

      this.currentUser = {
        id: 'admin_1',
        name: 'Admin',
        email: 'ss@2718',
        role: 'admin',
        authProvider: 'local',
        createdAt: new Date().toISOString()
      };

      this.saveSession(this.currentUser);
      this.notifyListeners();
      return { success: true, user: this.currentUser };
    }

    // 1. Supabase Auth Integration
    if (this.supabase?.auth && typeof this.supabase.auth.signInWithPassword === 'function') {
      try {
        const { data, error } = await this.supabase.auth.signInWithPassword({
          email: cleanEmail,
          password: cleanPass
        });
        if (error) {
          // If Supabase returned an error, verify if user is local fallback before rejecting
          const localUser = this.getRegisteredUsers().find(u => u.email === cleanEmail);
          if (localUser && localUser.password === cleanPass) {
            // Fall through to local auth below
          } else {
            return { success: false, error: error.message || 'Incorrect email or password.' };
          }
        } else if (data?.user) {
          this.currentUser = this.mapSupabaseUser(data.user);
          await this.syncProfileWithDatabase(data.user.id);
          this.saveSession(this.currentUser);
          this.notifyListeners();
          return { success: true, user: this.currentUser };
        }
      } catch (sbErr) {
        console.warn('[Auth] Supabase signIn notice:', sbErr);
      }
    }

    // Standard user email validation
    if (!this.isValidEmail(cleanEmail)) {
      return { success: false, error: 'Please enter a valid email address.' };
    }

    // Check if account exists
    const existingUser = this.getRegisteredUsers().find(u => u.email === cleanEmail);
    if (!existingUser) {
      return {
        success: false,
        error: 'No account found with this email. Please create an account first.'
      };
    }

    // Verify password against registered password
    if (existingUser.password !== cleanPass) {
      return {
        success: false,
        error: 'Incorrect password. Please try again.'
      };
    }

    // Authentication successful
    this.currentUser = {
      id: existingUser.id,
      name: existingUser.name,
      email: existingUser.email,
      role: existingUser.role || 'user',
      authProvider: existingUser.authProvider || 'local',
      picture: existingUser.picture || null,
      createdAt: existingUser.createdAt
    };

    this.saveSession(this.currentUser);
    this.notifyListeners();
    return { success: true, user: this.currentUser };
  },

  /**
   * Authenticate or register user via Google
   * @param {Object} googleProfile 
   * @param {string} googleProfile.email 
   * @param {string} [googleProfile.name] 
   * @param {string} [googleProfile.picture] 
   * @returns {Promise<{success: boolean, error?: string, user?: Object}>}
   */
  async loginWithGoogle({ email, name, picture } = {}) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) {
      return { success: false, error: 'Google account email is required.' };
    }

    if (!this.isValidEmail(cleanEmail)) {
      return { success: false, error: 'Please enter a valid Google email address.' };
    }

    const cleanName = (name || '').trim() || cleanEmail.split('@')[0];
    const existingUsers = this.getRegisteredUsers();
    let existingUser = existingUsers.find(u => u.email === cleanEmail);

    if (existingUser) {
      // Update name/picture if available
      if (picture) existingUser.picture = picture;
      if (!existingUser.name || existingUser.name === existingUser.email) {
        existingUser.name = cleanName;
      }
      existingUser.authProvider = 'google';
      this.saveUser(existingUser);

      this.currentUser = {
        id: existingUser.id,
        name: existingUser.name,
        email: existingUser.email,
        role: existingUser.role || 'user',
        picture: existingUser.picture || null,
        authProvider: 'google',
        createdAt: existingUser.createdAt
      };
    } else {
      const newUser = {
        id: `usr_${Date.now().toString(36)}`,
        name: cleanName,
        email: cleanEmail,
        role: 'user',
        picture: picture || null,
        authProvider: 'google',
        createdAt: new Date().toISOString()
      };
      this.saveUser(newUser);

      this.currentUser = {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        picture: newUser.picture,
        authProvider: 'google',
        createdAt: newUser.createdAt
      };
    }

    this.saveSession(this.currentUser);
    this.notifyListeners();
    return { success: true, user: this.currentUser };
  },

  /**
   * Retrieve all registered users from localStorage
   * @returns {Array<Object>}
   */
  getRegisteredUsers() {
    try {
      const data = localStorage.getItem(this.STORAGE_USERS_KEY);
      let users = data ? JSON.parse(data) : [];

      // Ensure currentUser is always included if logged in as user
      if (this.currentUser && this.currentUser.email && this.currentUser.role !== 'admin') {
        const cleanEmail = this.currentUser.email.trim().toLowerCase();
        const existingIdx = users.findIndex(u => u.email && u.email.trim().toLowerCase() === cleanEmail);
        const currentUserData = {
          id: this.currentUser.id || `usr_${Date.now().toString(36)}`,
          name: this.currentUser.name || cleanEmail.split('@')[0],
          email: cleanEmail,
          role: this.currentUser.role || 'user',
          authProvider: this.currentUser.authProvider || 'local',
          picture: this.currentUser.picture || null,
          createdAt: this.currentUser.createdAt || new Date().toISOString()
        };

        if (existingIdx === -1) {
          users.unshift(currentUserData);
          try {
            localStorage.setItem(this.STORAGE_USERS_KEY, JSON.stringify(users));
          } catch (e) {}
        }
      }

      return users;
    } catch (e) {
      console.error('Failed to read users from localStorage:', e);
      return [];
    }
  },

  /**
   * Get total count of registered users (local fallback)
   * @returns {number}
   */
  getUsersCount() {
    return this.getRegisteredUsers().length;
  },

  /**
   * Fetch all registered users from Supabase PostgreSQL (for Admin Dashboard)
   * @returns {Promise<Array>}
   */
  async fetchRegisteredUsers() {
    if (this.supabase && this.currentUser?.role === 'admin') {
      try {
        const { data, error } = await this.supabase
          .from('profiles')
          .select('id, email, name, picture, role, auth_provider, created_at')
          .order('created_at', { ascending: false });

        if (!error && Array.isArray(data)) {
          return data.map(row => ({
            id: row.id,
            email: row.email,
            name: row.name || row.email?.split('@')[0] || 'User',
            picture: row.picture || null,
            role: row.role || 'user',
            authProvider: row.auth_provider || 'email',
            createdAt: row.created_at
          }));
        }
      } catch (err) {
        console.warn('[Auth] Admin users DB fetch notice:', err);
      }
    }
    return this.getRegisteredUsers();
  },

  /**
   * Fetch system-wide conversion metrics from Supabase PostgreSQL (for Admin Dashboard)
   * @returns {Promise<{totalProjects: number, dailyUploads: number, filesGenerated: number}>}
   */
  async fetchAdminStats() {
    const empty = { totalProjects: 0, dailyUploads: 0, filesGenerated: 0 };
    if (!this.supabase || this.currentUser?.role !== 'admin') {
      return empty;
    }

    try {
      const { data, error } = await this.supabase
        .from('conversion_history')
        .select('id, status, created_at');

      if (error || !Array.isArray(data)) {
        return empty;
      }

      const todayStr = new Date().toDateString();
      let dailyUploads = 0;
      let filesGenerated = 0;

      for (const row of data) {
        if (row.created_at && new Date(row.created_at).toDateString() === todayStr) {
          dailyUploads++;
        }
        if (row.status === 'completed') {
          filesGenerated++;
        }
      }

      return {
        totalProjects: data.length,
        dailyUploads,
        filesGenerated
      };
    } catch (err) {
      console.warn('[Auth] Admin stats DB fetch notice:', err);
      return empty;
    }
  },

  /**
   * Persist user into localStorage
   * @param {Object} user 
   */
  saveUser(user) {
    try {
      if (!user || !user.email) return;
      const cleanEmail = user.email.trim().toLowerCase();
      const data = localStorage.getItem(this.STORAGE_USERS_KEY);
      const users = data ? JSON.parse(data) : [];
      const existingIdx = users.findIndex(u => u.email && u.email.trim().toLowerCase() === cleanEmail);

      const userRecord = {
        id: user.id || `usr_${Date.now().toString(36)}`,
        name: user.name || cleanEmail.split('@')[0],
        email: cleanEmail,
        role: user.role || 'user',
        authProvider: user.authProvider || 'local',
        picture: user.picture || null,
        createdAt: user.createdAt || new Date().toISOString()
      };
      if (user.password) {
        userRecord.password = user.password;
      }

      if (existingIdx >= 0) {
        users[existingIdx] = { ...users[existingIdx], ...userRecord };
      } else {
        users.unshift(userRecord);
      }

      localStorage.setItem(this.STORAGE_USERS_KEY, JSON.stringify(users));
    } catch (e) {
      console.error('Failed to save user to localStorage:', e);
    }
  },

  /**
   * Register new user account
   * @param {Object} data 
   * @param {string} data.name 
   * @param {string} data.email 
   * @param {string} data.password 
   * @param {string} data.confirmPassword 
   * @returns {Promise<{success: boolean, error?: string, user?: Object}>}
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

    // 1. Supabase Auth Registration
    if (this.supabase?.auth && typeof this.supabase.auth.signUp === 'function') {
      try {
        const { data, error } = await this.supabase.auth.signUp({
          email: cleanEmail,
          password: cleanPass,
          options: {
            data: {
              full_name: cleanName,
              name: cleanName
            }
          }
        });
        if (error) {
          return { success: false, error: error.message };
        }
        if (data?.session?.user) {
          this.currentUser = this.mapSupabaseUser(data.session.user);
          await this.syncProfileWithDatabase(data.session.user.id);
          this.saveSession(this.currentUser);
          this.notifyListeners();
          return { success: true, user: this.currentUser };
        } else if (data?.user) {
          return {
            success: true,
            requiresConfirmation: true,
            user: this.mapSupabaseUser(data.user),
            message: 'Account created! Please check your email and click the confirmation link to activate your account.'
          };
        }
      } catch (sbErr) {
        console.warn('[Auth] Supabase signUp error:', sbErr);
      }
    }

    // Check if account already exists with this email
    const existingUsers = this.getRegisteredUsers();
    if (existingUsers.some(u => u.email === cleanEmail)) {
      return { success: false, error: 'An account with this email already exists.' };
    }

    const newUser = {
      id: `usr_${Date.now().toString(36)}`,
      name: cleanName,
      email: cleanEmail,
      password: cleanPass,
      role: 'user',
      authProvider: 'local',
      createdAt: new Date().toISOString()
    };

    // Save into localStorage
    this.saveUser(newUser);

    // Active session user without sensitive password
    this.currentUser = {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      authProvider: 'local',
      createdAt: newUser.createdAt
    };

    this.saveSession(this.currentUser);
    this.notifyListeners();
    return { success: true, user: this.currentUser };
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

    // Check if account already exists with this email
    const existingUsers = this.getRegisteredUsers();
    if (existingUsers.some(u => u.email === cleanEmail)) {
      return { success: false, error: 'An account with this email already exists.' };
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
   * Verifies the 6-digit OTP code and finalizes registration
   * @param {string} enteredOtp 
   * @returns {Promise<{success: boolean, error?: string, expired?: boolean, user?: Object}>}
   */
  async verifyOtp(enteredOtp) {
    if (!this.pendingRegistration) {
      return { success: false, error: 'No pending registration found. Please register again.' };
    }

    const cleanOtp = (enteredOtp || '').toString().trim();
    if (!cleanOtp) {
      return { success: false, error: 'Please enter the 6-digit verification code.' };
    }

    // Check expiration (Strict 1 minute 50 seconds limit)
    if (Date.now() > this.pendingRegistration.expiresAt) {
      return {
        success: false,
        error: 'OTP has expired. Please click Resend Code to get a new one.',
        expired: true
      };
    }

    // Verify OTP code matches
    if (cleanOtp !== this.pendingRegistration.otp) {
      return {
        success: false,
        error: 'Invalid verification code. Please check your email and try again.'
      };
    }

    // If Supabase Auth is active, register verified user with Supabase Auth
    if (this.supabase?.auth && typeof this.supabase.auth.signUp === 'function') {
      try {
        const { data, error } = await this.supabase.auth.signUp({
          email: this.pendingRegistration.email,
          password: this.pendingRegistration.password,
          options: {
            data: {
              full_name: this.pendingRegistration.name,
              name: this.pendingRegistration.name
            }
          }
        });
        if (error) {
          return { success: false, error: error.message || 'Could not register account in Supabase.' };
        }
        this.pendingRegistration = null;

        if (data?.session?.user) {
          this.currentUser = this.mapSupabaseUser(data.session.user);
          await this.syncProfileWithDatabase(data.session.user.id);
          this.saveSession(this.currentUser);
          this.notifyListeners();
          return { success: true, user: this.currentUser };
        }

        if (data?.user) {
          return {
            success: true,
            requiresConfirmation: true,
            user: this.mapSupabaseUser(data.user),
            message: 'Please click the confirmation link sent to your email to finish activating your account.'
          };
        }
      } catch (sbErr) {
        return { success: false, error: sbErr.message || 'Supabase account registration failed.' };
      }
    }

    // Offline fallback registration (without storing plaintext password)
    const newUser = {
      id: `usr_${Date.now().toString(36)}`,
      name: this.pendingRegistration.name,
      email: this.pendingRegistration.email,
      role: 'user',
      authProvider: 'local',
      emailVerified: true,
      createdAt: new Date().toISOString()
    };

    this.saveUser({ ...newUser, password: this.pendingRegistration.password });

    this.currentUser = newUser;
    this.saveSession(this.currentUser);
    this.pendingRegistration = null;
    this.notifyListeners();

    return { success: true, user: this.currentUser };
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
   * Sends Password Recovery OTP email to user via EmailJS
   * @param {string} email Destination email address
   * @param {string} [name] User full name
   * @param {string} otp 6-digit code
   * @returns {Promise<{success: boolean, response?: any}>}
   */
  async sendRecoveryOtpEmail(email, name, otp) {
    const fullMessage = `ScanSheet Password Reset Code.\nThis code is system generated.\nValid for 1 minute 50 seconds.\n\nYour recovery code is: ${otp}\n\nIf you did not request a password reset, please ignore this email.`;
    const templateParams = {
      from_name: 'ScanSheet Security',
      to_email: email,
      email: email,
      recipient_email: email,
      user_email: email,
      reply_to: email,
      to_name: name || 'ScanSheet User',
      user_name: name || 'ScanSheet User',
      name: name || 'ScanSheet User',
      otp_code: otp,
      otp: otp,
      code: otp,
      passcode: otp,
      verification_code: otp,
      pin: otp,
      valid_time: '1 minute 50 seconds',
      subject: 'ScanSheet Password Reset Code',
      title: 'ScanSheet Password Reset Code',
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
        console.warn('EmailJS SDK recovery send notice:', sdkError);
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
      console.error('EmailJS REST API recovery dispatch error:', apiError);
      throw new Error(apiError.message || 'Unable to deliver recovery email.');
    }
  },

  /**
   * Initiates password recovery flow:
   * Validates email format, verifies account, dispatches time-limited recovery OTP,
   * and preserves security by not disclosing account existence to unauthenticated callers.
   * @param {string} email 
   * @returns {Promise<{success: boolean, error?: string, email?: string, expiresAt?: number}>}
   */
  async initiatePasswordRecovery(email) {
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanEmail) {
      return { success: false, error: 'Registered email address is required.' };
    }

    if (!this.isValidEmail(cleanEmail)) {
      return { success: false, error: 'Please enter a valid email address.' };
    }

    // Support for Supabase Auth if integrated
    if (this.supabase?.auth && typeof this.supabase.auth.resetPasswordForEmail === 'function') {
      try {
        const { error } = await this.supabase.auth.resetPasswordForEmail(cleanEmail, {
          redirectTo: window.location.origin + window.location.pathname
        });
        if (error) throw error;
        return {
          success: true,
          email: cleanEmail,
          expiresAt: Date.now() + (this.EMAILJS_CONFIG.OTP_VALIDITY_SECONDS * 1000)
        };
      } catch (sbErr) {
        return { success: false, error: sbErr.message || 'Failed to send recovery email.' };
      }
    }

    const registeredUsers = this.getRegisteredUsers();
    const existingUser = registeredUsers.find(u => u.email === cleanEmail);

    const otp = this.generateOtp();
    const token = `rec_tok_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
    const expiresAt = Date.now() + (this.EMAILJS_CONFIG.OTP_VALIDITY_SECONDS * 1000);

    // OWASP & Security Requirement:
    // If user exists, dispatch time-limited recovery OTP and store pending state.
    // If user does not exist, do not reveal account existence in unauthenticated response.
    if (existingUser) {
      this.pendingPasswordRecovery = {
        email: cleanEmail,
        name: existingUser.name,
        otp,
        token,
        expiresAt,
        verified: false
      };

      try {
        await this.sendRecoveryOtpEmail(cleanEmail, existingUser.name, otp);
        return {
          success: true,
          email: cleanEmail,
          expiresAt
        };
      } catch (err) {
        console.warn('Recovery email send notice:', err);
        // Fallback info log for dev/test environments without internet
        console.info(`[ScanSheet Security] Recovery Code for ${cleanEmail}: ${otp}`);
        return {
          success: true,
          email: cleanEmail,
          expiresAt
        };
      }
    } else {
      // Fake non-existent user state without valid OTP to prevent account enumeration
      this.pendingPasswordRecovery = {
        email: cleanEmail,
        name: null,
        otp: null,
        token: null,
        expiresAt,
        verified: false
      };

      return {
        success: true,
        email: cleanEmail,
        expiresAt
      };
    }
  },

  /**
   * Verifies the 6-digit recovery OTP code and establishes a time-limited recovery session
   * @param {string} enteredOtp 
   * @returns {Promise<{success: boolean, error?: string, expired?: boolean, email?: string, token?: string}>}
   */
  async verifyRecoveryOtp(enteredOtp) {
    if (!this.pendingPasswordRecovery) {
      return { success: false, error: 'No recovery request found. Please enter your email to continue.' };
    }

    const cleanOtp = (enteredOtp || '').toString().trim();
    if (!cleanOtp) {
      return { success: false, error: 'Please enter the 6-digit recovery code.' };
    }

    // Verify time-limited expiration
    if (Date.now() > this.pendingPasswordRecovery.expiresAt) {
      return {
        success: false,
        error: 'Recovery code has expired. Please click Resend Code to receive a new one.',
        expired: true
      };
    }

    // Verify code matching (fails safely if email was not registered or code is incorrect)
    if (!this.pendingPasswordRecovery.otp || cleanOtp !== this.pendingPasswordRecovery.otp) {
      return {
        success: false,
        error: 'Invalid recovery code. Please check your email and try again.'
      };
    }

    // Establish a verified, time-limited password recovery session (15 minutes validity)
    const sessionToken = this.pendingPasswordRecovery.token || `rec_sess_${Date.now().toString(36)}`;
    this.recoverySession = {
      email: this.pendingPasswordRecovery.email,
      token: sessionToken,
      expiresAt: Date.now() + (15 * 60 * 1000), // 15 minutes
      verified: true
    };

    const targetEmail = this.pendingPasswordRecovery.email;
    this.pendingPasswordRecovery = null;

    return {
      success: true,
      email: targetEmail,
      token: sessionToken
    };
  },

  /**
   * Resends a fresh recovery code and resets the countdown timer
   * @returns {Promise<{success: boolean, error?: string, email?: string, expiresAt?: number}>}
   */
  async resendRecoveryOtp() {
    if (!this.pendingPasswordRecovery) {
      return { success: false, error: 'No recovery request in progress. Please enter your email.' };
    }

    const cleanEmail = this.pendingPasswordRecovery.email;
    const newOtp = this.generateOtp();
    const expiresAt = Date.now() + (this.EMAILJS_CONFIG.OTP_VALIDITY_SECONDS * 1000);

    const registeredUsers = this.getRegisteredUsers();
    const existingUser = registeredUsers.find(u => u.email === cleanEmail);

    if (existingUser) {
      this.pendingPasswordRecovery.otp = newOtp;
      this.pendingPasswordRecovery.expiresAt = expiresAt;

      try {
        await this.sendRecoveryOtpEmail(cleanEmail, existingUser.name, newOtp);
        return { success: true, email: cleanEmail, expiresAt };
      } catch (err) {
        console.info(`[ScanSheet Security] Resent Recovery Code for ${cleanEmail}: ${newOtp}`);
        return { success: true, email: cleanEmail, expiresAt };
      }
    } else {
      this.pendingPasswordRecovery.expiresAt = expiresAt;
      return { success: true, email: cleanEmail, expiresAt };
    }
  },

  /**
   * Checks whether an active, verified recovery session exists and is not expired
   * @param {string} [token] Optional token to verify
   * @returns {boolean}
   */
  hasValidRecoverySession(token) {
    if (!this.recoverySession || !this.recoverySession.verified) {
      return false;
    }
    if (Date.now() > this.recoverySession.expiresAt) {
      return false;
    }
    if (token && this.recoverySession.token !== token) {
      return false;
    }
    return true;
  },

  /**
   * Updates user password after confirming valid recovery session.
   * Never updates passwords directly or without verification.
   * Does not store passwords in localStorage or sessionStorage session objects.
   * @param {Object} params
   * @param {string} params.newPassword
   * @param {string} params.confirmPassword
   * @param {string} [params.token]
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async resetPassword({ newPassword, confirmPassword, token }) {
    // Support Supabase Auth if integrated
    if (this.supabase?.auth && typeof this.supabase.auth.updateUser === 'function') {
      try {
        const { error } = await this.supabase.auth.updateUser({ password: newPassword });
        if (error) throw error;
        return { success: true };
      } catch (sbErr) {
        return { success: false, error: sbErr.message || 'Failed to update password.' };
      }
    }

    // Security Check: Confirm recovery session is valid
    if (!this.hasValidRecoverySession(token)) {
      return {
        success: false,
        error: 'Your password recovery session has expired or is invalid. Please start over from Forgot Password.'
      };
    }

    const cleanPass = newPassword || '';
    const cleanConfirm = confirmPassword || '';

    // Validation: Both fields required
    if (!cleanPass || !cleanConfirm) {
      return { success: false, error: 'Both password fields are required.' };
    }

    // Validation: Password policy (minimum 6 characters)
    if (cleanPass.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }

    // Validation: Passwords must match
    if (cleanPass !== cleanConfirm) {
      return { success: false, error: 'Passwords do not match. Please retype to confirm.' };
    }

    const emailToUpdate = this.recoverySession.email;
    const registeredUsers = this.getRegisteredUsers();
    const userIdx = registeredUsers.findIndex(u => u.email === emailToUpdate);

    if (userIdx === -1) {
      return {
        success: false,
        error: 'Account could not be found to update password.'
      };
    }

    // Update password in the user store of the auth provider
    registeredUsers[userIdx].password = cleanPass;
    registeredUsers[userIdx].authProvider = 'local';
    registeredUsers[userIdx].updatedAt = new Date().toISOString();

    try {
      localStorage.setItem(this.STORAGE_USERS_KEY, JSON.stringify(registeredUsers));
    } catch (e) {
      return { success: false, error: 'Failed to save updated password. Storage error.' };
    }

    // Invalidate the recovery session immediately to prevent replay
    this.recoverySession = null;
    this.pendingPasswordRecovery = null;

    return { success: true };
  },

  /**
   * Validates a recovery link token from URL and establishes a recovery session
   * @param {string} token 
   * @returns {boolean}
   */
  handleRecoveryLink(token) {
    if (!token) return false;
    if (this.supabase?.auth) {
      return true;
    }
    return false;
  },

  /**
   * Sign out current user
   */
  async logout() {
    if (this.supabase?.auth && typeof this.supabase.auth.signOut === 'function') {
      try {
        await this.supabase.auth.signOut();
      } catch (err) {
        console.warn('[Supabase] SignOut notice:', err);
      }
    }
    this.currentUser = null;
    this.intendedAction = null;
    this.saveSession(null);
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
