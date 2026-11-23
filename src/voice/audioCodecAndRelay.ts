import { MqttWssClient } from '../socket/mqttWssClient.ts';
import type { PlayerSlot } from '../shared/gameConstants.ts';

export const VOICE_RELAY_SAMPLE_RATE = 12000;
const VOICE_RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function linearToMulawSample(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  let mask = 0xff;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  }
  if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
  pcm += MULAW_BIAS;

  let seg = 8;
  for (let i = 0; i < 8; i += 1) {
    if (pcm <= SEG_END[i]) {
      seg = i;
      break;
    }
  }
  if (seg >= 8) {
    return 0x7f ^ mask;
  }
  const uval = (seg << 4) | ((pcm >> (seg + 3)) & 0x0f);
  return uval ^ mask;
}

function mulawToLinearSample(mulawByte: number): number {
  const val = ~mulawByte & 0xff;
  let t = ((val & 0x0f) << 3) + MULAW_BIAS;
  t <<= (val & 0x70) >> 4;
  const pcm = val & 0x80 ? MULAW_BIAS - t : t - MULAW_BIAS;
  return pcm / 32768;
}

export function encodeMulawBase64(
  samples: Float32Array,
  sourceSampleRate: number
): string {
  const ratio = sourceSampleRate / VOICE_RELAY_SAMPLE_RATE;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const bytes = new Uint8Array(outLen);

  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = samples[idx] ?? 0;
    const s1 = samples[Math.min(idx + 1, samples.length - 1)] ?? s0;
    const interp = s0 + (s1 - s0) * frac;
    bytes[i] = linearToMulawSample(interp);
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeMulawBase64(b64: string): Float32Array {
  const binary = atob(b64);
  const out = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = mulawToLinearSample(binary.charCodeAt(i));
  }
  return out;
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

export class WssVoiceRelay {
  private mqtt: MqttWssClient | null = null;
  private roomCode: string | null = null;
  private mySlot: PlayerSlot | null = null;
  private connecting = false;
  private closed = false;
  private onChunk: (b64: string) => void;
  private onConnectedChange?: (connected: boolean) => void;

  constructor(
    onChunk: (b64: string) => void,
    onConnectedChange?: (connected: boolean) => void
  ) {
    this.onChunk = onChunk;
    this.onConnectedChange = onConnectedChange;
  }

  public get connected(): boolean {
    return Boolean(this.mqtt?.connected);
  }

  public async connect(roomCode: string, mySlot: PlayerSlot): Promise<boolean> {
    if (
      this.mqtt?.connected &&
      this.roomCode === roomCode &&
      this.mySlot === mySlot
    ) {
      return true;
    }
    if (this.connecting) return false;
    this.connecting = true;
    this.closed = false;
    this.roomCode = roomCode;
    this.mySlot = mySlot;

    const opponentSlot: PlayerSlot = mySlot === 1 ? 2 : 1;
    const rxTopic = `duel-snl/v1/${roomCode}/voice-audio/${opponentSlot}`;

    for (const url of VOICE_RELAY_BROKERS) {
      if (this.closed) {
        this.connecting = false;
        return false;
      }
      const client = new MqttWssClient(
        url,
        (topic, payload) => {
          if (topic !== rxTopic) return;
          try {
            const parsed = JSON.parse(payload) as { d?: unknown };
            if (typeof parsed?.d === 'string' && parsed.d.length > 0) {
              this.onChunk(parsed.d);
            }
          } catch {
            // Ignore malformed packet
          }
        },
        {
          onDisconnect: () => {
            if (this.mqtt === client && !this.closed) {
              this.onConnectedChange?.(false);
              setTimeout(() => {
                if (this.mqtt === client && !this.closed) {
                  void client.reconnectNow();
                }
              }, 1000);
            }
          },
          onReconnect: () => {
            if (this.mqtt === client && !this.closed) {
              this.onConnectedChange?.(true);
            }
          },
        }
      );

      try {
        await client.connect(4500);
        await client.subscribe(rxTopic, 3500);
        if (this.closed) {
          client.close();
          this.connecting = false;
          return false;
        }
        this.mqtt = client;
        this.connecting = false;
        this.onConnectedChange?.(true);
        return true;
      } catch {
        client.close();
      }
    }

    this.connecting = false;
    this.onConnectedChange?.(false);
    return false;
  }

  public sendAudio(b64: string): boolean {
    if (!this.mqtt?.connected || !this.roomCode || !this.mySlot) return false;
    const txTopic = `duel-snl/v1/${this.roomCode}/voice-audio/${this.mySlot}`;
    return this.mqtt.publish(txTopic, JSON.stringify({ d: b64 }));
  }

  public close(): void {
    this.closed = true;
    this.connecting = false;
    if (this.mqtt) {
      this.mqtt.close();
      this.mqtt = null;
    }
    this.roomCode = null;
    this.mySlot = null;
    this.onConnectedChange?.(false);
  }
}
