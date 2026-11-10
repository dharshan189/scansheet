/**
 * ScanSheet - UI Component Handler
 * Step 2: Modals (Gate, Login, Sign Up, History), Mobile Drawer, and Feedback
 */

import { Utils } from './utils.js';
import { Auth } from './auth.js';

export const UI = {
  notificationTimeout: null,

  /**
   * Initializes all UI components, modals, and global keyboard controls
   */
  init() {
    this.toastElement = Utils.qs('#status-toast');
    this.toastMessage = Utils.qs('#status-toast-message');
    this.toastCloseBtn = Utils.qs('#status-toast-close');

    // Modals
    this.featuresModal = Utils.qs('#features-modal');
    this.multiExportInfoModal = Utils.qs('#multi-export-info-modal');
    this.gateModal = Utils.qs('#auth-gate-modal');
    this.loginModal = Utils.qs('#login-modal');
    this.signupModal = Utils.qs('#signup-modal');
    this.otpModal = Utils.qs('#otp-modal');
    this.accountModal = Utils.qs('#account-modal');
    this.successModal = Utils.qs('#signup-success-modal');
    this.loginSuccessModal = Utils.qs('#login-success-modal');
    this.cropModal = Utils.qs('#crop-modal');
    this.mobileDrawer = Utils.qs('#mobile-nav-drawer');
    this.drawerOverlay = Utils.qs('#drawer-backdrop');

    // Forgot Password & Recovery Modals
    this.forgotModal = Utils.qs('#forgot-modal');
    this.recoveryVerifyModal = Utils.qs('#recovery-verify-modal');
    this.resetPasswordModal = Utils.qs('#reset-password-modal');
    this.resetSuccessModal = Utils.qs('#reset-success-modal');

    // OTP Timer reference
    this.otpTimerInterval = null;
    this.recoveryTimerInterval = null;
    this.setupOtpInputs();
    this.setupRecoveryOtpInputs();

    // Toast Close
    if (this.toastCloseBtn) {
      this.toastCloseBtn.addEventListener('click', () => this.hideNotification());
    }

    // Modal Close Buttons
    Utils.qsa('.modal-close-trigger').forEach(btn => {
      btn.addEventListener('click', () => this.closeAllModals());
    });

    // Backdrop Click Dismiss
    Utils.qsa('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.closeAllModals();
        }
      });
    });

    // Side Toggle Bar Menu Button
    const navToggle = Utils.qs('#mobile-menu-toggle');
    const drawerClose = Utils.qs('#drawer-close-btn');

    if (navToggle) {
      navToggle.addEventListener('click', () => {
        const isCurrentlyOpen = this.mobileDrawer?.classList.contains('open');
        this.toggleMobileDrawer(!isCurrentlyOpen);
      });
    }
    if (drawerClose) {
      drawerClose.addEventListener('click', () => this.toggleMobileDrawer(false));
    }
    if (this.drawerOverlay) {
      this.drawerOverlay.addEventListener('click', () => this.toggleMobileDrawer(false));
    }

    // Password Visibility Toggles
    this.setupPasswordToggles();

    // Global Escape Key Listener
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.mobileDrawer?.classList.contains('open')) {
          this.toggleMobileDrawer(false);
        } else {
          this.closeAllModals();
        }
        if (this.toastElement?.classList.contains('visible')) {
          this.hideNotification();
        }
      }
    });

    // Forgot Password Action (Workflow Step 1)
    const forgotBtn = Utils.qs('#btn-forgot-password');
    if (forgotBtn) {
      forgotBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const prefill = Utils.qs('#login-email')?.value?.trim() || '';
        this.openForgotModal(prefill);
      });
    }
  },

  /**
   * Setup password visibility toggles
   */
  setupPasswordToggles() {
    Utils.qsa('.btn-toggle-password').forEach(btn => {
      btn.addEventListener('click', () => {
        const inputId = btn.getAttribute('data-target');
        const input = document.getElementById(inputId);
        const icon = btn.querySelector('img');
        const label = btn.querySelector('.pwd-toggle-label');

        if (input) {
          const isPassword = input.type === 'password';
          input.type = isPassword ? 'text' : 'password';

          if (icon) {
            icon.src = isPassword ? 'assets/icons/eye-off.svg' : 'assets/icons/eye.svg';
          }
          if (label) {
            label.textContent = isPassword ? 'Hide Password' : 'Show Password';
          }
          btn.setAttribute('aria-pressed', isPassword ? 'true' : 'false');
        }
      });
    });
  },

  /**
   * Opens the Login Gate Modal (Requirement 1)
   */
  openGateModal() {
    this.closeAllModals();
    if (this.gateModal) {
      this.gateModal.classList.add('visible');
      this.gateModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      const focusTarget = this.gateModal.querySelector('#gate-login-btn');
      if (focusTarget) focusTarget.focus();
    }
  },

  /**
   * Opens the Features Modal (Top Bar Features Content)
   */
  openFeaturesModal() {
    this.closeAllModals();
    if (this.featuresModal) {
      this.featuresModal.classList.add('visible');
      this.featuresModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }
  },

  /**
   * Opens the About Multi-Export Modal (Top Bar Multi-Export Content)
   */
  openMultiExportInfoModal() {
    this.closeAllModals();
    if (this.multiExportInfoModal) {
      this.multiExportInfoModal.classList.add('visible');
      this.multiExportInfoModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }
  },

  /**
   * Opens the Login Modal (Requirement 2)
   */
  openLoginModal() {
    this.closeAllModals();
    if (this.loginModal) {
      this.loginModal.classList.add('visible');
      this.loginModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      const firstInput = this.loginModal.querySelector('#login-email');
      if (firstInput) firstInput.focus();
    }
  },



  /**
   * Opens the Sign Up Modal (Requirement 3)
   */
  openSignupModal() {
    this.closeAllModals();
    if (this.signupModal) {
      this.signupModal.classList.add('visible');
      this.signupModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      const firstInput = this.signupModal.querySelector('#signup-name');
      if (firstInput) firstInput.focus();
    }
  },

  /**
   * Opens User Profile / Account Modal
   */
  openAccountModal() {
    this.closeAllModals();
    const user = Auth.getUser();
    if (!user) return;

    const nameEl = Utils.qs('#account-user-name');
    const emailEl = Utils.qs('#account-user-email');
    const badgeEl = Utils.qs('#account-provider-badge');
    const avatarCircle = Utils.qs('#account-avatar-circle');

    if (nameEl) nameEl.textContent = user.name;
    if (emailEl) emailEl.textContent = user.email;

    if (badgeEl) {
      badgeEl.style.display = user.authProvider === 'google' ? 'inline-flex' : 'none';
    }

    if (avatarCircle) {
      if (user.authProvider === 'google') {
        const initial = (user.name || user.email || 'G').charAt(0).toUpperCase();
        avatarCircle.style.backgroundColor = '#1e3a8a';
        avatarCircle.style.color = '#ffffff';
        avatarCircle.style.fontWeight = 'bold';
        avatarCircle.innerHTML = `<span>${initial}</span>`;
      } else {
        avatarCircle.style.backgroundColor = '';
        avatarCircle.style.color = '';
        avatarCircle.innerHTML = '<img src="assets/icons/user.svg" alt="" width="28" height="28" id="account-avatar-icon">';
      }
    }

    if (this.accountModal) {
      this.accountModal.classList.add('visible');
      this.accountModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }
  },



  /**
   * Opens Account Created Success Modal with centered logo
   * @param {Object} options
   * @param {string} [options.title]
   * @param {string} [options.message]
   * @param {Function} [options.onContinue]
   */
  openSuccessModal({ title, message, onContinue } = {}) {
    this.closeAllModals();
    if (this.successModal) {
      const titleEl = this.successModal.querySelector('#success-modal-title');
      const descEl = this.successModal.querySelector('#success-modal-desc');
      const continueBtn = this.successModal.querySelector('#btn-success-continue');

      if (title && titleEl) titleEl.textContent = title;
      if (message && descEl) descEl.textContent = message;

      if (continueBtn) {
        const newBtn = continueBtn.cloneNode(true);
        continueBtn.parentNode.replaceChild(newBtn, continueBtn);
        newBtn.addEventListener('click', () => {
          this.closeAllModals();
          if (typeof onContinue === 'function') {
            onContinue();
          }
        });
        setTimeout(() => newBtn.focus(), 50);
      }

      this.successModal.classList.add('visible');
      this.successModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }
  },

  /**
   * Opens Login Success Modal with animated tick
   * @param {Object} options
   * @param {string} [options.name]
   * @param {Function} [options.onContinue]
   */
  openLoginSuccessModal({ name, onContinue } = {}) {
    this.closeAllModals();
    if (this.loginSuccessModal) {
      const subtitleEl = this.loginSuccessModal.querySelector('#login-success-subtitle');
      if (subtitleEl) {
        subtitleEl.textContent = name ? `Welcome back, ${name}!` : 'Welcome back!';
      }

      const tickIcon = this.loginSuccessModal.querySelector('.success-tick-icon');
      if (tickIcon) {
        tickIcon.classList.remove('animating');
        void tickIcon.offsetWidth;
        tickIcon.classList.add('animating');
      }

      let timeoutId = null;
      let isHandled = false;

      const finishAction = () => {
        if (isHandled) return;
        isHandled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        this.closeAllModals();
        if (typeof onContinue === 'function') {
          onContinue();
        }
      };

      const continueBtn = this.loginSuccessModal.querySelector('#btn-login-success-continue');
      if (continueBtn) {
        const newBtn = continueBtn.cloneNode(true);
        continueBtn.parentNode.replaceChild(newBtn, continueBtn);
        newBtn.addEventListener('click', finishAction);
        setTimeout(() => newBtn.focus(), 50);
      }

      // Auto dismiss and continue after 2 seconds
      timeoutId = setTimeout(() => {
        finishAction();
      }, 2000);

      this.loginSuccessModal.classList.add('visible');
      this.loginSuccessModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }
  },

  /**
   * Closes all active modal windows
   */
  closeAllModals() {
    this.stopOtpTimer();
    this.stopRecoveryTimer();

    Utils.qsa('.modal-backdrop').forEach(modal => {
      modal.classList.remove('visible');
      modal.setAttribute('aria-hidden', 'true');
    });

    [
      this.featuresModal,
      this.multiExportInfoModal,
      this.gateModal,
      this.loginModal,
      this.signupModal,
      this.otpModal,
      this.accountModal,
      this.successModal,
      this.loginSuccessModal,
      this.cropModal,
      this.forgotModal,
      this.recoveryVerifyModal,
      this.resetPasswordModal,
      this.resetSuccessModal
    ].forEach(modal => {
      if (modal) {
        modal.classList.remove('visible');
        modal.setAttribute('aria-hidden', 'true');
      }
    });

    document.body.classList.remove('modal-open');
  },

  /**
   * Opens the Email OTP Verification Modal
   * @param {string} email 
   * @param {number} expiresAt 
   */
  openOtpModal(email, expiresAt) {
    this.closeAllModals();
    if (this.otpModal) {
      const emailEl = this.otpModal.querySelector('#otp-modal-email');
      const errorEl = this.otpModal.querySelector('#otp-error-msg');
      const resendBtn = this.otpModal.querySelector('#btn-resend-otp');

      if (emailEl) emailEl.textContent = email || 'your email';
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      }
      if (resendBtn) {
        resendBtn.setAttribute('disabled', 'true');
      }

      // Reset all digit inputs
      this.resetOtpInputs();

      // Start countdown timer
      this.startOtpTimer(expiresAt);

      this.otpModal.classList.add('visible');
      this.otpModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');

      const firstInput = this.otpModal.querySelector('#otp-digit-1');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 60);
      }
    }
  },

  /**
   * Starts OTP expiration countdown timer
   * @param {number} expiresAt Timestamp in milliseconds
   */
  startOtpTimer(expiresAt) {
    this.stopOtpTimer();

    const countdownEl = Utils.qs('#otp-countdown');
    const timerWrapper = Utils.qs('#otp-timer-wrapper');
    const resendBtn = Utils.qs('#btn-resend-otp');

    if (timerWrapper) timerWrapper.classList.remove('expired');

    const updateTimer = () => {
      const remainingMs = Math.max(0, expiresAt - Date.now());
      const totalSeconds = Math.ceil(remainingMs / 1000);

      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      if (countdownEl) {
        countdownEl.textContent = formatted;
      }

      if (totalSeconds <= 0) {
        this.stopOtpTimer();
        if (countdownEl) countdownEl.textContent = '00:00 (Expired)';
        if (timerWrapper) timerWrapper.classList.add('expired');
        if (resendBtn) resendBtn.removeAttribute('disabled');
      }
    };

    updateTimer();
    this.otpTimerInterval = setInterval(updateTimer, 1000);
  },

  /**
   * Stops OTP countdown interval
   */
  stopOtpTimer() {
    if (this.otpTimerInterval) {
      clearInterval(this.otpTimerInterval);
      this.otpTimerInterval = null;
    }
  },

  /**
   * Resets all OTP digit inputs
   */
  resetOtpInputs() {
    const inputs = Utils.qsa('.otp-digit-input');
    inputs.forEach(input => {
      input.value = '';
      input.classList.remove('filled');
    });
  },

  /**
   * Configures smart keyboard and clipboard navigation for the 6 OTP input boxes
   */
  setupOtpInputs() {
    const inputs = Array.from(Utils.qsa('.otp-digit-input'));
    if (!inputs.length) return;

    inputs.forEach((input, index) => {
      // Input event: auto advance
      input.addEventListener('input', () => {
        const val = input.value.replace(/[^0-9]/g, '');
        input.value = val ? val[val.length - 1] : '';

        if (input.value) {
          input.classList.add('filled');
          if (index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        } else {
          input.classList.remove('filled');
        }
      });

      // Keydown: backspace support & navigation
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (!input.value && index > 0) {
            inputs[index - 1].focus();
            inputs[index - 1].value = '';
            inputs[index - 1].classList.remove('filled');
            e.preventDefault();
          } else {
            input.classList.remove('filled');
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          inputs[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      });

      // Paste event: distribute 6 digits across inputs
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData)?.getData('text');
        const digits = (pasted || '').replace(/[^0-9]/g, '').slice(0, 6);

        if (digits) {
          digits.split('').forEach((d, i) => {
            if (inputs[i]) {
              inputs[i].value = d;
              inputs[i].classList.add('filled');
            }
          });

          const nextIndex = Math.min(digits.length, inputs.length - 1);
          inputs[nextIndex]?.focus();
        }
      });
    });
  },

  /**
   * Opens Forgot Password Modal (Workflow Step 1)
   * @param {string} [prefillEmail='']
   */
  openForgotModal(prefillEmail = '') {
    this.closeAllModals();
    if (this.forgotModal) {
      const emailInput = this.forgotModal.querySelector('#forgot-email');
      const errorMsg = this.forgotModal.querySelector('#forgot-error-msg');
      const forgotForm = this.forgotModal.querySelector('#forgot-form');

      if (forgotForm) forgotForm.reset();
      if (errorMsg) {
        errorMsg.textContent = '';
        errorMsg.style.display = 'none';
      }
      if (emailInput) {
        if (prefillEmail) {
          emailInput.value = prefillEmail;
        }
      }

      this.forgotModal.classList.add('visible');
      this.forgotModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');

      setTimeout(() => {
        if (emailInput && !emailInput.value) {
          emailInput.focus();
        } else if (emailInput && emailInput.value) {
          const btn = this.forgotModal.querySelector('#btn-forgot-continue');
          btn?.focus();
        }
      }, 60);
    }
  },

  /**
   * Opens Recovery Verification Modal (Workflow Step 2: Verify Registered Email)
   * @param {string} email
   * @param {number} expiresAt
   */
  openRecoveryVerifyModal(email, expiresAt) {
    this.closeAllModals();
    if (this.recoveryVerifyModal) {
      const emailEl = this.recoveryVerifyModal.querySelector('#recovery-verify-email');
      const errorEl = this.recoveryVerifyModal.querySelector('#recovery-error-msg');
      const resendBtn = this.recoveryVerifyModal.querySelector('#btn-resend-recovery');

      if (emailEl) emailEl.textContent = email || 'your email';
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      }
      if (resendBtn) {
        resendBtn.setAttribute('disabled', 'true');
      }

      this.resetRecoveryInputs();
      this.startRecoveryTimer(expiresAt);

      this.recoveryVerifyModal.classList.add('visible');
      this.recoveryVerifyModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');

      const firstInput = this.recoveryVerifyModal.querySelector('#recovery-digit-1');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 60);
      }
    }
  },

  /**
   * Opens Create New Password Modal (Workflow Step 3)
   */
  openResetPasswordModal() {
    this.closeAllModals();
    if (this.resetPasswordModal) {
      const resetForm = this.resetPasswordModal.querySelector('#reset-password-form');
      const errorMsg = this.resetPasswordModal.querySelector('#reset-error-msg');

      if (resetForm) resetForm.reset();
      if (errorMsg) {
        errorMsg.textContent = '';
        errorMsg.style.display = 'none';
      }

      // Reset password toggle visibility states
      const passInputs = this.resetPasswordModal.querySelectorAll('input[type="text"]');
      passInputs.forEach(input => {
        if (input.id === 'reset-new-password' || input.id === 'reset-confirm-password') {
          input.type = 'password';
        }
      });
      const toggleBtns = this.resetPasswordModal.querySelectorAll('.btn-toggle-password');
      toggleBtns.forEach(btn => {
        const icon = btn.querySelector('img');
        const label = btn.querySelector('.pwd-toggle-label');
        if (icon) icon.src = 'assets/icons/eye.svg';
        if (label) label.textContent = 'Show Password';
        btn.setAttribute('aria-pressed', 'false');
      });

      this.resetPasswordModal.classList.add('visible');
      this.resetPasswordModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');

      const firstInput = this.resetPasswordModal.querySelector('#reset-new-password');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 60);
      }
    }
  },

  /**
   * Opens Password Reset Success Modal (Workflow Step 4)
   * @param {Object} [options]
   * @param {Function} [options.onContinue]
   */
  openResetSuccessModal({ onContinue } = {}) {
    this.closeAllModals();
    if (this.resetSuccessModal) {
      const tickIcon = this.resetSuccessModal.querySelector('.success-tick-icon');
      if (tickIcon) {
        tickIcon.classList.remove('animating');
        void tickIcon.offsetWidth;
        tickIcon.classList.add('animating');
      }

      const goToLoginBtn = this.resetSuccessModal.querySelector('#btn-reset-go-to-login');
      if (goToLoginBtn) {
        const newBtn = goToLoginBtn.cloneNode(true);
        goToLoginBtn.parentNode.replaceChild(newBtn, goToLoginBtn);
        newBtn.addEventListener('click', () => {
          this.closeAllModals();
          if (typeof onContinue === 'function') {
            onContinue();
          } else {
            this.openLoginModal();
          }
        });
        setTimeout(() => newBtn.focus(), 60);
      }

      this.resetSuccessModal.classList.add('visible');
      this.resetSuccessModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }
  },

  /**
   * Starts Recovery OTP expiration countdown timer
   * @param {number} expiresAt Timestamp in milliseconds
   */
  startRecoveryTimer(expiresAt) {
    this.stopRecoveryTimer();

    const countdownEl = Utils.qs('#recovery-countdown');
    const timerWrapper = Utils.qs('#recovery-timer-wrapper');
    const resendBtn = Utils.qs('#btn-resend-recovery');

    if (timerWrapper) timerWrapper.classList.remove('expired');

    const updateTimer = () => {
      const remainingMs = Math.max(0, expiresAt - Date.now());
      const totalSeconds = Math.ceil(remainingMs / 1000);

      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      if (countdownEl) {
        countdownEl.textContent = formatted;
      }

      if (totalSeconds <= 0) {
        this.stopRecoveryTimer();
        if (countdownEl) countdownEl.textContent = '00:00 (Expired)';
        if (timerWrapper) timerWrapper.classList.add('expired');
        if (resendBtn) resendBtn.removeAttribute('disabled');
      }
    };

    updateTimer();
    this.recoveryTimerInterval = setInterval(updateTimer, 1000);
  },

  /**
   * Stops Recovery countdown interval
   */
  stopRecoveryTimer() {
    if (this.recoveryTimerInterval) {
      clearInterval(this.recoveryTimerInterval);
      this.recoveryTimerInterval = null;
    }
  },

  /**
   * Resets all Recovery OTP digit inputs
   */
  resetRecoveryInputs() {
    const inputs = Utils.qsa('.recovery-digit-input');
    inputs.forEach(input => {
      input.value = '';
      input.classList.remove('filled');
    });
  },

  /**
   * Configures smart keyboard and clipboard navigation for the 6 Recovery OTP input boxes
   */
  setupRecoveryOtpInputs() {
    const inputs = Array.from(Utils.qsa('.recovery-digit-input'));
    if (!inputs.length) return;

    inputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        const val = input.value.replace(/[^0-9]/g, '');
        input.value = val ? val[val.length - 1] : '';

        if (input.value) {
          input.classList.add('filled');
          if (index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        } else {
          input.classList.remove('filled');
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (!input.value && index > 0) {
            inputs[index - 1].focus();
            inputs[index - 1].value = '';
            inputs[index - 1].classList.remove('filled');
            e.preventDefault();
          } else {
            input.classList.remove('filled');
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          inputs[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      });

      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData)?.getData('text');
        const digits = (pasted || '').replace(/[^0-9]/g, '').slice(0, 6);

        if (digits) {
          digits.split('').forEach((d, i) => {
            if (inputs[i]) {
              inputs[i].value = d;
              inputs[i].classList.add('filled');
            }
          });

          const nextIndex = Math.min(digits.length, inputs.length - 1);
          inputs[nextIndex]?.focus();
        }
      });
    });
  },

  /**
   * Toggles navigation slide drawer
   * @param {boolean} isOpen 
   */
  toggleMobileDrawer(isOpen) {
    const navToggle = Utils.qs('#mobile-menu-toggle');
    if (navToggle) {
      navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    if (this.mobileDrawer && this.drawerOverlay) {
      if (isOpen) {
        this.mobileDrawer.classList.add('open');
        this.drawerOverlay.classList.add('open');
        this.mobileDrawer.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
      } else {
        this.mobileDrawer.classList.remove('open');
        this.drawerOverlay.classList.remove('open');
        this.mobileDrawer.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
      }
    }
  },

  /**
   * Displays an accessible floating toast notification
   * @param {string} message 
   * @param {number} duration 
   */
  showNotification(message, duration = 4000) {
    if (!this.toastElement || !this.toastMessage) return;

    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }

    this.toastMessage.textContent = message;
    this.toastElement.classList.add('visible');
    this.toastElement.setAttribute('aria-hidden', 'false');

    Utils.announce(message);

    this.notificationTimeout = setTimeout(() => {
      this.hideNotification();
    }, duration);
  },

  /**
   * Hides the active toast notification
   */
  hideNotification() {
    if (!this.toastElement) return;
    this.toastElement.classList.remove('visible');
    this.toastElement.setAttribute('aria-hidden', 'true');
  },

  /**
   * Accessibility announcement helper
   * @param {string} message 
   */
  announce(message) {
    Utils.announce(message);
  }
};
