// Web Bluetooth simulado. Cada `mode` imita una forma distinta en que un
// navegador puede entregar las notificaciones; Bluefy (iOS) da además los UUID
// cortos y en mayúsculas, como CoreBluetooth, y no como Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HrMonitor, bleLog, isUuid, toDataView } from '../js/ble.js';

const EVENT = 'characteristicvaluechanged';

class FakeCharacteristic extends EventTarget {
  value = null;
  notifying = false;
  starts = 0;
  properties = { notify: true, indicate: false, read: false };
  constructor(uuid, service, read) {
    super();
    this.uuid = uuid;
    this.service = service;
    this.read = read;
  }
  async startNotifications() {
    this.starts++;
    this.notifying = true;
    return this;
  }
  async stopNotifications() {
    this.notifying = false;
    return this;
  }
  async readValue() {
    return this.read;
  }
}

function fakeBand({ mode = 'characteristic', sendAfterStarts = 1, hangStart = false } = {}) {
  const bluetooth = new EventTarget();
  bluetooth.getAvailability = async () => true;
  const device = new EventTarget();
  device.id = 'BLUEFY-DEVICE-1';
  device.name = 'HW9 123456';
  const hrService = { uuid: '180D', device };
  const batService = { uuid: '180F', device };
  const hr = new FakeCharacteristic('2A37', hrService);
  const battery = new FakeCharacteristic('2A19', batService, new DataView(Uint8Array.of(87).buffer));
  const short = (uuid) => uuid.slice(4, 8).toUpperCase();
  let connected = false;
  const server = {
    async getPrimaryService(uuid) {
      if (short(uuid) === '180D') return { ...hrService, getCharacteristic: async () => hr };
      if (short(uuid) === '180F') return { ...batService, getCharacteristic: async () => battery };
      throw new DOMException('Service not found', 'NotFoundError');
    },
  };
  device.gatt = {
    get connected() {
      return connected;
    },
    async connect() {
      connected = true;
      return server;
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    getPrimaryService: (uuid) => server.getPrimaryService(uuid),
  };
  bluetooth.requestDevice = async () => device;
  if (hangStart) {
    // startNotifications suscribe, pero su promesa no se resuelve nunca.
    hr.startNotifications = () => {
      hr.starts++;
      hr.notifying = true;
      return new Promise(() => {});
    };
  }

  function push(bytes) {
    if (!hr.notifying || hr.starts < sendAfterStarts) return;
    const value = new DataView(Uint8Array.from(bytes).buffer);
    switch (mode) {
      case 'characteristic':
        hr.value = value;
        hr.dispatchEvent(new Event(EVENT));
        break;
      case 'late-value': // el valor se pone después de emitir el evento
        hr.value = null;
        hr.dispatchEvent(new Event(EVENT));
        hr.value = value;
        break;
      case 'device-only': // el evento llega al dispositivo, no a la característica
        hr.value = value;
        device.dispatchEvent(new Event(EVENT));
        break;
      case 'property-only': // solo se llama a oncharacteristicvaluechanged
        hr.value = value;
        hr.oncharacteristicvaluechanged?.({ target: hr });
        break;
      case 'bubbling': {
        // Como Chrome: el mismo evento pasa por característica, dispositivo y navigator.bluetooth.
        hr.value = value;
        const event = new Event(EVENT);
        hr.dispatchEvent(event);
        device.dispatchEvent(event);
        bluetooth.dispatchEvent(event);
        break;
      }
      case 'separate-events': // un evento distinto por cada vía
        hr.value = value;
        hr.dispatchEvent(new Event(EVENT));
        device.dispatchEvent(new Event(EVENT));
        break;
      case 'array-value': // el valor como lista de bytes en el propio evento
        hr.value = null;
        hr.dispatchEvent(Object.assign(new Event(EVENT), { value: [...bytes] }));
        break;
    }
  }

  Object.defineProperty(globalThis, 'navigator', {
    value: { bluetooth, userAgent: 'test (Bluefy simulado)' },
    configurable: true,
  });
  return { device, hr, push };
}

const until = async (check, ms = 1000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
};
const settle = () => new Promise((r) => setTimeout(r, 30));

function record(monitor) {
  const rec = { beats: [], statuses: [], battery: null, nodata: 0 };
  monitor.addEventListener('hr', (e) => rec.beats.push(e.detail));
  monitor.addEventListener('status', (e) => rec.statuses.push(e.detail));
  monitor.addEventListener('battery', (e) => (rec.battery = e.detail));
  monitor.addEventListener('nodata', () => rec.nodata++);
  return rec;
}

test('web (Bluefy): las pulsaciones llegan aunque el navegador dé los UUID en otro formato', async () => {
  const band = fakeBand();
  const monitor = new HrMonitor();
  const rec = record(monitor);

  await monitor.connect();
  assert.equal(monitor.name, 'HW9 123456');
  assert.equal(band.hr.starts, 1, 'debe activar las notificaciones de 0x2A37');

  band.push([0x16, 72, 0x00, 0x04]); // 72 ppm, contacto, un RR de 1024/1024 s
  band.push([0x06, 75]);
  assert.ok(await until(() => rec.beats.length === 2), `esperaba 2 lecturas, llegaron ${rec.beats.length}`);
  assert.equal(rec.beats[0].bpm, 72);
  assert.deepEqual(rec.beats[0].rr, [1000]);
  assert.equal(rec.beats[1].bpm, 75);
  assert.ok(await until(() => rec.battery === 87), 'debe leer la batería');
  assert.match(bleLog.text(), /Pulso #1 \(característica\): DataView \[16 48 00 04\] → 72 ppm/);

  // Tras una desconexión inesperada se reconecta y sigue recibiendo pulso, sin duplicar lecturas.
  band.device.gatt.disconnect();
  assert.ok(await until(() => rec.statuses.at(-1) === 'connected' && rec.statuses.includes('reconnecting'), 3000));
  band.push([0x06, 80]);
  assert.ok(await until(() => rec.beats.length === 3));
  await settle();
  assert.equal(rec.beats.length, 3, 'una notificación = una lectura');
  assert.equal(rec.beats[2].bpm, 80);

  await monitor.disconnect();
  assert.equal(rec.statuses.at(-1), 'disconnected');
});

for (const mode of ['late-value', 'device-only', 'property-only', 'bubbling', 'separate-events', 'array-value']) {
  test(`web: llega el pulso cuando el navegador lo entrega así: ${mode}`, async () => {
    const band = fakeBand({ mode });
    const monitor = new HrMonitor();
    const rec = record(monitor);
    await monitor.connect();
    band.push([0x06, 101]);
    await new Promise((r) => setTimeout(r, 200)); // más que la ventana de duplicados
    band.push([0x06, 102]);
    assert.ok(await until(() => rec.beats.length >= 2), `${mode}: llegaron ${rec.beats.length} lecturas`);
    await settle();
    assert.deepEqual(
      rec.beats.map((b) => b.bpm),
      [101, 102],
      `${mode}: cada notificación debe dar exactamente una lectura`,
    );
    await monitor.disconnect();
  });
}

test('web: si no llega nada, reactiva las notificaciones y entonces llega el pulso', async () => {
  const band = fakeBand({ sendAfterStarts: 2 });
  const monitor = new HrMonitor({ watchdogMs: 40 });
  const rec = record(monitor);
  await monitor.connect();
  band.push([0x06, 90]); // se pierde: la primera suscripción "no quedó hecha"
  assert.ok(await until(() => band.hr.starts === 2), 'debe volver a llamar a startNotifications');
  band.push([0x06, 91]);
  assert.ok(await until(() => rec.beats.length === 1));
  assert.equal(rec.beats[0].bpm, 91);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(rec.nodata, 0, 'con pulso no debe avisar de falta de datos');
  await monitor.disconnect();
});

test('web: si nunca llega el pulso, avisa con el evento nodata', async () => {
  fakeBand({ sendAfterStarts: 99 });
  const monitor = new HrMonitor({ watchdogMs: 30 });
  const rec = record(monitor);
  await monitor.connect();
  assert.ok(await until(() => rec.nodata === 1, 1000));
  assert.match(bleLog.text(), /Sigue sin llegar el pulso/);
  await monitor.disconnect();
});

test('web: si startNotifications no responde nunca, se conecta igual y llega el pulso', async () => {
  const band = fakeBand({ hangStart: true });
  const monitor = new HrMonitor({ notifyTimeoutMs: 40, watchdogMs: 5000 });
  const rec = record(monitor);
  await monitor.connect();
  assert.equal(rec.statuses.at(-1), 'connected');
  assert.match(bleLog.text(), /startNotifications no respondió/);
  band.push([0x06, 88]);
  assert.ok(await until(() => rec.beats.length === 1));
  assert.equal(rec.beats[0].bpm, 88);
  await monitor.disconnect();
});

test('isUuid y toDataView aceptan los formatos de cada navegador', () => {
  for (const uuid of ['2a37', '2A37', '00002a37', '00002A37-0000-1000-8000-00805F9B34FB', 0x2a37]) {
    assert.ok(isUuid(uuid, 0x2a37), String(uuid));
  }
  assert.ok(!isUuid('2a19', 0x2a37));
  assert.ok(!isUuid(undefined, 0x2a37));
  const bytes = [0x06, 70];
  for (const value of [
    new DataView(Uint8Array.from(bytes).buffer),
    Uint8Array.from(bytes),
    Uint8Array.from(bytes).buffer,
    bytes,
    { 0: 0x06, 1: 70, length: 2 },
  ]) {
    const view = toDataView(value);
    assert.equal(view?.getUint8(1), 70, Object.prototype.toString.call(value));
  }
  assert.equal(toDataView(null), null);
  assert.equal(toDataView('06 46'), null);
});
