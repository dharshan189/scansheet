# ScanSheet

> **"Turn table images into editable Excel files."**

ScanSheet is a lightweight commercial-grade productivity tool that converts photos and scans of tables into clean, structured, editable spreadsheets.

---

## 🎯 Target Platform & Distribution

- **Platform**: Android (Phones & Tablets) & Responsive Web
- **Release Target**: Google Play Release
- **Packaging Target**: Signed Android App Bundle (`.aab`) via Capacitor / WebView wrapper
- **Planned Application ID**: `com.scansheet.app` *(Registration/availability subject to Google Play verification)*

---

## 📂 Project Structure

```text
ScanSheet/
├── index.html              # Main HTML5 entry document (accessible, safe-area aware, dialogs)
├── css/
│   ├── style.css           # Core design system, navigation, forms, modals & upload card
│   └── responsive.css      # Responsive media queries (phones, tablets, laptops, desktops)
├── js/
│   ├── app.js              # Application bootstrapper, workflow orchestration & nav sync
│   ├── auth.js             # Authentication state, login gate & session intent manager
│   ├── upload.js           # File picker, image format validation & preview controller
│   ├── history.js          # User-specific history schema, gate & record view
│   ├── ui.js               # Modal manager, drawer, password toggles & toast alerts
│   └── utils.js            # DOM utilities, debounce & accessibility announcements
├── assets/
│   ├── icons/              # Vector SVG icons (logo, upload, sheet, menu, close, eye, user)
│   └── images/             # Static graphics and image directory (.gitkeep)
└── README.md               # Architectural documentation & implementation status
```

---

## 🛠️ Technology Stack

- **Markup**: Semantic HTML5 (WAI-ARIA dialogs, landmarks, `aria-live` status regions)
- **Styling**: Vanilla CSS3 (Custom properties design system, Grid & Flexbox, no external framework bloat)
- **Logic**: Vanilla ES Modules JavaScript (modular, zero-dependency, lightweight)

---

## 🚀 Step 2: Upload Action & Login Gate Architecture

### 1. Upload Button Behavior & Login Gate
- **Logged-out State**: When a user taps "Upload Table Image", the **Auth Gate Modal** appears:
  - Title: *"Sign in to save your history"*
  - Message: *"Create a ScanSheet account to keep your converted tables in your history and access them later."*
  - Buttons: `[Login]`, `[Create Account]`, `[Cancel]`
- **Continuous Workflow**: If the user authenticates after triggering the gate, they are automatically returned to the file upload workflow without needing to locate the Upload button again.
- **Logged-in State**: The file picker triggers immediately.

### 2. Authentication UI & Validation
- **Login Screen**: Email & Password inputs, interactive `[Show Password]` toggle, `[Forgot Password?]` link, and switch to `[Create Account]`.
- **Sign Up Screen**: Full Name, Email, Password, and Confirm Password fields with client validation (valid email format, minimum 6 characters, matching passwords).
- **Backend Readiness**: Architecture is cleanly prepared with `Auth.onAuthStateChanged()` to attach to Supabase / REST authentication backends in future steps.

### 3. File Upload & Preview Card
- **Supported Formats**: JPG, JPEG, PNG (prepared for camera and gallery integration).
- **Format Validation**: Unsupported file types trigger an accessible alert.
- **Preview Component**: Displays image thumbnail, file name, formatted file size, and actionable controls:
  - `[Continue]`: Displays *"Table scanning will be available in the next step."*
  - `[Change Image]`: Re-opens the system file picker.
  - `[Remove]`: Clears preview and resets upload drop zone.

### 4. History Architecture & Navigation
- **Navigation Item**: Added to header (`History`).
- **Logged-out State**: Displays *"Sign in to view your conversion history."* with `[Login]` and `[Create Account]` actions.
- **Logged-in State**: Displays user-specific conversion records (Today / Yesterday groups with rows, columns, and action buttons).
- **Access Control Model**: Architecture specifies records strictly bounded by authenticated `userId`.

---

## ⚡ Step 4: Rapid Table Scanning & Structure Recognition

### 1. Zero Artificial Latency Execution
- **Instant Scan Trigger**: Scanning starts immediately upon tapping `[Use This Image]`.
- **Zero Cosmetic Delays**: No synthetic timers or prolonged animation loops; processing runs synchronously through real milestone checkpoints.
- **Minimal Progress Screen**: Compact spinner with clear, concise status updates:
  - `Analyzing image...`
  - `Detecting table...`
  - `Reading content...`
  - `Preparing result...`

### 2. High-Performance Image Optimization & Recognition
- **Internal Downscaling**: Large phone photos (>1600px) are internally optimized to a crisp 1600px canvas, preventing browser memory stalls while preserving sharp text and grid lines.
- **Table Boundary Detection**: Computes horizontal/vertical projections and contour lines, excluding margins and outside noise.
- **Grid & Cell Segmentation**: Detects distinct row and column delimiters, preserving original row-major cell order.
- **Empty Cell Identification**: Evaluates pixel density per cell to accurately identify blank cells (`""`) without misattributing text.
- **Text-to-Cell Association**: Words and characters are strictly bound to their parent grid cells.

### 3. Immediate Results & Fallback Handling
- **Instant Result Transition**: Automatically moves to the clean result screen the instant processing finishes.
- **Semantic Structure**: Rendered in a clean, responsive spreadsheet preview card with sticky headers, row numbers, and empty cell pills.
- **No Table Fallback**: Displays *"We couldn't detect a table in this image. Please use a clearer image with the table fully visible."* with `[Try Another Image]`.

---

## 📱 Mobile & Android Readiness

- **Touch Ergonomics**: All inputs and buttons maintain standard 48px touch targets.
- **Keyboard Protection**: Modals scroll smoothly (`max-height: calc(100dvh - 32px)`) with no horizontal scrolling when mobile on-screen keyboards appear.
- **Mobile Navigation Drawer**: Accessible slide-out drawer on devices under 768px.
- **Safe Area Insets**: Handled with `viewport-fit=cover` and `env(safe-area-inset-*)`.

---

## 🔒 Security & Privacy by Design

- **No Plaintext Password Storage**: Client-side authentication models avoid persistent plaintext storage.
- **No Hard-coded Secrets**: Zero API keys or tokens in client bundles.
- **Zero Third-Party Telemetry**: No trackers, ads, or analytics scripts.
- **No Unnecessary Permissions**: No device contacts, location, SMS, or microphone requests.

---

## 🗄️ Supabase PostgreSQL & Persistent Authentication

ScanSheet integrates directly with **Supabase PostgreSQL** and **Supabase Auth** for secure, multi-tenant persistence.

### 1. Database Schema & Row Level Security (RLS)
The database structure is defined in non-destructive migration file:
`supabase/migrations/20261110000000_scansheet_init.sql`

- **`profiles`**: Tied 1:1 to `auth.users(id)` via Postgres trigger.
- **`conversion_history`**: Holds user conversion records, row/col metrics, output file names, and full structured document models for instant reopening.
- **`file_uploads`**: Stores image upload metadata, file sizes, MIME types, and processing states.
- **Performance Optimized RLS**: All RLS policies utilize cached UID evaluation `((select auth.uid()) = user_id)` following official Supabase performance guidelines (avoiding per-row function invocation).
- **Foreign Key Indexes**: B-tree indexes are enforced on foreign keys and RLS lookup columns to prevent table locks and slow joins.

### 2. Connection Pooling Architecture
Postgres connections are resource-intensive (1-3 MB RAM per connection). ScanSheet supports dual pooling modes:
- **Transaction Pooler (Port 6543 / PgBouncer / Supavisor)**: Recommended for serverless environments (Vercel, AWS Lambda). Automatically reuses database connections across thousands of stateless requests.
- **Session Connection (Port 5432)**: Dedicated persistent connections for local migrations and stateful background services.

### 3. Vercel Deployment
- **Frontend & Serverless**: Deploy the static assets and `/api/config.js` on Vercel using `vercel.json`.
- **Environment Variables**: Configure in Vercel Project Settings:
  - `SUPABASE_URL`: Your Supabase project URL (e.g. `https://xyz.supabase.co`)
  - `SUPABASE_ANON_KEY`: Public client anon key
  - `OCR_SERVER_URL`: URL of your deployed PaddleOCR Python service (e.g. on Railway/Render/VPS)
- **PaddleOCR Hosting**: Because PaddleOCR + ONNXRuntime models exceed Vercel's 50MB/250MB serverless bundle limits, the Python OCR service (`ocr_server.py`) is designed to run independently on Docker/Python container platforms (Railway, Render, Fly.io, or VPS) while communicating securely via CORS with the frontend.
