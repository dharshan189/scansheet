/**
 * ScanSheet - Core Utilities
 * Lightweight helper functions for DOM manipulation and accessibility
 */

export const Utils = {
  /**
   * Helper selector shortcut
   * @param {string} selector 
   * @param {HTMLElement|Document} scope 
   * @returns {HTMLElement|null}
   */
  qs(selector, scope = document) {
    return scope.querySelector(selector);
  },

  /**
   * Helper selector all shortcut
   * @param {string} selector 
   * @param {HTMLElement|Document} scope 
   * @returns {NodeListOf<HTMLElement>}
   */
  qsa(selector, scope = document) {
    return scope.querySelectorAll(selector);
  },

  /**
   * Announce message to assistive technology screen readers
   * @param {string} message 
   */
  announce(message) {
    const liveRegion = document.getElementById('a11y-live-region');
    if (liveRegion) {
      liveRegion.textContent = '';
      // Small timeout ensures screen readers re-read the updated text
      setTimeout(() => {
        liveRegion.textContent = message;
      }, 50);
    }
  },

  /**
   * Debounce execution of a function
   * @param {Function} fn 
   * @param {number} delay 
   * @returns {Function}
   */
  debounce(fn, delay = 250) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /**
   * Escapes HTML characters for safe rendering
   * @param {string} str 
   * @returns {string}
   */
  escapeHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};
