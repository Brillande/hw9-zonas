// Conexión con la banda COOSPO HW9 mediante el perfil BLE estándar
// Heart Rate (0x180D). Sirve para cualquier banda que lo implemente.
// BleClient usa Bluetooth nativo en Android y Web Bluetooth en el navegador.

import { BleClient, numberToUUID } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';
import { parseHeartRate } from './hr-parse.js';

const HR_SERVICE = numberToUUID(0x180d);
const HR_MEASUREMENT = numberToUUID(0x2a37);
const BATTERY_SERVICE = numberToUUID(0x180f);
const BATTERY_LEVEL = numberToUUID(0x2a19);
const MAX_RECONNECT_ATTEMPTS = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const bluetoothAvailable = () => Capacitor.isNativePlatform() || !!navigator.bluetooth;

class Monitor extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// Eventos: 'status' (connecting | connected | reconnecting | disconnected),
// 'hr' ({ bpm, contact, rr }) y 'battery' (0-100).
export class HrMonitor extends Monitor {
  device = null;
  #manual = false;
  #reconnecting = false;

  get name() {
    return this.device?.name || 'Banda';
  }

  async connect() {
    await BleClient.initialize({ androidNeverForLocation: true });
    if (Capacitor.isNativePlatform() && !(await BleClient.isEnabled())) await BleClient.requestEnable();
    this.device = await BleClient.requestDevice({
      services: [HR_SERVICE],
      optionalServices: [BATTERY_SERVICE],
    });
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
      if (this.device) await BleClient.disconnect(this.device.deviceId);
    } catch {}
    this.emit('status', 'disconnected');
  }

  async #open() {
    const id = this.device.deviceId;
    await BleClient.connect(id, this.#onDisconnect);
    await BleClient.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, (value) => {
      this.emit('hr', parseHeartRate(value));
    });
    this.emit('status', 'connected');
    this.#watchBattery(id);
  }

  // La batería es opcional: si la banda no la expone, se ignora.
  async #watchBattery(id) {
    try {
      this.emit('battery', (await BleClient.read(id, BATTERY_SERVICE, BATTERY_LEVEL)).getUint8(0));
      await BleClient.startNotifications(id, BATTERY_SERVICE, BATTERY_LEVEL, (value) => {
        this.emit('battery', value.getUint8(0));
      });
    } catch {}
  }

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
    this.emit('status', 'connected');
    this.emit('battery', 100);
    this.#timer = setInterval(() => {
      const t = (Date.now() - startedAt) / 1000;
      const wave = (1 - Math.cos((2 * Math.PI * t) / 180)) / 2; // ciclo de 3 min
      const pct = 0.52 + wave * 0.43;
      const bpm = Math.round(this.#getMaxHr() * pct + (Math.random() * 4 - 2));
      const rr = [Math.round(60000 / bpm + (Math.random() * 60 - 30))];
      this.emit('hr', { bpm, contact: true, rr });
    }, 1000);
  }

  async disconnect() {
    clearInterval(this.#timer);
    this.emit('status', 'disconnected');
  }
}
