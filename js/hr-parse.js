// Decodifica la característica BLE Heart Rate Measurement (0x2A37).
export function parseHeartRate(view) {
  const flags = view.getUint8(0);
  let i = 1;
  let bpm;
  if (flags & 0x01) {
    bpm = view.getUint16(i, true);
    i += 2;
  } else {
    bpm = view.getUint8(i);
    i += 1;
  }
  const contact = flags & 0x04 ? !!(flags & 0x02) : null;
  let energy = null;
  if (flags & 0x08) {
    energy = view.getUint16(i, true);
    i += 2;
  }
  const rr = [];
  if (flags & 0x10) {
    for (; i + 1 < view.byteLength; i += 2) rr.push(Math.round((view.getUint16(i, true) / 1024) * 1000));
  }
  return { bpm, contact, rr, energy };
}
