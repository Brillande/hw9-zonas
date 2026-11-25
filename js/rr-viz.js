const RR_MIN = 300;
const RR_MAX = 2000;
const ECTOPIC_THRESHOLD = 0.20;
const MIN_ECTOPIC = 5;

export function preparePoincare(rrMs) {
  const valid = rrMs.filter((v) => v >= RR_MIN && v <= RR_MAX);
  const pairs = [];
  for (let i = 0; i < valid.length - 1; i++) {
    pairs.push({ x: valid[i], y: valid[i + 1] });
  }
  return pairs.length >= 2 ? pairs : [];
}

function rollingMedian(arr, center, halfWindow) {
  const lo = Math.max(0, center - halfWindow);
  const hi = Math.min(arr.length - 1, center + halfWindow);
  const window = [];
  for (let i = lo; i <= hi; i++) window.push(arr[i]);
  window.sort((a, b) => a - b);
  const mid = window.length >> 1;
  return window.length & 1 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
}

export function detectEctopic(rrMs) {
  if (rrMs.length < MIN_ECTOPIC) return [];
  const results = [];
  for (let i = 0; i < rrMs.length; i++) {
    const median = rollingMedian(rrMs, i, 2);
    const deviation = Math.abs(rrMs[i] - median) / median;
    if (deviation > ECTOPIC_THRESHOLD) {
      results.push({ index: i, rr: rrMs[i], median, deviation });
    }
  }
  return results;
}

export function drawPoincare(ctx, data, width, height) {
  if (!data.length) return;
  ctx.clearRect(0, 0, width, height);

  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of data) {
    if (p.x < minV) minV = p.x;
    if (p.y < minV) minV = p.y;
    if (p.x > maxV) maxV = p.x;
    if (p.y > maxV) maxV = p.y;
  }
  const range = maxV - minV || 1;
  const pad = range * 0.1;
  const lo = minV - pad;
  const hi = maxV + pad;
  const scale = (v) => ((v - lo) / (hi - lo));

  const labelPad = 30;
  const plotW = width - labelPad;
  const plotH = height - labelPad;
  const px = (v) => labelPad + scale(v) * plotW;
  const py = (v) => plotH - scale(v) * plotH;

  ctx.strokeStyle = '#4b556344';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px(lo), py(lo));
  ctx.lineTo(px(hi), py(hi));
  ctx.stroke();

  ctx.fillStyle = '#3b9ae1';
  for (const p of data) {
    ctx.beginPath();
    ctx.arc(px(p.x), py(p.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#8b98a8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RR(n)', labelPad + plotW / 2, height - 2);
  ctx.save();
  ctx.translate(10, plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('RR(n+1)', 0, 0);
  ctx.restore();
}
