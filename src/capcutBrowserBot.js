const { chromium } = require('playwright-core');
const { exec, execFile } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, '..', 'chrome_profile');
const OUTPUT_DIR = path.join(__dirname, '..', 'outputs');
const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function execPromise(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

function probeDurationSafe(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      (err, stdout) => {
        if (err) return resolve(0);
        resolve(parseFloat(String(stdout || '').trim()) || 0);
      }
    );
  });
}

function getBatchTimeTag(dateObj = new Date()) {
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const mm = String(dateObj.getMinutes()).padStart(2, '0');
  return `${hh}h${mm}`;
}

function sanitizeTemplateSlug(title) {
  const raw = String(title || 'CapCut')
    .replace(/^\[\d+\]\s*/, '') // remove leading "[2] "
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  return raw || 'CapCut';
}

function getTemplateFolderName(templateInfo) {
  if (!templateInfo) return 'Default';
  const tplSlug = sanitizeTemplateSlug(templateInfo.title).toUpperCase();
  const tplId = String(templateInfo.templateId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return tplId ? `${tplSlug}_${tplId}` : tplSlug;
}

function getTemplateOutputDir(templateInfo) {
  const folderName = getTemplateFolderName(templateInfo);
  const dir = path.join(OUTPUT_DIR, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { folderName, dir };
}

function getPairInputSignature(pairPaths = []) {
  if (!Array.isArray(pairPaths) || pairPaths.length === 0) return '';
  return pairPaths
    .map((p) => {
      const base = path.basename(String(p || ''));
      const cleanName = base
        .replace(/^p\d+_s\d+_/i, '')
        .replace(/^(?:trim_\d+_)?(?:\d+_\d+_)?/i, '')
        .toLowerCase();
      let size = 0;
      try {
        if (fs.existsSync(p)) size = fs.statSync(p).size;
      } catch {}
      return `${cleanName}:${size}`;
    })
    .join('||');
}

function buildOutputVideoFilename(pairNum, templateInfo, batchTimeTag = null) {
  const pairStr = String(pairNum || 1).padStart(2, '0');
  const tplSlug = sanitizeTemplateSlug(templateInfo && templateInfo.title);
  const timeTag = batchTimeTag || getBatchTimeTag();
  return `Video_${pairStr}_${tplSlug}_${timeTag}.mp4`;
}

function overwritePreviousPairOutputs({ tplOutDir, outFilename, pairNum, templateInfo, inputSignature = '' }) {
  const overwritten = [];
  try {
    if (!tplOutDir || !fs.existsSync(tplOutDir)) return overwritten;
    const tplSlug = sanitizeTemplateSlug(templateInfo && templateInfo.title);
    const pairRe = new RegExp(`^Video_0*${Number(pairNum || 1)}_${tplSlug}(?:_\\d{2}h\\d{2})?(?:_v\\d+)?\\.mp4$`, 'i');

    const matchedBySig = new Set();
    if (inputSignature) {
      const localStatePath = path.join(tplOutDir, 'outputs_state.json');
      if (fs.existsSync(localStatePath)) {
        try {
          const stateMap = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) || {};
          for (const [fname, entry] of Object.entries(stateMap)) {
            if (entry && entry.inputSignature && entry.inputSignature === inputSignature) {
              matchedBySig.add(fname);
            }
          }
        } catch {}
      }
    }

    const mp4Files = fs.readdirSync(tplOutDir).filter(f => f.toLowerCase().endsWith('.mp4'));
    for (const fname of mp4Files) {
      if (fname === outFilename) continue;
      if (pairRe.test(fname) || matchedBySig.has(fname)) {
        try {
          fs.unlinkSync(path.join(tplOutDir, fname));
          overwritten.push(fname);
        } catch {}
      }
    }
  } catch {}
  return overwritten;
}

async function killProfileChromeProcesses() {
  if (process.platform !== 'win32') return;
  await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like '*capcut_video_web*chrome_profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
      ],
      () => resolve()
    );
  });
  await new Promise(r => setTimeout(r, 400));
  ensureChromeProfileAllowsMultiDownloads();
}

function ensureChromeProfileAllowsMultiDownloads() {
  try {
    const defaultDir = path.join(PROFILE_DIR, 'Default');
    if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
    const prefPath = path.join(defaultDir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(prefPath)) {
      try {
        prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8')) || {};
      } catch {
        prefs = {};
      }
    }
    if (!prefs.profile || typeof prefs.profile !== 'object') prefs.profile = {};
    if (!prefs.profile.default_content_setting_values || typeof prefs.profile.default_content_setting_values !== 'object') {
      prefs.profile.default_content_setting_values = {};
    }
    prefs.profile.default_content_setting_values.automatic_downloads = 1;

    if (!prefs.profile.content_settings || typeof prefs.profile.content_settings !== 'object') {
      prefs.profile.content_settings = {};
    }
    if (!prefs.profile.content_settings.exceptions || typeof prefs.profile.content_settings.exceptions !== 'object') {
      prefs.profile.content_settings.exceptions = {};
    }
    if (
      !prefs.profile.content_settings.exceptions.automatic_downloads ||
      typeof prefs.profile.content_settings.exceptions.automatic_downloads !== 'object'
    ) {
      prefs.profile.content_settings.exceptions.automatic_downloads = {};
    }
    const autoDlExceptions = prefs.profile.content_settings.exceptions.automatic_downloads;
    autoDlExceptions['https://www.capcut.com:443,*'] = { setting: 1 };
    autoDlExceptions['https://[*.]capcut.com:443,*'] = { setting: 1 };

    if (!prefs.download || typeof prefs.download !== 'object') prefs.download = {};
    prefs.download.prompt_for_download = false;

    fs.writeFileSync(prefPath, JSON.stringify(prefs), 'utf8');
  } catch {}
}

async function evalSafe(page, pageFunction, arg, timeoutMs = 7000, fallbackValue = null) {
  let timer = null;
  try {
    return await Promise.race([
      page.evaluate(pageFunction, arg),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('EVAL_TIMEOUT')), timeoutMs);
      })
    ]);
  } catch {
    return fallbackValue;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function enablePageMultiDownloads() {
  // Multi-download permission is configured natively in chrome_profile/Default/Preferences via ensureChromeProfileAllowsMultiDownloads().
  // Do NOT call CDP Page/Browser.setDownloadBehavior here because that overrides Playwright's internal allowAndName artifact directory!
}

function isCdpAlive() {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findChromeExecutable() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];
  return candidates.find(p => p && fs.existsSync(p)) || candidates[0];
}

/**
 * Opens the CapCut login window and automatically closes it ONLY after login has truly completed and the editor UI has finished loading!
 */
async function openCapCutLoginWindow(onLog = () => {}, onProgress = () => {}) {
  if (activeBatchCount > 0 || activeGlobalTabSlots > 0) {
    throw new Error('Hệ thống đang trong quá trình xuất video, vui lòng chờ xuất xong rồi mới mở cửa sổ Tài khoản CapCut!');
  }
  const loginUrl = 'https://www.capcut.com/editor-template?create_id=7694831529285111061';
  onLog('Đang mở cửa sổ đăng nhập tài khoản CapCut...');
  onProgress(20, 'Đang mở cửa sổ đăng nhập tài khoản CapCut...');

  if (!(await isCdpAlive())) {
    await killProfileChromeProcesses();
    const chromeExe = findChromeExecutable();
    const tr = `'${chromeExe}' --user-data-dir=${PROFILE_DIR} --remote-debugging-port=${CDP_PORT} --start-maximized --new-window ${loginUrl}`;
    await execPromise(`schtasks /Create /TN "CapCutStudioBrowser" /TR "${tr}" /SC ONCE /ST 00:00 /F`);
    await execPromise(`schtasks /Run /TN "CapCutStudioBrowser"`);
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 450));
      if (await isCdpAlive()) break;
    }
    if (!(await isCdpAlive())) {
      const { spawn } = require('child_process');
      const child = spawn(
        chromeExe,
        [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`, '--start-maximized', '--new-window', loginUrl],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await isCdpAlive()) break;
      }
    }
  }

  onLog('✅ Đã mở cửa sổ đăng nhập CapCut! Ngay khi đại ca đăng nhập xong và trang tải hoàn tất, cửa sổ sẽ tự động đóng lại.');

  // Background watcher: waits until the user completes login AND the CapCut editor finishes rendering the logged-in workspace
  (async () => {
    try {
      const browser = await chromium.connectOverCDP(CDP_URL);
      const context = browser.contexts()[0];
      if (!context) return;

      const getAuthCookies = async () => {
        const cookies = await context.cookies('https://www.capcut.com').catch(() => []);
        const sessionCookie = cookies.find(c => c.name === 'sessionid' && c.value && c.value.length > 8);
        const uidCookie = cookies.find(c => (c.name === 'uid_tt' || c.name === 'sid_tt') && c.value && c.value.length > 5);
        return {
          sessionId: sessionCookie ? sessionCookie.value : '',
          hasUid: Boolean(uidCookie)
        };
      };

      // Give initial navigation 4s to start loading
      await new Promise(r => setTimeout(r, 4000));

      let consecutiveLoggedInTicks = 0;
      let clickedSignInOnce = false;

      // Poll every 500ms
      for (let tick = 0; tick < 1200; tick++) {
        await new Promise(r => setTimeout(r, 500));
        if (!(await isCdpAlive())) break;

        const allPages = context.pages();
        if (allPages.length === 0) break;

        // 1. Check if any OAuth popup or login redirect tab is currently open
        const hasOAuthPopupOrLoginUrl = allPages.some(p => {
          const u = p.url() || '';
          return /\/login|passport|accounts\.google|tiktok\.com|facebook\.com|appleid\.apple/i.test(u);
        });

        if (hasOAuthPopupOrLoginUrl) {
          consecutiveLoggedInTicks = 0;
          continue;
        }

        const mainPage = allPages.find(p => p.url().includes('capcut.com') && !p.url().includes('/login')) || allPages[0];
        if (!mainPage || !mainPage.url().includes('capcut.com')) {
          consecutiveLoggedInTicks = 0;
          continue;
        }

        const { sessionId, hasUid } = await getAuthCookies();

        // 2. Inspect actual rendered DOM on CapCut page
        const domState = await mainPage.evaluate(() => {
          if (document.readyState !== 'complete') {
            return { isEditorLoaded: false, hasUnauthUI: true, hasLoginModalOpen: false, hasWorkspaceUI: false };
          }

          const bodyText = document.body ? (document.body.innerText || '') : '';

          // Check if the editor UI has actually finished mounting & rendering
          const visibleEls = Array.from(document.querySelectorAll('button, a, div[role="button"], span')).filter(
            el => el.offsetParent !== null
          );
          const hasExportBtn = visibleEls.some(el => /^(Export|Xuất)$/i.test((el.innerText || '').trim()));
          const hasMediaCanvas = document.querySelectorAll('video, canvas').length > 0;
          const isEditorLoaded = hasExportBtn && hasMediaCanvas;

          // Detect "Welcome to CapCut" modal or passport iframe
          const hasLoginModalText =
            /Welcome to CapCut|Chào mừng bạn đến với CapCut|Continue with Google|Tiếp tục với Google|Continue with TikTok|Tiếp tục với TikTok|Continue with Facebook|Tiếp tục với Facebook|Continue with email|Tiếp tục với email/i.test(
              bodyText
            );
          const hasLoginIframeOrModal = Boolean(
            document.querySelector(
              'iframe[src*="passport"], iframe[src*="login"], [class*="login-modal"], [class*="lv_sign_in"], [class*="sign-in"]'
            )
          );
          const hasLoginModalOpen = hasLoginModalText || hasLoginIframeOrModal;

          // Detect unauthenticated top warning banner or "Sign in" button/link
          const hasUnauthBanner =
            /aren't signed in|not be saved permanently|sign into your account|chưa đăng nhập|không được lưu vĩnh viễn/i.test(
              bodyText
            );
          const hasSignInBtn = visibleEls.some(el =>
            /^(Sign in|Log in|Đăng nhập|Sign up|Đăng ký)$/i.test((el.innerText || '').trim())
          );

          // Check for authenticated workspace indicators (e.g., "Phan Van Nam657's space", "Không gian của ...", "Renew" / "Gia hạn")
          const hasWorkspaceUI = /'s space|Không gian của|Auto upload|Tải lên tự động|Renew|Gia hạn/i.test(bodyText);

          return {
            isEditorLoaded,
            hasLoginModalOpen,
            hasUnauthUI: hasLoginModalOpen || hasUnauthBanner || hasSignInBtn,
            hasWorkspaceUI
          };
        }).catch(() => ({ isEditorLoaded: false, hasUnauthUI: true, hasLoginModalOpen: false, hasWorkspaceUI: false }));

        // If editor loaded unauthenticated and the login modal isn't open yet, click "Sign in" / "Đăng nhập" once so the modal opens
        if (domState.isEditorLoaded && !domState.hasWorkspaceUI && !domState.hasLoginModalOpen && !clickedSignInOnce) {
          clickedSignInOnce = true;
          await mainPage.evaluate(() => {
            const els = Array.from(document.querySelectorAll('button, a, div[role="button"], span')).filter(
              el => el.offsetParent !== null
            );
            const signInEl = els.find(el => /^(Sign in|Log in|Đăng nhập)$/i.test((el.innerText || '').trim()));
            if (signInEl) signInEl.click();
          }).catch(() => {});
        }

        // STRICT CHECK: Only count as logged-in when:
        // 1. Auth cookies (sessionId & uid) exist
        // 2. Editor UI (Export + canvas/video) is completely rendered
        // 3. User's workspace UI ("'s space" / "Không gian của" / "Renew" / "Gia hạn") is rendered on screen
        // 4. ZERO unauthenticated banners, Sign-in buttons, or login modals exist
        if (
          sessionId &&
          hasUid &&
          domState.isEditorLoaded &&
          domState.hasWorkspaceUI &&
          !domState.hasUnauthUI
        ) {
          consecutiveLoggedInTicks++;
        } else {
          consecutiveLoggedInTicks = 0;
        }

        // Wait for 3 consecutive ticks (1.5s) after the logged-in workspace finishes rendering so Chrome commits all cookies
        if (consecutiveLoggedInTicks >= 3) {
          onLog('🎉 Đã đăng nhập CapCut thành công và tải xong không gian làm việc! Tự động đóng cửa sổ...');
          onProgress(100, 'Đã đăng nhập tài khoản CapCut thành công!');
          for (const p of context.pages()) {
            await p.close().catch(() => {});
          }
          await new Promise(r => setTimeout(r, 600));
          try { await browser.close(); } catch {}
          break;
        }
      }
    } catch {}
  })();

  return { status: 'opened' };
}

async function sendRemoteBrowserAction() {
  return { success: true };
}

async function closeCapCutLoginWindow() {
  await killProfileChromeProcesses();
  return { success: true };
}

/**
 * Fill template slots inside CapCut Web Editor using .segment-item[data-mutable-index] inputs
 */
async function fillTemplateSlotsOnEditor(editorPage, videoFilePaths, onLog = () => {}) {
  await editorPage.waitForSelector('.segment-item[data-mutable-index], .segment-item input[type="file"]', { timeout: 30000 }).catch(() => {});
  let segmentItems = editorPage.locator('.segment-item[data-mutable-index]');
  let slotCount = await segmentItems.count();

  // Auto-retry once by reloading if CapCut Web Editor took longer to unpack the template on first open
  if (slotCount === 0) {
    onLog('Đang đồng bộ lại trình dựng mẫu CapCut để nhận diện các ô phân đoạn...');
    await editorPage.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await editorPage.waitForTimeout(3500);
    await editorPage.waitForSelector('.segment-item[data-mutable-index], .segment-item input[type="file"]', { timeout: 30000 }).catch(() => {});
    segmentItems = editorPage.locator('.segment-item[data-mutable-index]');
    slotCount = await segmentItems.count();
  }

  if (slotCount === 0) {
    return 0;
  }

  onLog(`Đang tự động nhét ${videoFilePaths.length} file của đại ca vào ${slotCount} phân đoạn của mẫu (chạy ngầm 100%)...`);

  // Record the original template thumbnail URL (img.src) of EVERY slot before we touch anything
  const originalSlotImgs = await evalSafe(
    editorPage,
    (count) => {
      const urls = [];
      for (let i = 0; i < count; i++) {
        const img = document.querySelector(`.segment-item[data-mutable-index="${i}"] img`);
        urls.push(img ? img.src : '');
      }
      return urls;
    },
    slotCount,
    6000,
    []
  );

  const replaceSingleSlotVerified = async (i, fileToUse) => {
    if (!fileToUse || !fs.existsSync(fileToUse)) {
      onLog(`❌ Không tìm thấy file nguồn cho Ô #${i + 1}: ${fileToUse}`);
      return false;
    }
    const segSelector = `.segment-item[data-mutable-index="${i}"]`;
    const segInput = editorPage.locator(`${segSelector} input[type="file"]`).first();
    if (await segInput.count().catch(() => 0) === 0) return true;

    const origImgSrc = originalSlotImgs[i] || '';

    for (let retry = 1; retry <= 4; retry++) {
      if (await segInput.count().catch(() => 0) === 0) {
        return true;
      }

      if (retry > 1) {
        onLog(`🔄 Ô #${i + 1}/${slotCount} đang đồng bộ, tự động nạp lại lần ${retry}: ${path.basename(fileToUse)}...`);
        await editorPage.waitForTimeout(700);
        if (await segInput.count().catch(() => 0) === 0) return true;
      }

      await acquireSlotUploadGate();
      const setOk = await segInput.setInputFiles(fileToUse, { timeout: 7000 }).then(() => true).catch(() => false);
      if (!setOk) {
        if (await segInput.count().catch(() => 0) === 0) return true;
        continue;
      }

      // Fast poll (every 350ms) until the slot's <img> src changes OR CapCut removes input[type="file"]
      for (let waitStep = 0; waitStep < 20; waitStep++) {
        await editorPage.waitForTimeout(350);
        const curState = await evalSafe(
          editorPage,
          ({ sel, origSrc }) => {
            const el = document.querySelector(sel);
            if (!el) return { changed: false, loading: false };
            const img = el.querySelector('img');
            const curSrc = img ? img.src : '';
            const hasInput = Boolean(el.querySelector('input[type="file"]'));
            const isChanged = Boolean((curSrc && curSrc !== origSrc) || !hasInput);
            const hasLoading = Boolean(el.querySelector('[class*="loading"], [class*="spin"], [class*="progress"]'));
            return { changed: isChanged, loading: hasLoading, curSrc };
          },
          { sel: segSelector, origSrc: origImgSrc },
          4000,
          { changed: false, loading: false }
        );

        if (curState && curState.changed && !curState.loading) {
          return true;
        }
      }
    }
    return false;
  };

  let filledCount = 0;
  for (let i = 0; i < slotCount; i++) {
    const fileToUse = videoFilePaths[i % videoFilePaths.length];
    const ok = await replaceSingleSlotVerified(i, fileToUse);
    if (ok) {
      filledCount++;
      onLog(`✅ Đã tự nạp & xác nhận thay thế Ô #${i + 1}/${slotCount} -> ${path.basename(fileToUse)}`);
    } else {
      onLog(`⚠️ Ô #${i + 1}/${slotCount} phản hồi chậm, sẽ kiểm tra khóa lại ngay sau đây...`);
    }
    // Short settle delay (800ms instead of 2500ms) since replaceSingleSlotVerified already confirmed replacement
    await editorPage.waitForTimeout(800);
  }

  // Final post-loop audit: re-check all slots to guarantee ZERO slots reverted to or kept the template's original image!
  for (let i = 0; i < slotCount; i++) {
    const segSelector = `.segment-item[data-mutable-index="${i}"]`;
    const origImgSrc = originalSlotImgs[i] || '';
    if (!origImgSrc) continue;

    const stillOriginal = await evalSafe(
      editorPage,
      ({ sel, origSrc }) => {
        const img = document.querySelector(`${sel} img`);
        return Boolean(img && img.src === origSrc);
      },
      { sel: segSelector, origSrc: origImgSrc },
      4000,
      false
    );

    if (stillOriginal) {
      const fileToUse = videoFilePaths[i % videoFilePaths.length];
      onLog(`🛡️ Phát hiện Ô #${i + 1}/${slotCount} vẫn còn ảnh gốc của mẫu, đang cưỡng chế nạp lại: ${path.basename(fileToUse)}...`);
      const retryOk = await replaceSingleSlotVerified(i, fileToUse);
      if (retryOk) filledCount++;
      await editorPage.waitForTimeout(800);
    }
  }

  return filledCount;
}

/**
 * Reliably opens the CapCut Export Confirm modal (#export-confirm-button) without toggling the Export menu closed,
 * using Playwright trusted clicks (with safe timeout) so Chromium records a valid user gesture for automatic downloads.
 */
async function openExportConfirmDialog(page) {
  await evalSafe(
    page,
    () => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
      for (const b of btns) {
        const t = (b.innerText || '').trim();
        if (/^(OK|Got it|Đã hiểu)$/i.test(t)) b.click();
      }
    },
    null,
    3000
  );

  for (let attempt = 1; attempt <= 45; attempt++) {
    const uiState = await evalSafe(
      page,
      () => {
        const isUsable = (el) =>
          Boolean(
            el &&
              el.offsetParent !== null &&
              !el.disabled &&
              !el.classList.contains('lv-btn-disabled') &&
              el.getAttribute('aria-disabled') !== 'true'
          );

        const visibleConfirmBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
          el => el && el.offsetParent !== null
        );
        if (visibleConfirmBtns.length > 0) {
          return visibleConfirmBtns.some(isUsable) ? 'READY_CONFIRM' : 'CONFIRM_LOADING';
        }

        const dlBtns = Array.from(document.querySelectorAll('[class*="choosePage-download-btn"] button')).filter(isUsable);
        if (dlBtns.length > 0) {
          return 'HAS_DL_MENU';
        }

        const expBtns = Array.from(document.querySelectorAll('#export-video-btn')).filter(isUsable);
        if (expBtns.length > 0) {
          return 'HAS_EXPORT_BTN';
        }

        const fallbackExpBtns = Array.from(document.querySelectorAll('button')).filter(b => {
          if (!isUsable(b) || b.id === 'export-confirm-button') return false;
          const t = (b.innerText || '').trim();
          return /^(Export|Xuất)$/i.test(t);
        });
        if (fallbackExpBtns.length > 0) {
          return 'HAS_EXPORT_BTN';
        }

        return 'WAITING';
      },
      null,
      4000,
      'WAITING'
    );

    if (uiState === 'READY_CONFIRM') {
      await page.waitForTimeout(350);
      return true;
    }

    if (uiState === 'CONFIRM_LOADING') {
      // Export settings panel is already open, waiting for CapCut to finish processing uploaded slot media
      await page.waitForTimeout(1000);
      continue;
    }

    if (uiState === 'HAS_DL_MENU') {
      await page
        .locator('[class*="choosePage-download-btn"] button:visible')
        .last()
        .click({ timeout: 2000 })
        .catch(() =>
          evalSafe(page, () => {
            const btns = Array.from(document.querySelectorAll('[class*="choosePage-download-btn"] button')).filter(
              b => b.offsetParent !== null && !b.disabled
            );
            if (btns.length > 0) btns[btns.length - 1].click();
          })
        );

      for (let w = 0; w < 10; w++) {
        await page.waitForTimeout(350);
        const confirmState = await evalSafe(
          page,
          () => {
            const cBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
              c => c && c.offsetParent !== null
            );
            if (cBtns.length === 0) return 'NONE';
            const ready = cBtns.some(
              c => !c.disabled && !c.classList.contains('lv-btn-disabled') && c.getAttribute('aria-disabled') !== 'true'
            );
            return ready ? 'READY' : 'LOADING';
          },
          null,
          3000,
          'NONE'
        );
        if (confirmState === 'READY') {
          await page.waitForTimeout(350);
          return true;
        }
        if (confirmState === 'LOADING') {
          break;
        }
      }
      continue;
    }

    if (uiState === 'HAS_EXPORT_BTN') {
      await page
        .locator('#export-video-btn:visible')
        .last()
        .click({ timeout: 2000 })
        .catch(() =>
          evalSafe(page, () => {
            const expBtns = Array.from(document.querySelectorAll('#export-video-btn')).filter(
              b => b.offsetParent !== null && !b.disabled
            );
            if (expBtns.length > 0) {
              expBtns[expBtns.length - 1].click();
              return;
            }
            const fallback = Array.from(document.querySelectorAll('button')).filter(b => {
              if (b.offsetParent === null || b.disabled || b.id === 'export-confirm-button') return false;
              return /^(Export|Xuất)$/i.test((b.innerText || '').trim());
            });
            if (fallback.length > 0) fallback[fallback.length - 1].click();
          })
        );

      // Poll up to 3.5s for the popover menu (#export-confirm-button or choosePage-download-btn) so we NEVER toggle it closed!
      for (let w = 0; w < 10; w++) {
        await page.waitForTimeout(350);
        const subState = await evalSafe(
          page,
          () => {
            const cBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
              c => c && c.offsetParent !== null
            );
            if (cBtns.length > 0) {
              const ready = cBtns.some(
                c => !c.disabled && !c.classList.contains('lv-btn-disabled') && c.getAttribute('aria-disabled') !== 'true'
              );
              return ready ? 'READY_CONFIRM' : 'CONFIRM_LOADING';
            }
            const dlBtns = Array.from(document.querySelectorAll('[class*="choosePage-download-btn"] button')).filter(
              dl => dl.offsetParent !== null && !dl.disabled
            );
            if (dlBtns.length > 0) return 'HAS_DL_MENU';
            return 'NONE';
          },
          null,
          3000,
          'NONE'
        );

        if (subState === 'READY_CONFIRM') {
          await page.waitForTimeout(350);
          return true;
        }
        if (subState === 'CONFIRM_LOADING') {
          break;
        }
        if (subState === 'HAS_DL_MENU') {
          await page
            .locator('[class*="choosePage-download-btn"] button:visible')
            .last()
            .click({ timeout: 2000 })
            .catch(() =>
              evalSafe(page, () => {
                const btns = Array.from(document.querySelectorAll('[class*="choosePage-download-btn"] button')).filter(
                  b => b.offsetParent !== null && !b.disabled
                );
                if (btns.length > 0) btns[btns.length - 1].click();
              })
            );
          for (let k = 0; k < 10; k++) {
            await page.waitForTimeout(350);
            const confirmState = await evalSafe(
              page,
              () => {
                const cBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
                  c => c && c.offsetParent !== null
                );
                if (cBtns.length === 0) return 'NONE';
                const ready = cBtns.some(
                  c => !c.disabled && !c.classList.contains('lv-btn-disabled') && c.getAttribute('aria-disabled') !== 'true'
                );
                return ready ? 'READY' : 'LOADING';
              },
              null,
              3000,
              'NONE'
            );
            if (confirmState === 'READY') {
              await page.waitForTimeout(350);
              return true;
            }
            if (confirmState === 'LOADING') {
              break;
            }
          }
          break;
        }
      }
      continue;
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

/**
 * Triggers #export-confirm-button, tracks progress without premature Download-button spam,
 * and auto-recovers if Chromium interrupts the first download stream.
 */
async function triggerExportAndSaveDownload({
  page,
  outPath,
  tag = '',
  onLog = () => {},
  onRenderPercent = () => {},
  onTick = null
}) {
  await enablePageMultiDownloads(page);

  let activeDownloadEvents = 0;
  const onDownloadListener = () => {
    activeDownloadEvents++;
  };
  page.on('download', onDownloadListener);

  let downloadPromise = page.waitForEvent('download', { timeout: 240000 });

  const clickConfirmBtn = async () => {
    await acquireExportSubmitGate();
    await page
      .locator('#export-confirm-button:visible')
      .last()
      .click({ timeout: 2500 })
      .catch(() => {});
    await evalSafe(page, () => {
      const btns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
        btn => btn.offsetParent !== null && !btn.disabled && !btn.classList.contains('lv-btn-disabled')
      );
      if (btns.length > 0) btns[btns.length - 1].click();
    });
  };

  // Trusted click on #export-confirm-button so Chrome registers transient user activation
  await clickConfirmBtn();

  let completionBtnSeenTicks = 0;
  let confirmStillVisibleTicks = 0;
  let idleNotExportingTicks = 0;
  let hasStartedExporting = false;
  let isPollingBusy = false;

  const pollTimer = setInterval(async () => {
    if (isPollingBusy || activeDownloadEvents > 0) return;
    isPollingBusy = true;
    try {
      const state = await evalSafe(
        page,
        () => {
          const bodyText = document.body ? (document.body.innerText || '') : '';
          // IMPORTANT: Only match actual Export progress text, NEVER standalone percentages like editor zoom (50%/100%)!
          const m = bodyText.match(/(?:Exporting|Đang xuất|Rendering|Đang kết xuất)[^%\d\n\r]{0,25}(\d{1,3})%/i);
          const pctStr = m ? `${m[1]}%` : null;
          const confirmBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
            c => c.offsetParent !== null && !c.disabled && !c.classList.contains('lv-btn-disabled')
          );
          const hasConfirm = confirmBtns.length > 0;
          const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
          const hasManualDlBtn = btns.some(b => {
            const t = (b.innerText || '').trim();
            return (t === 'Download' || t === 'Tải xuống') && b.id !== 'export-confirm-button';
          });
          return { pctStr, hasConfirm, hasManualDlBtn };
        },
        null,
        3500,
        null
      );

      if (!state) return;

      if (state.pctStr) {
        hasStartedExporting = true;
        confirmStillVisibleTicks = 0;
        idleNotExportingTicks = 0;
        onRenderPercent(state.pctStr);
      } else if (state.hasConfirm && activeDownloadEvents === 0) {
        // Wait 2 consecutive ticks (~6s) before re-clicking #export-confirm-button so we never send duplicate export requests
        idleNotExportingTicks = 0;
        confirmStillVisibleTicks++;
        if (confirmStillVisibleTicks >= 2) {
          confirmStillVisibleTicks = 0;
          await clickConfirmBtn();
        }
      } else if (!state.hasManualDlBtn && !hasStartedExporting && activeDownloadEvents === 0) {
        confirmStillVisibleTicks = 0;
        idleNotExportingTicks++;
        if (idleNotExportingTicks >= 3) {
          idleNotExportingTicks = 0;
          const readyAgain = await openExportConfirmDialog(page);
          if (readyAgain) {
            await clickConfirmBtn();
          }
        }
      }

      // Only click the manual "Download" / "Tải xuống" button if CapCut's built-in auto-download hasn't fired after 2 poll ticks (~6s)
      if (state.hasManualDlBtn && activeDownloadEvents === 0) {
        hasStartedExporting = true;
        idleNotExportingTicks = 0;
        completionBtnSeenTicks++;
        if (completionBtnSeenTicks >= 2) {
          completionBtnSeenTicks = 0;
          await page
            .locator('button:has-text("Download"), button:has-text("Tải xuống")')
            .first()
            .click({ timeout: 2000 })
            .catch(() =>
              evalSafe(page, () => {
                const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                for (const b of btns) {
                  const t = (b.innerText || '').trim();
                  if ((t === 'Download' || t === 'Tải xuống') && b.id !== 'export-confirm-button') {
                    b.click();
                    break;
                  }
                }
              })
            );
        }
      } else {
        completionBtnSeenTicks = 0;
      }

      if (onTick) await onTick(state.pctStr);
    } catch {} finally {
      isPollingBusy = false;
    }
  }, 3000);

  try {
    for (let dlAttempt = 1; dlAttempt <= 3; dlAttempt++) {
      try {
        const download = await downloadPromise;
        clearInterval(pollTimer);
        await download.saveAs(outPath);
        return;
      } catch (dlErr) {
        if (dlAttempt >= 3) {
          clearInterval(pollTimer);
          throw dlErr;
        }
        onLog(`🔄 ${tag} Luồng tải tự động bị ngắt (${dlErr.message}), đang tự động tải lại ngay (Lần ${dlAttempt + 1}/3)...`);
        await enablePageMultiDownloads(page);
        await page.waitForTimeout(800);
        downloadPromise = page.waitForEvent('download', { timeout: 90000 });
        const hasManualDl = await evalSafe(
          page,
          () => {
            const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
            return btns.some(b => {
              const t = (b.innerText || '').trim();
              return (t === 'Download' || t === 'Tải xuống') && b.id !== 'export-confirm-button';
            });
          },
          null,
          3000,
          false
        );
        if (hasManualDl) {
          await page
            .locator('button:has-text("Download"), button:has-text("Tải xuống")')
            .first()
            .click({ timeout: 3000 })
            .catch(() =>
              evalSafe(page, () => {
                const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                for (const b of btns) {
                  const t = (b.innerText || '').trim();
                  if ((t === 'Download' || t === 'Tải xuống') && b.id !== 'export-confirm-button') {
                    b.click();
                    break;
                  }
                }
              })
            );
        } else {
          hasStartedExporting = false;
          const reopened = await openExportConfirmDialog(page);
          if (reopened) {
            await clickConfirmBtn();
          }
        }
      }
    }
  } finally {
    clearInterval(pollTimer);
    page.removeListener('download', onDownloadListener);
  }
}

/**
 * Run 100% SILENT / INVISIBLE background CapCut Web Template filling and exporting!
 * Never pops up any Chrome window on the user's screen!
 */
async function runCapCutWebAutomation({
  templateInfo,
  videoFilePaths,
  onLog = () => {},
  onProgress = () => {},
  onScreenshot = () => {}
}) {
  // Ensure no leftover visible Chrome process is locking PROFILE_DIR
  await killProfileChromeProcesses();

  let targetEditorUrl = `https://www.capcut.com/editor-template?create_id=7694831529285111061&enter_from=main_btn&from_page=towards_page_template_reflux`;
  if (templateInfo.templateId && /^\d{10,}$/.test(String(templateInfo.templateId))) {
    targetEditorUrl = `https://www.capcut.com/editor-template?create_id=${templateInfo.templateId}&enter_from=main_btn&from_page=towards_page_template_reflux`;
  } else if (templateInfo.editorUrl) {
    targetEditorUrl = templateInfo.editorUrl;
  }

  onLog('🤖 Đang khởi chạy Engine CapCut Ngầm (100% chạy ẩn, không bật cửa sổ làm phiền đại ca)...');
  onProgress(15, 'Đang tải mẫu CapCut ngầm...');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection'
    ]
  });

  const snap = async (page, label) => {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 3000 });
      onScreenshot(`data:image/jpeg;base64,${buf.toString('base64')}`, label);
    } catch {}
  };

  try {
    const editorPage = context.pages()[0] || await context.newPage();
    await enablePageMultiDownloads(editorPage);

    await editorPage.goto(targetEditorUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await editorPage.waitForSelector('.segment-item[data-mutable-index], .segment-item input[type="file"]', { timeout: 30000 }).catch(() => {});
    await editorPage.waitForTimeout(1500);
    await snap(editorPage, 'Đang mở mẫu ngầm');

    // Step 1: Fill each slot via .segment-item[data-mutable-index="i"] input[type="file"]
    onProgress(40, 'Đang tự động nhét Video & Ảnh vào từng ô của mẫu...');
    const filledCount = await fillTemplateSlotsOnEditor(editorPage, videoFilePaths, onLog);

    if (filledCount === 0) {
      throw new Error('Không tìm thấy các ô phân đoạn của mẫu trên CapCut.');
    }

    await editorPage.waitForTimeout(800);
    await snap(editorPage, `Đã nhét ${filledCount} file vào mẫu (kèm chữ & hiệu ứng gốc)`);

    // Step 2: Open Export Confirm Dialog
    onLog('Đang áp hiệu ứng chuyển cảnh + chữ gốc của mẫu và chuẩn bị kết xuất MP4...');
    onProgress(65, 'Đang đồng bộ hiệu ứng gốc của mẫu...');

    const exportReady = await openExportConfirmDialog(editorPage);
    if (!exportReady) {
      throw new Error('Nút xuất video trên CapCut chưa sẵn sàng.');
    }

    await snap(editorPage, 'Đang kết xuất video MP4 gốc');
    onLog('Đang kết xuất (Render) video MP4 với 100% chữ, lời bài hát & chuyển cảnh 3D gốc...');
    onProgress(80, 'Đang render video gốc (0% -> 100%)...');

    const { folderName, dir: tplOutDir } = getTemplateOutputDir(templateInfo);
    const outFilename = buildOutputVideoFilename(1, templateInfo);
    const outPath = path.join(tplOutDir, outFilename);

    await triggerExportAndSaveDownload({
      page: editorPage,
      outPath,
      tag: '[Luồng Đơn]',
      onLog,
      onRenderPercent: (pctInfo) => {
        onProgress(88, `Đang kết xuất video gốc: ${pctInfo}...`);
      },
      onTick: async (pctInfo) => {
        await snap(editorPage, `Đang kết xuất video gốc ${pctInfo || ''}`);
      }
    });

    // Strict safety check: verify the MP4 file exists on disk, has valid size (>200KB), and is playable via ffprobe BEFORE deleting Cloud cache!
    const fileSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    const durationSec = await probeDurationSafe(outPath);
    const inputSignature = getPairInputSignature(videoFilePaths);

    if (fileSize > 200 * 1024 && durationSec > 0.5) {
      overwritePreviousPairOutputs({
        tplOutDir,
        outFilename,
        pairNum: 1,
        templateInfo,
        inputSignature
      });
      onProgress(98, 'Đã kiểm tra file MP4 an toàn 100%, đang dọn rác bộ nhớ đám mây CapCut Space...');
      await cleanupCapCutCloudSpace(editorPage, onLog).catch(() => {});
    } else {
      onLog('⚠️ File tải về chưa hoàn chỉnh, hệ thống GIỮ NGUYÊN bản gốc trên Cloud CapCut để không bị mất video!');
    }

    onProgress(100, 'Hoàn tất xuất video chuẩn 100% mẫu CapCut!');
    onLog(`🎉 Đã xuất ngầm thành công video gốc (đầy đủ chữ & hiệu ứng): ${folderName}/${outFilename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

    await context.close();
    return {
      success: true,
      engine: 'capcut_web_playwright',
      folderName,
      filename: outFilename,
      inputSignature,
      url: `/outputs/${folderName}/${outFilename}`,
      downloadUrl: `/api/download/${encodeURIComponent(outFilename)}`,
      filePath: outPath,
      size: fileSize
    };
  } catch (err) {
    try { await context.close(); } catch {}
    throw err;
  }
}

const GLOBAL_MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10) || 4;
let sharedBrowserContext = null;
let sharedContextLaunchPromise = null;
let activeBatchCount = 0;
let activeGlobalTabSlots = 0;
let nextBatchSeq = 1;
let lastServedBatchId = 0;
const globalSlotWaitQueue = [];
const activeRenderControllers = new Map();

async function cancelCapCutRender(templateId = '') {
  const targetKey = String(templateId || '').trim();
  const controllersToCancel = [];
  if (targetKey && activeRenderControllers.has(targetKey)) {
    controllersToCancel.push(activeRenderControllers.get(targetKey));
    activeRenderControllers.delete(targetKey);
  } else {
    for (const [k, ctrl] of activeRenderControllers.entries()) {
      if (!targetKey || k.includes(targetKey) || String(ctrl.templateId || '') === targetKey) {
        controllersToCancel.push(ctrl);
        activeRenderControllers.delete(k);
      }
    }
  }

  for (const ctrl of controllersToCancel) {
    ctrl.cancelled = true;
    // Wake up any workers waiting in globalSlotWaitQueue for this batch
    for (let i = globalSlotWaitQueue.length - 1; i >= 0; i--) {
      if (globalSlotWaitQueue[i].batchId === ctrl.batchId) {
        const [removed] = globalSlotWaitQueue.splice(i, 1);
        activeGlobalTabSlots++;
        removed.resolve();
      }
    }
    // Close all active pages of this batch immediately
    for (const p of Array.from(ctrl.pages || [])) {
      try {
        await p.close();
      } catch {}
    }
    ctrl.pages.clear();
  }

  return controllersToCancel.length > 0;
}

async function acquireGlobalTabSlot(batchId = 0) {
  if (activeGlobalTabSlots < GLOBAL_MAX_CONCURRENCY) {
    activeGlobalTabSlots++;
    lastServedBatchId = batchId;
    return;
  }
  await new Promise(resolve => globalSlotWaitQueue.push({ batchId, resolve }));
}

function releaseGlobalTabSlot() {
  if (globalSlotWaitQueue.length > 0) {
    // Round-Robin selection across batches so Machine 1 and Machine 2 get interleaved 50/50 tab slots!
    let pickIdx = globalSlotWaitQueue.findIndex(item => item.batchId !== lastServedBatchId);
    if (pickIdx === -1) pickIdx = 0;
    const [picked] = globalSlotWaitQueue.splice(pickIdx, 1);
    lastServedBatchId = picked.batchId;
    picked.resolve();
  } else {
    activeGlobalTabSlots = Math.max(0, activeGlobalTabSlots - 1);
  }
}

let lastEditorOpenAt = 0;
let editorOpenChain = Promise.resolve();
const EDITOR_OPEN_GAP_MS = 2000;

function acquireEditorOpenGate() {
  const next = editorOpenChain.then(async () => {
    const targetGap = EDITOR_OPEN_GAP_MS + Math.floor(Math.random() * 650);
    const elapsed = Date.now() - lastEditorOpenAt;
    if (elapsed < targetGap) {
      await new Promise(r => setTimeout(r, targetGap - elapsed));
    }
    lastEditorOpenAt = Date.now();
  });
  editorOpenChain = next.catch(() => {});
  return next;
}

let lastSlotUploadAt = 0;
let slotUploadChain = Promise.resolve();
const SLOT_UPLOAD_GAP_MS = 650;

function acquireSlotUploadGate() {
  const next = slotUploadChain.then(async () => {
    const targetGap = SLOT_UPLOAD_GAP_MS + Math.floor(Math.random() * 450);
    const elapsed = Date.now() - lastSlotUploadAt;
    if (elapsed < targetGap) {
      await new Promise(r => setTimeout(r, targetGap - elapsed));
    }
    lastSlotUploadAt = Date.now();
  });
  slotUploadChain = next.catch(() => {});
  return next;
}

let lastExportSubmitAt = 0;
let exportSubmitChain = Promise.resolve();
const EXPORT_SUBMIT_GAP_MS = 4200;

function acquireExportSubmitGate() {
  const next = exportSubmitChain.then(async () => {
    const targetGap = EXPORT_SUBMIT_GAP_MS + Math.floor(Math.random() * 800);
    const elapsed = Date.now() - lastExportSubmitAt;
    if (elapsed < targetGap) {
      await new Promise(r => setTimeout(r, targetGap - elapsed));
    }
    lastExportSubmitAt = Date.now();
  });
  exportSubmitChain = next.catch(() => {});
  return next;
}

async function getHealthySharedContext() {
  if (sharedBrowserContext) {
    try {
      sharedBrowserContext.pages();
      return sharedBrowserContext;
    } catch {
      sharedBrowserContext = null;
    }
  }
  if (!sharedContextLaunchPromise) {
    sharedContextLaunchPromise = (async () => {
      await killProfileChromeProcesses();
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1280, height: 720 },
        acceptDownloads: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--enable-webgl',
          '--ignore-gpu-blocklist',
          '--use-gl=angle',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-ipc-flooding-protection'
        ]
      });

      // Prevent CapCut's BroadcastChannel("capcut-business-tabs-v1"), storage events, and page visibility from detecting multiple open editor tabs
      await ctx.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
          const OrigBC = window.BroadcastChannel;
          if (OrigBC) {
            window.BroadcastChannel = class extends OrigBC {
              constructor(name) {
                super(name);
                this._isCapcutTabProbe = String(name || '').includes('capcut-business-tabs');
              }
              postMessage(msg) {
                if (this._isCapcutTabProbe) return;
                return super.postMessage(msg);
              }
              addEventListener(type, listener, options) {
                if (this._isCapcutTabProbe && type === 'message') return;
                return super.addEventListener(type, listener, options);
              }
            };
          }
          const origAddEventListener = window.addEventListener;
          window.addEventListener = function (type, listener, options) {
            if (type === 'visibilitychange' || type === 'blur') return;
            return origAddEventListener.call(this, type, listener, options);
          };
        } catch {}
      }).catch(() => {});

      ctx.on('close', () => {
        if (sharedBrowserContext === ctx) {
          sharedBrowserContext = null;
        }
      });
      await new Promise(r => setTimeout(r, 600));
      sharedBrowserContext = ctx;
      return ctx;
    })().finally(() => {
      sharedContextLaunchPromise = null;
    });
  }
  return sharedContextLaunchPromise;
}

async function acquireSharedBrowserContext() {
  activeBatchCount++;
  return getHealthySharedContext();
}

async function releaseSharedBrowserContext(allVerified, onLog) {
  activeBatchCount = Math.max(0, activeBatchCount - 1);
  if (activeBatchCount > 0 || !sharedBrowserContext) {
    return;
  }
  const ctxToClose = sharedBrowserContext;
  sharedBrowserContext = null;
  (async () => {
    try {
      const capcutPage = ctxToClose.pages().find(p => p.url().includes('capcut.com')) || ctxToClose.pages()[ctxToClose.pages().length - 1];
      if (capcutPage) {
        await cleanupCapCutCloudSpace(capcutPage, onLog).catch(() => {});
      }
    } catch {} finally {
      try { await ctxToClose.close(); } catch {}
    }
  })();
}

/**
 * Run N paired jobs IN PARALLEL across multiple non-throttled tabs inside our shared persistent Chrome profile!
 * Cleans up CapCut Cloud Space ONLY ONCE at the very end after all active batches have safely downloaded and verified their MP4 files.
 */
async function runCapCutWebParallelBatch({
  templateInfo,
  batchFileSets = [],
  maxConcurrency = 4,
  onLog = () => {},
  onProgress = () => {},
  onScreenshot = () => {},
  onVideoReady = () => {}
}) {
  if (!batchFileSets || batchFileSets.length === 0) {
    throw new Error('Không có cặp file nào để chạy song song!');
  }

  let targetEditorUrl = `https://www.capcut.com/editor-template?create_id=7694831529285111061&enter_from=main_btn&from_page=towards_page_template_reflux`;
  if (templateInfo.templateId && /^\d{10,}$/.test(String(templateInfo.templateId))) {
    targetEditorUrl = `https://www.capcut.com/editor-template?create_id=${templateInfo.templateId}&enter_from=main_btn&from_page=towards_page_template_reflux`;
  } else if (templateInfo.editorUrl) {
    targetEditorUrl = templateInfo.editorUrl;
  }

  const batchId = nextBatchSeq++;
  const tplLockKey = String((templateInfo && (templateInfo.templateId || templateInfo.title)) || 'default_tpl');
  const controller = {
    batchId,
    templateId: String((templateInfo && templateInfo.templateId) || ''),
    cancelled: false,
    pages: new Set()
  };
  activeRenderControllers.set(tplLockKey, controller);

  const totalJobs = batchFileSets.length;
  const concurrency = Math.max(1, Math.min(maxConcurrency, totalJobs));
  const { dir: initTplOutDir } = getTemplateOutputDir(templateInfo);
  const initTplSlug = sanitizeTemplateSlug(templateInfo && templateInfo.title);
  let existingCountAtStart = 0;
  try {
    if (fs.existsSync(initTplOutDir)) {
      const existingMp4s = fs.readdirSync(initTplOutDir).filter(f => f.toLowerCase().endsWith('.mp4'));
      for (let i = 1; i <= totalJobs; i++) {
        const re = new RegExp(`^Video_0*${i}_${initTplSlug}(?:_\\d{2}h\\d{2})?(?:_v\\d+)?\\.mp4$`, 'i');
        if (existingMp4s.some(f => re.test(f))) existingCountAtStart++;
      }
    }
  } catch {}
  if (existingCountAtStart > 0) {
    onLog(`Đang tạo lại và ghi đè ${existingCountAtStart} video cũ...`);
  }
  onLog(`Đang chạy ${totalJobs} luồng ghép video (Cặp #1 -> #${totalJobs})...`);
  onProgress(12, `Đang tạo ${totalJobs} video...`);

  await acquireSharedBrowserContext();

  const results = new Array(totalJobs).fill(null);
  const jobProgress = new Array(totalJobs).fill(0);
  const batchTimeTag = getBatchTimeTag();
  let completedCount = 0;
  let allVerified = true;
  let highestProgress = 12;

  const emitMonotonicProgress = (statusText) => {
    if (controller.cancelled) return;
    const avgJobPct = jobProgress.reduce((sum, p) => sum + p, 0) / totalJobs;
    const rawPct = Math.min(99, 12 + Math.round(avgJobPct * 0.87));
    if (rawPct > highestProgress) {
      highestProgress = rawPct;
    }
    onProgress(highestProgress, statusText);
  };

  const runSingleTabWorker = async (jobIdx) => {
    if (controller.cancelled) return null;
    const pairNum = jobIdx + 1;
    const fileSet = batchFileSets[jobIdx];
    const tag = `[Luồng #${pairNum}/${totalJobs}]`;

    // Launch first 2 tabs immediately (350ms apart); stagger tabs 3..4 by 1.8s so a 2nd machine clicking within a few seconds immediately gets 2 parallel slots (2+2 = 4)!
    if (jobIdx < 2) {
      await new Promise(r => setTimeout(r, jobIdx * 350));
    } else {
      await new Promise(r => setTimeout(r, 1200 + (jobIdx - 1) * 1800));
    }
    if (controller.cancelled) return null;
    await acquireGlobalTabSlot(batchId);

    try {
      if (controller.cancelled) return null;
      for (let workerTry = 1; workerTry <= 2; workerTry++) {
        if (controller.cancelled) return null;
        let page = null;
        let watchdogTimer = null;
        try {
          const activeCtx = await getHealthySharedContext();
          if (controller.cancelled) return null;
          page = await activeCtx.newPage();
          if (controller.cancelled) {
            try { await page.close(); } catch {}
            return null;
          }
          controller.pages.add(page);

          const executeAttempt = async () => {
            await enablePageMultiDownloads(page);

            jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 10);
            emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);
            onLog(
              `${tag} ${workerTry > 1 ? '[Thử lại] ' : ''}Đang mở mẫu và nạp cặp file #${pairNum}: ${fileSet
                .map(f => path.basename(f).replace(/^p\d+_s\d+_/, '').replace(/^\d+_\d+_/, ''))
                .join(' + ')}...`
            );
            await acquireEditorOpenGate();
            if (controller.cancelled) throw new Error('RENDER_CANCELLED');
            await page.goto(targetEditorUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });
            if (controller.cancelled) throw new Error('RENDER_CANCELLED');
            await page.waitForSelector('.segment-item[data-mutable-index], .segment-item input[type="file"]', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1200);
            if (controller.cancelled) throw new Error('RENDER_CANCELLED');

            const filledCount = await fillTemplateSlotsOnEditor(page, fileSet, (m) => {
              if (!controller.cancelled) onLog(`${tag} ${m}`);
            });
            if (controller.cancelled) throw new Error('RENDER_CANCELLED');
            if (filledCount === 0) {
              throw new Error(`${tag} Không tìm thấy các ô phân đoạn của mẫu.`);
            }

            jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 25);
            emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);

            await page.waitForTimeout(600);
            if (controller.cancelled) throw new Error('RENDER_CANCELLED');

            const exportDialogReady = await openExportConfirmDialog(page);
            if (controller.cancelled) throw new Error('RENDER_CANCELLED');
            if (!exportDialogReady) {
              throw new Error(`${tag} Nút xuất video trên CapCut chưa sẵn sàng (có thể do 1 phân đoạn chưa tải xong).`);
            }

            jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 30);
            emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);
            onLog(`${tag} Đang kết xuất (Render) MP4 song song...`);

            const { folderName, dir: tplOutDir } = getTemplateOutputDir(templateInfo);
            const outFilename = buildOutputVideoFilename(pairNum, templateInfo, batchTimeTag);
            const outPath = path.join(tplOutDir, outFilename);

            await triggerExportAndSaveDownload({
              page,
              outPath,
              tag,
              onLog: (m) => {
                if (!controller.cancelled) onLog(m);
              },
              onRenderPercent: (pctInfo) => {
                if (controller.cancelled) return;
                const numMatch = pctInfo.match(/(\d{1,3})/);
                if (numMatch) {
                  const renderPct = Math.min(100, parseInt(numMatch[1], 10));
                  jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 30 + Math.round(renderPct * 0.65));
                }
                emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);
              }
            });
            if (controller.cancelled) throw new Error('RENDER_CANCELLED');

            const fileSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
            const inputSignature = getPairInputSignature(fileSet);
            let overwrittenList = [];
            if (fileSize > 200 * 1024) {
              overwrittenList = overwritePreviousPairOutputs({
                tplOutDir,
                outFilename,
                pairNum,
                templateInfo,
                inputSignature
              });
            }

            completedCount++;
            jobProgress[jobIdx] = 100;
            const outItem = {
              success: true,
              pairIndex: pairNum,
              inputSignature,
              overwritten: overwrittenList.length > 0,
              engine: 'capcut_web_parallel',
              folderName,
              filename: outFilename,
              url: `/outputs/${folderName}/${outFilename}`,
              downloadUrl: `/api/download/${encodeURIComponent(outFilename)}`,
              filePath: outPath,
              size: fileSize
            };
            results[jobIdx] = outItem;

            emitMonotonicProgress(`Đã tạo xong ${completedCount}/${totalJobs} video (${outFilename})`);
            if (overwrittenList.length > 0) {
              onLog(`${tag} Đã ghi đè Video #${pairNum}: ${outFilename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
            } else {
              onLog(`${tag} Đã tạo xong Video #${pairNum}: ${outFilename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
            }
            try { onVideoReady(outItem); } catch {}

            const durationSec = await probeDurationSafe(outPath);
            if (!(fileSize > 200 * 1024 && durationSec > 0.5)) {
              allVerified = false;
              onLog(`⚠️ ${tag} File tải về chưa đạt kiểm tra dung lượng/thời lượng, sẽ giữ nguyên Cloud!`);
            }
          };

          await Promise.race([
            executeAttempt(),
            new Promise((_, reject) => {
              watchdogTimer = setTimeout(() => {
                reject(new Error(`${tag} Quá thời gian xử lý luồng (300s)`));
              }, 300000);
            })
          ]);

          if (watchdogTimer) clearTimeout(watchdogTimer);
          if (page) controller.pages.delete(page);
          const isLastSurvivor = (jobIdx === totalJobs - 1) && (activeBatchCount === 1);
          if (!isLastSurvivor && page) {
            try { await page.close(); } catch {}
          }
          return results[jobIdx];
        } catch (err) {
          if (watchdogTimer) clearTimeout(watchdogTimer);
          if (page) {
            controller.pages.delete(page);
            try { await page.close(); } catch {}
          }
          if (controller.cancelled || (err && err.message === 'RENDER_CANCELLED')) {
            return null;
          }
          if (workerTry < 2) {
            onLog(`🔄 ${tag} Gặp sự cố (${err.message}), đang tự động khởi tạo lại tab mới để xuất lại Video #${pairNum}...`);
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          allVerified = false;
          onLog(`❌ ${tag} Lỗi: ${err.message}`);
          return null;
        }
      }
    } finally {
      releaseGlobalTabSlot();
    }
  };

  try {
    let nextJobIdx = 0;
    const workerPool = Array.from({ length: concurrency }, async () => {
      while (nextJobIdx < totalJobs && !controller.cancelled) {
        const myIdx = nextJobIdx++;
        await runSingleTabWorker(myIdx);
      }
    });
    await Promise.all(workerPool);

    if (activeRenderControllers.get(tplLockKey) === controller) {
      activeRenderControllers.delete(tplLockKey);
    }

    if (controller.cancelled) {
      await releaseSharedBrowserContext(false, onLog);
      const cancelErr = new Error('Đã dừng quá trình tạo video.');
      cancelErr.isCancelled = true;
      throw cancelErr;
    }

    onProgress(100, `Hoàn tất tạo ${totalJobs} video!`);
    const finalOutputs = results.filter(Boolean);

    await releaseSharedBrowserContext(allVerified, onLog);
    return finalOutputs;
  } catch (err) {
    if (activeRenderControllers.get(tplLockKey) === controller) {
      activeRenderControllers.delete(tplLockKey);
    }
    await releaseSharedBrowserContext(false, onLog);
    throw err;
  }
}

/**
 * Automatically delete temporary uploaded media, drafts, and rendered tasks from CapCut Cloud Space
 * right after downloading the MP4 so Cloud Space remains at 0 MB forever!
 */
async function cleanupCapCutCloudSpace(page, onLog = () => {}) {
  const makeSign = (pathname) => {
    const dt = Math.floor(Date.now() / 1000);
    const sign = crypto.createHash('md5').update(`9e2c|${pathname.slice(-7)}|7|5.8.0|${dt}||11ac`).digest('hex');
    return { dt: String(dt), sign };
  };

  const sWs = makeSign('/cc/v1/workspace/get_user_workspaces');
  const sQuery = makeSign('/lv/v1/asset/query');
  const sDel = makeSign('/lv/v1/asset/delete');
  const sRecycleList = makeSign('/lv/v1/recycle/list');
  const sRecycleDel = makeSign('/lv/v1/recycle/delete');

  const cleanupResult = await page.evaluate(async ({ sWs, sQuery, sDel, sRecycleList, sRecycleDel }) => {
    const makeHeaders = (s) => ({
      'content-type': 'application/json',
      'appid': '348188',
      'pf': '7',
      'appvr': '5.8.0',
      'sign-ver': '1',
      'device-time': s.dt,
      'sign': s.sign
    });

    const wsRes = await fetch('https://edit-api-sg.capcut.com/cc/v1/workspace/get_user_workspaces', {
      method: 'POST',
      credentials: 'include',
      headers: makeHeaders(sWs),
      body: JSON.stringify({ cursor: '0', count: 20, need_convert_workspace: true })
    }).then(r => r.json()).catch(() => null);

    const ws = wsRes && wsRes.data && wsRes.data.workspace_infos && wsRes.data.workspace_infos[0];
    const workspaceId = (ws && ws.workspace_id) || '7316085995806572546';

    let movedToTrashCount = 0;
    for (let round = 0; round < 10; round++) {
      const qRes = await fetch('https://edit-api-sg.capcut.com/lv/v1/asset/query', {
        method: 'POST',
        credentials: 'include',
        headers: makeHeaders(sQuery),
        body: JSON.stringify({
          workspace_id: workspaceId,
          asset_types: [0, 1, 2, 3, 4, 5, 6],
          offset: 0,
          count: 100,
          order_by: 'modify_time',
          order: 1,
          parent_id: '-1',
          is_cross_folder: false
        })
      }).then(r => r.json()).catch(() => null);

      const assets = (qRes && qRes.data && qRes.data.assets) || [];
      const assetIds = assets.map(a => a.asset_id).filter(Boolean);
      if (assetIds.length === 0) break;

      await fetch('https://edit-api-sg.capcut.com/lv/v1/asset/delete', {
        method: 'POST',
        credentials: 'include',
        headers: makeHeaders(sDel),
        body: JSON.stringify({
          workspace_id: workspaceId,
          asset_ids: assetIds
        })
      }).catch(() => null);
      movedToTrashCount += assetIds.length;
    }

    // Permanently empty Recycle Bin (Trash) so 30-day items never consume the 5 GB Cloud Space quota!
    let purgedFromTrashCount = 0;
    for (let rRound = 0; rRound < 25; rRound++) {
      const rListRes = await fetch('https://edit-api-sg.capcut.com/lv/v1/recycle/list', {
        method: 'POST',
        credentials: 'include',
        headers: makeHeaders(sRecycleList),
        body: JSON.stringify({
          workspace_id: workspaceId,
          resource_types: [1, 3, 2],
          count: 100,
          cursor: '',
          order_by: 1,
          order_desc: 1,
          type_order_by: 1
        })
      }).then(r => r.json()).catch(() => null);

      const list = (rListRes && rListRes.data && rListRes.data.resource_list) || [];
      const resourceIds = list.map(item => item.resource_id).filter(Boolean);
      if (resourceIds.length === 0) break;

      await fetch('https://edit-api-sg.capcut.com/lv/v1/recycle/delete', {
        method: 'POST',
        credentials: 'include',
        headers: makeHeaders(sRecycleDel),
        body: JSON.stringify({
          workspace_id: workspaceId,
          resource_ids: resourceIds
        })
      }).catch(() => null);
      purgedFromTrashCount += resourceIds.length;
    }

    return {
      movedToTrashCount,
      purgedFromTrashCount
    };
  }, { sWs, sQuery, sDel, sRecycleList, sRecycleDel });

  if (cleanupResult && (cleanupResult.movedToTrashCount > 0 || cleanupResult.purgedFromTrashCount > 0)) {
    onLog(`🧹 Đã dọn sạch ${cleanupResult.movedToTrashCount} file tạm và xóa vĩnh viễn ${cleanupResult.purgedFromTrashCount} file trong Thùng rác Cloud CapCut!`);
  }
}

module.exports = {
  openCapCutLoginWindow,
  sendRemoteBrowserAction,
  closeCapCutLoginWindow,
  runCapCutWebAutomation,
  runCapCutWebParallelBatch,
  cancelCapCutRender,
  cleanupCapCutCloudSpace,
  getTemplateFolderName,
  getTemplateOutputDir
};


