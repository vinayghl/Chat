const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function encodeUtf8String(str: string): Uint8Array<ArrayBuffer> {
  const bytes = textEncoder.encode(str);
  const out = new Uint8Array(new ArrayBuffer(2 + bytes.length));
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

function encodeRemainingLength(len: number): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  let n = len;
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    bytes.push(digit);
  } while (n > 0);
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

function buildPacket(firstByte: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(
    new Uint8Array([firstByte]),
    encodeRemainingLength(body.length),
    body
  );
}

export type MqttMessageHandler = (topic: string, payload: string) => void;

export class MqttWssClient {
  public readonly url: string;
  private ws: WebSocket | null = null;
  private rxBuf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  private packetId = 1;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private closedByCaller = false;
  private connectedOnce = false;
  private isConnected = false;

  private subscriptions = new Set<string>();
  private pendingSubAcks = new Map<number, () => void>();
  private onMessage: MqttMessageHandler;
  private onDisconnect?: () => void;
  private onReconnect?: () => void;

  constructor(
    url: string,
    onMessage: MqttMessageHandler,
    hooks?: {
      onDisconnect?: () => void;
      onReconnect?: () => void;
    }
  ) {
    this.url = url;
    this.onMessage = onMessage;
    this.onDisconnect = hooks?.onDisconnect;
    this.onReconnect = hooks?.onReconnect;
  }

  public get connected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  public connect(timeoutMs = 5000): Promise<void> {
    this.closedByCaller = false;
    return this.openSocket(timeoutMs, false);
  }

  public reconnectNow(): Promise<void> {
    if (this.closedByCaller || this.connected) {
      return Promise.resolve();
    }
    return this.openSocket(5000, true).catch(() => {});
  }

  private openSocket(timeoutMs: number, isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        try {
          this.ws.onopen = null;
          this.ws.onmessage = null;
          this.ws.onerror = null;
          this.ws.onclose = null;
          this.ws.close();
        } catch {
          // Ignore
        }
        this.ws = null;
      }
      this.stopKeepAlive();
      this.rxBuf = new Uint8Array(0);
      this.isConnected = false;

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // Ignore
          }
          reject(new Error(`Timed out connecting to ${this.url}`));
        }
      }, timeoutMs);

      const ws = new WebSocket(this.url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        const clientId = `duel-${Math.random().toString(36).slice(2, 12)}`;
        const vh = concatBytes(
          encodeUtf8String('MQTT'),
          new Uint8Array([0x04, 0x02, 0x00, 0x1e]) // MQTT 3.1.1, cleanSession=1, keepAlive=30s
        );
        const pkt = buildPacket(0x10, concatBytes(vh, encodeUtf8String(clientId)));
        ws.send(pkt);
      };

      ws.onmessage = (ev) => {
        const chunk =
          ev.data instanceof ArrayBuffer
            ? new Uint8Array(ev.data)
            : typeof ev.data === 'string'
              ? textEncoder.encode(ev.data)
              : new Uint8Array(0);
        if (chunk.length === 0) return;
        this.rxBuf = concatBytes(this.rxBuf, chunk);
        this.drainPackets((connackRc) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (connackRc === 0) {
            this.isConnected = true;
            this.startKeepAlive();
            const wasPreviouslyConnected = this.connectedOnce;
            this.connectedOnce = true;

            // Resubscribe to existing topics on reconnect
            for (const topic of this.subscriptions) {
              this.sendSubscribe(topic);
            }
            if (isReconnect || wasPreviouslyConnected) {
              this.onReconnect?.();
            }
            resolve();
          } else {
            reject(new Error(`MQTT CONNACK refused (${connackRc})`));
          }
        });
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket error on ${this.url}`));
        }
      };

      ws.onclose = () => {
        this.stopKeepAlive();
        const wasConnected = this.isConnected;
        this.isConnected = false;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket closed on ${this.url}`));
        } else if (wasConnected && !this.closedByCaller) {
          this.onDisconnect?.();
        }
      };
    });
  }

  public subscribe(topic: string, timeoutMs = 4000): Promise<void> {
    this.subscriptions.add(topic);
    if (!this.connected) {
      return Promise.reject(new Error('MQTT client not connected.'));
    }
    return new Promise((resolve, reject) => {
      const id = this.sendSubscribe(topic);
      const timer = setTimeout(() => {
        this.pendingSubAcks.delete(id);
        reject(new Error(`SUBACK timeout for ${topic}`));
      }, timeoutMs);
      this.pendingSubAcks.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private sendSubscribe(topic: string): number {
    const id = this.nextPacketId();
    const body = concatBytes(
      new Uint8Array([(id >> 8) & 0xff, id & 0xff]),
      encodeUtf8String(topic),
      new Uint8Array([0x00]) // QoS 0
    );
    this.ws?.send(buildPacket(0x82, body));
    return id;
  }

  public publish(topic: string, payload: string): boolean {
    if (!this.connected || !this.ws) return false;
    const body = concatBytes(
      encodeUtf8String(topic),
      textEncoder.encode(payload)
    );
    // 0x30 = PUBLISH, DUP=0, QoS=0, RETAIN=0 (strictly ephemeral)
    this.ws.send(buildPacket(0x30, body));
    return true;
  }

  public close(): void {
    this.closedByCaller = true;
    this.stopKeepAlive();
    this.subscriptions.clear();
    for (const cb of this.pendingSubAcks.values()) {
      cb();
    }
    this.pendingSubAcks.clear();
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array([0xe0, 0x00])); // DISCONNECT
        }
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.isConnected = false;
  }

  private nextPacketId(): number {
    this.packetId = (this.packetId % 65535) + 1;
    return this.packetId;
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
        } catch {
          // Handled on close
        }
      }
    }, 18000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private drainPackets(onConnack: (returnCode: number) => void): void {
    while (this.rxBuf.length >= 2) {
      let multiplier = 1;
      let remainingLength = 0;
      let varintBytes = 0;
      let completeHeader = false;

      for (let i = 1; i < this.rxBuf.length && i <= 4; i += 1) {
        const encodedByte = this.rxBuf[i];
        remainingLength += (encodedByte & 127) * multiplier;
        varintBytes += 1;
        if ((encodedByte & 128) === 0) {
          completeHeader = true;
          break;
        }
        multiplier *= 128;
      }

      if (!completeHeader) break;
      const totalLen = 1 + varintBytes + remainingLength;
      if (this.rxBuf.length < totalLen) break;

      const firstByte = this.rxBuf[0];
      const body = this.rxBuf.subarray(1 + varintBytes, totalLen);
      this.rxBuf = this.rxBuf.subarray(totalLen);

      const packetType = firstByte >> 4;
      if (packetType === 2 && body.length >= 2) {
        // CONNACK
        onConnack(body[1]);
      } else if (packetType === 9 && body.length >= 2) {
        // SUBACK
        const ackId = (body[0] << 8) | body[1];
        const cb = this.pendingSubAcks.get(ackId);
        if (cb) {
          this.pendingSubAcks.delete(ackId);
          cb();
        }
      } else if (packetType === 3 && body.length >= 2) {
        // PUBLISH
        const qos = (firstByte >> 1) & 0x03;
        const topicLen = (body[0] << 8) | body[1];
        let offset = 2 + topicLen;
        if (offset <= body.length) {
          const topic = textDecoder.decode(body.subarray(2, offset));
          if (qos > 0) offset += 2;
          if (offset <= body.length) {
            const payload = textDecoder.decode(body.subarray(offset));
            this.onMessage(topic, payload);
          }
        }
      }
    }
  }
}
