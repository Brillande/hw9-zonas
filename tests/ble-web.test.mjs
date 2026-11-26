// Web Bluetooth simulado al estilo de Bluefy (iOS): los UUID se informan
// cortos y en mayúsculas, como los da CoreBluetooth, y no como Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeCharacteristic extends EventTarget {
  value = null;
  constructor(uuid, service, { read } = {}) {
    super();
    this.uuid = uuid;
    this.service = service;
    this.read = read;
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async readValue() {
    return this.read;
  }
  push(bytes) {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function fakeBluefy() {
  const device = new EventTarget();
  device.id = 'BLUEFY-DEVICE-1';
  device.name = 'HW9 123456';
  const hrService = { uuid: '180D', device };
  const batService = { uuid: '180F', device };
  const hr = new FakeCharacteristic('2A37', hrService);
  const battery = new FakeCharacteristic('2A19', batService, { read: new DataView(Uint8Array.of(87).buffer) });
  const byUuid = (uuid) => uuid.slice(4, 8).toUpperCase();
  const server = {
    connected: false,
    async getPrimaryService(uuid) {
      if (byUuid(uuid) === '180D') return { ...hrService, getCharacteristic: async () => hr };
      if (byUuid(uuid) === '180F') return { ...batService, getCharacteristic: async () => battery };
      throw new Error('NotFoundError');
    },
  };
  device.gatt = {
    get connected() {
      return server.connected;
    },
    async connect() {
      server.connected = true;
      return server;
    },
    disconnect() {
      if (!server.connected) return;
      server.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    getPrimaryService: (uuid) => server.getPrimaryService(uuid),
  };
  const bluetooth = {
    async getAvailability() {
      return true;
    },
    async requestDevice() {
      return device;
    },
  };
  return { bluetooth, device, hr, battery };
}

const until = async (check, ms = 1000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
};

test('web (Bluefy): las pulsaciones llegan aunque el navegador dé los UUID en otro formato', async () => {
  const fake = fakeBluefy();
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: fake.bluetooth }, configurable: true });
  const { HrMonitor } = await import('../js/ble.js');
  const monitor = new HrMonitor();
  const beats = [];
  const statuses = [];
  let battery = null;
  monitor.addEventListener('hr', (e) => beats.push(e.detail));
  monitor.addEventListener('status', (e) => statuses.push(e.detail));
  monitor.addEventListener('battery', (e) => (battery = e.detail));

  await monitor.connect();
  assert.equal(monitor.name, 'HW9 123456');
  assert.ok(fake.hr.notifying, 'debe activar las notificaciones de 0x2A37');

  fake.hr.push([0x16, 72, 0x00, 0x04]); // 72 ppm, contacto, un RR de 1024/1024 s
  fake.hr.push([0x06, 75]);
  assert.ok(await until(() => beats.length === 2), `esperaba 2 lecturas, llegaron ${beats.length}`);
  assert.equal(beats[0].bpm, 72);
  assert.deepEqual(beats[0].rr, [1000]);
  assert.equal(beats[1].bpm, 75);
  assert.ok(await until(() => battery === 87), 'debe leer la batería');

  // Tras una desconexión inesperada se reconecta y sigue recibiendo pulso, sin duplicar lecturas.
  fake.device.gatt.disconnect();
  assert.ok(await until(() => statuses.at(-1) === 'connected' && statuses.includes('reconnecting'), 3000));
  fake.hr.push([0x06, 80]);
  assert.ok(await until(() => beats.length === 3));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(beats.length, 3, 'una notificación = una lectura');
  assert.equal(beats[2].bpm, 80);

  await monitor.disconnect();
  assert.equal(statuses.at(-1), 'disconnected');
});
