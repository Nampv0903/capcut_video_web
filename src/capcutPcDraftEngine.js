const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { probeVideo } = require('./capcutAnalyzer');

const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

// Candidate paths where CapCut PC or JianYing stores Draft Projects
const CANDIDATE_DRAFT_DIRS = [
  path.join(LOCAL_APP_DATA, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'),
  path.join(LOCAL_APP_DATA, 'Bytedance', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'),
  path.join(LOCAL_APP_DATA, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'),
  path.join(os.homedir(), 'Documents', 'CapCut Drafts'),
  path.join(__dirname, '..', 'capcut_drafts')
];

// Candidate paths for CapCut.exe
const CANDIDATE_EXE_PATHS = [
  path.join(LOCAL_APP_DATA, 'CapCut', 'Apps', 'CapCut.exe'),
  path.join('C:\\Program Files\\CapCut', 'CapCut.exe'),
  path.join('C:\\Program Files (x86)\\CapCut', 'CapCut.exe')
];

const SLOT_PREP_DIR = path.join(__dirname, '..', 'cache', 'capcut_slots');
if (!fs.existsSync(SLOT_PREP_DIR)) {
  fs.mkdirSync(SLOT_PREP_DIR, { recursive: true });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', ...args], { maxBuffer: 25 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr ? stderr.slice(-500) : err.message));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Find CapCut.exe and active Drafts directory on the user's PC
 */
function detectCapCutPcEnvironment(customDraftDir = null) {
  let exePath = null;
  for (const p of CANDIDATE_EXE_PATHS) {
    if (fs.existsSync(p)) {
      exePath = p;
      break;
    }
  }

  // Also check if CapCut is currently running and get its path
  let draftDir = null;
  if (customDraftDir && fs.existsSync(customDraftDir)) {
    draftDir = customDraftDir;
  } else {
    // Check CapCut globalSetting config for custom draft path if present
    const globalSettingPath = path.join(LOCAL_APP_DATA, 'CapCut', 'User Data', 'Config', 'globalSetting');
    if (fs.existsSync(globalSettingPath)) {
      try {
        const raw = fs.readFileSync(globalSettingPath, 'utf8');
        const m = raw.match(/currentCustomDraftPath\s*=\s*([^\r\n]+)/);
        if (m && m[1] && fs.existsSync(m[1].trim())) {
          draftDir = m[1].trim();
        }
      } catch {}
    }

    if (!draftDir) {
      for (const d of CANDIDATE_DRAFT_DIRS) {
        if (fs.existsSync(d)) {
          draftDir = d;
          break;
        }
      }
    }
  }

  return {
    installed: Boolean(exePath || draftDir),
    exePath,
    draftDir: draftDir || CANDIDATE_DRAFT_DIRS[0]
  };
}

/**
 * Try parsing a JSON file safely (returns null if encrypted or invalid)
 */
function tryReadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      return null; // Encrypted binary/base64 draft_content.json in CapCut 6+
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Scan all CapCut PC Draft projects in the Drafts folder and inspect their slots, texts, effects, and transitions!
 */
async function listCapCutPcDrafts(customDraftDir = null) {
  const env = detectCapCutPcEnvironment(customDraftDir);
  const drafts = [];

  if (!fs.existsSync(env.draftDir)) {
    return { env, drafts };
  }

  const entries = fs.readdirSync(env.draftDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const folderPath = path.join(env.draftDir, entry.name);
    const contentPath = path.join(folderPath, 'draft_content.json');
    const infoPath = path.join(folderPath, 'draft_info.json');
    const metaPath = path.join(folderPath, 'draft_meta_info.json');

    if (!fs.existsSync(contentPath) && !fs.existsSync(infoPath) && !fs.existsSync(metaPath)) {
      continue;
    }

    const stat = fs.statSync(folderPath);
    const parsed = await inspectDraftFolder(folderPath, entry.name, stat.mtimeMs);
    if (parsed) {
      drafts.push(parsed);
    }
  }

  drafts.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { env, drafts };
}

/**
 * Inspect a single CapCut PC Draft folder to extract replaceable media slots, texts, transitions, and 3D effects
 */
async function inspectDraftFolder(folderPath, folderName = '', modifiedAt = Date.now()) {
  const contentPath = path.join(folderPath, 'draft_content.json');
  const infoPath = path.join(folderPath, 'draft_info.json');
  const metaPath = path.join(folderPath, 'draft_meta_info.json');

  // If we created a backup of the original unedited draft, inspect the backup to get clean slot metadata
  const sourceContentPath = fs.existsSync(`${contentPath}.orig_bak`) ? `${contentPath}.orig_bak` : contentPath;
  const sourceInfoPath = fs.existsSync(`${infoPath}.orig_bak`) ? `${infoPath}.orig_bak` : infoPath;
  const sourceMetaPath = fs.existsSync(`${metaPath}.orig_bak`) ? `${metaPath}.orig_bak` : metaPath;

  const contentJson = tryReadJson(sourceContentPath) || tryReadJson(sourceInfoPath);
  const metaJson = tryReadJson(sourceMetaPath);

  const draftName = (metaJson && metaJson.draft_name) || folderName || path.basename(folderPath);
  const coverPath = path.join(folderPath, 'draft_cover.jpg');

  const slots = [];
  const texts = [];
  let transitionsCount = 0;
  let effectsCount = 0;
  let isEncryptedContent = false;

  if (contentJson && contentJson.materials) {
    const mats = contentJson.materials;
    transitionsCount = Array.isArray(mats.transitions) ? mats.transitions.length : 0;
    effectsCount = (Array.isArray(mats.video_effects) ? mats.video_effects.length : 0) +
                   (Array.isArray(mats.material_animations) ? mats.material_animations.length : 0);

    // Extract text layers
    if (Array.isArray(mats.texts)) {
      for (const t of mats.texts) {
        let plainText = '';
        if (typeof t.content === 'string') {
          try {
            const cObj = JSON.parse(t.content);
            plainText = cObj.text || '';
          } catch {
            plainText = t.content.replace(/<[^>]+>/g, '');
          }
        }
        if (plainText.trim()) {
          texts.push({ id: t.id, text: plainText.trim() });
        }
      }
    }

    // Map video/photo materials to timeline segments
    const videoMap = new Map();
    if (Array.isArray(mats.videos)) {
      for (const v of mats.videos) {
        videoMap.set(v.id, v);
      }
    }

    const tracks = Array.isArray(contentJson.tracks) ? contentJson.tracks : [];
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const track = tracks[tIdx];
      if (track.type !== 'video') continue;
      const segments = Array.isArray(track.segments) ? track.segments : [];
      for (const seg of segments) {
        const mat = videoMap.get(seg.material_id);
        if (!mat || !mat.path) continue;
        // Skip internal CapCut system overlay assets if they are in CapCut AppData effect cache
        const normPath = String(mat.path).replace(/\\/g, '/');
        const durUs = (seg.target_timerange && seg.target_timerange.duration) || mat.duration || 3000000;
        const startUs = (seg.target_timerange && seg.target_timerange.start) || 0;
        const durSec = Number((durUs / 1000000).toFixed(2));
        const startSec = Number((startUs / 1000000).toFixed(2));

        slots.push({
          index: slots.length + 1,
          materialId: mat.id,
          segmentId: seg.id,
          trackIndex: tIdx,
          originalPath: mat.path,
          materialName: mat.material_name || path.basename( normPath ),
          type: mat.type || 'video',
          width: mat.width || 1080,
          height: mat.height || 1920,
          startTime: startSec,
          endTime: Number((startSec + durSec).toFixed(2)),
          duration: durSec
        });
      }
    }

    // Fallback if tracks didn't list segments but materials.videos has items
    if (slots.length === 0 && Array.isArray(mats.videos)) {
      let runningStart = 0;
      for (const mat of mats.videos) {
        if (!mat.path) continue;
        const durSec = Number(((mat.duration || 3000000) / 1000000).toFixed(2));
        slots.push({
          index: slots.length + 1,
          materialId: mat.id,
          originalPath: mat.path,
          materialName: mat.material_name || path.basename(String(mat.path)),
          type: mat.type || 'video',
          width: mat.width || 1080,
          height: mat.height || 1920,
          startTime: runningStart,
          endTime: Number((runningStart + durSec).toFixed(2)),
          duration: durSec
        });
        runningStart = Number((runningStart + durSec).toFixed(2));
      }
    }
  } else {
    isEncryptedContent = true;
    // Fallback: Read plain-JSON draft_meta_info.json (always unencrypted even in CapCut 6-9!)
    if (metaJson && Array.isArray(metaJson.draft_materials)) {
      let runningStart = 0;
      for (const group of metaJson.draft_materials) {
        if (!Array.isArray(group.value)) continue;
        for (const item of group.value) {
          const fp = item.file_Path || item.file_path || '';
          if (!fp || /\.(mp3|wav|aac|m4a)$/i.test(fp)) continue;
          const durSec = Number(((item.duration || 4000000) / 1000000).toFixed(2));
          slots.push({
            index: slots.length + 1,
            materialId: item.id || `meta_${slots.length + 1}`,
            originalPath: fp,
            materialName: item.extra_info || path.basename(fp),
            type: /\.(jpg|jpeg|png|webp)$/i.test(fp) ? 'photo' : 'video',
            width: item.width || 1080,
            height: item.height || 1920,
            startTime: runningStart,
            endTime: Number((runningStart + durSec).toFixed(2)),
            duration: durSec
          });
          runningStart = Number((runningStart + durSec).toFixed(2));
        }
      }
    }

    // Also scan sub-folders (e.g. Resources/ or materials/) inside folderPath if slots still empty
    if (slots.length === 0) {
      const mediaFiles = findMediaFilesInDir(folderPath);
      let runningStart = 0;
      for (const mf of mediaFiles) {
        const info = await probeVideo(mf);
        slots.push({
          index: slots.length + 1,
          materialId: `file_${slots.length + 1}`,
          originalPath: mf,
          materialName: path.basename(mf),
          type: info.isImage ? 'photo' : 'video',
          width: info.width || 1080,
          height: info.height || 1920,
          startTime: runningStart,
          endTime: Number((runningStart + info.duration).toFixed(2)),
          duration: Number(info.duration.toFixed(2))
        });
        runningStart = Number((runningStart + info.duration).toFixed(2));
      }
    }
  }

  const totalDuration = slots.reduce((acc, s) => acc + (Number(s.duration) || 0), 0);

  return {
    draftId: path.basename(folderPath),
    draftName,
    folderPath,
    hasCover: fs.existsSync(coverPath),
    isEncryptedContent,
    modifiedAt,
    totalDuration: Number(totalDuration.toFixed(2)),
    slotCount: slots.length,
    slots,
    texts,
    transitionsCount,
    effectsCount
  };
}

function findMediaFilesInDir(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return [];
  const results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of list) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      results.push(...findMediaFilesInDir(full, depth + 1));
    } else if (
      /\.(mp4|mov|jpg|jpeg|png|webp)$/i.test(ent.name) &&
      !ent.name.includes('draft_cover') &&
      !ent.name.endsWith('.orig_bak')
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Prepare a user's video or image to match the exact target slot duration & dimensions
 * so when injected into CapCut PC's draft_content.json (or disk path), keyframes/transitions/effects fit 100%!
 */
async function prepareMediaForCapCutSlot(userFilePath, targetSlot, index) {
  const isUserImg = /\.(jpg|jpeg|png|webp|bmp)$/i.test(userFilePath);
  const slotDur = Math.max(0.4, Number(targetSlot.duration) || 3.0);
  const targetW = targetSlot.width || 1080;
  const targetH = targetSlot.height || 1920;

  // If the original slot in CapCut was a photo AND user provided a photo, we can also prepare a high-res JPG
  // AND a prepared MP4 video of exact duration
  const outMp4 = path.join(SLOT_PREP_DIR, `cc_slot_${Date.now()}_${index}.mp4`);
  const inputInfo = await probeVideo(userFilePath);
  const inputArgs = [];

  if (isUserImg) {
    inputArgs.push('-loop', '1', '-framerate', '30');
  } else if (inputInfo.duration < slotDur + 0.1) {
    inputArgs.push('-stream_loop', '-1');
  }

  const vf = `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},setsar=1,fps=30`;
  await runFfmpeg([
    ...inputArgs,
    '-i', userFilePath,
    '-t', String(slotDur),
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    outMp4
  ]);

  return {
    preparedMp4Path: outMp4,
    originalUserPath: userFilePath,
    isUserImg,
    durationUs: Math.round(slotDur * 1000000),
    width: targetW,
    height: targetH
  };
}

/**
 * Inject user's videos/images into a CapCut PC Draft folder!
 * Works for BOTH plain JSON draft_content.json AND encrypted CapCut 6-9 drafts
 * (by backing up and replacing the referenced media files on disk + updating JSON files).
 */
async function injectMediaIntoCapCutDraft({
  folderPath,
  userFilePaths = [],
  textOverrides = {},
  autoLaunchCapCut = true,
  onLog = () => {}
}) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    throw new Error('Không tìm thấy thư mục Project nháp của CapCut PC!');
  }
  const envCheck = detectCapCutPcEnvironment();
  const resolvedFolder = path.resolve(folderPath);
  const allowedRoots = CANDIDATE_DRAFT_DIRS.concat(envCheck.draftDir ? [envCheck.draftDir] : []).map(d => path.resolve(d));
  const isInsideAllowedRoot = allowedRoots.some(root => resolvedFolder.startsWith(root + path.sep));
  if (!isInsideAllowedRoot) {
    throw new Error('Đường dẫn thư mục nháp không nằm trong vùng cho phép của CapCut PC!');
  }
  if (!userFilePaths || userFilePaths.length === 0) {
    throw new Error('Đại ca chưa chọn video hoặc ảnh để tráo vào Project CapCut PC!');
  }

  onLog(`Đang đọc cấu trúc Project CapCut PC tại: ${folderPath}`);
  const draftInfo = await inspectDraftFolder(folderPath, path.basename(folderPath));
  if (!draftInfo || draftInfo.slots.length === 0) {
    throw new Error('Project CapCut PC này chưa có phân đoạn video/ảnh nào để thay thế!');
  }

  const contentPath = path.join(folderPath, 'draft_content.json');
  const infoPath = path.join(folderPath, 'draft_info.json');
  const metaPath = path.join(folderPath, 'draft_meta_info.json');

  // 1. Backup original JSON files once so we never lose original template structure
  for (const p of [contentPath, infoPath, metaPath]) {
    if (fs.existsSync(p) && !fs.existsSync(`${p}.orig_bak`)) {
      fs.copyFileSync(p, `${p}.orig_bak`);
    }
  }

  // 2. Prepare each user media file to match each slot's exact duration & dimensions
  const preparedSlots = [];
  for (let i = 0; i < draftInfo.slots.length; i++) {
    const slot = draftInfo.slots[i];
    const userFile = userFilePaths[i % userFilePaths.length];
    onLog(`Đang chuẩn hóa file "${path.basename(userFile)}" khớp vào Đoạn #${i + 1} (${slot.duration}s)...`);
    const prep = await prepareMediaForCapCutSlot(userFile, slot, i + 1);
    preparedSlots.push({ slot, prep });

    // Also replace the file on disk at slot.originalPath (after backing up original file once!)
    // This guarantees that EVEN IF CapCut 9.x encrypted draft_content.json, CapCut loads the new media!
    if (slot.originalPath && fs.existsSync(slot.originalPath)) {
      try {
        const bakMedia = `${slot.originalPath}.orig_bak`;
        if (!fs.existsSync(bakMedia)) {
          fs.copyFileSync(slot.originalPath, bakMedia);
        }
        const origExt = path.extname(slot.originalPath).toLowerCase();
        if (origExt === '.jpg' || origExt === '.jpeg' || origExt === '.png' || origExt === '.webp') {
          if (prep.isUserImg) {
            fs.copyFileSync(userFile, slot.originalPath);
          } else {
            // Extract first frame as image if slot on disk is strictly an image path
            await runFfmpeg(['-i', userFile, '-frames:v', '1', slot.originalPath]);
          }
        } else {
          fs.copyFileSync(prep.preparedMp4Path, slot.originalPath);
        }
        onLog(`✓ Đã tráo trực tiếp file nguồn của Đoạn #${i + 1} trên ổ cứng.`);
      } catch (diskErr) {
        onLog(`Lưu ý ghi đè file gốc: ${diskErr.message}`);
      }
    }
  }

  // 3. Update draft_content.json and draft_info.json if they are plain JSON
  for (const jsonPath of [contentPath, infoPath]) {
    const backupOrFile = fs.existsSync(`${jsonPath}.orig_bak`) ? `${jsonPath}.orig_bak` : jsonPath;
    const data = tryReadJson(backupOrFile);
    if (!data || !data.materials) continue;

    if (Array.isArray(data.materials.videos)) {
      for (const item of preparedSlots) {
        const mat = data.materials.videos.find(v => v.id === item.slot.materialId);
        if (mat) {
          mat.path = item.prep.preparedMp4Path.replace(/\\/g, '/');
          mat.material_name = path.basename(item.prep.originalUserPath);
          mat.type = 'video';
          mat.width = item.prep.width;
          mat.height = item.prep.height;
          mat.duration = item.prep.durationUs;
        }
      }
    }

    // Update source_timerange in tracks so it matches target_timerange
    if (Array.isArray(data.tracks)) {
      for (const track of data.tracks) {
        if (track.type !== 'video' || !Array.isArray(track.segments)) continue;
        for (const seg of track.segments) {
          if (seg.target_timerange && seg.source_timerange) {
            seg.source_timerange.start = 0;
            seg.source_timerange.duration = seg.target_timerange.duration;
          }
        }
      }
    }

    // Apply any optional text overrides
    if (textOverrides && Object.keys(textOverrides).length > 0 && Array.isArray(data.materials.texts)) {
      for (const t of data.materials.texts) {
        if (textOverrides[t.id] !== undefined) {
          try {
            const cObj = JSON.parse(t.content);
            cObj.text = textOverrides[t.id];
            t.content = JSON.stringify(cObj);
          } catch {
            t.content = textOverrides[t.id];
          }
        }
      }
    }

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    onLog(`✓ Đã cập nhật cấu trúc ${path.basename(jsonPath)} (Giữ nguyên 100% chữ, hiệu ứng 3D & chuyển cảnh của mẫu)!`);
  }

  // 4. Update draft_meta_info.json timestamp so it floats to the top of CapCut PC's project list
  const metaData = tryReadJson(metaPath);
  if (metaData) {
    metaData.tm_draft_modified = Date.now() * 1000;
    fs.writeFileSync(metaPath, JSON.stringify(metaData), 'utf8');
  }

  // 5. Optionally launch CapCut PC so the user can export in 1 click (or trigger Ctrl+E)
  const env = detectCapCutPcEnvironment();
  if (autoLaunchCapCut && env.exePath) {
    onLog(`Đang mở CapCut PC (${env.exePath}) để đại ca xuất video với đầy đủ hiệu ứng gốc...`);
    const child = spawn(env.exePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  return {
    success: true,
    draftName: draftInfo.draftName,
    folderPath,
    replacedSlots: preparedSlots.length,
    transitionsPreserved: draftInfo.transitionsCount,
    effectsPreserved: draftInfo.effectsCount,
    textsPreserved: draftInfo.texts.length
  };
}

/**
 * Open a CapCut Template URL directly inside CapCut PC Desktop App via capcut:// deep link protocol
 */
function openTemplateInCapCutPcApp(templateUrlOrId, onLog = () => {}) {
  const idMatch = String(templateUrlOrId || '').match(/(\d{10,25})/);
  if (!idMatch) {
    throw new Error('Link hoặc ID mẫu CapCut không hợp lệ (Cần chứa mã số mẫu CapCut)!');
  }
  const templateId = idMatch[1];

  // CapCut PC supports deep links via capcut:// protocol
  const deepLink = `capcut://template/detail?template_id=${templateId}`;
  onLog(`Đang gọi giao thức mở thẳng mẫu #${templateId} trong App CapCut PC: ${deepLink}`);
  execFile('cmd.exe', ['/c', 'start', '', deepLink]);
  return { success: true, deepLink, templateId };
}

module.exports = {
  detectCapCutPcEnvironment,
  listCapCutPcDrafts,
  inspectDraftFolder,
  injectMediaIntoCapCutDraft,
  openTemplateInCapCutPcApp
};
