const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { probeVideo, CACHE_DIR } = require('./capcutAnalyzer');

const OUTPUT_DIR = path.join(__dirname, '..', 'outputs');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const TEMP_DIR = path.join(__dirname, '..', 'cache', 'temp');

for (const dir of [OUTPUT_DIR, UPLOAD_DIR, TEMP_DIR, CACHE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', ...args], { maxBuffer: 25 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr ? stderr.slice(-600) : err.message));
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Stabilize a shaky user video using 2-pass FFmpeg vidstabdetect + vidstabtransform (enabled by default!)
 */
async function stabilizeVideoFile(filePath, level = 'recommended', onLog = () => {}) {
  if (!filePath || filePath === 'KEEP_TEMPLATE_ORIGINAL' || !fs.existsSync(filePath)) {
    return filePath;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.heic', '.heif', '.jfif', '.avif', '.tif', '.tiff'].includes(ext)) {
    return filePath; // Static images don't need stabilization
  }

  const markerPath = path.join(TEMP_DIR, `${path.basename(filePath)}.stab_${level}.done`);
  if (fs.existsSync(markerPath)) {
    return filePath;
  }

  let shakiness = 7;
  let smoothing = 15;
  if (level === 'minimal') {
    shakiness = 5;
    smoothing = 10;
  } else if (level === 'most_stable') {
    shakiness = 10;
    smoothing = 28;
  }

  const trfFilename = `trf_${Date.now()}_${Math.floor(Math.random() * 10000)}.trf`;
  const trfFullPath = path.join(TEMP_DIR, trfFilename);
  const tempOutPath = path.join(TEMP_DIR, `stab_out_${Date.now()}_${path.basename(filePath)}`);

  try {
    onLog(`🎥 Đang tự động Chống Rung Video (Optical-Flow 2-Pass [${level}]) cho: ${path.basename(filePath).replace(/^\d+_\d+_/, '')}...`);

    // Pass 1: Detect motion vectors
    await runFfmpeg([
      '-i', filePath,
      '-vf', `vidstabdetect=shakiness=${shakiness}:accuracy=15:result=${trfFilename}`,
      '-f', 'null',
      '-'
    ], { cwd: TEMP_DIR });

    // Pass 2: Smooth camera trajectory & sharpen bicubic interpolation
    await runFfmpeg([
      '-i', filePath,
      '-vf', `vidstabtransform=smoothing=${smoothing}:input=${trfFilename}:interpol=bicubic:crop=black,unsharp=5:5:0.8:3:3:0.4`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      tempOutPath
    ], { cwd: TEMP_DIR });

    if (fs.existsSync(tempOutPath) && fs.statSync(tempOutPath).size > 1000) {
      fs.copyFileSync(tempOutPath, filePath);
      fs.writeFileSync(markerPath, String(Date.now()), 'utf8');
      onLog(`✅ Đã chống rung mượt mà xong cho video: ${path.basename(filePath).replace(/^\d+_\d+_/, '')}`);
    }
  } catch (err) {
    onLog(`Lưu ý chống rung (${path.basename(filePath)}): ${err.message}`);
  } finally {
    try { if (fs.existsSync(trfFullPath)) fs.unlinkSync(trfFullPath); } catch {}
    try { if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath); } catch {}
  }

  return filePath;
}

/**
 * Check if a media file has an audio stream
 */
function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve(false);
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath
    ], (err, stdout) => {
      if (err) return resolve(false);
      resolve((stdout || '').trim().length > 0);
    });
  });
}

/**
 * Render user videos into a CapCut template structure (slots + template audio + beat effects)
 */
async function renderWithFfmpegEngine({
  templateInfo,
  videoFilePaths,
  effectPreset = 'flash_zoom', // 'flash_zoom' | 'flash' | 'zoom_punch' | 'clean'
  aspectRatio = '9:16',        // '9:16' | '16:9' | '1:1'
  customAudioPath = null,
  onLog = () => {},
  onProgress = () => {}
}) {
  if (!videoFilePaths || videoFilePaths.length === 0) {
    throw new Error('Vui lòng chọn video hoặc ảnh nguyên liệu để ghép vào mẫu!');
  }

  const slots = (templateInfo && Array.isArray(templateInfo.slots) && templateInfo.slots.length > 0)
    ? templateInfo.slots
    : [
        { index: 1, duration: 2.0 },
        { index: 2, duration: 1.5 },
        { index: 3, duration: 1.5 },
        { index: 4, duration: 2.0 },
        { index: 5, duration: 2.0 }
      ];

  let targetW = 1080;
  let targetH = 1920;
  if (aspectRatio === '16:9') {
    targetW = 1920;
    targetH = 1080;
  } else if (aspectRatio === '1:1') {
    targetW = 1080;
    targetH = 1080;
  }

  const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const segmentFiles = [];

  onLog(`Bắt đầu cắt & đồng bộ ${slots.length} phân đoạn theo mẫu "${templateInfo.title || 'CapCut Template'}"...`);
  onProgress(15, `Chuẩn bị xử lý ${slots.length} phân đoạn theo nhịp mẫu...`);

  try {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const slotDuration = Math.max(0.35, Math.min(120, Number(slot.duration) || 2.0));
      const slotStart = Number(slot.startTime) || 0;
      const inputVideo = videoFilePaths[i % videoFilePaths.length];
      const segPath = path.join(TEMP_DIR, `${jobId}_seg_${i}.mp4`);

      // Option: Keep original segment from the CapCut template video (preserving 100% original text/lyrics/intro!)
      if (
        inputVideo === 'KEEP_TEMPLATE_ORIGINAL' &&
        templateInfo &&
        templateInfo.localVideoPath &&
        fs.existsSync(templateInfo.localVideoPath)
      ) {
        const vfOrig = `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},setsar=1,fps=30`;
        await runFfmpeg([
          '-ss', String(slotStart),
          '-t', String(slotDuration),
          '-i', templateInfo.localVideoPath,
          '-vf', vfOrig,
          '-an',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '20',
          '-pix_fmt', 'yuv420p',
          segPath
        ]);
        segmentFiles.push(segPath);
        const pct = 15 + Math.round(((i + 1) / slots.length) * 60);
        onProgress(pct, `Đã giữ nguyên phân đoạn gốc #${i + 1}/${slots.length} (${slotDuration}s)...`);
        onLog(`✓ Phân đoạn #${i + 1} (${slotDuration}s) -> Giữ nguyên cảnh & chữ gốc từ mẫu CapCut`);
        continue;
      }

      // Probe input media (supports both Video and Image files!)
      const isImageFile = /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(inputVideo);
      const inputInfo = await probeVideo(inputVideo);
      const inputArgs = [];
      if (isImageFile) {
        inputArgs.push('-loop', '1', '-framerate', '30');
      } else if (inputInfo.duration < slotDuration + 0.2) {
        inputArgs.push('-stream_loop', '-1');
      }

      // Build video filter for aspect ratio + CapCut-style dynamic motion & transition flash
      // On images or flash_zoom, apply smooth dynamic zoom/pan + white flash at cut entrance + smooth fade transition
      const overscaleW = Math.round(targetW * 1.12);
      const overscaleH = Math.round(targetH * 1.12);
      let vfChain = `scale=${ targetW }:${ targetH }:force_original_aspect_ratio=increase,crop=${ targetW }:${ targetH },setsar=1,fps=30`;

      if (effectPreset === 'flash_zoom') {
        // Smooth progressive zoom-in across slotDuration + bright white flash in first 0.22s of cut
        vfChain = `scale=${overscaleW}:${overscaleH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}:'(iw-ow)/2 + sin(t*1.8)*8':'(ih-oh)/2 + cos(t*1.5)*8',setsar=1,fps=30,eq=brightness='if(lt(t,0.22),0.45*(1-t/0.22),0)':contrast='if(lt(t,0.22),1.18,1.0)':eval=frame`;
      } else if (effectPreset === 'flash') {
        vfChain = `${vfChain},eq=brightness='if(lt(t,0.22),0.48*(1-t/0.22),0)':eval=frame`;
      } else if (effectPreset === 'zoom_punch') {
        vfChain = `scale=${overscaleW}:${overscaleH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}:'(iw-ow)/2 + if(lt(t,0.25),sin(t*90)*16,sin(t*2)*6)':'(ih-oh)/2 + if(lt(t,0.25),cos(t*90)*16,cos(t*2)*6)',setsar=1,fps=30,eq=brightness='if(lt(t,0.18),0.35*(1-t/0.18),0)':eval=frame`;
      }

      await runFfmpeg([
        ...inputArgs,
        '-i', inputVideo,
        '-t', String(slotDuration),
        '-vf', vfChain,
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        segPath
      ]);

      segmentFiles.push(segPath);
      const pct = 15 + Math.round(((i + 1) / slots.length) * 60);
      onProgress(pct, `Đã xử lý phân đoạn ${i + 1}/${slots.length} (${slotDuration}s)...`);
      onLog(`✓ Phân đoạn #${i + 1} (${slotDuration}s) -> Đã khớp nhịp beat & hiệu ứng [${effectPreset}]`);
    }

    // Create concat list file
    const concatListPath = path.join(TEMP_DIR, `${jobId}_list.txt`);
    const listContent = segmentFiles
      .map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(concatListPath, listContent, 'utf8');

    const totalDuration = slots.reduce((acc, s) => acc + (Number(s.duration) || 2.0), 0);
    const outFilename = `capcut_auto_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, outFilename);

    onProgress(82, 'Đang ghép nối toàn bộ phân đoạn & lồng nhạc gốc của mẫu CapCut...');
    onLog('Đang ghép nối các phân đoạn và lồng nhạc nền của mẫu CapCut...');

    // Determine audio source:
    // 1. Custom uploaded audio if provided
    // 2. Template's original local video audio if present
    // 3. First user video's audio if present
    // 4. Otherwise synthesize an energetic beat audio track
    let audioSourcePath = null;
    if (customAudioPath && await hasAudioStream(customAudioPath)) {
      audioSourcePath = customAudioPath;
    } else if (templateInfo && templateInfo.localVideoPath && await hasAudioStream(templateInfo.localVideoPath)) {
      audioSourcePath = templateInfo.localVideoPath;
    } else if (await hasAudioStream(videoFilePaths[0])) {
      audioSourcePath = videoFilePaths[0];
    }

    if (audioSourcePath) {
      await runFfmpeg([
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-stream_loop', '-1',
        '-i', audioSourcePath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-t', String(totalDuration.toFixed(2)),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outPath
      ]);
    } else {
      // Synthesize a clean upbeat bass/synth audio track so output always has sound
      await runFfmpeg([
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-f', 'lavfi',
        '-i', `aevalsrc='0.25*sin(2*PI*110*t)*exp(-4*mod(t,0.5))+0.15*sin(2*PI*220*t)*exp(-2*mod(t,0.25))':s=44100:d=${totalDuration.toFixed(2)}`,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-t', String(totalDuration.toFixed(2)),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outPath
      ]);
    }

    // Cleanup temp files
    for (const f of [...segmentFiles, concatListPath]) {
      try { fs.unlinkSync(f); } catch {}
    }

    onProgress(100, 'Hoàn tất xuất video chuẩn mẫu CapCut!');
    onLog(`🎉 Xuất thành công video: ${outFilename} (${totalDuration.toFixed(1)}s, ${targetW}x${targetH})`);

    return {
      success: true,
      engine: 'ffmpeg_beat_clone',
      filename: outFilename,
      url: `/outputs/${outFilename}`,
      filePath: outPath,
      duration: Number(totalDuration.toFixed(2)),
      slotCount: slots.length
    };
  } catch (err) {
    for (const f of segmentFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    throw err;
  }
}

/**
 * Generate built-in starter CapCut templates AND optional demo user clips
 * so the user can test immediately or pick from pre-configured beat templates!
 */
const BUILTIN_TEMPLATES = [
  {
    templateId: 'cc_trend_beat_01',
    title: 'Mẫu CapCut Giật Nhịp Bass Cực Căng (TikTok Trend 6 Đoạn)',
    originalUrl: 'https://www.capcut.com/templates/cc_trend_beat_01',
    canUseOnWeb: true,
    totalDuration: 7.2,
    width: 1080,
    height: 1920,
    slotCount: 6,
    slots: [
      { index: 1, startTime: 0.0, endTime: 1.8, duration: 1.8 },
      { index: 2, startTime: 1.8, endTime: 2.7, duration: 0.9 },
      { index: 3, startTime: 2.7, endTime: 3.6, duration: 0.9 },
      { index: 4, startTime: 3.6, endTime: 4.5, duration: 0.9 },
      { index: 5, startTime: 4.5, endTime: 5.7, duration: 1.2 },
      { index: 6, startTime: 5.7, endTime: 7.2, duration: 1.5 }
    ]
  },
  {
    templateId: 'cc_cinematic_reel_02',
    title: 'Mẫu CapCut Vlog / Cinematic Chuyển Cảnh Nhanh (5 Đoạn)',
    originalUrl: 'https://www.capcut.com/templates/cc_cinematic_reel_02',
    canUseOnWeb: true,
    totalDuration: 8.0,
    width: 1080,
    height: 1920,
    slotCount: 5,
    slots: [
      { index: 1, startTime: 0.0, endTime: 2.0, duration: 2.0 },
      { index: 2, startTime: 2.0, endTime: 3.5, duration: 1.5 },
      { index: 3, startTime: 3.5, endTime: 4.8, duration: 1.3 },
      { index: 4, startTime: 4.8, endTime: 6.3, duration: 1.5 },
      { index: 5, startTime: 6.3, endTime: 8.0, duration: 1.7 }
    ]
  },
  {
    templateId: 'cc_flash_speed_03',
    title: 'Mẫu CapCut Biến Hình Speed-Ramp Nháy Flash (8 Đoạn)',
    originalUrl: 'https://www.capcut.com/templates/cc_flash_speed_03',
    canUseOnWeb: true,
    totalDuration: 6.8,
    width: 1080,
    height: 1920,
    slotCount: 8,
    slots: [
      { index: 1, startTime: 0.0, endTime: 1.6, duration: 1.6 },
      { index: 2, startTime: 1.6, endTime: 2.2, duration: 0.6 },
      { index: 3, startTime: 2.2, endTime: 2.8, duration: 0.6 },
      { index: 4, startTime: 2.8, endTime: 3.4, duration: 0.6 },
      { index: 5, startTime: 3.4, endTime: 4.0, duration: 0.6 },
      { index: 6, startTime: 4.0, endTime: 4.8, duration: 0.8 },
      { index: 7, startTime: 4.8, endTime: 5.6, duration: 0.8 },
      { index: 8, startTime: 5.6, endTime: 6.8, duration: 1.2 }
    ]
  }
];

async function ensureBuiltinTemplateVideos() {
  const colors = ['#0f172a', '#1e1b4b', '#311042', '#064e3b', '#3b0764', '#172554', '#3f1d38', '#111827'];
  for (const tpl of BUILTIN_TEMPLATES) {
    const filename = `template_${tpl.templateId}.mp4`;
    const fullPath = path.join(CACHE_DIR, filename);
    tpl.localVideoUrl = `/cache/templates/${filename}`;
    tpl.localVideoPath = fullPath;

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 5000) {
      continue;
    }

    // Build a quick multi-scene preview video with beat audio for this template
    const segPaths = [];
    for (let i = 0; i < tpl.slots.length; i++) {
      const slot = tpl.slots[i];
      const seg = path.join(TEMP_DIR, `init_${tpl.templateId}_${i}.mp4`);
      const color = colors[i % colors.length];
      await runFfmpeg([
        '-f', 'lavfi',
        '-i', `color=c=${color}:s=540x960:r=30:d=${slot.duration}`,
        '-vf', `eq=brightness='if(lt(t,0.12),0.35*(1-t/0.12),0)':eval=frame`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        seg
      ]);
      segPaths.push(seg);
    }

    const listFile = path.join(TEMP_DIR, `init_${tpl.templateId}_list.txt`);
    fs.writeFileSync(listFile, segPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

    await runFfmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-f', 'lavfi',
      '-i', `aevalsrc='0.3*sin(2*PI*95*t)*exp(-5*mod(t,0.45))+0.18*sin(2*PI*190*t)*exp(-3*mod(t,0.225))':s=44100:d=${tpl.totalDuration}`,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-t', String(tpl.totalDuration),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      fullPath
    ]);

    for (const f of [...segPaths, listFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
  return BUILTIN_TEMPLATES;
}

/**
 * Generate 5 colorful demo user clips on demand so the user can test the workflow in 1 click
 */
async function generateDemoUserClips() {
  const clips = [];
  const palettes = [
    { name: 'clip_demo_1_neon_city.mp4', filter: 'testsrc2=s=720x1280:r=30:d=4,hue=h=200:s=1.5' },
    { name: 'clip_demo_2_cyber_wave.mp4', filter: 'testsrc2=s=720x1280:r=30:d=4,hue=h=290:s=1.8' },
    { name: 'clip_demo_3_emerald_pulse.mp4', filter: 'testsrc2=s=720x1280:r=30:d=4,hue=h=140:s=1.6' },
    { name: 'clip_demo_4_sunset_drive.mp4', filter: 'testsrc2=s=720x1280:r=30:d=4,hue=h=30:s=1.7' },
    { name: 'clip_demo_5_violet_storm.mp4', filter: 'testsrc2=s=720x1280:r=30:d=4,hue=h=250:s=1.9' },
    { name: 'clip_demo_6_gold_flash.mp4', filter: 'testsrc2=s=720x1280:r=30:d=4,hue=h=55:s=1.7' }
  ];

  for (const item of palettes) {
    const filePath = path.join(UPLOAD_DIR, item.name);
    if (!fs.existsSync(filePath)) {
      await runFfmpeg([
        '-f', 'lavfi',
        '-i', item.filter,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        filePath
      ]);
    }
    const stat = fs.statSync(filePath);
    clips.push({
      id: item.name,
      originalName: item.name,
      filename: item.name,
      url: `/uploads/${item.name}`,
      filePath,
      size: stat.size,
      duration: 4.0
    });
  }
  return clips;
}

module.exports = {
  renderWithFfmpegEngine,
  stabilizeVideoFile,
  ensureBuiltinTemplateVideos,
  generateDemoUserClips,
  BUILTIN_TEMPLATES,
  OUTPUT_DIR,
  UPLOAD_DIR
};
