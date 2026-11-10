/**
 * ScanSheet - Table Scanning & Recognition Controller
 *
 * Computer Vision Table Extraction Pipeline:
 *   1. Preprocess & Scale Canvas (Adaptive Dimensions)
 *   2. Bradley-Roth Integral Image Adaptive Binarization (Immune to Shadows & Lighting)
 *   3. Morphological Line Detection (Horizontal & Vertical Kernel Openings)
 *   4. Ruled & Borderless Layout Analysis (Whitespace Gutters & Projections)
 *   5. Tesseract.js OCR with Cached Worker & Timeout Guard
 *   6. Spatial Cell Association: Binds OCR Words to Geometric Grid Cells
 *   7. Interactive Spreadsheet Rendering with Cell Editing & CSV/Excel Export
 */

import { Utils } from './utils.js';
import { UI } from './ui.js';
import { History } from './history.js';
import { Auth } from './auth.js';
import { ImagePreprocessor } from './preprocessor.js';
import { DocumentExporter } from './export.js';

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTER VISION TABLE DETECTOR ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export const TableDetector = {
  /**
   * Evaluates canvas pixels to detect table structures:
   * Returns: { type: 'bordered'|'ruled'|'borderless', rowsY, colsX, rowCount, colCount, binary } or null
   */
  detect(ctx, width, height) {
    try {
      // High-speed analysis scaling: downscale to max 800px for instant CV detection (<30ms)
      let workCtx = ctx;
      let w = width, h = height;
      let scale = 1;
      if (width > 800 || height > 800) {
        scale = 800 / Math.max(width, height);
        w = Math.round(width * scale);
        h = Math.round(height * scale);
        const analysisCanvas = document.createElement('canvas');
        analysisCanvas.width = w;
        analysisCanvas.height = h;
        const actx = analysisCanvas.getContext('2d');
        actx.drawImage(ctx.canvas, 0, 0, w, h);
        workCtx = actx;
      }

      const imgData = workCtx.getImageData(0, 0, w, h);
      const data = imgData.data;
      const n = w * h;

      // 1. Grayscale conversion
      const gray = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
      }

      // 2. Bradley-Roth Adaptive Integral Binarization (tuned to capture subtle gray grid lines ~210)
      const binary = this.adaptiveThreshold(gray, w, h, 0.04, 0.08);

      // Check if image has minimal ink content
      let totalInk = 0;
      for (let i = 0; i < n; i++) if (binary[i]) totalInk++;
      if (totalInk < 40) return null;

      const invScale = 1 / scale;

      // 3. Morphological Line Detection (Bordered & Open-side tables)
      let lineGrid = this.detectLineGrid(binary, w, h);

      // Sensitive fallback pass for faint or light gray/colored gridlines
      if (!lineGrid || lineGrid.rowsY.length < 2) {
        const sensitiveBinary = this.adaptiveThreshold(gray, w, h, 0.05, 0.05);
        const secondGrid = this.detectLineGrid(sensitiveBinary, w, h);
        if (secondGrid && secondGrid.rowsY.length >= 2) {
          lineGrid = secondGrid;
        }
      }

      if (lineGrid && lineGrid.rowsY.length >= 2) {
        let colsX = [...lineGrid.colsX];
        // Only fallback to gutter analysis if physical vertical lines are missing
        if (colsX.length < 2) {
          const gutterCols = this.findGuttersBetweenLines(binary, w, h, lineGrid.rowsY, lineGrid.hLineImg);
          if (gutterCols && gutterCols.length >= 2) {
            colsX = gutterCols;
          }
        }

        if (colsX.length >= 2) {
          const rowsY = lineGrid.rowsY.map(y => Math.round(y * invScale));
          const colsXScaled = colsX.map(x => Math.round(x * invScale));
          return {
            type: 'bordered',
            rowsY,
            colsX: colsXScaled,
            rowCount: rowsY.length - 1,
            colCount: colsXScaled.length - 1,
            tableBounds: {
              top: rowsY[0],
              bottom: rowsY[rowsY.length - 1],
              left: colsXScaled[0],
              right: colsXScaled[colsXScaled.length - 1]
            },
            binary
          };
        }
      }

      // 4. Ruled Sheets (Horizontal lines only, like attendance sheets/notebooks)
      if (lineGrid && lineGrid.rowsY.length >= 2) {
        const colsX = this.findGuttersBetweenLines(binary, w, h, lineGrid.rowsY, lineGrid.hLineImg);
        if (colsX && colsX.length >= 2) {
          const rowsY = lineGrid.rowsY.map(y => Math.round(y * invScale));
          const colsXScaled = colsX.map(x => Math.round(x * invScale));
          return {
            type: 'ruled',
            rowsY,
            colsX: colsXScaled,
            rowCount: rowsY.length - 1,
            colCount: colsXScaled.length - 1,
            tableBounds: {
              top: rowsY[0],
              bottom: rowsY[rowsY.length - 1],
              left: colsXScaled[0],
              right: colsXScaled[colsXScaled.length - 1]
            },
            binary
          };
        }
      }

      // 5. Borderless table via text layout & gutter analysis (requires both multi-row and multi-column)
      const borderlessGrid = this.detectBorderlessGrid(binary, w, h);
      if (borderlessGrid && borderlessGrid.rowCount >= 2 && borderlessGrid.colCount >= 2) {
        const rowsY = borderlessGrid.rowsY.map(y => Math.round(y * invScale));
        const colsX = borderlessGrid.colsX.map(x => Math.round(x * invScale));
        return {
          type: 'borderless',
          rowsY,
          colsX,
          rowCount: borderlessGrid.rowCount,
          colCount: borderlessGrid.colCount,
          tableBounds: {
            top: rowsY[0],
            bottom: rowsY[rowsY.length - 1],
            left: colsX[0],
            right: colsX[colsX.length - 1]
          },
          binary
        };
      }

      return null;
    } catch (err) {
      console.error('[TableDetector] Detection error:', err);
      return null;
    }
  },

  /**
   * Bradley-Roth Local Adaptive Thresholding using Integral Image
   * O(W * H) speed. Robust against non-uniform phone shadows and flash glare.
   */
  adaptiveThreshold(gray, width, height, windowRatio = 0.04, thresholdT = 0.10) {
    const n = width * height;
    const integral = new Float64Array(n);

    // Build integral image
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      const yOffset = y * width;
      const prevYOffset = (y - 1) * width;
      for (let x = 0; x < width; x++) {
        rowSum += gray[yOffset + x];
        integral[yOffset + x] = (y > 0 ? integral[prevYOffset + x] : 0) + rowSum;
      }
    }

    const binary = new Uint8Array(n);
    const s = Math.max(8, Math.round(Math.min(width, height) * windowRatio));
    const s2 = Math.floor(s / 2);

    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - s2);
      const y1 = Math.min(height - 1, y + s2);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - s2);
        const x1 = Math.min(width - 1, x + s2);

        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[y1 * width + x1]
          - (x0 > 0 ? integral[y1 * width + (x0 - 1)] : 0)
          - (y0 > 0 ? integral[(y0 - 1) * width + x1] : 0)
          + (x0 > 0 && y0 > 0 ? integral[(y0 - 1) * width + (x0 - 1)] : 0);

        const mean = sum / count;
        // Pixel is darker than (mean * (1 - thresholdT)) -> classified as ink (1)
        if (gray[y * width + x] < mean * (1 - thresholdT)) {
          binary[y * width + x] = 1;
        }
      }
    }

    return binary;
  },

  /**
   * Multi-scale Morphological Line Extraction (OpenCV-style horizontal & vertical filters)
   */
  detectLineGrid(binary, width, height) {
    // Try primary and secondary kernel lengths
    const hKernels = [Math.max(12, Math.floor(width / 28)), Math.max(8, Math.floor(width / 45))];
    const vKernels = [Math.max(12, Math.floor(height / 28)), Math.max(8, Math.floor(height / 45))];

    for (let k = 0; k < hKernels.length; k++) {
      const hKernel = hKernels[k];
      const vKernel = vKernels[k];

      const hLineImg = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        let run = 0;
        let gap = 0;
        const yOff = y * width;
        for (let x = 0; x < width; x++) {
          if (binary[yOff + x] === 1) {
            run += 1 + gap;
            gap = 0;
          } else {
            if (run > 0 && gap < 2) {
              gap++;
            } else {
              if (run >= hKernel) {
                const sX = Math.max(0, x - gap - run);
                const eX = x - gap;
                for (let m = sX; m < eX; m++) hLineImg[yOff + m] = 1;
              }
              run = 0;
              gap = 0;
            }
          }
        }
        if (run >= hKernel) {
          const sX = Math.max(0, width - gap - run);
          const eX = width - gap;
          for (let m = sX; m < eX; m++) hLineImg[yOff + m] = 1;
        }
      }

      const vLineImg = new Uint8Array(width * height);
      for (let x = 0; x < width; x++) {
        let run = 0;
        let gap = 0;
        for (let y = 0; y < height; y++) {
          if (binary[y * width + x] === 1) {
            run += 1 + gap;
            gap = 0;
          } else {
            if (run > 0 && gap < 2) {
              gap++;
            } else {
              if (run >= vKernel) {
                const sY = Math.max(0, y - gap - run);
                const eY = y - gap;
                for (let m = sY; m < eY; m++) vLineImg[m * width + x] = 1;
              }
              run = 0;
              gap = 0;
            }
          }
        }
        if (run >= vKernel) {
          const sY = Math.max(0, height - gap - run);
          const eY = height - gap;
          for (let m = sY; m < eY; m++) vLineImg[m * width + x] = 1;
        }
      }

      // Compute projections
      const hProj = new Int32Array(height);
      for (let y = 0; y < height; y++) {
        let sum = 0;
        const yOff = y * width;
        for (let x = 0; x < width; x++) sum += hLineImg[yOff + x];
        hProj[y] = sum;
      }

      const vProj = new Int32Array(width);
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let y = 0; y < height; y++) sum += vLineImg[y * width + x];
        vProj[x] = sum;
      }

      let maxH = 0;
      for (let y = 0; y < height; y++) if (hProj[y] > maxH) maxH = hProj[y];
      let maxV = 0;
      for (let x = 0; x < width; x++) if (vProj[x] > maxV) maxV = vProj[x];

      let minHLen = Math.max(40, Math.floor(width * 0.20));
      if (maxH >= width * 0.35) {
        minHLen = Math.max(minHLen, Math.floor(maxH * 0.55));
      }

      let minVLen = Math.max(30, Math.floor(height * 0.18));
      if (maxV >= height * 0.30) {
        minVLen = Math.max(minVLen, Math.floor(maxV * 0.45));
      }

      const rawRowsY = this.extractPeaks(hProj, minHLen, Math.max(14, Math.floor(height * 0.025)));
      const rawColsX = this.extractPeaks(vProj, minVLen, Math.max(16, Math.floor(width * 0.025)));
      const rowsY = this.filterSpuriousGridLines(rawRowsY, height, hProj);
      const colsX = this.filterSpuriousGridLines(rawColsX, width, vProj);

      if (rowsY.length >= 2) {
        // Robust horizontal extent determination across all rows
        let minHStart = width, maxHEnd = 0;
        for (let x = 0; x < width; x++) {
          let hasLine = false;
          for (const y of rowsY) {
            for (let dy = -2; dy <= 2; dy++) {
              const ny = y + dy;
              if (ny >= 0 && ny < height && hLineImg[ny * width + x]) {
                hasLine = true; break;
              }
            }
            if (hasLine) break;
          }
          if (hasLine) {
            if (x < minHStart) minHStart = x;
            if (x > maxHEnd) maxHEnd = x;
          }
        }

        if (minHStart < maxHEnd && colsX.length >= 1) {
          const minColW = Math.max(20, Math.floor((maxHEnd - minHStart) * 0.08));
          if (colsX[0] - minHStart >= minColW) {
            colsX.unshift(minHStart);
          }
          if (maxHEnd - colsX[colsX.length - 1] >= minColW) {
            colsX.push(maxHEnd);
          }
        }

        return { rowsY, colsX, hLineImg, vLineImg };
      }
    }

    return null;
  },

  /**
   * Filter spurious micro-intervals created by shaded header bands or double borders
   */
  filterSpuriousGridLines(lines, totalDimension, proj) {
    if (!lines || lines.length <= 1) return lines || [];

    // Filter lines that are unnaturally close (micro-interval duplicates / double borders < 14px)
    const minGap = 14;
    const filtered = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const curr = lines[i];
      const prev = filtered[filtered.length - 1];
      if (curr - prev < minGap) {
        if (proj && proj[curr] > proj[prev]) {
          filtered[filtered.length - 1] = curr;
        }
      } else {
        filtered.push(curr);
      }
    }
    return filtered;
  },

  /**
   * Peak detection along projection arrays
   */
  extractPeaks(proj, minThreshold, minGap) {
    const peaks = [];
    let inPeak = false, maxVal = 0, bestIdx = 0, peakStart = 0;

    for (let i = 0; i < proj.length; i++) {
      if (proj[i] >= minThreshold) {
        if (!inPeak) {
          inPeak = true; maxVal = proj[i]; bestIdx = i; peakStart = i;
        } else if (proj[i] > maxVal) {
          maxVal = proj[i]; bestIdx = i;
        }
      } else if (inPeak) {
        inPeak = false;
        const peakWidth = i - peakStart;
        if (peakWidth >= minGap * 1.5) {
          peaks.push(peakStart);
          peaks.push(i - 1);
        } else {
          peaks.push(bestIdx);
        }
      }
    }
    if (inPeak) {
      const peakWidth = proj.length - peakStart;
      if (peakWidth >= minGap * 1.5) {
        peaks.push(peakStart);
        peaks.push(proj.length - 1);
      } else {
        peaks.push(bestIdx);
      }
    }

    if (peaks.length <= 1) return peaks;

    // Merge peaks closer than minGap (excluding top/bottom band pairs)
    const merged = [peaks[0]];
    for (let i = 1; i < peaks.length; i++) {
      if (peaks[i] - merged[merged.length - 1] < minGap * 0.7) {
        merged[merged.length - 1] = Math.round((merged[merged.length - 1] + peaks[i]) / 2);
      } else {
        merged.push(peaks[i]);
      }
    }
    return merged;
  },

  /**
   * Finds column gutters (vertical whitespace channels) between detected horizontal lines
   */
  findGuttersBetweenLines(binary, width, height, rowsY, hLineImg) {
    const y0 = rowsY[0];
    const y1 = rowsY[rowsY.length - 1];
    const vProj = new Int32Array(width);

    for (let y = y0; y <= y1; y++) {
      const yOff = y * width;
      for (let x = 0; x < width; x++) {
        // Exclude horizontal lines so they don't corrupt vertical column gutters
        if (binary[yOff + x] && (!hLineImg || !hLineImg[yOff + x])) vProj[x]++;
      }
    }

    // Determine horizontal bounds of content
    let minX = 0, maxX = width - 1;
    for (let x = 0; x < width; x++) {
      if (vProj[x] > 4) { minX = x; break; }
    }
    for (let x = width - 1; x >= 0; x--) {
      if (vProj[x] > 4) { maxX = x; break; }
    }

    if (maxX - minX < 40) return [0, width];

    const gutters = [minX];
    const span = maxX - minX;
    const minColW = Math.max(30, Math.floor(span * 0.08));
    let lastGutter = minX;

    let inValley = false, vStart = 0;
    const valleyThreshold = (y1 - y0) * 0.04;

    for (let x = minX + minColW; x <= maxX - minColW; x++) {
      if (vProj[x] <= valleyThreshold) {
        if (!inValley) { inValley = true; vStart = x; }
      } else if (inValley) {
        inValley = false;
        const vMid = Math.round((vStart + x - 1) / 2);
        if (vMid - lastGutter >= minColW) {
          gutters.push(vMid);
          lastGutter = vMid;
        }
      }
    }
    gutters.push(maxX);
    return gutters.length >= 2 ? gutters : [minX, maxX];
  },

  /**
   * Detects borderless tables using horizontal & vertical projection profiles
   */
  detectBorderlessGrid(binary, width, height) {
    const hProj = new Int32Array(height);
    const vProj = new Int32Array(width);
    let totalInk = 0;

    for (let y = 0; y < height; y++) {
      const yOff = y * width;
      for (let x = 0; x < width; x++) {
        if (binary[yOff + x]) {
          hProj[y]++;
          vProj[x]++;
          totalInk++;
        }
      }
    }

    if (totalInk < 50) return null;

    let y0 = 0, y1 = height - 1;
    while (y0 < height && hProj[y0] < 4) y0++;
    while (y1 >= 0 && hProj[y1] < 4) y1--;

    let x0 = 0, x1 = width - 1;
    while (x0 < width && vProj[x0] < 4) x0++;
    while (x1 >= 0 && vProj[x1] < 4) x1--;

    if (y1 - y0 < 20 || x1 - x0 < 30) return null;

    // Detect rows via horizontal valleys
    const rowDivs = [y0];
    const avgLineHeight = Math.max(14, Math.floor((y1 - y0) / 16));
    let lastY = y0;
    let inGap = false, gapStart = 0;

    for (let y = y0 + 10; y <= y1 - 10; y++) {
      if (hProj[y] <= 2) {
        if (!inGap) { inGap = true; gapStart = y; }
      } else if (inGap) {
        inGap = false;
        const mid = Math.round((gapStart + y - 1) / 2);
        if (mid - lastY >= avgLineHeight) {
          rowDivs.push(mid);
          lastY = mid;
        }
      }
    }
    rowDivs.push(y1);

    // Detect columns via vertical valleys
    const colDivs = [x0];
    const avgColWidth = Math.max(30, Math.floor((x1 - x0) / 8));
    let lastX = x0;
    let inVGap = false, vGapStart = 0;

    for (let x = x0 + 20; x <= x1 - 20; x++) {
      if (vProj[x] <= 2) {
        if (!inVGap) { inVGap = true; vGapStart = x; }
      } else if (inVGap) {
        inVGap = false;
        const mid = Math.round((vGapStart + x - 1) / 2);
        if (mid - lastX >= avgColWidth) {
          colDivs.push(mid);
          lastX = mid;
        }
      }
    }
    colDivs.push(x1);

    const rCount = Math.max(1, rowDivs.length - 1);
    const cCount = Math.max(1, colDivs.length - 1);

    return {
      rowsY: rowDivs,
      colsX: colDivs,
      rowCount: rCount,
      colCount: cCount
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SCANNER CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

export const Scanner = {
  scanningCard: null,
  statusTextEl: null,
  noTableCard: null,
  resultCard: null,
  tableContainer: null,
  dimensionsEl: null,
  btnTryAnother: null,
  btnNewScan: null,
  btnExportExcel: null,
  btnExportDocx: null,
  btnExportPdf: null,
  btnExportPng: null,
  btnExportMulti: null,
  btnToggleCompare: null,
  imagePane: null,
  comparisonImg: null,
  zoomLevel: 1.0,

  // Multi Export Modal elements
  multiExportModal: null,
  btnCloseMultiExport: null,
  btnCancelMultiExport: null,
  btnConfirmMultiExport: null,

  currentDocument: null,
  currentFileName: 'ScanSheet_Converted_Table.xlsx',
  currentSourceUrl: null,
  tessWorker: null,

  // ── INIT ──────────────────────────────────────────────────────────────────

  init() {
    this.scanningCard = Utils.qs('#table-scanning-card');
    this.statusTextEl = Utils.qs('#scanning-status-text');
    this.noTableCard = Utils.qs('#no-table-card');
    this.resultCard = Utils.qs('#scan-result-card');
    this.tableContainer = Utils.qs('#scan-table-container');
    this.dimensionsEl = Utils.qs('#scan-table-dimensions');

    this.btnTryAnother = Utils.qs('#btn-try-another-image');
    this.btnNewScan = Utils.qs('#btn-result-new-scan');
    this.btnExportExcel = Utils.qs('#btn-export-excel') || Utils.qs('#btn-export-csv');
    this.btnExportDocx = Utils.qs('#btn-export-docx');
    this.btnExportPdf = Utils.qs('#btn-export-pdf');
    this.btnExportPng = Utils.qs('#btn-export-png');
    this.btnExportMulti = Utils.qs('#btn-export-multi');
    this.btnToggleCompare = Utils.qs('#btn-toggle-compare');

    this.multiExportModal = Utils.qs('#multi-export-modal');
    this.btnCloseMultiExport = Utils.qs('#btn-close-multi-export');
    this.btnCancelMultiExport = Utils.qs('#btn-cancel-multi-export');
    this.btnConfirmMultiExport = Utils.qs('#btn-confirm-multi-export');

    if (this.btnTryAnother) this.btnTryAnother.addEventListener('click', () => this.resetToUpload());
    if (this.btnNewScan) this.btnNewScan.addEventListener('click', () => this.resetToUpload());
    if (this.btnExportExcel) this.btnExportExcel.addEventListener('click', () => this.handleExport('excel'));
    if (this.btnExportDocx) this.btnExportDocx.addEventListener('click', () => this.handleExport('word'));
    if (this.btnExportPdf) this.btnExportPdf.addEventListener('click', () => this.handleExport('pdf'));
    if (this.btnExportPng) this.btnExportPng.addEventListener('click', () => this.handleExport('image'));
    if (this.btnExportMulti) this.btnExportMulti.addEventListener('click', () => this.openMultiExportModal());
    if (this.btnToggleCompare) this.btnToggleCompare.addEventListener('click', () => this.toggleImageComparison());

    if (this.btnCloseMultiExport) this.btnCloseMultiExport.addEventListener('click', () => this.closeMultiExportModal());
    if (this.btnCancelMultiExport) this.btnCancelMultiExport.addEventListener('click', () => this.closeMultiExportModal());
    if (this.btnConfirmMultiExport) this.btnConfirmMultiExport.addEventListener('click', () => this.confirmMultiExport());

    // Page-level Multi-Export Triggers
    const triggerIds = ['#hero-btn-export-multi', '#badge-multi-export', '#btn-banner-multi-export'];
    triggerIds.forEach(id => {
      const el = Utils.qs(id);
      if (el) el.addEventListener('click', () => this.openMultiExportModal());
    });

    const singleBadgeTriggers = [
      { id: '#badge-excel', format: 'excel' },
      { id: '#badge-word', format: 'word' },
      { id: '#badge-pdf', format: 'pdf' },
      { id: '#badge-png', format: 'image' }
    ];
    singleBadgeTriggers.forEach(({ id, format }) => {
      const el = Utils.qs(id);
      if (el) {
        el.addEventListener('click', () => {
          if (this.currentDocument) {
            this.handleExport(format);
          } else {
            UI.showNotification(`Please upload and scan a table image first to export as ${format.toUpperCase()}.`);
            const dropZone = Utils.qs('#upload-drop-zone');
            if (dropZone) dropZone.scrollIntoView({ behavior: 'smooth' });
          }
        });
      }
    });

    if (this.multiExportModal) {
      this.multiExportModal.addEventListener('click', (e) => {
        if (e.target === this.multiExportModal) this.closeMultiExportModal();
      });
    }

    const btnCancelScanning = Utils.qs('#btn-cancel-scanning');
    if (btnCancelScanning) {
      btnCancelScanning.addEventListener('click', () => this.cancelScan());
    }
  },

  cancelScan() {
    this.isScanCancelled = true;
    if (this.scanningCard) {
      this.scanningCard.style.display = 'none';
      this.scanningCard.setAttribute('aria-busy', 'false');
    }
    const previewCard = Utils.qs('#upload-preview-card');
    const dropZone = Utils.qs('#upload-drop-zone');
    if (previewCard && this.currentSourceUrl) {
      previewCard.style.display = 'flex';
    } else if (dropZone) {
      dropZone.style.display = 'block';
    }
    this.setStatus('Scan cancelled.');
    Utils.announce('Scan cancelled by user.');
  },

  setStatus(status) {
    if (this.statusTextEl) this.statusTextEl.textContent = status;
    Utils.announce(status);
  },

  nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  },

  // ── OCR ENGINE (Tesseract.js v5 with Worker Reuse & Preloading) ───────────

  preloadTesseract() {
    if (!this.tessWorker && window.Tesseract) {
      this.getTessWorker().catch(e => console.warn('[Scanner] Preload failed:', e));
    }
  },

  async getTessWorker() {
    if (this.tessWorker) return this.tessWorker;

    if (!window.Tesseract) {
      await new Promise(resolve => {
        const start = Date.now();
        const iv = setInterval(() => {
          if (window.Tesseract || Date.now() - start > 6000) {
            clearInterval(iv);
            resolve();
          }
        }, 150);
      });
    }

    if (!window.Tesseract) {
      console.warn('[Scanner] Tesseract not available on window.Tesseract');
      return null;
    }

    try {
      this.setStatus('Initializing OCR engine...');

      const loggerFn = m => {
        if (m.status === 'loading tesseract core') {
          this.setStatus('Loading OCR core components...');
        } else if (m.status === 'loading language traineddata') {
          const p = m.progress !== undefined ? ` (${Math.round(m.progress * 100)}%)` : '';
          this.setStatus(`Downloading high-accuracy OCR language model${p}...`);
        } else if (m.status === 'initializing api') {
          this.setStatus('Initializing recognition engine...');
        } else if (m.status === 'recognizing text' && m.progress !== undefined) {
          this.setStatus(`Reading document & table... ${Math.round(m.progress * 100)}%`);
        }
      };

      // Attempt 1: High-accuracy float LSTM model for superior character & spelling precision
      // Attempt 2: Fast model fallback if network timeout occurs
      let workerPromise;
      try {
        workerPromise = window.Tesseract.createWorker('eng', 1, {
          langPath: 'https://tessdata.projectnaptha.com/4.0.0',
          logger: loggerFn
        });
      } catch (err) {
        workerPromise = window.Tesseract.createWorker('eng', 1, {
          langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast',
          logger: loggerFn
        });
      }

      // Timeout guard (30s) so worker creation cannot hang indefinitely
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tesseract worker initialization timed out (30s)')), 30000)
      );

      const worker = await Promise.race([workerPromise, timeoutPromise]);

      await worker.setParameters({
        tessedit_pageseg_mode: window.Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        tessedit_enable_dict_correction: '1'
      });

      this.tessWorker = worker;
      return worker;
    } catch (e) {
      console.warn('[Scanner] Trying fast OCR model fallback due to error:', e);
      try {
        const fallbackWorker = await window.Tesseract.createWorker('eng', 1, {
          langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast'
        });
        await fallbackWorker.setParameters({
          tessedit_pageseg_mode: window.Tesseract.PSM.AUTO,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300'
        });
        this.tessWorker = fallbackWorker;
        return fallbackWorker;
      } catch (e2) {
        console.error('[Scanner] Failed to initialize OCR worker:', e2);
        return null;
      }
    }
  },

  async runOCR(canvas) {
    const ocrPromise = (async () => {
      try {
        const worker = await this.getTessWorker();
        if (!worker) {
          console.warn('[Scanner] OCR worker unavailable');
          return { words: [], lines: [], rawText: '' };
        }

        const res = await worker.recognize(canvas);
        const rawText = res?.data?.text || '';
        const lines = res?.data?.lines || [];

        const rawWords = (res?.data?.words && res.data.words.length > 0)
          ? res.data.words
          : lines.flatMap(l => l.words || []);

        const words = rawWords
          .filter(w => w && w.text && w.text.trim())
          .map(w => ({
            text: w.text.trim(),
            x0: w.bbox ? w.bbox.x0 : 0,
            y0: w.bbox ? w.bbox.y0 : 0,
            x1: w.bbox ? w.bbox.x1 : 0,
            y1: w.bbox ? w.bbox.y1 : 0,
            cx: w.bbox ? (w.bbox.x0 + w.bbox.x1) / 2 : 0,
            cy: w.bbox ? (w.bbox.y0 + w.bbox.y1) / 2 : 0,
            confidence: typeof w.confidence === 'number' ? w.confidence : 85,
            isUncertain: typeof w.confidence === 'number' && w.confidence < 60
          }));

        return { words, lines, rawText, blocks: res?.data?.blocks || [] };
      } catch (e) {
        console.error('[Scanner] OCR recognize error:', e?.stack || e?.message || e);
        return { words: [], lines: [], rawText: '', error: e?.message };
      }
    })();

    const timeoutPromise = new Promise(resolve => setTimeout(() => {
      console.warn('[Scanner] OCR timeout guard reached (25s)');
      resolve({ words: [], lines: [], rawText: '', error: 'timeout' });
    }, 25000));

    return Promise.race([ocrPromise, timeoutPromise]);
  },

  async runPaddleOCR(file, imageUrl) {
    const endpoints = [];
    if (window.PADDLE_OCR_API_URL) {
      endpoints.push(window.PADDLE_OCR_API_URL);
    }

    const hostname = window.location.hostname || 'localhost';
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.');

    // 1. Same-origin endpoint
    endpoints.push('/api/scan');

    // 2. Direct port 5000 probing only in local/LAN development environments
    if (isLocalHost) {
      endpoints.push(`http://${hostname}:5000/api/scan`);
      if (hostname !== '127.0.0.1') endpoints.push('http://127.0.0.1:5000/api/scan');
      if (hostname !== 'localhost') endpoints.push('http://localhost:5000/api/scan');
    }

    let lastError = null;

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        let response;
        if (file instanceof File || file instanceof Blob) {
          const fd = new FormData();
          fd.append('file', file, file.name || 'document_image.png');
          response = await fetch(url, {
            method: 'POST',
            body: fd,
            signal: controller.signal
          });
        } else {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageUrl }),
            signal: controller.signal
          });
        }
        clearTimeout(timeoutId);

        if (!response.ok) {
          let errJson = null;
          try { errJson = await response.json(); } catch (_) {}
          const errorMsg = errJson?.error || `PaddleOCR server returned HTTP ${response.status}`;
          lastError = new Error(errorMsg);
          if (response.status === 404 || response.status === 405 || response.status === 502 || response.status === 503 || response.status === 504) {
            continue;
          }
          throw lastError;
        }

        const data = await response.json();
        if (!data || data.success === false) {
          throw new Error(data?.error || "We couldn't read the content clearly. Please upload a clearer image.");
        }

        data.sourceImageUrl = imageUrl;
        if (data.table && !data.table.isUncertainMap) {
          data.table.isUncertainMap = {};
        }

        return data;
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new Error('Recognition timed out. Please try again or use a clearer image.');
        }
        lastError = err;
        if (err.message && (err.message.includes('Failed to fetch') || err.message.includes('Load failed') || err.message.includes('NetworkError') || err.name === 'TypeError')) {
          continue;
        }
        throw err;
      }
    }

    const reason = lastError ? lastError.message : 'PaddleOCR backend unavailable';
    throw new Error(`OCR_BACKEND_UNAVAILABLE: ${reason}`);
  },

  /**
   * Eliminates black table border lines from the OCR canvas prior to recognition.
   * Prevents line segments from fusing with words or generating phantom punctuation symbols.
   */
  whitenGridLinesForOCR(canvas, structure) {
    if (!canvas || !structure) return;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;

      const rowsY = structure.rowsY || [];
      const colsX = structure.colsX || [];
      if (rowsY.length < 2 || colsX.length < 2) {
        ctx.restore();
        return;
      }

      const x0 = colsX[0];
      const x1 = colsX[colsX.length - 1];
      const y0 = rowsY[0];
      const y1 = rowsY[rowsY.length - 1];

      for (const y of rowsY) {
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
      }

      for (const x of colsX) {
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.stroke();
      }

      ctx.restore();
    } catch (e) {
      console.warn('[Scanner] whitenGridLinesForOCR skipped:', e);
    }
  },

  /**
   * Prepares mobile camera photos for upload by safely scaling down images larger than 2200px
   * or over 2.5MB to high-quality JPEG blobs. Prevents mobile browser OOM and slow uploads.
   */
  async prepareMobileImagePayload(file, imageUrl) {
    if (!imageUrl) return { file, imageUrl };

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        const maxDim = Math.max(w, h);

        // If image dimensions are already compact and file is under 2.5MB, no resize needed
        if (maxDim <= 2200 && (!file || file.size < 2.5 * 1024 * 1024)) {
          resolve({ file, imageUrl });
          return;
        }

        try {
          const scale = maxDim > 2200 ? (2200 / maxDim) : 1;
          const targetW = Math.round(w * scale);
          const targetH = Math.round(h * scale);

          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, targetW, targetH);

          canvas.toBlob((blob) => {
            if (blob && blob.size > 0) {
              const optFile = new File([blob], file?.name || 'document_image.jpg', { type: 'image/jpeg' });
              const optUrl = URL.createObjectURL(blob);
              resolve({ file: optFile, imageUrl: optUrl });
            } else {
              resolve({ file, imageUrl });
            }
          }, 'image/jpeg', 0.92);
        } catch (e) {
          console.warn('[Scanner] prepareMobileImagePayload fallback:', e);
          resolve({ file, imageUrl });
        }
      };
      img.onerror = () => resolve({ file, imageUrl });
      img.src = imageUrl;
    });
  },

  // ── MAIN SCANNING WORKFLOW ────────────────────────────────────────────────

  async startScan(file, imageUrl, dimensions) {
    if (!this.scanningCard || !this.resultCard || !this.tableContainer) {
      this.init();
    }

    this.isScanCancelled = false;
    const previewCard = Utils.qs('#upload-preview-card');
    const dropZone = Utils.qs('#upload-drop-zone');
    if (previewCard) previewCard.style.display = 'none';
    if (dropZone) dropZone.style.display = 'none';
    if (this.noTableCard) this.noTableCard.style.display = 'none';
    if (this.resultCard) this.resultCard.style.display = 'none';

    if (this.scanningCard) {
      this.scanningCard.style.display = 'flex';
      this.scanningCard.setAttribute('aria-busy', 'true');
    }

    this.currentSourceUrl = imageUrl;

    try {
      this.setStatus('Optimizing image for fast mobile recognition...');
      const payload = await this.prepareMobileImagePayload(file, imageUrl);
      const activeFile = payload.file;
      const activeUrl = payload.imageUrl;

      this.setStatus('Recognizing document & tables with PaddleOCR...');
      await this.nextFrame();

      let documentModel = null;
      try {
        documentModel = await this.runPaddleOCR(activeFile, activeUrl);
      } catch (ocrErr) {
        console.warn('[Scanner] PaddleOCR server notice:', ocrErr.message);
        if (ocrErr.message && ocrErr.message.includes("couldn't read the content clearly")) {
          throw ocrErr;
        }
        if (ocrErr.message && (
          ocrErr.message.includes('OCR_BACKEND_UNAVAILABLE') ||
          ocrErr.message.includes('Failed to fetch') ||
          ocrErr.message.includes('Load failed') ||
          ocrErr.message.includes('connect to PaddleOCR')
        )) {
          console.info('[Scanner] Falling back to client-side recognition engine...');
          this.setStatus('Analyzing layout & text content...');
          const preprocessed = await ImagePreprocessor.process(imageUrl, dimensions);
          if (this.isScanCancelled) return;
          await this.nextFrame();

          const structure = TableDetector.detect(
            preprocessed.structureCanvas.getContext('2d'),
            preprocessed.width,
            preprocessed.height
          );
          if (this.isScanCancelled) return;
          await this.nextFrame();

          if (structure && structure.rowsY && structure.rowsY.length >= 2 && structure.colsX && structure.colsX.length >= 2) {
            this.whitenGridLinesForOCR(preprocessed.ocrCanvas, structure);
          }

          const ocrData = await this.runOCR(preprocessed.ocrCanvas);
          if (this.isScanCancelled) return;
          await this.nextFrame();

          documentModel = this.buildDocumentModel(
            structure,
            ocrData,
            preprocessed.width,
            preprocessed.height
          );
        } else {
          throw ocrErr;
        }
      }

      if (this.isScanCancelled) return;

      if (!documentModel || (!documentModel.table?.grid?.length && !documentModel.paragraphs?.length && !documentModel.title)) {
        console.warn('[Scanner] No table or text detected');
        this.showNoTableFound();
        return;
      }

      this.currentDocument = documentModel;
      await this.nextFrame();
      this.showResultScreen(documentModel);

      this.recordHistory(file, documentModel);

    } catch (err) {
      console.error('[Scanner] Pipeline error:', err);
      if (!this.isScanCancelled) {
        this.showNoTableFound(err?.message);
      }
    }
  },

  // ── DOCUMENT & TABLE RECONSTRUCTION ───────────────────────────────────────

  /**
   * Layout analyzer to determine if borderless content is genuinely columnar or narrative text.
   * Prevents standard paragraphs from being converted into broken 1-column tables.
   */
  isLikelyTabularContent(words, imgW) {
    if (!words || words.length < 4) return false;

    const validWords = words.filter(w => w && w.text && w.text.trim().length > 0);
    if (validWords.length < 4) return false;

    const sortedByY = [...validWords].sort((a, b) => a.cy - b.cy);
    const heights = sortedByY.map(w => w.y1 - w.y0).filter(h => h > 5).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 20;
    const lineTol = Math.max(10, Math.round(medianH * 0.65));

    const lines = [];
    for (const w of sortedByY) {
      let matched = null;
      for (const l of lines) {
        if (Math.abs(w.cy - l.cy) <= lineTol) {
          matched = l; break;
        }
      }
      if (matched) {
        matched.words.push(w);
        matched.cy = matched.words.reduce((sum, item) => sum + item.cy, 0) / matched.words.length;
      } else {
        lines.push({ cy: w.cy, words: [w] });
      }
    }

    if (lines.length < 2) return false;

    let multiColumnLinesCount = 0;
    const gutterPositions = [];

    for (const line of lines) {
      line.words.sort((a, b) => a.x0 - b.x0);
      const lineGaps = [];
      for (let i = 0; i < line.words.length - 1; i++) {
        const gap = line.words[i + 1].x0 - line.words[i].x1;
        lineGaps.push({ gap, x: (line.words[i].x1 + line.words[i + 1].x0) / 2 });
      }

      // Detect wide whitespace gutters that split line into distinct columns (> 32px or > 1.6x line height)
      const colGutters = lineGaps.filter(g => g.gap > Math.max(32, medianH * 1.6));
      if (colGutters.length >= 1) {
        multiColumnLinesCount++;
        colGutters.forEach(g => gutterPositions.push(g.x));
      }
    }

    // Borderless tables must have multi-column gutters across at least 35% of rows
    if (multiColumnLinesCount < 2 || (multiColumnLinesCount / lines.length) < 0.35) {
      return false;
    }

    // Check if gutter positions align vertically across rows
    const gutterClusters = [];
    const clusterTol = Math.max(25, (imgW || 800) * 0.05);

    for (const gx of gutterPositions) {
      let matched = null;
      for (const c of gutterClusters) {
        if (Math.abs(gx - c.center) < clusterTol) {
          matched = c; break;
        }
      }
      if (matched) {
        matched.samples.push(gx);
        matched.center = matched.samples.reduce((s, v) => s + v, 0) / matched.samples.length;
      } else {
        gutterClusters.push({ center: gx, samples: [gx] });
      }
    }

    const strongGutters = gutterClusters.filter(c => c.samples.length >= 2);
    return strongGutters.length >= 1;
  },

  /**
   * Parses recognized lines into title, distinct paragraphs, headings, bullet points, and footer notes.
   */
  parseDocumentSections(lines) {
    if (!lines || !lines.length) return { title: '', paragraphs: [], notes: [] };

    const validLines = lines.filter(l => l && l.text && l.text.trim().length > 0);
    if (!validLines.length) return { title: '', paragraphs: [], notes: [] };

    const heights = validLines.map(l => (l.y1 !== undefined && l.y0 !== undefined) ? (l.y1 - l.y0) : 20).filter(h => h > 5).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 20;

    let title = '';
    const paragraphs = [];
    const notes = [];

    // First line title detection
    let startIdx = 0;
    const firstLineText = validLines[0].text.trim();
    if (validLines.length > 1 && (firstLineText.length < 90 || /^([A-Z0-9\s:.-]{3,60}|Question\s+Paper|Test\s+Paper|Notes|Invoice|Receipt|Report)/i.test(firstLineText))) {
      title = firstLineText;
      startIdx = 1;
    }

    let currentPara = [];
    let prevLine = startIdx > 0 ? validLines[0] : null;

    for (let i = startIdx; i < validLines.length; i++) {
      const line = validLines[i];
      const text = line.text.trim();

      if (!prevLine) {
        currentPara.push(text);
        prevLine = line;
        continue;
      }

      const lineY0 = line.y0 !== undefined ? line.y0 : line.cy;
      const prevY1 = prevLine.y1 !== undefined ? prevLine.y1 : prevLine.cy;
      const gap = lineY0 - prevY1;
      const isNewParaGap = gap > medianH * 1.35;
      const isBulletOrNum = /^[•\-\*]\s+|^\(?\d+[.)]\s+|^(Question|Q\d|Section|Part|Chapter)\b/i.test(text);

      if (isNewParaGap || isBulletOrNum) {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join(' '));
          currentPara = [];
        }
      }

      currentPara.push(text);
      prevLine = line;
    }

    if (currentPara.length > 0) {
      paragraphs.push(currentPara.join(' '));
    }

    // Identify trailing notes or disclaimers
    if (paragraphs.length >= 1 && /^(Note|Source|Disclaimer|Confidential|Page \d)\b/i.test(paragraphs[paragraphs.length - 1])) {
      notes.push(paragraphs.pop());
    }

    return { title, paragraphs, notes };
  },

  buildDocumentModel(structure, ocrData, imgW, imgH) {
    const words = ocrData?.words || [];
    const lines = ocrData?.lines || [];
    const rawText = ocrData?.rawText || '';

    let docTitle = '';
    let introParagraphs = [];
    let footerNotes = [];

    let tableTop = 0;
    let tableBtm = imgH;
    let tableLeft = 0;
    let tableRight = imgW;

    if (structure?.tableBounds) {
      tableTop = structure.tableBounds.top;
      tableBtm = structure.tableBounds.bottom;
      tableLeft = structure.tableBounds.left;
      tableRight = structure.tableBounds.right;
    }

    const preTableWords = [];
    const inTableWords = [];
    const postTableWords = [];

    const hasPhysicalTable = structure && structure.rowCount >= 1 && structure.colCount >= 1 &&
      (structure.type === 'bordered' || structure.type === 'ruled');

    if (hasPhysicalTable) {
      for (const w of words) {
        if (w.cy < tableTop - 12) {
          preTableWords.push(w);
        } else if (w.cy > tableBtm + 12) {
          postTableWords.push(w);
        } else {
          inTableWords.push(w);
        }
      }

      // Pre-table header candidate assimilation
      if (preTableWords.length > 0 && structure.rowsY && structure.rowsY.length >= 2) {
        const r0Top = structure.rowsY[0] - 6;
        const r0Btm = structure.rowsY[1] + 6;
        const hasHeaderInTable = inTableWords.some(w => w.cy >= r0Top && w.cy <= r0Btm);

        if (!hasHeaderInTable) {
          const avgRowH = (tableBtm - tableTop) / Math.max(1, structure.rowCount);
          const headerCandidates = [];
          const remainingPreWords = [];
          for (const w of preTableWords) {
            if (w.cy >= tableTop - avgRowH * 1.35 && w.cx >= tableLeft - 35 && w.cx <= tableRight + 35) {
              headerCandidates.push(w);
            } else {
              remainingPreWords.push(w);
            }
          }

          if (headerCandidates.length >= 2) {
            inTableWords.push(...headerCandidates);
            const newTop = Math.max(0, Math.round(tableTop - avgRowH));
            structure.rowsY.unshift(newTop);
            structure.rowCount = structure.rowsY.length - 1;
            structure.tableBounds.top = newTop;
            tableTop = newTop;
            preTableWords.length = 0;
            preTableWords.push(...remainingPreWords);
          }
        }
      }

      // Post-table footer candidate assimilation
      if (postTableWords.length > 0 && structure.rowsY && structure.rowsY.length >= 2) {
        const lastRTop = structure.rowsY[structure.rowsY.length - 2] - 6;
        const lastRBtm = structure.rowsY[structure.rowsY.length - 1] + 6;
        const hasFooterInTable = inTableWords.some(w => w.cy >= lastRTop && w.cy <= lastRBtm);

        if (!hasFooterInTable) {
          const avgRowH = (tableBtm - tableTop) / Math.max(1, structure.rowCount);
          const footerCandidates = [];
          const remainingPostWords = [];
          for (const w of postTableWords) {
            if (w.cy <= tableBtm + avgRowH * 1.35 && w.cx >= tableLeft - 35 && w.cx <= tableRight + 35) {
              footerCandidates.push(w);
            } else {
              remainingPostWords.push(w);
            }
          }

          if (footerCandidates.length >= 2) {
            inTableWords.push(...footerCandidates);
            const newBtm = Math.min(imgH, Math.round(tableBtm + avgRowH));
            structure.rowsY.push(newBtm);
            structure.rowCount = structure.rowsY.length - 1;
            structure.tableBounds.bottom = newBtm;
            tableBtm = newBtm;
            postTableWords.length = 0;
            postTableWords.push(...remainingPostWords);
          }
        }
      }

      // Parse pre-table sections
      if (preTableWords.length > 0) {
        const preLines = this.groupWordsIntoLines(preTableWords);
        const preParsed = this.parseDocumentSections(preLines);
        docTitle = preParsed.title;
        introParagraphs = preParsed.paragraphs;
        if (preParsed.notes.length > 0) footerNotes.push(...preParsed.notes);
      }

      // Parse post-table sections
      if (postTableWords.length > 0) {
        const postLines = this.groupWordsIntoLines(postTableWords);
        const postParsed = this.parseDocumentSections(postLines);
        if (postParsed.paragraphs.length > 0) {
          introParagraphs.push(...postParsed.paragraphs);
        }
        if (postParsed.notes.length > 0) {
          footerNotes.push(...postParsed.notes);
        }
      }

      let tableResult = this.reconstructBorderedTable(structure, inTableWords);
      if (!tableResult || tableResult.rowCount < 1) {
        const grid = Array.from({ length: structure.rowCount }, () => Array(structure.colCount).fill(''));
        tableResult = { rowCount: structure.rowCount, colCount: structure.colCount, grid, isUncertainMap: {} };
      }

      const isMixed = introParagraphs.length > 0 || docTitle.length > 0;
      return {
        title: docTitle,
        paragraphs: introParagraphs,
        table: tableResult,
        notes: footerNotes,
        contentType: isMixed ? 'mixed' : 'table',
        recommendedExport: isMixed ? 'word' : 'excel',
        recommendedFormats: isMixed ? ['word', 'pdf', 'excel'] : ['excel', 'word', 'pdf'],
        recommendationReason: isMixed
          ? 'Detected mixed document with both narrative text and structured tables. Word and PDF preserve the full layout; Excel includes table data and document text in separate sheets.'
          : 'Detected structured table. Excel is recommended for spreadsheet analysis, or Word/PDF for formatted reporting.',
        sourceImageUrl: this.currentSourceUrl
      };
    }

    // No physical table borders: evaluate if content is columnar table or narrative document
    const isTabular = this.isLikelyTabularContent(words, imgW);

    if (isTabular) {
      let tableResult = this.reconstructClusteredTable(words, imgW, imgH);
      if (!tableResult || tableResult.rowCount < 1) {
        if (rawText && rawText.trim()) {
          tableResult = this.parseDelimitedText(rawText);
        }
      }

      if (tableResult && tableResult.rowCount >= 2 && tableResult.colCount >= 2) {
        const isReceipt = /(invoice|receipt|subtotal|total|amount|bill to|tax)/i.test(rawText);
        return {
          title: docTitle,
          paragraphs: introParagraphs,
          table: tableResult,
          notes: footerNotes,
          contentType: isReceipt ? 'receipt' : 'table',
          recommendedExport: 'excel',
          recommendedFormats: ['excel', 'word', 'pdf'],
          recommendationReason: isReceipt
            ? 'Detected invoice / receipt. Excel is recommended for calculation of entries; Word and PDF preserve receipt layout.'
            : 'Detected borderless table. Excel is recommended for spreadsheet analysis, or Word/PDF for formatted reporting.',
          sourceImageUrl: this.currentSourceUrl
        };
      }
    }

    // Continuous narrative document (paragraphs, headings, articles, notes, questions)
    const allLines = lines && lines.length > 0 ? lines : this.groupWordsIntoLines(words);
    const parsedDoc = this.parseDocumentSections(allLines);

    docTitle = parsedDoc.title;
    introParagraphs = parsedDoc.paragraphs;
    footerNotes = parsedDoc.notes;

    // Fallback if parsing didn't find paragraphs but rawText exists
    if (introParagraphs.length === 0 && rawText.trim()) {
      const splitParas = rawText.split(/\r?\n\r?\n/).map(p => p.replace(/\r?\n/g, ' ').trim()).filter(p => p.length > 0);
      if (splitParas.length > 0) {
        if (!docTitle && splitParas[0].length < 80) {
          docTitle = splitParas[0];
          introParagraphs = splitParas.slice(1);
        } else {
          introParagraphs = splitParas;
        }
      }
    }

    const isStudyNotes = /(question|marks|answer|section [a-c]|fill in the blanks|true or false)/i.test(rawText);

    return {
      title: docTitle,
      paragraphs: introParagraphs,
      table: null,
      notes: footerNotes,
      contentType: 'document',
      recommendedExport: 'word',
      recommendedFormats: ['word', 'pdf'],
      recommendationReason: isStudyNotes
        ? 'Detected study notes / question paper. Word (.docx) and PDF (.pdf) are recommended for studying and printing.'
        : 'Detected text document with headings and paragraphs. Word (.docx) and PDF (.pdf) are recommended for editable reading and sharing.',
      sourceImageUrl: this.currentSourceUrl
    };
  },

  groupWordsIntoLines(words) {
    if (!words.length) return [];
    const lines = [];
    const sorted = [...words].sort((a, b) => a.cy - b.cy);

    for (const w of sorted) {
      let matched = null;
      for (const l of lines) {
        if (Math.abs(w.cy - l.cy) < 14) {
          matched = l; break;
        }
      }
      if (matched) {
        matched.words.push(w);
        matched.cy = matched.words.reduce((sum, item) => sum + item.cy, 0) / matched.words.length;
        matched.y0 = Math.min(matched.y0, w.y0);
        matched.y1 = Math.max(matched.y1, w.y1);
      } else {
        lines.push({ y0: w.y0, y1: w.y1, cy: w.cy, words: [w] });
      }
    }

    lines.sort((a, b) => a.cy - b.cy);
    return lines.map(l => {
      l.words.sort((a, b) => a.x0 - b.x0);
      return {
        text: l.words.map(w => w.text).join(' '),
        words: l.words,
        y0: l.y0,
        y1: l.y1,
        cy: l.cy
      };
    });
  },

  reconstructBorderedTable(structure, words) {
    const rowsY = [...structure.rowsY];
    const colsX = [...structure.colsX];
    const numRows = rowsY.length - 1;
    const numCols = colsX.length - 1;

    if (numRows < 1 || numCols < 1) return null;

    const cellBuckets = Array.from({ length: numRows }, () => Array.from({ length: numCols }, () => []));

    for (const w of words) {
      let bestR = -1;
      let maxOverlapY = 0;

      // Primary check: Word vertical center falls within row bounds
      for (let r = 0; r < numRows; r++) {
        if (w.cy >= rowsY[r] && w.cy < rowsY[r + 1]) {
          bestR = r;
          break;
        }
      }

      // Secondary check: Vertical span overlap
      if (bestR === -1) {
        for (let r = 0; r < numRows; r++) {
          const top = rowsY[r];
          const btm = rowsY[r + 1];
          const ov = Math.max(0, Math.min(w.y1, btm) - Math.max(w.y0, top));
          if (ov > maxOverlapY) {
            maxOverlapY = ov;
            bestR = r;
          }
        }
      }

      if (bestR === -1 || maxOverlapY <= 0) {
        for (let r = 0; r < numRows; r++) {
          const top = (r === 0) ? rowsY[r] - 12 : rowsY[r] - 4;
          const btm = (r === numRows - 1) ? rowsY[r + 1] + 12 : rowsY[r + 1] + 4;
          if (w.cy >= top && w.cy <= btm) {
            bestR = r; break;
          }
        }
      }

      let bestC = -1;
      let maxOverlapX = 0;

      // Primary check: Word horizontal center falls within column bounds
      for (let c = 0; c < numCols; c++) {
        if (w.cx >= colsX[c] && w.cx < colsX[c + 1]) {
          bestC = c;
          break;
        }
      }

      // Secondary check: Horizontal span overlap
      if (bestC === -1) {
        for (let c = 0; c < numCols; c++) {
          const left = colsX[c];
          const right = colsX[c + 1];
          const ov = Math.max(0, Math.min(w.x1, right) - Math.max(w.x0, left));
          if (ov > maxOverlapX) {
            maxOverlapX = ov;
            bestC = c;
          }
        }
      }

      if (bestC === -1 || maxOverlapX <= 0) {
        for (let c = 0; c < numCols; c++) {
          const left = (c === 0) ? colsX[c] - 16 : colsX[c] - 4;
          const right = (c === numCols - 1) ? colsX[c + 1] + 16 : colsX[c + 1] + 4;
          if (w.cx >= left && w.cx <= right) {
            bestC = c; break;
          }
        }
      }

      // Edge margin fallback: assign to closest row/col if within 24px of boundaries
      if (bestR === -1 && bestC >= 0) {
        for (let r = 0; r < numRows; r++) {
          if (w.cy >= rowsY[r] - 24 && w.cy <= rowsY[r + 1] + 24) {
            bestR = r; break;
          }
        }
      }
      if (bestR >= 0 && bestC === -1) {
        for (let c = 0; c < numCols; c++) {
          if (w.cx >= colsX[c] - 24 && w.cx <= colsX[c + 1] + 24) {
            bestC = c; break;
          }
        }
      }

      if (bestR >= 0 && bestC >= 0) {
        cellBuckets[bestR][bestC].push(w);
      }
    }

    const grid = [];
    const isUncertainMap = {};

    for (let r = 0; r < numRows; r++) {
      const row = [];
      for (let c = 0; c < numCols; c++) {
        const wordsInCell = cellBuckets[r][c];
        // Robust word ordering: groups words on same line and sorts strictly left-to-right
        const sortedWords = this.sortCellWords(wordsInCell);

        const hasUncertain = sortedWords.some(w => w.isUncertain);
        if (hasUncertain) {
          isUncertainMap[`${r}_${c}`] = true;
        }

        const rawCell = sortedWords.map(w => w.text).join(' ');
        row.push(this.cleanCellText(rawCell));
      }
      grid.push(row);
    }

    return this.pruneAndFinalizeGrid(grid, isUncertainMap, 'bordered');
  },

  reconstructClusteredTable(words, imgW, imgH) {
    const validWords = words.filter(w => w && w.text && w.text.trim().length > 0);
    if (!validWords.length) return null;

    const sortedByY = [...validWords].sort((a, b) => a.cy - b.cy);
    const heights = sortedByY.map(w => (w.y1 - w.y0)).filter(h => h > 5).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 22;
    const lineTol = Math.max(10, Math.round(medianHeight * 0.65));

    const rows = [];
    for (const w of sortedByY) {
      let matchedRow = null;
      for (const row of rows) {
        if (Math.abs(w.cy - row.cy) <= lineTol) {
          matchedRow = row; break;
        }
      }
      if (matchedRow) {
        matchedRow.words.push(w);
        matchedRow.cy = matchedRow.words.reduce((sum, item) => sum + item.cy, 0) / matchedRow.words.length;
      } else {
        rows.push({ cy: w.cy, words: [w] });
      }
    }

    rows.sort((a, b) => a.cy - b.cy);

    const rowTokens = [];
    for (const row of rows) {
      row.words.sort((a, b) => a.x0 - b.x0);
      const tokens = [];
      let cur = { ...row.words[0] };

      for (let i = 1; i < row.words.length; i++) {
        const next = row.words[i];
        const gap = next.x0 - cur.x1;
        if (gap < Math.max(18, Math.round(medianHeight * 1.2))) {
          cur.text += ' ' + next.text;
          cur.x1 = Math.max(cur.x1, next.x1);
          cur.y0 = Math.min(cur.y0, next.y0);
          cur.y1 = Math.max(cur.y1, next.y1);
          if (next.isUncertain) cur.isUncertain = true;
        } else {
          cur.cx = (cur.x0 + cur.x1) / 2;
          tokens.push(cur);
          cur = { ...next };
        }
      }
      cur.cx = (cur.x0 + cur.x1) / 2;
      tokens.push(cur);
      rowTokens.push(tokens);
    }

    if (!rowTokens.length) return null;

    const allTokens = rowTokens.flat();
    const maxTokensInRow = Math.max(...rowTokens.map(r => r.length));

    const colBands = [];
    const colTol = Math.max(28, Math.floor(imgW * 0.05));

    for (const tok of allTokens) {
      let matched = null;
      for (const b of colBands) {
        if (Math.abs(tok.cx - b.center) < colTol || (tok.x0 <= b.max && tok.x1 >= b.min)) {
          matched = b; break;
        }
      }
      if (matched) {
        matched.samples.push(tok.cx);
        matched.center = matched.samples.reduce((s, v) => s + v, 0) / matched.samples.length;
        matched.min = Math.min(matched.min, tok.x0);
        matched.max = Math.max(matched.max, tok.x1);
      } else {
        colBands.push({ min: tok.x0, max: tok.x1, center: tok.cx, samples: [tok.cx] });
      }
    }

    colBands.sort((a, b) => a.center - b.center);
    const numCols = Math.max(maxTokensInRow, colBands.length);

    const grid = [];
    const isUncertainMap = {};

    rowTokens.forEach((tokens, ri) => {
      const row = Array(numCols).fill('');
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        let bestC = 0, bestDist = Infinity;
        for (let c = 0; c < colBands.length; c++) {
          const d = Math.abs(tok.cx - colBands[c].center);
          if (d < bestDist) {
            bestDist = d; bestC = c;
          }
        }
        if (bestC < numCols && !row[bestC]) {
          row[bestC] = this.cleanCellText(tok.text);
          if (tok.isUncertain) isUncertainMap[`${ri}_${bestC}`] = true;
        } else {
          let placed = false;
          for (let c = bestC; c < numCols; c++) {
            if (!row[c]) {
              row[c] = this.cleanCellText(tok.text);
              if (tok.isUncertain) isUncertainMap[`${ri}_${c}`] = true;
              placed = true; break;
            }
          }
          if (!placed) {
            row[bestC] += ' ' + this.cleanCellText(tok.text);
          }
        }
      }
      grid.push(row);
    });

    return this.pruneAndFinalizeGrid(grid, isUncertainMap, 'borderless');
  },

  parseDelimitedText(rawText) {
    const rawLines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (!rawLines.length) return null;

    const rows = rawLines.map(line => {
      if (line.includes('\t')) {
        return line.split('\t').map(c => this.cleanCellText(c));
      }
      if (line.includes(' | ')) {
        return line.split(' | ').map(c => this.cleanCellText(c));
      }
      const parts = line.split(/\s{2,}/).map(c => this.cleanCellText(c)).filter(c => c.length > 0);
      return parts.length > 1 ? parts : [this.cleanCellText(line)];
    });

    return this.pruneAndFinalizeGrid(rows, {}, 'text_parsed');
  },

  /**
   * Robust cell word ordering:
   * Groups words belonging to the same text line using vertical span overlap and center proximity,
   * sorts lines top-to-bottom, and sorts words within each line strictly left-to-right.
   * Completely avoids word-order swapping caused by mixed-case bounding box variations.
   */
  sortCellWords(words) {
    if (!words || words.length <= 1) return words || [];

    const lines = [];
    const sortedByY = [...words].sort((a, b) => a.cy - b.cy);

    for (const w of sortedByY) {
      let matched = null;
      for (const l of lines) {
        const lineH = Math.max(1, l.y1 - l.y0);
        const wordH = Math.max(1, w.y1 - w.y0);
        const ov = Math.max(0, Math.min(w.y1, l.y1) - Math.max(w.y0, l.y0));
        const minH = Math.min(lineH, wordH);
        if (ov >= minH * 0.45 || Math.abs(w.cy - l.cy) <= Math.max(8, minH * 0.4)) {
          matched = l;
          break;
        }
      }
      if (matched) {
        matched.words.push(w);
        matched.y0 = Math.min(matched.y0, w.y0);
        matched.y1 = Math.max(matched.y1, w.y1);
        matched.cy = (matched.y0 + matched.y1) / 2;
      } else {
        lines.push({ y0: w.y0, y1: w.y1, cy: w.cy, words: [w] });
      }
    }

    lines.sort((a, b) => a.cy - b.cy);

    const sorted = [];
    for (const l of lines) {
      l.words.sort((a, b) => a.x0 - b.x0);
      sorted.push(...l.words);
    }
    return sorted;
  },

  cleanCellText(text) {
    if (!text) return '';
    let val = String(text).trim();

    // Remove single isolated separator or punctuation noise characters (e.g. stray border lines misread as text)
    if (/^[|!lI·•_\-—~`'"^\[\]\\/]$/.test(val)) return '';
    if (/^[.,·•_\-—~`'"^\[\]\\/|!]+$/.test(val)) return '';
    if (/^\s*\.\s*1\s*$/.test(val)) return '';

    // Strip isolated pipes, underscores, tildes from edges (preserving negative sign if followed by digit or currency)
    val = val.replace(/^([|_\~—\s]+|-(?!\d|\$))/, '').trim();
    val = val.replace(/[|_\~—\s]+$/, '').trim();

    // Fix stray underscores between letters (scanned underline touching text)
    val = val.replace(/([a-zA-Z])_([a-zA-Z])/g, '$1 $2');

    // Fix spaced decimals, commas, currency, dates, percentages (common Tesseract tokenization glitches)
    val = val.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
    val = val.replace(/(\d)\s*,\s*(\d)/g, '$1,$2');
    val = val.replace(/([$€£¥₹])\s+(\d)/g, '$1$2');
    val = val.replace(/(\d)\s+%/g, '$1%');
    val = val.replace(/(\d{2,4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,4})/g, '$1-$2-$3');

    // Fix OCR numeric confusions in clean financial / decimal numbers (e.g., "$1O.50" -> "$10.50")
    if (/[0-9]/.test(val) && /[oO]/.test(val)) {
      val = val.replace(/(\d)[oO](\d)/g, '$10$2')
               .replace(/(\d)[oO]\b/g, '$10')
               .replace(/\b[oO](\d)/g, '0$1');
    }

    // Fix numeric 1 vs l/I/| between digits: e.g. "1l0" -> "110", "2|5" -> "215"
    val = val.replace(/(\d)\s*[lI|]\s*(\d)/g, '$11$2');

    // Fix accidental zeros in words: e.g. "T0TAL" -> "TOTAL", "AM0UNT" -> "AMOUNT"
    val = val.replace(/([A-Z])0([A-Z])/g, '$1O$2');

    // Fix accidental ones in words: e.g. "Tota1" -> "Total", "Sa1es" -> "Sales"
    val = val.replace(/([a-zA-Z])1([a-zA-Z])/g, '$1l$2');

    // Fix stray pipes inside words: e.g. "Tota|" -> "Total", "|tem" -> "Item", "Sa|es" -> "Sales"
    val = val.replace(/([a-zA-Z])\|([a-zA-Z])/g, '$1l$2');
    val = val.replace(/(^|\s)\|([a-zA-Z]+)/g, '$1I$2');
    val = val.replace(/([a-zA-Z]+)\|(?=\s|$|[.,;:!?])/g, '$1l');

    // Normalize repeated whitespace
    val = val.replace(/\s{2,}/g, ' ').trim();
    return val;
  },

  cleanHeaderCell(text) {
    if (!text) return '';
    let val = this.cleanCellText(text);

    // Only discard if the cell contains ONLY non-alphanumeric noise characters
    if (/^[^a-zA-Z0-9]+$/.test(val)) return '';

    return val.trim();
  },

  remapUncertainties(isUncertainMap, rowShift) {
    if (!isUncertainMap || !rowShift) return isUncertainMap || {};
    const remapped = {};
    for (const [key, val] of Object.entries(isUncertainMap)) {
      const [r, c] = key.split('_').map(Number);
      const newR = r - rowShift;
      if (newR >= 0) {
        remapped[`${newR}_${c}`] = val;
      }
    }
    return remapped;
  },

  pruneAndFinalizeGrid(grid, isUncertainMap = {}, structureType = 'table') {
    if (!grid || !grid.length) return null;

    let shiftCount = 0;

    // Only drop Row 0 if ALL cells in Row 0 are completely empty or pure non-alphanumeric noise
    if (grid.length >= 2) {
      const row0HasAnyContent = grid[0].some(c => c && /[a-zA-Z0-9]/.test(c));
      const row1HasContent = grid[1].some(c => c && /[a-zA-Z0-9]/.test(c));

      if (!row0HasAnyContent && row1HasContent) {
        grid.shift();
        shiftCount++;
      }
    }

    // Defense-in-depth: If Row 0 is now header, check if Row 1 is a spurious pure non-alphanumeric line
    if (grid.length >= 3) {
      const row1Filled = grid[1].filter(c => c && c.trim() !== '' && c.trim() !== '—');
      if (row1Filled.length === 1 && /^[^a-zA-Z0-9]+$/.test(row1Filled[0])) {
        grid.splice(1, 1);
      }
    }

    if (structureType !== 'bordered') {
      while (grid.length > 0 && grid[0].every(val => !val || val.trim() === '')) {
        grid.shift();
        shiftCount++;
      }
      while (grid.length > 0 && grid[grid.length - 1].every(val => !val || val.trim() === '')) {
        grid.pop();
      }
    }

    if (!grid.length) return null;

    const colCount = Math.max(...grid.map(r => r.length));
    for (const row of grid) {
      while (row.length < colCount) row.push('');
    }

    // Clean header row (grid[0]) without overwriting legitimate header titles
    if (grid.length > 0) {
      for (let c = 0; c < grid[0].length; c++) {
        grid[0][c] = this.cleanHeaderCell(grid[0][c]);
      }
    }

    const remappedUncertain = this.remapUncertainties(isUncertainMap, shiftCount);

    return {
      rowCount: grid.length,
      colCount,
      grid,
      isUncertainMap: remappedUncertain || {},
      structureType
    };
  },

  // ── RESULT DISPLAY & EDITING ──────────────────────────────────────────────

  showResultScreen(docModel) {
    if (this.scanningCard) {
      this.scanningCard.style.display = 'none';
      this.scanningCard.setAttribute('aria-busy', 'false');
    }
    if (this.noTableCard) this.noTableCard.style.display = 'none';

    const table = docModel.table;
    if (this.dimensionsEl) {
      if (table && table.rowCount > 0 && table.colCount > 0) {
        this.dimensionsEl.textContent = `${table.rowCount} Rows × ${table.colCount} Columns`;
      } else {
        const pCount = (docModel.paragraphs?.length || 0);
        this.dimensionsEl.textContent = `${pCount} Section${pCount === 1 ? '' : 's'} / Paragraphs`;
      }
    }

    if (this.tableContainer) {
      this.tableContainer.innerHTML = this.renderDocumentHtml(docModel);
      this.attachDocumentEditListeners();
    }

    if (this.resultCard) {
      this.resultCard.style.display = 'block';
      this.resultCard.setAttribute('aria-hidden', 'false');
    }

    // Highlight recommended export buttons
    const exportBtns = [
      { id: '#btn-export-excel', fmt: 'excel' },
      { id: '#btn-export-word', fmt: 'word' },
      { id: '#btn-export-pdf', fmt: 'pdf' }
    ];
    exportBtns.forEach(({ id, fmt }) => {
      const btn = Utils.qs(id);
      if (btn) {
        if (docModel.recommendedExport === fmt) {
          btn.classList.add('btn-export-recommended');
        } else {
          btn.classList.remove('btn-export-recommended');
        }
      }
    });

    if (table && table.rowCount > 0) {
      Utils.announce(`Scan complete. Detected ${table.rowCount} rows and ${table.colCount} columns.`);
    } else {
      const pCount = (docModel.paragraphs?.length || 0);
      Utils.announce(`Scan complete. Extracted ${pCount} document sections.`);
    }
  },

  refreshDocumentView() {
    this.syncTableFromDOM();
    if (this.tableContainer && this.currentDocument) {
      this.tableContainer.innerHTML = this.renderDocumentHtml(this.currentDocument);
      this.attachDocumentEditListeners();
    }
  },

  renderDocumentHtml(docModel) {
    const table = docModel.table;
    const grid = table?.grid || [];
    const isUncertainMap = table?.isUncertainMap || {};
    const colCount = table?.colCount || (grid[0]?.length || 0);
    const hasTable = grid.length > 0 && colCount > 0;
    const paragraphs = docModel.paragraphs || [];
    const notes = docModel.notes || [];

    let html = `
      <div class="document-scan-wrapper" id="document-scan-wrapper">
        <div class="scan-split-container" id="scan-split-container">
          <div class="scan-image-pane" id="scan-image-pane" style="display: none;">
            <div class="image-pane-header">
              <span class="image-pane-title">Uploaded Source Image</span>
              <div class="zoom-controls">
                <button type="button" class="btn-zoom" id="btn-zoom-out" title="Zoom Out" aria-label="Zoom Out">−</button>
                <span class="zoom-level-text" id="zoom-level-text">100%</span>
                <button type="button" class="btn-zoom" id="btn-zoom-in" title="Zoom In" aria-label="Zoom In">+</button>
                <button type="button" class="btn-zoom btn-zoom-fit" id="btn-zoom-fit" title="Fit to Pane">Fit</button>
              </div>
            </div>
            <div class="image-viewport" id="image-viewport">
              <img id="comparison-source-img" src="${docModel.sourceImageUrl || ''}" alt="Uploaded document" class="comparison-source-img">
            </div>
          </div>

          <div class="scan-editor-pane" id="scan-editor-pane">
            <!-- Smart Recommendation Banner -->
            <div class="smart-rec-banner" id="smart-rec-banner">
              <div class="smart-rec-left">
                <span class="smart-rec-icon">💡</span>
                <span class="smart-rec-text">${Utils.escapeHtml(docModel.recommendationReason || 'Recommended Export Formats:')}</span>
              </div>
              <div class="smart-rec-chips">
                ${(docModel.recommendedFormats || ['word', 'pdf']).map(fmt => `
                  <span class="rec-chip">${fmt === 'word' ? '📄 Word' : fmt === 'pdf' ? '📕 PDF' : fmt === 'excel' ? '📊 Excel' : fmt}</span>
                `).join('')}
              </div>
            </div>

            <!-- Document Title Row -->
            <div class="doc-title-row">
              <input type="text" id="doc-title-input" class="doc-title-input" 
                value="${Utils.escapeHtml(docModel.title || '')}" 
                placeholder="Document Title (e.g. Report Heading, Article Title, Table Name...)" 
                title="Click to edit document title">
            </div>

            <!-- Document Paragraphs / Headings / Lists Editor -->
            <div class="doc-paragraphs-box" id="doc-paragraphs-box">
              <div class="doc-section-header">
                <span class="doc-section-title">Document Text &amp; Paragraphs (${paragraphs.length})</span>
                <button type="button" class="btn-add-para" id="btn-add-paragraph" title="Add new paragraph section">+ Add Paragraph</button>
              </div>
              <div id="para-items-container">
                ${paragraphs.map((p, idx) => `
                  <div class="doc-para-wrapper" data-pindex="${idx}">
                    <div class="doc-para-controls">
                      <span class="para-num">Section ${idx + 1}</span>
                      <button type="button" class="btn-para-action btn-para-up" data-pindex="${idx}" title="Move Up (reorder reading order)" ${idx === 0 ? 'disabled' : ''}>↑</button>
                      <button type="button" class="btn-para-action btn-para-down" data-pindex="${idx}" title="Move Down (reorder reading order)" ${idx === (paragraphs.length - 1) ? 'disabled' : ''}>↓</button>
                      <button type="button" class="btn-para-action btn-para-del" data-pindex="${idx}" title="Delete Section">×</button>
                    </div>
                    <p class="doc-paragraph-item" contenteditable="true" data-pindex="${idx}" title="Click to edit paragraph">${Utils.escapeHtml(p)}</p>
                  </div>
                `).join('')}
              </div>
            </div>
    `;

    // Render Table section only if a structured table exists
    if (hasTable) {
      html += `
        <div class="table-section-box" id="table-section-box">
          <div class="table-edit-toolbar">
            <span class="table-edit-label">Table Tools:</span>
            <button type="button" class="btn-table-action" id="btn-add-row" title="Add row at bottom">+ Row</button>
            <button type="button" class="btn-table-action" id="btn-del-row" title="Remove last row">− Row</button>
            <button type="button" class="btn-table-action" id="btn-add-col" title="Add column to right">+ Col</button>
            <button type="button" class="btn-table-action" id="btn-del-col" title="Remove last column">− Col</button>
          </div>
          <div class="table-responsive-wrapper">
            <table class="detected-table" role="table" aria-label="Detected table results">
              <thead><tr>
                <th class="table-row-num-th" aria-label="Row number">#</th>
      `;

      const cellSpans = table?.cellSpans || {};
      const coveredCells = new Set();
      for (const [key, span] of Object.entries(cellSpans)) {
        const [sr, sc] = key.split('_').map(Number);
        const rSpan = span.rowspan || 1;
        const cSpan = span.colspan || 1;
        for (let dr = 0; dr < rSpan; dr++) {
          for (let dc = 0; dc < cSpan; dc++) {
            if (dr > 0 || dc > 0) coveredCells.add(`${sr + dr}_${sc + dc}`);
          }
        }
      }

      for (let c = 0; c < colCount; c++) {
        if (coveredCells.has(`0_${c}`)) continue;
        const span = cellSpans[`0_${c}`];
        const colSpanAttr = span?.colspan > 1 ? ` colspan="${span.colspan}"` : '';
        const rowSpanAttr = span?.rowspan > 1 ? ` rowspan="${span.rowspan}"` : '';
        const rawHeader = grid[0]?.[c] || '';
        const empty = rawHeader.trim() === '';
        const headerVal = empty ? `<span class="empty-cell-pill" aria-label="Empty cell">—</span>` : Utils.escapeHtml(rawHeader);
        html += `<th scope="col" contenteditable="true" data-row="0" data-col="${c}"${colSpanAttr}${rowSpanAttr} class="${empty ? 'cell-empty' : ''}" title="Click to edit header">${headerVal}</th>`;
      }
      html += `</tr></thead><tbody>`;

      for (let r = 1; r < grid.length; r++) {
        html += `<tr><td class="table-row-num-td">${r}</td>`;
        for (let c = 0; c < colCount; c++) {
          if (coveredCells.has(`${r}_${c}`)) continue;
          const span = cellSpans[`${r}_${c}`];
          const colSpanAttr = span?.colspan > 1 ? ` colspan="${span.colspan}"` : '';
          const rowSpanAttr = span?.rowspan > 1 ? ` rowspan="${span.rowspan}"` : '';
          const raw = grid[r]?.[c] || '';
          const empty = raw.trim() === '';
          const isUncertain = !!isUncertainMap[`${r}_${c}`];
          const uncertainClass = isUncertain ? 'cell-uncertain' : '';
          const uncertainTitle = isUncertain ? 'Uncertain OCR confidence. Click to verify/edit.' : 'Click to edit cell';

          html += `<td contenteditable="true" data-row="${r}" data-col="${c}"${colSpanAttr}${rowSpanAttr} 
                     class="${empty ? 'cell-empty' : ''} ${uncertainClass}" 
                     title="${uncertainTitle}">` +
            (empty ? `<span class="empty-cell-pill" aria-label="Empty cell">—</span>` : Utils.escapeHtml(raw)) +
            `</td>`;
        }
        html += `</tr>`;
      }

      html += `</tbody></table></div></div>`;
    }

    // Render Notes & Summary section
    if (notes.length > 0 || !hasTable) {
      html += `
        <div class="doc-notes-box" id="doc-notes-box">
          <div class="doc-section-header">
            <span class="doc-section-title">Notes &amp; Summary (${notes.length})</span>
            <button type="button" class="btn-add-note" id="btn-add-note" title="Add note section">+ Add Note</button>
          </div>
          <div id="notes-items-container">
            ${notes.map((n, idx) => `
              <div class="doc-para-wrapper" data-nindex="${idx}">
                <div class="doc-para-controls">
                  <span class="para-num">Note ${idx + 1}</span>
                  <button type="button" class="btn-para-action btn-note-del" data-nindex="${idx}" title="Delete Note">×</button>
                </div>
                <div class="doc-note-item" contenteditable="true" data-nindex="${idx}" title="Click to edit note">${Utils.escapeHtml(n)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    html += `</div></div></div>`;
    return html;
  },

  attachDocumentEditListeners() {
    if (!this.tableContainer) return;

    // Table cell edits
    const editableCells = this.tableContainer.querySelectorAll('.detected-table [contenteditable="true"]');
    editableCells.forEach(cell => {
      cell.addEventListener('input', () => {
        const r = parseInt(cell.getAttribute('data-row'), 10);
        const c = parseInt(cell.getAttribute('data-col'), 10);
        if (this.currentDocument?.table?.grid?.[r] && c !== undefined) {
          const text = cell.innerText.trim();
          this.currentDocument.table.grid[r][c] = text;
          if (text) {
            cell.classList.remove('cell-empty');
          }
          cell.classList.remove('cell-uncertain');
          if (this.currentDocument.table.isUncertainMap) {
            delete this.currentDocument.table.isUncertainMap[`${r}_${c}`];
          }
        }
      });
    });

    // Title input
    const titleInput = this.tableContainer.querySelector('#doc-title-input');
    if (titleInput) {
      titleInput.addEventListener('input', (e) => {
        if (this.currentDocument) {
          this.currentDocument.title = e.target.value.trim();
        }
      });
    }

    // Paragraph direct text edits
    const pElements = this.tableContainer.querySelectorAll('.doc-paragraph-item[contenteditable="true"]');
    pElements.forEach(pEl => {
      pEl.addEventListener('input', () => {
        const idx = parseInt(pEl.getAttribute('data-pindex'), 10);
        if (this.currentDocument?.paragraphs && idx !== undefined) {
          this.currentDocument.paragraphs[idx] = pEl.innerText.trim();
        }
      });
    });

    // Paragraph Move Up
    const upButtons = this.tableContainer.querySelectorAll('.btn-para-up');
    upButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-pindex'), 10);
        if (this.currentDocument?.paragraphs && idx > 0) {
          this.syncTableFromDOM();
          const tmp = this.currentDocument.paragraphs[idx];
          this.currentDocument.paragraphs[idx] = this.currentDocument.paragraphs[idx - 1];
          this.currentDocument.paragraphs[idx - 1] = tmp;
          this.refreshDocumentView();
        }
      });
    });

    // Paragraph Move Down
    const downButtons = this.tableContainer.querySelectorAll('.btn-para-down');
    downButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-pindex'), 10);
        if (this.currentDocument?.paragraphs && idx < this.currentDocument.paragraphs.length - 1) {
          this.syncTableFromDOM();
          const tmp = this.currentDocument.paragraphs[idx];
          this.currentDocument.paragraphs[idx] = this.currentDocument.paragraphs[idx + 1];
          this.currentDocument.paragraphs[idx + 1] = tmp;
          this.refreshDocumentView();
        }
      });
    });

    // Paragraph Delete
    const delButtons = this.tableContainer.querySelectorAll('.btn-para-del');
    delButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-pindex'), 10);
        if (this.currentDocument?.paragraphs && idx !== undefined) {
          this.syncTableFromDOM();
          this.currentDocument.paragraphs.splice(idx, 1);
          this.refreshDocumentView();
        }
      });
    });

    // Add Paragraph
    const btnAddPara = this.tableContainer.querySelector('#btn-add-paragraph');
    if (btnAddPara) {
      btnAddPara.addEventListener('click', () => {
        this.syncTableFromDOM();
        if (!this.currentDocument.paragraphs) this.currentDocument.paragraphs = [];
        this.currentDocument.paragraphs.push('New paragraph text...');
        this.refreshDocumentView();
      });
    }

    // Notes direct text edits
    const nElements = this.tableContainer.querySelectorAll('.doc-note-item[contenteditable="true"]');
    nElements.forEach(nEl => {
      nEl.addEventListener('input', () => {
        const idx = parseInt(nEl.getAttribute('data-nindex'), 10);
        if (this.currentDocument?.notes && idx !== undefined) {
          this.currentDocument.notes[idx] = nEl.innerText.trim();
        }
      });
    });

    // Note Delete
    const noteDelBtns = this.tableContainer.querySelectorAll('.btn-note-del');
    noteDelBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-nindex'), 10);
        if (this.currentDocument?.notes && idx !== undefined) {
          this.syncTableFromDOM();
          this.currentDocument.notes.splice(idx, 1);
          this.refreshDocumentView();
        }
      });
    });

    // Add Note
    const btnAddNote = this.tableContainer.querySelector('#btn-add-note');
    if (btnAddNote) {
      btnAddNote.addEventListener('click', () => {
        this.syncTableFromDOM();
        if (!this.currentDocument.notes) this.currentDocument.notes = [];
        this.currentDocument.notes.push('New note or summary item...');
        this.refreshDocumentView();
      });
    }

    // Table Toolbar Actions: Add / Remove Rows and Columns
    const btnAddRow = this.tableContainer.querySelector('#btn-add-row');
    if (btnAddRow) {
      btnAddRow.addEventListener('click', () => {
        this.syncTableFromDOM();
        if (this.currentDocument?.table?.grid) {
          const colCount = Math.max(1, this.currentDocument.table.colCount || this.currentDocument.table.grid[0]?.length || 1);
          this.currentDocument.table.grid.push(Array(colCount).fill(''));
          this.currentDocument.table.rowCount = this.currentDocument.table.grid.length;
          this.refreshDocumentView();
        }
      });
    }

    const btnDelRow = this.tableContainer.querySelector('#btn-del-row');
    if (btnDelRow) {
      btnDelRow.addEventListener('click', () => {
        this.syncTableFromDOM();
        if (this.currentDocument?.table?.grid && this.currentDocument.table.grid.length > 1) {
          this.currentDocument.table.grid.pop();
          this.currentDocument.table.rowCount = this.currentDocument.table.grid.length;
          this.refreshDocumentView();
        }
      });
    }

    const btnAddCol = this.tableContainer.querySelector('#btn-add-col');
    if (btnAddCol) {
      btnAddCol.addEventListener('click', () => {
        this.syncTableFromDOM();
        if (this.currentDocument?.table?.grid) {
          this.currentDocument.table.grid.forEach(row => row.push(''));
          this.currentDocument.table.colCount = (this.currentDocument.table.grid[0]?.length || 1);
          this.refreshDocumentView();
        }
      });
    }

    const btnDelCol = this.tableContainer.querySelector('#btn-del-col');
    if (btnDelCol) {
      btnDelCol.addEventListener('click', () => {
        this.syncTableFromDOM();
        if (this.currentDocument?.table?.grid && (this.currentDocument.table.colCount || this.currentDocument.table.grid[0]?.length) > 1) {
          this.currentDocument.table.grid.forEach(row => row.pop());
          this.currentDocument.table.colCount = (this.currentDocument.table.grid[0]?.length || 1);
          this.refreshDocumentView();
        }
      });
    }

    // Zoom Controls
    const btnZoomIn = this.tableContainer.querySelector('#btn-zoom-in');
    const btnZoomOut = this.tableContainer.querySelector('#btn-zoom-out');
    const btnZoomFit = this.tableContainer.querySelector('#btn-zoom-fit');
    this.comparisonImg = this.tableContainer.querySelector('#comparison-source-img');
    this.imagePane = this.tableContainer.querySelector('#scan-image-pane');

    if (btnZoomIn) btnZoomIn.addEventListener('click', () => this.adjustZoom(0.25));
    if (btnZoomOut) btnZoomOut.addEventListener('click', () => this.adjustZoom(-0.25));
    if (btnZoomFit) btnZoomFit.addEventListener('click', () => this.resetZoom());

    // Mobile keyboard awareness: smooth scroll focused editing field into view
    const isTouchOrMobile = typeof navigator !== 'undefined' && (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || (typeof window !== 'undefined' && window.innerWidth < 768));
    if (isTouchOrMobile) {
      const scrollOnFocus = (el) => {
        if (!el) return;
        el.addEventListener('focus', () => {
          setTimeout(() => {
            try {
              el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            } catch (_) {}
          }, 300);
        });
      };
      if (titleInput) scrollOnFocus(titleInput);
      editableCells.forEach(scrollOnFocus);
      pElements.forEach(scrollOnFocus);
      nElements.forEach(scrollOnFocus);
    }
  },

  // ── IMAGE COMPARISON VIEW ─────────────────────────────────────────────────

  toggleImageComparison() {
    this.imagePane = Utils.qs('#scan-image-pane');
    if (!this.imagePane) return;

    const isVisible = this.imagePane.style.display !== 'none';
    if (isVisible) {
      this.imagePane.style.display = 'none';
      if (this.btnToggleCompare) {
        this.btnToggleCompare.classList.remove('btn-active');
        this.btnToggleCompare.querySelector('span').textContent = 'Compare';
      }
    } else {
      this.imagePane.style.display = 'flex';
      if (this.btnToggleCompare) {
        this.btnToggleCompare.classList.add('btn-active');
        this.btnToggleCompare.querySelector('span').textContent = 'Hide Image';
      }
      this.resetZoom();
    }
  },

  adjustZoom(delta) {
    if (!this.comparisonImg) return;
    this.zoomLevel = Math.max(0.5, Math.min(3.0, this.zoomLevel + delta));
    this.comparisonImg.style.transform = `scale(${this.zoomLevel})`;
    const zoomText = Utils.qs('#zoom-level-text');
    if (zoomText) zoomText.textContent = `${Math.round(this.zoomLevel * 100)}%`;
  },

  resetZoom() {
    if (!this.comparisonImg) return;
    this.zoomLevel = 1.0;
    this.comparisonImg.style.transform = `scale(1.0)`;
    const zoomText = Utils.qs('#zoom-level-text');
    if (zoomText) zoomText.textContent = `100%`;
  },

  syncTableFromDOM() {
    if (!this.tableContainer || !this.currentDocument) return;

    // Sync title
    const titleInput = this.tableContainer.querySelector('#doc-title-input');
    if (titleInput) {
      this.currentDocument.title = titleInput.value.trim();
    }

    // Sync table grid
    const tableEl = this.tableContainer.querySelector('.detected-table');
    if (tableEl) {
      const rows = tableEl.querySelectorAll('tr');
      const newGrid = [];
      rows.forEach(tr => {
        const cells = tr.querySelectorAll('th[data-col], td[data-col]');
        if (cells.length > 0) {
          const rowData = [];
          cells.forEach(cell => {
            const pill = cell.querySelector('.empty-cell-pill');
            let text = pill ? '' : cell.innerText.trim();
            if (text === '—') text = '';
            rowData.push(text);
          });
          newGrid.push(rowData);
        }
      });
      if (newGrid.length > 0) {
        if (!this.currentDocument.table) {
          this.currentDocument.table = { rowCount: newGrid.length, colCount: newGrid[0].length, grid: newGrid };
        } else {
          this.currentDocument.table.grid = newGrid;
          this.currentDocument.table.rowCount = newGrid.length;
          this.currentDocument.table.colCount = newGrid[0].length;
        }
      }
    }

    // Sync paragraphs
    const pEls = this.tableContainer.querySelectorAll('.doc-paragraph-item[contenteditable="true"]');
    if (pEls.length > 0) {
      this.currentDocument.paragraphs = Array.from(pEls).map(p => p.innerText.trim());
    } else if (this.tableContainer.querySelector('#para-items-container')) {
      this.currentDocument.paragraphs = [];
    }

    // Sync notes
    const noteEls = this.tableContainer.querySelectorAll('.doc-note-item[contenteditable="true"]');
    if (noteEls.length > 0) {
      this.currentDocument.notes = Array.from(noteEls).map(n => n.innerText.trim());
    } else if (this.tableContainer.querySelector('#notes-items-container')) {
      this.currentDocument.notes = [];
    }
  },

  getExportFilename(ext) {
    let base = this.currentDocument?.title?.trim();
    if (!base && this.currentFileName) {
      base = this.currentFileName.replace(/\.[^.]+$/, '');
    }
    if (!base) {
      base = 'ScanSheet_Converted_Table';
    }
    const cleanBase = base.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'ScanSheet_Export';
    return `${cleanBase}.${ext}`;
  },

  // ── MULTI-FORMAT EXPORTS ──────────────────────────────────────────────────

  async handleExport(format) {
    this.syncTableFromDOM();
    if (!this.currentDocument) {
      UI.showNotification('No document content to export.');
      return;
    }

    try {
      if (format === 'word') {
        const filename = this.getExportFilename('docx');
        this.setStatus('Generating Word document (.docx)...');
        await DocumentExporter.exportWord(this.currentDocument, filename);
        UI.showNotification(`Successfully exported ${filename}`);
        Utils.announce('Word document downloaded.');
      } else if (format === 'pdf') {
        const filename = this.getExportFilename('pdf');
        this.setStatus('Generating PDF document (.pdf)...');
        await DocumentExporter.exportPDF(this.currentDocument, filename);
        UI.showNotification(`Successfully exported ${filename}`);
        Utils.announce('PDF document downloaded.');
      } else if (format === 'image') {
        const filename = this.getExportFilename('png');
        this.setStatus('Rendering high-resolution image (.png)...');
        await DocumentExporter.exportImage(this.currentDocument, filename);
        UI.showNotification(`Successfully exported ${filename}`);
        Utils.announce('PNG image downloaded.');
      } else if (format === 'excel') {
        const filename = this.getExportFilename('xlsx');
        if (!this.currentDocument.table || !this.currentDocument.table.grid?.length) {
          UI.showNotification('Note: Exporting text document to Excel: lines placed into spreadsheet rows. (Tip: Use Word or PDF for standard document layout).');
        }
        this.setStatus('Generating Excel workbook (.xlsx)...');
        DocumentExporter.exportExcel(this.currentDocument, filename);
        UI.showNotification(`Successfully exported ${filename}`);
        Utils.announce('Excel spreadsheet downloaded.');
      }
    } catch (err) {
      console.error(`[Scanner] Export ${format} error:`, err);
      UI.showNotification(`Failed to export as ${format.toUpperCase()}: ${err.message || 'Export error'}`);
    }
  },

  openMultiExportModal() {
    this.syncTableFromDOM();
    if (!this.currentDocument) {
      UI.showNotification('Please upload and scan a table image first to export content.');
      const dropZone = Utils.qs('#upload-drop-zone');
      if (dropZone) dropZone.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    this.multiExportModal = Utils.qs('#multi-export-modal');
    if (!this.multiExportModal) return;

    const docInfo = Utils.qs('#multi-export-doc-info');
    const docTitle = Utils.qs('#multi-export-doc-title');
    const confirmBtn = Utils.qs('#btn-confirm-multi-export');

    if (docInfo) docInfo.style.display = 'flex';
    if (docTitle) {
      docTitle.textContent = this.currentDocument.title || `${this.currentDocument.table?.rowCount || 0} Rows × ${this.currentDocument.table?.colCount || 0} Cols`;
    }
    if (confirmBtn) {
      confirmBtn.querySelector('span').textContent = 'Download Selected Files';
    }

    this.multiExportModal.classList.add('visible');
    this.multiExportModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  },

  closeMultiExportModal() {
    this.multiExportModal = Utils.qs('#multi-export-modal');
    if (this.multiExportModal) {
      this.multiExportModal.classList.remove('visible');
      this.multiExportModal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
    }
  },

  async confirmMultiExport() {
    this.syncTableFromDOM();
    if (!this.currentDocument) {
      UI.showNotification('No scanned document to export. Please upload an image first.');
      return;
    }

    const formats = [];
    const chkExcel = Utils.qs('#chk-export-excel');
    const chkWord = Utils.qs('#chk-export-word');
    const chkPdf = Utils.qs('#chk-export-pdf');
    const chkImage = Utils.qs('#chk-export-image');
    const radioZip = Utils.qs('#radio-delivery-zip');

    if (chkExcel && chkExcel.checked) formats.push('excel');
    if (chkWord && chkWord.checked) formats.push('word');
    if (chkPdf && chkPdf.checked) formats.push('pdf');
    if (chkImage && chkImage.checked) formats.push('image');

    if (formats.length === 0) {
      UI.showNotification('Please select at least one format to export.');
      return;
    }

    const asZip = !!(radioZip && radioZip.checked);

    try {
      this.closeMultiExportModal();
      this.setStatus('Generating selected export formats...');
      UI.showNotification(asZip ? 'Creating ZIP bundle with selected files...' : 'Downloading selected files...');

      const result = await DocumentExporter.exportMultiple(this.currentDocument, formats, asZip);
      if (asZip) {
        UI.showNotification(`Successfully created ${result.bundle} with ${result.count} files.`);
      } else {
        UI.showNotification(`Successfully exported ${result.count} files.`);
      }
      Utils.announce('Multiple file export complete.');
    } catch (err) {
      console.error('[Scanner] Multi-export error:', err);
      UI.showNotification(`Multi-export failed: ${err.message || 'Error generating files'}`);
    }
  },

  // ── RECORD TO USER HISTORY ───────────────────────────────────────────────

  async recordHistory(file, docModel) {
    try {
      const user = Auth.getUser();
      if (!user) return;

      const table = docModel?.table;
      const originalName = file?.name || 'scanned_image.jpg';
      const isTable = table && table.rowCount > 0;
      const baseName = originalName.replace(/\.[^/.]+$/, "");
      const outputName = isTable 
        ? `${baseName}_Table.xlsx` 
        : `${baseName}_Document.docx`;

      const record = {
        userId: user.id || 'current_user',
        originalFileName: originalName,
        outputFileName: outputName,
        conversionType: docModel?.contentType || (isTable ? 'table' : 'document'),
        conversionDateTime: new Date().toLocaleString(),
        relativeGroup: 'Today',
        rowCount: table?.rowCount || 0,
        columnCount: table?.colCount || 0,
        outputFileRef: outputName,
        conversionStatus: 'completed',
        documentModel: docModel
      };

      await History.addRecord(record);
    } catch (_) { /* non-fatal */ }
  },

  // ── ERROR / RESET ─────────────────────────────────────────────────────────

  showNoTableFound(customMsg) {
    if (this.scanningCard) {
      this.scanningCard.style.display = 'none';
      this.scanningCard.setAttribute('aria-busy', 'false');
    }
    if (this.resultCard) this.resultCard.style.display = 'none';

    const msg = customMsg || "We couldn't read the content clearly. Please upload a clearer image.";
    const desc = Utils.qs('#no-table-desc');
    if (desc) desc.textContent = msg;

    if (this.noTableCard) {
      this.noTableCard.style.display = 'flex';
      this.noTableCard.setAttribute('aria-hidden', 'false');
    }
    Utils.announce(msg);
  },

  resetToUpload() {
    if (this.scanningCard) this.scanningCard.style.display = 'none';
    if (this.noTableCard) this.noTableCard.style.display = 'none';
    if (this.resultCard) this.resultCard.style.display = 'none';

    const dropZone = Utils.qs('#upload-drop-zone');
    const preview = Utils.qs('#upload-preview-card');
    const fileInput = Utils.qs('#hidden-file-input');

    if (preview) preview.style.display = 'none';
    if (dropZone) dropZone.style.display = 'flex';
    if (fileInput) { fileInput.value = ''; fileInput.click(); }
  }
};
