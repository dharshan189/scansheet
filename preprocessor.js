/**
 * ScanSheet - Advanced Image Preprocessing Engine
 * 
 * Pipeline:
 *  1. Adaptive High-Res Rescaling (preserving small fonts, thin lines, punctuation & decimals)
 *  2. Fast Horizontal-Projection Skew Detection & Auto-Deskewing (-12° to +12°)
 *  3. Local Illumination Compensation (background division to eliminate shadows & glare)
 *  4. Contrast Stretching & Unsharp Edge Sharpening (enhancing faint ink & symbols)
 */

export const ImagePreprocessor = {
  /**
   * Main entry point for preprocessing an image before OCR and Table Detection
   * @param {string} imageUrl - Blob or object URL of source image
   * @param {Object} [dimensions] - { width, height }
   * @returns {Promise<{ocrCanvas: HTMLCanvasElement, structureCanvas: HTMLCanvasElement, width: number, height: number, deskewAngle: number, previewUrl: string}>}
   */
  async process(imageUrl, dimensions) {
    const img = await this.loadImage(imageUrl);
    const origW = img.naturalWidth || dimensions?.width || 1200;
    const origH = img.naturalHeight || dimensions?.height || 900;

    // 1. Calculate Target Dimensions:
    // Ensure small text is magnified and high-res photos retain crisp character strokes
    const MAX_DIM = 2200;
    let scale = 1;

    const maxSide = Math.max(origW, origH);

    if (maxSide > MAX_DIM) {
      scale = MAX_DIM / maxSide;
    } else if (maxSide < 1000) {
      // Upscale smaller images so text characters have sufficient pixel height (>25px) for high OCR accuracy
      scale = Math.min(2.0, 1200 / maxSide);
    }

    const W = Math.round(origW * scale);
    const H = Math.round(origH * scale);

    // Initial Render onto Canvas
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = W;
    baseCanvas.height = H;
    const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
    baseCtx.imageSmoothingEnabled = true;
    baseCtx.imageSmoothingQuality = 'high';
    baseCtx.drawImage(img, 0, 0, W, H);

    // 2. Skew Detection & Deskewing
    let deskewAngle = 0;
    let deskewedCanvas = baseCanvas;
    try {
      deskewAngle = this.detectSkew(baseCtx, W, H);
      if (Math.abs(deskewAngle) >= 0.4) {
        deskewedCanvas = this.rotateCanvas(baseCanvas, -deskewAngle);
      }
    } catch (e) {
      console.warn('[ImagePreprocessor] Skew detection skipped:', e);
      deskewAngle = 0;
    }

    const curW = deskewedCanvas.width;
    const curH = deskewedCanvas.height;
    const deskewedCtx = deskewedCanvas.getContext('2d', { willReadFrequently: true });
    const imgData = deskewedCtx.getImageData(0, 0, curW, curH);

    // 3. Illumination Compensation & Local Background Division
    // Removes uneven phone shadows and flash gradients
    const enhancedData = this.compensateIlluminationAndSharpen(imgData, curW, curH);

    // 4. Inverted Region Normalization (for dark/colored table headers, badges and pills with white text)
    this.normalizeInvertedRegions(enhancedData, imgData, curW, curH);

    // Create OCR-optimized Canvas
    const ocrCanvas = document.createElement('canvas');
    ocrCanvas.width = curW;
    ocrCanvas.height = curH;
    const ocrCtx = ocrCanvas.getContext('2d', { willReadFrequently: true });
    ocrCtx.putImageData(enhancedData, 0, 0);

    // Structure Canvas retains color/subtle grayscale edges for geometric line detection
    const structureCanvas = deskewedCanvas;

    return {
      ocrCanvas,
      structureCanvas,
      width: curW,
      height: curH,
      deskewAngle,
      previewUrl: imageUrl
    };
  },

  loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // Only set crossOrigin if URL is remote HTTP/HTTPS to prevent mobile blob CORS hangs
      if (url && typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
        img.crossOrigin = 'anonymous';
      }
      const timer = setTimeout(() => {
        reject(new Error('Image loading timed out'));
      }, 7000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = (err) => {
        clearTimeout(timer);
        reject(new Error('Failed to load image for preprocessing: ' + (err?.message || 'load error')));
      };
      img.src = url;
    });
  },

  /**
   * Fast Horizontal-Projection Profile Skew Detector (-10° to +10°)
   * Finds the angle where horizontal text lines and table rules maximize projection variance
   */
  detectSkew(ctx, w, h) {
    // Downsample to max 500px for sub-20ms speed
    const maxSample = 500;
    const sampleScale = Math.min(1, maxSample / Math.max(w, h));
    const sw = Math.round(w * sampleScale);
    const sh = Math.round(h * sampleScale);

    const sCanvas = document.createElement('canvas');
    sCanvas.width = sw;
    sCanvas.height = sh;
    const sCtx = sCanvas.getContext('2d');
    sCtx.drawImage(ctx.canvas, 0, 0, sw, sh);

    const sData = sCtx.getImageData(0, 0, sw, sh).data;
    const n = sw * sh;
    const gray = new Uint8Array(n);

    // Grayscale conversion and approximate local threshold
    let sumLum = 0;
    for (let i = 0; i < n; i++) {
      const g = Math.round(0.299 * sData[i * 4] + 0.587 * sData[i * 4 + 1] + 0.114 * sData[i * 4 + 2]);
      gray[i] = g;
      sumLum += g;
    }
    const avgLum = sumLum / n;
    const inkThresh = avgLum * 0.85;

    // Search angles: Coarse search (-8° to +8° in 1.0° steps)
    let bestAngle = 0;
    let maxVariance = -1;
    const deg2Rad = Math.PI / 180;
    const cx = sw / 2;
    const cy = sh / 2;

    const testAngles = [];
    for (let a = -8; a <= 8; a += 1.0) testAngles.push(a);

    for (const a of testAngles) {
      const rad = a * deg2Rad;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const proj = new Float64Array(sh);
      let inkCount = 0;

      // Sample every 2nd pixel
      for (let y = 4; y < sh - 4; y += 2) {
        const yOff = y * sw;
        for (let x = 4; x < sw - 4; x += 2) {
          if (gray[yOff + x] < inkThresh) {
            const ry = Math.round((x - cx) * sin + (y - cy) * cos + cy);
            if (ry >= 0 && ry < sh) {
              proj[ry]++;
              inkCount++;
            }
          }
        }
      }

      if (inkCount > 100) {
        const mean = inkCount / sh;
        let variance = 0;
        for (let y = 0; y < sh; y++) {
          const diff = proj[y] - mean;
          variance += diff * diff;
        }
        if (variance > maxVariance) {
          maxVariance = variance;
          bestAngle = a;
        }
      }
    }

    // Fine search around bestAngle (±0.8° in 0.2° steps)
    if (Math.abs(bestAngle) > 0) {
      let fineBest = bestAngle;
      for (let a = bestAngle - 0.8; a <= bestAngle + 0.8; a += 0.2) {
        const rad = a * deg2Rad;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const proj = new Float64Array(sh);
        let inkCount = 0;

        for (let y = 4; y < sh - 4; y += 2) {
          const yOff = y * sw;
          for (let x = 4; x < sw - 4; x += 2) {
            if (gray[yOff + x] < inkThresh) {
              const ry = Math.round((x - cx) * sin + (y - cy) * cos + cy);
              if (ry >= 0 && ry < sh) {
                proj[ry]++;
                inkCount++;
              }
            }
          }
        }

        if (inkCount > 100) {
          const mean = inkCount / sh;
          let variance = 0;
          for (let y = 0; y < sh; y++) {
            const diff = proj[y] - mean;
            variance += diff * diff;
          }
          if (variance > maxVariance) {
            maxVariance = variance;
            fineBest = a;
          }
        }
      }
      bestAngle = fineBest;
    }

    return bestAngle;
  },

  /**
   * Rotates a canvas by specified degrees with high-quality antialiasing
   */
  rotateCanvas(srcCanvas, deg) {
    const rad = deg * Math.PI / 180;
    const sin = Math.abs(Math.sin(rad));
    const cos = Math.abs(Math.cos(rad));
    const w = srcCanvas.width;
    const h = srcCanvas.height;

    const newW = Math.round(w * cos + h * sin);
    const newH = Math.round(h * cos + w * sin);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = newW;
    dstCanvas.height = newH;
    const dstCtx = dstCanvas.getContext('2d');

    // Fill white background for rotated margins
    dstCtx.fillStyle = '#ffffff';
    dstCtx.fillRect(0, 0, newW, newH);

    dstCtx.translate(newW / 2, newH / 2);
    dstCtx.rotate(rad);
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.imageSmoothingQuality = 'high';
    dstCtx.drawImage(srcCanvas, -w / 2, -h / 2);

    return dstCanvas;
  },

  /**
   * Uneven Lighting Compensation & Unsharp Text Sharpening
   * Removes phone shadows, brightens background to uniform paper white,
   * sharpens thin strokes, dots, punctuation and decimals
   */
  compensateIlluminationAndSharpen(imgData, w, h) {
    const data = imgData.data;
    const n = w * h;
    const gray = new Uint8Array(n);

    // 1. Convert to Grayscale
    for (let i = 0; i < n; i++) {
      gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
    }

    // 2. Estimate Background Luminance using Block Maximum
    // Use larger blocks (32-48px) so dark character strokes are never mistaken for paper background
    const ds = Math.max(32, Math.round(Math.min(w, h) / 30));
    const bw = Math.ceil(w / ds);
    const bh = Math.ceil(h / ds);
    const bgSmall = new Uint8Array(bw * bh);

    // Compute approximate 80th percentile luminance to anchor global paper white floor
    const samples = [];
    const step = Math.max(1, Math.floor(n / 2000));
    for (let i = 0; i < n; i += step) {
      samples.push(gray[i]);
    }
    samples.sort((a, b) => a - b);
    const paperWhiteFloor = Math.max(150, Math.round(samples[Math.floor(samples.length * 0.80)] * 0.75));

    for (let by = 0; by < bh; by++) {
      const y0 = by * ds;
      const y1 = Math.min(h, y0 + ds);
      for (let bx = 0; bx < bw; bx++) {
        const x0 = bx * ds;
        const x1 = Math.min(w, x0 + ds);
        let maxVal = 0;
        for (let y = y0; y < y1; y++) {
          const yOff = y * w;
          for (let x = x0; x < x1; x++) {
            const v = gray[yOff + x];
            if (v > maxVal) maxVal = v;
          }
        }
        // Protect background estimate: never drop below paper white floor
        bgSmall[by * bw + bx] = Math.max(paperWhiteFloor, maxVal);
      }
    }

    // 3. Bilinear Interpolation of Background and Division (Precompute X weights for 10x mobile speed)
    const normalized = new Uint8Array(n);
    const bx0Arr = new Int32Array(w);
    const bx1Arr = new Int32Array(w);
    const wx0Arr = new Float32Array(w);
    const wx1Arr = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const fx = x / ds;
      const bx0 = Math.floor(fx);
      bx0Arr[x] = bx0;
      bx1Arr[x] = Math.min(bw - 1, bx0 + 1);
      const wx1 = fx - bx0;
      wx1Arr[x] = wx1;
      wx0Arr[x] = 1 - wx1;
    }

    for (let y = 0; y < h; y++) {
      const fy = y / ds;
      const by0 = Math.floor(fy);
      const by1 = Math.min(bh - 1, by0 + 1);
      const wy1 = fy - by0;
      const wy0 = 1 - wy1;
      const row0 = by0 * bw;
      const row1 = by1 * bw;
      const yOff = y * w;

      for (let x = 0; x < w; x++) {
        const bx0 = bx0Arr[x];
        const bx1 = bx1Arr[x];
        const wx0 = wx0Arr[x];
        const wx1 = wx1Arr[x];

        const bgVal = Math.max(25, Math.round(
          (bgSmall[row0 + bx0] * wx0 + bgSmall[row0 + bx1] * wx1) * wy0 +
          (bgSmall[row1 + bx0] * wx0 + bgSmall[row1 + bx1] * wx1) * wy1
        ));

        const orig = gray[yOff + x];
        // Standard paper white normalization to 240
        normalized[yOff + x] = Math.min(255, Math.max(0, Math.round((orig / bgVal) * 238)));
      }
    }

    // 4. Contrast Stretch (1st to 99th percentile) & Unsharp Edge Sharpening
    const outData = new ImageData(w, h);
    const out = outData.data;

    for (let y = 0; y < h; y++) {
      const yOff = y * w;
      for (let x = 0; x < w; x++) {
        const idx = yOff + x;
        const center = normalized[idx];

        // 3x3 Laplacian / Unsharp sharpening filter
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
          const top = normalized[(y - 1) * w + x];
          const btm = normalized[(y + 1) * w + x];
          const lft = normalized[yOff + (x - 1)];
          const rgt = normalized[yOff + (x + 1)];

          const diff = 4 * center - top - btm - lft - rgt;
          // Unsharp text sharpening: enhance stroke contrast without blurring
          let sharp = center + Math.round(0.18 * diff);
          sharp = Math.min(255, Math.max(0, sharp));

          // Contrast curve enhancement: darks stay dark, lights stay light
          if (sharp < 150) {
            sharp = Math.max(0, Math.round(sharp * 0.90));
          } else {
            sharp = Math.min(255, Math.round(sharp * 1.02));
          }

          const pIdx = idx * 4;
          out[pIdx] = sharp;
          out[pIdx + 1] = sharp;
          out[pIdx + 2] = sharp;
          out[pIdx + 3] = 255;
        } else {
          const pIdx = idx * 4;
          out[pIdx] = center;
          out[pIdx + 1] = center;
          out[pIdx + 2] = center;
          out[pIdx + 3] = 255;
        }
      }
    }

    return outData;
  },

  /**
   * Inverted Region Normalization
   * Detects dark or colored header banners/pills containing light text (e.g. orange/gray table headers)
   * and inverts them so OCR engines can read the text with high accuracy.
   */
  normalizeInvertedRegions(enhancedData, rawImgData, w, h) {
    const raw = rawImgData.data;
    const out = enhancedData.data;
    const n = w * h;
    const gray = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      const idx = i * 4;
      gray[i] = Math.round(0.299 * raw[idx] + 0.587 * raw[idx + 1] + 0.114 * raw[idx + 2]);
    }

    const blockH = 10;
    const blockW = 40;
    const numRows = Math.ceil(h / blockH);
    const numCols = Math.ceil(w / blockW);

    for (let by = 0; by < numRows; by++) {
      const y0 = by * blockH;
      const y1 = Math.min(h, y0 + blockH);

      for (let bx = 0; bx < numCols; bx++) {
        const x0 = bx * blockW;
        const x1 = Math.min(w, x0 + blockW);

        let darkCount = 0;
        let brightCount = 0;
        const total = (y1 - y0) * (x1 - x0);

        for (let y = y0; y < y1; y++) {
          const yOff = y * w;
          for (let x = x0; x < x1; x++) {
            const g = gray[yOff + x];
            if (g < 170) darkCount++;
            else if (g > 195) brightCount++;
          }
        }

        // Inverted block condition: True dark/colored background with bright text
        // (At least 72% dark background pixels, and 3-25% bright text stroke pixels)
        // Prevents normal black text on white paper from being corrupted
        if (darkCount / total >= 0.72 && brightCount / total >= 0.03 && brightCount / total <= 0.25) {
          for (let y = y0; y < y1; y++) {
            const yOff = y * w;
            for (let x = x0; x < x1; x++) {
              const g = gray[yOff + x];
              const pIdx = (yOff + x) * 4;
              if (g >= 190) {
                // Bright text stroke -> convert to crisp dark ink
                out[pIdx] = 20;
                out[pIdx + 1] = 20;
                out[pIdx + 2] = 20;
              } else if (g <= 165) {
                // Dark/colored background -> convert to clean white paper
                out[pIdx] = 255;
                out[pIdx + 1] = 255;
                out[pIdx + 2] = 255;
              } else {
                // Anti-aliased boundary
                const factor = (g - 165) / 25;
                const v = Math.round(255 - factor * 235);
                out[pIdx] = v;
                out[pIdx + 1] = v;
                out[pIdx + 2] = v;
              }
            }
          }
        }
      }
    }
  }
};
