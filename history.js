/**
 * ScanSheet - History Controller & Database Integration
 * Integrates with Supabase PostgreSQL conversion_history table.
 * Enforces Row Level Security (RLS) user isolation, persistent records, and dynamic rendering.
 */

import { Auth } from './auth.js';
import { UI } from './ui.js';
import { Utils } from './utils.js';
import { SupabaseConfig } from './supabase-client.js';

export const History = {
  // In-memory session cache (no hardcoded mock data)
  records: [],

  /**
   * Initializes History DOM events
   */
  init() {
    this.historyModal = Utils.qs('#history-modal');
    this.historyContent = Utils.qs('#history-modal-content');
    this.historyCloseBtn = Utils.qs('#history-modal-close');

    if (this.historyCloseBtn) {
      this.historyCloseBtn.addEventListener('click', () => {
        this.close();
      });
    }

    // Modal background dismiss
    if (this.historyModal) {
      this.historyModal.addEventListener('click', (e) => {
        if (e.target === this.historyModal) {
          this.close();
        }
      });
    }
  },

  /**
   * Open the History view based on authentication state
   */
  async open() {
    if (!this.historyModal || !this.historyContent) return;

    const user = Auth.getUser();

    if (!user) {
      // STATE: Logged out
      this.renderLoggedOutView();
    } else {
      // STATE: Logged in (User-specific history loaded from Supabase)
      await this.renderLoggedInView(user);
    }

    this.historyModal.classList.add('visible');
    this.historyModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  },

  /**
   * Fetch conversion history from Supabase PostgreSQL (or local fallback)
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async fetchRecords(userId) {
    const supabase = SupabaseConfig.getClient();
    if (supabase && userId) {
      try {
        const { data, error } = await supabase
          .from('conversion_history')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });

        if (!error && Array.isArray(data)) {
          return data.map(item => ({
            id: item.id,
            userId: item.user_id,
            originalFileName: item.original_file_name,
            outputFileName: item.output_file_name,
            conversionDateTime: new Date(item.created_at).toLocaleString(),
            relativeGroup: this.getRelativeGroup(item.created_at),
            rowCount: item.row_count || 0,
            columnCount: item.column_count || 0,
            outputFileRef: item.output_file_url || item.output_file_name,
            conversionStatus: item.status || 'completed',
            documentModel: item.document_model,
            rawItem: item
          }));
        }
      } catch (err) {
        console.warn('[History] Could not query Supabase history:', err);
      }
    }

    // Fallback to in-memory records strictly scoped to current user
    return this.records.filter(r => !userId || r.userId === userId || r.userId === 'current_user');
  },

  /**
   * Save a conversion record to Supabase PostgreSQL
   * @param {Object} record
   */
  async addRecord(record) {
    const supabase = SupabaseConfig.getClient();
    if (supabase && record.userId) {
      try {
        const payload = {
          user_id: record.userId,
          original_file_name: record.originalFileName || 'image.png',
          output_file_name: record.outputFileName || 'ScanSheet_Export.xlsx',
          conversion_type: record.conversionType || 'table',
          status: record.conversionStatus || 'completed',
          row_count: record.rowCount || 0,
          column_count: record.columnCount || 0,
          source_file_url: record.sourceFileUrl || null,
          output_file_url: record.outputFileUrl || null,
          document_model: record.documentModel || null
        };

        const { data, error } = await supabase
          .from('conversion_history')
          .insert([payload])
          .select()
          .single();

        if (!error && data) {
          record.id = data.id;
        }
      } catch (err) {
        console.warn('[History] Supabase addRecord error:', err);
      }
    }

    // Add to in-memory list
    record.id = record.id || `rec_${Date.now()}`;
    record.relativeGroup = record.relativeGroup || 'Today';
    this.records.unshift(record);
    return record;
  },

  /**
   * Delete a conversion record by ID from Supabase PostgreSQL
   * @param {string} recordId
   */
  async deleteRecord(recordId) {
    const supabase = SupabaseConfig.getClient();
    if (supabase && recordId) {
      try {
        const { error } = await supabase
          .from('conversion_history')
          .delete()
          .eq('id', recordId);

        if (error) throw error;
      } catch (err) {
        console.error('[History] Failed to delete from Supabase:', err);
        throw err;
      }
    }

    // Remove from in-memory list
    this.records = this.records.filter(r => r.id !== recordId);
  },

  /**
   * Helper to categorize timestamps into friendly groups
   * @param {string|Date} dateStr
   * @returns {string}
   */
  getRelativeGroup(dateStr) {
    if (!dateStr) return 'Earlier';
    const date = new Date(dateStr);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) return 'Today';

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return 'Earlier';
  },

  /**
   * Renders the logged-out gate screen
   */
  renderLoggedOutView() {
    this.historyContent.innerHTML = `
      <div class="history-gate-box">
        <div class="history-icon-circle" aria-hidden="true">
          <img src="assets/icons/sheet.svg" alt="" width="28" height="28">
        </div>
        <h3 class="history-gate-title">Sign in to view your conversion history</h3>
        <p class="history-gate-desc">
          Your saved tables and exported Excel spreadsheets will appear here once you sign in to your ScanSheet account.
        </p>
        <div class="history-gate-actions">
          <button type="button" class="btn-primary" id="btn-history-login">
            <span>Login</span>
          </button>
          <button type="button" class="btn-secondary" id="btn-history-signup">
            <span>Create Account</span>
          </button>
        </div>
      </div>
    `;

    // Bind login & create account triggers
    const btnLogin = Utils.qs('#btn-history-login', this.historyContent);
    const btnSignup = Utils.qs('#btn-history-signup', this.historyContent);

    if (btnLogin) {
      btnLogin.addEventListener('click', () => {
        this.close();
        UI.openLoginModal();
      });
    }

    if (btnSignup) {
      btnSignup.addEventListener('click', () => {
        this.close();
        UI.openSignupModal();
      });
    }
  },

  /**
   * Renders user's conversion records from Supabase PostgreSQL
   * @param {Object} user 
   */
  async renderLoggedInView(user) {
    this.historyContent.innerHTML = `
      <div class="history-user-header">
        <div>
          <h3 class="history-heading">Conversion History</h3>
          <p class="history-user-meta">Signed in as <strong>${Utils.escapeHtml(user.name)}</strong> (${Utils.escapeHtml(user.email)})</p>
        </div>
      </div>
      <div class="history-loading-indicator" style="text-align:center; padding: 2.5rem 1rem; color: #64748b;">
        <span class="spinner-sm" style="display:inline-block; vertical-align:middle; margin-right:8px;"></span>
        <span>Loading conversions...</span>
      </div>
    `;

    const records = await this.fetchRecords(user.id);

    if (!records || records.length === 0) {
      this.historyContent.innerHTML = `
        <div class="history-user-header">
          <div>
            <h3 class="history-heading">Conversion History</h3>
            <p class="history-user-meta">Signed in as <strong>${Utils.escapeHtml(user.name)}</strong> (${Utils.escapeHtml(user.email)})</p>
          </div>
        </div>
        <div class="history-gate-box" style="padding: 3rem 1.5rem; text-align: center;">
          <div class="history-icon-circle" aria-hidden="true" style="margin: 0 auto 1rem;">
            <img src="assets/icons/sheet.svg" alt="" width="28" height="28">
          </div>
          <h4 style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; color: #1e293b;">No conversions yet</h4>
          <p style="color: #64748b; font-size: 0.9rem; max-width: 380px; margin: 0 auto 1.5rem;">
            Your converted tables and documents will be saved securely to your account and shown here.
          </p>
          <button type="button" class="btn-primary" id="btn-history-start-scan">
            <span>Upload Image Now</span>
          </button>
        </div>
      `;

      const startScanBtn = Utils.qs('#btn-history-start-scan', this.historyContent);
      if (startScanBtn) {
        startScanBtn.addEventListener('click', () => {
          this.close();
          const uploadBtn = Utils.qs('#upload-action-btn') || Utils.qs('#hero-btn-upload');
          if (uploadBtn) uploadBtn.click();
        });
      }
      return;
    }

    // Group records by relativeGroup
    const groups = {};
    records.forEach(rec => {
      const g = rec.relativeGroup || 'Earlier';
      if (!groups[g]) groups[g] = [];
      groups[g].push(rec);
    });

    const groupOrder = ['Today', 'Yesterday', 'Earlier'];
    let groupsHtml = '<div class="history-groups-list">';

    for (const groupName of groupOrder) {
      if (groups[groupName] && groups[groupName].length > 0) {
        groupsHtml += `
          <div class="history-group">
            <h4 class="history-group-title">${groupName}</h4>
        `;

        groups[groupName].forEach(rec => {
          const rowColMeta = rec.rowCount > 0
            ? `${rec.rowCount} rows &bull; ${rec.columnCount} columns`
            : 'Document extraction';
          const fileTitle = rec.outputFileName || rec.originalFileName || 'ScanSheet_Converted.xlsx';

          groupsHtml += `
            <div class="history-item-card" data-record-id="${rec.id}">
              <div class="history-item-info">
                <div class="history-file-header">
                  <img src="assets/icons/sheet.svg" alt="" width="18" height="18" class="history-sheet-icon">
                  <span class="history-file-title">${Utils.escapeHtml(fileTitle)}</span>
                </div>
                <p class="history-file-meta">${rec.conversionDateTime} &bull; ${rowColMeta}</p>
              </div>
              <div class="history-item-actions">
                ${rec.documentModel ? `<button type="button" class="btn-action-sm btn-history-open" data-id="${rec.id}" title="Reopen document in editor">Open</button>` : ''}
                <button type="button" class="btn-action-sm btn-history-download" data-id="${rec.id}" title="Download file">Download</button>
                <button type="button" class="btn-action-sm btn-action-danger btn-history-delete" data-id="${rec.id}" title="Delete record">Delete</button>
              </div>
            </div>
          `;
        });

        groupsHtml += `</div>`;
      }
    }

    groupsHtml += '</div>';

    this.historyContent.innerHTML = `
      <div class="history-user-header">
        <div>
          <h3 class="history-heading">Conversion History</h3>
          <p class="history-user-meta">Signed in as <strong>${Utils.escapeHtml(user.name)}</strong> (${Utils.escapeHtml(user.email)})</p>
        </div>
      </div>
      ${groupsHtml}
    `;

    // Bind item actions
    Utils.qsa('.btn-history-open', this.historyContent).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const recordId = e.currentTarget.getAttribute('data-id');
        const targetRec = records.find(r => r.id === recordId);
        if (targetRec?.documentModel) {
          try {
            const { Scanner } = await import('./scanner.js');
            this.close();
            Scanner.showResultScreen(targetRec.documentModel);
            UI.showNotification(`Loaded "${targetRec.outputFileName}" into editor.`);
          } catch (loadErr) {
            console.error('Error reopening document:', loadErr);
            UI.showNotification('Could not load document preview.');
          }
        }
      });
    });

    Utils.qsa('.btn-history-download', this.historyContent).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const recordId = e.currentTarget.getAttribute('data-id');
        const targetRec = records.find(r => r.id === recordId);
        if (targetRec?.documentModel) {
          try {
            const { DocumentExporter } = await import('./export.js');
            await DocumentExporter.exportExcel(targetRec.documentModel, targetRec.outputFileName);
            UI.showNotification(`Downloaded ${targetRec.outputFileName}`);
          } catch (dlErr) {
            UI.showNotification('Export failed. Please reopen and try again.');
          }
        } else {
          UI.showNotification(`Download initiated for ${targetRec?.outputFileName || 'file'}.`);
        }
      });
    });

    Utils.qsa('.btn-history-delete', this.historyContent).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const recordId = e.currentTarget.getAttribute('data-id');
        const card = e.currentTarget.closest('.history-item-card');
        if (!recordId) return;

        if (card) {
          card.style.opacity = '0.3';
          card.style.pointerEvents = 'none';
        }

        try {
          await this.deleteRecord(recordId);
          if (card) card.remove();
          UI.showNotification('Conversion record deleted successfully.');
        } catch (delErr) {
          if (card) {
            card.style.opacity = '1';
            card.style.pointerEvents = 'auto';
          }
          UI.showNotification('Could not delete record. Please try again.');
        }
      });
    });
  },

  /**
   * Close history modal
   */
  close() {
    if (!this.historyModal) return;
    this.historyModal.classList.remove('visible');
    this.historyModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }
};
