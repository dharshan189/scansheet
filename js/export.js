/**
 * ScanSheet - Multi-Format Document Export Engine
 * 
 * Supports:
 *  1. Microsoft Word (.docx) - Genuine OpenXML with editable paragraphs, headings, and styled tables
 *  2. PDF (.pdf) - Multi-page vector PDF via jsPDF & autoTable
 *  3. PNG Image (.png) - High-resolution 2x retina Canvas render with styled grid and typography
 *  4. Microsoft Excel (.xlsx) - Genuine binary Excel workbook via SheetJS
 *  5. Multi-File Export - Simultaneous download or single ZIP bundle (.zip via JSZip)
 */

export const DocumentExporter = {
  /**
   * Helper to trigger native browser file download from Blob
   * Robust against mobile Safari, Android DownloadManager, Chrome and Edge
   */
  downloadBlob(blob, filename) {
    if (!blob) {
      console.error('[DocumentExporter] downloadBlob called with empty blob');
      throw new Error('File generation failed. Blob is empty.');
    }
    const cleanFilename = String(filename || 'ScanSheet_Export.bin').trim();

    // Ensure correct MIME type for mobile download managers & iOS Share Sheet
    let mimeType = blob.type;
    if (!mimeType || mimeType === 'application/octet-stream') {
      if (cleanFilename.endsWith('.xlsx')) {
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (cleanFilename.endsWith('.docx')) {
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (cleanFilename.endsWith('.pdf')) {
        mimeType = 'application/pdf';
      } else if (cleanFilename.endsWith('.png')) {
        mimeType = 'image/png';
      } else if (cleanFilename.endsWith('.zip')) {
        mimeType = 'application/zip';
      }
    }

    const typedBlob = (blob.type === mimeType) ? blob : new Blob([blob], { type: mimeType });

    // Native mobile share sheet on mobile devices when supported
    if (typeof navigator !== 'undefined' && navigator.canShare && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try {
        const file = new File([typedBlob], cleanFilename, { type: mimeType });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({
            files: [file],
            title: cleanFilename
          }).catch((err) => {
            if (err.name !== 'AbortError') {
              this.triggerAnchorDownload(typedBlob, cleanFilename);
            }
          });
          return;
        }
      } catch (e) {
        // Fallback to anchor
      }
    }

    this.triggerAnchorDownload(typedBlob, cleanFilename);
  },

  triggerAnchorDownload(blob, filename) {
    const cleanFilename = String(filename || 'ScanSheet_Export.bin').trim();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.top = '-9999px';
    a.style.opacity = '0';
    a.href = url;
    a.download = cleanFilename;
    a.setAttribute('download', cleanFilename);
    // CRITICAL: DO NOT set a.rel = 'noopener' or target, as Chromium/Edge strips the download attribute and downloads the raw blob UUID!
    document.body.appendChild(a);

    a.click();

    setTimeout(() => {
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1000);

    // Keep Blob URL alive for 2 minutes (120s) so slow download managers do not fail
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }, 120000);
  },

  /**
   * 1. Generate Microsoft Word (.docx) Blob
   */
  async generateWordBlob(docData) {
    if (!window.docx) {
      throw new Error('Word export engine (docx) is not loaded.');
    }

    const {
      Document,
      Packer,
      Paragraph,
      TextRun,
      Table,
      TableRow,
      TableCell,
      WidthType,
      BorderStyle,
      HeadingLevel,
      ShadingType,
      AlignmentType
    } = window.docx;

    const sectionsChildren = [];

    // 1. Document Title
    if (docData.title && docData.title.trim()) {
      sectionsChildren.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 120, after: 180 },
          children: [
            new TextRun({
              text: docData.title.trim(),
              bold: true,
              size: 32,
              color: '111827'
            })
          ]
        })
      );
    }

    // 2. Document Paragraphs / Headings / Lists
    if (docData.paragraphs && docData.paragraphs.length > 0) {
      for (const p of docData.paragraphs) {
        const text = String(p || '').trim();
        if (!text) continue;

        const isBullet = /^[•\-\*]\s+/.test(text);
        const isHeading = /^([A-Z0-9\s:.-]{3,60}|(Question|Q\d|Section|Part|Chapter)\s+.*)$/i.test(text) && text.length < 80;

        if (isHeading && !isBullet) {
          sectionsChildren.push(
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              spacing: { before: 200, after: 100 },
              children: [
                new TextRun({
                  text,
                  bold: true,
                  size: 26,
                  color: '1f2937'
                })
              ]
            })
          );
        } else if (isBullet) {
          sectionsChildren.push(
            new Paragraph({
              bullet: { level: 0 },
              spacing: { before: 60, after: 60 },
              children: [
                new TextRun({
                  text: text.replace(/^[•\-\*]\s+/, ''),
                  size: 22,
                  color: '374151'
                })
              ]
            })
          );
        } else {
          sectionsChildren.push(
            new Paragraph({
              spacing: { before: 80, after: 140, line: 276 },
              children: [
                new TextRun({
                  text,
                  size: 22,
                  color: '1f2937'
                })
              ]
            })
          );
        }
      }
    }

    // 3. Structured Table (when present)
    const grid = docData.table?.grid;
    if (grid && grid.length > 0) {
      if (sectionsChildren.length > 0) {
        sectionsChildren.push(new Paragraph({ spacing: { before: 120, after: 60 } }));
      }

      const colCount = Math.max(...grid.map(r => r.length));
      const tableRows = [];

      const cellBorder = {
        style: BorderStyle.SINGLE,
        size: 4,
        color: '000000'
      };
      const borders = {
        top: cellBorder,
        bottom: cellBorder,
        left: cellBorder,
        right: cellBorder
      };

      const cellSpans = docData.table?.cellSpans || {};
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

      grid.forEach((row, ri) => {
        const cells = [];

        for (let c = 0; c < colCount; c++) {
          if (coveredCells.has(`${ri}_${c}`)) continue;
          const val = row[c] || '';
          const span = cellSpans[`${ri}_${c}`];
          const colSpanVal = span?.colspan || 1;
          const rowSpanVal = span?.rowspan || 1;

          cells.push(
            new TableCell({
              borders,
              columnSpan: colSpanVal > 1 ? colSpanVal : undefined,
              rowSpan: rowSpanVal > 1 ? rowSpanVal : undefined,
              width: { size: Math.floor((100 / colCount) * colSpanVal), type: WidthType.PERCENTAGE },
              margins: {
                top: 100,
                bottom: 100,
                left: 120,
                right: 120
              },
              children: [
                new Paragraph({
                  alignment: this.isNumeric(val) ? AlignmentType.RIGHT : AlignmentType.LEFT,
                  children: [
                    new TextRun({
                      text: val,
                      bold: ri === 0 && row.some(cell => cell && /[a-zA-Z]/.test(cell)),
                      size: 20,
                      color: '000000'
                    })
                  ]
                })
              ]
            })
          );
        }

        tableRows.push(
          new TableRow({
            children: cells
          })
        );
      });

      sectionsChildren.push(
        new Table({
          alignment: AlignmentType.CENTER,
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows
        })
      );
    }

    // 4. Notes & Summary
    if (docData.notes && docData.notes.length > 0) {
      sectionsChildren.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 240, after: 100 },
          children: [
            new TextRun({
              text: 'Notes & Summary',
              bold: true,
              size: 24,
              color: '4b5563'
            })
          ]
        })
      );
      for (const n of docData.notes) {
        sectionsChildren.push(
          new Paragraph({
            spacing: { before: 60, after: 100 },
            children: [
              new TextRun({
                text: String(n).trim(),
                italics: true,
                size: 20,
                color: '4b5563'
              })
            ]
          })
        );
      }
    }

    if (sectionsChildren.length === 0) {
      sectionsChildren.push(new Paragraph({ text: '' }));
    }

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 720, right: 720 }
          }
        },
        children: sectionsChildren
      }]
    });

    try {
      return await Packer.toBlob(doc);
    } catch (err) {
      if (typeof Packer.toBuffer === 'function') {
        const buf = await Packer.toBuffer(doc);
        return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      }
      throw err;
    }
  },

  async exportWord(docData, filename = 'ScanSheet_Converted_Document.docx') {
    const blob = await this.generateWordBlob(docData);
    this.downloadBlob(blob, filename);
    return true;
  },

  /**
   * 2. Generate PDF (.pdf) Blob
   */
  async generatePdfBlob(docData) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) {
      throw new Error('PDF export engine (jsPDF) is not loaded.');
    }

    const grid = docData.table?.grid || [];
    const colCount = Math.max(...grid.map(r => r.length), 1);

    // Orientation: landscape if many columns in table, otherwise portrait
    const orientation = (grid.length > 0 && colCount > 5) ? 'landscape' : 'portrait';

    const doc = new jsPDF({
      orientation,
      unit: 'pt',
      format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 36;
    const marginY = 40;
    const contentWidth = pageWidth - marginX * 2;
    let curY = marginY;

    // 1. Title
    if (docData.title && docData.title.trim()) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(17, 24, 39);
      const titleLines = doc.splitTextToSize(docData.title.trim(), contentWidth);
      doc.text(titleLines, marginX, curY);
      curY += titleLines.length * 18 + 12;
    }

    // 2. Paragraphs / Headings / Lists
    if (docData.paragraphs && docData.paragraphs.length > 0) {
      for (const p of docData.paragraphs) {
        const text = String(p || '').trim();
        if (!text) continue;

        const isHeading = /^([A-Z0-9\s:.-]{3,60}|(Question|Q\d|Section|Part|Chapter)\s+.*)$/i.test(text) && text.length < 80;

        if (isHeading) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(12);
          doc.setTextColor(17, 24, 39);
          curY += 6;
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10);
          doc.setTextColor(31, 41, 55);
        }

        const lines = doc.splitTextToSize(text, contentWidth);
        const blockH = lines.length * 14;

        if (curY + blockH > pageHeight - marginY - 20) {
          doc.addPage();
          curY = marginY;
        }

        doc.text(lines, marginX, curY);
        curY += blockH + (isHeading ? 6 : 10);
      }
    }

    // 3. Table (if present)
    if (grid && grid.length > 0 && typeof doc.autoTable === 'function') {
      if (curY + 60 > pageHeight - marginY - 20) {
        doc.addPage();
        curY = marginY;
      }

      doc.autoTable({
        startY: curY + 6,
        body: grid,
        tableWidth: contentWidth,
        margin: { left: marginX, right: marginX },
        theme: 'plain',
        styles: {
          font: 'helvetica',
          fontStyle: 'normal',
          fontSize: 9.5,
          cellPadding: 6,
          lineColor: [0, 0, 0],
          lineWidth: 0.75,
          textColor: [0, 0, 0],
          fillColor: [255, 255, 255],
          valign: 'middle',
          overflow: 'linebreak'
        },
        bodyStyles: {
          fontStyle: 'normal',
          textColor: [0, 0, 0],
          fillColor: [255, 255, 255],
          lineColor: [0, 0, 0],
          lineWidth: 0.75
        },
        alternateRowStyles: {
          fillColor: [255, 255, 255]
        },
        didParseCell: (data) => {
          data.cell.styles.fillColor = [255, 255, 255];
          data.cell.styles.textColor = [0, 0, 0];
          data.cell.styles.lineColor = [0, 0, 0];
          data.cell.styles.lineWidth = 0.75;
          data.cell.styles.fontStyle = (data.row.index === 0) ? 'bold' : 'normal';

          // Apply cell colSpan and rowSpan from merges if present
          if (docData.table?.cellSpans) {
            const span = docData.table.cellSpans[`${data.row.index}_${data.column.index}`];
            if (span) {
              if (span.colspan > 1) data.cell.colSpan = span.colspan;
              if (span.rowspan > 1) data.cell.rowSpan = span.rowspan;
            }
          }
        }
      });

      curY = doc.lastAutoTable.finalY + 16;
    }

    // 4. Notes (if present)
    if (docData.notes && docData.notes.length > 0) {
      if (curY + 40 > pageHeight - marginY - 20) {
        doc.addPage();
        curY = marginY;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(75, 85, 99);
      doc.text('Notes & Summary:', marginX, curY);
      curY += 14;

      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9.5);
      for (const n of docData.notes) {
        const text = String(n || '').trim();
        if (!text) continue;
        const lines = doc.splitTextToSize(text, contentWidth);
        const blockH = lines.length * 13;
        if (curY + blockH > pageHeight - marginY - 20) {
          doc.addPage();
          curY = marginY;
        }
        doc.text(lines, marginX, curY);
        curY += blockH + 6;
      }
    }

    // Number all pages cleanly
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(140, 140, 140);
      doc.text(
        `Page ${i} of ${pageCount}`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 16,
        { align: 'center' }
      );
    }

    return doc.output('blob');
  },

  async exportPDF(docData, filename = 'ScanSheet_Converted_Document.pdf') {
    const blob = await this.generatePdfBlob(docData);
    this.downloadBlob(blob, filename);
    return true;
  },

  /**
   * 3. Generate PNG Image (.png) Blob
   * Centered on canvas, fitted to page width, with ZERO color on any columns or cells.
   */
  async generateImageBlob(docData) {
    const grid = docData.table?.grid || [];
    const numRows = grid.length;
    const numCols = Math.max(...grid.map(r => r.length), 1);

    const scale = 2;
    const canvasWidth = 1000 * scale;
    const marginX = 40 * scale;
    const contentWidth = canvasWidth - marginX * 2;
    const rowHeight = 36 * scale;
    const tableHeight = numRows * rowHeight;

    // Estimate total required height
    let totalEstimatedH = 60 * scale; // top padding
    if (docData.title) totalEstimatedH += 40 * scale;
    if (docData.paragraphs && docData.paragraphs.length > 0) {
      totalEstimatedH += docData.paragraphs.length * 36 * scale;
    }
    if (grid.length > 0) {
      totalEstimatedH += tableHeight + 20 * scale;
    }
    if (docData.notes && docData.notes.length > 0) {
      totalEstimatedH += docData.notes.length * 30 * scale + 30 * scale;
    }
    totalEstimatedH += 60 * scale; // bottom padding

    const canvasHeight = Math.max(700 * scale, totalEstimatedH);

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    // Clean white page background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    let curY = 40 * scale;

    // 1. Draw Title
    if (docData.title && docData.title.trim()) {
      ctx.fillStyle = '#111827';
      ctx.font = `bold ${18 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(docData.title.trim(), marginX, curY);
      curY += 36 * scale;
    }

    // 2. Draw Paragraphs
    if (docData.paragraphs && docData.paragraphs.length > 0) {
      ctx.fillStyle = '#1f2937';
      ctx.font = `${12.5 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';

      for (const p of docData.paragraphs) {
        const text = String(p || '').trim();
        if (!text) continue;
        ctx.fillText(text, marginX, curY);
        curY += 24 * scale;
      }
      curY += 10 * scale;
    }

    // 3. Draw Table
    if (grid.length > 0) {
      const colWidth = contentWidth / numCols;
      let rowY = curY;

      for (let r = 0; r < numRows; r++) {
        let colX = marginX;
        for (let c = 0; c < numCols; c++) {
          const val = grid[r]?.[c] || '';

          // Pure white cell fill - absolutely NO colors
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(colX, rowY, colWidth, rowHeight);

          // Crisp black grid border
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1 * scale;
          ctx.strokeRect(colX, rowY, colWidth, rowHeight);

          // Standard black text
          ctx.fillStyle = '#000000';
          const isHeader = (r === 0 && grid[0].some(cell => cell && /[a-zA-Z]/.test(cell)));
          ctx.font = `${isHeader ? 'bold ' : ''}${12 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          ctx.fillText(val, colX + 10 * scale, rowY + rowHeight / 2);

          colX += colWidth;
        }
        rowY += rowHeight;
      }
      curY = rowY + 20 * scale;
    }

    // 4. Draw Notes
    if (docData.notes && docData.notes.length > 0) {
      ctx.fillStyle = '#4b5563';
      ctx.font = `italic ${11 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText('Notes & Summary:', marginX, curY);
      curY += 20 * scale;

      for (const n of docData.notes) {
        ctx.fillText(String(n).trim(), marginX, curY);
        curY += 18 * scale;
      }
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to create PNG blob.'));
          return;
        }
        resolve(blob);
      }, 'image/png');
    });
  },

  async exportImage(docData, filename = 'ScanSheet_Converted_Image.png') {
    const blob = await this.generateImageBlob(docData);
    this.downloadBlob(blob, filename);
    return true;
  },

  /**
   * Helper to build SheetJS Workbook with proper multi-sheet support:
   * - If table exists: Sheet 1 'ScannedTable' (table grid); if text exists, Sheet 2 'DocumentText'
   * - If text-only: Sheet 1 'DocumentContent' with paragraphs in rows
   */
  createExcelWorkbook(docData) {
    if (!window.XLSX) {
      throw new Error('Excel export engine (SheetJS XLSX) is not loaded.');
    }

    const wb = window.XLSX.utils.book_new();
    const grid = docData.table?.grid;

    if (grid && grid.length > 0) {
      const aoa = grid.map(row => Array.isArray(row) ? [...row] : [row]);
      const ws = window.XLSX.utils.aoa_to_sheet(aoa);

      const colCount = Math.max(1, ...aoa.map(r => r.length));
      const colWidths = [];
      for (let c = 0; c < colCount; c++) {
        let maxLen = 8;
        for (const row of aoa) {
          const len = (row[c] !== undefined && row[c] !== null ? String(row[c]).length : 0);
          if (len > maxLen) maxLen = len;
        }
        colWidths.push({ wch: Math.min(60, maxLen + 3) });
      }
      ws['!cols'] = colWidths;
      if (docData.table?.merges && docData.table.merges.length > 0) {
        ws['!merges'] = docData.table.merges.map(m => ({
          s: { r: m.s.r, c: m.s.c },
          e: { r: m.e.r, c: m.e.c }
        }));
      }
      window.XLSX.utils.book_append_sheet(wb, ws, 'ScannedTable');

      // Append second sheet for Document Narrative if title or paragraphs exist
      const textRows = [];
      if (docData.title) textRows.push([docData.title], ['']);
      if (docData.paragraphs && docData.paragraphs.length > 0) {
        docData.paragraphs.forEach(p => textRows.push([p]));
      }
      if (docData.notes && docData.notes.length > 0) {
        if (textRows.length > 0) textRows.push(['']);
        textRows.push(['Notes & Summary:']);
        docData.notes.forEach(n => textRows.push([n]));
      }
      if (textRows.length > 0) {
        const wsText = window.XLSX.utils.aoa_to_sheet(textRows);
        wsText['!cols'] = [{ wch: 80 }];
        window.XLSX.utils.book_append_sheet(wb, wsText, 'DocumentText');
      }
    } else {
      // Document without structured table
      const textRows = [];
      if (docData.title) textRows.push([docData.title], ['']);
      if (docData.paragraphs && docData.paragraphs.length > 0) {
        docData.paragraphs.forEach(p => textRows.push([p]));
      }
      if (docData.notes && docData.notes.length > 0) {
        if (textRows.length > 0) textRows.push(['']);
        textRows.push(['Notes & Summary:']);
        docData.notes.forEach(n => textRows.push([n]));
      }
      if (textRows.length === 0) {
        throw new Error('No content available to export to Excel.');
      }
      const wsText = window.XLSX.utils.aoa_to_sheet(textRows);
      wsText['!cols'] = [{ wch: 80 }];
      window.XLSX.utils.book_append_sheet(wb, wsText, 'DocumentContent');
    }

    return wb;
  },

  /**
   * 4. Generate Excel (.xlsx) Blob
   */
  generateExcelBlob(docData) {
    const wb = this.createExcelWorkbook(docData);
    const wbout = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  },

  exportExcel(docData, filename = 'ScanSheet_Converted_Table.xlsx') {
    const isMobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (!isMobile && window.XLSX && typeof window.XLSX.writeFile === 'function') {
      try {
        const wb = this.createExcelWorkbook(docData);
        window.XLSX.writeFile(wb, filename);
        return true;
      } catch (e) {
        console.warn('[DocumentExporter] XLSX.writeFile failed, falling back to Blob download:', e);
      }
    }

    const blob = this.generateExcelBlob(docData);
    this.downloadBlob(blob, filename);
    return true;
  },

  /**
   * 5. Multi-Format Batch Export
   * Exports multiple formats either as a single .ZIP bundle or simultaneous files
   * @param {Object} docData 
   * @param {string[]} formats - array e.g. ['excel', 'word', 'pdf', 'image']
   * @param {boolean} asZip - if true bundles into ScanSheet_Exports_Bundle.zip
   */
  async exportMultiple(docData, formats = ['excel', 'word', 'pdf', 'image'], asZip = false) {
    if (!formats || formats.length === 0) {
      throw new Error('Please select at least one format to export.');
    }

    const filesToExport = [];

    if (formats.includes('excel')) {
      const excelBlob = this.generateExcelBlob(docData);
      filesToExport.push({ name: 'ScanSheet_Converted_Table.xlsx', blob: excelBlob });
    }

    if (formats.includes('word')) {
      const wordBlob = await this.generateWordBlob(docData);
      filesToExport.push({ name: 'ScanSheet_Converted_Document.docx', blob: wordBlob });
    }

    if (formats.includes('pdf')) {
      const pdfBlob = await this.generatePdfBlob(docData);
      filesToExport.push({ name: 'ScanSheet_Converted_Document.pdf', blob: pdfBlob });
    }

    if (formats.includes('image')) {
      const imgBlob = await this.generateImageBlob(docData);
      filesToExport.push({ name: 'ScanSheet_Converted_Image.png', blob: imgBlob });
    }

    if (asZip && window.JSZip) {
      const zip = new window.JSZip();
      for (const f of filesToExport) {
        if (f.blob && typeof f.blob.arrayBuffer === 'function') {
          try {
            const ab = await f.blob.arrayBuffer();
            zip.file(f.name, ab);
            continue;
          } catch (e) {}
        }
        zip.file(f.name, f.blob);
      }
      let zipBlob;
      try {
        zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      } catch (err) {
        const u8 = await zip.generateAsync({ type: 'uint8array' });
        zipBlob = new Blob([u8], { type: 'application/zip' });
      }
      this.downloadBlob(zipBlob, 'ScanSheet_Exports_Bundle.zip');
      return { count: filesToExport.length, bundle: 'ScanSheet_Exports_Bundle.zip' };
    } else {
      // Download all individually with safe spacing
      for (let i = 0; i < filesToExport.length; i++) {
        const file = filesToExport[i];
        if (i > 0) {
          await new Promise(r => setTimeout(r, 400));
        }
        this.downloadBlob(file.blob, file.name);
      }
      return { count: filesToExport.length, files: filesToExport.map(f => f.name) };
    }
  },

  isNumeric(val) {
    if (!val) return false;
    const clean = String(val).trim().replace(/^[\$€₹£¥]/, '').replace(/%$/, '').trim();
    return !isNaN(clean) && !isNaN(parseFloat(clean));
  }
};
