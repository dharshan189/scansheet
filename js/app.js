/**
 * ScanSheet - Application Controller & Orchestration
 * Step 2: Upload Action, Login Gate, Authentication Flows & History Navigation
 */

import { UI } from './ui.js?v=5.9';
import { Utils } from './utils.js';
import { Auth } from './auth.js';
import { Upload } from './upload.js?v=5.2';
import { History } from './history.js';
import { Crop } from './crop.js';
import { Scanner } from './scanner.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize Core Subsystems
  await Auth.init();
  UI.init();
  Crop.init();
  Upload.init();
  History.init();
  Scanner.init();

  // Resume pending upload/camera action if user just returned from OAuth redirect
  if (Auth.isAuthenticated()) {
    const postAuthAction = Auth.consumeIntendedAction();
    if (postAuthAction === 'upload') {
      setTimeout(() => Upload.openPicker(), 150);
    } else if (postAuthAction === 'camera') {
      setTimeout(() => Upload.openCamera(), 150);
    }
  }

  // Pre-warm OCR worker in idle time so scans execute instantly
  if (window.requestIdleCallback) {
    window.requestIdleCallback(() => Scanner.preloadTesseract(), { timeout: 3000 });
  } else {
    setTimeout(() => Scanner.preloadTesseract(), 1500);
  }

  // Elements
  const uploadActionBtn = Utils.qs('#upload-action-btn');
  const uploadDropZone = Utils.qs('#upload-drop-zone');

  // Gate Modal Triggers
  const gateGoogleBtn = Utils.qs('#gate-google-btn');
  const gateLoginBtn = Utils.qs('#gate-login-btn');
  const gateSignupBtn = Utils.qs('#gate-signup-btn');
  const gateCancelBtn = Utils.qs('#gate-cancel-btn');

  // Google Login Buttons
  const btnGoogleLogin = Utils.qs('#btn-google-login');
  const btnGoogleSignup = Utils.qs('#btn-google-signup');

  // Switch between Login and Sign Up
  const switchSignupLink = Utils.qs('#switch-to-signup');
  const switchLoginLink = Utils.qs('#switch-to-login');

  // Forms
  const loginForm = Utils.qs('#login-form');
  const signupForm = Utils.qs('#signup-form');
  const loginErrorEl = Utils.qs('#login-error-msg');
  const signupErrorEl = Utils.qs('#signup-error-msg');

  // OTP Form Elements
  const otpForm = Utils.qs('#otp-form');
  const otpErrorEl = Utils.qs('#otp-error-msg');
  const btnResendOtp = Utils.qs('#btn-resend-otp');
  const btnOtpChangeEmail = Utils.qs('#btn-otp-change-email');
  const btnSubmitSignup = Utils.qs('#btn-submit-signup');
  const btnSubmitOtp = Utils.qs('#btn-submit-otp');

  // Account Modal Actions
  const btnLogoutAccount = Utils.qs('#btn-account-logout');

  // --------------------------------------------------------------------------
  // 1. UPLOAD BUTTON BEHAVIOR & LOGIN GATE (Requirement 1 & 4)
  // --------------------------------------------------------------------------
  function handleUploadRequest(e) {
    if (e) e.preventDefault();

    if (!Auth.isAuthenticated()) {
      // STATE A — USER IS NOT LOGGED IN
      // Preserve intended action so user seamlessly returns to upload after login
      Auth.setIntendedAction('upload');
      UI.openGateModal();
    } else {
      // STATE B — USER IS LOGGED IN
      Upload.openPicker();
    }
  }

  function handleMobileScanRequest(e) {
    if (e) e.preventDefault();

    if (!Auth.isAuthenticated()) {
      Auth.setIntendedAction('camera');
      UI.openGateModal();
    } else {
      Upload.openCamera();
    }
  }

  const heroBtnUpload = Utils.qs('#hero-btn-upload');
  if (heroBtnUpload) {
    heroBtnUpload.addEventListener('click', handleUploadRequest);
  }

  const heroBtnMobileScan = Utils.qs('#hero-btn-mobile-scan');
  if (heroBtnMobileScan) {
    heroBtnMobileScan.addEventListener('click', handleMobileScanRequest);
  }

  if (uploadActionBtn) {
    uploadActionBtn.addEventListener('click', handleUploadRequest);
  }

  if (uploadDropZone) {
    uploadDropZone.addEventListener('click', (e) => {
      // If clicking button inside, let button listener handle it
      if (e.target.closest('#upload-action-btn')) return;
      handleUploadRequest(e);
    });

    uploadDropZone.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === uploadDropZone) {
        e.preventDefault();
        handleUploadRequest(e);
      }
    });

    // Drag and Drop
    ['dragenter', 'dragover'].forEach(eventType => {
      uploadDropZone.addEventListener(eventType, (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadDropZone.classList.add('drag-active');
      });
    });

    ['dragleave', 'drop'].forEach(eventType => {
      uploadDropZone.addEventListener(eventType, (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadDropZone.classList.remove('drag-active');
        if (eventType === 'drop') {
          if (!Auth.isAuthenticated()) {
            Auth.setIntendedAction('upload');
            UI.openGateModal();
          } else {
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
              Upload.handleSelectedFile(files[0]);
            }
          }
        }
      });
    });
  }

  // Gate Modal Actions
  if (gateLoginBtn) {
    gateLoginBtn.addEventListener('click', () => {
      UI.openLoginModal();
    });
  }

  if (gateSignupBtn) {
    gateSignupBtn.addEventListener('click', () => {
      UI.openSignupModal();
    });
  }

  if (gateCancelBtn) {
    gateCancelBtn.addEventListener('click', () => {
      Auth.setIntendedAction(null);
      UI.closeAllModals();
    });
  }

  // Modal Switching
  if (switchSignupLink) {
    switchSignupLink.addEventListener('click', (e) => {
      e.preventDefault();
      UI.openSignupModal();
    });
  }

  if (switchLoginLink) {
    switchLoginLink.addEventListener('click', (e) => {
      e.preventDefault();
      UI.openLoginModal();
    });
  }

  // --------------------------------------------------------------------------
  // GOOGLE AUTHENTICATION PROCESS ("Continue with Google" via Supabase Auth)
  // --------------------------------------------------------------------------
  function initGoogleIdentity() {
    // Initialize optional Google One Tap / ID Token flow routed through Supabase signInWithIdToken
    if (window.google?.accounts?.id && Auth.GOOGLE_CLIENT_ID) {
      try {
        google.accounts.id.initialize({
          client_id: Auth.GOOGLE_CLIENT_ID,
          callback: async (response) => {
            if (response?.credential) {
              await processSuccessfulGoogleLogin(response.credential);
            }
          }
        });
      } catch (e) {
        console.warn('Google accounts.id initialize error:', e);
      }
    }
  }

  // Attempt Google One Tap initialization when script is loaded
  if (window.google?.accounts) {
    initGoogleIdentity();
  } else {
    window.addEventListener('load', () => {
      setTimeout(initGoogleIdentity, 300);
    });
  }

  async function processSuccessfulGoogleLogin(idToken) {
    const result = await Auth.loginWithGoogle({ idToken });

    if (!result.success) {
      UI.showNotification(result.error || 'Google authentication failed.');
      return;
    }

    const pendingAction = Auth.consumeIntendedAction();

    // Popup box with animated tick
    UI.openLoginSuccessModal({
      name: result.user.name,
      onContinue: () => {
        if (result.user.role === 'admin') {
          updateDashboardView(result.user);
        } else if (pendingAction === 'upload') {
          setTimeout(() => {
            Upload.openPicker();
          }, 100);
        } else if (pendingAction === 'camera') {
          setTimeout(() => {
            Upload.openCamera();
          }, 100);
        }
      }
    });
  }

  async function handleGoogleAuthRequest() {
    UI.showNotification('Connecting to Google Sign-In...');
    const result = await Auth.loginWithGoogle();
    if (!result.success) {
      UI.showNotification(result.error || 'Google authentication failed.');
    }
  }

  if (gateGoogleBtn) {
    gateGoogleBtn.addEventListener('click', handleGoogleAuthRequest);
  }
  if (btnGoogleLogin) {
    btnGoogleLogin.addEventListener('click', handleGoogleAuthRequest);
  }
  if (btnGoogleSignup) {
    btnGoogleSignup.addEventListener('click', handleGoogleAuthRequest);
  }

  // --------------------------------------------------------------------------
  // 2. LOGIN FORM SUBMISSION (Requirement 2 & 4)
  // --------------------------------------------------------------------------
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (loginErrorEl) loginErrorEl.textContent = '';

      const email = Utils.qs('#login-email')?.value;
      const password = Utils.qs('#login-password')?.value;

      const result = await Auth.login({ email, password });

      if (!result.success) {
        if (loginErrorEl) {
          loginErrorEl.textContent = result.error;
          loginErrorEl.style.display = 'block';
        }
        return;
      }

      // Successful authentication
      loginForm.reset();
      const pendingAction = Auth.consumeIntendedAction();

      // Popup box with animated tick
      UI.openLoginSuccessModal({
        name: result.user.name,
        onContinue: () => {
          if (result.user.role === 'admin') {
            updateDashboardView(result.user);
          } else if (pendingAction === 'upload') {
            setTimeout(() => {
              Upload.openPicker();
            }, 100);
          } else if (pendingAction === 'camera') {
            setTimeout(() => {
              Upload.openCamera();
            }, 100);
          }
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // 3. SIGN UP FORM SUBMISSION -> INITIATES EMAIL OTP VERIFICATION
  // --------------------------------------------------------------------------
  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (signupErrorEl) {
        signupErrorEl.textContent = '';
        signupErrorEl.style.display = 'none';
      }

      const name = Utils.qs('#signup-name')?.value;
      const email = Utils.qs('#signup-email')?.value;
      const password = Utils.qs('#signup-password')?.value;
      const confirmPassword = Utils.qs('#signup-confirm-password')?.value;

      // Provide responsive UI button loading feedback
      const originalBtnHtml = btnSubmitSignup?.innerHTML || '<span>Create Account</span>';
      if (btnSubmitSignup) {
        btnSubmitSignup.setAttribute('disabled', 'true');
        btnSubmitSignup.innerHTML = '<span>Sending verification email...</span>';
      }

      try {
        const result = await Auth.initiateSignup({ name, email, password, confirmPassword });

        if (!result.success) {
          if (signupErrorEl) {
            signupErrorEl.textContent = result.error;
            signupErrorEl.style.display = 'block';
          }
          return;
        }

        // Open the OTP Verification Modal with 1m 50s countdown timer
        UI.openOtpModal(result.email, result.expiresAt);
        UI.showNotification(`Verification code sent to ${result.email}`);
      } catch (err) {
        console.error('Registration initiation error:', err);
        if (signupErrorEl) {
          signupErrorEl.textContent = 'Could not initiate registration. Please check your network and try again.';
          signupErrorEl.style.display = 'block';
        }
      } finally {
        if (btnSubmitSignup) {
          btnSubmitSignup.removeAttribute('disabled');
          btnSubmitSignup.innerHTML = originalBtnHtml;
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // 3.1. OTP VERIFICATION FORM SUBMISSION
  // --------------------------------------------------------------------------
  if (otpForm) {
    otpForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (otpErrorEl) {
        otpErrorEl.textContent = '';
        otpErrorEl.style.display = 'none';
      }

      // Collect entered 6-digit code from the inputs
      const digitInputs = Array.from(Utils.qsa('.otp-digit-input'));
      const code = digitInputs.map(input => input.value.trim()).join('');

      if (code.length < 6) {
        if (otpErrorEl) {
          otpErrorEl.textContent = 'Please enter all 6 digits of your verification code.';
          otpErrorEl.style.display = 'block';
        }
        return;
      }

      const origBtnHtml = btnSubmitOtp?.innerHTML || '<span>Verify & Create Account</span>';
      if (btnSubmitOtp) {
        btnSubmitOtp.setAttribute('disabled', 'true');
        btnSubmitOtp.innerHTML = '<span>Verifying code...</span>';
      }

      try {
        const result = await Auth.verifyOtp(code);

        if (!result.success) {
          if (otpErrorEl) {
            otpErrorEl.textContent = result.error;
            otpErrorEl.style.display = 'block';
          }
          if (result.expired) {
            btnResendOtp?.removeAttribute('disabled');
          }
          return;
        }

        // Verification and registration successful!
        if (signupForm) signupForm.reset();
        if (otpForm) otpForm.reset();
        const pendingAction = Auth.consumeIntendedAction();

        // Welcome Success Modal
        if (result.requiresConfirmation) {
          UI.openSuccessModal({
            title: 'Confirm your email to sign in',
            message: `Account created for ${result.user.email}. Click the confirmation link sent by Supabase to your email, then log in.`,
            onContinue: () => {
              UI.openLoginModal();
            }
          });
        } else {
          UI.openSuccessModal({
            title: 'ScanSheet account has been created',
            message: `Welcome, ${result.user.name}! Your account has been verified and created successfully.`,
            onContinue: () => {
              if (pendingAction === 'upload') {
                setTimeout(() => {
                  Upload.openPicker();
                }, 100);
              } else if (pendingAction === 'camera') {
                setTimeout(() => {
                  Upload.openCamera();
                }, 100);
              }
            }
          });
        }
      } catch (err) {
        console.error('OTP verification error:', err);
        if (otpErrorEl) {
          otpErrorEl.textContent = 'Verification failed. Please try again.';
          otpErrorEl.style.display = 'block';
        }
      } finally {
        if (btnSubmitOtp) {
          btnSubmitOtp.removeAttribute('disabled');
          btnSubmitOtp.innerHTML = origBtnHtml;
        }
      }
    });
  }

  // Resend OTP button action
  if (btnResendOtp) {
    btnResendOtp.addEventListener('click', async () => {
      btnResendOtp.setAttribute('disabled', 'true');
      const origText = btnResendOtp.textContent;
      btnResendOtp.textContent = 'Sending...';

      if (otpErrorEl) {
        otpErrorEl.textContent = '';
        otpErrorEl.style.display = 'none';
      }

      const result = await Auth.resendOtp();

      if (!result.success) {
        if (otpErrorEl) {
          otpErrorEl.textContent = result.error;
          otpErrorEl.style.display = 'block';
        }
        btnResendOtp.removeAttribute('disabled');
        btnResendOtp.textContent = origText;
        return;
      }

      btnResendOtp.textContent = 'Resend Code';
      UI.resetOtpInputs();
      UI.startOtpTimer(result.expiresAt);
      UI.showNotification(`New verification code sent to ${result.email}`);

      const firstInput = Utils.qs('#otp-digit-1');
      if (firstInput) firstInput.focus();
    });
  }

  // Change Email or Details (go back to signup modal)
  if (btnOtpChangeEmail) {
    btnOtpChangeEmail.addEventListener('click', () => {
      UI.closeAllModals();
      UI.openSignupModal();
    });
  }

  // --------------------------------------------------------------------------
  // 3.2. FORGOT PASSWORD FORM SUBMISSION (Workflow Step 1 & 2)
  // --------------------------------------------------------------------------
  const forgotForm = Utils.qs('#forgot-form');
  const forgotErrorEl = Utils.qs('#forgot-error-msg');
  const btnForgotContinue = Utils.qs('#btn-forgot-continue');
  const forgotBackToLogin = Utils.qs('#forgot-back-to-login');

  if (forgotBackToLogin) {
    forgotBackToLogin.addEventListener('click', () => {
      UI.closeAllModals();
      UI.openLoginModal();
    });
  }

  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (forgotErrorEl) {
        forgotErrorEl.textContent = '';
        forgotErrorEl.style.display = 'none';
      }

      const email = Utils.qs('#forgot-email')?.value?.trim();

      // Format validation
      if (!email || !Auth.isValidEmail(email)) {
        if (forgotErrorEl) {
          forgotErrorEl.textContent = 'Please enter a valid email address.';
          forgotErrorEl.style.display = 'block';
        }
        return;
      }

      const origHtml = btnForgotContinue?.innerHTML || '<span>Continue</span>';
      if (btnForgotContinue) {
        btnForgotContinue.setAttribute('disabled', 'true');
        btnForgotContinue.innerHTML = '<span>Verifying...</span>';
      }

      try {
        const result = await Auth.initiatePasswordRecovery(email);

        if (!result.success) {
          if (forgotErrorEl) {
            forgotErrorEl.textContent = result.error || 'Failed to verify email. Please try again.';
            forgotErrorEl.style.display = 'block';
          }
          return;
        }

        if (result.mode === 'supabase_link') {
          UI.closeAllModals();
          UI.showNotification(`Password reset link sent to ${result.email}. Please check your email inbox.`);
          return;
        }

        // Fallback recovery verification modal if OTP flow returned
        UI.openRecoveryVerifyModal(result.email, result.expiresAt);
        UI.showNotification(`If registered, a recovery code has been sent to ${result.email}`);
      } catch (err) {
        console.error('Password recovery error:', err);
        if (forgotErrorEl) {
          forgotErrorEl.textContent = 'Unable to proceed with recovery. Please check your network and try again.';
          forgotErrorEl.style.display = 'block';
        }
      } finally {
        if (btnForgotContinue) {
          btnForgotContinue.removeAttribute('disabled');
          btnForgotContinue.innerHTML = origHtml;
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // 3.3. RECOVERY OTP VERIFICATION FORM (Workflow Step 2 -> Step 3)
  // --------------------------------------------------------------------------
  const recoveryVerifyForm = Utils.qs('#recovery-verify-form');
  const recoveryErrorEl = Utils.qs('#recovery-error-msg');
  const btnSubmitRecoveryVerify = Utils.qs('#btn-submit-recovery-verify');
  const btnResendRecovery = Utils.qs('#btn-resend-recovery');
  const btnRecoveryChangeEmail = Utils.qs('#btn-recovery-change-email');

  if (recoveryVerifyForm) {
    recoveryVerifyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (recoveryErrorEl) {
        recoveryErrorEl.textContent = '';
        recoveryErrorEl.style.display = 'none';
      }

      const digits = Array.from(Utils.qsa('.recovery-digit-input'));
      const code = digits.map(input => input.value.trim()).join('');

      if (code.length < 6) {
        if (recoveryErrorEl) {
          recoveryErrorEl.textContent = 'Please enter all 6 digits of your recovery code.';
          recoveryErrorEl.style.display = 'block';
        }
        return;
      }

      const origHtml = btnSubmitRecoveryVerify?.innerHTML || '<span>Continue</span>';
      if (btnSubmitRecoveryVerify) {
        btnSubmitRecoveryVerify.setAttribute('disabled', 'true');
        btnSubmitRecoveryVerify.innerHTML = '<span>Verifying code...</span>';
      }

      try {
        const result = await Auth.verifyRecoveryOtp(code);

        if (!result.success) {
          if (recoveryErrorEl) {
            recoveryErrorEl.textContent = result.error || 'Verification failed. Please check your code.';
            recoveryErrorEl.style.display = 'block';
          }
          if (result.expired) {
            btnResendRecovery?.removeAttribute('disabled');
          }
          return;
        }

        // Account is verified through secure recovery flow -> Proceed to New Password screen (Step 3)
        UI.openResetPasswordModal();
        UI.showNotification('Email verified successfully. Please create your new password.');
      } catch (err) {
        console.error('Recovery code verification error:', err);
        if (recoveryErrorEl) {
          recoveryErrorEl.textContent = 'Verification error. Please try again.';
          recoveryErrorEl.style.display = 'block';
        }
      } finally {
        if (btnSubmitRecoveryVerify) {
          btnSubmitRecoveryVerify.removeAttribute('disabled');
          btnSubmitRecoveryVerify.innerHTML = origHtml;
        }
      }
    });
  }

  if (btnResendRecovery) {
    btnResendRecovery.addEventListener('click', async () => {
      btnResendRecovery.setAttribute('disabled', 'true');
      const origText = btnResendRecovery.textContent;
      btnResendRecovery.textContent = 'Sending...';

      if (recoveryErrorEl) {
        recoveryErrorEl.textContent = '';
        recoveryErrorEl.style.display = 'none';
      }

      const result = await Auth.resendRecoveryOtp();

      if (!result.success) {
        if (recoveryErrorEl) {
          recoveryErrorEl.textContent = result.error || 'Failed to resend code.';
          recoveryErrorEl.style.display = 'block';
        }
        btnResendRecovery.removeAttribute('disabled');
        btnResendRecovery.textContent = origText;
        return;
      }

      btnResendRecovery.textContent = 'Resend Code';
      UI.resetRecoveryInputs();
      UI.startRecoveryTimer(result.expiresAt);
      UI.showNotification(`New recovery code sent to ${result.email}`);

      const firstInput = Utils.qs('#recovery-digit-1');
      if (firstInput) firstInput.focus();
    });
  }

  if (btnRecoveryChangeEmail) {
    btnRecoveryChangeEmail.addEventListener('click', () => {
      const currentEmail = Utils.qs('#recovery-verify-email')?.textContent || '';
      UI.closeAllModals();
      UI.openForgotModal(currentEmail);
    });
  }

  // --------------------------------------------------------------------------
  // 3.4. CREATE NEW PASSWORD FORM SUBMISSION (Workflow Step 3 & 4)
  // --------------------------------------------------------------------------
  const resetPasswordForm = Utils.qs('#reset-password-form');
  const resetErrorEl = Utils.qs('#reset-error-msg');
  const btnSubmitResetPassword = Utils.qs('#btn-submit-reset-password');

  if (resetPasswordForm) {
    resetPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (resetErrorEl) {
        resetErrorEl.textContent = '';
        resetErrorEl.style.display = 'none';
      }

      const newPassword = Utils.qs('#reset-new-password')?.value || '';
      const confirmPassword = Utils.qs('#reset-confirm-password')?.value || '';

      // Validation 1: Both fields are required
      if (!newPassword || !confirmPassword) {
        if (resetErrorEl) {
          resetErrorEl.textContent = 'Both password fields are required.';
          resetErrorEl.style.display = 'block';
        }
        return;
      }

      // Validation 2: Password policy (minimum 6 characters)
      if (newPassword.length < 6) {
        if (resetErrorEl) {
          resetErrorEl.textContent = 'Password must be at least 6 characters.';
          resetErrorEl.style.display = 'block';
        }
        return;
      }

      // Validation 3: Both passwords must match
      if (newPassword !== confirmPassword) {
        if (resetErrorEl) {
          resetErrorEl.textContent = 'Both passwords must match.';
          resetErrorEl.style.display = 'block';
        }
        return;
      }

      const origHtml = btnSubmitResetPassword?.innerHTML || '<span>Reset Password</span>';
      if (btnSubmitResetPassword) {
        btnSubmitResetPassword.setAttribute('disabled', 'true');
        btnSubmitResetPassword.innerHTML = '<span>Updating password...</span>';
      }

      try {
        const result = await Auth.resetPassword({ newPassword, confirmPassword });

        if (!result.success) {
          if (resetErrorEl) {
            resetErrorEl.textContent = result.error || 'Failed to update password. Please try again.';
            resetErrorEl.style.display = 'block';
          }
          return;
        }

        // Workflow Step 4: Display "Your password has been changed successfully." and [Go to Login]
        resetPasswordForm.reset();
        UI.openResetSuccessModal({
          onContinue: () => {
            UI.openLoginModal();
          }
        });
      } catch (err) {
        console.error('Password reset error:', err);
        if (resetErrorEl) {
          resetErrorEl.textContent = 'An error occurred while updating your password. Please try again.';
          resetErrorEl.style.display = 'block';
        }
      } finally {
        if (btnSubmitResetPassword) {
          btnSubmitResetPassword.removeAttribute('disabled');
          btnSubmitResetPassword.innerHTML = origHtml;
        }
      }
    });
  }

  // Handle Supabase password recovery events & redirect tokens
  Auth.onPasswordRecovery(() => {
    UI.openResetPasswordModal();
  });

  try {
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const recoveryToken = urlParams.get('recovery_token') || urlParams.get('token') || hashParams.get('access_token');
    const type = urlParams.get('type') || hashParams.get('type');

    if (recoveryToken && (type === 'recovery' || urlParams.has('recovery_token'))) {
      if (Auth.handleRecoveryLink(recoveryToken)) {
        UI.openResetPasswordModal();
      }
    }
  } catch (urlErr) {
    console.warn('URL recovery parse notice:', urlErr);
  }

  // Account Modal Logout
  if (btnLogoutAccount) {
    btnLogoutAccount.addEventListener('click', () => {
      closeAdminDashboard();
      Auth.logout();
      Upload.reset();
      UI.closeAllModals();
      UI.showNotification('You have logged out.');
    });
  }

  // --------------------------------------------------------------------------
  // 4. HEADER NAVIGATION & AUTH STATE SYNC (Requirement 8 & 10)
  // --------------------------------------------------------------------------
  let cachedAdminTotalUsers = 0;
  let cachedAdminUsers = [];
  let cachedAdminStats = { totalProjects: 0, dailyUploads: 0, filesGenerated: 0 };
  let adminUserFilterTerm = '';
  let isAdminDashboardOpen = false;
  let adminRefreshSeq = 0;
  let adminRealtimeDebounceTimer = null;

  Auth.onAuthStateChanged((user) => {
    updateNavigation(user);
    updateDashboardView(user);
  });

  function updateAdminRealtimeBadge(status) {
    const badge = Utils.qs('#admin-realtime-status');
    if (!badge) return;
    if (!isAdminDashboardOpen) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = 'inline-flex';
    badge.classList.remove('live', 'warning');

    if (status === 'SUBSCRIBED') {
      badge.classList.add('live');
      badge.textContent = 'Live Sync';
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      badge.classList.add('warning');
      badge.textContent = 'Reconnecting...';
    } else if (status === 'UNAVAILABLE') {
      badge.classList.add('warning');
      badge.textContent = 'Sync Offline';
    } else {
      badge.textContent = 'Connecting...';
    }
  }

  function scheduleAdminRefresh(delayMs = 150) {
    if (!isAdminDashboardOpen) return;
    if (adminRealtimeDebounceTimer) {
      clearTimeout(adminRealtimeDebounceTimer);
    }
    adminRealtimeDebounceTimer = setTimeout(() => {
      adminRealtimeDebounceTimer = null;
      if (isAdminDashboardOpen) {
        refreshAdminDashboard();
      }
    }, delayMs);
  }

  function handleAdminOnline() {
    if (!isAdminDashboardOpen) return;
    Auth.ensureAdminRealtimeConnected();
    scheduleAdminRefresh(50);
  }

  function handleAdminVisibilityChange() {
    if (!isAdminDashboardOpen || document.visibilityState !== 'visible') return;
    Auth.ensureAdminRealtimeConnected();
    scheduleAdminRefresh(50);
  }

  function handleAdminUnmount() {
    if (isAdminDashboardOpen) {
      closeAdminDashboard();
    }
  }

  function attachAdminLifecycleListeners() {
    window.addEventListener('online', handleAdminOnline);
    document.addEventListener('visibilitychange', handleAdminVisibilityChange);
    window.addEventListener('pagehide', handleAdminUnmount);
    window.addEventListener('beforeunload', handleAdminUnmount);
  }

  function detachAdminLifecycleListeners() {
    window.removeEventListener('online', handleAdminOnline);
    document.removeEventListener('visibilitychange', handleAdminVisibilityChange);
    window.removeEventListener('pagehide', handleAdminUnmount);
    window.removeEventListener('beforeunload', handleAdminUnmount);
  }

  function openAdminDashboard() {
    const userDashboard = Utils.qs('#user-dashboard');
    const adminDashboard = Utils.qs('#admin-dashboard');
    if (userDashboard) userDashboard.style.display = 'none';
    if (adminDashboard) adminDashboard.style.display = 'block';

    if (isAdminDashboardOpen) {
      Auth.ensureAdminRealtimeConnected();
      return;
    }

    isAdminDashboardOpen = true;
    attachAdminLifecycleListeners();
    updateAdminRealtimeBadge('CONNECTING');
    refreshAdminDashboard();

    Auth.startAdminRealtime({
      onDataChanged: (evt) => {
        if (!isAdminDashboardOpen) return;
        const delay = evt?.reason === 'reconnected' ? 50 : 180;
        scheduleAdminRefresh(delay);
      },
      onStatusChange: (status) => {
        if (!isAdminDashboardOpen) return;
        updateAdminRealtimeBadge(status);
      }
    });
  }

  function closeAdminDashboard() {
    isAdminDashboardOpen = false;
    adminRefreshSeq++;
    if (adminRealtimeDebounceTimer) {
      clearTimeout(adminRealtimeDebounceTimer);
      adminRealtimeDebounceTimer = null;
    }
    detachAdminLifecycleListeners();
    Auth.stopAdminRealtime();

    cachedAdminTotalUsers = 0;
    cachedAdminUsers = [];
    cachedAdminStats = { totalProjects: 0, dailyUploads: 0, filesGenerated: 0 };

    const userDashboard = Utils.qs('#user-dashboard');
    const adminDashboard = Utils.qs('#admin-dashboard');
    const badge = Utils.qs('#admin-realtime-status');
    if (badge) badge.style.display = 'none';
    if (adminDashboard) adminDashboard.style.display = 'none';
    if (userDashboard) userDashboard.style.display = 'block';
  }

  function updateDashboardView(user) {
    if (user && user.role === 'admin') {
      openAdminDashboard();
    } else {
      closeAdminDashboard();
    }
  }

  async function refreshAdminDashboard() {
    if (!isAdminDashboardOpen) return false;
    const seq = ++adminRefreshSeq;
    const overview = await Auth.fetchAdminOverview();
    if (!isAdminDashboardOpen || seq !== adminRefreshSeq) {
      return false;
    }

    if (!overview.success) {
      if (!overview.authorized) {
        closeAdminDashboard();
      }
      if (overview.error) {
        UI.showNotification(overview.error);
      }
      return false;
    }

    cachedAdminTotalUsers = overview.totalUsers;
    cachedAdminUsers = overview.users || [];
    cachedAdminStats = overview.stats || { totalProjects: 0, dailyUploads: 0, filesGenerated: 0 };
    updateAdminStats();
    renderAdminUsersTable();
    return true;
  }

  function updateAdminStats() {
    const userCount = cachedAdminTotalUsers;
    const totalUsersEl = Utils.qs('#stat-total-users');
    if (totalUsersEl) totalUsersEl.textContent = userCount;

    const adminUsersBadge = Utils.qs('#admin-users-badge');
    if (adminUsersBadge) {
      adminUsersBadge.textContent = `${userCount} ${userCount === 1 ? 'User' : 'Users'}`;
    }

    const totalProjectsEl = Utils.qs('#stat-total-projects');
    if (totalProjectsEl) totalProjectsEl.textContent = cachedAdminStats.totalProjects || 0;

    const dailyUploadsEl = Utils.qs('#stat-daily-uploads');
    if (dailyUploadsEl) dailyUploadsEl.textContent = cachedAdminStats.dailyUploads || 0;

    const filesGenEl = Utils.qs('#stat-excel-generated');
    if (filesGenEl) filesGenEl.textContent = cachedAdminStats.filesGenerated || 0;
  }

  function renderAdminUsersTable() {
    const tbody = Utils.qs('#admin-users-tbody');
    const emptyState = Utils.qs('#admin-users-empty');
    if (!tbody) return;

    updateAdminStats();

    const allUsers = cachedAdminUsers;
    const query = adminUserFilterTerm.trim().toLowerCase();

    const filteredUsers = query
      ? allUsers.filter(u => 
          (u.email && u.email.toLowerCase().includes(query)) ||
          (u.name && u.name.toLowerCase().includes(query)) ||
          (u.id && u.id.toLowerCase().includes(query))
        )
      : allUsers;

    if (filteredUsers.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    tbody.innerHTML = filteredUsers.map((user, idx) => {
      const initials = (user.name || user.email || 'U')
        .split(' ')
        .map(n => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

      const isGoogle = user.authProvider === 'google';
      const formattedDate = user.createdAt 
        ? new Date(user.createdAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })
        : 'Registered';

      const avatarHtml = user.picture 
        ? `<img src="${Utils.escapeHtml(user.picture)}" alt="${Utils.escapeHtml(user.name)}" class="admin-user-avatar-img">`
        : `<div class="admin-user-avatar">${Utils.escapeHtml(initials)}</div>`;

      return `
        <tr>
          <td class="admin-index-cell">${idx + 1}</td>
          <td>
            <div class="admin-user-cell">
              ${avatarHtml}
              <div class="admin-user-meta">
                <span class="admin-user-name">${Utils.escapeHtml(user.name || 'Anonymous User')}</span>
                <span class="admin-user-id">${Utils.escapeHtml(user.id || 'usr_')}</span>
              </div>
            </div>
          </td>
          <td>
            <div class="admin-email-wrapper">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                <polyline points="22,6 12,13 2,6"></polyline>
              </svg>
              <span class="admin-email-text">${Utils.escapeHtml(user.email || 'N/A')}</span>
              <button type="button" class="btn-copy-email btn-copy-user-email" data-email="${Utils.escapeHtml(user.email || '')}" title="Copy registered email" aria-label="Copy email">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
            </div>
          </td>
          <td>
            <span class="admin-provider-badge ${isGoogle ? 'admin-provider-google' : 'admin-provider-local'}">
              ${isGoogle ? 'Google Account' : 'Email & Password'}
            </span>
          </td>
          <td class="admin-date-cell">${formattedDate}</td>
          <td>
            <span class="admin-role-badge ${user.role === 'admin' ? 'admin' : ''}">${Utils.escapeHtml(user.role || 'user')}</span>
          </td>
          <td style="text-align: right;">
            <button type="button" class="btn-ghost btn-copy-user-email" data-email="${Utils.escapeHtml(user.email || '')}" style="padding: 4px 8px; font-size: 0.8rem;">
              Copy Email
            </button>
          </td>
        </tr>
      `;
    }).join('');

    // Attach Copy Email event listeners
    Utils.qsa('.btn-copy-user-email', tbody).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const email = btn.getAttribute('data-email');
        if (email) {
          navigator.clipboard.writeText(email).then(() => {
            UI.showNotification(`Copied ${email} to clipboard!`);
          }).catch(() => {
            UI.showNotification(`Email: ${email}`);
          });
        }
      });
    });
  }

  // Admin section listeners
  const adminSearchInput = Utils.qs('#admin-user-search');
  if (adminSearchInput) {
    adminSearchInput.addEventListener('input', (e) => {
      adminUserFilterTerm = e.target.value;
      renderAdminUsersTable();
    });
  }

  const btnAdminRefresh = Utils.qs('#btn-admin-refresh-users');
  if (btnAdminRefresh) {
    btnAdminRefresh.addEventListener('click', async () => {
      const ok = await refreshAdminDashboard();
      if (ok) {
        UI.showNotification('Registered users list refreshed from database.');
      }
    });
  }

  const btnAdminExportUsers = Utils.qs('#btn-admin-export-users');
  if (btnAdminExportUsers) {
    btnAdminExportUsers.addEventListener('click', () => {
      exportUsersToCsv();
    });
  }

  async function exportUsersToCsv() {
    let users = cachedAdminUsers;
    if (users.length === 0) {
      try {
        users = await Auth.fetchRegisteredUsers();
      } catch (err) {
        UI.showNotification(err?.message || 'Unable to export registered users.');
        return;
      }
    }
    if (users.length === 0) {
      UI.showNotification('No registered users to export.');
      return;
    }

    const headers = ['User ID', 'Name', 'Registered Email', 'Auth Provider', 'Role', 'Registered Date'];
    const rows = users.map(u => [
      `"${(u.id || '').replace(/"/g, '""')}"`,
      `"${(u.name || '').replace(/"/g, '""')}"`,
      `"${(u.email || '').replace(/"/g, '""')}"`,
      `"${(u.authProvider || 'email').replace(/"/g, '""')}"`,
      `"${(u.role || 'user').replace(/"/g, '""')}"`,
      `"${(u.createdAt || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ScanSheet_Registered_Users_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    UI.showNotification(`Exported ${users.length} registered users to CSV.`);
  }

  function updateNavigation(user) {
    const navContainers = Utils.qsa('.nav-links-list');

    navContainers.forEach(container => {
      const isDrawer = container.classList.contains('drawer-links-list');
      const prefix = isDrawer ? 'drawer' : 'nav';
      const drawerMobileClass = isDrawer ? ' class="drawer-mobile-only"' : '';

      const primaryLinksHtml = isDrawer ? `
        <li><a href="#main-content" class="nav-link active drawer-nav-home" id="${prefix}-btn-home">Home</a></li>
        <li><button type="button" class="nav-link-btn drawer-nav-features" id="${prefix}-btn-features">Features</button></li>
        <li><button type="button" class="nav-link-btn nav-btn-multi-export" id="${prefix}-btn-multi-export">Multi-Export</button></li>
      ` : '';

      const historyBtnHtml = `<li${drawerMobileClass}><button type="button" class="nav-link-btn ${isDrawer ? 'drawer-nav-history' : 'nav-history-btn'}" id="${prefix}-btn-history"><span aria-hidden="true">🕒</span><span>History</span></button></li>`;
      const logoutBtnHtml = `<li${drawerMobileClass}><button type="button" class="nav-link-btn ${isDrawer ? 'drawer-nav-logout' : 'nav-logout-btn'}" id="${prefix}-btn-logout"><span aria-hidden="true">🚪</span><span>Logout</span></button></li>`;

      if (!user) {
        // STATE: Logged Out
        container.innerHTML = `
          ${primaryLinksHtml}
          ${historyBtnHtml}
          <li${drawerMobileClass}><button type="button" class="btn-primary-sm ${isDrawer ? 'drawer-nav-login' : 'nav-login-btn'}" id="${prefix}-btn-login">Login</button></li>
        `;
      } else if (user.role === 'admin') {
        // STATE: Admin Logged In
        container.innerHTML = `
          ${primaryLinksHtml}
          <li${drawerMobileClass}><span class="admin-nav-pill">Admin Mode</span></li>
          <li${drawerMobileClass}>
            <button type="button" class="nav-user-badge ${isDrawer ? 'drawer-nav-account' : 'nav-account-btn'}" id="${prefix}-btn-account" aria-label="Open Admin Profile">
              <img src="assets/icons/user.svg" alt="" width="16" height="16">
              <span>Admin</span>
            </button>
          </li>
          ${logoutBtnHtml}
        `;
      } else {
        // STATE: Regular User Logged In
        const safeName = Utils.escapeHtml(user.name || 'User');
        container.innerHTML = `
          ${primaryLinksHtml}
          ${historyBtnHtml}
          <li${drawerMobileClass}>
            <button type="button" class="nav-user-badge ${isDrawer ? 'drawer-nav-account' : 'nav-account-btn'}" id="${prefix}-btn-account" aria-label="Open Account Profile">
              <img src="${user.authProvider === 'google' ? 'assets/icons/google.svg' : 'assets/icons/user.svg'}" alt="" width="16" height="16">
              <span>${safeName}</span>
            </button>
          </li>
          ${logoutBtnHtml}
        `;
      }
    });

    // Rebind navigation listeners
    bindNavEvents();
  }

  function bindNavEvents() {
    // Home Link in Side Toggle Bar
    Utils.qsa('#drawer-btn-home, .drawer-nav-home').forEach(link => {
      link.addEventListener('click', () => {
        UI.toggleMobileDrawer(false);
        UI.closeAllModals();
      });
    });

    // Features Buttons (Side Bar Features Content)
    Utils.qsa('#nav-btn-features, #drawer-btn-features, .drawer-nav-features, .nav-features-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        UI.toggleMobileDrawer(false);
        UI.openFeaturesModal();
      });
    });

    // Multi-Export Buttons (Top Bar About Multi-Export Content)
    Utils.qsa('.nav-btn-multi-export').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        UI.toggleMobileDrawer(false);
        UI.openMultiExportInfoModal();
      });
    });

    // History Buttons
    Utils.qsa('#nav-btn-history, #drawer-btn-history, .drawer-nav-history, .nav-history-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        UI.toggleMobileDrawer(false);
        History.open();
      });
    });

    // Login Buttons
    Utils.qsa('#nav-btn-login, #drawer-btn-login, .drawer-nav-login, .nav-login-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        UI.toggleMobileDrawer(false);
        UI.openLoginModal();
      });
    });

    // Account Buttons
    Utils.qsa('#nav-btn-account, #drawer-btn-account, .drawer-nav-account, .nav-account-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        UI.toggleMobileDrawer(false);
        UI.openAccountModal();
      });
    });

    // Logout Buttons
    Utils.qsa('#nav-btn-logout, #drawer-btn-logout, .drawer-nav-logout, .nav-logout-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        UI.toggleMobileDrawer(false);
        closeAdminDashboard();
        Auth.logout();
        Upload.reset();
        UI.showNotification('You have logged out.');
      });
    });
  }

  // --------------------------------------------------------------------------
  // 5. FLOATING MOBILE APK DOWNLOAD BOX (Bottom-Right Corner)
  // --------------------------------------------------------------------------
  const apkBanner = Utils.qs('#mobile-app-download-banner');
  const btnDismissApk = Utils.qs('#btn-dismiss-apk-banner');
  const btnDownloadApk = Utils.qs('#btn-download-apk');

  if (apkBanner) {
    const isNativeCapacitor = Boolean(
      window.Capacitor?.isNativePlatform?.() ||
      window.location.protocol === 'capacitor:' ||
      /; wv\)/i.test(navigator.userAgent || '')
    );
    let wasDismissed = false;
    try {
      wasDismissed = sessionStorage.getItem('scansheet_hide_apk_banner') === '1';
    } catch (_) {}

    if (isNativeCapacitor || wasDismissed) {
      apkBanner.style.display = 'none';
    }

    if (btnDismissApk) {
      btnDismissApk.addEventListener('click', () => {
        apkBanner.style.display = 'none';
        try {
          sessionStorage.setItem('scansheet_hide_apk_banner', '1');
        } catch (_) {}
      });
    }

    if (btnDownloadApk) {
      btnDownloadApk.addEventListener('click', () => {
        UI.showNotification('Downloading ScanSheet.apk for Android...');
        Utils.announce('Downloading ScanSheet Android application.');
      });
    }
  }

  // --------------------------------------------------------------------------
  // NETWORK CONNECTIVITY: SEPARATE FULL OFFLINE PAGE REDIRECTION
  // --------------------------------------------------------------------------
  function navigateToOfflinePage() {
    window.location.replace('/offline.html');
  }

  // If user enters website without internet, navigate to the separate full offline page
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    navigateToOfflinePage();
  }

  // If connection drops during session, navigate to the separate full offline page
  window.addEventListener('offline', () => {
    navigateToOfflinePage();
  });

  console.log('ScanSheet initialized (Step 2: Upload Action & Login Gate Ready).');
});
