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

function probeAudioStreamBitrate(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bit_rate', '-of', 'json', filePath],
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const data = JSON.parse(stdout);
          const s = (data.streams && data.streams[0]) || null;
          if (!s || !s.codec_name) return resolve(null);
          resolve({ codec: s.codec_name, bitRate: parseInt(s.bit_rate || '64000', 10) || 64000 });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Ensure the exported video uses the exact 100% original audio stream (pitch, tone, speed, effects)
 * from the cached original template preview video (`cache/templates/template_<id>.mp4`) without re-encoding video.
 */
async function syncOriginalTemplateAudio(outPath, templateInfo) {
  try {
    if (!outPath || !fs.existsSync(outPath)) return false;
    const tplId = String((templateInfo && templateInfo.templateId) || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const candidates = [];
    if (templateInfo && templateInfo.localVideoPath) candidates.push(templateInfo.localVideoPath);
    if (tplId) {
      candidates.push(path.join(__dirname, '..', 'cache', 'templates', `template_${tplId}.mp4`));
    }
    const tplVideoPath = candidates.find((p) => p && fs.existsSync(p) && fs.statSync(p).size > 20 * 1024);
    if (!tplVideoPath) return false;

    const [outDur, tplDur, audInfo] = await Promise.all([
      probeDurationSafe(outPath),
      probeDurationSafe(tplVideoPath),
      probeAudioStreamBitrate(tplVideoPath)
    ]);
    if (!outDur || !tplDur || Math.abs(outDur - tplDur) > 1.5) return false;
    if (!audInfo || audInfo.bitRate < 16000) return false;

    const tmpOutPath = `${outPath}.audio_sync_${Date.now()}.mp4`;
    const ok = await new Promise((resolve) => {
      execFile(
        'ffmpeg',
        [
          '-y',
          '-v', 'error',
          '-i', outPath,
          '-i', tplVideoPath,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-shortest',
          '-movflags', '+faststart',
          tmpOutPath
        ],
        (err) => resolve(!err)
      );
    });
    if (ok && fs.existsSync(tmpOutPath) && fs.statSync(tmpOutPath).size > 200 * 1024) {
      fs.renameSync(tmpOutPath, outPath);
      return true;
    }
    if (fs.existsSync(tmpOutPath)) {
      try { fs.unlinkSync(tmpOutPath); } catch {}
    }
  } catch {}
  return false;
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
  ensureChromeProfileAllowsMultiDownloads(true);
}

function ensureChromeProfileAllowsMultiDownloads(offscreen = true) {
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

    if (!prefs.browser || typeof prefs.browser !== 'object') prefs.browser = {};
    if (offscreen) {
      prefs.browser.window_placement = {
        bottom: -1500,
        left: -2400,
        maximized: false,
        right: -960,
        top: -2400,
        work_area_bottom: 1080,
        work_area_left: 0,
        work_area_right: 1920,
        work_area_top: 0
      };
    } else {
      prefs.browser.window_placement = {
        bottom: 960,
        left: 60,
        maximized: true,
        right: 1500,
        top: 60,
        work_area_bottom: 1080,
        work_area_left: 0,
        work_area_right: 1920,
        work_area_top: 0
      };
    }

    fs.writeFileSync(prefPath, JSON.stringify(prefs), 'utf8');
  } catch {}
}

async function hidePageWindowOffscreen(page) {
  if (!page) return;
  let cdp = null;
  try {
    cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' }
    }).catch(() => {});
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: -2400, top: -2400, width: 1440, height: 900, windowState: 'normal' }
    }).catch(() => {});
  } catch {} finally {
    if (cdp) {
      try { await cdp.detach(); } catch {}
    }
  }
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
 * Opens the CapCut account window and keeps it open so the user can freely sign in, sign out, or switch accounts.
 */
async function openCapCutLoginWindow(onLog = () => {}, onProgress = () => {}) {
  if (activeBatchCount > 0 || activeGlobalTabSlots > 0) {
    throw new Error('Hệ thống đang trong quá trình xuất video, vui lòng chờ xuất xong rồi mới mở cửa sổ Tài khoản CapCut!');
  }
  const loginUrl = 'https://www.capcut.com/my-edit';
  onLog('Đang mở cửa sổ quản lý tài khoản CapCut...');
  onProgress(20, 'Đang mở cửa sổ quản lý tài khoản CapCut...');

  if (sharedBrowserContext) {
    try { await sharedBrowserContext.close(); } catch {}
    sharedBrowserContext = null;
  }
  warmTabPoolByTemplate.clear();
  await killProfileChromeProcesses();
  ensureChromeProfileAllowsMultiDownloads(false);

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

  onLog('✅ Đã mở cửa sổ Tài khoản CapCut (giữ nguyên cửa sổ để đăng nhập / đăng xuất tùy ý).');
  onProgress(100, 'Đã mở cửa sổ Tài khoản CapCut.');
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
 * Returns an already-open CapCut tab from the Export Complete / Download modal (.lv_share_export-container or .template-post-publisher)
 * directly back to the Template Editor timeline (.segment-item[data-mutable-index]) without reloading the page or opening a new tab.
 */
async function returnToEditorOnSameTab(page) {
  if (!page || page.isClosed()) return false;

  for (let step = 0; step < 6; step++) {
    const state = await evalSafe(
      page,
      () => {
        // 1. If .lv_share_export-container is open, trigger its XState CLOSE transition + callbacks via React Fiber
        const expHeader = document.querySelector('.lv_share_export-container-header, .lv_share_export-container');
        if (expHeader) {
          const fk = Object.keys(expHeader).find(k => k.startsWith('__reactFiber'));
          let f = fk ? expHeader[fk] : null;
          while (f && !(f.memoizedProps && (f.memoizedProps.renderService || f.memoizedProps.handleCloseCallback))) {
            f = f.return;
          }
          if (f && f.memoizedProps) {
            const mp = f.memoizedProps;
            try {
              if (mp.renderService && typeof mp.renderService.send === 'function') {
                mp.renderService.send('CLOSE');
              }
            } catch {}
            try {
              if (typeof mp.handleCloseCallback === 'function') mp.handleCloseCallback();
            } catch {}
            try {
              if (typeof mp.shareModalHideCallback === 'function') mp.shareModalHideCallback();
            } catch {}
          }
        }

        // 2. Also click .template-post-publisher-back or modal close icons if present
        const backEl = document.querySelector(
          '.template-post-publisher-back, [class*="publisher-back"], .lv-modal-close-icon'
        );
        if (backEl) {
          try { backEl.click(); } catch {}
        }

        const expContainer = document.querySelector('.lv_share_export-container');
        const expRect = expContainer ? expContainer.getBoundingClientRect() : null;
        const hasExportModal = Boolean(expRect && expRect.width > 100 && expRect.height > 100);

        const pubContainer = document.querySelector('.template-post-publisher');
        const pubRect = pubContainer ? pubContainer.getBoundingClientRect() : null;
        const hasPubModal = Boolean(pubRect && pubRect.width > 100 && pubRect.height > 100);

        const seg0 = document.querySelector('.segment-item[data-mutable-index="0"]');
        const segRect = seg0 ? seg0.getBoundingClientRect() : null;
        const hasTimeline = Boolean(segRect && segRect.width > 20 && segRect.height > 20);

        const headerRightSvg = document.querySelector('.lv_share_export-container-header-right svg:last-child');
        const svgRect = headerRightSvg ? headerRightSvg.getBoundingClientRect() : null;

        return {
          hasExportModal,
          hasPubModal,
          hasTimeline,
          closeSvgPt: svgRect && svgRect.width > 0 ? { x: svgRect.left + svgRect.width / 2, y: svgRect.top + svgRect.height / 2 } : null
        };
      },
      null,
      3000,
      null
    );

    if (state && state.hasTimeline && !state.hasExportModal && !state.hasPubModal) {
      await page.keyboard.press('Escape').catch(() => {});
      return true;
    }

    if (state && state.closeSvgPt) {
      await page.mouse.click(state.closeSvgPt.x, state.closeSvgPt.y).catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }

  // Final check: is the timeline visible and usable?
  const finalOk = await evalSafe(
    page,
    () => {
      const seg0 = document.querySelector('.segment-item[data-mutable-index="0"]');
      const segRect = seg0 ? seg0.getBoundingClientRect() : null;
      const expContainer = document.querySelector('.lv_share_export-container');
      const expRect = expContainer ? expContainer.getBoundingClientRect() : null;
      return Boolean(
        segRect &&
        segRect.width > 20 &&
        segRect.height > 20 &&
        (!expRect || expRect.width < 100)
      );
    },
    null,
    2500,
    false
  );
  return Boolean(finalOk);
}

/**
 * Unblocks CapCut Web Editor template export when unused template assets fail EverCloud sync (sync2UserMaterialFailure)
 * and patches dataSdk.getDraftStr() so transitions/effects with legacy source_platform=0 / empty third_resource_id
 * are properly recognized and rendered by CapCut's Cloud Render Server.
 */
async function unblockCapCutTemplateSyncAndPatchTransitions(page, options = {}) {
  if (!page || page.isClosed()) return null;
  const allowForceUnlock = Boolean(options && options.allowForceUnlock);
  return evalSafe(
    page,
    (forceUnlock) => {
      try {
        document.querySelectorAll('.lv-modal-close-icon').forEach(x => {
          const r = x.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) x.click();
        });
        document.querySelectorAll('.lv-modal-wrapper, .lv-modal-mask').forEach(m => {
          const txt = m.innerText || '';
          if (txt.includes('save project') || txt.includes('Refresh') || txt.includes('Không thể lưu')) {
            m.remove();
          }
        });
      } catch {}

      const b2 =
        Array.from(document.querySelectorAll('#export-video-btn')).find(el => el.getBoundingClientRect().left > 100) ||
        document.querySelector('#export-video-btn');
      if (!b2) return null;

      const fk2 = Object.keys(b2).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      let cur = fk2 ? b2[fk2] : null;
      let compD = null;
      while (cur) {
        if (cur.memoizedProps && cur.memoizedProps.mainDraftService && !compD) {
          compD = cur;
          break;
        }
        cur = cur.return;
      }
      if (!compD || !compD.memoizedProps) return null;

      const mp = compD.memoizedProps;
      const mds = mp.mainDraftService.__origin__ || mp.mainDraftService;
      if (!mds) return null;

      // 1. Patch dataSdk.getDraftStr so cloud render server always receives valid third_resource_id & source_platform=1 for transitions/effects
      // IMPORTANT: NEVER set third_resource_id on d.materials.effects (mix_mode / filter), because built-in blend modes ("Bộ lọc", "Làm sáng", "Trình chiếu")
      // require third_resource_id: "" to use the engine's built-in /editor/effect/mix/... shader; setting third_resource_id on mix_mode breaks transparency
      // and causes overlay tracks (like starlight MOVs) to render opaque black over Track 0!
      const dataSdk = mds.dataSdk;
      if (dataSdk && typeof dataSdk.getDraftStr === 'function' && dataSdk.__patchedGetDraftStrVersion !== 2) {
        if (!dataSdk.__origGetDraftStr) {
          dataSdk.__origGetDraftStr = dataSdk.getDraftStr.bind(dataSdk);
        }
        const origGetDraftStr = dataSdk.__origGetDraftStr;
        dataSdk.getDraftStr = function (...args) {
          const raw = origGetDraftStr(...args);
          try {
            const parsed = JSON.parse(raw);
            const patchDraftObj = (d) => {
              if (!d || typeof d !== 'object') return;
              if (d.materials) {
                if (Array.isArray(d.materials.transitions)) {
                  for (const tr of d.materials.transitions) {
                    if (tr && tr.resource_id && (!tr.third_resource_id || tr.source_platform === 0)) {
                      tr.third_resource_id = tr.resource_id;
                      tr.effect_id = tr.resource_id;
                      tr.source_platform = 1;
                    }
                  }
                }
                if (Array.isArray(d.materials.video_effects)) {
                  for (const ve of d.materials.video_effects) {
                    if (ve && ve.resource_id && /^\d{15,}$/.test(String(ve.resource_id)) && ve.source_platform === 0) {
                      ve.third_resource_id = ve.resource_id;
                      ve.effect_id = ve.resource_id;
                      ve.source_platform = 1;
                    }
                  }
                }
                if (Array.isArray(d.materials.audio_effects)) {
                  for (const ae of d.materials.audio_effects) {
                    if (ae && ae.resource_id && (!ae.third_resource_id || ae.source_platform === 0)) {
                      ae.third_resource_id = ae.resource_id;
                      ae.effect_id = ae.resource_id;
                      ae.source_platform = 1;
                    }
                  }
                }
                if (Array.isArray(d.materials.drafts)) {
                  for (const sub of d.materials.drafts) {
                    if (sub && sub.draft) patchDraftObj(sub.draft);
                  }
                }
              }
              if (Array.isArray(d.tracks)) {
                for (const track of d.tracks) {
                  if (track && track.type === 'audio' && Array.isArray(track.segments)) {
                    for (const seg of track.segments) {
                      if (seg && typeof seg.speed === 'number' && Math.abs(seg.speed - 1) > 0.001 && seg.is_tone_modify === true) {
                        seg.is_tone_modify = false;
                      }
                    }
                  }
                }
              }
            };
            if (parsed && parsed.materials) {
              patchDraftObj(parsed);
              return JSON.stringify(parsed);
            }
          } catch {}
          return raw;
        };
        dataSdk.__patchedGetDraftStr = true;
        dataSdk.__patchedGetDraftStrVersion = 2;
      }

      // 2. Remove any failed autoGeneratedMaterials (e.g., sync2UserMaterialFailure) that permanently block #export-video-btn
      const sm = mds._saveManager || mds.saveManager;
      const dms = sm && (sm._draftMaterialsService ? (sm._draftMaterialsService.__origin__ || sm._draftMaterialsService) : null);
      let removedFailedCount = 0;
      if (dms && typeof dms.getMaterials === 'function') {
        const mats = dms.getMaterials();
        for (const m of [...((mats && mats.autoGeneratedMaterials) || [])]) {
          if (m && m.status && m.status !== 'Success' && (forceUnlock || (m.status !== 'uploading' && m.status !== 'syncing' && m.status !== 'transcoding'))) {
            try {
              dms.removeFromAutoGenerated(m.id);
              removedFailedCount++;
            } catch {}
          }
        }
        if (forceUnlock && mats && Array.isArray(mats.userGeneratedMaterials)) {
          for (const um of [...mats.userGeneratedMaterials]) {
            if (um && um.status && um.status !== 'Success' && um.status !== 'uploading' && um.status !== 'syncing' && um.status !== 'transcoding') {
              try {
                if (typeof dms.removeFromUserGenerated === 'function') {
                  dms.removeFromUserGenerated(um.id);
                }
                removedFailedCount++;
              } catch {}
            }
          }
        }
        const stillSyncing = typeof dms.hasMaterialSyncing === 'function' ? dms.hasMaterialSyncing() : false;
        if (removedFailedCount > 0 || !stillSyncing || forceUnlock) {
          try { dms._checkAndNotifyMaterialDoneState(); } catch {}
        }
      }

      const s = mp.store;
      if (s && Array.isArray(s._autoGeneratedMaterials)) {
        const filtered = s._autoGeneratedMaterials.filter(
          m => !m || m.status === 'Success' || (!forceUnlock && (m.status === 'uploading' || m.status === 'syncing' || m.status === 'transcoding'))
        );
        if (filtered.length !== s._autoGeneratedMaterials.length && typeof s.actionAutoGeneratedMaterialsSet === 'function') {
          try { s.actionAutoGeneratedMaterialsSet(filtered); } catch {}
        }
      }

      if (forceUnlock) {
        if (s && typeof s.actionExportButtonDisable === 'function') {
          try { s.actionExportButtonDisable(false); } catch {}
        }
        document.querySelectorAll('#export-video-btn').forEach(btn => {
          btn.disabled = false;
          btn.classList.remove('lv-btn-disabled');
          btn.removeAttribute('aria-disabled');
        });
      }

      return {
        patchedDraftStr: Boolean(dataSdk && dataSdk.__patchedGetDraftStr),
        removedFailedCount,
        isExportButtonDisable: s ? s.isExportButtonDisable : null,
        trigger: s ? s.isExportButtonDisableTrigger : null
      };
    },
    allowForceUnlock,
    4000,
    null
  );
}

/**
 * Fill template slots inside CapCut Web Editor using .segment-item[data-mutable-index] inputs
 * Supports BOTH fresh tabs (direct input[type="file"]) AND reused tabs (clicking .tier-inner button -> .menu-mutable input[type="file"])!
 */
async function fillTemplateSlotsOnEditor(editorPage, videoFilePaths, onLog = () => {}, prevUploadedFiles = null) {
  await returnToEditorOnSameTab(editorPage).catch(() => {});
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

  // Wait up to 15s for CapCut Web Editor's timelineStore to finish unpacking the template (exportReady === true)
  // before we start injecting user files into slots
  for (let readyWait = 0; readyWait < 30; readyWait++) {
    const isTplUnpacked = await evalSafe(
      editorPage,
      (expectedSlots) => {
        const el = document.querySelector('.segment-item[data-mutable-index="0"]');
        if (!el) return false;
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        let cur = fk ? el[fk] : null;
        let ts = null;
        while (cur) {
          if (cur.memoizedProps) {
            if (cur.memoizedProps.timelineStore) {
              ts = cur.memoizedProps.timelineStore;
              break;
            }
            if (cur.memoizedProps.store && cur.memoizedProps.store.timelineStore) {
              ts = cur.memoizedProps.store.timelineStore;
              break;
            }
          }
          cur = cur.return;
        }
        if (!ts) return true;
        const segs =
          ts.tracksMutable &&
          ts.tracksMutable[0] &&
          ts.tracksMutable[0][0] &&
          ts.tracksMutable[0][0].segments;
        return Boolean(ts.exportReady && Array.isArray(segs) && segs.length >= expectedSlots);
      },
      slotCount,
      3000,
      false
    );
    if (isTplUnpacked) break;
    await editorPage.waitForTimeout(500);
  }

  const cleanDisplayName = (fp) =>
    path.basename(String(fp || '')).replace(/^p\d+_s\d+_/, '').replace(/^\d+_\d+_/, '');

  // Record the current active thumbnail URL (img.tier-sprite-img / first img) of EVERY slot before we touch anything
  const originalSlotImgs = await evalSafe(
    editorPage,
    (count) => {
      const urls = [];
      for (let i = 0; i < count; i++) {
        const img =
          document.querySelector(`.segment-item[data-mutable-index="${i}"] img.tier-sprite-img`) ||
          document.querySelector(`.segment-item[data-mutable-index="${i}"] img`);
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
    const segLocator = editorPage.locator(segSelector).first();
    const segInput = editorPage.locator(`${segSelector} input[type="file"]`).first();
    const origImgSrc = originalSlotImgs[i] || '';

    // If this reused tab already uploaded this exact same file into slot i on the previous run AND MobX confirms seg.mutable.filled === true, no need to re-upload
    const hasDirectInputInit = (await segInput.count().catch(() => 0)) > 0;
    if (
      !hasDirectInputInit &&
      Array.isArray(prevUploadedFiles) &&
      prevUploadedFiles[i] === fileToUse &&
      origImgSrc.startsWith('blob:')
    ) {
      const alreadyFilledMobx = await evalSafe(
        editorPage,
        ({ sel, slotIdx }) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
          let cur = fk ? el[fk] : null;
          let ts = null;
          while (cur) {
            if (cur.memoizedProps) {
              if (cur.memoizedProps.timelineStore) {
                ts = cur.memoizedProps.timelineStore;
                break;
              }
              if (cur.memoizedProps.store && cur.memoizedProps.store.timelineStore) {
                ts = cur.memoizedProps.store.timelineStore;
                break;
              }
            }
            cur = cur.return;
          }
          const seg =
            ts &&
            ts.tracksMutable &&
            ts.tracksMutable[0] &&
            ts.tracksMutable[0][0] &&
            ts.tracksMutable[0][0].segments &&
            ts.tracksMutable[0][0].segments[slotIdx];
          return Boolean(seg && !seg.loading && seg.mutable && seg.mutable.filled);
        },
        { sel: segSelector, slotIdx: i },
        3000,
        false
      );
      if (alreadyFilledMobx) return true;
    }

    for (let retry = 1; retry <= 4; retry++) {
      if (retry > 1) {
        onLog(`🔄 Phân đoạn ${i + 1}/${slotCount} đang đồng bộ, tự động nạp lại (lần ${retry}): ${cleanDisplayName(fileToUse)}`);
        await editorPage.keyboard.press('Escape').catch(() => {});
        await editorPage.waitForTimeout(600);
      }

      let setOk = false;
      const directInputCount = await segInput.count().catch(() => 0);

      if (directInputCount > 0) {
        // Fresh slot: upload directly via .segment-item[data-mutable-index="i"] input[type="file"]
        await acquireSlotUploadGate();
        setOk = await segInput.setInputFiles(fileToUse, { timeout: 7000 }).then(() => true).catch(() => false);
      } else {
        // Reused tab slot (already filled once): click .tier-inner button on the slot to open .menu-mutable ("Replace") and upload via its input[type="file"]
        await editorPage.keyboard.press('Escape').catch(() => {});
        await editorPage.waitForTimeout(150);

        const editBtn = segLocator.locator('.tier-inner button').first();
        if ((await editBtn.count().catch(() => 0)) > 0) {
          await editBtn.click({ timeout: 3000 }).catch(async () => {
            await segLocator.click({ timeout: 3000 }).catch(() => {});
          });
        } else {
          await segLocator.click({ timeout: 3000 }).catch(() => {});
        }
        await editorPage.waitForTimeout(420);

        const menuInput = editorPage.locator('.menu-mutable:visible input[type="file"]').last();
        if ((await menuInput.count().catch(() => 0)) > 0) {
          await acquireSlotUploadGate();
          setOk = await menuInput.setInputFiles(fileToUse, { timeout: 7000 }).then(() => true).catch(() => false);
        } else {
          const fallbackMenuInput = editorPage.locator('.menu-mutable input[type="file"], [class*="segment-widget-menu"] input[type="file"]').last();
          if ((await fallbackMenuInput.count().catch(() => 0)) > 0) {
            await acquireSlotUploadGate();
            setOk = await fallbackMenuInput.setInputFiles(fileToUse, { timeout: 7000 }).then(() => true).catch(() => false);
          }
        }
      }

      if (!setOk) {
        continue;
      }

      // Fast poll (every 350ms): wait up to ~10s for the slot to register the file (curState.changed === true),
      // and once curState.changed === true, keep waiting up to ~45s for .quick-import / transcoding (curState.loading === false)
      // WITHOUT re-uploading on top of an active import!
      let maxSteps = 28; // ~10s to detect that setInputFiles was accepted by the slot
      for (let waitStep = 0; waitStep < maxSteps; waitStep++) {
        await editorPage.waitForTimeout(350);
        const curState = await evalSafe(
          editorPage,
          ({ sel, origSrc, wasDirect, slotIdx }) => {
            const el = document.querySelector(sel);
            if (!el) return { changed: false, loading: false };
            const img = el.querySelector('img.tier-sprite-img') || el.querySelector('img');
            const curSrc = img ? img.src : '';
            const hasInput = Boolean(el.querySelector('input[type="file"]'));
            let isChanged = Boolean((curSrc && curSrc !== origSrc) || (wasDirect && !hasInput));
            let hasLoading = Boolean(el.querySelector('[class*="loading"], [class*="spin"], [class*="progress"]'));

            // Verify MobX timelineStore segment state (via memoizedProps.store.timelineStore or memoizedProps.timelineStore)
            try {
              const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
              let cur = fk ? el[fk] : null;
              let ts = null;
              while (cur) {
                if (cur.memoizedProps) {
                  if (cur.memoizedProps.timelineStore) {
                    ts = cur.memoizedProps.timelineStore;
                    break;
                  }
                  if (cur.memoizedProps.store && cur.memoizedProps.store.timelineStore) {
                    ts = cur.memoizedProps.store.timelineStore;
                    break;
                  }
                }
                cur = cur.return;
              }
              const seg =
                ts &&
                ts.tracksMutable &&
                ts.tracksMutable[0] &&
                ts.tracksMutable[0][0] &&
                ts.tracksMutable[0][0].segments &&
                ts.tracksMutable[0][0].segments[slotIdx];
              if (seg) {
                const segPath = String(seg.path || '');
                if (seg.loading || segPath.startsWith('/.quick-import/') || segPath.includes('IOS_ALBUM')) {
                  hasLoading = true;
                  isChanged = true;
                }
                if (seg.mutable) {
                  if (!seg.mutable.filled && !hasLoading) return { changed: false, loading: false, curSrc };
                  if (seg.mutable.filled) isChanged = true;
                }
              }
            } catch {}

            return { changed: isChanged, loading: hasLoading, curSrc };
          },
          { sel: segSelector, origSrc: origImgSrc, wasDirect: directInputCount > 0, slotIdx: i },
          4000,
          { changed: false, loading: false }
        );

        if (curState && curState.changed) {
          // The slot has accepted the file and is importing/transcoding it — extend wait limit to 130 steps (~45s) so we never interrupt it with a duplicate upload!
          maxSteps = 130;
          if (!curState.loading) {
            await editorPage.keyboard.press('Escape').catch(() => {});
            return true;
          }
        }
      }
    }
    await editorPage.keyboard.press('Escape').catch(() => {});
    return false;
  };

  let filledCount = 0;
  for (let i = 0; i < slotCount; i++) {
    const fileToUse = videoFilePaths[i % videoFilePaths.length];
    const ok = await replaceSingleSlotVerified(i, fileToUse);
    if (ok) {
      filledCount++;
      onLog(`✓ Phân đoạn ${i + 1}/${slotCount}: ${cleanDisplayName(fileToUse)}`);
    } else {
      onLog(`⚠️ Phân đoạn ${i + 1}/${slotCount} phản hồi chậm, đang kiểm tra lại...`);
    }
    // Short settle delay (650ms) since replaceSingleSlotVerified already confirmed replacement
    await editorPage.waitForTimeout(650);
  }

  // Final post-loop audit: re-check all slots in both DOM and MobX timelineStore to guarantee ZERO slots kept the original template media
  for (let i = 0; i < slotCount; i++) {
    const fileToUse = videoFilePaths[i % videoFilePaths.length];
    const segSelector = `.segment-item[data-mutable-index="${i}"]`;
    const origImgSrc = originalSlotImgs[i] || '';
    const sameAsPrevRun = Array.isArray(prevUploadedFiles) && prevUploadedFiles[i] === fileToUse;

    const needsRefill = await evalSafe(
      editorPage,
      ({ sel, origSrc, slotIdx, isSameAsPrev }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        let cur = fk ? el[fk] : null;
        let ts = null;
        while (cur) {
          if (cur.memoizedProps) {
            if (cur.memoizedProps.timelineStore) {
              ts = cur.memoizedProps.timelineStore;
              break;
            }
            if (cur.memoizedProps.store && cur.memoizedProps.store.timelineStore) {
              ts = cur.memoizedProps.store.timelineStore;
              break;
            }
          }
          cur = cur.return;
        }
        const seg =
          ts &&
          ts.tracksMutable &&
          ts.tracksMutable[0] &&
          ts.tracksMutable[0][0] &&
          ts.tracksMutable[0][0].segments &&
          ts.tracksMutable[0][0].segments[slotIdx];
        if (seg && seg.mutable && !seg.mutable.filled) {
          return true;
        }
        if (!isSameAsPrev && origSrc) {
          const img = el.querySelector('img.tier-sprite-img') || el.querySelector('img');
          if (img && img.src === origSrc) return true;
        }
        return false;
      },
      { sel: segSelector, origSrc: origImgSrc, slotIdx: i, isSameAsPrev: sameAsPrevRun },
      4000,
      false
    );

    if (needsRefill) {
      onLog(`🔄 Nạp lại Phân đoạn ${i + 1}/${slotCount}: ${cleanDisplayName(fileToUse)}...`);
      const retryOk = await replaceSingleSlotVerified(i, fileToUse);
      if (retryOk) filledCount++;
      await editorPage.waitForTimeout(650);
    }
  }

  // Wait up to 30s for all user-uploaded slot files to finish .quick-import and cloud material upload (userGeneratedMaterials === 'Success')
  // so #export-video-btn is immediately clickable and CapCut's Cloud Render Server has 100% of the user's uploaded media on Track 0!
  for (let syncStep = 0; syncStep < 60; syncStep++) {
    await unblockCapCutTemplateSyncAndPatchTransitions(editorPage).catch(() => {});
    const syncState = await evalSafe(
      editorPage,
      (count) => {
        const el = document.querySelector('.segment-item[data-mutable-index="0"]');
        if (!el) return { ready: true };
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        let cur = fk ? el[fk] : null;
        let ts = null;
        while (cur) {
          if (cur.memoizedProps) {
            if (cur.memoizedProps.timelineStore) {
              ts = cur.memoizedProps.timelineStore;
              break;
            }
            if (cur.memoizedProps.store && cur.memoizedProps.store.timelineStore) {
              ts = cur.memoizedProps.store.timelineStore;
              break;
            }
          }
          cur = cur.return;
        }
        const segs =
          ts &&
          ts.tracksMutable &&
          ts.tracksMutable[0] &&
          ts.tracksMutable[0][0] &&
          ts.tracksMutable[0][0].segments;
        if (Array.isArray(segs)) {
          for (let i = 0; i < Math.min(count, segs.length); i++) {
            const s = segs[i];
            if (!s) continue;
            const sp = String(s.path || '');
            if (s.loading || sp.startsWith('/.quick-import/') || sp.includes('IOS_ALBUM') || (s.mutable && !s.mutable.filled)) {
              return { ready: false, reason: `slot_${i}_importing` };
            }
          }
        }

        const expBtns = Array.from(document.querySelectorAll('#export-video-btn')).filter(
          b => b.getBoundingClientRect().left > 100
        );
        if (expBtns.length > 0) {
          const btn = expBtns[0];
          const fk2 = Object.keys(btn).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
          let c2 = fk2 ? btn[fk2] : null;
          let compD = null;
          while (c2) {
            if (c2.memoizedProps && c2.memoizedProps.mainDraftService) {
              compD = c2;
              break;
            }
            c2 = c2.return;
          }
          if (compD && compD.memoizedProps) {
            const mds = compD.memoizedProps.mainDraftService.__origin__ || compD.memoizedProps.mainDraftService;
            const sm = mds && (mds._saveManager || mds.saveManager);
            const dms = sm && sm._draftMaterialsService ? (sm._draftMaterialsService.__origin__ || sm._draftMaterialsService) : null;
            if (dms) {
              if (typeof dms.hasMaterialSyncing === 'function' && dms.hasMaterialSyncing()) {
                return { ready: false, reason: 'dms_syncing' };
              }
              if (typeof dms.getMaterials === 'function') {
                const mats = dms.getMaterials();
                const uMats = (mats && mats.userGeneratedMaterials) || [];
                if (uMats.some(m => m && m.status !== 'Success')) {
                  return { ready: false, reason: 'user_mats_uploading' };
                }
              }
            }
          }
          const disabled =
            btn.disabled ||
            btn.classList.contains('lv-btn-disabled') ||
            btn.getAttribute('aria-disabled') === 'true';
          if (disabled) return { ready: false, reason: 'export_btn_disabled' };
        }
        return { ready: true };
      },
      slotCount,
      3000,
      { ready: true }
    );
    if (syncState && syncState.ready) break;
    await editorPage.waitForTimeout(500);
  }

  await unblockCapCutTemplateSyncAndPatchTransitions(editorPage, { allowForceUnlock: true }).catch(() => {});
  await editorPage.keyboard.press('Escape').catch(() => {});
  return filledCount;
}

/**
 * Reliably opens the CapCut Export Confirm modal (#export-confirm-button) without toggling the Export menu closed,
 * using Playwright trusted clicks (with safe timeout) so Chromium records a valid user gesture for automatic downloads.
 */
async function openExportConfirmDialog(page) {
  for (let attempt = 1; attempt <= 45; attempt++) {
    await unblockCapCutTemplateSyncAndPatchTransitions(page, { allowForceUnlock: true }).catch(() => {});
    // Dismiss any onboarding tooltips, guide buttons, or blocking modal close icons on every attempt
    await evalSafe(
      page,
      () => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.left >= 0;
        });
        for (const b of btns) {
          const t = (b.innerText || '').trim();
          if (/^(OK|Got it|Đã hiểu)$/i.test(t)) b.click();
        }
        const closeIcons = Array.from(document.querySelectorAll('.lv-modal-close-icon'));
        for (const x of closeIcons) {
          const r = x.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) x.click();
        }
      },
      null,
      3000
    );

    const uiState = await evalSafe(
      page,
      () => {
        const isOnScreen = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.05) {
            return false;
          }
          const r = el.getBoundingClientRect();
          return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
        };
        const isUsable = (el) =>
          Boolean(
            isOnScreen(el) &&
              !el.disabled &&
              !el.classList.contains('lv-btn-disabled') &&
              el.getAttribute('aria-disabled') !== 'true'
          );

        const visibleConfirmBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(isOnScreen);
        if (visibleConfirmBtns.length > 0) {
          return visibleConfirmBtns.some(isUsable) ? 'READY_CONFIRM' : 'CONFIRM_LOADING';
        }

        const dlBtns = Array.from(
          document.querySelectorAll('[class*="choosePage-download-btn"] button, [class*="choosePage-download-btn"]')
        ).filter(isUsable);
        if (dlBtns.length > 0) {
          return 'HAS_DL_MENU';
        }

        // IMPORTANT: CapCut renders TWO #export-video-btn elements: one real button at top-right (left > 100)
        // and one hidden duplicate at negative X (left ≈ -67). Always filter for r.left > 100!
        const expBtns = Array.from(document.querySelectorAll('#export-video-btn')).filter(
          el => isUsable(el) && el.getBoundingClientRect().left > 100
        );
        if (expBtns.length > 0) {
          return 'HAS_EXPORT_BTN';
        }

        const fallbackExpBtns = Array.from(document.querySelectorAll('button')).filter(b => {
          if (!isUsable(b) || b.id === 'export-confirm-button' || b.getBoundingClientRect().left <= 100) return false;
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
      await page.waitForTimeout(550);
      return true;
    }

    if (uiState === 'CONFIRM_LOADING') {
      // Export settings panel is already open, waiting for CapCut to finish processing uploaded slot media
      await page.waitForTimeout(1000);
      continue;
    }

    const clickChooseDownloadMenu = async () => {
      const targetPt = await evalSafe(
        page,
        () => {
          const btns = Array.from(
            document.querySelectorAll('[class*="choosePage-download-btn"] button, [class*="choosePage-download-btn"]')
          ).filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0 && !b.disabled;
          });
          if (btns.length === 0) return null;
          const r = btns[0].getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        null,
        2500,
        null
      );
      if (targetPt) {
        await page.mouse.click(targetPt.x, targetPt.y).catch(() => {});
      }
      await page.waitForTimeout(450);
      await evalSafe(
        page,
        () => {
          const cBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
            c => c && c.getBoundingClientRect().width > 18 && c.getBoundingClientRect().left >= 0
          );
          if (cBtns.length > 0) return; // Already opened #export-confirm-button!
          const btns = Array.from(
            document.querySelectorAll('[class*="choosePage-download-btn"] button, [class*="choosePage-download-btn"]')
          ).filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0 && !b.disabled;
          });
          if (btns.length > 0) btns[0].click();
        },
        null,
        2500
      );
    };

    if (uiState === 'HAS_DL_MENU') {
      await clickChooseDownloadMenu();

      for (let w = 0; w < 10; w++) {
        await page.waitForTimeout(350);
        const confirmState = await evalSafe(
          page,
          () => {
            const cBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(c => {
              if (!c) return false;
              const r = c.getBoundingClientRect();
              return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
            });
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
          await page.waitForTimeout(550);
          return true;
        }
        if (confirmState === 'LOADING') {
          break;
        }
      }
      continue;
    }

    if (uiState === 'HAS_EXPORT_BTN') {
      // IMPORTANT: #export-video-btn is a TOGGLE button! Clicking it twice within 500ms on a slow VPS CPU
      // opens the popover on click #1 and immediately closes it on click #2!
      // Therefore, perform ONLY ONE click per attempt, then poll 4.8s (12 * 400ms) for the popover to finish rendering.
      if (attempt % 2 === 1) {
        await evalSafe(
          page,
          () => {
            const candidates = [
              ...Array.from(document.querySelectorAll('#export-video-btn')),
              ...Array.from(document.querySelectorAll('button')).filter(
                b => b.id !== 'export-confirm-button' && /^(Export|Xuất)$/i.test((b.innerText || '').trim())
              )
            ].filter(el => {
              if (!el || el.disabled || el.classList.contains('lv-btn-disabled')) return false;
              const r = el.getBoundingClientRect();
              return r.width > 18 && r.height > 14 && r.left > 100 && r.top >= 0;
            });
            if (candidates.length > 0) {
              candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
              candidates[0].click();
            }
          },
          null,
          2500
        );
      } else {
        const expPt = await evalSafe(
          page,
          () => {
            const candidates = [
              ...Array.from(document.querySelectorAll('#export-video-btn')),
              ...Array.from(document.querySelectorAll('button')).filter(
                b => b.id !== 'export-confirm-button' && /^(Export|Xuất)$/i.test((b.innerText || '').trim())
              )
            ].filter(el => {
              if (!el || el.disabled || el.classList.contains('lv-btn-disabled')) return false;
              const r = el.getBoundingClientRect();
              return r.width > 18 && r.height > 14 && r.left > 100 && r.top >= 0;
            });
            if (candidates.length === 0) return null;
            candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
            const r = candidates[0].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          },
          null,
          2500,
          null
        );
        if (expPt) {
          await page.mouse.click(expPt.x, expPt.y).catch(() => {});
        }
      }

      // Poll up to 4.8s for the popover menu (#export-confirm-button or choosePage-download-btn) so we NEVER toggle it closed on slow VPS CPUs!
      for (let w = 0; w < 12; w++) {
        await page.waitForTimeout(400);
        const subState = await evalSafe(
          page,
          () => {
            const cBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(c => {
              if (!c) return false;
              const r = c.getBoundingClientRect();
              return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
            });
            if (cBtns.length > 0) {
              const ready = cBtns.some(
                c => !c.disabled && !c.classList.contains('lv-btn-disabled') && c.getAttribute('aria-disabled') !== 'true'
              );
              return ready ? 'READY_CONFIRM' : 'CONFIRM_LOADING';
            }
            const dlBtns = Array.from(
              document.querySelectorAll('[class*="choosePage-download-btn"] button, [class*="choosePage-download-btn"]')
            ).filter(dl => {
              if (!dl || dl.disabled) return false;
              const r = dl.getBoundingClientRect();
              return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
            });
            if (dlBtns.length > 0) return 'HAS_DL_MENU';
            return 'NONE';
          },
          null,
          3000,
          'NONE'
        );

        if (subState === 'READY_CONFIRM') {
          await page.waitForTimeout(550);
          return true;
        }
        if (subState === 'CONFIRM_LOADING') {
          break;
        }
        if (subState === 'HAS_DL_MENU') {
          await clickChooseDownloadMenu();
          for (let k = 0; k < 10; k++) {
            await page.waitForTimeout(350);
            const confirmState = await evalSafe(
              page,
              () => {
                const cBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(c => {
                  if (!c) return false;
                  const r = c.getBoundingClientRect();
                  return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
                });
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
              await page.waitForTimeout(550);
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
  downloadPromise.catch(() => {});

  const clickConfirmBtn = async () => {
    await acquireExportSubmitGate();
    // Locate the on-screen #export-confirm-button
    let confirmPt = await evalSafe(
      page,
      () => {
        const btns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(btn => {
          if (!btn || btn.disabled || btn.classList.contains('lv-btn-disabled') || btn.getAttribute('aria-disabled') === 'true') {
            return false;
          }
          const r = btn.getBoundingClientRect();
          return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
        });
        if (btns.length === 0) return null;
        btns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        const r = btns[0].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      null,
      2500,
      null
    );

    if (!confirmPt) {
      await openExportConfirmDialog(page);
      confirmPt = await evalSafe(
        page,
        () => {
          const btns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(btn => {
            if (!btn || btn.disabled || btn.classList.contains('lv-btn-disabled') || btn.getAttribute('aria-disabled') === 'true') {
              return false;
            }
            const r = btn.getBoundingClientRect();
            return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
          });
          if (btns.length === 0) return null;
          btns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
          const r = btns[0].getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        null,
        2500,
        null
      );
    }

    let clickedMouse = false;
    if (confirmPt) {
      clickedMouse = await page.mouse.click(confirmPt.x, confirmPt.y).then(() => true).catch(() => false);
    }

    if (!clickedMouse) {
      await evalSafe(page, () => {
        const btns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(btn => {
          if (
            !btn ||
            btn.disabled ||
            btn.classList.contains('lv-btn-disabled') ||
            btn.classList.contains('lv-btn-loading') ||
            btn.getAttribute('aria-disabled') === 'true'
          ) {
            return false;
          }
          const r = btn.getBoundingClientRect();
          return r.width > 18 && r.height > 14 && r.left >= 0 && r.top >= 0;
        });
        if (btns.length > 0) {
          btns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
          btns[0].click();
        }
      });
    }
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
          const expIntEl = document.querySelector('.lv_exportProcess-container .lv-statistic-value-int');
          const expIntText = expIntEl ? (expIntEl.innerText || '').trim() : '';
          let pctStr = /^\d{1,3}$/.test(expIntText) ? `${expIntText}%` : null;

          if (!pctStr) {
            const bodyText = document.body ? (document.body.innerText || '') : '';
            const mAfter = bodyText.match(/(?:Exporting|Đang xuất|Rendering|Đang kết xuất)[^%\d\n\r]{0,25}(\d{1,3})(?:\.\d+)?%/i);
            const mBefore = bodyText.match(/(\d{1,3})(?:\.\d+)?\s*%\s*(?:Exporting|Đang xuất|Rendering|Đang kết xuất)/i);
            const matchedNum = (mAfter && mAfter[1]) || (mBefore && mBefore[1]);
            if (matchedNum) pctStr = `${matchedNum}%`;
          }

          const expProc = document.querySelector('.lv_exportProcess-container');
          const hasExportProcessModal = Boolean(expProc && expProc.getBoundingClientRect().width > 100);

          const confirmBtns = Array.from(document.querySelectorAll('#export-confirm-button')).filter(
            c =>
              c.offsetParent !== null &&
              !c.disabled &&
              !c.classList.contains('lv-btn-disabled') &&
              !c.classList.contains('lv-btn-loading')
          );
          const hasConfirm = confirmBtns.length > 0;
          const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
          const hasManualDlBtn = btns.some(b => {
            const t = (b.innerText || '').trim();
            return (t === 'Download' || t === 'Tải xuống') && b.id !== 'export-confirm-button';
          });
          return { pctStr, hasExportProcessModal, hasConfirm, hasManualDlBtn };
        },
        null,
        3500,
        null
      );

      if (!state) return;

      if (state.pctStr || state.hasExportProcessModal) {
        hasStartedExporting = true;
        confirmStillVisibleTicks = 0;
        idleNotExportingTicks = 0;
        if (state.pctStr) onRenderPercent(state.pctStr);
      } else if (state.hasConfirm && activeDownloadEvents === 0) {
        // Wait 4 consecutive ticks (~12s) before re-clicking #export-confirm-button so we never send duplicate export requests while video_draft/save is in flight
        idleNotExportingTicks = 0;
        confirmStillVisibleTicks++;
        if (confirmStillVisibleTicks >= 4) {
          confirmStillVisibleTicks = 0;
          await clickConfirmBtn();
        }
      } else if (!state.hasManualDlBtn && !hasStartedExporting && activeDownloadEvents === 0) {
        confirmStillVisibleTicks = 0;
        idleNotExportingTicks++;
        if (idleNotExportingTicks >= 4) {
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
        await returnToEditorOnSameTab(page).catch(() => {});
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
        downloadPromise.catch(() => {});
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

  onLog('🤖 Đang khởi chạy trình dựng mẫu CapCut ngầm...');
  onProgress(15, 'Đang tải mẫu CapCut ngầm...');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: [
      '--window-position=-2400,-2400',
      '--window-size=1440,900',
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
    await hidePageWindowOffscreen(editorPage);
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

    await syncOriginalTemplateAudio(outPath, templateInfo);

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

const GLOBAL_MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '5', 10) || 5;
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
        viewport: { width: 1440, height: 900 },
        acceptDownloads: true,
        args: [
          '--window-position=-2400,-2400',
          '--window-size=1440,900',
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
      const initPage = ctx.pages()[0];
      if (initPage) {
        await hidePageWindowOffscreen(initPage);
      }

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
  const activeCtx = sharedBrowserContext;
  (async () => {
    try {
      const openPages = activeCtx.pages().filter(p => !p.isClosed());
      // Keep at most GLOBAL_MAX_CONCURRENCY warm editor tabs open so the next batch or stream reuses them immediately!
      for (let i = GLOBAL_MAX_CONCURRENCY; i < openPages.length; i++) {
        if (!openPages[i]._inUseByWorker) {
          try { await openPages[i].close(); } catch {}
        }
      }
      // Do NOT delete workspace assets via cleanupCapCutCloudSpace while warm editor tabs are open or cached in IndexedDB,
      // because deleting synced template assets and deduplicated user uploads causes subsequent renders to reference trashed cloud assets!
    } catch {}
  })();
}

/**
 * Run N paired jobs IN PARALLEL across persistent non-throttled tabs inside our shared Chrome profile!
 * Reuses each open CapCut editor tab across consecutive videos without closing/reopening tabs or reloading the editor.
 */
async function runCapCutWebParallelBatch({
  templateInfo,
  batchFileSets = [],
  maxConcurrency = 5,
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
  const targetTemplateKey = String((templateInfo && templateInfo.templateId) || targetEditorUrl);

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
  const tplTitleDisplay = String((templateInfo && templateInfo.title) || (templateInfo && templateInfo.templateId) || 'CapCut').trim();
  if (existingCountAtStart > 0) {
    onLog(`🚀 Bắt đầu tạo ${totalJobs} video (ghi đè ${existingCountAtStart} video cũ) — Mẫu "${tplTitleDisplay}" (${concurrency} luồng song song)`);
  } else {
    onLog(`🚀 Bắt đầu tạo ${totalJobs} video — Mẫu "${tplTitleDisplay}" (${concurrency} luồng song song)`);
  }
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

  // Acquire or reuse an existing idle tab in sharedBrowserContext
  const acquireWorkerPage = async () => {
    const activeCtx = await getHealthySharedContext();
    if (controller.cancelled) return null;
    const openPages = activeCtx.pages().filter(p => !p.isClosed() && !p._inUseByWorker);
    // Prefer a tab already open on the same template, otherwise any idle tab
    let page =
      openPages.find(p => p._templateKey === targetTemplateKey && p.url().includes('capcut.com/editor-template')) ||
      openPages.find(p => p.url().includes('capcut.com/editor-template')) ||
      openPages[0] ||
      null;
    if (!page) {
      page = await activeCtx.newPage();
    }
    page._inUseByWorker = true;
    controller.pages.add(page);
    await hidePageWindowOffscreen(page);
    await enablePageMultiDownloads(page);
    return page;
  };

  const runJobOnPersistentPage = async (jobIdx, getOrResetPage) => {
    if (controller.cancelled) return null;
    const pairNum = jobIdx + 1;
    const fileSet = batchFileSets[jobIdx];
    const tag = `[Video #${pairNum}/${totalJobs}]`;
    const fileLabel = fileSet
      .map(f => path.basename(f).replace(/^p\d+_s\d+_/, '').replace(/^\d+_\d+_/, ''))
      .join(' + ');

    for (let workerTry = 1; workerTry <= 2; workerTry++) {
      if (controller.cancelled) return null;
      let watchdogTimer = null;
      let page = null;
      const attemptSignal = { aborted: false };
      try {
        page = await getOrResetPage(workerTry > 1);
        if (!page || controller.cancelled) return null;

        const checkAborted = () => {
          if (controller.cancelled) throw new Error('RENDER_CANCELLED');
          if (attemptSignal.aborted) throw new Error('ATTEMPT_ABORTED');
        };

        const executeAttempt = async () => {
          await hidePageWindowOffscreen(page);
          await enablePageMultiDownloads(page);

          jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 10);
          emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);

          const curUrl = page.url() || '';
          const isSameTemplateTab =
            workerTry === 1 &&
            page._templateKey === targetTemplateKey &&
            curUrl.includes('capcut.com/editor-template');

          let reusedInPlace = false;
          if (isSameTemplateTab) {
            reusedInPlace = await returnToEditorOnSameTab(page);
          }

          if (reusedInPlace) {
            onLog(`${tag} ♻️ Thay nguyên liệu mới trên tab sẵn có: ${fileLabel}`);
            await page.waitForTimeout(350);
          } else {
            onLog(`${tag} ${workerTry > 1 ? '[Thử lại] ' : ''}Đang mở mẫu & nạp nguyên liệu: ${fileLabel}`);
            await acquireEditorOpenGate();
            checkAborted();
            await page.goto(targetEditorUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });
            checkAborted();
            await page.waitForSelector('.segment-item[data-mutable-index], .segment-item input[type="file"]', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1200);
            page._lastUploadedFiles = null;
          }

          checkAborted();

          const filledCount = await fillTemplateSlotsOnEditor(
            page,
            fileSet,
            (m) => {
              if (!controller.cancelled && !attemptSignal.aborted) onLog(`${tag} ${m}`);
            },
            reusedInPlace ? page._lastUploadedFiles : null
          );
          checkAborted();
          if (filledCount === 0) {
            throw new Error(`${tag} Không tìm thấy các ô phân đoạn của mẫu.`);
          }

          page._templateKey = targetTemplateKey;
          page._lastUploadedFiles = Array.from({ length: filledCount }, (_, sIdx) => fileSet[sIdx % fileSet.length]);

          jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 25);
          emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);

          await page.waitForTimeout(500);
          checkAborted();

          const exportDialogReady = await openExportConfirmDialog(page);
          checkAborted();
          if (!exportDialogReady) {
            throw new Error(`${tag} Nút xuất video trên CapCut chưa sẵn sàng (có thể do 1 phân đoạn chưa tải xong).`);
          }

          jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 30);
          emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);
          onLog(`${tag} ⏳ Đang kết xuất (Render) MP4...`);

          const { folderName, dir: tplOutDir } = getTemplateOutputDir(templateInfo);
          const outFilename = buildOutputVideoFilename(pairNum, templateInfo, batchTimeTag);
          const outPath = path.join(tplOutDir, outFilename);

          await triggerExportAndSaveDownload({
            page,
            outPath,
            tag,
            onLog: (m) => {
              if (!controller.cancelled && !attemptSignal.aborted) onLog(m);
            },
            onRenderPercent: (pctInfo) => {
              if (controller.cancelled || attemptSignal.aborted) return;
              const numMatch = pctInfo.match(/(\d{1,3})/);
              if (numMatch) {
                const renderPct = Math.min(100, parseInt(numMatch[1], 10));
                jobProgress[jobIdx] = Math.max(jobProgress[jobIdx], 30 + Math.round(renderPct * 0.65));
              }
              emitMonotonicProgress(`Đang tạo ${totalJobs} video (Đã xong ${completedCount}/${totalJobs})...`);
            }
          });
          checkAborted();

          await syncOriginalTemplateAudio(outPath, templateInfo);

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
            onLog(`${tag} ✅ Hoàn tất (ghi đè): ${outFilename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
          } else {
            onLog(`${tag} ✅ Hoàn tất: ${outFilename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
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
              attemptSignal.aborted = true;
              reject(new Error(`${tag} Quá thời gian xử lý luồng (300s)`));
            }, 300000);
          })
        ]);

        if (watchdogTimer) clearTimeout(watchdogTimer);
        return results[jobIdx];
      } catch (err) {
        attemptSignal.aborted = true;
        if (watchdogTimer) clearTimeout(watchdogTimer);
        if (controller.cancelled || (err && err.message === 'RENDER_CANCELLED')) {
          return null;
        }
        if (page) {
          page._templateKey = null;
          page._lastUploadedFiles = null;
        }
        if (workerTry < 2) {
          onLog(`🔄 ${tag} Gặp sự cố (${err.message}), đang tự động làm mới lại tab để xuất lại Video #${pairNum}...`);
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
        allVerified = false;
        onLog(`❌ ${tag} Lỗi: ${err.message}`);
        return null;
      }
    }
    return null;
  };

  try {
    let nextJobIdx = 0;
    const workerPool = Array.from({ length: concurrency }, async (_, workerIdx) => {
      if (workerIdx > 0) {
        await new Promise(r => setTimeout(r, workerIdx * 450));
      }
      if (controller.cancelled) return;
      await acquireGlobalTabSlot(batchId);
      let workerPage = null;
      try {
        const getOrResetPage = async (forceReset = false) => {
          if (controller.cancelled) return null;
          if (!workerPage || workerPage.isClosed()) {
            workerPage = await acquireWorkerPage();
          } else if (forceReset) {
            workerPage._templateKey = null;
            workerPage._lastUploadedFiles = null;
          }
          return workerPage;
        };

        while (nextJobIdx < totalJobs && !controller.cancelled) {
          const myIdx = nextJobIdx++;
          await runJobOnPersistentPage(myIdx, getOrResetPage);
        }
      } finally {
        if (workerPage) {
          workerPage._inUseByWorker = false;
          controller.pages.delete(workerPage);
        }
        releaseGlobalTabSlot();
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


