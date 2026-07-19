'use strict';

/* ------------------------------------------------------------------
   Analogital Pocket — MVP
   写真を1枚選ぶ → 暖色フィルム風レシピを適用 → 別ファイルで保存
   ・写真は端末の外へ送らない（すべてこのファイル内＝ブラウザ内で処理）
   ・元の写真は一切変更しない（非破壊。保存は必ず新しいファイル）
------------------------------------------------------------------ */

// ---- Service Worker 登録（PWA・オフライン用）----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

// ---- 画面の要素 ----
const screens = { home: document.getElementById('home'), editor: document.getElementById('editor') };
const fileInput   = document.getElementById('fileInput');
const pickBtn     = document.getElementById('pickBtn');
const backBtn     = document.getElementById('backBtn');
const recipeBtn   = document.getElementById('recipeBtn');
const saveBtn     = document.getElementById('saveBtn');
const statusEl    = document.getElementById('status');
const busyEl      = document.getElementById('busy');
const previewCanvas = document.getElementById('preview');
const pctx = previewCanvas.getContext('2d', { willReadFrequently: true });

// ---- 状態 ----
let sourceCanvas = null;   // 向き補正済み・フル解像度の元画像（読み取り専用の下絵として扱う）
let recipeOn = false;      // レシピを適用中かどうか

// ---- 画面切り替え ----
function show(name) {
  for (const k in screens) screens[k].classList.toggle('is-active', k === name);
}

// ---- 暖色フィルム風レシピ（色は仮。後日、本物の調整値に差し替える前提）----
// 事前計算した対応表（LUT）。1回作れば全ピクセルに使い回せるので、大きな写真でも速い。
function buildLUT(gamma, gain, lift, ceil) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let x = Math.pow(i / 255, gamma) * gain;   // 明るさカーブ＋色ごとの強さ
    x = lift + x * (ceil - lift);              // 黒を少し持ち上げ・白を少し抑える（フィルムの褪色感）
    lut[i] = Math.round(x * 255);
  }
  return lut;
}
const R_LUT = buildLUT(0.90, 1.03, 0.05, 0.98);  // 赤をやや強く
const G_LUT = buildLUT(1.00, 1.00, 0.04, 0.96);
const B_LUT = buildLUT(1.10, 0.98, 0.05, 0.94);  // 青をやや弱く → 全体が暖色に寄る

function applyRecipe(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = R_LUT[d[i]];
    d[i + 1] = G_LUT[d[i + 1]];
    d[i + 2] = B_LUT[d[i + 2]];
    // d[i+3]（透明度）はそのまま
  }
  return imageData;
}

// ---- 写真の読み込み（EXIFの「向き」を反映）----
async function loadFile(file) {
  // JPEG以外はやさしく断る（仕様どおりJPEGを対象にする）
  const isJpeg = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);
  if (!isJpeg) { alert('JPEGの写真を選んでください。'); return; }

  busy(true);
  try {
    const img = await decodeOriented(file);
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = w;
    sourceCanvas.height = h;
    sourceCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
    if (img.close) img.close();

    recipeOn = false;
    recipeBtn.setAttribute('aria-pressed', 'false');
    recipeBtn.classList.remove('is-on');
    setupPreview();
    renderPreview();
    statusEl.textContent = '';
    show('editor');
  } catch (e) {
    alert('写真を読み込めませんでした。別の写真で試してください。');
  } finally {
    busy(false);
  }
}

// EXIFの向きタグを反映して読み込む（そのままだと回転した写真が保存される事故が起きる）
async function decodeOriented(file) {
  if ('createImageBitmap' in window) {
    try {
      // imageOrientation:'from-image' で撮影時の向きを反映
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) { /* このオプション非対応の環境では下のフォールバックへ */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return img; // Chromeは<img>表示時に既定で向きを反映する
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- プレビュー（表示は画面サイズに縮小して軽くする）----
function setupPreview() {
  const maxW = Math.min(window.innerWidth - 32, 1000);
  const maxH = Math.min(window.innerHeight * 0.60, 1400);
  const sw = sourceCanvas.width, sh = sourceCanvas.height;
  const scale = Math.min(maxW / sw, maxH / sh, 1);
  previewCanvas.width  = Math.max(1, Math.round(sw * scale));
  previewCanvas.height = Math.max(1, Math.round(sh * scale));
}

function renderPreview() {
  pctx.drawImage(sourceCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
  if (recipeOn) {
    const img = pctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
    applyRecipe(img);
    pctx.putImageData(img, 0, 0);
  }
}

// ---- レシピのオン/オフ ----
recipeBtn.addEventListener('click', () => {
  if (!sourceCanvas) return;
  recipeOn = !recipeOn;
  recipeBtn.setAttribute('aria-pressed', String(recipeOn));
  recipeBtn.classList.toggle('is-on', recipeOn);
  renderPreview();
  statusEl.textContent = recipeOn
    ? 'レシピを適用中。保存すると、この色で新しい写真ができます。'
    : '元の色に戻しました。';
});

// ---- 保存（フル解像度で書き出し。元画像は変更しない＝非破壊）----
saveBtn.addEventListener('click', async () => {
  if (!sourceCanvas) return;
  busy(true);
  statusEl.textContent = '保存用に書き出しています…';
  try {
    const out = document.createElement('canvas');
    out.width = sourceCanvas.width;
    out.height = sourceCanvas.height;
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.drawImage(sourceCanvas, 0, 0);
    if (recipeOn) {
      const img = octx.getImageData(0, 0, out.width, out.height);
      applyRecipe(img);
      octx.putImageData(img, 0, 0);
    }
    const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) throw new Error('toBlob returned null');
    const fname = `analogital_${stamp()}.jpg`;
    downloadBlob(blob, fname);
    statusEl.textContent = `保存しました：${fname}（ダウンロード先に新しいファイルとして入ります）`;
  } catch (e) {
    statusEl.textContent = '保存に失敗しました。もう一度お試しください。';
  } finally {
    busy(false);
  }
});

// ---- 補助 ----
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function busy(on) {
  busyEl.hidden = !on;
  saveBtn.disabled = on;
  recipeBtn.disabled = on;
}

// ---- イベント ----
pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f);
  fileInput.value = ''; // 同じ写真をもう一度選んでも反応するように空にする
});
backBtn.addEventListener('click', () => { show('home'); sourceCanvas = null; });

// 画面回転・リサイズ時にプレビューを組み直す
let resizeTimer;
window.addEventListener('resize', () => {
  if (!sourceCanvas || !screens.editor.classList.contains('is-active')) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { setupPreview(); renderPreview(); }, 150);
});
