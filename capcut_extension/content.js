(async function runCapCutAutoBridge() {
  const STUDIO_API = 'http://localhost:3000';

  function showBanner(msg, bg = 'linear-gradient(90deg, #00f2fe, #7c3aed)') {
    let b = document.getElementById('cc-auto-bridge-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'cc-auto-bridge-banner';
      b.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 20px;border-radius:999px;color:#fff;font-family:sans-serif;font-size:13px;font-weight:700;box-shadow:0 8px 25px rgba(0,0,0,0.45);pointer-events:none;transition:all 0.3s;';
      document.body.appendChild(b);
    }
    b.style.background = bg;
    b.textContent = msg;
  }

  try {
    const res = await fetch(`${STUDIO_API}/api/extension/current-job`);
    if (!res.ok) return;
    const job = await res.json();
    if (!job || !job.files || job.files.length === 0) return;

    showBanner(`🤖 CapCut Auto Studio: Đang đợi khung timeline mẫu tải xong để nạp ${job.files.length} file...`);

    // Wait up to 25 seconds for .segment-item[data-mutable-index] to appear
    let segments = [];
    for (let t = 0; t < 50; t++) {
      segments = Array.from(document.querySelectorAll('.segment-item[data-mutable-index]'));
      if (segments.length > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (segments.length === 0) {
      showBanner('⚠️ Không tìm thấy các ô phân đoạn trên mẫu này!', '#ef4444');
      return;
    }

    showBanner(`🚀 Đang tự động nạp ${job.files.length} file vào ${segments.length} ô của mẫu...`);

    for (let i = 0; i < segments.length; i++) {
      const fileMeta = job.files[i % job.files.length];
      const segInput = document.querySelector(`.segment-item[data-mutable-index="${i}"] input[type="file"]`);
      if (!segInput) continue;

      const fileRes = await fetch(`${STUDIO_API}${fileMeta.url}`);
      const blob = await fileRes.blob();
      const fileObj = new File([blob], fileMeta.originalName || fileMeta.filename, {
        type: fileMeta.mimeType || blob.type || (fileMeta.filename.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg')
      });

      const dt = new DataTransfer();
      dt.items.add(fileObj);
      segInput.files = dt.files;
      segInput.dispatchEvent(new Event('change', { bubbles: true }));

      showBanner(`✅ Đã nạp Ô #${i + 1}/${segments.length}: ${fileMeta.originalName || fileMeta.filename}`);
      await new Promise(r => setTimeout(r, 2200));
    }

    showBanner('🎉 Đã nạp đủ các ô! Đang tự động bấm nút Export (Xuất video)...', 'linear-gradient(90deg, #10b981, #059669)');
    await new Promise(r => setTimeout(r, 4000));

    // Dismiss OK tooltip if present
    const buttons = Array.from(document.querySelectorAll('button'));
    const okBtn = buttons.find(b => b.textContent.trim() === 'OK' || b.textContent.trim() === 'Got it');
    if (okBtn) okBtn.click();

    await new Promise(r => setTimeout(r, 1000));

    // Click visible #export-video-btn
    const expBtns = document.querySelectorAll('#export-video-btn');
    if (expBtns.length > 0) {
      expBtns[expBtns.length - 1].click();
    }
  } catch (err) {
    console.warn('[CapCut Auto Bridge]', err);
  }
})();
