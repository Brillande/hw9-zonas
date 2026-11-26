// Conexión con la banda COOSPO HW9 mediante el perfil BLE estándar
// Heart Rate (0x180D). Sirve para cualquier banda que lo implemente.
// En Android se usa Bluetooth nativo (BleClient); en el navegador, Web
// Bluetooth directamente (Chrome, Edge, Bluefy en iOS…).

import { BleClient, numberToUUID } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';
import { parseHeartRate } from './hr-parse.js';

const HR_SERVICE = numberToUUID(0x180d);
const HR_MEASUREMENT = numberToUUID(0x2a37);
const BATTERY_SERVICE = numberToUUID(0x180f);
const BATTERY_LEVEL = numberToUUID(0x2a19);
const MAX_RECONNECT_ATTEMPTS = 20;
const CONNECT_TIMEOUT_MS = 10000;

const isNative = Capacitor.isNativePlatform();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const bluetoothAvailable = () => isNative || !!navigator.bluetooth;

// Cada navegador entrega el valor a su manera (DataView en Chrome; otros
// pueden dar un ArrayBuffer o un array tipado): se normaliza a DataView.
export function toDataView(value) {
  if (!value) return null;
  if (typeof value.getUint8 === 'function' && 'byteLength' in value) return value;
  if (ArrayBuffer.isView(value)) return new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (Array.isArray(value)) return new DataView(Uint8Array.from(value).buffer);
  return null;
}

class Monitor extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// Eventos: 'status' (connecting | connected | reconnecting | disconnected),
// 'hr' ({ bpm, contact, rr, energy }) y 'battery' (0-100).
export class HrMonitor extends Monitor {
  device = null;
  #manual = false;
  #reconnecting = false;
  // Solo web: el BluetoothDevice y las características con listener puesto.
  #web = null;
  #hrChar = null;
  #batteryChar = null;

  get name() {
    return this.device?.name || 'Banda';
  }

  async connect() {
    if (isNative) {
      await BleClient.initialize({ androidNeverForLocation: true });
      if (!(await BleClient.isEnabled())) await BleClient.requestEnable();
      this.device = await BleClient.requestDevice({
        services: [HR_SERVICE],
        optionalServices: [BATTERY_SERVICE],
      });
    } else {
      this.#web = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE] }],
        optionalServices: [BATTERY_SERVICE],
      });
      this.#web.addEventListener('gattserverdisconnected', this.#onDisconnect);
      this.device = { deviceId: this.#web.id, name: this.#web.name };
    }
    this.emit('status', 'connecting');
    try {
      await this.#open();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect() {
    this.#manual = true;
    try {
      if (this.#web) this.#web.gatt?.disconnect();
      else if (this.device) await BleClient.disconnect(this.device.deviceId);
    } catch {}
    this.emit('status', 'disconnected');
  }

  async #open() {
    if (this.#web) await this.#openWeb();
    else await this.#openNative();
    this.emit('status', 'connected');
    this.#watchBattery();
  }

  async #openNative() {
    const id = this.device.deviceId;
    await BleClient.connect(id, this.#onDisconnect);
    await BleClient.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, (value) => this.#onHr(value));
  }

  // En la web no se usa BleClient: la librería reparte cada notificación
  // buscando su listener por los UUID que informa el navegador. Chrome los da
  // en minúsculas y formato largo, como los registra la librería; Bluefy (iOS)
  // no, así que conectaba pero todas las lecturas de pulso se perdían.
  async #openWeb() {
    const gatt = this.#web.gatt;
    let server;
    try {
      server = await withTimeout(gatt.connect(), CONNECT_TIMEOUT_MS, 'Connection timeout');
    } catch (err) {
      try {
        gatt.disconnect();
      } catch {}
      throw err;
    }
    const service = await server.getPrimaryService(HR_SERVICE);
    const characteristic = await service.getCharacteristic(HR_MEASUREMENT);
    this.#hrChar?.removeEventListener('characteristicvaluechanged', this.#onHrEvent);
    this.#hrChar = characteristic;
    characteristic.addEventListener('characteristicvaluechanged', this.#onHrEvent);
    await characteristic.startNotifications();
  }

  #onHrEvent = (event) => this.#onHr(event?.target?.value ?? this.#hrChar?.value);

  #onHr(value) {
    const view = toDataView(value);
    if (view && view.byteLength >= 2) this.emit('hr', parseHeartRate(view));
  }

  // La batería es opcional: si la banda no la expone, se ignora.
  async #watchBattery() {
    try {
      if (this.#web) await this.#watchBatteryWeb();
      else await this.#watchBatteryNative();
    } catch {}
  }

  async #watchBatteryNative() {
    const id = this.device.deviceId;
    this.emit('battery', (await BleClient.read(id, BATTERY_SERVICE, BATTERY_LEVEL)).getUint8(0));
    await BleClient.startNotifications(id, BATTERY_SERVICE, BATTERY_LEVEL, (value) => {
      this.emit('battery', value.getUint8(0));
    });
  }

  async #watchBatteryWeb() {
    const service = await this.#web.gatt.getPrimaryService(BATTERY_SERVICE);
    const characteristic = await service.getCharacteristic(BATTERY_LEVEL);
    const level = toDataView(await characteristic.readValue());
    if (level?.byteLength) this.emit('battery', level.getUint8(0));
    this.#batteryChar?.removeEventListener('characteristicvaluechanged', this.#onBatteryEvent);
    this.#batteryChar = characteristic;
    characteristic.addEventListener('characteristicvaluechanged', this.#onBatteryEvent);
    await characteristic.startNotifications();
  }

  #onBatteryEvent = (event) => {
    const view = toDataView(event?.target?.value ?? this.#batteryChar?.value);
    if (view?.byteLength) this.emit('battery', view.getUint8(0));
  };

  #onDisconnect = async () => {
    if (this.#manual || this.#reconnecting) return;
    this.#reconnecting = true;
    this.emit('status', 'reconnecting');
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS && !this.#manual; attempt++) {
      await sleep(Math.min(attempt * 1000, 5000));
      try {
        await this.#open();
        this.#reconnecting = false;
        return;
      } catch {}
    }
    this.#reconnecting = false;
    if (!this.#manual) this.emit('status', 'disconnected');
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Pulso simulado para probar la app sin banda.
export class DemoMonitor extends Monitor {
  name = 'Demo';
  #timer = null;
  #getMaxHr;

  constructor(getMaxHr) {
    super();
    this.#getMaxHr = getMaxHr;
  }

  async connect() {
    const startedAt = Date.now();
    let energyAccum = 0;
    this.emit('status', 'connected');
    this.emit('battery', 100);
    this.#timer = setInterval(() => {
      const t = (Date.now() - startedAt) / 1000;
      const wave = (1 - Math.cos((2 * Math.PI * t) / 180)) / 2; // ciclo de 3 min
      const pct = 0.52 + wave * 0.43;
      const bpm = Math.round(this.#getMaxHr() * pct + (Math.random() * 4 - 2));
      const rr = [Math.round(60000 / bpm + (Math.random() * 60 - 30))];
      energyAccum += bpm / 60;
      this.emit('hr', { bpm, contact: true, rr, energy: Math.round(energyAccum) });
    }, 1000);
  }

  async disconnect() {
    clearInterval(this.#timer);
    this.emit('status', 'disconnected');
  }
}
