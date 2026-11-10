"""
ScanSheet PaddleOCR Pipeline
Uses free, open-source PaddleOCR models (PP-OCRv4 + PP-Structure SLANet)
via ONNX Runtime CPU engine for maximum compatibility across all CPUs.
"""

import os
import re
import cv2
import numpy as np
import lxml.html
from rapidocr import RapidOCR
from rapid_table import RapidTable

_ocr_engine = None
_table_engine = None

def clean_text(text):
    """
    Generic typographic and structural normalization for OCR extracted text.
    Relies purely on character structure, whitespace normalization, and edge boundary cleanup.
    Contains no hardcoded word dictionaries or image-specific substitutions.
    """
    if not text or not isinstance(text, str):
        return text or ''
    val = ' '.join(text.split()).strip()
    # Strip isolated border artifacts from cell boundaries (e.g. stray pipe, underscore, or tilde)
    val = re.sub(r'^[|!_~—\s]+', '', val).strip()
    val = re.sub(r'[|!_~—\s]+$', '', val).strip()
    return val

def get_engines():
    global _ocr_engine, _table_engine
    if _ocr_engine is None:
        _ocr_engine = RapidOCR()
    if _table_engine is None:
        _table_engine = RapidTable()
    return _ocr_engine, _table_engine

def parse_html_table(html_str):
    """
    Parses HTML table produced by PP-Structure SLANet into a 2D grid matrix,
    properly expanding colspan and rowspan attributes and preserving cell positions.
    """
    if not html_str or '<table' not in html_str.lower():
        return None

    try:
        tree = lxml.html.fromstring(html_str)
        tables = tree.xpath('//table')
        if not tables:
            return None
        table_el = tables[0]
        rows = table_el.xpath('.//tr')
        if not rows:
            return None

        matrix = {}
        max_c = 0
        merges = []
        cell_spans = {}

        for r_idx, tr in enumerate(rows):
            c_idx = 0
            cells = tr.xpath('./td|./th')
            for td in cells:
                while (r_idx, c_idx) in matrix:
                    c_idx += 1
                try:
                    colspan = int(td.get('colspan', 1))
                except (ValueError, TypeError):
                    colspan = 1
                try:
                    rowspan = int(td.get('rowspan', 1))
                except (ValueError, TypeError):
                    rowspan = 1

                raw_text = ' '.join(td.text_content().split()).strip()
                cleaned_text = clean_text(raw_text)

                if colspan > 1 or rowspan > 1:
                    merges.append({
                        's': {'r': r_idx, 'c': c_idx},
                        'e': {'r': r_idx + rowspan - 1, 'c': c_idx + colspan - 1}
                    })
                    cell_spans[f"{r_idx}_{c_idx}"] = {
                        'colspan': colspan,
                        'rowspan': rowspan
                    }

                for r in range(rowspan):
                    for c in range(colspan):
                        matrix[(r_idx + r, c_idx + c)] = cleaned_text if (r == 0 and c == 0) else ''

                c_idx += colspan
                if c_idx > max_c:
                    max_c = c_idx

        num_rows = len(rows)
        num_cols = max_c

        if num_rows == 0 or num_cols == 0:
            return None

        grid = []
        for r in range(num_rows):
            row_data = [matrix.get((r, c), '') for c in range(num_cols)]
            grid.append(row_data)

        # Remove trailing completely empty rows
        while grid and not any(cell.strip() for cell in grid[-1]):
            grid.pop()

        if not grid:
            return None

        return {
            'rowCount': len(grid),
            'colCount': num_cols,
            'grid': grid,
            'html': html_str,
            'merges': merges,
            'cellSpans': cell_spans,
            'isUncertainMap': {}
        }
    except Exception as e:
        print(f"[PaddleOCR Pipeline] parse_html_table error: {e}")
        return None

def process_document_image(image_input):
    """
    Main recognition entrypoint:
    image_input: file path (str) or numpy array (BGR)
    Returns structured ScanSheet document model dict compatible with frontend.
    """
    ocr_engine, table_engine = get_engines()

    if isinstance(image_input, str):
        if not os.path.exists(image_input):
            raise FileNotFoundError(f"Image not found: {image_input}")
        img = cv2.imread(image_input)
    elif isinstance(image_input, np.ndarray):
        img = image_input
    else:
        img = cv2.cvtColor(np.array(image_input), cv2.COLOR_RGB2BGR)

    if img is None:
        raise ValueError("Failed to load image for recognition.")

    # Guard against excessively large or low-resolution images
    # 1. Downscale excessively large camera photos to max 2400px preserving aspect ratio
    max_dim = max(img.shape[0], img.shape[1])
    if max_dim > 2400:
        scale = 2400.0 / max_dim
        new_w = int(img.shape[1] * scale)
        new_h = int(img.shape[0] * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    # 2. Upscale low-resolution images (e.g. < 900px) using bilinear interpolation so character strokes have optimal pixel height without ringing artifacts
    elif max_dim < 900:
        scale = min(1.6, 900.0 / max_dim)
        new_w = int(img.shape[1] * scale)
        new_h = int(img.shape[0] * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    # 1. Attempt RapidTable (PP-Structure SLANet)
    table_result = None
    table_html = None
    try:
        res = table_engine(img)
        if res and hasattr(res, 'pred_htmls') and len(res.pred_htmls) > 0:
            table_html = res.pred_htmls[0]
            table_result = parse_html_table(table_html)
    except Exception as e:
        print(f"[PaddleOCR Pipeline] Table engine notice: {e}")

    # Check if a genuine multi-cell table was found
    has_table = False
    if table_result and table_result['rowCount'] >= 2 and table_result['colCount'] >= 2:
        cells_with_text = sum(1 for row in table_result['grid'] for cell in row if cell.strip())
        if cells_with_text >= 3:
            has_table = True

    doc_title = ''
    intro_paragraphs = []
    notes = []

    if has_table:
        grid = table_result['grid']
        num_cols = table_result['colCount']

        # Check if the last row is actually notes/guidelines/footer
        if len(grid) >= 3:
            last_row = grid[-1]
            last_text = ' '.join(c for c in last_row if c.strip()).strip()
            if re.match(r'^(Notes?|Guidelines?|Disclaimer|Important|Source|Total|Notice)\b', last_text, re.I):
                notes.append(last_text)
                grid.pop()

        # Check if row 0 is a document title or section heading
        if len(grid) >= 2:
            first_row = grid[0]
            first_text = ' '.join(c for c in first_row if c.strip()).strip()
            row1 = grid[1]
            row1_text_count = sum(1 for c in row1 if c.strip())

            # If row 0 text spans across columns (only cell 0 has text while others are empty)
            if first_row[0] and all(not c.strip() for c in first_row[1:]):
                # If row 1 has multiple filled cells (it's the real table header), row 0 is a title!
                if row1_text_count >= 2:
                    if len(first_text) > 80 and '.' in first_text:
                        parts = first_text.split('. ', 1)
                        doc_title = parts[0].strip()
                        intro_paragraphs.append(parts[1].strip())
                    else:
                        doc_title = first_text
                    grid = grid[1:]

                    # Shift merges and cellSpans up by 1 row since row 0 became document title
                    if table_result.get('merges'):
                        shifted_merges = []
                        for m in table_result['merges']:
                            if m['s']['r'] > 0:
                                shifted_merges.append({
                                    's': {'r': m['s']['r'] - 1, 'c': m['s']['c']},
                                    'e': {'r': m['e']['r'] - 1, 'c': m['e']['c']}
                                })
                        table_result['merges'] = shifted_merges

                    if table_result.get('cellSpans'):
                        shifted_spans = {}
                        for k, v in table_result['cellSpans'].items():
                            r, c = map(int, k.split('_'))
                            if r > 0:
                                shifted_spans[f"{r - 1}_{c}"] = v
                        table_result['cellSpans'] = shifted_spans

                # If row 1 only has 1 or fewer filled cells or looks like data, row 0 might be concatenated header names
                elif len(first_row) > 1:
                    # Check if first_text can be split into headers matching colCount via multi-space or tab delimiters
                    tokens = [t.strip() for t in re.split(r'\s{2,}|\t', first_text) if t.strip()]
                    if len(tokens) == num_cols:
                        grid[0] = tokens

        table_result['grid'] = grid
        table_result['rowCount'] = len(grid)

        content_type = 'mixed' if (doc_title or intro_paragraphs) else 'table'
        is_receipt = bool(re.search(r'(invoice|receipt|subtotal|total due|amount due|bill to|tax)', table_html or '', re.I))

        return {
            'success': True,
            'contentType': 'receipt' if is_receipt else content_type,
            'title': doc_title,
            'paragraphs': intro_paragraphs,
            'table': table_result,
            'notes': notes,
            'recommendedExport': 'excel' if not intro_paragraphs else 'word',
            'recommendedFormats': ['excel', 'word', 'pdf'] if content_type == 'table' else ['word', 'pdf', 'excel'],
            'recommendationReason': (
                'Detected structured table via PaddleOCR. Excel is recommended for spreadsheet analysis, or Word/PDF for formatted reporting.'
                if content_type == 'table' else
                'Detected document with heading and structured table via PaddleOCR. Word and PDF preserve the full layout; Excel includes table data.'
            )
        }

    # 2. If no structured table was found, run RapidOCR (PP-OCRv4) for text extraction
    all_texts = []
    try:
        ocr_res = ocr_engine(img)
        if ocr_res and hasattr(ocr_res, 'txts') and ocr_res.txts is not None:
            all_texts = [clean_text(t) for t in ocr_res.txts if t and str(t).strip()]
    except Exception as e:
        print(f"[PaddleOCR Pipeline] RapidOCR error: {e}")

    if not all_texts:
        return {
            'success': False,
            'error': "We couldn't read the content clearly. Please upload a clearer image."
        }

    raw_text = ' '.join(all_texts)
    lines = all_texts

    # Extract Document Title if first line looks like a title/heading
    if lines:
        first_line = lines[0].strip()
        if len(lines) > 1 and (len(first_line) < 90 or re.match(r'^([A-Z0-9\s:.-]{3,60}|Question\s+Paper|Test\s+Paper|Notes|Invoice|Receipt|Report)', first_line, re.I)):
            doc_title = first_line
            lines = lines[1:]

    # Segment remaining lines into clean paragraphs
    current_para = []
    for line in lines:
        text = line.strip()
        if not text:
            continue
        is_bullet_or_num = bool(re.match(r'^[•\-\*]\s+|^\(?\d+[.)]\s+|^(Question|Q\d|Section|Part|Chapter)\b', text, re.I))
        if is_bullet_or_num and current_para:
            intro_paragraphs.append(' '.join(current_para))
            current_para = []
        current_para.append(text)

    if current_para:
        intro_paragraphs.append(' '.join(current_para))

    # Identify trailing notes or disclaimers
    if intro_paragraphs and re.match(r'^(Note|Source|Disclaimer|Confidential|Page \d)\b', intro_paragraphs[-1], re.I):
        notes.append(intro_paragraphs.pop())

    is_study_notes = bool(re.search(r'(question|marks|answer|section [a-c]|fill in the blanks|true or false)', raw_text, re.I))

    return {
        'success': True,
        'contentType': 'document',
        'title': doc_title,
        'paragraphs': intro_paragraphs,
        'table': None,
        'notes': notes,
        'recommendedExport': 'word',
        'recommendedFormats': ['word', 'pdf'],
        'recommendationReason': (
            'Detected study notes / question paper via PaddleOCR. Word (.docx) and PDF (.pdf) are recommended for studying and printing.'
            if is_study_notes else
            'Detected text document with headings and paragraphs via PaddleOCR. Word (.docx) and PDF (.pdf) are recommended for editable reading and sharing.'
        )
    }

if __name__ == '__main__':
    import sys
    import json
    if len(sys.argv) < 2:
        print("Usage: python ocr_pipeline.py <image_path>")
        sys.exit(1)
    test_img = sys.argv[1]
    res = process_document_image(test_img)
    print(json.dumps(res, indent=2, ensure_ascii=False))

