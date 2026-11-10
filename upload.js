/**
 * ScanSheet - Upload Workflow & Preview Controller
 * Step 3.1 & 3.2: Client-side Image Selection, Format Validation, Preview & Cropping
 */

import { Utils } from './utils.js';
import { UI } from './ui.js';
import { Auth } from './auth.js';
import { Crop } from './crop.js';
import { Scanner } from './scanner.js';

export const Upload = {
  originalFile: null,
  originalPreviewUrl: null,
  originalDimensions: null,
  baseFile: null,
  basePreviewUrl: null,
  baseDimensions: null,
  currentFile: null,
  currentPreviewUrl: null,
  currentDimensions: null,
  currentRotation: 0,
  isCropped: false,
  isRotating: false,

  // Allowed MIME types and extensions (including webp commonly used on mobile)
  ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  ALLOWED_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.webp'],

  /**
   * Initializes the upload manager elements and events
   */
  init() {
    this.fileInput = Utils.qs('#hidden-file-input');
    this.cameraInput = Utils.qs('#camera-file-input');
    this.dropZone = Utils.qs('#upload-drop-zone');
    this.previewCard = Utils.qs('#upload-preview-card');
    this.previewImg = Utils.qs('#image-preview-element');
    this.fileNameEl = Utils.qs('#preview-file-name');
    this.fileSizeEl = Utils.qs('#preview-file-size');
    this.fileDimensionsEl = Utils.qs('#preview-file-dimensions');
    this.qualityWarningEl = Utils.qs('#image-quality-warning');

    this.btnContinue = Utils.qs('#btn-upload-continue');
    this.btnRotate = Utils.qs('#btn-upload-rotate');
    this.btnCrop = Utils.qs('#btn-upload-crop');
    this.btnChange = Utils.qs('#btn-upload-change');
    this.btnRemove = Utils.qs('#btn-upload-remove');

    if (this.fileInput) {
      this.fileInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) {
          this.handleSelectedFile(file);
        }
      });
    }

    if (this.cameraInput) {
      this.cameraInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) {
          this.handleSelectedFile(file);
        }
      });
    }

    if (this.btnContinue) {
      this.btnContinue.addEventListener('click', () => {
        if (!this.currentPreviewUrl) return;
        Scanner.startScan(this.currentFile, this.currentPreviewUrl, this.currentDimensions);
      });
    }

    if (this.btnRotate) {
      this.btnRotate.addEventListener('click', () => {
        this.rotate();
      });
    }

    if (this.btnCrop) {
      this.btnCrop.addEventListener('click', () => {
        this.openCropInterface();
      });
    }

    if (this.btnChange) {
      this.btnChange.addEventListener('click', () => {
        this.openPicker();
      });
    }

    if (this.btnRemove) {
      this.btnRemove.addEventListener('click', () => {
        this.reset();
        UI.showNotification('Image removed.');
      });
    }
  },

  /**
   * Rotates the current image 90 degrees clockwise (0°, 90°, 180°, 270°)
   */
  async rotate() {
    if (!this.currentFile || this.isRotating) return;
    this.isRotating = true;

    try {
      this.currentRotation = (this.currentRotation + 90) % 360;

      // When returning to 0° (or 360°), restore the pristine base image directly
      if (this.currentRotation === 0) {
        if (this.currentPreviewUrl && 
            this.currentPreviewUrl !== this.basePreviewUrl && 
            this.currentPreviewUrl !== this.originalPreviewUrl) {
          URL.revokeObjectURL(this.currentPreviewUrl);
        }

        this.currentFile = this.baseFile;
        this.currentPreviewUrl = this.basePreviewUrl;
        this.currentDimensions = { ...this.baseDimensions };

        if (this.previewImg) {
          this.previewImg.src = this.basePreviewUrl;
          this.previewImg.alt = `Table image preview: ${this.currentFile.name}`;
        }

        if (this.fileDimensionsEl) {
          this.fileDimensionsEl.textContent = `${this.baseDimensions.width} × ${this.baseDimensions.height} px`;
        }

        if (this.fileSizeEl) {
          this.fileSizeEl.textContent = this.formatFileSize(this.baseFile.size);
        }

        Utils.announce(`Image rotated to original orientation. Dimensions: ${this.baseDimensions.width} by ${this.baseDimensions.height} pixels.`);
        this.evaluateQuality(this.basePreviewUrl, this.baseDimensions.width, this.baseDimensions.height);
        this.isRotating = false;
        return;
      }

      // Generate high-quality rotated image from baseImage
      const rotated = await this.generateRotatedImage(
        this.basePreviewUrl,
        this.baseFile,
        this.currentRotation
      );

      if (!rotated) {
        this.handleRotateFailure();
        this.isRotating = false;
        return;
      }

      // Cleanup previously generated rotated URL
      if (this.currentPreviewUrl && 
          this.currentPreviewUrl !== this.basePreviewUrl && 
          this.currentPreviewUrl !== this.originalPreviewUrl) {
        URL.revokeObjectURL(this.currentPreviewUrl);
      }

      this.currentFile = rotated.file;
      this.currentPreviewUrl = rotated.url;
      this.currentDimensions = { width: rotated.width, height: rotated.height };

      if (this.previewImg) {
        this.previewImg.src = rotated.url;
        this.previewImg.alt = `Rotated table image (${this.currentRotation}°): ${this.currentFile.name}`;
      }

      if (this.fileDimensionsEl) {
        this.fileDimensionsEl.textContent = `${rotated.width} × ${rotated.height} px`;
      }

      if (this.fileSizeEl) {
        this.fileSizeEl.textContent = this.formatFileSize(rotated.blob.size);
      }

      Utils.announce(`Image rotated to ${this.currentRotation} degrees. Dimensions: ${rotated.width} by ${rotated.height} pixels.`);
      this.evaluateQuality(rotated.url, rotated.width, rotated.height);
    } catch {
      this.handleRotateFailure();
    } finally {
      this.isRotating = false;
    }
  },

  /**
   * Generates a canvas-rotated blob and object URL locally on device
   * @param {string} sourceUrl 
   * @param {File} sourceFile 
   * @param {number} angle 
   * @returns {Promise<{file: File, blob: Blob, url: string, width: number, height: number}|null>}
   */
  generateRotatedImage(sourceUrl, sourceFile, angle) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const naturalW = img.naturalWidth || img.width;
          const naturalH = img.naturalHeight || img.height;

          if (!naturalW || !naturalH) {
            resolve(null);
            return;
          }

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          if (!ctx) {
            resolve(null);
            return;
          }

          let outWidth, outHeight;
          if (angle === 90 || angle === 270) {
            canvas.width = naturalH;
            canvas.height = naturalW;
            outWidth = naturalH;
            outHeight = naturalW;
          } else {
            canvas.width = naturalW;
            canvas.height = naturalH;
            outWidth = naturalW;
            outHeight = naturalH;
          }

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';

          // Translate to center, rotate, and draw
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((angle * Math.PI) / 180);
          ctx.drawImage(img, -naturalW / 2, -naturalH / 2);

          const mimeType = sourceFile?.type || 'image/jpeg';
          const quality = 0.95;

          canvas.toBlob((blob) => {
            if (!blob) {
              resolve(null);
              return;
            }

            const rotatedUrl = URL.createObjectURL(blob);
            const rotatedFile = new File([blob], sourceFile.name, {
              type: mimeType,
              lastModified: Date.now()
            });

            resolve({
              file: rotatedFile,
              blob,
              url: rotatedUrl,
              width: outWidth,
              height: outHeight
            });
          }, mimeType, quality);
        } catch {
          resolve(null);
        }
      };

      img.onerror = () => {
        resolve(null);
      };

      img.src = sourceUrl;
    });
  },

  /**
   * User-friendly notification on rotate failure
   */
  handleRotateFailure() {
    UI.showNotification("We couldn't rotate this image. Please try again.");
    Utils.announce("We couldn't rotate this image. Please try again.");
  },

  /**
   * Opens the crop editor modal for the current active image
   */
  openCropInterface() {
    const fileToCrop = this.currentFile;
    const urlToCrop = this.currentPreviewUrl;

    if (!fileToCrop || !urlToCrop) {
      UI.showNotification("We couldn't crop this image. Please try again.");
      return;
    }

    Crop.open({
      file: fileToCrop,
      imageUrl: urlToCrop,
      onApply: ({ file, blob, width, height }) => {
        this.applyCroppedImage(file, blob, width, height);
      }
    });
  },

  /**
   * Applies the cropped blob to preview and establishes new base for rotation
   * @param {File} file 
   * @param {Blob} blob 
   * @param {number} width 
   * @param {number} height 
   */
  applyCroppedImage(file, blob, width, height) {
    // Revoke previous URLs that are not original
    if (this.currentPreviewUrl && 
        this.currentPreviewUrl !== this.originalPreviewUrl && 
        this.currentPreviewUrl !== this.basePreviewUrl) {
      URL.revokeObjectURL(this.currentPreviewUrl);
    }
    if (this.basePreviewUrl && this.basePreviewUrl !== this.originalPreviewUrl) {
      URL.revokeObjectURL(this.basePreviewUrl);
    }

    const croppedUrl = URL.createObjectURL(blob);
    this.currentFile = file;
    this.currentPreviewUrl = croppedUrl;
    this.currentDimensions = { width, height };

    // Set new base image for subsequent rotations
    this.baseFile = file;
    this.basePreviewUrl = croppedUrl;
    this.baseDimensions = { width, height };
    this.currentRotation = 0;
    this.isCropped = true;

    // Update UI elements
    if (this.previewImg) {
      this.previewImg.src = croppedUrl;
      this.previewImg.alt = `Cropped table image: ${file.name} (${width} × ${height} pixels)`;
    }

    if (this.fileDimensionsEl) {
      this.fileDimensionsEl.textContent = `${width} × ${height} px`;
    }

    if (this.fileSizeEl) {
      this.fileSizeEl.textContent = this.formatFileSize(blob.size);
    }

    UI.showNotification('Crop applied.');
    Utils.announce(`Cropped image applied. Dimensions: ${width} by ${height} pixels.`);
    this.evaluateQuality(croppedUrl, width, height);
  },

  /**
   * Opens native system file / gallery / camera picker and resets crop/rotation state
   */
  openPicker() {
    this.resetRotationAndCrop();
    if (this.fileInput) {
      this.fileInput.value = '';
      this.fileInput.click();
    }
  },

  /**
   * Resets rotation and crop states
   */
  resetRotationAndCrop() {
    this.currentRotation = 0;
    this.isCropped = false;
    this.isRotating = false;
  },

  /**
   * Validates and displays selected image
   * @param {File} file 
   */
  handleSelectedFile(file) {
    if (!file) return;

    // Check login state: user must be authenticated to preview
    if (!Auth.isAuthenticated()) {
      Auth.setIntendedAction('upload');
      UI.openGateModal();
      if (this.fileInput) this.fileInput.value = '';
      return;
    }

    // Validate type and extension
    const fileExt = '.' + file.name.split('.').pop().toLowerCase();
    const isMimeValid = this.ALLOWED_TYPES.includes(file.type);
    const isExtValid = this.ALLOWED_EXTENSIONS.includes(fileExt);

    if (!isMimeValid && !isExtValid) {
      UI.showNotification('Unsupported format. Please choose a JPG, JPEG, or PNG image.');
      if (this.fileInput) this.fileInput.value = '';
      return;
    }

    // Test opening and loading the image object
    let objectUrl;
    try {
      objectUrl = URL.createObjectURL(file);
      // Pre-warm OCR worker in background while user views preview
      Scanner.preloadTesseract();
    } catch {
      this.showImageOpenError();
      return;
    }

    const testImg = new Image();

    testImg.onload = () => {
      const width = testImg.naturalWidth;
      const height = testImg.naturalHeight;

      if (!width || !height || width <= 0 || height <= 0) {
        URL.revokeObjectURL(objectUrl);
        this.showImageOpenError();
        return;
      }

      this.displayPreview(file, objectUrl, width, height);
    };

    testImg.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      this.showImageOpenError();
    };

    testImg.src = objectUrl;
  },

  /**
   * Displays the validated image and metadata
   * @param {File} file 
   * @param {string} objectUrl 
   * @param {number} width 
   * @param {number} height 
   */
  displayPreview(file, objectUrl, width, height) {
    // Revoke previous object URLs if different
    if (this.currentPreviewUrl && this.currentPreviewUrl !== objectUrl) {
      URL.revokeObjectURL(this.currentPreviewUrl);
    }
    if (this.originalPreviewUrl && this.originalPreviewUrl !== objectUrl) {
      URL.revokeObjectURL(this.originalPreviewUrl);
    }

    this.originalFile = file;
    this.originalPreviewUrl = objectUrl;
    this.originalDimensions = { width, height };

    this.baseFile = file;
    this.basePreviewUrl = objectUrl;
    this.baseDimensions = { width, height };

    this.currentFile = file;
    this.currentPreviewUrl = objectUrl;
    this.currentDimensions = { width, height };
    this.currentRotation = 0;
    this.isCropped = false;

    // Update UI elements
    if (this.previewImg) {
      this.previewImg.src = objectUrl;
      this.previewImg.alt = `Selected table image: ${file.name} (${width} × ${height} pixels)`;
    }

    if (this.fileNameEl) {
      this.fileNameEl.textContent = file.name;
      this.fileNameEl.title = file.name;
    }

    if (this.fileSizeEl) {
      this.fileSizeEl.textContent = this.formatFileSize(file.size);
    }

    if (this.fileDimensionsEl) {
      this.fileDimensionsEl.textContent = `${width} × ${height} px`;
    }

    // Toggle views: hide drop zone, show preview card
    if (this.dropZone) this.dropZone.style.display = 'none';
    if (this.previewCard) {
      this.previewCard.style.display = 'block';
      this.previewCard.setAttribute('aria-hidden', 'false');
    }

    Utils.announce(`Table image ${file.name} loaded. Dimensions: ${width} by ${height} pixels.`);
    this.evaluateQuality(objectUrl, width, height);
  },

  /**
   * User-friendly error message when image cannot be opened/decoded
   */
  showImageOpenError() {
    this.reset();
    UI.showNotification("We couldn't open this image. Please choose another image.");
    Utils.announce("We couldn't open this image. Please choose another image.");
  },

  /**
   * Format bytes to readable human unit
   * @param {number} bytes 
   * @returns {string}
   */
  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },

  /**
   * Resets upload view back to drop zone
   */
  reset() {
    if (this.currentPreviewUrl) {
      URL.revokeObjectURL(this.currentPreviewUrl);
      this.currentPreviewUrl = null;
    }
    if (this.basePreviewUrl && 
        this.basePreviewUrl !== this.currentPreviewUrl && 
        this.basePreviewUrl !== this.originalPreviewUrl) {
      URL.revokeObjectURL(this.basePreviewUrl);
      this.basePreviewUrl = null;
    }
    if (this.originalPreviewUrl && this.originalPreviewUrl !== this.currentPreviewUrl) {
      URL.revokeObjectURL(this.originalPreviewUrl);
      this.originalPreviewUrl = null;
    }
    this.originalFile = null;
    this.originalDimensions = null;
    this.baseFile = null;
    this.basePreviewUrl = null;
    this.baseDimensions = null;
    this.currentFile = null;
    this.currentDimensions = null;
    this.currentRotation = 0;
    this.isCropped = false;
    this.isRotating = false;
    if (this.fileInput) this.fileInput.value = '';

    if (this.previewImg) {
      this.previewImg.src = '';
      this.previewImg.alt = '';
    }

    if (this.fileNameEl) {
      this.fileNameEl.textContent = '—';
      this.fileNameEl.removeAttribute('title');
    }

    if (this.fileSizeEl) {
      this.fileSizeEl.textContent = '—';
    }

    if (this.fileDimensionsEl) {
      this.fileDimensionsEl.textContent = '—';
    }

    if (this.previewCard) {
      this.previewCard.style.display = 'none';
      this.previewCard.setAttribute('aria-hidden', 'true');
    }

    if (this.qualityWarningEl) {
      this.qualityWarningEl.style.display = 'none';
      this.qualityWarningEl.setAttribute('aria-hidden', 'true');
    }

    const scanningCard = Utils.qs('#table-scanning-card');
    const noTableCard = Utils.qs('#no-table-card');
    const resultCard = Utils.qs('#scan-result-card');
    if (scanningCard) scanningCard.style.display = 'none';
    if (noTableCard) noTableCard.style.display = 'none';
    if (resultCard) resultCard.style.display = 'none';

    if (this.dropZone) {
      this.dropZone.style.display = 'flex';
    }
  },

  /**
   * Assesses whether an image is suitable for table extraction (Step 3.4)
   * Detects:
   * 1. Very low-resolution images (< 250px width or < 180px height or < 60,000 pixels)
   * 2. Completely blank / uniform / solid color images
   * 3. Images that cannot be processed correctly (extreme darkness, washed out, near-zero contrast/variance)
   * 
   * @param {string} imageUrl 
   * @param {number} width 
   * @param {number} height 
   * @returns {Promise<{isSuitable: boolean, reason?: string}>}
   */
  checkImageQuality(imageUrl, width, height) {
    // 1. Detect very low-resolution images
    if (!width || !height || width < 250 || height < 180 || (width * height) < 60000) {
      return Promise.resolve({ isSuitable: false, reason: 'low_resolution' });
    }

    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        try {
          const sampleW = Math.min(width, 160);
          const sampleH = Math.min(height, 160);
          const canvas = document.createElement('canvas');
          canvas.width = sampleW;
          canvas.height = sampleH;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });

          if (!ctx) {
            resolve({ isSuitable: false, reason: 'canvas_unavailable' });
            return;
          }

          ctx.drawImage(img, 0, 0, sampleW, sampleH);
          const imgData = ctx.getImageData(0, 0, sampleW, sampleH).data;
          const totalPixels = sampleW * sampleH;

          let sumLum = 0;
          let minLum = 255;
          let maxLum = 0;
          const lums = new Float32Array(totalPixels);

          let darkCount = 0;
          let brightCount = 0;

          for (let i = 0; i < totalPixels; i++) {
            const r = imgData[i * 4];
            const g = imgData[i * 4 + 1];
            const b = imgData[i * 4 + 2];
            const a = imgData[i * 4 + 3];

            // Consider high transparency as white/blank
            const lum = (a < 30) ? 255 : (0.299 * r + 0.587 * g + 0.114 * b);
            lums[i] = lum;
            sumLum += lum;

            if (lum < minLum) minLum = lum;
            if (lum > maxLum) maxLum = lum;
            if (lum < 25) darkCount++;
            if (lum > 245) brightCount++;
          }

          const meanLum = sumLum / totalPixels;

          // Compute variance and standard deviation of luminance across pixels
          let varianceSum = 0;
          for (let i = 0; i < totalPixels; i++) {
            const diff = lums[i] - meanLum;
            varianceSum += diff * diff;
          }
          const stdDev = Math.sqrt(varianceSum / totalPixels);

          // 2. Completely blank / uniform / solid color image
          if ((maxLum - minLum) < 8 || stdDev < 4.0) {
            resolve({ isSuitable: false, reason: 'blank_or_solid' });
            return;
          }

          // 3. Images that cannot be processed correctly:
          // a. Completely dark / underexposed (pitch black, lens covered)
          if (meanLum < 20 && (darkCount / totalPixels) > 0.95) {
            resolve({ isSuitable: false, reason: 'too_dark' });
            return;
          }

          // b. Completely blown out / washed out overexposure
          if (meanLum > 248 && (brightCount / totalPixels) > 0.95 && stdDev < 8.0) {
            resolve({ isSuitable: false, reason: 'overexposed_blank' });
            return;
          }

          // c. Extremely low contrast / blurry flat wash with no discernible table boundaries
          if (stdDev < 7.0 && (maxLum - minLum) < 22) {
            resolve({ isSuitable: false, reason: 'low_contrast' });
            return;
          }

          // Image is clear and suitable
          resolve({ isSuitable: true });
        } catch {
          resolve({ isSuitable: false, reason: 'processing_error' });
        }
      };

      img.onerror = () => {
        resolve({ isSuitable: false, reason: 'load_error' });
      };

      img.src = imageUrl;
    });
  },

  /**
   * Assesses quality and toggles the small warning banner (Step 3.4)
   * If suitable: no extra message shown (banner hidden)
   * If unsuitable: shows small warning without blocking continuation
   * @param {string} imageUrl 
   * @param {number} width 
   * @param {number} height 
   */
  async evaluateQuality(imageUrl, width, height) {
    if (!this.qualityWarningEl) return;

    try {
      const result = await this.checkImageQuality(imageUrl, width, height);

      if (result.isSuitable) {
        // Suitable: Do not show any extra message
        this.qualityWarningEl.style.display = 'none';
        this.qualityWarningEl.setAttribute('aria-hidden', 'true');
      } else {
        // May produce inaccurate results: show small warning banner
        this.qualityWarningEl.style.display = 'flex';
        this.qualityWarningEl.setAttribute('aria-hidden', 'false');
        Utils.announce("This image may produce inaccurate results. Please use a clearer image with the table fully visible.");
      }
    } catch {
      if (this.qualityWarningEl) {
        this.qualityWarningEl.style.display = 'none';
        this.qualityWarningEl.setAttribute('aria-hidden', 'true');
      }
    }
  },

  /**
   * Opens mobile camera directly using camera capture input
   */
  openCamera() {
    if (this.cameraInput) {
      this.cameraInput.value = '';
      this.cameraInput.click();
    }
  }
};
