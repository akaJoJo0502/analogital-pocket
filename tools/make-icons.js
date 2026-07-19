'use strict';
/* アプリのアイコンPNGを外部ライブラリなしで生成する開発用スクリプト。
   出力（アプリと同じフォルダ）: icon-192.png / icon-512.png / icon-maskable-512.png
   実行: node tools/make-icons.js */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- PNGエンコード（RGBA・フィルタ0）---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf){ let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba){
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- 描画（暖色の角丸＋レンズ風のリング＋中心のドット）---
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const lerp = (a, b, t) => a + (b - a) * t;
function sdRoundRect(px, py, hw, hh, r){
  const qx = Math.abs(px) - hw + r, qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const dark = [58, 42, 26], amber = [190, 126, 60], cream = [245, 233, 216];

function drawIcon(size, maskable){
  const rgba = Buffer.alloc(size * size * 4);
  const aa = size / 200;
  const c = (size - 1) / 2;
  const half = size / 2 - size * 0.06;
  const radius = size * 0.22;
  const ringR = size * (maskable ? 0.24 : 0.28);
  const ringT = size * 0.052;
  const dotR = size * 0.072;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x - c, py = y - c;
      // 背景（maskableは全面塗り／通常は角丸で外側は透明）
      const bgA = maskable ? 1 : clamp(0.5 - sdRoundRect(px, py, half, half, radius) / aa, 0, 1);
      const gt = clamp((x + y) / (2 * size), 0, 1);
      let R = lerp(dark[0], amber[0], gt), G = lerp(dark[1], amber[1], gt), B = lerp(dark[2], amber[2], gt);
      // 前景（リング＋ドット）
      const dist = Math.hypot(px, py);
      const ringA = clamp((ringT - Math.abs(dist - ringR)) / aa + 0.5, 0, 1);
      const dotA = clamp((dotR - dist) / aa + 0.5, 0, 1);
      const fgA = Math.max(ringA, dotA);
      R = lerp(R, cream[0], fgA); G = lerp(G, cream[1], fgA); B = lerp(B, cream[2], fgA);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(clamp(R, 0, 255));
      rgba[i + 1] = Math.round(clamp(G, 0, 255));
      rgba[i + 2] = Math.round(clamp(B, 0, 255));
      rgba[i + 3] = Math.round(clamp(bgA, 0, 1) * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.resolve(__dirname, '..');
fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192, false));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512, false));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), drawIcon(512, true));
console.log('icons written: icon-192.png, icon-512.png, icon-maskable-512.png');
