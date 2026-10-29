// Per-machine / per-browser unique Client ID so 2 machines working simultaneously never overwrite each other's slot files or progress bars!
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem('lm_client_id');
    if (!id) {
      id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('lm_client_id', id);
    }
    return id;
  } catch {
    return 'c_default';
  }
})();

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (!headers.has('X-Client-Id')) {
    headers.set('X-Client-Id', CLIENT_ID);
  }
  return nativeFetch(input, { ...init, headers });
};

// State management
let templatesList = [];
let activeTemplate = null;
let userClips = [];
let outputsHistory = [];
let latestBatchOutputs = [];
let lockedTemplateIds = new Set();
let activeRendersByTemplate = new Map();

// DOM Elements
const templateListEl = document.getElementById('template-list');
const templateCountLabel = document.getElementById('template-count-label');
const activeTemplateTitle = document.getElementById('active-template-title');
const statSlotCount = document.getElementById('stat-slot-count');
const statDuration = document.getElementById('stat-duration');
const statResolution = document.getElementById('stat-resolution');
const inputTemplateUrl = document.getElementById('input-template-url');
const btnAnalyzeUrl = document.getElementById('btn-analyze-url');
const btnPreviewTemplate = document.getElementById('btn-preview-template');
const btnCapcutLogin = document.getElementById('btn-capcut-login');

const btnClearClips = document.getElementById('btn-clear-clips');
const btnAddSlot = document.getElementById('btn-add-slot');
const slotsTimelineEl = document.getElementById('slots-timeline');
const syncPairStatusEl = document.getElementById('sync-pair-status');

const btnStartRender = document.getElementById('btn-start-render');
const btnStartRenderLabel = document.getElementById('btn-start-render-label');

const progressWrapperEl = document.getElementById('progress-wrapper');
const progressStatusText = document.getElementById('progress-status-text');
const progressPercentText = document.getElementById('progress-percent-text');
const progressBarFill = document.getElementById('progress-bar-fill');

const mainPreviewVideo = document.getElementById('main-preview-video');
const botLiveScreenshot = document.getElementById('bot-live-screenshot');
const previewBadge = document.getElementById('preview-badge');
const btnDownloadLatest = document.getElementById('btn-download-latest');
const btnDownloadAllBatch = document.getElementById('btn-download-all-batch');
const btnDownloadAllLabel = document.getElementById('btn-download-all-label');
const terminalLogs = document.getElementById('terminal-logs');
const btnClearLogs = document.getElementById('btn-clear-logs');
const outputsListEl = document.getElementById('outputs-list');
const outputsTitleLabel = document.getElementById('outputs-title-label');
const outputsCountLabel = document.getElementById('outputs-count-label');
const btnClearOutputs = document.getElementById('btn-clear-outputs');

// Inline SVG Icons
const SVG_UPLOAD = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
const SVG_TRASH = `<svg class="icon" style="width:13px;height:13px;" viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const SVG_DOWNLOAD = `<svg class="icon" style="width:13px;height:13px;" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

function pad2(num) {
  return String(num).padStart(2, '0');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Terminal logger
function appendLog(message, level = 'info', timeStr = null) {
  if (!terminalLogs) return;
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const t = timeStr || new Date().toLocaleTimeString('vi-VN');
  line.innerHTML = `<span class="log-time">[${t}]</span>${escapeHtml(message)}`;
  terminalLogs.appendChild(line);
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

let currentDisplayedPercent = 0;

function syncActiveRendersFromServer(activeRenders, lockedIds) {
  if (Array.isArray(lockedIds)) {
    lockedTemplateIds = new Set(lockedIds.map(String));
  }
  if (Array.isArray(activeRenders)) {
    const activeIds = new Set();
    for (const item of activeRenders) {
      if (!item || !item.templateId) continue;
      const tid = String(item.templateId);
      activeIds.add(tid);
      lockedTemplateIds.add(tid);
      const prev = activeRendersByTemplate.get(tid);
      const pct = Math.max(prev ? prev.percent || 0 : 0, Math.round(item.percent || 12));
      activeRendersByTemplate.set(tid, {
        templateId: tid,
        clientId: item.clientId || (prev && prev.clientId) || '',
        percent: pct,
        status: item.status || (prev && prev.status) || 'Đang tạo video...'
      });
    }
    for (const key of Array.from(activeRendersByTemplate.keys())) {
      if (!activeIds.has(key) && !lockedTemplateIds.has(key)) {
        activeRendersByTemplate.delete(key);
      }
    }
  } else {
    for (const key of Array.from(activeRendersByTemplate.keys())) {
      if (!lockedTemplateIds.has(key)) {
        activeRendersByTemplate.delete(key);
      }
    }
  }
}

function updateActiveTemplateProgressUI() {
  if (!progressWrapperEl) return;
  const tplId = activeTemplate ? String(activeTemplate.templateId || '') : '';
  const st = tplId ? activeRendersByTemplate.get(tplId) : null;
  const isLocked = tplId && lockedTemplateIds.has(tplId);

  if (!st && !isLocked) {
    progressWrapperEl.style.display = 'none';
    return;
  }

  const rawPct = st && typeof st.percent === 'number' ? st.percent : 12;
  const pct = Math.max(0, Math.min(100, Math.round(rawPct)));
  const status = (st && st.status) || 'Đang tạo video...';
  progressWrapperEl.style.display = 'block';
  if (progressBarFill) progressBarFill.style.width = `${pct}%`;
  if (progressPercentText) progressPercentText.textContent = `${pct}%`;
  if (progressStatusText) progressStatusText.textContent = status;
}

function setProgress(percent, status, forceReset = false, targetTemplateId = null) {
  const tplId = String(targetTemplateId || (activeTemplate && activeTemplate.templateId) || '');
  let pct = Math.max(0, Math.min(100, Math.round(percent || 0)));

  if (tplId && (lockedTemplateIds.has(tplId) || activeRendersByTemplate.has(tplId))) {
    const prev = activeRendersByTemplate.get(tplId) || {
      templateId: tplId,
      clientId: CLIENT_ID,
      percent: 0,
      status: ''
    };
    if (forceReset || pct === 0 || pct === 100) {
      prev.percent = pct === 100 ? 100 : pct;
    } else if (pct >= (prev.percent || 0)) {
      prev.percent = pct;
    }
    if (status) prev.status = status;
    activeRendersByTemplate.set(tplId, prev);
  }

  updateActiveTemplateProgressUI();
}

// Connect WebSocket for real-time updates
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    appendLog('Đã kết nối Engine LMautoedit (Playwright Cloud · 1 TB).', 'success');
    loadOutputsHistory();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const isForActiveTemplate = !data.templateId || (activeTemplate && String(data.templateId) === String(activeTemplate.templateId));
      if (data.type === 'log') {
        appendLog(data.message, data.level || 'info', data.timestamp);
      } else if (data.type === 'progress') {
        const tid = String(data.templateId || (activeTemplate && activeTemplate.templateId) || '');
        if (tid && (lockedTemplateIds.has(tid) || activeRendersByTemplate.has(tid))) {
          const prev = activeRendersByTemplate.get(tid);
          const forceReset = data.percent <= 12 && prev && prev.percent >= 99;
          setProgress(data.percent, data.status, forceReset, tid);
          renderTemplateList();
        }
      } else if (data.type === 'single_video_ready') {
        loadOutputsHistory();
        if (isForActiveTemplate && data.output) {
          showRenderedVideo(data.output);
        }
      } else if (data.type === 'render_complete') {
        if (data.templateId) {
          const tid = String(data.templateId);
          lockedTemplateIds.delete(tid);
          activeRendersByTemplate.delete(tid);
        }
        renderTemplateList();
        updateSyncPairStatus();
        loadOutputsHistory();
        if (isForActiveTemplate) {
          currentDisplayedPercent = 0;
          if (data.outputs && data.outputs.length > 0) {
            showRenderedVideo(data.outputs[0]);
          }
        }
      } else if (data.type === 'render_cancelled') {
        if (data.templateId) {
          const tid = String(data.templateId);
          lockedTemplateIds.delete(tid);
          activeRendersByTemplate.delete(tid);
        }
        renderTemplateList();
        updateSyncPairStatus();
        loadOutputsHistory();
      } else if (data.type === 'template_locks') {
        syncActiveRendersFromServer(data.activeRenders, data.lockedTemplateIds);
        renderTemplateList();
        updateSyncPairStatus();
      } else if (data.type === 'output_status_changed' || data.type === 'output_deleted') {
        loadOutputsHistory();
      }
    } catch {}
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 2500);
  };
}

function showVideoPreview(videoUrl, badgeText, isRenderedOutput = false, downloadHref = null) {
  if (!videoUrl) return;
  if (botLiveScreenshot) botLiveScreenshot.style.display = 'none';
  mainPreviewVideo.style.display = 'block';
  mainPreviewVideo.src = videoUrl;
  mainPreviewVideo.play().catch(() => {});
  previewBadge.textContent = badgeText || 'Preview';

  if (isRenderedOutput && btnDownloadLatest) {
    btnDownloadLatest.href = downloadHref || videoUrl;
    btnDownloadLatest.style.display = 'inline-flex';
  }
}

function showRenderedVideo(outputObj) {
  if (!outputObj) return;
  const dlHref = outputObj.downloadUrl || `/api/download/${encodeURIComponent(outputObj.filename)}`;
  showVideoPreview(outputObj.url, `Thành phẩm: ${outputObj.filename}`, true, dlHref);
}

function toTemplateSlugClient(title) {
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

function getOutputsForTemplate(tpl) {
  if (!tpl) return [];
  const tplId = String(tpl.templateId || '');
  const tplSlug = toTemplateSlugClient(tpl.title);
  return outputsHistory.filter(o => {
    if (o.templateId && String(o.templateId) === tplId) return true;
    if (!o.templateId && tplSlug) {
      const m = String(o.filename || '').match(/^Video_\d+_(.+)_\d{2}h\d{2}(?:_v\d+)?\.mp4$/i);
      if (m && m[1].toUpperCase() === tplSlug) return true;
    }
    return false;
  });
}

async function saveActiveTemplateSlots() {
  if (!activeTemplate || !activeTemplate.templateId || !Array.isArray(activeTemplate.slots)) return;
  try {
    localStorage.setItem(
      `capcut_slots_${activeTemplate.templateId}`,
      JSON.stringify(activeTemplate.slots.map(s => (Array.isArray(s.assignedFiles) ? s.assignedFiles : [])))
    );
  } catch {}
  try {
    await fetch(`/api/templates/${encodeURIComponent(activeTemplate.templateId)}/slots`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: activeTemplate.slots })
    });
  } catch {}
}

function restoreTemplateSlotsFromLocalBackup(tpl) {
  if (!tpl || !Array.isArray(tpl.slots)) return;
  try {
    const raw = localStorage.getItem(`capcut_slots_${tpl.templateId}`);
    if (!raw) return;
    const backupQueues = JSON.parse(raw);
    if (!Array.isArray(backupQueues)) return;
    tpl.slots.forEach((slot, idx) => {
      const hasServerAssigned = Array.isArray(slot.assignedFiles) && slot.assignedFiles.length > 0;
      if (!hasServerAssigned && Array.isArray(backupQueues[idx]) && backupQueues[idx].length > 0) {
        slot.assignedFiles = backupQueues[idx];
      }
    });
  } catch {}
}

// Render saved templates list (Column 1)
function renderTemplateList() {
  if (!templateListEl) return;
  templateListEl.innerHTML = '';
  if (templateCountLabel) templateCountLabel.textContent = `${templatesList.length} mẫu`;

  if (templatesList.length === 0) {
    templateListEl.innerHTML = `
      <div class="template-empty-hint">
        Chưa có mẫu nào được lưu.<br/>Dán link mẫu CapCut vào ô phía trên và bấm <strong>+ Thêm mẫu</strong>.
      </div>
    `;
    return;
  }

  templatesList.forEach((tpl) => {
    const isSelected = activeTemplate && String(activeTemplate.templateId) === String(tpl.templateId);
    const card = document.createElement('div');
    card.className = `template-card ${isSelected ? 'active' : ''}`;
    const slotLen = (tpl.slots && tpl.slots.length) || tpl.slotCount || 2;
    const dur = tpl.totalDuration || 10;
    const tplOutputs = getOutputsForTemplate(tpl);
    const tplIdStr = String(tpl.templateId);
    const isLocked = lockedTemplateIds.has(tplIdStr);
    const renderSt = activeRendersByTemplate.get(tplIdStr);
    const pctSuffix = renderSt && renderSt.percent ? ` (${renderSt.percent}%)` : '';
    const lockBadgeHtml = isLocked
      ? `<span class="tag-chip" style="background:rgba(245,158,11,0.18);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);">⏳ Đang chạy${pctSuffix}</span>`
      : '';
    const outBadgeHtml = tplOutputs.length > 0
      ? `<span class="tag-chip" style="background:rgba(59,130,246,0.14);color:#60a5fa;border:1px solid rgba(59,130,246,0.28);">${tplOutputs.length} video</span>`
      : '';

    card.innerHTML = `
      <div class="template-card-info">
        <div class="template-card-title">${escapeHtml(tpl.title || `Mẫu #${tpl.templateId}`)}</div>
        <div class="template-card-meta">
          <span class="tag-chip chip-emerald">${slotLen} phân đoạn</span>
          <span class="tag-chip chip-amber">${dur}s</span>
          ${outBadgeHtml}
          ${lockBadgeHtml}
        </div>
      </div>
      <button type="button" class="template-del-btn" title="Xóa mẫu này khỏi danh sách">${SVG_TRASH}</button>
    `;

    card.addEventListener('click', () => selectTemplate(tpl));
    const delBtn = card.querySelector('.template-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const res = await fetch(`/api/templates/${encodeURIComponent(tpl.templateId)}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            templatesList = data.templates || [];
            if (activeTemplate && String(activeTemplate.templateId) === String(tpl.templateId)) {
              activeTemplate = templatesList[0] || null;
              if (activeTemplate) {
                selectTemplate(activeTemplate);
              } else {
                clearActiveTemplateUI();
              }
            } else {
              renderTemplateList();
            }
          }
        } catch {}
      });
    }
    templateListEl.appendChild(card);
  });
}

function clearActiveTemplateUI() {
  activeTemplate = null;
  if (activeTemplateTitle) activeTemplateTitle.textContent = 'Chưa chọn mẫu CapCut';
  const statsBox = document.getElementById('active-template-stats');
  if (statsBox) statsBox.style.display = 'none';
  if (btnPreviewTemplate) btnPreviewTemplate.style.display = 'none';
  if (slotsTimelineEl) slotsTimelineEl.innerHTML = '';
  renderTemplateList();
  renderOutputsForActiveTemplate();
}

function selectTemplate(tpl) {
  if (!tpl) {
    clearActiveTemplateUI();
    return;
  }
  activeTemplate = tpl;
  try {
    localStorage.setItem('capcut_active_template_id', String(tpl.templateId));
  } catch {}
  if (activeTemplateTitle) activeTemplateTitle.textContent = tpl.title || `Mẫu #${tpl.templateId}`;
  const statsBox = document.getElementById('active-template-stats');
  if (statsBox) statsBox.style.display = 'flex';
  if (btnPreviewTemplate) btnPreviewTemplate.style.display = 'inline-flex';
  const slotCount = (tpl.slots && tpl.slots.length) || tpl.slotCount || 2;
  if (statSlotCount) statSlotCount.textContent = `${slotCount} phân đoạn`;
  if (statDuration) statDuration.textContent = `${tpl.totalDuration || 10}s`;
  if (statResolution) statResolution.textContent = `${tpl.width || 1080}x${tpl.height || 1920}`;

  renderTemplateList();
  renderSlotsTimeline();
  renderOutputsForActiveTemplate();

  if (tpl.localVideoUrl || tpl.remoteVideoUrl) {
    showVideoPreview(tpl.localVideoUrl || tpl.remoteVideoUrl, `Mẫu: ${tpl.title}`, false);
  }
}

let isRenderBtnHovered = false;

// Update synchronized pair status banner & primary button state
function updateSyncPairStatus() {
  if (!activeTemplate || !activeTemplate.slots) return;
  const counts = activeTemplate.slots.map(s => (Array.isArray(s.assignedFiles) ? s.assignedFiles.length : 0));
  const detailStr = counts.map((c, i) => `Đoạn ${pad2(i + 1)}: ${c} file`).join(' · ');
  const firstCount = counts[0] || 0;
  const allNonEmpty = counts.every(c => c > 0);
  const allEqual = counts.every(c => c === firstCount);
  const tplIdStr = String(activeTemplate.templateId || '');
  const isTplLocked = lockedTemplateIds.has(tplIdStr);
  const renderSt = activeRendersByTemplate.get(tplIdStr);
  const isMyRender = Boolean(renderSt && (!renderSt.clientId || renderSt.clientId === CLIENT_ID));

  updateActiveTemplateProgressUI();

  const iconSvg = btnStartRender ? btnStartRender.querySelector('svg.icon') : null;

  if (isTplLocked || renderSt) {
    btnStartRender.classList.remove('ready-parallel', 'mismatch-error');
    if (isMyRender) {
      const isCancelling = Boolean(renderSt && renderSt.cancelling);
      const isHovered = Boolean(isRenderBtnHovered || (btnStartRender.matches && btnStartRender.matches(':hover')));
      btnStartRender.disabled = isCancelling;
      btnStartRender.classList.add('is-rendering');
      btnStartRender.title = 'Bấm vào đây để dừng tạo video';
      if (btnStartRenderLabel) {
        btnStartRenderLabel.textContent = isCancelling
          ? 'Đang dừng...'
          : (isHovered ? 'Dừng tạo' : 'Đang tạo ...');
      }
      if (iconSvg) {
        iconSvg.innerHTML = (isHovered || isCancelling)
          ? '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"></rect>'
          : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
      }
    } else {
      btnStartRender.disabled = true;
      btnStartRender.classList.remove('is-rendering');
      btnStartRender.title = '';
      if (btnStartRenderLabel) {
        btnStartRenderLabel.textContent = `Mẫu Này Đang Có Máy Khác Chạy...`;
      }
      if (iconSvg) {
        iconSvg.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
      }
    }
    return;
  } else {
    btnStartRender.disabled = false;
    btnStartRender.classList.remove('is-rendering');
    btnStartRender.title = '';
    if (iconSvg) {
      iconSvg.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    }
  }

  if (allNonEmpty && allEqual) {
    btnStartRender.classList.remove('mismatch-error');
    btnStartRender.classList.add('ready-parallel');
    if (!btnStartRender.disabled && btnStartRenderLabel) {
      btnStartRenderLabel.textContent = `Tạo ${firstCount} Video Ngay`;
    }
  } else if (counts.some(c => c > 0)) {
    btnStartRender.classList.remove('ready-parallel');
    btnStartRender.classList.add('mismatch-error');
    if (!btnStartRender.disabled && btnStartRenderLabel) {
      btnStartRenderLabel.textContent = `Số lượng file ở các đoạn chưa bằng nhau (${detailStr})`;
    }
  } else {
    btnStartRender.classList.remove('ready-parallel');
    btnStartRender.classList.remove('mismatch-error');
    if (!btnStartRender.disabled && btnStartRenderLabel) {
      btnStartRenderLabel.textContent = 'Tạo Video Ngay';
    }
  }
}

function getCanonicalMediaKey(nameStr) {
  const raw = String(nameStr || '').split(/[\\/]/).pop().trim();
  const stripped = raw.replace(/^p\d+_s\d+_/i, '').replace(/^(?:trim_\d+_)?(?:\d+_\d+_)?/i, '');
  const dotIdx = stripped.lastIndexOf('.');
  const rawExt = dotIdx > 0 ? stripped.slice(dotIdx).toLowerCase() : '';
  let ext = rawExt;
  if (/^\.(heic|heif|jfif|avif|tif|tiff|bmp)$/i.test(rawExt)) {
    ext = '.jpg';
  } else if (/^\.(mts|m2ts|ts|wmv|flv|f4v|3gp|3g2|mpg|mpeg|vob|ogv|asf|avi|mkv|m4v)$/i.test(rawExt)) {
    ext = '.mp4';
  }
  const base = (dotIdx > 0 ? stripped.slice(0, dotIdx) : stripped)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40)
    .toLowerCase();
  return `${base}${ext}`;
}

function showDuplicateFilesNoticeModal(duplicateNames) {
  const modal = document.getElementById('overwrite-confirm-modal');
  const titleEl = document.getElementById('overwrite-modal-title');
  const descEl = document.getElementById('overwrite-modal-desc');
  const listEl = document.getElementById('overwrite-modal-list');
  const btnConfirm = document.getElementById('btn-overwrite-confirm');
  const btnCancel = document.getElementById('btn-overwrite-cancel');
  const btnClose = document.getElementById('btn-overwrite-modal-close');

  if (!modal || !btnConfirm || !btnCancel) {
    window.alert(`Không tải được file lên vì đã có trên hệ thống:\n${duplicateNames.join('\n')}`);
    return;
  }

  if (titleEl) titleEl.textContent = 'Thông báo';
  if (descEl) {
    descEl.innerHTML = duplicateNames.length === 1
      ? `Không tải được file <strong>${escapeHtml(duplicateNames[0])}</strong> lên vì đã có trên hệ thống.`
      : `Không tải được <strong>${duplicateNames.length} file</strong> sau lên vì đã có trên hệ thống:`;
  }
  if (listEl) {
    listEl.style.display = duplicateNames.length > 1 ? 'block' : 'none';
    listEl.innerHTML = duplicateNames
      .map((name, i) => `<div style="padding: 3px 0; border-bottom: 1px dashed rgba(255,255,255,0.06);">#${pad2(i + 1)}: ${escapeHtml(name)}</div>`)
      .join('');
  }

  btnCancel.style.display = 'none';
  btnConfirm.innerHTML = '<span>Đóng</span>';
  modal.style.display = 'flex';

  const closeNotice = () => {
    modal.style.display = 'none';
    btnCancel.style.display = '';
    btnConfirm.innerHTML = '<span>Tạo lại &amp; ghi đè</span>';
    if (listEl) listEl.style.display = 'block';
    btnConfirm.onclick = null;
    if (btnClose) btnClose.onclick = null;
  };

  btnConfirm.onclick = closeNotice;
  if (btnClose) btnClose.onclick = closeNotice;
}

// Helper to upload files directly into a specific slot index (skips files already in the slot / system)
async function uploadFilesIntoSlot(idx, fileList) {
  if (!fileList || fileList.length === 0 || !activeTemplate || !activeTemplate.slots[idx]) return;
  if (lockedTemplateIds.has(String(activeTemplate.templateId))) {
    appendLog(`Mẫu "${activeTemplate.title}" đang trong quá trình tạo video! Không thể thay đổi nguyên liệu lúc này.`, 'warn');
    return;
  }
  const pickedFiles = Array.from(fileList);
  const uploadQs = `?templateId=${encodeURIComponent(activeTemplate.templateId || '')}&templateTitle=${encodeURIComponent(activeTemplate.title || '')}`;

  if (!Array.isArray(activeTemplate.slots[idx].assignedFiles)) {
    activeTemplate.slots[idx].assignedFiles = [];
  }

  // Build set of canonical keys already present in this slot
  const existingInSlotKeys = new Set(
    activeTemplate.slots[idx].assignedFiles.map((fname) => {
      const clipObj = userClips.find(c => c.filename === fname);
      return getCanonicalMediaKey((clipObj && clipObj.originalName) || fname);
    })
  );

  const filesToProcess = [];
  const duplicateFileNames = [];

  for (const f of pickedFiles) {
    const key = getCanonicalMediaKey(f.name);
    if (existingInSlotKeys.has(key)) {
      duplicateFileNames.push(f.name);
      continue;
    }
    existingInSlotKeys.add(key);
    filesToProcess.push({ file: f, key });
  }

  if (duplicateFileNames.length > 0) {
    showDuplicateFilesNoticeModal(duplicateFileNames);
    appendLog(`Không tải được ${duplicateFileNames.length} file lên vì đã có trên hệ thống.`, 'warn');
  }

  if (filesToProcess.length === 0) {
    return;
  }

  let uploadedCount = 0;
  try {
    for (let i = 0; i < filesToProcess.length; i++) {
      const { file: f } = filesToProcess[i];
      const fd = new FormData();
      fd.append('videos', f);

      const res = await fetch(`/api/uploads${uploadQs}`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Lỗi tải file');
      if (data.clips && data.clips.length > 0) {
        for (const c of data.clips) {
          if (!userClips.some(existing => existing.filename === c.filename)) {
            userClips.push(c);
          }
          activeTemplate.slots[idx].assignedFiles.push(c.filename);
          uploadedCount++;
        }
      }
    }
    activeTemplate.slots[idx].assignedFilename = activeTemplate.slots[idx].assignedFiles[0] || '';
    renderSlotsTimeline();
    await saveActiveTemplateSlots();
    if (uploadedCount > 0) {
      appendLog(`Đoạn ${pad2(idx + 1)}: Đã tải lên ${uploadedCount} file mới.`, 'success');
    }
  } catch (err) {
    renderSlotsTimeline();
    await saveActiveTemplateSlots();
    appendLog(`Lỗi nạp file Đoạn ${pad2(idx + 1)}: ${err.message}`, 'error');
  }
}

// Track drag state for reordering files inside a slot queue
let slotRowDragState = { slotIdx: null, fromIdx: null };

// Render center side-by-side slot columns matrix
function renderSlotsTimeline() {
  if (!slotsTimelineEl) return;
  // Preserve scroll positions of each slot queue list before re-render
  const prevScrollTops = Array.from(slotsTimelineEl.querySelectorAll('.slot-box')).map(b => {
    const list = b.querySelector('.slot-queue-list');
    return list ? list.scrollTop : 0;
  });

  slotsTimelineEl.innerHTML = '';
  if (!activeTemplate || !activeTemplate.slots) return;

  activeTemplate.slots.forEach((slot, idx) => {
    if (!Array.isArray(slot.assignedFiles)) {
      slot.assignedFiles = [];
    }
    slot.assignedFiles = slot.assignedFiles.filter(fname => userClips.some(c => c.filename === fname));

    const box = document.createElement('div');
    box.className = `slot-box slot-theme-${idx % 4}`;

    const queueHtml = slot.assignedFiles.length > 0
      ? `<div class="slot-queue-list">
          ${slot.assignedFiles.map((fname, qIdx) => {
            const clipObj = userClips.find(c => c.filename === fname);
            const isImg = clipObj && (Boolean(clipObj.isImage) || /\.(jpg|jpeg|png|webp|bmp|gif|heic|heif|jfif|avif|tif|tiff)$/i.test(clipObj.filename));
            const thumbHtml = clipObj
              ? (isImg
                  ? `<img class="slot-thumb" src="${clipObj.url}" alt="" draggable="false" />`
                  : `<video class="slot-thumb" src="${clipObj.url}" muted preload="metadata" draggable="false"></video>`)
              : '';
            const shortName = clipObj ? clipObj.originalName : fname;
            const typeBadge = isImg
              ? `<span class="media-type-badge type-image">ẢNH</span>`
              : `<span class="media-type-badge type-video">VIDEO · ${clipObj ? clipObj.duration : ''}s</span>`;

            return `
              <div class="slot-queue-row" draggable="true" data-qidx="${qIdx}">
                <div class="slot-queue-left">
                  <span class="pair-idx-badge">#${pad2(qIdx + 1)}</span>
                  ${thumbHtml}
                  <div class="slot-file-info">
                    <span class="slot-file-name" title="${escapeHtml(shortName)}">${escapeHtml(shortName)}</span>
                    ${typeBadge}
                  </div>
                </div>
                <button type="button" class="slot-remove-btn" data-qidx="${qIdx}" title="Bỏ file này khỏi Đoạn ${pad2(idx + 1)}">
                  ${SVG_TRASH}
                </button>
              </div>
            `;
          }).join('')}
        </div>`
      : `<div class="slot-empty-drop slot-preview-trigger">
           <div class="slot-empty-icon">${SVG_UPLOAD}</div>
           <div class="slot-empty-title">Tải video hoặc ảnh lên</div>
           <div class="slot-empty-sub">Bấm vào đây hoặc kéo thả nhiều file cùng lúc</div>
         </div>`;

    box.innerHTML = `
      <div class="slot-box-header">
        <div class="slot-title-wrap">
          <span class="slot-index-pill">${pad2(idx + 1)}</span>
          <span class="slot-title">Đoạn ${pad2(idx + 1)}</span>
          <span class="slot-count-badge">${slot.assignedFiles.length} file</span>
        </div>
        <div class="slot-duration-wrap">
          <span class="slot-duration-input" title="Thời lượng (giây) của phân đoạn này">${slot.duration}s</span>
        </div>
      </div>

      ${queueHtml}

      <input type="file" class="slot-direct-file" accept=".mp4,.mov,.webm,.mkv,.avi,.m4v,.mts,.m2ts,.ts,.wmv,.flv,.f4v,.3gp,.3g2,.mpg,.mpeg,.vob,.ogv,.asf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.heic,.heif,.jfif,.avif,.tif,.tiff,image/heic,image/heif,image/avif,image/tiff,video/*,image/*" multiple style="display:none;" />
      <div class="slot-box-footer">
        <button type="button" class="btn slot-upload-btn" style="flex:1;">
          ${SVG_UPLOAD}
          <span>+ Tải file lên Đoạn ${pad2(idx + 1)}</span>
        </button>
        ${slot.assignedFiles.length > 0 ? `<button type="button" class="btn btn-ghost-danger slot-clear-queue-btn" title="Xóa sạch Đoạn ${pad2(idx + 1)}">Xóa đoạn</button>` : ''}
      </div>
    `;

    // Drag & drop external files from OS directly onto the slot column
    box.addEventListener('dragover', (e) => {
      if (slotRowDragState.slotIdx !== null) return;
      e.preventDefault();
      box.classList.add('dragover');
    });
    box.addEventListener('dragleave', () => {
      box.classList.remove('dragover');
    });
    box.addEventListener('drop', async (e) => {
      if (slotRowDragState.slotIdx !== null) return;
      e.preventDefault();
      box.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await uploadFilesIntoSlot(idx, e.dataTransfer.files);
      }
    });

    // Drag & drop internal rows to reorder items up/down within this slot
    const queueRows = box.querySelectorAll('.slot-queue-row[data-qidx]');
    queueRows.forEach(rowEl => {
      const qIdx = parseInt(rowEl.getAttribute('data-qidx'), 10);

      rowEl.addEventListener('dragstart', (e) => {
        slotRowDragState = { slotIdx: idx, fromIdx: qIdx };
        rowEl.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(qIdx));
        }
      });

      rowEl.addEventListener('dragover', (e) => {
        if (slotRowDragState.slotIdx !== idx || slotRowDragState.fromIdx === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (slotRowDragState.fromIdx === qIdx) return;

        const rect = rowEl.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > rect.height / 2;
        rowEl.classList.toggle('drop-above', !isAfter);
        rowEl.classList.toggle('drop-below', isAfter);
      });

      rowEl.addEventListener('dragleave', () => {
        rowEl.classList.remove('drop-above', 'drop-below');
      });

      rowEl.addEventListener('drop', (e) => {
        if (slotRowDragState.slotIdx !== idx || slotRowDragState.fromIdx === null) return;
        e.preventDefault();
        e.stopPropagation();
        rowEl.classList.remove('drop-above', 'drop-below');

        const fromIdx = slotRowDragState.fromIdx;
        slotRowDragState = { slotIdx: null, fromIdx: null };
        if (fromIdx === qIdx) return;

        const rect = rowEl.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > rect.height / 2;
        const filesArr = activeTemplate.slots[idx].assignedFiles;
        const [movedFile] = filesArr.splice(fromIdx, 1);
        let insertIdx = isAfter ? qIdx + 1 : qIdx;
        if (fromIdx < insertIdx) insertIdx--;
        filesArr.splice(insertIdx, 0, movedFile);
        activeTemplate.slots[idx].assignedFilename = filesArr[0] || '';

        renderSlotsTimeline();
        saveActiveTemplateSlots();
      });

      rowEl.addEventListener('dragend', () => {
        slotRowDragState = { slotIdx: null, fromIdx: null };
        rowEl.classList.remove('dragging', 'drop-above', 'drop-below');
      });

      // Clicking a video row opens the Video Trimmer Modal; clicking an image row opens the Image Preview Modal
      rowEl.addEventListener('click', (e) => {
        if (e.target.closest('.slot-remove-btn')) return;
        const fname = activeTemplate.slots[idx].assignedFiles[qIdx];
        const clipObj = userClips.find(c => c.filename === fname);
        if (!clipObj) return;
        const isImg = Boolean(clipObj.isImage) || /\.(jpg|jpeg|png|webp|bmp|gif|heic|heif|jfif|avif|tif|tiff)$/i.test(clipObj.filename);
        if (isImg) {
          openImagePreviewModal(idx, qIdx, clipObj);
        } else {
          openVideoTrimmerModal(idx, qIdx, clipObj);
        }
      });
    });

    const durInput = box.querySelector('.slot-duration-input');
    durInput.addEventListener('change', (e) => {
      const val = Math.max(0.3, Math.min(60, parseFloat(e.target.value) || 1.5));
      activeTemplate.slots[idx].duration = Number(val.toFixed(2));
      const total = activeTemplate.slots.reduce((a, s) => a + Number(s.duration || 0), 0);
      activeTemplate.totalDuration = Number(total.toFixed(2));
      if (statDuration) statDuration.textContent = `${activeTemplate.totalDuration}s`;
    });

    box.querySelectorAll('.slot-remove-btn[data-qidx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qIdx = parseInt(btn.getAttribute('data-qidx'), 10);
        activeTemplate.slots[idx].assignedFiles.splice(qIdx, 1);
        activeTemplate.slots[idx].assignedFilename = activeTemplate.slots[idx].assignedFiles[0] || '';
        renderSlotsTimeline();
        saveActiveTemplateSlots();
      });
    });

    const clearQueueBtn = box.querySelector('.slot-clear-queue-btn');
    if (clearQueueBtn) {
      clearQueueBtn.addEventListener('click', () => {
        activeTemplate.slots[idx].assignedFiles = [];
        activeTemplate.slots[idx].assignedFilename = '';
        renderSlotsTimeline();
        saveActiveTemplateSlots();
      });
    }

    const slotFileInp = box.querySelector('.slot-direct-file');
    const slotUploadBtn = box.querySelector('.slot-upload-btn');
    const slotPreviewTrigger = box.querySelector('.slot-preview-trigger');
    slotUploadBtn.addEventListener('click', () => slotFileInp.click());
    if (slotPreviewTrigger) {
      slotPreviewTrigger.addEventListener('click', () => slotFileInp.click());
    }
    slotFileInp.addEventListener('change', async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        await uploadFilesIntoSlot(idx, e.target.files);
        slotFileInp.value = '';
      }
    });

    const delBtn = box.querySelector('.slot-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        activeTemplate.slots.splice(idx, 1);
        activeTemplate.slots.forEach((s, i) => { s.index = i + 1; });
        if (statSlotCount) statSlotCount.textContent = `${activeTemplate.slots.length} phân đoạn`;
        const total = activeTemplate.slots.reduce((a, s) => a + Number(s.duration || 0), 0);
        activeTemplate.totalDuration = Number(total.toFixed(2));
        if (statDuration) statDuration.textContent = `${activeTemplate.totalDuration}s`;
        renderSlotsTimeline();
      });
    }

    slotsTimelineEl.appendChild(box);
    const newList = box.querySelector('.slot-queue-list');
    if (newList && prevScrollTops[idx]) {
      newList.scrollTop = prevScrollTops[idx];
    }
  });

  updateSyncPairStatus();
}

// Load outputs gallery
function renderOutputsForActiveTemplate() {
  if (!outputsListEl) return;
  outputsListEl.innerHTML = '';

  const filteredOutputs = activeTemplate ? getOutputsForTemplate(activeTemplate) : [];
  const tplTitle = activeTemplate ? activeTemplate.title : '';

  if (outputsTitleLabel) {
    outputsTitleLabel.textContent = 'Danh sách video đã tạo';
  }

  const downloadedCount = filteredOutputs.filter(o => o.downloaded).length;
  if (outputsCountLabel) {
    outputsCountLabel.textContent = downloadedCount > 0
      ? `Đã tải ${downloadedCount}/${filteredOutputs.length}`
      : `${filteredOutputs.length} video`;
  }

  if (btnClearOutputs) {
    btnClearOutputs.style.display = filteredOutputs.length > 0 ? 'inline-flex' : 'none';
  }

  // Update "Tải tất cả" button for the active template's downloadable videos
  const downloadableForTpl = filteredOutputs.filter(o => o.onServer !== false);
  latestBatchOutputs = downloadableForTpl;
  if (btnDownloadAllBatch) {
    if (downloadableForTpl.length > 1) {
      btnDownloadAllBatch.style.display = 'inline-flex';
      if (btnDownloadAllLabel) {
        btnDownloadAllLabel.textContent = `Tải tất cả (${downloadableForTpl.length})`;
      }
    } else {
      btnDownloadAllBatch.style.display = 'none';
    }
  }

  if (filteredOutputs.length === 0) {
    outputsListEl.innerHTML = `
      <div class="template-empty-hint" style="padding: 18px 12px;">
        Chưa có video nào được tạo cho mẫu <strong>${escapeHtml(tplTitle || 'này')}</strong>.
      </div>
    `;
    return;
  }

  filteredOutputs.forEach((out) => {
    const row = document.createElement('div');
    row.className = 'output-item';
    const mb = ((out.size || 0) / (1024 * 1024)).toFixed(1);
    const dlHref = `/api/download/${encodeURIComponent(out.filename)}`;
    const isDownloaded = Boolean(out.downloaded);
    const isOnServer = out.onServer !== false;

    let actionBtnHtml = '';
    if (!isDownloaded && isOnServer) {
      actionBtnHtml = `
        <a class="btn" href="${dlHref}" download style="padding: 5px 10px; font-size: 13px;" onclick="event.stopPropagation();">
          ${SVG_DOWNLOAD}
          <span>Tải</span>
        </a>
      `;
    } else if (isDownloaded && isOnServer) {
      actionBtnHtml = `
        <a class="btn" href="${dlHref}" download title="Bấm để tải lại nếu cần (Server giữ dự phòng 5 phút)" style="padding: 5px 10px; font-size: 13px; background: rgba(16,185,129,0.14); color: #10b981; border-color: rgba(16,185,129,0.3);" onclick="event.stopPropagation();">
          <span>✓ Đã tải</span>
        </a>
      `;
    } else {
      actionBtnHtml = `
        <span style="display:inline-flex;align-items:center;padding:5px 10px;border-radius:5px;font-size:13px;font-weight:600;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25);">
          ✓ Đã tải
        </span>
      `;
    }

    row.innerHTML = `
      <div class="output-info">
        <div class="output-name">${escapeHtml(out.filename)}</div>
        <div class="output-meta">${mb} MB · ${new Date(out.createdAt).toLocaleTimeString('vi-VN')}</div>
      </div>
      ${actionBtnHtml}
    `;

    row.addEventListener('click', () => {
      if (isOnServer) {
        showRenderedVideo({ ...out, url: out.url || `/outputs/${out.filename}`, downloadUrl: dlHref });
      }
    });

    outputsListEl.appendChild(row);
  });
}

async function loadOutputsHistory() {
  try {
    const res = await fetch('/api/outputs');
    const data = await res.json();
    if (!data.success) return;
    outputsHistory = data.outputs || [];
    renderTemplateList();
    renderOutputsForActiveTemplate();
  } catch {}
}

// Initialize Studio
async function initStudio() {
  try {
    const [tplRes, outRes, clipsRes] = await Promise.all([
      fetch('/api/templates/builtin'),
      fetch('/api/outputs'),
      fetch('/api/uploads')
    ]);
    const tplData = await tplRes.json();
    const outData = await outRes.json();
    const clipsData = await clipsRes.json();

    if (clipsData.success) {
      userClips = clipsData.clips || [];
    }
    if (outData.success) {
      outputsHistory = outData.outputs || [];
    }

    if (tplData.success) {
      syncActiveRendersFromServer(tplData.activeRenders, tplData.lockedTemplateIds);
    }
    if (tplData.success && tplData.templates && tplData.templates.length > 0) {
      templatesList = tplData.templates;
      templatesList.forEach(tpl => restoreTemplateSlotsFromLocalBackup(tpl));

      let savedActiveId = '';
      try {
        savedActiveId = localStorage.getItem('capcut_active_template_id') || '';
      } catch {}
      const targetTpl =
        templatesList.find(t => String(t.templateId) === String(savedActiveId)) ||
        templatesList[0];
      selectTemplate(targetTpl);
    } else {
      clearActiveTemplateUI();
    }
  } catch (err) {
    appendLog(`Lỗi khởi tạo: ${err.message}`, 'error');
  }

  connectWebSocket();
}

// Analyze CapCut URL
if (btnAnalyzeUrl) {
  btnAnalyzeUrl.addEventListener('click', async () => {
    const url = (inputTemplateUrl.value || '').trim();
    if (!url) {
      appendLog('Vui lòng dán link mẫu CapCut vào ô trước khi thêm mẫu.', 'warn');
      return;
    }

    btnAnalyzeUrl.disabled = true;
    appendLog('Đang phân tích cấu trúc phân đoạn của mẫu CapCut...', 'info');

    try {
      const res = await fetch('/api/templates/analyze-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const existingIdx = templatesList.findIndex(t => String(t.templateId) === String(data.template.templateId));
      if (existingIdx >= 0) {
        templatesList[existingIdx] = data.template;
      } else {
        templatesList.unshift(data.template);
      }

      if (inputTemplateUrl) inputTemplateUrl.value = '';
      selectTemplate(data.template);
      appendLog(`Đã nạp mẫu "${data.template.title}" (${data.template.slotCount} phân đoạn).`, 'success');
    } catch (err) {
      appendLog(`Lỗi phân tích mẫu: ${err.message}`, 'error');
    } finally {
      btnAnalyzeUrl.disabled = false;
    }
  });
}

// Preview active template
if (btnPreviewTemplate) {
  btnPreviewTemplate.addEventListener('click', () => {
    if (!activeTemplate) return;
    const url = activeTemplate.localVideoUrl || activeTemplate.remoteVideoUrl;
    if (url) {
      showVideoPreview(url, `Mẫu gốc: ${activeTemplate.title}`, false);
    } else {
      appendLog('Mẫu này chưa có video xem trước.', 'warn');
    }
  });
}

// Open CapCut login window (Only visible when accessed directly on VPS localhost)
const isLocalhostView = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname || '');
if (btnCapcutLogin) {
  if (!isLocalhostView) {
    btnCapcutLogin.style.display = 'none';
  }
  btnCapcutLogin.addEventListener('click', async () => {
    btnCapcutLogin.disabled = true;
    try {
      const res = await fetch('/api/capcut/login', { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
    } catch (err) {
      appendLog(`Lỗi mở cửa sổ đăng nhập: ${err.message}`, 'error');
    } finally {
      setTimeout(() => { btnCapcutLogin.disabled = false; }, 1500);
    }
  });
}

// Clear clips & slot queues of the active template
if (btnClearClips) {
  btnClearClips.addEventListener('click', async () => {
    const tplId = activeTemplate ? activeTemplate.templateId : '';
    const qs = tplId ? `?templateId=${encodeURIComponent(tplId)}` : '';
    await fetch(`/api/uploads/ALL${qs}`, { method: 'DELETE' });
    if (activeTemplate && activeTemplate.slots) {
      activeTemplate.slots.forEach(s => {
        s.assignedFiles = [];
        s.assignedFilename = '';
      });
      await saveActiveTemplateSlots();
    }
    const clipsRes = await fetch('/api/uploads').catch(() => null);
    if (clipsRes) {
      const clipsData = await clipsRes.json().catch(() => ({}));
      if (clipsData.success) userClips = clipsData.clips || [];
    }
    renderSlotsTimeline();
  });
}

// Clear outputs list of the active template
if (btnClearOutputs) {
  btnClearOutputs.addEventListener('click', async () => {
    const tplId = activeTemplate ? String(activeTemplate.templateId || '') : '';
    const qs = tplId ? `?templateId=${encodeURIComponent(tplId)}` : '';
    await fetch(`/api/outputs/ALL${qs}`, { method: 'DELETE' });
    if (tplId && !lockedTemplateIds.has(tplId)) {
      activeRendersByTemplate.delete(tplId);
    }
    await loadOutputsHistory();
    updateSyncPairStatus();
  });
}

// Add custom slot
if (btnAddSlot) {
  btnAddSlot.addEventListener('click', () => {
    if (!activeTemplate) return;
    if (!activeTemplate.slots) activeTemplate.slots = [];
    activeTemplate.slots.push({
      index: activeTemplate.slots.length + 1,
      duration: 5.0,
      assignedFiles: []
    });
    if (statSlotCount) statSlotCount.textContent = `${activeTemplate.slots.length} phân đoạn`;
    renderSlotsTimeline();
  });
}

// Clear logs
if (btnClearLogs) {
  btnClearLogs.addEventListener('click', () => {
    terminalLogs.innerHTML = '';
  });
}

// Download all batch outputs
if (btnDownloadAllBatch) {
  btnDownloadAllBatch.addEventListener('click', () => {
    if (!latestBatchOutputs || latestBatchOutputs.length === 0) return;
    latestBatchOutputs.forEach((out, idx) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = out.downloadUrl || out.url;
        a.download = out.filename || `LMautoedit_${idx + 1}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, idx * 450);
    });
  });
}

function getExistingBatchOutputs(tpl, batchCount) {
  if (!tpl || !batchCount) return [];
  const tplOuts = getOutputsForTemplate(tpl);
  return tplOuts.filter((out) => {
    const m = String(out.filename || '').match(/^Video_(\d+)_/i);
    if (!m) return false;
    const pNum = parseInt(m[1], 10);
    return pNum >= 1 && pNum <= batchCount;
  });
}

function askOverwriteConfirmationModal(existingList, totalCount) {
  return new Promise((resolve) => {
    const modal = document.getElementById('overwrite-confirm-modal');
    const titleEl = document.getElementById('overwrite-modal-title');
    const descEl = document.getElementById('overwrite-modal-desc');
    const listEl = document.getElementById('overwrite-modal-list');
    const btnConfirm = document.getElementById('btn-overwrite-confirm');
    const btnCancel = document.getElementById('btn-overwrite-cancel');
    const btnClose = document.getElementById('btn-overwrite-modal-close');

    if (!modal || !btnConfirm || !btnCancel) {
      const ok = window.confirm(
        existingList.length === totalCount
          ? `${totalCount} video này đã tạo trước đó. Tạo lại và ghi đè lên video cũ?`
          : `Có ${existingList.length} video đã tạo trước đó. Tiếp tục tạo và ghi đè lên video cũ?`
      );
      return resolve(ok);
    }

    if (titleEl) {
      titleEl.textContent = `Video đã tạo rồi`;
    }
    if (descEl) {
      descEl.innerHTML = existingList.length === totalCount
        ? `<strong>${totalCount} video</strong> này đã được tạo trước đó. Bạn có muốn tạo lại và ghi đè lên video cũ không?`
        : `Có <strong>${existingList.length}/${totalCount} video</strong> đã tạo trước đó. Bạn có muốn tiếp tục và ghi đè lên video cũ không?`;
    }
    if (listEl) {
      listEl.style.display = 'block';
      listEl.innerHTML = existingList
        .map((item, i) => `<div style="padding: 3px 0; border-bottom: 1px dashed rgba(255,255,255,0.06);">#${pad2(i + 1)}: ${escapeHtml(item.filename)}</div>`)
        .join('');
    }

    btnCancel.style.display = '';
    btnConfirm.innerHTML = '<span>Tạo lại &amp; ghi đè</span>';
    modal.style.display = 'flex';

    const cleanup = (result) => {
      modal.style.display = 'none';
      btnConfirm.onclick = null;
      btnCancel.onclick = null;
      if (btnClose) btnClose.onclick = null;
      resolve(result);
    };

    btnConfirm.onclick = () => cleanup(true);
    btnCancel.onclick = () => cleanup(false);
    if (btnClose) btnClose.onclick = () => cleanup(false);
  });
}

// START PARALLEL RENDER
if (btnStartRender) {
  btnStartRender.addEventListener('mouseenter', () => {
    isRenderBtnHovered = true;
    if (btnStartRender.classList.contains('is-rendering')) {
      updateSyncPairStatus();
    }
  });

  btnStartRender.addEventListener('mouseleave', () => {
    isRenderBtnHovered = false;
    if (btnStartRender.classList.contains('is-rendering')) {
      updateSyncPairStatus();
    }
  });

  btnStartRender.addEventListener('click', async () => {
    if (!activeTemplate) {
      appendLog('Vui lòng chọn hoặc thêm mẫu CapCut ở cột 01 trước.', 'warn');
      return;
    }

    const tplKey = String(activeTemplate.templateId || activeTemplate.id || activeTemplate.title || '');
    const activeRenderSt = activeRendersByTemplate.get(tplKey);
    const isMyActiveRender = Boolean(activeRenderSt && (!activeRenderSt.clientId || activeRenderSt.clientId === CLIENT_ID));

    // If currently rendering on this machine, clicking "Đang tạo ..." cancels/stops the render
    if (isMyActiveRender) {
      if (activeRenderSt.cancelling) return;
      activeRenderSt.cancelling = true;
      updateSyncPairStatus();
      try {
        await fetch('/api/render/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId: tplKey })
        });
      } catch (cancelErr) {
        appendLog(`Lỗi khi dừng tạo video: ${cancelErr.message}`, 'error');
      } finally {
        lockedTemplateIds.delete(tplKey);
        activeRendersByTemplate.delete(tplKey);
        renderTemplateList();
        updateSyncPairStatus();
      }
      return;
    }

    const slotQueues = (activeTemplate.slots || []).map(s => (Array.isArray(s.assignedFiles) ? s.assignedFiles : []));
    const counts = slotQueues.map(q => q.length);
    const firstCount = counts[0] || 0;
    const allEqual = counts.every(c => c > 0 && c === firstCount);

    if (!allEqual) {
      const detailStr = counts.map((c, i) => `Đoạn ${pad2(i + 1)}: ${c} file`).join(' · ');
      const msg = `Chưa đồng bộ số lượng file (${detailStr}). Vui lòng chọn số lượng file bằng nhau ở các phân đoạn.`;
      appendLog(msg, 'error');
      return;
    }

    if (tplKey && lockedTemplateIds.has(tplKey)) {
      const msg = `Mẫu "${activeTemplate.title}" đang có người chạy tạo video! Cùng một lúc mỗi mẫu chỉ được 1 người chạy — vui lòng chọn mẫu khác.`;
      appendLog(msg, 'error');
      return;
    }

    if (!outputsHistory || outputsHistory.length === 0) {
      await loadOutputsHistory();
    }
    const existingBatchOutputs = getExistingBatchOutputs(activeTemplate, firstCount);
    if (existingBatchOutputs.length > 0) {
      const confirmed = await askOverwriteConfirmationModal(existingBatchOutputs, firstCount);
      if (!confirmed) {
        return;
      }
      appendLog(`Đang tạo lại và ghi đè ${existingBatchOutputs.length} video...`, 'info');
    }

    const renderTplId = String(activeTemplate.templateId || '');
    lockedTemplateIds.add(renderTplId);
    activeRendersByTemplate.set(renderTplId, {
      templateId: renderTplId,
      clientId: CLIENT_ID,
      percent: 10,
      status: `Đang tạo ${firstCount} video...`
    });
    renderTemplateList();
    updateSyncPairStatus();

    let keepLockedForAsync = false;
    try {
      const payload = {
        template: activeTemplate,
        slotQueues,
        clipFilenames: slotQueues.map(q => q[0]),
        mode: 'capcut_web',
        headless: true
      };

      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.cancelled) {
        return;
      }
      if (!data.success) throw new Error(data.error || 'Lỗi xuất video');

      if (data.asyncStarted) {
        keepLockedForAsync = true;
        return;
      }

      if (data.outputs && data.outputs.length > 0) {
        latestBatchOutputs = data.outputs;
        if (activeTemplate && String(activeTemplate.templateId) === renderTplId) {
          showRenderedVideo(data.outputs[0]);
        }
        await loadOutputsHistory();
        appendLog(`Đã tạo xong ${data.outputs.length} video (#01 -> #${pad2(data.outputs.length)}).`, 'success');
      }
    } catch (err) {
      appendLog(`Lỗi khi ghép video: ${err.message}`, 'error');
    } finally {
      if (!keepLockedForAsync) {
        lockedTemplateIds.delete(renderTplId);
        activeRendersByTemplate.delete(renderTplId);
        renderTemplateList();
        updateSyncPairStatus();
      }
    }
  });
}

// Cloudflare-resilient background sync: while any template is rendering, poll status & outputs every 3.5s
setInterval(async () => {
  if (lockedTemplateIds.size === 0 && activeRendersByTemplate.size === 0) return;
  try {
    const [tplRes, outRes] = await Promise.all([
      fetch('/api/templates/builtin'),
      fetch('/api/outputs')
    ]);
    const tplData = await tplRes.json();
    const outData = await outRes.json();
    if (outData && outData.success) {
      outputsHistory = outData.outputs || [];
      renderOutputsForActiveTemplate();
    }
    if (tplData && tplData.success) {
      syncActiveRendersFromServer(tplData.activeRenders, tplData.lockedTemplateIds);
      renderTemplateList();
      updateSyncPairStatus();
    }
  } catch {}
}, 3500);

// VIDEO TRIMMER MODAL LOGIC
const videoTrimModal = document.getElementById('video-trim-modal');
const trimModalFilename = document.getElementById('trim-modal-filename');
const trimModalVideo = document.getElementById('trim-modal-video');
const trimStartLabel = document.getElementById('trim-start-label');
const trimEndLabel = document.getElementById('trim-end-label');
const trimDurationLabel = document.getElementById('trim-duration-label');
const trimSlotTargetLabel = document.getElementById('trim-slot-target-label');
const trimRangeStart = document.getElementById('trim-range-start');
const trimRangeEnd = document.getElementById('trim-range-end');
const trimCutLeft = document.getElementById('trim-cut-left');
const trimCutRight = document.getElementById('trim-cut-right');
const trimActiveFill = document.getElementById('trim-active-fill');
const btnTrimClose = document.getElementById('btn-trim-close');
const btnTrimCancel = document.getElementById('btn-trim-cancel');
const btnTrimPreview = document.getElementById('btn-trim-preview');
const btnTrimSave = document.getElementById('btn-trim-save');

let activeTrimContext = null; // { slotIdx, qIdx, clipObj, totalDuration }

function updateTrimSliderUI(changedHandle = null) {
  if (!activeTrimContext) return;
  const maxDur = activeTrimContext.totalDuration || 10;
  let startVal = parseFloat(trimRangeStart.value) || 0;
  let endVal = parseFloat(trimRangeEnd.value) || maxDur;

  if (changedHandle === 'start' && startVal > endVal - 0.3) {
    startVal = Math.max(0, endVal - 0.3);
    trimRangeStart.value = startVal.toFixed(2);
  } else if (changedHandle === 'end' && endVal < startVal + 0.3) {
    endVal = Math.min(maxDur, startVal + 0.3);
    trimRangeEnd.value = endVal.toFixed(2);
  }

  const keptDur = Math.max(0.1, endVal - startVal);
  if (trimStartLabel) trimStartLabel.textContent = `${startVal.toFixed(1)}s`;
  if (trimEndLabel) trimEndLabel.textContent = `${endVal.toFixed(1)}s`;
  if (trimDurationLabel) trimDurationLabel.textContent = `${keptDur.toFixed(1)}s`;

  const leftPct = Math.max(0, Math.min(100, (startVal / maxDur) * 100));
  const rightPct = Math.max(0, Math.min(100, 100 - (endVal / maxDur) * 100));
  if (trimCutLeft) trimCutLeft.style.width = `${leftPct}%`;
  if (trimCutRight) trimCutRight.style.width = `${rightPct}%`;
  if (trimActiveFill) {
    trimActiveFill.style.left = `${leftPct}%`;
    trimActiveFill.style.right = `${rightPct}%`;
  }

  if (trimModalVideo && changedHandle === 'start') {
    trimModalVideo.currentTime = startVal;
  } else if (trimModalVideo && changedHandle === 'end') {
    trimModalVideo.currentTime = Math.max(startVal, endVal - 0.05);
  }
}

function openVideoTrimmerModal(slotIdx, qIdx, clipObj) {
  if (!videoTrimModal || !trimModalVideo) return;
  const maxDur = Math.max(0.5, Number(clipObj.duration || 10));
  activeTrimContext = { slotIdx, qIdx, clipObj, totalDuration: maxDur };

  if (trimModalFilename) {
    trimModalFilename.textContent = `#${pad2(qIdx + 1)} · ${clipObj.originalName || clipObj.filename}`;
  }
  const slotDur = activeTemplate && activeTemplate.slots && activeTemplate.slots[slotIdx]
    ? activeTemplate.slots[slotIdx].duration
    : null;
  if (trimSlotTargetLabel) {
    trimSlotTargetLabel.textContent = slotDur ? `(Đoạn ${pad2(slotIdx + 1)} cần: ${slotDur}s)` : '';
  }

  trimRangeStart.min = '0';
  trimRangeStart.max = String(maxDur);
  trimRangeStart.step = '0.05';
  trimRangeStart.value = '0';

  trimRangeEnd.min = '0';
  trimRangeEnd.max = String(maxDur);
  trimRangeEnd.step = '0.05';
  trimRangeEnd.value = String(maxDur);

  trimModalVideo.src = clipObj.url;
  trimModalVideo.currentTime = 0;
  videoTrimModal.style.display = 'flex';
  updateTrimSliderUI();

  trimModalVideo.onloadedmetadata = () => {
    const realDur = Number(trimModalVideo.duration);
    if (realDur && realDur > 0.3) {
      activeTrimContext.totalDuration = realDur;
      trimRangeStart.max = String(realDur);
      trimRangeEnd.max = String(realDur);
      trimRangeEnd.value = String(realDur);
      updateTrimSliderUI();
    }
  };
}

function closeVideoTrimmerModal() {
  if (!videoTrimModal) return;
  if (trimModalVideo) {
    trimModalVideo.pause();
    trimModalVideo.removeAttribute('src');
    trimModalVideo.load();
  }
  videoTrimModal.style.display = 'none';
  activeTrimContext = null;
}

if (trimRangeStart) {
  trimRangeStart.addEventListener('input', () => updateTrimSliderUI('start'));
}
if (trimRangeEnd) {
  trimRangeEnd.addEventListener('input', () => updateTrimSliderUI('end'));
}
if (trimModalVideo) {
  trimModalVideo.addEventListener('timeupdate', () => {
    if (!activeTrimContext) return;
    const endVal = parseFloat(trimRangeEnd.value) || activeTrimContext.totalDuration;
    const startVal = parseFloat(trimRangeStart.value) || 0;
    if (trimModalVideo.currentTime >= endVal) {
      trimModalVideo.pause();
      trimModalVideo.currentTime = startVal;
    }
  });
}
if (btnTrimPreview) {
  btnTrimPreview.addEventListener('click', () => {
    if (!trimModalVideo || !activeTrimContext) return;
    const startVal = parseFloat(trimRangeStart.value) || 0;
    trimModalVideo.currentTime = startVal;
    trimModalVideo.play().catch(() => {});
  });
}
if (btnTrimClose) btnTrimClose.addEventListener('click', closeVideoTrimmerModal);
if (btnTrimCancel) btnTrimCancel.addEventListener('click', closeVideoTrimmerModal);
if (videoTrimModal) {
  videoTrimModal.addEventListener('click', (e) => {
    if (e.target === videoTrimModal) closeVideoTrimmerModal();
  });
}

if (btnTrimSave) {
  btnTrimSave.addEventListener('click', async () => {
    if (!activeTrimContext || !activeTemplate) return;
    const { slotIdx, qIdx, clipObj } = activeTrimContext;
    const startTime = parseFloat(trimRangeStart.value) || 0;
    const endTime = parseFloat(trimRangeEnd.value) || activeTrimContext.totalDuration;

    btnTrimSave.disabled = true;
    const origText = btnTrimSave.innerHTML;
    btnTrimSave.innerHTML = '<span>Đang cắt video...</span>';

    try {
      const res = await fetch('/api/uploads/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: clipObj.filename,
          startTime,
          endTime,
          templateId: activeTemplate.templateId || '',
          templateTitle: activeTemplate.title || ''
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Lỗi cắt video');

      if (data.clip) {
        userClips.push(data.clip);
        if (activeTemplate.slots && activeTemplate.slots[slotIdx]) {
          activeTemplate.slots[slotIdx].assignedFiles[qIdx] = data.clip.filename;
          activeTemplate.slots[slotIdx].assignedFilename = activeTemplate.slots[slotIdx].assignedFiles[0] || '';
        }
        renderSlotsTimeline();
        await saveActiveTemplateSlots();
        appendLog(`Đã cắt Video #${pad2(qIdx + 1)} ở Đoạn ${pad2(slotIdx + 1)} (${data.clip.duration}s)`, 'success');
      }
      closeVideoTrimmerModal();
    } catch (err) {
      appendLog(`Lỗi cắt video: ${err.message}`, 'error');
    } finally {
      btnTrimSave.disabled = false;
      btnTrimSave.innerHTML = origText;
    }
  });
}

// IMAGE PREVIEW LIGHTBOX MODAL LOGIC
const imagePreviewModal = document.getElementById('image-preview-modal');
const imageModalFilename = document.getElementById('image-modal-filename');
const imageModalImg = document.getElementById('image-modal-img');
const btnImageModalClose = document.getElementById('btn-image-modal-close');

function openImagePreviewModal(slotIdx, qIdx, clipObj) {
  if (!imagePreviewModal || !imageModalImg) return;
  if (imageModalFilename) {
    imageModalFilename.textContent = `#${pad2(qIdx + 1)} · ${clipObj.originalName || clipObj.filename}`;
  }
  imageModalImg.src = clipObj.url;
  imagePreviewModal.style.display = 'flex';
}

function closeImagePreviewModal() {
  if (!imagePreviewModal) return;
  imagePreviewModal.style.display = 'none';
  if (imageModalImg) imageModalImg.src = '';
}

if (btnImageModalClose) {
  btnImageModalClose.addEventListener('click', closeImagePreviewModal);
}
if (imagePreviewModal) {
  imagePreviewModal.addEventListener('click', (e) => {
    if (e.target === imagePreviewModal) closeImagePreviewModal();
  });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeVideoTrimmerModal();
    closeImagePreviewModal();
  }
});

// ============================================================================
// ANTI-INSPECT & ANTI-SCRAPE PROTECTION + SERVER-SIDE PIN GATE
// ============================================================================
document.addEventListener('contextmenu', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  e.preventDefault();
});

window.addEventListener('keydown', (e) => {
  const key = String(e.key || '').toLowerCase();
  const isF12 = e.key === 'F12' || e.keyCode === 123;
  const isDevToolsShortcut = (e.ctrlKey || e.metaKey) && e.shiftKey && (key === 'i' || key === 'j' || key === 'c');
  const isViewSourceOrSave = (e.ctrlKey || e.metaKey) && (key === 'u' || key === 's');
  if (isF12 || isDevToolsShortcut || isViewSourceOrSave) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
}, true);

const pinLockOverlay = document.getElementById('pin-lock-overlay');
const pinLockCard = document.getElementById('pin-lock-card');
const pinLockForm = document.getElementById('pin-lock-form');
const pinInputField = document.getElementById('pin-input-field');
const pinErrorMsg = document.getElementById('pin-error-msg');
const btnLockSystem = document.getElementById('btn-lock-system');
let studioBooted = false;

function triggerPinError(msg) {
  if (pinErrorMsg) pinErrorMsg.textContent = msg || 'Mã PIN không chính xác!';
  if (pinLockCard) {
    pinLockCard.classList.remove('shake-error');
    void pinLockCard.offsetWidth;
    pinLockCard.classList.add('shake-error');
  }
}

async function verifyAndUnlockPin(rawPin) {
  const cleanPin = String(rawPin || '').trim();
  if (!cleanPin) {
    triggerPinError('Vui lòng nhập mã PIN 6 số!');
    return false;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: cleanPin })
    });
    const data = await res.json();
    if (!data.success) {
      triggerPinError(data.error || 'Mã PIN không chính xác!');
      if (pinInputField) pinInputField.value = '';
      return false;
    }
    try {
      sessionStorage.setItem('lm_pin_unlocked', '1');
    } catch {}
    if (pinErrorMsg) pinErrorMsg.textContent = '';
    if (pinInputField) pinInputField.value = '';
    if (pinLockOverlay) pinLockOverlay.style.display = 'none';
    if (!studioBooted) {
      studioBooted = true;
      await initStudio();
    }
    return true;
  } catch (err) {
    triggerPinError('Lỗi kết nối máy chủ: ' + err.message);
    return false;
  }
}

if (pinLockForm) {
  pinLockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await verifyAndUnlockPin(pinInputField ? pinInputField.value : '');
  });
}

if (pinInputField) {
  pinInputField.addEventListener('input', async () => {
    if (pinErrorMsg && pinErrorMsg.textContent) pinErrorMsg.textContent = '';
    const val = (pinInputField.value || '').trim();
    if (val.length === 6) {
      await verifyAndUnlockPin(val);
    }
  });
}

if (btnLockSystem) {
  btnLockSystem.addEventListener('click', async () => {
    try {
      sessionStorage.removeItem('lm_pin_unlocked');
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    location.reload();
  });
}

async function bootWithPinGate() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (data && data.authenticated) {
      if (pinLockOverlay) pinLockOverlay.style.display = 'none';
      studioBooted = true;
      await initStudio();
      return;
    }
  } catch {}

  if (pinLockOverlay) pinLockOverlay.style.display = 'flex';
  if (pinInputField) pinInputField.focus();
}

bootWithPinGate();
