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
const WATCHDOG_MS = 6000; // sin pulso en este tiempo, se reactivan las notificaciones
const DETAILED_BEATS = 5; // las primeras lecturas se apuntan con detalle en el registro
const DUPLICATE_MS = 150; // la misma notificación recibida por dos vías
const MAX_LOG_LINES = 120;

const isNative = Capacitor.isNativePlatform();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const typeOf = (value) => Object.prototype.toString.call(value).slice(8, -1);
const errText = (err) => `${err?.name || 'Error'}: ${err?.message || err}`;
const hexBytes = (view) =>
  Array.from({ length: view.byteLength }, (_, i) => view.getUint8(i).toString(16).padStart(2, '0')).join(' ');

export const bluetoothAvailable = () => isNative || !!navigator.bluetooth;

// ---------- Registro de diagnóstico (Ajustes → Diagnóstico Bluetooth) ----------

class BleLog extends EventTarget {
  lines = [];

  add(text) {
    const t = new Date();
    const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    this.lines.push(`${time} ${text}`);
    if (this.lines.length > MAX_LOG_LINES) this.lines.shift();
    this.dispatchEvent(new Event('change'));
  }

  text() {
    return this.lines.join('\n');
  }
}

export const bleLog = new BleLog();
const log = (text) => bleLog.add(text);

// ---------- Valores y UUID en el formato de cada navegador ----------

// UUID tal como lo dé el navegador ('2a37', '2A37', '00002a37-0000-…', 0x2a37)
// frente a un UUID de 16 bits.
export function isUuid(uuid, short) {
  if (uuid == null) return false;
  if (typeof uuid === 'number') return uuid === short;
  const s = String(uuid).toLowerCase().replace(/^0x/, '');
  const want = short.toString(16).padStart(4, '0');
  return s === want || s === `0000${want}` || s.startsWith(`0000${want}-`);
}

// Chrome da un DataView; otros navegadores pueden dar un ArrayBuffer, un array
// tipado o una lista de bytes (a veces de otro contexto JS). Todo a DataView.
export function toDataView(value) {
  if (value == null || typeof value !== 'object') return null;
  if (typeof value.getUint8 === 'function' && typeof value.byteLength === 'number') return value;
  if (ArrayBuffer.isView(value)) return new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (typeOf(value) === 'ArrayBuffer') return new DataView(value);
  if (typeof value.length === 'number') return new DataView(Uint8Array.from(value).buffer);
  return null;
}

function describe(value) {
  if (value == null) return String(value);
  if (typeof value !== 'object') return `${typeof value} ${String(value).slice(0, 40)}`;
  const view = toDataView(value);
  return view ? `${typeOf(value)} [${hexBytes(view)}]` : typeOf(value);
}

class Monitor extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// Eventos: 'status' (connecting | connected | reconnecting | disconnected),
// 'hr' ({ bpm, contact, rr, energy }), 'battery' (0-100) y 'nodata' (conectada
// pero sin recibir pulso, ni siquiera tras reactivar las notificaciones).
export class HrMonitor extends Monitor {
  device = null;
  #manual = false;
  #reconnecting = false;
  #watchdogMs;
  // Solo web: el BluetoothDevice y las características con listener puesto.
  #web = null;
  #hrChar = null;
  #batteryChar = null;
  #seen = new WeakSet(); // eventos ya atendidos (un mismo evento llega por varias vías)
  #beats = 0; // lecturas desde la última (re)conexión
  #invalid = 0;
  #last = { bytes: '', at: 0 };
  #watchdog = null;

  constructor({ watchdogMs = WATCHDOG_MS } = {}) {
    super();
    this.#watchdogMs = watchdogMs;
  }

  get name() {
    return this.device?.name || 'Banda';
  }

  async connect() {
    if (isNative) {
      log('Bluetooth nativo (app Android)');
      await BleClient.initialize({ androidNeverForLocation: true });
      if (!(await BleClient.isEnabled())) await BleClient.requestEnable();
      this.device = await BleClient.requestDevice({
        services: [HR_SERVICE],
        optionalServices: [BATTERY_SERVICE],
      });
    } else {
      log(`Navegador: ${navigator.userAgent}`);
      this.#web = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE] }],
        optionalServices: [BATTERY_SERVICE],
      });
      this.#web.addEventListener('gattserverdisconnected', this.#onDisconnect);
      // Hay navegadores que emiten la notificación en el dispositivo o en
      // navigator.bluetooth y no en la característica: se escucha en todos.
      this.#web.addEventListener('characteristicvaluechanged', this.#onWebValue);
      navigator.bluetooth.addEventListener?.('characteristicvaluechanged', this.#onWebValue);
      this.device = { deviceId: this.#web.id, name: this.#web.name };
    }
    log(`Banda elegida: ${this.device.name || '(sin nombre)'} · id ${this.device.deviceId}`);
    this.emit('status', 'connecting');
    try {
      await this.#open();
    } catch (err) {
      log(`No se pudo conectar: ${errText(err)}`);
      await this.disconnect();
      throw err;
    }
  }

  async disconnect() {
    this.#manual = true;
    clearTimeout(this.#watchdog);
    if (this.#web) {
      try {
        navigator.bluetooth.removeEventListener?.('characteristicvaluechanged', this.#onWebValue);
      } catch {}
      try {
        this.#web.gatt?.disconnect();
      } catch {}
    } else if (this.device) {
      try {
        await BleClient.disconnect(this.device.deviceId);
      } catch {}
    }
    log('Desconectada');
    this.emit('status', 'disconnected');
  }

  async #open() {
    this.#beats = 0;
    this.#invalid = 0;
    if (this.#web) await this.#openWeb();
    else await this.#openNative();
    this.emit('status', 'connected');
    this.#watchBattery();
  }

  async #openNative() {
    const id = this.device.deviceId;
    await BleClient.connect(id, this.#onDisconnect);
    await BleClient.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, (value) => this.#onHr(value));
    log('Notificaciones de pulso activadas');
  }

  // En la web no se usa BleClient: la librería reparte cada notificación
  // buscando su listener por los UUID que informa el navegador. Chrome los da
  // en minúsculas y formato largo, como los registra la librería; Bluefy (iOS)
  // no, así que conectaba pero todas las lecturas de pulso se perdían.
  async #openWeb() {
    clearTimeout(this.#watchdog);
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
    log('Conectada (GATT)');
    const service = await server.getPrimaryService(HR_SERVICE);
    log(`Servicio de pulso: ${service.uuid}`);
    const characteristic = await service.getCharacteristic(HR_MEASUREMENT);
    const p = characteristic.properties || {};
    log(`Característica: ${characteristic.uuid} · notify ${p.notify} · indicate ${p.indicate}`);
    this.#listenHr(characteristic);
    await characteristic.startNotifications();
    log('Notificaciones de pulso activadas; esperando datos…');
    this.#armWatchdog(characteristic, 1);
  }

  #listenHr(characteristic) {
    if (this.#hrChar && this.#hrChar !== characteristic) this.#unlistenHr(this.#hrChar);
    this.#hrChar = characteristic;
    characteristic.addEventListener('characteristicvaluechanged', this.#onWebValue);
    // Hay implementaciones que solo avisan por la propiedad on…
    try {
      characteristic.oncharacteristicvaluechanged = this.#onWebValue;
    } catch {}
  }

  #unlistenHr(characteristic) {
    characteristic.removeEventListener('characteristicvaluechanged', this.#onWebValue);
    try {
      characteristic.oncharacteristicvaluechanged = null;
    } catch {}
  }

  // Si tras activar las notificaciones no llega nada, se reactivan una vez
  // (en iOS a veces la primera suscripción no queda hecha) y, si sigue sin
  // llegar, se avisa.
  #armWatchdog(characteristic, round) {
    clearTimeout(this.#watchdog);
    const before = this.#beats + this.#invalid;
    this.#watchdog = setTimeout(async () => {
      if (this.#manual || this.#hrChar !== characteristic || this.#beats + this.#invalid > before) return;
      if (round > 1) {
        log('Sigue sin llegar el pulso. Comprueba que la banda esté bien colocada sobre la piel; si lo está, comparte este registro.');
        this.emit('nodata');
        return;
      }
      log(`Sin datos tras ${this.#watchdogMs / 1000} s: se reactivan las notificaciones`);
      try {
        await characteristic.stopNotifications?.();
      } catch (err) {
        log(`stopNotifications: ${errText(err)}`);
      }
      try {
        this.#listenHr(characteristic);
        await characteristic.startNotifications();
        log('Notificaciones reactivadas');
      } catch (err) {
        log(`startNotifications: ${errText(err)}`);
      }
      this.#armWatchdog(characteristic, round + 1);
    }, this.#watchdogMs);
  }

  #onWebValue = (event) => {
    if (this.#manual || event == null || typeof event !== 'object') return;
    // Hay implementaciones que llaman al listener con el valor en vez de con un evento.
    if (!('target' in event) && toDataView(event)) return this.#onHr(event, 'valor directo');
    if (this.#seen.has(event)) return;
    this.#seen.add(event);
    const target = event.target;
    if (!this.#isHrTarget(target)) return;
    const via = this.#via(event.currentTarget);
    const value = target?.value ?? event.value ?? event.detail?.value ?? event.detail;
    if (toDataView(value)) return this.#onHr(value, via);
    // El valor puede no estar puesto aún al emitirse el evento: se lee justo después.
    setTimeout(() => this.#onHr(target?.value ?? this.#hrChar?.value ?? value, `${via}, diferido`), 0);
  };

  #isHrTarget(target) {
    if (!target || target === this.#hrChar) return true;
    if (target === this.#batteryChar) return false;
    return target.uuid == null || isUuid(target.uuid, 0x2a37);
  }

  #via(currentTarget) {
    if (!currentTarget) return 'propiedad on…';
    if (currentTarget === this.#hrChar) return 'característica';
    if (currentTarget === this.#web) return 'dispositivo';
    if (typeof navigator !== 'undefined' && currentTarget === navigator.bluetooth) return 'navigator.bluetooth';
    return typeOf(currentTarget);
  }

  #onHr(value, via = '') {
    const view = toDataView(value);
    if (!view || view.byteLength < 2) {
      if (++this.#invalid <= DETAILED_BEATS) log(`Notificación sin datos de pulso${via ? ` (${via})` : ''}: ${describe(value)}`);
      return;
    }
    const bytes = hexBytes(view);
    const now = Date.now();
    if (bytes === this.#last.bytes && now - this.#last.at < DUPLICATE_MS) return;
    this.#last = { bytes, at: now };
    let hr;
    try {
      hr = parseHeartRate(view);
    } catch (err) {
      log(`No se pudo interpretar [${bytes}]: ${errText(err)}`);
      return;
    }
    this.#beats++;
    if (this.#beats <= DETAILED_BEATS) {
      log(`Pulso #${this.#beats}${via ? ` (${via})` : ''}: ${typeOf(value)} [${bytes}] → ${hr.bpm} ppm`);
    } else if (this.#beats % 60 === 0) {
      log(`${this.#beats} lecturas recibidas (última: ${hr.bpm} ppm)`);
    }
    this.emit('hr', hr);
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
    if (this.#batteryChar && this.#batteryChar !== characteristic) {
      this.#batteryChar.removeEventListener('characteristicvaluechanged', this.#onBatteryEvent);
    }
    this.#batteryChar = characteristic;
    const level = toDataView(await characteristic.readValue());
    if (level?.byteLength) this.emit('battery', level.getUint8(0));
    characteristic.addEventListener('characteristicvaluechanged', this.#onBatteryEvent);
    await characteristic.startNotifications();
  }

  #onBatteryEvent = (event) => {
    const view = toDataView(event?.target?.value ?? this.#batteryChar?.value);
    if (view?.byteLength) this.emit('battery', view.getUint8(0));
  };

  #onDisconnect = async () => {
    if (this.#manual || this.#reconnecting) return;
    clearTimeout(this.#watchdog);
    this.#reconnecting = true;
    log('La banda se ha desconectado; reconectando…');
    this.emit('status', 'reconnecting');
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS && !this.#manual; attempt++) {
      await sleep(Math.min(attempt * 1000, 5000));
      try {
        await this.#open();
        this.#reconnecting = false;
        log(`Reconectada (intento ${attempt})`);
        return;
      } catch (err) {
        if (attempt === 1 || attempt % 5 === 0) log(`Reconexión ${attempt}: ${errText(err)}`);
      }
    }
    this.#reconnecting = false;
    if (!this.#manual) {
      log('No se pudo reconectar');
      this.emit('status', 'disconnected');
    }
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
