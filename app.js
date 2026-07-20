'use strict';

/* ------------------------------------------------------------------
   Analogital Pocket
   写真を選ぶ → レシピ／明るさ／トリミング（傾き補正つき）→ 別ファイルで保存
   ・写真は端末の外へ送らない（すべてブラウザ内で処理）
   ・元の写真は一切変更しない（非破壊。保存は必ず新しいファイル）
------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

// ---- 要素 ----
const screens = { home: document.getElementById('home'), editor: document.getElementById('editor') };
const fileInput   = document.getElementById('fileInput');
const pickBtn     = document.getElementById('pickBtn');
const backBtn     = document.getElementById('backBtn');
const recipesEl   = document.getElementById('recipes');
const exposureEl  = document.getElementById('exposure');
const expResetEl  = document.getElementById('expReset');
const grainEl     = document.getElementById('grain');
const grainResetEl = document.getElementById('grainReset');
const cropBtn     = document.getElementById('cropBtn');
const saveBtn     = document.getElementById('saveBtn');
const normalControls = document.getElementById('normalControls');
const cropControls   = document.getElementById('cropControls');
const cropCancel  = document.getElementById('cropCancel');
const cropApply   = document.getElementById('cropApply');
const ratiosEl    = document.getElementById('ratios');
const swapOrientEl = document.getElementById('swapOrient');
const angleEl     = document.getElementById('angle');
const angleResetEl = document.getElementById('angleReset');
const statusEl    = document.getElementById('status');
const busyEl      = document.getElementById('busy');
const previewCanvas = document.getElementById('preview');
const pctx = previewCanvas.getContext('2d', { willReadFrequently: true });
const stageCache = document.createElement('canvas'); // crop中の回転済み表示をキャッシュ

// ---- 状態 ----
let originalCanvas = null;               // 向き補正済み・フル解像度の元画像
let cropRect = { x: 0, y: 0, w: 0, h: 0 }; // ステージ（回転済みW0×H0枠）座標での切り抜き範囲
let exposure = 0;                        // 明るさ（-100〜+100）
let grain = 0;                           // グレイン（0〜100）
let angle = 0;                           // 傾き（度・-45〜+45）
let currentRecipe = null;

// ---- レシピ ----
function lutRecipe(rL, gL, bL) {
  return (img) => {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = rL[d[i]]; d[i + 1] = gL[d[i + 1]]; d[i + 2] = bL[d[i + 2]]; }
  };
}
function monoRecipe(toneL, tR, tG, tB) {
  return (img) => {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      const v = toneL[y];
      d[i] = v * tR; d[i + 1] = v * tG; d[i + 2] = v * tB;
    }
  };
}
const RECIPES = (window.RECIPE_DATA || []).map((d) => ({
  id: d.id, name: d.name,
  apply: d.type === 'mono'
    ? monoRecipe(d.tone, d.tint[0], d.tint[1], d.tint[2])
    : lutRecipe(d.R, d.G, d.B),
}));

// ---- 料理向けの仕上げ（MESHITERO専用）----
// 色ごとの変換表(LUT)では出せない「鮮やかさ・明瞭度・シャープ」を後処理で軽く足す。
// 数値はすべて控えめ。強すぎたらここを下げる（saturation:1.0=変化なし／clarity・sharpen:0=効果なし）。
const FINISH = {
  meshitero: { saturation: 1.12, clarity: 0.15, sharpen: 0.30 },
};

// 箱ぼかし：各画素をまわり半径rの平均に置き換える（明瞭度・シャープの「ぼかし版」を作るのに使う）。
// 端は同じ画素を繰り返す扱い。合計を持ち回るので半径が大きくても速い。縦横に分けて2回かける。
function boxBlur(src, w, h, r) {
  const win = 2 * r + 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {                 // 横方向
    const off = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[off + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[off + x] = sum / win;
      sum += src[off + Math.min(w - 1, x + r + 1)] - src[off + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {                 // 縦方向
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// 仕上げ本体。d=画素データ(RGBA)、w×h=サイズ、p=強さ設定。
function applyFinish(d, w, h, p) {
  // 1) 彩度：各画素で「その画素の明るさ(灰色)」との差を saturation 倍に広げる（明るさ自体は変えない）
  const s = p.saturation || 1;
  if (s !== 1) {
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = L + (d[i] - L) * s;
      d[i + 1] = L + (d[i + 1] - L) * s;
      d[i + 2] = L + (d[i + 2] - L) * s;
    }
  }
  // 2) 明瞭度＋シャープ：明るさ成分だけを強調（色ズレ・色ノイズを防ぐ）
  const clarity = p.clarity || 0, sharpen = p.sharpen || 0;
  if (clarity <= 0 && sharpen <= 0) return;
  const n = w * h;
  const Y = new Float32Array(n);                // 明るさ
  for (let i = 0, j = 0; i < d.length; i += 4, j++) Y[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  // 明瞭度＝広めのぼかし（画像サイズに比例＝プレビューと保存で見た目一致）／シャープ＝1画素の細部
  const rBig = Math.max(3, Math.round(Math.min(w, h) * 0.02));
  const blurBig = clarity > 0 ? boxBlur(Y, w, h, rBig) : null;
  const blurSmall = sharpen > 0 ? boxBlur(Y, w, h, 1) : null;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let add = 0;
    if (clarity > 0) {
      const mid = 1 - Math.abs(Y[j] - 128) / 128; // 中間調ほど強く＝白飛び/黒つぶれ付近のフチ(ハロ)を抑える
      add += clarity * mid * (Y[j] - blurBig[j]);
    }
    if (sharpen > 0) add += sharpen * (Y[j] - blurSmall[j]);
    if (add) { d[i] += add; d[i + 1] += add; d[i + 2] += add; }
  }
}

function show(name) { for (const k in screens) screens[k].classList.toggle('is-active', k === name); }

// ---- レシピ選択ボタン ----
function addChip(label, recipe) {
  const b = document.createElement('button');
  b.className = 'recipe-chip'; b.type = 'button'; b.textContent = label;
  b.dataset.id = recipe ? recipe.id : 'none';
  b.addEventListener('click', () => {
    if (!originalCanvas) return;
    currentRecipe = recipe; renderPreview(); updateChips();
    statusEl.textContent = recipe ? `${recipe.name} を適用中` : '元の色に戻しました。';
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

// ---- 明るさ＋レシピをまとめて当てる ----
function applyAdjustments(ctx, w, h) {
  if (exposure === 0 && !currentRecipe && grain === 0) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  if (exposure !== 0) {
    // 最大±0.5段。中央付近ほど効きが弱く＝微調整しやすい（べき1.5）
    const n = exposure / 100;
    const stops = 0.5 * Math.sign(n) * Math.pow(Math.abs(n), 1.5);
    const f = Math.pow(2, stops);
    for (let i = 0; i < d.length; i += 4) { d[i] *= f; d[i + 1] *= f; d[i + 2] *= f; }
  }
  if (currentRecipe) currentRecipe.apply(img);
  if (currentRecipe && FINISH[currentRecipe.id]) applyFinish(d, w, h, FINISH[currentRecipe.id]);
  if (grain !== 0) {
    // モノクロの粒（明暗のノイズ）。三角分布で自然に。色ではなく明るさに乗せる。
    const amp = (grain / 100) * 50;
    for (let i = 0; i < d.length; i += 4) {
      const g = (Math.random() + Math.random() - 1) * amp;
      d[i] += g; d[i + 1] += g; d[i + 2] += g;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---- 回転（傾き補正）つきステージ描画 ----
// ステージ＝元画像を中心まわりに angle 度回転し、枠(W0×H0)を隙間なく覆うよう拡大したもの。
function coverScale(W, H, rad) {
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  return Math.max((W * c + H * s) / W, (H * c + W * s) / H);
}
function renderStage(ctx, dstW, dstH, sx, sy, sw, sh) {
  const W0 = originalCanvas.width, H0 = originalCanvas.height;
  const rad = angle * Math.PI / 180;
  const s = coverScale(W0, H0, rad);
  ctx.save();
  ctx.clearRect(0, 0, dstW, dstH);
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(dstW / sw, dstH / sh);
  ctx.translate(-sx, -sy);
  ctx.translate(W0 / 2, H0 / 2);
  ctx.rotate(rad);
  ctx.scale(s, s);
  ctx.drawImage(originalCanvas, -W0 / 2, -H0 / 2);
  ctx.restore();
}

// ---- 読み込み ----
async function loadFile(file) {
  const isJpeg = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);
  if (!isJpeg) { alert('JPEGの写真を選んでください。'); return; }
  busy(true);
  try {
    const img = await decodeOriented(file);
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    originalCanvas = document.createElement('canvas');
    originalCanvas.width = w; originalCanvas.height = h;
    originalCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
    if (img.close) img.close();
    cropRect = { x: 0, y: 0, w: w, h: h };
    exposure = 0; exposureEl.value = 0;
    grain = 0; grainEl.value = 0;
    angle = 0; angleEl.value = 0;
    currentRecipe = null;
    exitCropMode(true);
    setupPreview(); renderPreview(); updateChips();
    statusEl.textContent = '';
    show('editor');
  } catch (e) {
    alert('写真を読み込めませんでした。別の写真で試してください。');
  } finally {
    busy(false);
  }
}
async function decodeOriented(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return img;
  } finally { URL.revokeObjectURL(url); }
}

// ---- プレビュー ----
function setupPreview() {
  const maxW = Math.min(window.innerWidth - 32, 1000);
  const maxH = Math.min(window.innerHeight * 0.5, 1400);
  const scale = Math.min(maxW / cropRect.w, maxH / cropRect.h, 1);
  previewCanvas.width = Math.max(1, Math.round(cropRect.w * scale));
  previewCanvas.height = Math.max(1, Math.round(cropRect.h * scale));
}
function renderPreview() {
  renderStage(pctx, previewCanvas.width, previewCanvas.height, cropRect.x, cropRect.y, cropRect.w, cropRect.h);
  applyAdjustments(pctx, previewCanvas.width, previewCanvas.height);
}

// ---- 明るさ ----
exposureEl.addEventListener('input', () => {
  if (!originalCanvas || cropMode) return;
  exposure = Number(exposureEl.value); renderPreview();
});
expResetEl.addEventListener('click', () => {
  exposure = 0; exposureEl.value = 0;
  if (originalCanvas && !cropMode) renderPreview();
});
grainEl.addEventListener('input', () => {
  if (!originalCanvas || cropMode) return;
  grain = Number(grainEl.value); renderPreview();
});
grainResetEl.addEventListener('click', () => {
  grain = 0; grainEl.value = 0;
  if (originalCanvas && !cropMode) renderPreview();
});

/* ==================================================================
   トリミング（切り抜き＋傾き補正）
================================================================== */
let cropMode = false;
let cropScale = 1;
let cropRatio = 'free';
let box = { x: 0, y: 0, w: 0, h: 0 };
let drag = null;

function updateStageCache() {
  stageCache.width = previewCanvas.width; stageCache.height = previewCanvas.height;
  renderStage(stageCache.getContext('2d'), stageCache.width, stageCache.height, 0, 0, originalCanvas.width, originalCanvas.height);
}
function enterCropMode() {
  if (!originalCanvas) return;
  cropMode = true;
  previewCanvas.classList.add('cropping');
  const maxW = Math.min(window.innerWidth - 32, 1000);
  const maxH = Math.min(window.innerHeight * 0.46, 1400);
  const s = Math.min(maxW / originalCanvas.width, maxH / originalCanvas.height, 1);
  previewCanvas.width = Math.max(1, Math.round(originalCanvas.width * s));
  previewCanvas.height = Math.max(1, Math.round(originalCanvas.height * s));
  cropScale = originalCanvas.width / previewCanvas.width;
  box = { x: cropRect.x / cropScale, y: cropRect.y / cropScale, w: cropRect.w / cropScale, h: cropRect.h / cropScale };
  angleEl.value = angle;
  normalControls.hidden = true; cropControls.hidden = false;
  statusEl.textContent = '枠と角度を調整して「適用」を押してください。';
  updateStageCache(); drawCrop();
}
function exitCropMode(silent) {
  cropMode = false; drag = null;
  previewCanvas.classList.remove('cropping');
  normalControls.hidden = false; cropControls.hidden = true;
  if (!silent) { setupPreview(); renderPreview(); statusEl.textContent = ''; }
}
function drawCrop() {
  const W = previewCanvas.width, H = previewCanvas.height;
  pctx.clearRect(0, 0, W, H);
  pctx.drawImage(stageCache, 0, 0);
  pctx.save();
  pctx.fillStyle = 'rgba(0,0,0,.5)';
  pctx.beginPath(); pctx.rect(0, 0, W, H); pctx.rect(box.x, box.y, box.w, box.h); pctx.fill('evenodd');
  pctx.restore();
  pctx.strokeStyle = 'rgba(255,255,255,.95)'; pctx.lineWidth = 2;
  pctx.strokeRect(box.x, box.y, box.w, box.h);
  pctx.lineWidth = 1; pctx.strokeStyle = 'rgba(255,255,255,.4)';
  for (let i = 1; i < 3; i++) {
    pctx.beginPath(); pctx.moveTo(box.x + box.w * i / 3, box.y); pctx.lineTo(box.x + box.w * i / 3, box.y + box.h); pctx.stroke();
    pctx.beginPath(); pctx.moveTo(box.x, box.y + box.h * i / 3); pctx.lineTo(box.x + box.w, box.y + box.h * i / 3); pctx.stroke();
  }
  pctx.fillStyle = '#fff'; const hs = 7;
  [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]]
    .forEach(([cx, cy]) => pctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2));
}
function toCanvas(e) {
  const r = previewCanvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (previewCanvas.width / r.width), y: (e.clientY - r.top) * (previewCanvas.height / r.height) };
}
function hitTest(x, y) {
  const hs = 16;
  const c = { tl: [box.x, box.y], tr: [box.x + box.w, box.y], bl: [box.x, box.y + box.h], br: [box.x + box.w, box.y + box.h] };
  for (const k in c) { if (Math.abs(x - c[k][0]) <= hs && Math.abs(y - c[k][1]) <= hs) return k; }
  if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return 'move';
  return null;
}
function moveBox(dx, dy) {
  const W = previewCanvas.width, H = previewCanvas.height;
  box.x = Math.max(0, Math.min(box.x + dx, W - box.w));
  box.y = Math.max(0, Math.min(box.y + dy, H - box.h));
}
function resizeBox(type, px, py) {
  const W = previewCanvas.width, H = previewCanvas.height, MIN = 30;
  let fx, fy;
  if (type === 'br') { fx = box.x; fy = box.y; }
  else if (type === 'tl') { fx = box.x + box.w; fy = box.y + box.h; }
  else if (type === 'tr') { fx = box.x; fy = box.y + box.h; }
  else { fx = box.x + box.w; fy = box.y; }
  px = Math.max(0, Math.min(W, px)); py = Math.max(0, Math.min(H, py));
  const dirX = px >= fx ? 1 : -1, dirY = py >= fy ? 1 : -1;
  let w = Math.abs(px - fx), h = Math.abs(py - fy);
  const availW = dirX > 0 ? W - fx : fx, availH = dirY > 0 ? H - fy : fy;
  if (cropRatio !== 'free') {
    const r = cropRatio;
    if (w / h > r) h = w / r; else w = h * r;
    if (w > availW) { w = availW; h = w / r; }
    if (h > availH) { h = availH; w = h * r; }
  } else { w = Math.min(w, availW); h = Math.min(h, availH); }
  w = Math.max(MIN, w); h = Math.max(MIN, h);
  box.x = dirX > 0 ? fx : fx - w;
  box.y = dirY > 0 ? fy : fy - h;
  box.w = w; box.h = h;
  box.x = Math.max(0, Math.min(box.x, W - box.w));
  box.y = Math.max(0, Math.min(box.y, H - box.h));
}
function fitBoxToRatio() {
  if (cropRatio === 'free' || !originalCanvas) return;
  const W = previewCanvas.width, H = previewCanvas.height;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let w = box.w, h = w / cropRatio;
  if (h > box.h) { h = box.h; w = h * cropRatio; }
  if (w > W) { w = W; h = w / cropRatio; }
  if (h > H) { h = H; w = h * cropRatio; }
  box.w = w; box.h = h;
  box.x = Math.max(0, Math.min(cx - w / 2, W - w));
  box.y = Math.max(0, Math.min(cy - h / 2, H - h));
  drawCrop();
}
function setRatio(rStr) {
  cropRatio = rStr === 'free' ? 'free' : (() => { const [a, b] = rStr.split(':').map(Number); return a / b; })();
  Array.from(ratiosEl.children).forEach((b) => b.classList.toggle('is-on', b.dataset.ratio === rStr));
  fitBoxToRatio();
}
function swapOrientation() {
  if (!originalCanvas) return;
  if (cropRatio !== 'free') { cropRatio = 1 / cropRatio; fitBoxToRatio(); return; }
  // 自由：現在の枠の縦横を入れ替え
  const W = previewCanvas.width, H = previewCanvas.height;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const w = Math.min(box.h, W), h = Math.min(box.w, H);
  box.w = w; box.h = h;
  box.x = Math.max(0, Math.min(cx - w / 2, W - w));
  box.y = Math.max(0, Math.min(cy - h / 2, H - h));
  drawCrop();
}

previewCanvas.addEventListener('pointerdown', (e) => {
  if (!cropMode) return;
  const p = toCanvas(e); const t = hitTest(p.x, p.y);
  if (!t) return;
  previewCanvas.setPointerCapture(e.pointerId);
  drag = { type: t, lastX: p.x, lastY: p.y }; e.preventDefault();
});
previewCanvas.addEventListener('pointermove', (e) => {
  if (!cropMode || !drag) return;
  const p = toCanvas(e);
  if (drag.type === 'move') { moveBox(p.x - drag.lastX, p.y - drag.lastY); drag.lastX = p.x; drag.lastY = p.y; }
  else { resizeBox(drag.type, p.x, p.y); }
  drawCrop(); e.preventDefault();
});
previewCanvas.addEventListener('pointerup', () => { drag = null; });
previewCanvas.addEventListener('pointercancel', () => { drag = null; });

cropBtn.addEventListener('click', enterCropMode);
cropCancel.addEventListener('click', () => exitCropMode(false));
cropApply.addEventListener('click', () => {
  let x = Math.round(box.x * cropScale), y = Math.round(box.y * cropScale);
  let w = Math.round(box.w * cropScale), h = Math.round(box.h * cropScale);
  x = Math.max(0, Math.min(x, originalCanvas.width - 1));
  y = Math.max(0, Math.min(y, originalCanvas.height - 1));
  w = Math.max(1, Math.min(w, originalCanvas.width - x));
  h = Math.max(1, Math.min(h, originalCanvas.height - y));
  cropRect = { x, y, w, h };
  exitCropMode(false);
});
ratiosEl.addEventListener('click', (e) => {
  const b = e.target.closest('.ratio-chip'); if (!b) return;
  setRatio(b.dataset.ratio);
});
swapOrientEl.addEventListener('click', swapOrientation);
angleEl.addEventListener('input', () => {
  if (!cropMode) return;
  angle = Number(angleEl.value);
  updateStageCache(); drawCrop();
});
angleResetEl.addEventListener('click', () => {
  angle = 0; angleEl.value = 0;
  if (cropMode) { updateStageCache(); drawCrop(); }
});

// ---- 保存 ----
saveBtn.addEventListener('click', async () => {
  if (!originalCanvas) return;
  busy(true); statusEl.textContent = '保存用に書き出しています…';
  try {
    const out = document.createElement('canvas');
    out.width = cropRect.w; out.height = cropRect.h;
    const octx = out.getContext('2d', { willReadFrequently: true });
    renderStage(octx, cropRect.w, cropRect.h, cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    applyAdjustments(octx, cropRect.w, cropRect.h);
    const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) throw new Error('toBlob returned null');
    const fname = `analogital_${stamp()}.jpg`;
    downloadBlob(blob, fname);
    statusEl.textContent = `保存しました：${fname}`;
  } catch (e) {
    statusEl.textContent = '保存に失敗しました。もう一度お試しください。';
  } finally { busy(false); }
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
function busy(on) { busyEl.hidden = !on; saveBtn.disabled = on; }

// ---- イベント ----
pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); fileInput.value = ''; });
backBtn.addEventListener('click', () => { if (cropMode) { exitCropMode(false); return; } show('home'); originalCanvas = null; });
let resizeTimer;
window.addEventListener('resize', () => {
  if (!originalCanvas || cropMode || !screens.editor.classList.contains('is-active')) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { setupPreview(); renderPreview(); }, 150);
});

buildChips();
