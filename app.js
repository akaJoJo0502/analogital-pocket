'use strict';

/* ------------------------------------------------------------------
   Analogital Pocket
   写真を1枚選ぶ → フィルム風レシピ（3種）を適用 → 別ファイルで保存
   ・写真は端末の外へ送らない（すべてブラウザ内で処理）
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
const recipesEl   = document.getElementById('recipes');
const saveBtn     = document.getElementById('saveBtn');
const statusEl    = document.getElementById('status');
const busyEl      = document.getElementById('busy');
const previewCanvas = document.getElementById('preview');
const pctx = previewCanvas.getContext('2d', { willReadFrequently: true });

// ---- 状態 ----
let sourceCanvas = null;   // 向き補正済み・フル解像度の元画像（読み取り専用の下絵）
let currentRecipe = null;  // null = 元の写真（レシピ未適用）

/* ------------------------------------------------------------------
   レシピ（色は「仮」。後日、本物の調整値に差し替える前提）
   事前計算した対応表（LUT）で高速に色変換する
------------------------------------------------------------------ */
function buildLUT(gamma, gain, lift, ceil) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let x = Math.pow(i / 255, gamma) * gain;   // 明るさカーブ＋色ごとの強さ
    x = lift + x * (ceil - lift);              // 黒を少し持ち上げ・白を少し抑える（フィルムの褪色感）
    lut[i] = Math.round(x * 255);
  }
  return lut;
}
// 色ごとの対応表を使うレシピ（暖色・青系）
function lutRecipe(rL, gL, bL) {
  return (img) => {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = rL[d[i]]; d[i + 1] = gL[d[i + 1]]; d[i + 2] = bL[d[i + 2]]; }
  };
}
// 明るさ（輝度）だけ残して色を抜くレシピ（モノクロ）＋ごく淡い色味
function monoRecipe(toneL, tR, tG, tB) {
  return (img) => {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; // 明るさ
      const v = toneL[y];
      d[i] = v * tR; d[i + 1] = v * tG; d[i + 2] = v * tB; // Uint8ClampedArrayが自動で0〜255に丸める
    }
  };
}

const RECIPES = [
  { id: 'warm', name: '暖色フィルム',
    apply: lutRecipe(buildLUT(0.90, 1.03, 0.05, 0.98), buildLUT(1.00, 1.00, 0.04, 0.96), buildLUT(1.10, 0.98, 0.05, 0.94)) },
  { id: 'cool', name: 'クールブルー',
    apply: lutRecipe(buildLUT(1.10, 0.97, 0.04, 0.94), buildLUT(1.00, 1.01, 0.05, 0.97), buildLUT(0.88, 1.05, 0.08, 0.99)) },
  { id: 'mono', name: 'モノクロ',
    apply: monoRecipe(buildLUT(0.95, 1.00, 0.06, 0.96), 1.02, 1.00, 0.96) },
];

// ---- 画面切り替え ----
function show(name) { for (const k in screens) screens[k].classList.toggle('is-active', k === name); }

// ---- レシピ選択ボタン（「元の写真」＋3種）----
function addChip(label, recipe) {
  const b = document.createElement('button');
  b.className = 'recipe-chip';
  b.textContent = label;
  b.dataset.id = recipe ? recipe.id : 'none';
  b.addEventListener('click', () => {
    if (!sourceCanvas) return;
    currentRecipe = recipe;
    renderPreview();
    updateChips();
    statusEl.textContent = recipe
      ? `${recipe.name}を適用中。保存すると、この色で新しい写真ができます。`
      : '元の色に戻しました。';
  });
  recipesEl.appendChild(b);
}
function buildChips() {
  recipesEl.innerHTML = '';
  addChip('元の写真', null);
  RECIPES.forEach((r) => addChip(r.name, r));
  updateChips();
}
function updateChips() {
  const cur = currentRecipe ? currentRecipe.id : 'none';
  Array.from(recipesEl.children).forEach((b) => b.classList.toggle('is-on', b.dataset.id === cur));
}

// ---- 写真の読み込み（EXIFの「向き」を反映）----
async function loadFile(file) {
  const isJpeg = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);
  if (!isJpeg) { alert('JPEGの写真を選んでください。'); return; }
  busy(true);
  try {
    const img = await decodeOriented(file);
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = w; sourceCanvas.height = h;
    sourceCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
    if (img.close) img.close();
    currentRecipe = null;
    setupPreview();
    renderPreview();
    updateChips();
    statusEl.textContent = '';
    show('editor');
  } catch (e) {
    alert('写真を読み込めませんでした。別の写真で試してください。');
  } finally {
    busy(false);
  }
}
// EXIFの向きタグを反映して読み込む（横倒しで保存される事故を防ぐ）
async function decodeOriented(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return img;
  } finally { URL.revokeObjectURL(url); }
}

// ---- プレビュー（表示は画面サイズに縮小して軽くする）----
function setupPreview() {
  const maxW = Math.min(window.innerWidth - 32, 1000);
  const maxH = Math.min(window.innerHeight * 0.55, 1400);
  const sw = sourceCanvas.width, sh = sourceCanvas.height;
  const scale = Math.min(maxW / sw, maxH / sh, 1);
  previewCanvas.width = Math.max(1, Math.round(sw * scale));
  previewCanvas.height = Math.max(1, Math.round(sh * scale));
}
function renderPreview() {
  pctx.drawImage(sourceCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
  if (currentRecipe) {
    const img = pctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
    currentRecipe.apply(img);
    pctx.putImageData(img, 0, 0);
  }
}

// ---- 保存（フル解像度で書き出し。元画像は変更しない＝非破壊）----
saveBtn.addEventListener('click', async () => {
  if (!sourceCanvas) return;
  busy(true);
  statusEl.textContent = '保存用に書き出しています…';
  try {
    const out = document.createElement('canvas');
    out.width = sourceCanvas.width; out.height = sourceCanvas.height;
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.drawImage(sourceCanvas, 0, 0);
    if (currentRecipe) {
      const img = octx.getImageData(0, 0, out.width, out.height);
      currentRecipe.apply(img);
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
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function busy(on) {
  busyEl.hidden = !on;
  saveBtn.disabled = on;
  Array.from(recipesEl.children).forEach((b) => { b.disabled = on; });
}

// ---- イベント ----
pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); fileInput.value = ''; });
backBtn.addEventListener('click', () => { show('home'); sourceCanvas = null; });
let resizeTimer;
window.addEventListener('resize', () => {
  if (!sourceCanvas || !screens.editor.classList.contains('is-active')) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { setupPreview(); renderPreview(); }, 150);
});

// ---- 初期化 ----
buildChips();
