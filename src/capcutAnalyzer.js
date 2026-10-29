const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'templates');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function isBlockedInternalHost(hostname) {
  const h = String(hostname || '').toLowerCase().trim();
  if (!h || h === 'localhost' || h === '[::1]' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  return false;
}

function assertValidCapCutUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Đường link mẫu không hợp lệ!');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Chỉ chấp nhận đường link bảo mật https:// từ CapCut!');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'capcut.com' && !host.endsWith('.capcut.com')) {
    throw new Error('Chỉ chấp nhận đường link mẫu chính thức thuộc tên miền capcut.com!');
  }
  return parsed.toString();
}

/**
 * Helper to download a remote file (like template preview video or cover)
 */
function downloadFile(url, destPath, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 5) {
      return reject(new Error('Too many redirects'));
    }
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch {
      return reject(new Error('Invalid URL'));
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || isBlockedInternalHost(parsed.hostname)) {
      return reject(new Error('Blocked URL host'));
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.capcut.com/'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, parsed).toString();
        return downloadFile(nextUrl, destPath, redirectDepth + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Get media duration and dimensions using ffprobe
 */
function probeVideo(filePath) {
  return new Promise((resolve) => {
    const isImage = /\.(jpg|jpeg|png|webp|bmp|gif|heic|heif|jfif|avif|tif|tiff)$/i.test(filePath);
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration:format=duration',
      '-of', 'json',
      filePath
    ], (err, stdout) => {
      if (err) return resolve({ duration: isImage ? 5 : 10, width: 1080, height: 1920, isImage });
      try {
        const data = JSON.parse(stdout);
        const stream = (data.streams && data.streams[0]) || {};
        const format = data.format || {};
        const rawDur = parseFloat(stream.duration || format.duration || (isImage ? '5' : '10'));
        const duration = isImage ? 5.0 : (isNaN(rawDur) || rawDur <= 0 ? 10 : rawDur);
        const width = parseInt(stream.width || '1080', 10);
        const height = parseInt(stream.height || '1920', 10);
        resolve({ duration, width, height, isImage });
      } catch {
        resolve({ duration: isImage ? 5 : 10, width: 1080, height: 1920, isImage });
      }
    });
  });
}

/**
 * Use FFmpeg scene cut detection (scdet) on a template preview video
 * to automatically find exact cut points and segment durations!
 * When expectedSlots (> 0) is provided by CapCut's metadata (e.g. segmentAmount = 2),
 * it picks the top (expectedSlots - 1) strongest scene transitions so the slot count
 * ALWAYS matches the template's exact segment count!
 */
function detectSceneSlotsFromVideo(videoPath, expectedSlots = 0) {
  return new Promise(async (resolve) => {
    const info = await probeVideo(videoPath);
    const totalDuration = info.duration || 10;

    if (expectedSlots === 1) {
      return resolve({
        totalDuration: Number(totalDuration.toFixed(2)),
        width: info.width,
        height: info.height,
        slots: [{
          index: 1,
          startTime: 0,
          endTime: Number(totalDuration.toFixed(2)),
          duration: Number(totalDuration.toFixed(2))
        }]
      });
    }

    execFile('ffmpeg', [
      '-i', videoPath,
      '-vf', 'scdet=threshold=2:sc_pass=1',
      '-an',
      '-f', 'null',
      '-'
    ], { maxBuffer: 15 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stderr || '') + '\n' + (stdout || '');
      const candidates = [];
      const regex = /lavfi\.scd\.score:\s*([0-9.]+),\s*lavfi\.scd\.time:\s*([0-9.]+)/g;
      let match;
      while ((match = regex.exec(output)) !== null) {
        const score = parseFloat(match[1]);
        const time = parseFloat(match[2]);
        if (!isNaN(time) && !isNaN(score) && time > 0.35 && time < totalDuration - 0.35) {
          candidates.push({ time: Number(time.toFixed(2)), score });
        }
      }

      // Filter candidates that are too close to each other (keep higher score within 0.45s window)
      candidates.sort((a, b) => b.score - a.score);
      const distinctCuts = [];
      for (const c of candidates) {
        if (distinctCuts.every(existing => Math.abs(existing.time - c.time) >= 0.45)) {
          distinctCuts.push(c);
        }
      }

      let chosenTimes = [];

      if (expectedSlots > 1) {
        const neededCuts = expectedSlots - 1;
        // Take the top neededCuts highest-scoring scene changes
        const topCuts = distinctCuts.slice(0, neededCuts).map(c => c.time);

        // If the video had fewer detectable cuts than neededCuts (e.g. very smooth dissolve),
        // fill remaining cuts by splitting the longest segment(s)
        topCuts.sort((a, b) => a - b);
        while (topCuts.length < neededCuts) {
          const pts = [0, ...topCuts, Number(totalDuration.toFixed(2))];
          let maxGap = -1;
          let maxIdx = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const gap = pts[i + 1] - pts[i];
            if (gap > maxGap) {
              maxGap = gap;
              maxIdx = i;
            }
          }
          const mid = Number(((pts[maxIdx] + pts[maxIdx + 1]) / 2).toFixed(2));
          topCuts.push(mid);
          topCuts.sort((a, b) => a - b);
        }
        chosenTimes = topCuts;
      } else {
        // No expectedSlots known -> use strong scene cuts (score >= 7.5)
        chosenTimes = distinctCuts
          .filter(c => c.score >= 7.5)
          .map(c => c.time)
          .sort((a, b) => a - b);

        // If still 0 cuts found on an unknown template, split into 2 segments at midpoint
        if (chosenTimes.length === 0) {
          chosenTimes = [Number((totalDuration / 2).toFixed(2))];
        }
      }

      const cutPoints = [0, ...chosenTimes, Number(totalDuration.toFixed(2))];
      const slots = [];
      for (let i = 0; i < cutPoints.length - 1; i++) {
        const start = Number(cutPoints[i].toFixed(2));
        const end = Number(cutPoints[i + 1].toFixed(2));
        const dur = Number(Math.max(0.3, end - start).toFixed(2));
        slots.push({
          index: i + 1,
          startTime: start,
          endTime: end,
          duration: dur
        });
      }

      resolve({
        totalDuration: Number(totalDuration.toFixed(2)),
        width: info.width,
        height: info.height,
        slots
      });
    });
  });
}

/**
 * Analyze a CapCut template URL using Chrome headless via Playwright
 * Extracts template ID, title, author, video URL, cover URL, exact segmentAmount,
 * downloads the template preview video locally, and finds exact cut timestamps.
 */
async function analyzeCapCutTemplate(templateUrl, onLog = () => {}) {
  const safeInputUrl = assertValidCapCutUrl(templateUrl);
  let decodedUrl = safeInputUrl;
  try {
    decodedUrl = decodeURIComponent(safeInputUrl);
  } catch {}

  let templateId = null;
  const idMatch = decodedUrl.match(/create_id=(\d{10,})/) ||
                  decodedUrl.match(/template_id=(\d{10,})/) ||
                  decodedUrl.match(/templates\/(\d{10,})/) ||
                  decodedUrl.match(/template-detail\/[^/?]*?(\d{10,})/) ||
                  decodedUrl.match(/\/(\d{15,})/);
  if (idMatch) {
    templateId = idMatch[1];
  }

  // If the user pasted a /login?redirect_url=... or /editor-template?create_id=... link, normalize to /template-detail/<id> so metadata and preview video load without requiring login!
  let targetAnalyzeUrl = safeInputUrl;
  if (templateId && (safeInputUrl.includes('/login') || safeInputUrl.includes('/editor-template'))) {
    targetAnalyzeUrl = `https://www.capcut.com/template-detail/${templateId}`;
  }

  onLog(`Đang mở và phân tích link mẫu CapCut: ${targetAnalyzeUrl}`);

  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--mute-audio']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 800 },
      locale: 'vi-VN'
    });
    const page = await context.newPage();

    const capturedVideoUrls = [];

    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (ct.includes('video/mp4') || url.includes('.mp4') || url.includes('v16-webapp') || url.includes('capcutvod')) {
        if (url.startsWith('http') && !url.includes('background')) {
          capturedVideoUrls.push(url);
        }
      }
    });

    await page.goto(targetAnalyzeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    if (!templateId) {
      const finalMatch = finalUrl.match(/template_id=(\d+)/) ||
                         finalUrl.match(/templates\/(\d+)/) ||
                         finalUrl.match(/template-detail\/[^/?]*?(\d{10,})/) ||
                         finalUrl.match(/\/(\d{15,})/);
      if (finalMatch) templateId = finalMatch[1];
    }

    // Extract structured templateDetail directly from window._ROUTER_DATA / _SSR_DATA and DOM
    const pageData = await page.evaluate(() => {
      const result = {
        title: document.title || '',
        h1: '',
        videoSrc: '',
        posterSrc: '',
        slotCountText: '',
        canUseOnWeb: false,
        editorUrl: '',
        routerTemplateDetail: null
      };

      const h1El = document.querySelector('h1');
      if (h1El) result.h1 = h1El.innerText.trim();

      const videoEl = document.querySelector('video');
      if (videoEl) {
        result.videoSrc = videoEl.currentSrc || videoEl.src || '';
        result.posterSrc = videoEl.poster || '';
        if (!result.videoSrc) {
          const sourceEl = videoEl.querySelector('source');
          if (sourceEl) result.videoSrc = sourceEl.src;
        }
      }

      // Check for "Use template" / "Sử dụng mẫu" button
      const buttons = Array.from(document.querySelectorAll('button, a'));
      for (const btn of buttons) {
        const txt = (btn.innerText || '').trim().toLowerCase();
        if (txt.includes('use template') || txt.includes('use this template') || txt.includes('sử dụng mẫu') || txt.includes('dùng mẫu')) {
          result.canUseOnWeb = true;
          if (btn.href) result.editorUrl = btn.href;
        }
      }

      // 1. Inspect window._ROUTER_DATA.loaderData for exact templateDetail object
      try {
        if (window._ROUTER_DATA && window._ROUTER_DATA.loaderData) {
          for (const key of Object.keys(window._ROUTER_DATA.loaderData)) {
            const entry = window._ROUTER_DATA.loaderData[key];
            if (entry && entry.templateDetail) {
              const td = entry.templateDetail;
              result.routerTemplateDetail = {
                templateId: td.templateId || '',
                title: td.title || '',
                desc: td.desc || '',
                videoUrl: td.videoUrl || (td.structuredData && td.structuredData.contentUrl) || '',
                coverUrl: td.coverUrl || (td.structuredData && td.structuredData.thumbnailUrl) || '',
                segmentAmount: Number(td.segmentAmount || td.fragmentCount || 0),
                templateDurationMs: Number(td.templateDuration || 0),
                videoWidth: Number(td.videoWidth || 720),
                videoHeight: Number(td.videoHeight || 1280),
                useAvailable: Boolean(td.useAvailable)
              };
              break;
            }
          }
        }
      } catch {}

      // 2. Fallback: Check title or body text for explicit clip count (e.g., "[2]", "2 ảnh", "12 clips")
      const bodyText = document.body ? document.body.innerText : '';
      const clipMatch = bodyText.match(/(\d{1,3})\s*(clips|clip|phân đoạn|đoạn|mục|slots)/i);
      if (clipMatch) {
        result.slotCountText = clipMatch[1];
      }

      return result;
    });

    await browser.close();
    browser = null;

    const rtd = pageData.routerTemplateDetail;
    if (!templateId && rtd && rtd.templateId) {
      templateId = rtd.templateId;
    }
    if (!templateId) {
      templateId = String(Date.now());
    }

    const title = (rtd && rtd.title) ||
                  pageData.h1 ||
                  pageData.title.replace(/\|.*$/, '').replace(/- CapCut.*$/i, '').trim() ||
                  `Mẫu CapCut #${templateId.slice(-6)}`;

    let videoUrl = (rtd && rtd.videoUrl) ||
                   pageData.videoSrc ||
                   capturedVideoUrls[0] || '';

    let coverUrl = (rtd && rtd.coverUrl) ||
                   pageData.posterSrc || '';

    // Determine exact expected slot count:
    // Priority 1: templateDetail.segmentAmount from CapCut's SSR data
    // Priority 2: Title bracket notation like "[2] THANH TÂN" or "2 ảnh"
    // Priority 3: Page clip text match
    let expectedSlots = (rtd && rtd.segmentAmount > 0) ? rtd.segmentAmount : 0;
    if (!expectedSlots) {
      const bracketMatch = title.match(/^\s*\[(\d{1,2})\]/) || title.match(/(\d{1,2})\s*(ảnh|video|clip)/i);
      if (bracketMatch) {
        expectedSlots = parseInt(bracketMatch[1], 10);
      } else if (pageData.slotCountText) {
        expectedSlots = parseInt(pageData.slotCountText, 10);
      }
    }

    onLog(`Thông tin mẫu từ CapCut: "${title}" — Số phân đoạn chuẩn: ${expectedSlots || 'Tự động dò'}`);

    const localVideoFilename = `template_${templateId}.mp4`;
    const localVideoPath = path.join(CACHE_DIR, localVideoFilename);

    let hasLocalVideo = fs.existsSync(localVideoPath) && fs.statSync(localVideoPath).size > 10000;
    if (!hasLocalVideo && videoUrl && videoUrl.startsWith('http')) {
      try {
        onLog(`Đang tải video gốc của mẫu CapCut về máy để tách nhạc & bắt đúng mốc chuyển cảnh...`);
        await downloadFile(videoUrl, localVideoPath);
        hasLocalVideo = fs.existsSync(localVideoPath) && fs.statSync(localVideoPath).size > 10000;
      } catch (dlErr) {
        onLog(`Cảnh báo tải video mẫu: ${dlErr.message}`);
      }
    }

    let sceneAnalysis = {
      totalDuration: rtd && rtd.templateDurationMs ? Number((rtd.templateDurationMs / 1000).toFixed(2)) : 10,
      width: (rtd && rtd.videoWidth) || 1080,
      height: (rtd && rtd.videoHeight) || 1920,
      slots: []
    };

    if (hasLocalVideo) {
      onLog(`Đang dò chính xác thời điểm chuyển cảnh cho ${expectedSlots || 'các'} phân đoạn trên video mẫu...`);
      sceneAnalysis = await detectSceneSlotsFromVideo(localVideoPath, expectedSlots);
    } else {
      const count = expectedSlots > 0 ? expectedSlots : 2;
      const segDur = Number((sceneAnalysis.totalDuration / count).toFixed(2));
      for (let i = 0; i < count; i++) {
        const start = Number((i * segDur).toFixed(2));
        const end = i === count - 1 ? sceneAnalysis.totalDuration : Number(((i + 1) * segDur).toFixed(2));
        sceneAnalysis.slots.push({
          index: i + 1,
          startTime: start,
          endTime: end,
          duration: Number((end - start).toFixed(2))
        });
      }
    }

    const editorUrl = `https://www.capcut.com/editor-template?create_id=${templateId}&enter_from=main_btn&from_page=towards_page_template_reflux`;

    onLog(`✅ Phân tích hoàn tất! Mẫu "${title}" có đúng ${sceneAnalysis.slots.length} phân đoạn (${sceneAnalysis.slots.map(s => s.duration + 's').join(' + ')} = ${sceneAnalysis.totalDuration}s).`);

    return {
      templateId,
      originalUrl: templateUrl,
      finalUrl,
      editorUrl,
      title,
      coverUrl,
      remoteVideoUrl: videoUrl,
      localVideoUrl: hasLocalVideo ? `/cache/templates/${localVideoFilename}` : null,
      localVideoPath: hasLocalVideo ? localVideoPath : null,
      canUseOnWeb: true,
      totalDuration: sceneAnalysis.totalDuration,
      width: sceneAnalysis.width,
      height: sceneAnalysis.height,
      slotCount: sceneAnalysis.slots.length,
      slots: sceneAnalysis.slots
    };
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    throw err;
  }
}

/**
 * Discover trending templates directly from CapCut Web Portal
 */
async function discoverCapCutTemplates(keyword = '', onLog = () => {}) {
  let browser;
  try {
    onLog(`Đang quét kho mẫu thịnh hành trên CapCut Web...`);
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--mute-audio']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'vi-VN'
    });
    const page = await context.newPage();

    const targetUrl = 'https://www.capcut.com/templates';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);

    const templates = await page.evaluate(() => {
      const items = [];
      const seen = new Set();

      const links = Array.from(document.querySelectorAll('a[href*="template"]'));
      for (const a of links) {
        const href = a.href;
        if (!href || seen.has(href)) continue;
        if (!href.includes('template-detail') && !href.includes('templates/') && !href.includes('template_id=')) continue;
        if (!/\d{10,}/.test(href)) continue;

        seen.add(href);
        const img = a.querySelector('img');
        const video = a.querySelector('video');
        const text = (a.innerText || '').trim().split('\n').filter(Boolean);
        items.push({
          url: href,
          title: text[0] || 'Mẫu CapCut Trending',
          cover: img ? img.src : '',
          video: video ? (video.currentSrc || video.src) : ''
        });
        if (items.length >= 12) break;
      }
      return items;
    });

    await browser.close();
    return templates;
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return [];
  }
}

module.exports = {
  analyzeCapCutTemplate,
  discoverCapCutTemplates,
  detectSceneSlotsFromVideo,
  probeVideo,
  CACHE_DIR
};
