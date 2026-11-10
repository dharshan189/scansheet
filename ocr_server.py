"""
ScanSheet - PaddleOCR Backend Server
Exposes free, open-source PaddleOCR (PP-OCRv4 + PP-Structure SLANet)
via lightweight Flask REST API and serves the frontend application.
"""

import os
import sys
import base64
import cv2
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from ocr_pipeline import process_document_image

# Path to static frontend files
FRONTEND_DIR = os.path.abspath(os.path.dirname(__file__))

# Non-destructive .env loader for local environment variables
def load_dotenv():
    env_path = os.path.join(FRONTEND_DIR, '.env')
    if os.path.exists(env_path):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k and k not in os.environ:
                            os.environ[k] = v
        except Exception as e:
            print(f"[OCR Server] Notice: Could not read .env: {e}")

load_dotenv()

app = Flask(__name__, static_folder=FRONTEND_DIR)
CORS(app)  # Enable Cross-Origin Resource Sharing for mobile and local dev

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'ok',
        'engine': 'PaddleOCR (PP-OCRv4 + PP-Structure SLANet)',
        'framework': 'ONNXRuntime (CPU optimized for Intel/AMD/ARM)',
        'version': '1.0.0'
    })

@app.route('/api/config', methods=['GET'])
def get_config():
    """
    Exposes only public configuration to the frontend client.
    Never exposes secret role keys or database connection strings.
    """
    supabase_url = (
        os.environ.get('SUPABASE_URL')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
        or ''
    )
    supabase_key = (
        os.environ.get('SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
        or os.environ.get('SUPABASE_PUBLISHABLE_KEY')
        or ''
    )
    return jsonify({
        'supabaseUrl': supabase_url,
        'supabaseAnonKey': supabase_key,
        'ocrServerUrl': os.environ.get('OCR_SERVER_URL', '')
    })

@app.route('/api/scan', methods=['POST'])
def scan_image():
    try:
        img_bgr = None

        # 1. Check for file upload (multipart/form-data)
        if 'file' in request.files:
            file = request.files['file']
            if file.filename:
                file_bytes = np.frombuffer(file.read(), np.uint8)
                img_bgr = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

        # 2. Check for JSON payload with base64 data URL
        if img_bgr is None and request.is_json:
            data = request.get_json(silent=True) or {}
            img_b64 = data.get('image') or data.get('imageUrl')
            if img_b64:
                # Remove header if present (e.g. data:image/png;base64,...)
                if ',' in img_b64:
                    img_b64 = img_b64.split(',', 1)[1]
                img_bytes = base64.b64decode(img_b64)
                np_arr = np.frombuffer(img_bytes, np.uint8)
                img_bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if img_bgr is None:
            return jsonify({
                'success': False,
                'error': 'No valid image provided. Please upload an image file or base64 data.'
            }), 400

        # Process through PaddleOCR pipeline
        result = process_document_image(img_bgr)
        return jsonify(result)

    except Exception as e:
        print(f"[OCR Server Error]: {e}", file=sys.stderr)
        return jsonify({
            'success': False,
            'error': f"Recognition failed: {str(e)}"
        }), 500

# Serve static frontend application
@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    if path != "" and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, 'index.html')

def start_instance(port):
    try:
        app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
    except Exception as err:
        print(f"[OCR Server] Port {port} notice: {err}")

if __name__ == '__main__':
    import threading
    import time

    print(f"===========================================================")
    print(f" ScanSheet PaddleOCR Server starting on ports 8080 & 5000")
    print(f" Mobile / Ngrok Tunnel:  http://localhost:8080")
    print(f" Local Web & OCR API:    http://localhost:5000")
    print(f"===========================================================")

    # Run port 5000 in background daemon thread
    t5000 = threading.Thread(target=start_instance, args=(5000,), daemon=True)
    t5000.start()
    time.sleep(0.5)

    # Run port 8080 in main thread (mapped to ngrok tunnel)
    start_instance(8080)

