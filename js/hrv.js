export function filterRR(rrMs) {
  const valid = rrMs.filter((v) => v >= 300 && v <= 2000);
  if (valid.length < 5) return valid;
  const result = [];
  for (let i = 0; i < valid.length; i++) {
    const start = Math.max(0, i - 2);
    const end = Math.min(valid.length - 1, i + 2);
    const neighbors = [];
    for (let j = start; j <= end; j++) neighbors.push(valid[j]);
    neighbors.sort((a, b) => a - b);
    const median = neighbors[Math.floor(neighbors.length / 2)];
    if (Math.abs(valid[i] - median) <= median * 0.2) result.push(valid[i]);
  }
  return result;
}

export function computeRMSSD(rrMs) {
  const rr = filterRR(rrMs);
  if (rr.length < 5) return null;
  let sum = 0;
  for (let i = 1; i < rr.length; i++) {
    const diff = rr[i] - rr[i - 1];
    sum += diff * diff;
  }
  return Math.sqrt(sum / (rr.length - 1));
}

export function computeSDNN(rrMs) {
  const rr = filterRR(rrMs);
  if (rr.length < 5) return null;
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  const variance = rr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / rr.length;
  return Math.sqrt(variance);
}

export function computePNN50(rrMs) {
  const rr = filterRR(rrMs);
  if (rr.length < 5) return null;
  let count = 0;
  for (let i = 1; i < rr.length; i++) {
    if (Math.abs(rr[i] - rr[i - 1]) > 50) count++;
  }
  return (count / (rr.length - 1)) * 100;
}
