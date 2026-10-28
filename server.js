const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const {
  analyzeCapCutTemplate,
  discoverCapCutTemplates,
  detectSceneSlotsFromVideo,
  probeVideo,
  CACHE_DIR
} = require('./src/capcutAnalyzer');

const {
  openCapCutLoginWindow,
  sendRemoteBrowserAction,
  closeCapCutLoginWindow,
  runCapCutWebAutomation,
  runCapCutWebParallelBatch,
  cancelCapCutRender,
  getTemplateFolderName,
  getTemplateOutputDir
} = require('./src/capcutBrowserBot');

const {
  renderWithFfmpegEngine,
  stabilizeVideoFile,
  ensureBuiltinTemplateVideos,
  generateDemoUserClips,
  BUILTIN_TEMPLATES,
  OUTPUT_DIR,
  UPLOAD_DIR
} = require('./src/ffmpegTemplateEngine');

const {
  listCapCutPcDrafts,
  injectMediaIntoCapCutDraft,
  openTemplateInCapCutPcApp
} = require('./src/capcutPcDraftEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ============================================================================
// SECURITY: Server-Side PIN Gate & Anti-Scraper Protection
// ============================================================================
const HARDCODED_PIN_MD5 = '5c6fa40fd0eb5e811ef6bae0e8b66116';
const AUTH_SECRET_FILE = path.join(CACHE_DIR, '.auth_secret');
const AUTH_SECRET = (() => {
  try {
    if (fs.existsSync(AUTH_SECRET_FILE)) {
      const saved = fs.readFileSync(AUTH_SECRET_FILE, 'utf8').trim();
      if (saved.length >= 64) return saved;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(AUTH_SECRET_FILE, generated, 'utf8');
    return generated;
  } catch {
    return crypto.randomBytes(48).toString('hex');
  }
})();
const AUTH_COOKIE_NAME = 'lm_auth_token';
const loginAttemptsByIp = new Map();

function createAuthToken() {
  const payload = `unlocked:${HARDCODED_PIN_MD5}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expected = createAuthToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader) return map;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try {
        map[k] = decodeURIComponent(v);
      } catch {
        map[k] = v;
      }
    }
  }
  return map;
}

function isRequestAuthenticated(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const token =
    cookies[AUTH_COOKIE_NAME] ||
    (req.headers && req.headers['x-auth-token']) ||
    (req.query && req.query.token) ||
    '';
  return verifyAuthToken(String(token));
}

function isLocalRequest(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || req.ip || '');
  const isLoopbackSocket = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopbackSocket) return false;

  const headers = req.headers || {};
  if (
    headers['cf-connecting-ip'] ||
    headers['cf-ray'] ||
    headers['x-forwarded-for'] ||
    headers['x-forwarded-host']
  ) {
    return false;
  }

  const hostHeader = String(headers.host || '').trim();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(hostHeader);
}

function requirePinAuth(req, res, next) {
  if (isRequestAuthenticated(req)) {
    return next();
  }
  return res.status(401).json({
    success: false,
    authRequired: true,
    error: 'Vui lòng nhập mã PIN bảo mật để truy cập hệ thống!'
  });
}

function attachWebSocketUpgrade(httpServer) {
  httpServer.on('upgrade', (request, socket, head) => {
    if (!isRequestAuthenticated(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
}
attachWebSocketUpgrade(server);

wss.on('connection', (ws) => {
  try {
    ws.send(JSON.stringify({
      type: 'template_locks',
      timestamp: new Date().toLocaleTimeString('vi-VN'),
      lockedTemplateIds: Array.from(activeRenderingTemplates.keys()),
      activeRenders: Array.from(activeRenderingTemplates.values())
    }));
  } catch {}
});

// Anti-Scraper / Anti-Bot & Security Headers Middleware
const SCRAPER_UA_REGEX = /(httrack|wget|curl|python-requests|python-urllib|scrapy|webcopier|teleport|sitesucker|offline explorer|go-http-client|libwww-perl|sqlmap|nikto|nmap|masscan|zgrab|apachebench|httpclient|java\/|php\/|ruby)/i;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  const ua = String((req.headers && req.headers['user-agent']) || '');
  if (!isLocalRequest(req) && (!ua || SCRAPER_UA_REGEX.test(ua))) {
    return res.status(403).send('403 Forbidden');
  }
  next();
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

// PIN Auth Endpoints (Must be registered BEFORE the static file gate so unauthenticated users can submit their PIN)
app.get('/api/auth/status', (req, res) => {
  res.json({
    success: true,
    authenticated: isRequestAuthenticated(req),
    isLocalhost: isLocalRequest(req)
  });
});

app.post('/api/auth/login', (req, res) => {
  const clientIp = String(req.headers['cf-connecting-ip'] || req.ip || 'unknown');
  const now = Date.now();
  const attempt = loginAttemptsByIp.get(clientIp) || { count: 0, resetAt: now + 60000 };
  if (now > attempt.resetAt) {
    attempt.count = 0;
    attempt.resetAt = now + 60000;
  }
  if (attempt.count >= 8) {
    const waitSec = Math.max(1, Math.ceil((attempt.resetAt - now) / 1000));
    return res.status(429).json({
      success: false,
      error: `Nhập sai quá nhiều lần. Vui lòng thử lại sau ${waitSec} giây!`
    });
  }

  const { pin = '' } = req.body || {};
  const cleanPin = String(pin || '').trim();
  const inputMd5 = crypto.createHash('md5').update(cleanPin).digest('hex');

  const a = Buffer.from(inputMd5, 'utf8');
  const b = Buffer.from(HARDCODED_PIN_MD5, 'utf8');
  const isMatch = cleanPin.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!isMatch) {
    attempt.count += 1;
    loginAttemptsByIp.set(clientIp, attempt);
    return res.status(401).json({
      success: false,
      error: 'Mã PIN không chính xác!'
    });
  }

  loginAttemptsByIp.delete(clientIp);
  const token = createAuthToken();
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
  );
  return res.json({ success: true, token });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
  return res.json({ success: true });
});

// Standalone PIN Lock HTML served when visitor is NOT authenticated (Hides 100% of Studio HTML & blocks /app.js!)
const LOCK_SCREEN_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LMautoedit — Bảo Mật Hệ Thống</title>
  <link rel="icon" type="image/png" href="/favicon.png?v=20261028_12" />
  <link rel="stylesheet" href="/index.css?v=20261029_19" />
</head>
<body>
  <div class="pin-lock-overlay" id="pin-lock-overlay" style="display: flex;">
    <div class="pin-lock-card" id="pin-lock-card">
      <div class="pin-lock-logo">
        <img src="/logo.png?v=20261028_12" alt="LMautoedit" />
      </div>
      <div class="pin-lock-brand">
        <span class="wordmark-lm">LM</span><span class="wordmark-video">autoedit</span><span class="wordmark-dot"></span>
      </div>
      <p class="pin-lock-sub">Nhập mã PIN bảo mật để truy cập hệ thống</p>
      <form id="pin-lock-form" class="pin-lock-form" autocomplete="off">
        <input type="password" id="pin-input-field" class="pin-input-field" inputmode="numeric" maxlength="6" placeholder="• • • • • •" autofocus />
        <div class="pin-error-msg" id="pin-error-msg"></div>
        <button type="submit" class="btn btn-primary pin-submit-btn" id="btn-pin-submit">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <span>Mở Khóa Hệ Thống</span>
        </button>
      </form>
    </div>
  </div>
  <script>
    document.addEventListener('contextmenu', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
    window.addEventListener('keydown', e => {
      const k = String(e.key || '').toLowerCase();
      if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) || ((e.ctrlKey || e.metaKey) && (k === 'u' || k === 's'))) {
        e.preventDefault(); e.stopPropagation();
      }
    }, true);
    const form = document.getElementById('pin-lock-form');
    const input = document.getElementById('pin-input-field');
    const errEl = document.getElementById('pin-error-msg');
    const card = document.getElementById('pin-lock-card');
    let busy = false;
    async function submitPin(val) {
      if (busy) return;
      const pin = String(val || '').trim();
      if (!pin) return;
      busy = true;
      try {
        const r = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });
        const d = await r.json();
        if (d && d.success) {
          location.reload();
          return;
        }
        errEl.textContent = (d && d.error) || 'Mã PIN không chính xác!';
        input.value = '';
        card.classList.remove('shake-error');
        void card.offsetWidth;
        card.classList.add('shake-error');
      } catch (e) {
        errEl.textContent = 'Lỗi kết nối máy chủ!';
      } finally {
        busy = false;
      }
    }
    form.addEventListener('submit', e => { e.preventDefault(); submitPin(input.value); });
    input.addEventListener('input', () => {
      if (errEl.textContent) errEl.textContent = '';
      if (input.value.trim().length === 6) submitPin(input.value);
    });
  </script>
</body>
</html>`;

// Gate / and /index.html and /app.js behind PIN authentication so unauthenticated visitors/scrapers CANNOT view source!
app.use((req, res, next) => {
  const p = req.path || '/';
  if (p === '/' || p.toLowerCase() === '/index.html') {
    if (!isRequestAuthenticated(req)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(LOCK_SCREEN_HTML);
    }
  } else if (p.toLowerCase() === '/app.js' || p.toLowerCase().endsWith('.map')) {
    if (!isRequestAuthenticated(req)) {
      return res.status(403).send('403 Forbidden — Vui lòng mở khóa mã PIN trước!');
    }
  }
  next();
});

// Static assets (CSS/Logo for Lock Screen, and full Studio HTML/JS ONLY after PIN authentication)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// Protect all subsequent /api/* routes and media folders with PIN Auth + strict nosniff headers
const safeStaticOptions = {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'");
  }
};
app.use('/api', requirePinAuth);
app.use('/uploads', requirePinAuth, express.static(UPLOAD_DIR, safeStaticOptions));
app.use('/outputs', requirePinAuth, express.static(OUTPUT_DIR, safeStaticOptions));
app.use('/cache', requirePinAuth, express.static(path.join(__dirname, 'cache'), safeStaticOptions));

// WebSocket broadcast helper
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, timestamp: new Date().toLocaleTimeString('vi-VN'), ...payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function logToClient(message, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${message}`);
  broadcast('log', { message, level });
}

function getTemplateUploadDir(templateInfo) {
  const folderName = getTemplateFolderName(templateInfo);
  const dir = path.join(UPLOAD_DIR, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { folderName, dir };
}

function findUploadFileOnDisk(filename, preferredTemplate = null) {
  const base = path.basename(filename || '');
  if (!base) return null;
  if (preferredTemplate) {
    const { folderName, dir } = getTemplateUploadDir(preferredTemplate);
    const p = path.join(dir, base);
    if (fs.existsSync(p)) return { fullPath: p, folderName, url: `/uploads/${folderName}/${base}` };
  }
  const direct = path.join(UPLOAD_DIR, base);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return { fullPath: direct, folderName: '', url: `/uploads/${base}` };
  }
  const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const subPath = path.join(UPLOAD_DIR, ent.name, base);
      if (fs.existsSync(subPath)) {
        return { fullPath: subPath, folderName: ent.name, url: `/uploads/${ent.name}/${base}` };
      }
    }
  }
  return null;
}

function findOutputFileOnDisk(filename) {
  const base = path.basename(filename || '');
  if (!base) return null;
  const direct = path.join(OUTPUT_DIR, base);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return { fullPath: direct, folderName: '', url: `/outputs/${base}` };
  }
  const entries = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const subPath = path.join(OUTPUT_DIR, ent.name, base);
      if (fs.existsSync(subPath)) {
        return { fullPath: subPath, folderName: ent.name, url: `/outputs/${ent.name}/${base}` };
      }
    }
  }
  return null;
}

const ALLOWED_MEDIA_EXTS = new Set([
  '.mp4', '.mov', '.webm', '.mkv', '.avi',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'
]);

function mediaFileFilter(req, file, cb) {
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!ALLOWED_MEDIA_EXTS.has(ext)) {
    return cb(new Error(`Định dạng file "${ext || 'không rõ'}" không được phép! Chỉ chấp nhận file Video và Ảnh.`));
  }
  cb(null, true);
}

// Configure Multer for user videos and template video uploads (stored in per-template folder!)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tplId = req.query.templateId || (req.body && req.body.templateId) || '';
    const tplTitle = req.query.templateTitle || (req.body && req.body.templateTitle) || '';
    if (tplId || tplTitle) {
      const { dir } = getTemplateUploadDir({ templateId: tplId, title: tplTitle });
      return cb(null, dir);
    }
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const rawExt = (path.extname(file.originalname || '') || '.mp4').toLowerCase();
    const ext = ALLOWED_MEDIA_EXTS.has(rawExt) ? rawExt : '.mp4';
    const safeBase = path.basename(file.originalname, rawExt).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    cb(null, `${Date.now()}_${Math.floor(Math.random() * 1000)}_${safeBase}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: mediaFileFilter,
  limits: { fileSize: 500 * 1024 * 1024, files: 50 }
});

const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, CACHE_DIR);
  },
  filename: (req, file, cb) => {
    const rawExt = (path.extname(file.originalname || '') || '.mp4').toLowerCase();
    const ext = ALLOWED_MEDIA_EXTS.has(rawExt) ? rawExt : '.mp4';
    cb(null, `template_custom_${Date.now()}${ext}`);
  }
});
const uploadTemplateVideo = multer({
  storage: templateStorage,
  fileFilter: mediaFileFilter,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 }
});

const SAVED_TEMPLATES_FILE = path.join(__dirname, 'cache', 'saved_templates.json');

// Clean up any old auto-generated fake template videos from cache
for (const fakeFile of [
  'template_cc_trend_beat_01.mp4',
  'template_cc_cinematic_reel_02.mp4',
  'template_cc_flash_speed_03.mp4'
]) {
  const fakePath = path.join(CACHE_DIR, fakeFile);
  try {
    if (fs.existsSync(fakePath)) fs.unlinkSync(fakePath);
  } catch {}
}

function loadSavedTemplates() {
  try {
    if (fs.existsSync(SAVED_TEMPLATES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVED_TEMPLATES_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        return raw.filter(t => t && t.templateId && !String(t.templateId).startsWith('cc_'));
      }
    }
  } catch {}
  return [];
}

function saveAnalyzedTemplate(tpl) {
  try {
    const allExisting = loadSavedTemplates();
    const prev = allExisting.find(t => String(t.templateId) === String(tpl.templateId));
    if (prev && Array.isArray(prev.slots) && Array.isArray(tpl.slots)) {
      tpl.slots = tpl.slots.map((s, idx) => {
        const prevSlot = prev.slots[idx];
        return {
          ...s,
          assignedFiles: (s.assignedFiles && s.assignedFiles.length > 0)
            ? s.assignedFiles
            : (prevSlot && Array.isArray(prevSlot.assignedFiles) ? prevSlot.assignedFiles : [])
        };
      });
    }
    const list = allExisting.filter(t => String(t.templateId) !== String(tpl.templateId));
    list.unshift(tpl);
    fs.writeFileSync(SAVED_TEMPLATES_FILE, JSON.stringify(list.slice(0, 30), null, 2), 'utf8');
  } catch {}
}

function getClientId(req) {
  const raw = String((req.headers && req.headers['x-client-id']) || (req.query && req.query.clientId) || 'default').trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'default';
}

const activeRenderingTemplates = new Map();

// 1. Get user's saved real CapCut templates (with per-client slot isolation!)
app.get('/api/templates/builtin', async (req, res) => {
  try {
    const clientId = getClientId(req);
    const list = loadSavedTemplates().map(tpl => {
      const copy = { ...tpl };
      if (tpl.clientSlots && Array.isArray(tpl.clientSlots[clientId])) {
        copy.slots = tpl.clientSlots[clientId];
      } else if (clientId !== 'default' && Array.isArray(tpl.slots)) {
        // Fresh client starts with clean empty slots if another client already had files in the global fallback
        copy.slots = tpl.slots.map(s => ({ ...s, assignedFiles: [], assignedFilename: '' }));
      }
      return copy;
    });
    res.json({
      success: true,
      templates: list,
      lockedTemplateIds: Array.from(activeRenderingTemplates.keys()),
      activeRenders: Array.from(activeRenderingTemplates.values())
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1b. Save uploaded file assignments for a template's slots per clientId so 2 machines never overwrite each other's slots!
app.put('/api/templates/:templateId/slots', (req, res) => {
  try {
    const clientId = getClientId(req);
    const { templateId } = req.params;
    const { slots } = req.body || {};
    if (!Array.isArray(slots)) {
      return res.status(400).json({ success: false, error: 'Dữ liệu slots không hợp lệ' });
    }
    const list = loadSavedTemplates();
    const target = list.find(t => String(t.templateId) === String(templateId));
    if (target) {
      const normalizedSlots = slots.map((s, i) => ({
        index: s.index || (i + 1),
        startTime: s.startTime ?? 0,
        endTime: s.endTime ?? s.duration ?? 5,
        duration: Number(s.duration || 5),
        assignedFiles: Array.isArray(s.assignedFiles) ? s.assignedFiles : [],
        assignedFilename: (Array.isArray(s.assignedFiles) && s.assignedFiles[0]) || ''
      }));
      if (!target.clientSlots || typeof target.clientSlots !== 'object') {
        target.clientSlots = {};
      }
      target.clientSlots[clientId] = normalizedSlots;
      target.slots = normalizedSlots;
      target.slotCount = normalizedSlots.length;
      fs.writeFileSync(SAVED_TEMPLATES_FILE, JSON.stringify(list, null, 2), 'utf8');
    }
    res.json({ success: true, template: target || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/templates/:templateId', (req, res) => {
  try {
    const { templateId } = req.params;
    const list = loadSavedTemplates().filter(t => String(t.templateId) !== String(templateId));
    fs.writeFileSync(SAVED_TEMPLATES_FILE, JSON.stringify(list, null, 2), 'utf8');
    res.json({ success: true, templates: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Discover trending templates on CapCut Web via Playwright
app.get('/api/templates/discover', async (req, res) => {
  try {
    const items = await discoverCapCutTemplates(req.query.q || '', (msg) => logToClient(msg, 'info'));
    res.json({ success: true, templates: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Analyze any CapCut template URL
app.post('/api/templates/analyze-url', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !url.trim()) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập link mẫu CapCut!' });
  }

  try {
    const template = await analyzeCapCutTemplate(url.trim(), (msg) => logToClient(msg, 'info'));
    saveAnalyzedTemplate(template);
    res.json({ success: true, template });
  } catch (err) {
    logToClient(`Lỗi phân tích link mẫu: ${err.message}`, 'error');
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Analyze an uploaded template video file directly (Auto Scene Cut Detection + Audio Extraction)
app.post('/api/templates/analyze-video', uploadTemplateVideo.single('templateVideo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Chưa nhận được file video mẫu!' });
    }
    const videoPath = req.file.path;
    const expectedSlots = parseInt(req.body.expectedSlots || '0', 10) || 0;
    logToClient(`Đang dùng FFmpeg AI Scene Detection bóc tách nhịp cắt từ video mẫu: ${req.file.originalname}...`, 'info');

    const analysis = await detectSceneSlotsFromVideo(videoPath, expectedSlots);
    const tpl = {
      templateId: `custom_${Date.now()}`,
      title: req.file.originalname.replace(/\.[^.]+$/, ''),
      originalUrl: 'local://uploaded-template',
      localVideoUrl: `/cache/templates/${req.file.filename}`,
      localVideoPath: videoPath,
      canUseOnWeb: false,
      totalDuration: analysis.totalDuration,
      width: analysis.width,
      height: analysis.height,
      slotCount: analysis.slots.length,
      slots: analysis.slots
    };

    logToClient(`Bóc tách thành công ${tpl.slotCount} phân đoạn (${tpl.totalDuration}s) từ video mẫu!`, 'success');
    res.json({ success: true, template: tpl });
  } catch (err) {
    logToClient(`Lỗi bóc tách video mẫu: ${err.message}`, 'error');
    res.status(500).json({ success: false, error: err.message });
  }
});

const UPLOADS_META_FILE = path.join(__dirname, 'cache', 'uploads_meta.json');

function loadUploadsMeta() {
  try {
    if (fs.existsSync(UPLOADS_META_FILE)) {
      return JSON.parse(fs.readFileSync(UPLOADS_META_FILE, 'utf8')) || {};
    }
  } catch {}
  return {};
}

let uploadsMetaCache = loadUploadsMeta();

function saveUploadsMeta() {
  try {
    fs.writeFileSync(UPLOADS_META_FILE, JSON.stringify(uploadsMetaCache, null, 2), 'utf8');
  } catch {}
}

// 5. Upload user video & image clips (saved directly into the template's own upload subfolder)
app.post('/api/uploads', upload.array('videos', 50), async (req, res) => {
  try {
    const files = req.files || [];
    const results = [];
    for (const f of files) {
      const info = await probeVideo(f.path);
      const relDir = path.relative(UPLOAD_DIR, path.dirname(f.path)).replace(/\\/g, '/');
      const urlPath = relDir ? `/uploads/${relDir}/${f.filename}` : `/uploads/${f.filename}`;
      const item = {
        id: f.filename,
        originalName: f.originalname,
        filename: f.filename,
        folderName: relDir || '',
        url: urlPath,
        filePath: f.path,
        size: f.size,
        duration: Number((info.duration || 4).toFixed(2)),
        width: info.width,
        height: info.height,
        isImage: Boolean(info.isImage)
      };
      uploadsMetaCache[f.filename] = {
        originalName: item.originalName,
        duration: item.duration,
        width: item.width,
        height: item.height,
        isImage: item.isImage
      };
      results.push(item);
    }
    saveUploadsMeta();
    logToClient(`Đã tải lên ${results.length} file (video/ảnh) nguyên liệu của đại ca!`, 'success');
    res.json({ success: true, clips: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. List uploaded user clips across all per-template subfolders with cached metadata
app.get('/api/uploads', async (req, res) => {
  try {
    const fileItems = [];
    const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && /\.(mp4|mov|webm|mkv|avi|jpg|jpeg|png|webp|gif|bmp)$/i.test(ent.name)) {
        fileItems.push({
          filename: ent.name,
          folderName: '',
          filePath: path.join(UPLOAD_DIR, ent.name),
          url: `/uploads/${ent.name}`
        });
      } else if (ent.isDirectory()) {
        const subDir = path.join(UPLOAD_DIR, ent.name);
        const subFiles = fs.readdirSync(subDir).filter(f => /\.(mp4|mov|webm|mkv|avi|jpg|jpeg|png|webp|gif|bmp)$/i.test(f));
        for (const sf of subFiles) {
          fileItems.push({
            filename: sf,
            folderName: ent.name,
            filePath: path.join(subDir, sf),
            url: `/uploads/${ent.name}/${sf}`
          });
        }
      }
    }

    const clips = [];
    let metaDirty = false;
    for (const item of fileItems) {
      const { filename, folderName, filePath, url } = item;
      const stat = fs.statSync(filePath);
      let meta = uploadsMetaCache[filename];
      if (!meta) {
        const info = await probeVideo(filePath);
        meta = {
          originalName: filename.replace(/^\d+_\d+_/, ''),
          duration: Number((info.duration || 4).toFixed(2)),
          width: info.width,
          height: info.height,
          isImage: Boolean(info.isImage)
        };
        uploadsMetaCache[filename] = meta;
        metaDirty = true;
      }
      clips.push({
        id: filename,
        originalName: meta.originalName || filename.replace(/^\d+_\d+_/, ''),
        filename,
        folderName,
        url,
        filePath,
        size: stat.size,
        duration: Number((meta.duration || 4).toFixed(2)),
        isImage: Boolean(meta.isImage)
      });
    }
    if (metaDirty) saveUploadsMeta();
    res.json({ success: true, clips });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6b. Trim an uploaded user video (cut start and/or end) via FFmpeg
app.post('/api/uploads/trim', async (req, res) => {
  try {
    const { filename, startTime, endTime, templateId = '', templateTitle = '' } = req.body || {};
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Thiếu tên file video cần cắt.' });
    }
    const found = findUploadFileOnDisk(filename, (templateId || templateTitle) ? { templateId, title: templateTitle } : null);
    if (!found || !fs.existsSync(found.fullPath)) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy file video gốc trên Server.' });
    }

    const startSec = Math.max(0, Number(parseFloat(startTime) || 0));
    const endSec = Number(parseFloat(endTime) || 0);
    if (endSec <= startSec + 0.2) {
      return res.status(400).json({ success: false, error: 'Khoảng thời gian cắt phải lớn hơn 0.2 giây.' });
    }

    const dir = path.dirname(found.fullPath);
    const strippedBase = path.basename(filename, path.extname(filename))
      .replace(/^trim_\d+_/, '')
      .replace(/^\d+_\d+_/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 36);
    const newFilename = `trim_${Date.now()}_${strippedBase}.mp4`;
    const newFullPath = path.join(dir, newFilename);

    await new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile(
        'ffmpeg',
        [
          '-y',
          '-ss', startSec.toFixed(3),
          '-to', endSec.toFixed(3),
          '-i', found.fullPath,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '18',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          newFullPath
        ],
        { maxBuffer: 25 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr ? stderr.slice(-400) : err.message));
          resolve();
        }
      );
    });

    const info = await probeVideo(newFullPath);
    const stat = fs.statSync(newFullPath);
    const prevMeta = uploadsMetaCache[filename] || {};
    const baseOrigName = (prevMeta.originalName || filename.replace(/^\d+_\d+_/, '')).replace(/\s*\[Đã cắt.*\]$/i, '');
    const newOrigName = `${baseOrigName} [Đã cắt ${startSec.toFixed(1)}s-${endSec.toFixed(1)}s]`;
    const relDir = path.relative(UPLOAD_DIR, dir).replace(/\\/g, '/');
    const urlPath = relDir ? `/uploads/${relDir}/${newFilename}` : `/uploads/${newFilename}`;

    const newClip = {
      id: newFilename,
      originalName: newOrigName,
      filename: newFilename,
      folderName: relDir || '',
      url: urlPath,
      filePath: newFullPath,
      size: stat.size,
      duration: Number((info.duration || (endSec - startSec)).toFixed(2)),
      width: info.width,
      height: info.height,
      isImage: false
    };

    uploadsMetaCache[newFilename] = {
      originalName: newClip.originalName,
      duration: newClip.duration,
      width: newClip.width,
      height: newClip.height,
      isImage: false
    };
    saveUploadsMeta();

    res.json({ success: true, clip: newClip });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Generate 6 demo clips for instant testing
app.post('/api/uploads/generate-demo', async (req, res) => {
  try {
    logToClient('Đang tạo 6 video demo 9:16 màu Neon để đại ca test ghép mẫu ngay...', 'info');
    const clips = await generateDemoUserClips();
    logToClient('Đã tạo xong 6 video nguyên liệu demo!', 'success');
    res.json({ success: true, clips });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Clear or delete uploaded clips (isolates by clientId so Machine 2 clearing files never deletes Machine 1's active files!)
app.delete('/api/uploads/:filename', (req, res) => {
  try {
    const clientId = getClientId(req);
    const target = req.params.filename;
    const templateId = req.query.templateId ? String(req.query.templateId) : null;

    if (target === 'ALL') {
      const templates = loadSavedTemplates();
      if (templateId) {
        const tpl = templates.find(t => String(t.templateId) === templateId);
        if (tpl) {
          const filesOwnedByThisClient = new Set();
          const filesUsedByOtherClients = new Set();

          if (tpl.clientSlots && typeof tpl.clientSlots === 'object') {
            for (const [cid, cSlots] of Object.entries(tpl.clientSlots)) {
              if (!Array.isArray(cSlots)) continue;
              for (const s of cSlots) {
                for (const f of (s.assignedFiles || [])) {
                  if (cid === clientId) filesOwnedByThisClient.add(f);
                  else filesUsedByOtherClients.add(f);
                }
              }
            }
            if (Array.isArray(tpl.clientSlots[clientId])) {
              tpl.clientSlots[clientId].forEach(s => {
                s.assignedFiles = [];
                s.assignedFilename = '';
              });
            }
          }
          if (Array.isArray(tpl.slots)) {
            tpl.slots.forEach(s => {
              for (const f of (s.assignedFiles || [])) filesOwnedByThisClient.add(f);
              s.assignedFiles = [];
              s.assignedFilename = '';
            });
          }
          fs.writeFileSync(SAVED_TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');

          const { dir: tplUploadDir } = getTemplateUploadDir(tpl);
          if (fs.existsSync(tplUploadDir)) {
            for (const f of fs.readdirSync(tplUploadDir)) {
              if (filesUsedByOtherClients.has(f)) continue;
              if (filesOwnedByThisClient.size === 0 || filesOwnedByThisClient.has(f)) {
                try { fs.unlinkSync(path.join(tplUploadDir, f)); } catch {}
                delete uploadsMetaCache[f];
              }
            }
          }
        }
        saveUploadsMeta();
        logToClient('Đã làm mới thư mục file nguyên liệu của mẫu hiện tại.', 'info');
        return res.json({ success: true });
      }

      const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(UPLOAD_DIR, ent.name);
        if (ent.isDirectory()) {
          for (const sf of fs.readdirSync(full)) {
            try { fs.unlinkSync(path.join(full, sf)); } catch {}
          }
        } else {
          try { fs.unlinkSync(full); } catch {}
        }
      }
      uploadsMetaCache = {};
      saveUploadsMeta();
      logToClient('Đã xóa toàn bộ danh sách video nguyên liệu.', 'info');
      return res.json({ success: true });
    }
    const base = path.basename(target);
    const found = findUploadFileOnDisk(base);
    if (found && fs.existsSync(found.fullPath)) {
      fs.unlinkSync(found.fullPath);
    }
    delete uploadsMetaCache[base];
    saveUploadsMeta();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

let latestExtensionJobFiles = null;

app.get('/api/extension/current-job', (req, res) => {
  try {
    let filesList = latestExtensionJobFiles;
    if (!filesList || filesList.length === 0) {
      const diskFiles = fs.readdirSync(UPLOAD_DIR).filter(f => /\.(mp4|mov|webm|mkv|avi|jpg|jpeg|png|webp|gif)$/i.test(f));
      filesList = diskFiles.map(filename => ({
        filename,
        originalName: filename.replace(/^\d+_\d+_/, ''),
        url: `/uploads/${encodeURIComponent(filename)}`,
        mimeType: /\.(jpg|jpeg|png|webp|gif)$/i.test(filename) ? 'image/jpeg' : 'video/mp4'
      }));
    }
    res.json({ success: true, files: filesList });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/extension/set-job', (req, res) => {
  const { clipFilenames = [] } = req.body || {};
  latestExtensionJobFiles = clipFilenames
    .filter(name => name && name !== 'KEEP_TEMPLATE_ORIGINAL')
    .map(filename => ({
      filename: path.basename(filename),
      originalName: path.basename(filename).replace(/^\d+_\d+_/, ''),
      url: `/uploads/${encodeURIComponent(path.basename(filename))}`,
      mimeType: /\.(jpg|jpeg|png|webp|gif)$/i.test(filename) ? 'image/jpeg' : 'video/mp4'
    }));
  res.json({ success: true, count: latestExtensionJobFiles.length });
});

// 9. Open persistent Chrome window to log in to CapCut Web once (Restricted to Localhost VPS Desktop)
app.post('/api/capcut/login', async (req, res) => {
  try {
    if (!isLocalRequest(req)) {
      return res.status(403).json({
        success: false,
        error: 'Chức năng đăng nhập Tài khoản CapCut chỉ được mở trực tiếp trên màn hình máy chủ VPS (localhost)!'
      });
    }
    const result = await openCapCutLoginWindow(
      (msg) => logToClient(msg, 'info'),
      (percent, status) => broadcast('progress', { percent, status })
    );
    res.json({ success: true, ...result });
  } catch (err) {
    logToClient(`Lỗi mở phiên đăng nhập: ${err.message}`, 'error');
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9b. List CapCut PC local Draft projects (draft_content.json) - Restricted to Localhost
app.get('/api/capcut-pc/drafts', async (req, res) => {
  try {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ success: false, error: 'Tính năng CapCut PC chỉ khả dụng trực tiếp trên máy chủ!' });
    }
    const data = await listCapCutPcDrafts(null);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9c. Open a CapCut template URL directly inside CapCut PC Desktop App via capcut:// deep link
app.post('/api/capcut-pc/open-template', (req, res) => {
  try {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ success: false, error: 'Tính năng CapCut PC chỉ khả dụng trực tiếp trên máy chủ!' });
    }
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'Thiếu link hoặc ID mẫu!' });
    const out = openTemplateInCapCutPcApp(url, (msg) => logToClient(msg, 'info'));
    res.json(out);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9d. Inject user media directly into CapCut PC Draft (draft_content.json)
app.post('/api/capcut-pc/inject', async (req, res) => {
  try {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ success: false, error: 'Tính năng CapCut PC chỉ khả dụng trực tiếp trên máy chủ!' });
    }
    const { folderPath, clipFilenames = [], textOverrides = {}, autoLaunchCapCut = true } = req.body || {};
    const validPaths = clipFilenames
      .filter(name => name && name !== 'KEEP_TEMPLATE_ORIGINAL')
      .map(name => path.join(UPLOAD_DIR, path.basename(name)))
      .filter(p => fs.existsSync(p));

    const result = await injectMediaIntoCapCutDraft({
      folderPath,
      userFilePaths: validPaths,
      textOverrides,
      autoLaunchCapCut,
      onLog: (msg) => logToClient(msg, 'info')
    });
    logToClient(`🎉 Đã tráo tự động ${result.replacedSlots} video/ảnh vào Project CapCut PC "${result.draftName}" (Giữ nguyên 100% hiệu ứng 3D, chuyển cảnh & chữ gốc)!`, 'success');
    res.json(result);
  } catch (err) {
    logToClient(`Lỗi tráo file vào CapCut PC: ${err.message}`, 'error');
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Auto Render Video(s) into Template (Supports Synchronized Multi-File Slot Queues & Parallel Streams!)
app.post('/api/render', async (req, res) => {
  const {
    template,
    slotQueues = null, // Array of arrays: [[slot1_file1, slot1_file2...], [slot2_file1, slot2_file2...]]
    clipFilenames = [],
    mode = 'capcut_web', // 'capcut_web' | 'auto_hybrid' | 'capcut_pc' | 'ffmpeg_clone'
    headless = false,
    effectPreset = 'flash_zoom',
    aspectRatio = '9:16',
    batchCount = 1
  } = req.body || {};

  if (!template) {
    return res.status(400).json({ success: false, error: 'Vui lòng chọn hoặc thêm mẫu CapCut trước!' });
  }

  const tplLockKey = String(template.templateId || template.title || 'default_tpl');
  if (activeRenderingTemplates.has(tplLockKey)) {
    return res.status(409).json({
      success: false,
      error: `Mẫu "${template.title || tplLockKey}" đang được chạy tạo video! Cùng một lúc mỗi mẫu chỉ cho phép 1 người chạy — vui lòng chờ mẫu này hoàn tất hoặc chọn mẫu khác.`
    });
  }

  // Case A: Synchronized Multi-File Slot Queues (e.g., 5 videos in Slot 1 + 5 images in Slot 2 -> 5 parallel pairs in exact upload order!)
  if (Array.isArray(slotQueues) && slotQueues.length > 0 && slotQueues.some(q => Array.isArray(q) && q.length > 0)) {
    const counts = slotQueues.map(q => (Array.isArray(q) ? q.length : 0));
    const expectedCount = counts[0];

    for (let sIdx = 0; sIdx < counts.length; sIdx++) {
      if (counts[sIdx] === 0) {
        return res.status(400).json({
          success: false,
          error: `Đoạn #${sIdx + 1} đang trống (0 file). Vui lòng tải đủ ${expectedCount || 1} file cho Đoạn #${sIdx + 1} để đồng bộ.`
        });
      }
      if (counts[sIdx] !== expectedCount) {
        const detailStr = counts.map((c, i) => `Đoạn #${i + 1}: ${c} file`).join(' | ');
        return res.status(400).json({
          success: false,
          error: `Số lượng file giữa các phân đoạn chưa đồng bộ (${detailStr}). Vui lòng tải số lượng file bằng nhau ở các phân đoạn.`
        });
      }
    }

    // Snapshot all input files into an isolated job directory so even if another user/machine clears uploads mid-render, this batch's files are 100% protected on disk!
    const rawClientId = getClientId(req);
    const clientId = rawClientId === 'default' ? '' : rawClientId;
    const jobSnapshotDir = path.join(__dirname, 'cache', 'render_jobs', `job_${Date.now()}_${Math.floor(Math.random() * 10000)}`);
    fs.mkdirSync(jobSnapshotDir, { recursive: true });

    activeRenderingTemplates.set(tplLockKey, {
      templateId: tplLockKey,
      title: template.title || '',
      clientId,
      percent: 12,
      status: `Đang tạo ${expectedCount} video...`,
      totalCount: expectedCount,
      startedAt: Date.now()
    });
    broadcast('template_locks', {
      lockedTemplateIds: Array.from(activeRenderingTemplates.keys()),
      activeRenders: Array.from(activeRenderingTemplates.values())
    });

    const batchFileSets = [];
    try {
      for (let pairIdx = 0; pairIdx < expectedCount; pairIdx++) {
        const pairPaths = slotQueues.map((q, sIdx) => {
          const fname = q[pairIdx];
          const resolved = findUploadFileOnDisk(fname, template);
          if (!resolved || !fs.existsSync(resolved.fullPath)) {
            throw new Error(`Không tìm thấy file "${fname}" ở Đoạn #${sIdx + 1} (Vị trí #${pairIdx + 1})`);
          }
          const snapName = `p${pairIdx + 1}_s${sIdx + 1}_${path.basename(resolved.fullPath)}`;
          const snapPath = path.join(jobSnapshotDir, snapName);
          fs.copyFileSync(resolved.fullPath, snapPath);
          return snapPath;
        });
        batchFileSets.push(pairPaths);
      }

      const isRealCapCutWebUrl = template.originalUrl &&
        template.originalUrl.includes('capcut.com') &&
        !template.originalUrl.includes('cc_trend_') &&
        !template.originalUrl.includes('cc_cinematic_') &&
        !template.originalUrl.includes('cc_flash_');
      const hasValidTemplateId = template.templateId && /^\d{10,}$/.test(String(template.templateId));
      const canRunOnWebBot = isRealCapCutWebUrl || hasValidTemplateId;

      const tplIdStr = String(template.templateId || '');
      logToClient(`🚀 Đang kích hoạt ${batchFileSets.length} luồng ghép video (tối ưu 2 luồng/lượt cho VPS, 1-1 -> ${batchFileSets.length}-${batchFileSets.length})...`, 'info');

      // Respond immediately (<100ms) so Cloudflare's 100-second HTTP proxy timeout (Error 524) NEVER interrupts the client UI!
      res.json({
        success: true,
        asyncStarted: true,
        templateId: tplIdStr,
        totalCount: expectedCount
      });

      (async () => {
        try {
          const renderedOutputs = await runCapCutWebParallelBatch({
            templateInfo: template,
            batchFileSets,
            maxConcurrency: 2,
            onLog: (msg) => logToClient(msg, 'info'),
            onProgress: (percent, status) => {
              const lockEntry = activeRenderingTemplates.get(tplLockKey);
              if (!lockEntry) return;
              if (percent > (lockEntry.percent || 0)) lockEntry.percent = percent;
              if (status) lockEntry.status = status;
              broadcast('progress', { percent, status, templateId: tplIdStr, clientId });
            },
            onScreenshot: (image, label) => broadcast('bot_screenshot', { image, label, templateId: tplIdStr, clientId }),
            onVideoReady: (outItem) => {
              outItem.templateId = tplIdStr;
              outItem.templateTitle = template.title || '';
              outItem.clientId = clientId;
              outItem.downloadUrl = `/api/download/${encodeURIComponent(outItem.filename)}`;
              registerOutputForTemplate(outItem, template);
              broadcast('single_video_ready', { output: outItem, templateId: tplIdStr, clientId });
            }
          });

          for (const out of renderedOutputs) {
            out.templateId = tplIdStr;
            out.templateTitle = template.title || '';
            out.clientId = clientId;
            out.downloadUrl = `/api/download/${encodeURIComponent(out.filename)}`;
            registerOutputForTemplate(out, template);
          }

          broadcast('render_complete', { outputs: renderedOutputs, templateId: tplIdStr, clientId });
        } catch (err) {
          if (err && err.isCancelled) {
            broadcast('render_cancelled', { templateId: tplIdStr, clientId });
          } else {
            logToClient(`Lỗi xuất song song: ${err.message}`, 'error');
            broadcast('progress', { percent: 0, status: `Lỗi: ${err.message}`, templateId: tplIdStr, clientId });
          }
        } finally {
          activeRenderingTemplates.delete(tplLockKey);
          broadcast('template_locks', {
            lockedTemplateIds: Array.from(activeRenderingTemplates.keys()),
            activeRenders: Array.from(activeRenderingTemplates.values())
          });
          try {
            fs.rmSync(jobSnapshotDir, { recursive: true, force: true });
          } catch {}
        }
      })();
      return;
    } catch (err) {
      activeRenderingTemplates.delete(tplLockKey);
      broadcast('template_locks', {
        lockedTemplateIds: Array.from(activeRenderingTemplates.keys()),
        activeRenders: Array.from(activeRenderingTemplates.values())
      });
      try {
        fs.rmSync(jobSnapshotDir, { recursive: true, force: true });
      } catch {}
      logToClient(`Lỗi khởi tạo luồng xuất: ${err.message}`, 'error');
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Case B: Legacy single-file per slot fallback
  const validPaths = clipFilenames
    .map(name => {
      if (name === 'KEEP_TEMPLATE_ORIGINAL') return 'KEEP_TEMPLATE_ORIGINAL';
      const found = findUploadFileOnDisk(name, template);
      return found ? found.fullPath : '';
    })
    .filter(p => p === 'KEEP_TEMPLATE_ORIGINAL' || (p && fs.existsSync(p)));

  if (validPaths.length === 0) {
    return res.status(400).json({ success: false, error: 'Đại ca chưa tải lên hoặc chọn video/ảnh nguyên liệu nào!' });
  }

  const totalBatches = Math.max(1, Math.min(10, parseInt(batchCount, 10) || 1));
  const renderedOutputs = [];

  try {
    for (let b = 0; b < totalBatches; b++) {
      const batchPaths = [...validPaths];
      if (b > 0) {
        for (let r = 0; r < b; r++) {
          batchPaths.push(batchPaths.shift());
        }
      }

      const isRealCapCutWebUrl = template.originalUrl &&
        template.originalUrl.includes('capcut.com') &&
        !template.originalUrl.includes('cc_trend_') &&
        !template.originalUrl.includes('cc_cinematic_') &&
        !template.originalUrl.includes('cc_flash_');

      let result = null;
      const hasValidTemplateId = template.templateId && /^\d{10,}$/.test(String(template.templateId));
      const canRunOnWebBot = isRealCapCutWebUrl || hasValidTemplateId;

      if (mode !== 'ffmpeg_clone' && canRunOnWebBot) {
        try {
          const diskOnlyPaths = batchPaths.filter(p => p !== 'KEEP_TEMPLATE_ORIGINAL');
          result = await runCapCutWebAutomation({
            templateInfo: template,
            videoFilePaths: diskOnlyPaths.length > 0 ? diskOnlyPaths : batchPaths,
            headless: Boolean(headless),
            onLog: (msg) => logToClient(msg, 'info'),
            onProgress: (percent, status) => broadcast('progress', { percent, status }),
            onScreenshot: (image, label) => broadcast('bot_screenshot', { image, label })
          });
        } catch (botErr) {
          logToClient(`Thông báo từ Bot CapCut Web: ${botErr.message}`, 'warn');
        }
      }

      if (!result) {
        result = await renderWithFfmpegEngine({
          templateInfo: template,
          videoFilePaths: batchPaths,
          effectPreset,
          aspectRatio,
          onLog: (msg) => logToClient(msg, 'info'),
          onProgress: (percent, status) => broadcast('progress', { percent, status })
        });
      }

      result.templateId = String(template.templateId || '');
      result.templateTitle = template.title || '';
      result.downloadUrl = `/api/download/${encodeURIComponent(result.filename)}`;
      registerOutputForTemplate(result, template);
      renderedOutputs.push(result);
    }

    broadcast('render_complete', { outputs: renderedOutputs });
    res.json({ success: true, outputs: renderedOutputs });
  } catch (err) {
    logToClient(`Lỗi xuất video: ${err.message}`, 'error');
    broadcast('progress', { percent: 0, status: `Lỗi: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10b. Cancel active render for a template
app.post('/api/render/cancel', async (req, res) => {
  try {
    const { templateId } = req.body || {};
    const tplLockKey = String(templateId || '').trim();
    const cancelled = await cancelCapCutRender(tplLockKey);
    if (tplLockKey) {
      activeRenderingTemplates.delete(tplLockKey);
    } else {
      activeRenderingTemplates.clear();
    }
    broadcast('template_locks', {
      lockedTemplateIds: Array.from(activeRenderingTemplates.keys()),
      activeRenders: Array.from(activeRenderingTemplates.values())
    });
    broadcast('render_cancelled', {
      templateId: tplLockKey,
      clientId: getClientId(req)
    });
    logToClient('🛑 Đã dừng quá trình tạo video theo yêu cầu.', 'warn');
    res.json({ success: true, cancelled });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. Persistent state for rendered outputs (keeps items in the list with "Đã tải" status and maps each video to its templateId!)
const OUTPUTS_STATE_FILE = path.join(CACHE_DIR, 'outputs_state.json');

function toTemplateSlug(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/^\[\d+\]\s*/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .toUpperCase();
}

function inferTemplateInfoFromFilename(filename) {
  const fname = String(filename || '');
  // Match Video_XX_<SLUG>_<HHhMM>.mp4
  const m = fname.match(/^Video_\d+_(.+)_\d{2}h\d{2}(?:_v\d+)?\.mp4$/i);
  const slug = m ? m[1].toUpperCase() : '';

  if (slug === 'THANH-TAN' || fname.includes('THANH-TAN')) {
    return { templateId: '7610024433243163920', templateTitle: '[2] THANH TÂN' };
  }
  if (slug === 'BEAT') {
    return { templateId: '7689369959943654674', templateTitle: 'BEAT' };
  }
  if (slug === 'BEAT-5-ANH-NGAU' || fname.includes('BEAT-5-ANH-NGAU')) {
    return { templateId: '7115961416414235906', templateTitle: 'BEAT 5 ẢNH NGẦU' };
  }

  const saved = loadSavedTemplates();
  for (const tpl of saved) {
    const tplSlug = toTemplateSlug(tpl.title);
    if (tplSlug && slug && tplSlug === slug) {
      return { templateId: String(tpl.templateId), templateTitle: tpl.title || '' };
    }
  }
  return { templateId: '', templateTitle: '' };
}

function migrateLegacyOutputFiles() {
  try {
    const dup5 = path.join(OUTPUT_DIR, 'capcut_cap_5_1793130368847.mp4');
    const main5 = path.join(OUTPUT_DIR, 'capcut_cap_5_1793130594625.mp4');
    if (fs.existsSync(dup5) && fs.existsSync(main5)) {
      try { fs.unlinkSync(dup5); } catch {}
    }

    const legacyFiles = fs.readdirSync(OUTPUT_DIR).filter(f => /^capcut_cap_(\d+)_\d+\.mp4$/i.test(f));
    for (const oldName of legacyFiles) {
      const m = oldName.match(/^capcut_cap_(\d+)_(\d+)\.mp4$/i);
      if (!m) continue;
      const pairStr = String(parseInt(m[1], 10)).padStart(2, '0');
      const newName = `Video_${pairStr}_THANH-TAN_02h50.mp4`;
      const oldFull = path.join(OUTPUT_DIR, oldName);
      const newFull = path.join(OUTPUT_DIR, newName);
      if (!fs.existsSync(newFull)) {
        try { fs.renameSync(oldFull, newFull); } catch {}
      }
    }

    // 1. Move any flat .mp4 files in OUTPUT_DIR into their dedicated template folder: outputs/<SLUG>_<templateId>/
    const flatMp4s = fs.readdirSync(OUTPUT_DIR).filter(f => {
      const full = path.join(OUTPUT_DIR, f);
      return f.endsWith('.mp4') && fs.statSync(full).isFile();
    });
    for (const fname of flatMp4s) {
      const inferred = inferTemplateInfoFromFilename(fname);
      if (inferred.templateId || inferred.templateTitle) {
        const { dir: tplOutDir } = getTemplateOutputDir({
          templateId: inferred.templateId,
          title: inferred.templateTitle
        });
        const oldFull = path.join(OUTPUT_DIR, fname);
        const newFull = path.join(tplOutDir, fname);
        if (!fs.existsSync(newFull)) {
          try { fs.renameSync(oldFull, newFull); } catch {}
        }
      }
    }

    // 2. Move any flat uploaded files in UPLOAD_DIR into their dedicated template folder: uploads/<SLUG>_<templateId>/
    const savedTemplates = loadSavedTemplates();
    for (const tpl of savedTemplates) {
      const { dir: tplUploadDir } = getTemplateUploadDir(tpl);
      if (Array.isArray(tpl.slots)) {
        for (const slot of tpl.slots) {
          for (const fname of (slot.assignedFiles || [])) {
            const base = path.basename(fname);
            const flatUploadPath = path.join(UPLOAD_DIR, base);
            const targetUploadPath = path.join(tplUploadDir, base);
            if (fs.existsSync(flatUploadPath) && !fs.existsSync(targetUploadPath)) {
              try { fs.renameSync(flatUploadPath, targetUploadPath); } catch {}
            }
          }
        }
      }
    }

    // 3. Deduplicate existing output folders so each Video_XX_<SLUG> only keeps the latest overwritten file on disk
    const outEntries = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true });
    for (const ent of outEntries) {
      if (!ent.isDirectory()) continue;
      const subDir = path.join(OUTPUT_DIR, ent.name);
      const mp4s = fs.readdirSync(subDir).filter(f => f.toLowerCase().endsWith('.mp4'));
      const byPair = new Map();
      for (const fname of mp4s) {
        const m = fname.match(/^Video_(\d+)_/i);
        if (!m) continue;
        const pNum = parseInt(m[1], 10);
        const full = path.join(subDir, fname);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        if (!byPair.has(pNum)) byPair.set(pNum, []);
        byPair.get(pNum).push({ fname, full, mtime });
      }
      for (const list of byPair.values()) {
        if (list.length <= 1) continue;
        list.sort((a, b) => b.mtime - a.mtime);
        for (let i = 1; i < list.length; i++) {
          try { fs.unlinkSync(list[i].full); } catch {}
        }
      }
    }
  } catch {}
}

migrateLegacyOutputFiles();

function extractPairOrder(filename) {
  const m = String(filename || '').match(/^Video_(\d+)_/i);
  return m ? parseInt(m[1], 10) : 999;
}

function extractBatchTag(filename) {
  const m = String(filename || '').match(/_(\d{2}h\d{2})(?:_v\d+)?\.mp4$/i);
  return m ? m[1] : '';
}

function loadOutputsState() {
  try {
    if (fs.existsSync(OUTPUTS_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(OUTPUTS_STATE_FILE, 'utf8')) || {};
      for (const k of Object.keys(parsed)) {
        if (/^capcut_cap_\d+_\d+\.mp4$/i.test(k)) {
          delete parsed[k];
        }
      }
      // Enrich all existing entries with templateId, templateTitle, and folderName
      for (const [fname, entry] of Object.entries(parsed)) {
        if (!entry.templateId) {
          const inferred = inferTemplateInfoFromFilename(fname);
          entry.templateId = inferred.templateId;
          entry.templateTitle = inferred.templateTitle;
        }
        if (!entry.folderName && (entry.templateId || entry.templateTitle)) {
          entry.folderName = getTemplateFolderName({
            templateId: entry.templateId,
            title: entry.templateTitle
          });
        }
      }
      // Deduplicate by (templateId, pairOrder): keep only the newest entry per Video_XX
      const newestByTplPair = new Map();
      for (const [fname, entry] of Object.entries(parsed)) {
        const pOrder = extractPairOrder(fname);
        if (pOrder === 999) continue;
        const key = `${entry.templateId || entry.folderName || ''}::${pOrder}`;
        const prev = newestByTplPair.get(key);
        if (!prev || (entry.createdAt || 0) >= (prev.entry.createdAt || 0)) {
          if (prev) delete parsed[prev.fname];
          newestByTplPair.set(key, { fname, entry });
        } else {
          delete parsed[fname];
        }
      }
      return parsed;
    }
  } catch {}
  return {};
}

let outputsState = loadOutputsState();

function saveOutputsState() {
  try {
    fs.writeFileSync(OUTPUTS_STATE_FILE, JSON.stringify(outputsState, null, 2), 'utf8');
    // Also write per-template outputs_state.json inside each template's own folder in outputs/<folderName>/
    const byFolder = {};
    for (const [fname, entry] of Object.entries(outputsState)) {
      const fName = entry.folderName || getTemplateFolderName({ templateId: entry.templateId, title: entry.templateTitle });
      if (!fName || fName === 'Default') continue;
      if (!byFolder[fName]) byFolder[fName] = {};
      byFolder[fName][fname] = entry;
    }
    for (const [fName, mapObj] of Object.entries(byFolder)) {
      const dir = path.join(OUTPUT_DIR, fName);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'outputs_state.json'), JSON.stringify(mapObj, null, 2), 'utf8');
    }
  } catch {}
}

function registerOutputForTemplate(outItem, template) {
  if (!outItem || !outItem.filename) return;
  const existing = outputsState[outItem.filename] || {};
  const tplId = String((template && template.templateId) || existing.templateId || '');
  const tplTitle = (template && template.title) || existing.templateTitle || '';
  const folderName = outItem.folderName || existing.folderName || getTemplateFolderName({ templateId: tplId, title: tplTitle });
  const newPairOrder = outItem.pairIndex || extractPairOrder(outItem.filename);
  const newSig = outItem.inputSignature || existing.inputSignature || '';

  // Overwrite any previous output entry for the same inputSignature or same pairOrder in this template
  for (const [oldFname, oldEntry] of Object.entries(outputsState)) {
    if (oldFname === outItem.filename) continue;
    const sameTpl = (tplId && String(oldEntry.templateId || '') === tplId) || (folderName && oldEntry.folderName === folderName);
    if (!sameTpl) continue;
    const sameSig = Boolean(newSig && oldEntry.inputSignature && oldEntry.inputSignature === newSig);
    const samePair = newPairOrder !== 999 && extractPairOrder(oldFname) === newPairOrder;
    if (sameSig || samePair) {
      delete outputsState[oldFname];
      if (typeof serverCleanupTimers !== 'undefined' && serverCleanupTimers.has(oldFname)) {
        clearTimeout(serverCleanupTimers.get(oldFname));
        serverCleanupTimers.delete(oldFname);
      }
      if (folderName) {
        const oldDiskPath = path.join(OUTPUT_DIR, folderName, oldFname);
        try {
          if (fs.existsSync(oldDiskPath)) fs.unlinkSync(oldDiskPath);
        } catch {}
      }
    }
  }

  outputsState[outItem.filename] = {
    filename: outItem.filename,
    templateId: tplId,
    templateTitle: tplTitle,
    folderName,
    inputSignature: newSig,
    size: outItem.size || existing.size || 0,
    createdAt: Date.now(),
    downloaded: false,
    downloadedAt: null
  };
  saveOutputsState();
}

function scanAllOutputMp4Files() {
  const foundMap = new Map();
  const entries = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith('.mp4')) {
      foundMap.set(ent.name, {
        filename: ent.name,
        folderName: '',
        fullPath: path.join(OUTPUT_DIR, ent.name),
        url: `/outputs/${ent.name}`
      });
    } else if (ent.isDirectory()) {
      const subDir = path.join(OUTPUT_DIR, ent.name);
      const subFiles = fs.readdirSync(subDir).filter(f => f.endsWith('.mp4'));
      for (const sf of subFiles) {
        foundMap.set(sf, {
          filename: sf,
          folderName: ent.name,
          fullPath: path.join(subDir, sf),
          url: `/outputs/${ent.name}/${sf}`
        });
      }
    }
  }
  return foundMap;
}

function getMergedOutputsList(filterTemplateId = null) {
  const diskFilesMap = scanAllOutputMp4Files();

  for (const [filename, diskInfo] of diskFilesMap.entries()) {
    try {
      const stat = fs.statSync(diskInfo.fullPath);
      const existing = outputsState[filename] || {};
      const inferred = existing.templateId
        ? { templateId: existing.templateId, templateTitle: existing.templateTitle || '' }
        : inferTemplateInfoFromFilename(filename);
      outputsState[filename] = {
        filename,
        templateId: inferred.templateId,
        templateTitle: inferred.templateTitle,
        folderName: diskInfo.folderName || existing.folderName || getTemplateFolderName({ templateId: inferred.templateId, title: inferred.templateTitle }),
        inputSignature: existing.inputSignature || '',
        size: stat.size,
        createdAt: existing.createdAt || stat.mtimeMs,
        downloaded: Boolean(existing.downloaded),
        downloadedAt: existing.downloadedAt || null
      };
    } catch {}
  }

  // Ensure any old entry whose Video_XX was overwritten by a newer Video_XX on disk is removed from outputsState
  const activePairsOnDisk = new Map();
  for (const [filename, diskInfo] of diskFilesMap.entries()) {
    const entry = outputsState[filename];
    const pOrder = extractPairOrder(filename);
    if (entry && pOrder !== 999) {
      const key = `${entry.templateId || diskInfo.folderName || ''}::${pOrder}`;
      activePairsOnDisk.set(key, filename);
    }
  }
  for (const [fname, entry] of Object.entries(outputsState)) {
    const pOrder = extractPairOrder(fname);
    if (pOrder !== 999) {
      const key = `${entry.templateId || entry.folderName || ''}::${pOrder}`;
      const activeFname = activePairsOnDisk.get(key);
      if (activeFname && activeFname !== fname) {
        delete outputsState[fname];
      }
    }
  }

  saveOutputsState();

  return Object.values(outputsState)
    .filter(entry => {
      if (!filterTemplateId) return true;
      return String(entry.templateId || '') === String(filterTemplateId);
    })
    .map(entry => {
      const diskInfo = diskFilesMap.get(entry.filename);
      const onServer = Boolean(diskInfo);
      return {
        filename: entry.filename,
        templateId: entry.templateId || '',
        templateTitle: entry.templateTitle || '',
        folderName: entry.folderName || (diskInfo && diskInfo.folderName) || '',
        url: onServer ? diskInfo.url : null,
        downloadUrl: onServer ? `/api/download/${encodeURIComponent(entry.filename)}` : null,
        size: entry.size,
        createdAt: entry.createdAt,
        downloaded: Boolean(entry.downloaded),
        downloadedAt: entry.downloadedAt || null,
        onServer
      };
    })
    .sort((a, b) => {
      const orderA = extractPairOrder(a.filename);
      const orderB = extractPairOrder(b.filename);
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return b.createdAt - a.createdAt;
    });
}

app.get('/api/outputs', (req, res) => {
  try {
    const filterTemplateId = req.query.templateId ? String(req.query.templateId) : null;
    const outputs = getMergedOutputsList(filterTemplateId);
    res.json({ success: true, outputs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Dedicated download route: marks as "Đã tải" without removing from the list, and keeps file on Server for 5 minutes in case re-download is needed!
const serverCleanupTimers = new Map();

function scheduleSafeServerCleanup(filePath, filename, delayMs = 5 * 60 * 1000) {
  if (serverCleanupTimers.has(filename)) {
    clearTimeout(serverCleanupTimers.get(filename));
  }
  const timer = setTimeout(() => {
    serverCleanupTimers.delete(filename);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logToClient(`🧹 Đã tự động dọn file "${filename}" trên ổ cứng Server (sau 5 phút tải xong) để giải phóng dung lượng.`, 'info');
        broadcast('output_status_changed', { filename, downloaded: true, onServer: false });
      }
    } catch {}
  }, delayMs);
  serverCleanupTimers.set(filename, timer);
}

app.get('/api/download/:filename', (req, res) => {
  const rawName = path.basename(req.params.filename || '');
  const safeFilename = rawName.toLowerCase().endsWith('.mp4') ? rawName : `${rawName}.mp4`;
  const found = findOutputFileOnDisk(rawName);

  if (!found || !fs.existsSync(found.fullPath)) {
    return res.status(404).send('File này đã được tải về máy trước đó và dọn khỏi bộ nhớ tạm của Server!');
  }

  const fullPath = found.fullPath;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  return res.download(fullPath, safeFilename, (err) => {
    if (!err && !req.aborted) {
      const statSize = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
      const prev = outputsState[rawName] || {};
      const inferred = prev.templateId
        ? { templateId: prev.templateId, templateTitle: prev.templateTitle || '' }
        : inferTemplateInfoFromFilename(rawName);
      outputsState[rawName] = {
        filename: rawName,
        templateId: inferred.templateId,
        templateTitle: inferred.templateTitle,
        folderName: found.folderName || prev.folderName || '',
        size: prev.size || statSize,
        createdAt: prev.createdAt || Date.now(),
        downloaded: true,
        downloadedAt: Date.now()
      };
      saveOutputsState();
      logToClient(`✅ Đã tải "${safeFilename}" về máy (Giữ bản dự phòng trên Server 5 phút phòng khi đại ca cần tải lại).`, 'success');
      broadcast('output_status_changed', { filename: rawName, downloaded: true, onServer: true });
      scheduleSafeServerCleanup(fullPath, rawName, 5 * 60 * 1000);
    }
  });
});

// 13. Clean downloaded files from server disk or clear history (supports per-template deletion via ?templateId=...)
app.delete('/api/outputs/:filename', (req, res) => {
  try {
    const target = req.params.filename;
    const templateId = req.query.templateId ? String(req.query.templateId) : null;

    if (target === 'DOWNLOADED_DISK') {
      let cleaned = 0;
      for (const [fname, info] of Object.entries(outputsState)) {
        if (info && info.downloaded) {
          const found = findOutputFileOnDisk(fname);
          if (found && fs.existsSync(found.fullPath)) {
            try {
              fs.unlinkSync(found.fullPath);
              cleaned++;
            } catch {}
          }
        }
      }
      logToClient(`🧹 Đã dọn ${cleaned} file MP4 (đã tải) khỏi ổ cứng Server.`, 'info');
      broadcast('output_status_changed', { filename: 'ALL' });
      return res.json({ success: true, cleaned });
    }
    if (target === 'ALL') {
      if (templateId) {
        for (const [fname, info] of Object.entries(outputsState)) {
          if (info && String(info.templateId || '') === templateId) {
            const found = findOutputFileOnDisk(fname);
            if (found && fs.existsSync(found.fullPath)) {
              try { fs.unlinkSync(found.fullPath); } catch {}
            }
            if (info.folderName) {
              const stateInFolder = path.join(OUTPUT_DIR, info.folderName, 'outputs_state.json');
              if (fs.existsSync(stateInFolder)) {
                try { fs.unlinkSync(stateInFolder); } catch {}
              }
            }
            delete outputsState[fname];
          }
        }
        saveOutputsState();
        logToClient('Đã xóa danh sách video đã tạo của mẫu hiện tại.', 'info');
        broadcast('output_status_changed', { filename: 'ALL' });
        return res.json({ success: true });
      }

      const diskFilesMap = scanAllOutputMp4Files();
      for (const diskInfo of diskFilesMap.values()) {
        try { fs.unlinkSync(diskInfo.fullPath); } catch {}
      }
      outputsState = {};
      saveOutputsState();
      broadcast('output_status_changed', { filename: 'ALL' });
      return res.json({ success: true });
    }
    const rawName = path.basename(target);
    const found = findOutputFileOnDisk(rawName);
    if (found && fs.existsSync(found.fullPath)) {
      try { fs.unlinkSync(found.fullPath); } catch {}
    }
    delete outputsState[rawName];
    saveOutputsState();
    broadcast('output_status_changed', { filename: rawName });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const os = require('os');
function getLanAddresses() {
  const results = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({ name, address: net.address });
      }
    }
  }
  return results;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LMautoedit — Hệ Thống Tạo Video Tự Động đang chạy tại:`);
  console.log(`   👉 Máy chủ (Local): http://localhost:${PORT}`);
  for (const item of getLanAddresses()) {
    console.log(`   👉 Mạng LAN (${item.name}): http://${item.address}:${PORT}`);
  }
});

// Automatically also listen on Port 80 if Port 80 is free on the VPS, so domain A-records on Hostinger/Cloudflare connect directly with zero XAMPP config!
if (Number(PORT) !== 80) {
  const server80 = http.createServer(app);
  attachWebSocketUpgrade(server80);
  server80.on('error', () => {
    // Port 80 is already in use (e.g. by XAMPP/IIS) — silently skip
  });
  server80.listen(80, '0.0.0.0', () => {
    console.log(`🌐 Đã mở tự động Cổng 80 (HTTP) trên toàn mạng LAN & Internet!`);
  });
}
