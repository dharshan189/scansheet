"""
ScanSheet - PaddleOCR Backend Server
Exposes free, open-source PaddleOCR (PP-OCRv4 + PP-Structure SLANet)
via lightweight Flask REST API and serves the frontend application.
"""

import os
import sys
import json
import base64
import mimetypes
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime
import cv2
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from ocr_pipeline import process_document_image

mimetypes.add_type('application/vnd.android.package-archive', '.apk')

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
    ).strip()
    supabase_key = (
        os.environ.get('SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
        or os.environ.get('SUPABASE_PUBLISHABLE_KEY')
        or ''
    ).strip()
    ocr_server_url = (os.environ.get('OCR_SERVER_URL') or '').strip()
    return jsonify({
        'supabaseUrl': supabase_url,
        'supabaseAnonKey': supabase_key,
        'ocrServerUrl': ocr_server_url,
        'configured': bool(supabase_url and supabase_key)
    })

def _supabase_get_json(url, headers):
    req = urllib.request.Request(url, method='GET', headers={'Accept': 'application/json', **headers})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode('utf-8', errors='replace')
            return resp.status, (json.loads(raw) if raw else None), resp.headers.get('Content-Range', '')
    except urllib.error.HTTPError as err:
        raw = err.read().decode('utf-8', errors='replace')
        try:
            payload = json.loads(raw) if raw else None
        except Exception:
            payload = {'message': raw}
        return err.code, payload, ''

def _parse_content_range_total(content_range, fallback):
    if not content_range or '/' not in content_range:
        return fallback
    try:
        return int(content_range.rsplit('/', 1)[-1].strip())
    except ValueError:
        return fallback

@app.route('/api/admin/overview', methods=['GET'])
def get_admin_overview():
    """
    Verifies Supabase JWT & server-side admin role in public.profiles before
    returning shared registered users, count, and conversion stats.
    """
    supabase_url = (
        os.environ.get('SUPABASE_URL')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
        or ''
    ).strip().rstrip('/')
    supabase_key = (
        os.environ.get('SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
        or os.environ.get('SUPABASE_PUBLISHABLE_KEY')
        or ''
    ).strip()
    service_role_key = (os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or '').strip()

    if not supabase_url or not supabase_key:
        return jsonify({'error': 'Supabase environment variables are not configured on the server.'}), 503

    auth_header = request.headers.get('Authorization', '')
    if not auth_header.lower().startswith('bearer ') or len(auth_header) <= 7:
        return jsonify({'error': 'Authentication token required.'}), 401
    access_token = auth_header.split(' ', 1)[1].strip()

    try:
        st, auth_user, _ = _supabase_get_json(
            f"{supabase_url}/auth/v1/user",
            {'apikey': supabase_key, 'Authorization': f'Bearer {access_token}'}
        )
        if st >= 400 or not isinstance(auth_user, dict) or not auth_user.get('id'):
            return jsonify({'error': 'Invalid or expired authentication session.'}), 401

        db_headers = (
            {'apikey': service_role_key, 'Authorization': f'Bearer {service_role_key}'}
            if service_role_key
            else {'apikey': supabase_key, 'Authorization': f'Bearer {access_token}'}
        )

        uid = urllib.parse.quote(auth_user['id'], safe='')
        p_st, p_rows, _ = _supabase_get_json(
            f"{supabase_url}/rest/v1/profiles?id=eq.{uid}&select=id,email,role",
            db_headers
        )
        caller_profile = p_rows[0] if (isinstance(p_rows, list) and p_rows) else None
        if p_st >= 400 or not caller_profile or caller_profile.get('role') != 'admin':
            return jsonify({'error': 'Admin access required.'}), 403

        u_st, u_rows, u_range = _supabase_get_json(
            f"{supabase_url}/rest/v1/profiles?select=id,email,name,picture,role,auth_provider,created_at&order=created_at.desc",
            {**db_headers, 'Prefer': 'count=exact'}
        )
        if u_st >= 400 or not isinstance(u_rows, list):
            return jsonify({'error': 'Failed to load user profiles from database.'}), 502

        users = [
            {
                'id': r.get('id'),
                'email': r.get('email'),
                'name': r.get('name') or (r.get('email') or '').split('@')[0] or 'User',
                'picture': r.get('picture'),
                'role': 'admin' if r.get('role') == 'admin' else 'user',
                'authProvider': r.get('auth_provider') or 'email',
                'createdAt': r.get('created_at')
            }
            for r in u_rows
        ]
        total_users = _parse_content_range_total(u_range, len(users))
        source = 'supabase-profiles-rls'

        if service_role_key:
            a_st, a_data, _ = _supabase_get_json(
                f"{supabase_url}/auth/v1/admin/users?page=1&per_page=1000",
                {'apikey': service_role_key, 'Authorization': f'Bearer {service_role_key}'}
            )
            if a_st < 400 and isinstance(a_data, dict) and isinstance(a_data.get('users'), list):
                prof_map = {u['id']: u for u in users}
                merged = []
                for u in a_data['users']:
                    prof = prof_map.get(u.get('id'), {})
                    meta = u.get('user_metadata') or {}
                    merged.append({
                        'id': u.get('id'),
                        'email': prof.get('email') or u.get('email') or '',
                        'name': prof.get('name') or meta.get('full_name') or meta.get('name') or (u.get('email') or '').split('@')[0] or 'User',
                        'picture': prof.get('picture') or meta.get('avatar_url'),
                        'role': 'admin' if prof.get('role') == 'admin' else 'user',
                        'authProvider': prof.get('authProvider') or (u.get('app_metadata') or {}).get('provider') or 'email',
                        'createdAt': prof.get('createdAt') or u.get('created_at')
                    })
                merged.sort(key=lambda item: item.get('createdAt') or '', reverse=True)
                users = merged
                total_users = a_data.get('total') if isinstance(a_data.get('total'), int) else len(users)
                source = 'supabase-auth-admin'

        s_st, s_rows, s_range = _supabase_get_json(
            f"{supabase_url}/rest/v1/conversion_history?select=id,status,created_at",
            {**db_headers, 'Prefer': 'count=exact'}
        )
        stats = {'totalProjects': 0, 'dailyUploads': 0, 'filesGenerated': 0}
        if s_st < 400 and isinstance(s_rows, list):
            stats['totalProjects'] = _parse_content_range_total(s_range, len(s_rows))
            today_iso = datetime.now().date().isoformat()
            for row in s_rows:
                created = row.get('created_at') or ''
                if created[:10] == today_iso:
                    stats['dailyUploads'] += 1
                if row.get('status') == 'completed':
                    stats['filesGenerated'] += 1

        return jsonify({
            'totalUsers': total_users,
            'users': users,
            'stats': stats,
            'verifiedAdmin': {'id': auth_user['id'], 'email': auth_user.get('email'), 'role': 'admin'},
            'source': source
        })
    except Exception as exc:
        print(f"[Admin Overview Error]: {exc}", file=sys.stderr)
        return jsonify({'error': 'Unable to verify admin authorization with Supabase.'}), 500

@app.route('/api/auth/login', methods=['POST'])
def auth_login_with_identifier():
    """
    Resolves admin username alias (`ss@2718`) server-side to a real Supabase
    email and authenticates with Supabase Auth password grant.
    """
    supabase_url = (
        os.environ.get('SUPABASE_URL')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
        or ''
    ).strip().rstrip('/')
    supabase_key = (
        os.environ.get('SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
        or os.environ.get('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
        or os.environ.get('SUPABASE_PUBLISHABLE_KEY')
        or ''
    ).strip()
    admin_login_email = (
        os.environ.get('ADMIN_EMAIL')
        or os.environ.get('ADMIN_LOGIN_EMAIL')
        or 'ss2718@scansheet.app'
    ).strip().lower()

    if not supabase_url or not supabase_key:
        return jsonify({'error': 'Supabase environment variables are not configured on the server.'}), 503

    payload = request.get_json(silent=True) or {}
    identifier = str(payload.get('identifier') or payload.get('email') or '').strip().lower()
    password = payload.get('password') if isinstance(payload.get('password'), str) else ''

    if not identifier or not password:
        return jsonify({'error': 'Email/username and password are required.'}), 400

    if identifier == 'ss@2718':
        login_email = admin_login_email
    elif '@' in identifier and '.' in identifier.split('@', 1)[-1]:
        login_email = identifier
    else:
        return jsonify({'error': 'Please enter a valid email address or admin username.'}), 400

    req = urllib.request.Request(
        f"{supabase_url}/auth/v1/token?grant_type=password",
        data=json.dumps({'email': login_email, 'password': password}).encode('utf-8'),
        method='POST',
        headers={
            'apikey': supabase_key,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8', errors='replace') or '{}')
            if not data.get('access_token') or not data.get('refresh_token') or not data.get('user'):
                return jsonify({'error': 'Incorrect username or password.'}), 401
            return jsonify({
                'session': {
                    'access_token': data['access_token'],
                    'refresh_token': data['refresh_token']
                },
                'user': data['user']
            })
    except urllib.error.HTTPError as err:
        raw = err.read().decode('utf-8', errors='replace')
        try:
            err_json = json.loads(raw) if raw else {}
        except Exception:
            err_json = {}
        return jsonify({'error': err_json.get('error_description') or err_json.get('msg') or 'Incorrect username or password.'}), 401
    except Exception as exc:
        print(f"[Auth Login Error]: {exc}", file=sys.stderr)
        return jsonify({'error': 'Unable to authenticate right now. Please try again.'}), 500

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

