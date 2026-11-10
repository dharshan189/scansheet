/**
 * ScanSheet - Interactive Image Crop Controller
 * Step 3.2: Touch-friendly bounding-box cropping for Android phones, tablets & desktop
 */

import { Utils } from './utils.js';
import { UI } from './ui.js';

export const Crop = {
  isOpen: false,
  sourceImage: null,
  sourceFile: null,
  onApplyCallback: null,

  // Box coordinates relative to displayed stage image
  box: {
    x: 0,
    y: 0,
    w: 0,
    h: 0
  },

  // Display size of the stage image
  display: {
    w: 0,
    h: 0
  },

  // Dragging state
  drag: null,

  /**
   * Initializes the crop interface elements and listeners
   */
  init() {
    this.modal = Utils.qs('#crop-modal');
    this.stage = Utils.qs('#crop-stage');
    this.stageImg = Utils.qs('#crop-stage-image');
    this.cropBox = Utils.qs('#crop-box');
    this.viewport = Utils.qs('#crop-viewport');

    this.btnApply = Utils.qs('#btn-crop-apply');
    this.btnCancel = Utils.qs('#btn-crop-cancel');
    this.btnReset = Utils.qs('#btn-crop-reset');
    this.btnClose = Utils.qs('#btn-crop-close');

    if (this.btnApply) {
      this.btnApply.addEventListener('click', () => this.apply());
    }

    if (this.btnCancel) {
      this.btnCancel.addEventListener('click', () => this.cancel());
    }

    if (this.btnClose) {
      this.btnClose.addEventListener('click', () => this.cancel());
    }

    if (this.btnReset) {
      this.btnReset.addEventListener('click', () => this.resetCropBox());
    }

    // Touch & Pointer interaction on Crop Box & Handles
    this.setupInteractions();

    // Handle window resize while open
    window.addEventListener('resize', Utils.debounce(() => {
      if (this.isOpen) {
        this.updateStageDimensions();
      }
    }, 150));
  },

  /**
   * Opens the crop interface for a given file and source image
   * @param {Object} options
   * @param {File} options.file
   * @param {string} options.imageUrl
   * @param {Function} options.onApply
   */
  open({ file, imageUrl, onApply }) {
    if (!file || !imageUrl) return;

    this.sourceFile = file;
    this.onApplyCallback = onApply;
    this.isOpen = true;

    // Show modal
    if (this.modal) {
      this.modal.classList.add('visible');
      this.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
    }

    // Load image into stage
    const img = new Image();
    img.onload = () => {
      this.sourceImage = img;
      if (this.stageImg) {
        this.stageImg.src = imageUrl;
      }
      // Give browser a frame to compute modal layout
      requestAnimationFrame(() => {
        this.updateStageDimensions(true);
      });
    };

    img.onerror = () => {
      this.close();
      this.handleCropFailure();
    };

    img.src = imageUrl;
  },

  /**
   * Recalculates stage display dimensions and positions crop box
   * @param {boolean} [resetBox=false]
   */
  updateStageDimensions(resetBox = false) {
    if (!this.stageImg || !this.sourceImage) return;

    const naturalW = this.sourceImage.naturalWidth;
    const naturalH = this.sourceImage.naturalHeight;
    if (!naturalW || !naturalH) return;

    const rect = this.stageImg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      setTimeout(() => this.updateStageDimensions(resetBox), 50);
      return;
    }

    const prevW = this.display.w;
    const prevH = this.display.h;

    this.display.w = rect.width;
    this.display.h = rect.height;

    // Set stage size to match image exact render rect
    if (this.stage) {
      this.stage.style.width = `${rect.width}px`;
      this.stage.style.height = `${rect.height}px`;
    }

    if (resetBox || prevW === 0 || prevH === 0) {
      // Default to 90% centered selection
      const marginX = rect.width * 0.05;
      const marginY = rect.height * 0.05;
      this.box.x = marginX;
      this.box.y = marginY;
      this.box.w = rect.width - (marginX * 2);
      this.box.h = rect.height - (marginY * 2);
    } else {
      // Scale proportionally on screen orientation change / resize
      const scaleX = rect.width / prevW;
      const scaleY = rect.height / prevH;
      this.box.x *= scaleX;
      this.box.y *= scaleY;
      this.box.w *= scaleX;
      this.box.h *= scaleY;
    }

    this.renderBox();
  },

  /**
   * Resets crop box to 100% full bounds of the image
   */
  resetCropBox() {
    if (!this.display.w || !this.display.h) return;
    this.box.x = 0;
    this.box.y = 0;
    this.box.w = this.display.w;
    this.box.h = this.display.h;
    this.renderBox();
    Utils.announce('Crop area reset to full image.');
  },

  /**
   * Renders the crop box CSS coordinates
   */
  renderBox() {
    if (!this.cropBox) return;
    this.cropBox.style.left = `${this.box.x}px`;
    this.cropBox.style.top = `${this.box.y}px`;
    this.cropBox.style.width = `${this.box.w}px`;
    this.cropBox.style.height = `${this.box.h}px`;
  },

  /**
   * Setup pointer and touch drag / resize interactions
   */
  setupInteractions() {
    if (!this.cropBox) return;

    const onPointerDown = (e) => {
      // Only respond to primary mouse button or touch
      if (e.button !== undefined && e.button !== 0) return;

      const handle = e.target.closest('.crop-handle');
      const isHandle = Boolean(handle);
      const handleType = handle ? handle.dataset.handle : null;

      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;

      this.drag = {
        isHandle,
        handleType,
        startX,
        startY,
        initialBox: { ...this.box }
      };

      if (e.target.setPointerCapture && e.pointerId !== undefined) {
        try {
          e.target.setPointerCapture(e.pointerId);
        } catch {
          // pointer capture unsupported or not active
        }
      }

      const onPointerMove = (moveEvent) => {
        if (!this.drag) return;
        moveEvent.preventDefault();

        const dx = moveEvent.clientX - this.drag.startX;
        const dy = moveEvent.clientY - this.drag.startY;
        const init = this.drag.initialBox;

        const minSize = 36; // Minimum touch width/height in px
        const maxW = this.display.w;
        const maxH = this.display.h;

        if (!this.drag.isHandle) {
          // MOVE entire crop box
          let newX = init.x + dx;
          let newY = init.y + dy;

          newX = Math.max(0, Math.min(newX, maxW - init.w));
          newY = Math.max(0, Math.min(newY, maxH - init.h));

          this.box.x = newX;
          this.box.y = newY;
        } else {
          // RESIZE via handle
          const type = this.drag.handleType;
          let x = init.x;
          let y = init.y;
          let w = init.w;
          let h = init.h;

          // Horizontal adjustments
          if (type.includes('w')) {
            const proposedW = init.w - dx;
            if (proposedW >= minSize) {
              const proposedX = init.x + dx;
              if (proposedX >= 0) {
                x = proposedX;
                w = proposedW;
              }
            } else {
              x = init.x + (init.w - minSize);
              w = minSize;
            }
          } else if (type.includes('e')) {
            const proposedW = init.w + dx;
            w = Math.max(minSize, Math.min(proposedW, maxW - init.x));
          }

          // Vertical adjustments
          if (type.includes('n')) {
            const proposedH = init.h - dy;
            if (proposedH >= minSize) {
              const proposedY = init.y + dy;
              if (proposedY >= 0) {
                y = proposedY;
                h = proposedH;
              }
            } else {
              y = init.y + (init.h - minSize);
              h = minSize;
            }
          } else if (type.includes('s')) {
            const proposedH = init.h + dy;
            h = Math.max(minSize, Math.min(proposedH, maxH - init.y));
          }

          this.box.x = x;
          this.box.y = y;
          this.box.w = w;
          this.box.h = h;
        }

        this.renderBox();
      };

      const onPointerUp = () => {
        if (!this.drag) return;
        this.drag = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    };

    // Attach pointerdown to crop box (handles will bubble up)
    this.cropBox.addEventListener('pointerdown', onPointerDown, { passive: false });
  },

  /**
   * Applies the crop: cuts full resolution pixels from source image onto canvas,
   * generates high-quality blob, and returns to preview screen.
   */
  apply() {
    return new Promise((resolve) => {
      if (!this.sourceImage || !this.display.w || !this.display.h) {
        this.handleCropFailure();
        resolve(null);
        return;
      }

      try {
        const naturalW = this.sourceImage.naturalWidth || this.sourceImage.width;
        const naturalH = this.sourceImage.naturalHeight || this.sourceImage.height;

        if (!naturalW || !naturalH) {
          this.handleCropFailure();
          resolve(null);
          return;
        }

        const scaleX = naturalW / this.display.w;
        const scaleY = naturalH / this.display.h;

        // Natural crop coordinates
        const cropX = Math.max(0, Math.round(this.box.x * scaleX));
        const cropY = Math.max(0, Math.round(this.box.y * scaleY));
        const cropW = Math.min(naturalW - cropX, Math.round(this.box.w * scaleX));
        const cropH = Math.min(naturalH - cropY, Math.round(this.box.h * scaleY));

        if (cropW < 5 || cropH < 5) {
          this.handleCropFailure();
          resolve(null);
          return;
        }

        // Draw onto offscreen canvas at full natural resolution
        const canvas = document.createElement('canvas');
        canvas.width = cropW;
        canvas.height = cropH;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          this.handleCropFailure();
          resolve(null);
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.drawImage(
          this.sourceImage,
          cropX, cropY, cropW, cropH,
          0, 0, cropW, cropH
        );

        const mimeType = this.sourceFile?.type || 'image/jpeg';
        const quality = 0.95;

        canvas.toBlob((blob) => {
          if (!blob) {
            this.handleCropFailure();
            resolve(null);
            return;
          }

          const croppedFile = new File([blob], this.sourceFile.name, {
            type: mimeType,
            lastModified: Date.now()
          });

          this.close();

          const result = {
            file: croppedFile,
            blob,
            width: cropW,
            height: cropH
          };

          if (typeof this.onApplyCallback === 'function') {
            this.onApplyCallback(result);
          }

          resolve(result);
        }, mimeType, quality);
      } catch {
        this.handleCropFailure();
        resolve(null);
      }
    });
  },

  /**
   * Cancel cropping and return to original preview
   */
  cancel() {
    this.close();
  },

  /**
   * Closes the crop modal
   */
  close() {
    this.isOpen = false;
    this.drag = null;
    if (this.modal) {
      this.modal.classList.remove('visible');
      this.modal.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('modal-open');
  },

  /**
   * Displays required user-friendly error without technical details
   */
  handleCropFailure() {
    this.close();
    UI.showNotification("We couldn't crop this image. Please try again.");
    Utils.announce("We couldn't crop this image. Please try again.");
  }
};
