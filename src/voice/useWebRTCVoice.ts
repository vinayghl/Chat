import { useCallback, useEffect, useRef, useState } from 'react';
import type { IceConfigResponse, PlayerSlot } from '../shared/gameConstants.ts';
import { getServerUrl, type RealtimeClient } from '../socket/socketClient.ts';
import {
  VOICE_RELAY_SAMPLE_RATE,
  WssVoiceRelay,
  computeRms,
  decodeMulawBase64,
  encodeMulawBase64,
} from './audioCodecAndRelay.ts';

export type VoiceConnectionStatus =
  | 'idle'
  | 'waiting-peer'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type MicPermissionState = 'prompt' | 'granted' | 'denied' | 'error';

interface UseWebRTCVoiceOptions {
  socket: RealtimeClient;
  roomCode: string | null;
  myPlayerId: string | null;
  mySlot: PlayerSlot | null;
  opponentConnected: boolean;
}

export interface UseWebRTCVoiceReturn {
  micEnabled: boolean;
  micMuted: boolean;
  permissionState: MicPermissionState;
  permissionError: string | null;
  voiceStatus: VoiceConnectionStatus;
  voiceWarning: string | null;
  isSelfSpeaking: boolean;
  isOpponentSpeaking: boolean;
  hasTurnServer: boolean;
  audioPlaybackBlocked: boolean;
  enableMicrophone: () => Promise<void>;
  disableMicrophone: () => void;
  toggleMute: () => void;
  resumeRemoteAudio: () => void;
  retryVoiceConnection: () => void;
  teardownVoice: () => void;
}

export function useWebRTCVoice({
  socket,
  roomCode,
  myPlayerId,
  mySlot,
  opponentConnected,
}: UseWebRTCVoiceOptions): UseWebRTCVoiceReturn {
  const [micEnabled, setMicEnabled] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [permissionState, setPermissionState] = useState<MicPermissionState>('prompt');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceConnectionStatus>('idle');
  const [voiceWarning, setVoiceWarning] = useState<string | null>(null);
  const [isSelfSpeaking, setIsSelfSpeaking] = useState(false);
  const [isOpponentSpeaking, setIsOpponentSpeaking] = useState(false);
  const [hasTurnServer, setHasTurnServer] = useState(Boolean(import.meta.env.VITE_TURN_URL));
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);

  const iceConfigRef = useRef<RTCIceServer[]>([
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
      ],
    },
    ...(import.meta.env.VITE_TURN_URL
      ? [
          {
            urls: import.meta.env.VITE_TURN_URL,
            ...(import.meta.env.VITE_TURN_USERNAME
              ? { username: import.meta.env.VITE_TURN_USERNAME }
              : {}),
            ...(import.meta.env.VITE_TURN_CREDENTIAL
              ? { credential: import.meta.env.VITE_TURN_CREDENTIAL }
              : {}),
          } satisfies RTCIceServer,
        ]
      : []),
  ]);

  const stateRef = useRef({ roomCode, myPlayerId, mySlot, opponentConnected });
  stateRef.current = { roomCode, myPlayerId, mySlot, opponentConnected };

  const micActiveRef = useRef({ enabled: false, muted: false });

  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const isSettingRemoteAnswerPendingRef = useRef(false);
  const needsRenegotiationRef = useRef(false);
  const negotiationTimerRef = useRef<number | null>(null);

  const pendingIncomingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const outgoingIceQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const gatheredLocalCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const iceFlushTimerRef = useRef<number | null>(null);
  const watchdogTimersRef = useRef<number[]>([]);

  const localVadIntervalRef = useRef<number | null>(null);
  const remoteVadIntervalRef = useRef<number | null>(null);
  const vadCtxRef = useRef<AudioContext | null>(null);
  const lastEmittedSpeakingRef = useRef(false);

  // Automatic zero-config WSS/Socket audio relay fallback when direct WebRTC ICE is blocked by NAT
  const webrtcConnectedRef = useRef(false);
  const relayActiveRef = useRef(false);
  const relayConnectedRef = useRef(false);
  const wssRelayRef = useRef<WssVoiceRelay | null>(null);
  const relayActivationTimerRef = useRef<number | null>(null);

  const captureCtxRef = useRef<AudioContext | null>(null);
  const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const captureSilentGainRef = useRef<GainNode | null>(null);
  const captureChunksRef = useRef<Float32Array[]>([]);
  const captureSampleCountRef = useRef(0);
  const captureHangoverRef = useRef(0);

  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const opponentSpeakingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const baseUrl = getServerUrl();
    fetch(`${baseUrl}/api/ice-config`)
      .then(async (res) => {
        const ct = res.headers.get('content-type') ?? '';
        if (!res.ok || !ct.includes('application/json')) return null;
        return (await res.json()) as IceConfigResponse;
      })
      .then((data) => {
        if (active && data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          iceConfigRef.current = data.iceServers;
          setHasTurnServer(Boolean(data.hasTurn));
        }
      })
      .catch(() => {
        // Keep STUN fallback
      });
    return () => {
      active = false;
    };
  }, []);

  const getAudioCtxCtor = () =>
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  const ensurePlaybackCtx = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    const Ctor = getAudioCtxCtor();
    if (!Ctor) return null;
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new Ctor();
      nextPlayTimeRef.current = 0;
    }
    if (playbackCtxRef.current.state === 'suspended') {
      void playbackCtxRef.current
        .resume()
        .then(() => {
          setAudioPlaybackBlocked(false);
        })
        .catch(() => {
          setAudioPlaybackBlocked(true);
        });
    }
    return playbackCtxRef.current;
  }, []);

  const playRelayedAudioChunk = useCallback(
    (b64: string) => {
      if (webrtcConnectedRef.current || !relayActiveRef.current) return;
      const ctx = ensurePlaybackCtx();
      if (!ctx) return;

      if (ctx.state === 'suspended') {
        setAudioPlaybackBlocked(true);
        void ctx.resume().then(() => setAudioPlaybackBlocked(false)).catch(() => {});
      }

      let samples: Float32Array;
      try {
        samples = decodeMulawBase64(b64);
      } catch {
        return;
      }
      if (samples.length === 0) return;

      const buffer = ctx.createBuffer(1, samples.length, VOICE_RELAY_SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const now = ctx.currentTime;
      if (nextPlayTimeRef.current < now + 0.02 || nextPlayTimeRef.current > now + 0.6) {
        nextPlayTimeRef.current = now + 0.05;
      }
      src.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += buffer.duration;

      setIsOpponentSpeaking(true);
      if (opponentSpeakingTimerRef.current !== null) {
        window.clearTimeout(opponentSpeakingTimerRef.current);
      }
      opponentSpeakingTimerRef.current = window.setTimeout(() => {
        setIsOpponentSpeaking(false);
      }, 450);
    },
    [ensurePlaybackCtx]
  );

  const stopRelayCapture = useCallback(() => {
    if (captureProcessorRef.current) {
      captureProcessorRef.current.onaudioprocess = null;
      try {
        captureProcessorRef.current.disconnect();
      } catch {
        // Ignore
      }
      captureProcessorRef.current = null;
    }
    if (captureSourceRef.current) {
      try {
        captureSourceRef.current.disconnect();
      } catch {
        // Ignore
      }
      captureSourceRef.current = null;
    }
    if (captureSilentGainRef.current) {
      try {
        captureSilentGainRef.current.disconnect();
      } catch {
        // Ignore
      }
      captureSilentGainRef.current = null;
    }
    if (captureCtxRef.current && captureCtxRef.current.state !== 'closed') {
      void captureCtxRef.current.close().catch(() => {});
      captureCtxRef.current = null;
    }
    captureChunksRef.current = [];
    captureSampleCountRef.current = 0;
    captureHangoverRef.current = 0;
  }, []);

  const startRelayCapture = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream || !relayActiveRef.current || webrtcConnectedRef.current) return;
    if (captureProcessorRef.current) return;

    const Ctor = getAudioCtxCtor();
    if (!Ctor) return;

    try {
      const ctx = new Ctor();
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      captureCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      captureSourceRef.current = source;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      captureProcessorRef.current = processor;

      // Connect through a zero-gain node so browsers keep firing onaudioprocess without local echo
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      captureSilentGainRef.current = silentGain;

      const targetChunkSamples = Math.max(2048, Math.round(ctx.sampleRate * 0.18));

      processor.onaudioprocess = (ev) => {
        if (
          !relayActiveRef.current ||
          webrtcConnectedRef.current ||
          !micActiveRef.current.enabled ||
          micActiveRef.current.muted
        ) {
          return;
        }
        const input = ev.inputBuffer.getChannelData(0);
        const rms = computeRms(input);
        if (rms > 0.0035) {
          captureHangoverRef.current = 4;
        } else if (captureHangoverRef.current > 0) {
          captureHangoverRef.current -= 1;
        } else {
          captureChunksRef.current = [];
          captureSampleCountRef.current = 0;
          return;
        }

        const copy = new Float32Array(input.length);
        copy.set(input);
        captureChunksRef.current.push(copy);
        captureSampleCountRef.current += copy.length;

        if (captureSampleCountRef.current >= targetChunkSamples) {
          const merged = new Float32Array(captureSampleCountRef.current);
          let offset = 0;
          for (const chunk of captureChunksRef.current) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          captureChunksRef.current = [];
          captureSampleCountRef.current = 0;

          const b64 = encodeMulawBase64(merged, ctx.sampleRate);
          if (socket.mode === 'socket') {
            socket.emit('voice:audio-chunk', { d: b64 });
          } else {
            wssRelayRef.current?.sendAudio(b64);
          }
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);
    } catch {
      // Ignore capture errors
    }
  }, [socket]);

  const stopRelayFallback = useCallback(() => {
    if (relayActivationTimerRef.current !== null) {
      window.clearTimeout(relayActivationTimerRef.current);
      relayActivationTimerRef.current = null;
    }
    relayActiveRef.current = false;
    relayConnectedRef.current = false;
    stopRelayCapture();
    if (wssRelayRef.current) {
      wssRelayRef.current.close();
      wssRelayRef.current = null;
    }
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.muted = false;
    }
  }, [stopRelayCapture]);

  const activateRelayFallback = useCallback(async () => {
    const { roomCode: activeRoom, mySlot: slot, opponentConnected: peerOnline } =
      stateRef.current;
    if (!activeRoom || !slot || !peerOnline || webrtcConnectedRef.current) return;
    if (relayActiveRef.current) {
      if (micActiveRef.current.enabled) {
        startRelayCapture();
      }
      return;
    }

    relayActiveRef.current = true;
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.muted = true;
    }

    if (socket.mode === 'socket') {
      relayConnectedRef.current = socket.connected;
      if (socket.connected) {
        setVoiceWarning(null);
        setVoiceStatus('connected');
      }
      if (micActiveRef.current.enabled) {
        startRelayCapture();
      }
      return;
    }

    const relay = new WssVoiceRelay(
      (b64) => {
        playRelayedAudioChunk(b64);
      },
      (connected) => {
        relayConnectedRef.current = connected;
        if (!webrtcConnectedRef.current && relayActiveRef.current) {
          if (connected) {
            setVoiceWarning(null);
            setVoiceStatus('connected');
          } else {
            setVoiceStatus('reconnecting');
          }
        }
      }
    );
    wssRelayRef.current = relay;
    const ok = await relay.connect(activeRoom, slot);
    if (ok && relayActiveRef.current && !webrtcConnectedRef.current) {
      relayConnectedRef.current = true;
      setVoiceWarning(null);
      setVoiceStatus('connected');
      if (micActiveRef.current.enabled) {
        startRelayCapture();
      }
    }
  }, [playRelayedAudioChunk, socket.connected, socket.mode, startRelayCapture]);

  const clearWatchdogTimers = useCallback(() => {
    watchdogTimersRef.current.forEach((id) => window.clearTimeout(id));
    watchdogTimersRef.current = [];
  }, []);

  const flushOutgoingIce = useCallback(() => {
    if (iceFlushTimerRef.current !== null) {
      window.clearTimeout(iceFlushTimerRef.current);
      iceFlushTimerRef.current = null;
    }
    if (outgoingIceQueueRef.current.length === 0) return;
    const batch = outgoingIceQueueRef.current.splice(0, outgoingIceQueueRef.current.length);
    socket.emit('voice:ice-candidates', { candidates: batch });
  }, [socket]);

  const queueOutgoingIce = useCallback(
    (candidate: RTCIceCandidateInit) => {
      gatheredLocalCandidatesRef.current.push(candidate);
      outgoingIceQueueRef.current.push(candidate);
      if (iceFlushTimerRef.current === null) {
        iceFlushTimerRef.current = window.setTimeout(() => {
          flushOutgoingIce();
        }, 160);
      }
    },
    [flushOutgoingIce]
  );

  const stopVadMonitor = useCallback((which: 'local' | 'remote' | 'all') => {
    if (which === 'local' || which === 'all') {
      if (localVadIntervalRef.current !== null) {
        window.clearInterval(localVadIntervalRef.current);
        localVadIntervalRef.current = null;
      }
      setIsSelfSpeaking(false);
    }
    if (which === 'remote' || which === 'all') {
      if (remoteVadIntervalRef.current !== null) {
        window.clearInterval(remoteVadIntervalRef.current);
        remoteVadIntervalRef.current = null;
      }
      setIsOpponentSpeaking(false);
    }
  }, []);

  const startVadMonitor = useCallback(
    (stream: MediaStream, kind: 'local' | 'remote') => {
      if (typeof window === 'undefined') return;
      const AudioCtx = getAudioCtxCtor();
      if (!AudioCtx) return;

      stopVadMonitor(kind);

      try {
        if (!vadCtxRef.current || vadCtxRef.current.state === 'closed') {
          vadCtxRef.current = new AudioCtx();
        }
        const ctx = vadCtxRef.current;
        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        const intervalId = window.setInterval(() => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            sum += data[i];
          }
          const avg = sum / data.length;
          const speaking = avg > 14;

          if (kind === 'local') {
            const activeTrack = localStreamRef.current?.getAudioTracks()[0];
            const effectiveSpeaking =
              speaking && Boolean(activeTrack && activeTrack.enabled);
            setIsSelfSpeaking(effectiveSpeaking);
            if (effectiveSpeaking !== lastEmittedSpeakingRef.current) {
              lastEmittedSpeakingRef.current = effectiveSpeaking;
              socket.emit('voice:speaking', { speaking: effectiveSpeaking });
            }
          } else if (!relayActiveRef.current) {
            setIsOpponentSpeaking(speaking);
          }
        }, 120);

        if (kind === 'local') {
          localVadIntervalRef.current = intervalId;
        } else {
          remoteVadIntervalRef.current = intervalId;
        }
      } catch {
        // Ignore VAD setup failure on restricted browsers
      }
    },
    [socket, stopVadMonitor]
  );

  const ensureRemoteAudioElement = useCallback((stream: MediaStream) => {
    if (!remoteAudioElRef.current) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      audio.volume = 1;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      remoteAudioElRef.current = audio;
    }
    const audioEl = remoteAudioElRef.current;
    audioEl.muted = relayActiveRef.current && !webrtcConnectedRef.current;
    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
    }
    audioEl
      .play()
      .then(() => {
        setAudioPlaybackBlocked(false);
      })
      .catch(() => {
        setAudioPlaybackBlocked(true);
      });
  }, []);

  const attachReceiverTracks = useCallback(
    (pc: RTCPeerConnection) => {
      const tracks = pc
        .getReceivers()
        .map((r) => r.track)
        .filter((t): t is MediaStreamTrack => Boolean(t && t.kind === 'audio'));
      if (tracks.length === 0) return;

      const stream =
        remoteStreamRef.current &&
        remoteStreamRef.current.getAudioTracks().some((t) => tracks.includes(t))
          ? remoteStreamRef.current
          : new MediaStream([tracks[0]]);
      remoteStreamRef.current = stream;
      ensureRemoteAudioElement(stream);
      startVadMonitor(stream, 'remote');
    },
    [ensureRemoteAudioElement, startVadMonitor]
  );

  const resumeRemoteAudio = useCallback(() => {
    const audioEl = remoteAudioElRef.current;
    if (audioEl) {
      audioEl
        .play()
        .then(() => {
          setAudioPlaybackBlocked(false);
        })
        .catch(() => {
          setAudioPlaybackBlocked(true);
        });
    }
    if (playbackCtxRef.current && playbackCtxRef.current.state === 'suspended') {
      void playbackCtxRef.current
        .resume()
        .then(() => setAudioPlaybackBlocked(false))
        .catch(() => {});
    }
    if (vadCtxRef.current && vadCtxRef.current.state === 'suspended') {
      void vadCtxRef.current.resume().catch(() => {});
    }
  }, []);

  // Automatically unlock audio playback on any user interaction on the page
  useEffect(() => {
    if (typeof window === 'undefined' || !audioPlaybackBlocked) return;
    const onGesture = () => {
      resumeRemoteAudio();
    };
    window.addEventListener('pointerdown', onGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onGesture);
    };
  }, [audioPlaybackBlocked, resumeRemoteAudio]);

  const sendOfferNow = useCallback(
    async (pc: RTCPeerConnection) => {
      if (makingOfferRef.current || pc.signalingState !== 'stable') {
        needsRenegotiationRef.current = true;
        return;
      }
      try {
        makingOfferRef.current = true;
        needsRenegotiationRef.current = false;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          socket.emit('voice:offer', { sdp: pc.localDescription.toJSON() });
        }
      } catch {
        // Retry if interrupted
      } finally {
        makingOfferRef.current = false;
      }
    },
    [socket]
  );

  const scheduleNegotiation = useCallback(
    (pc: RTCPeerConnection) => {
      if (negotiationTimerRef.current !== null) {
        window.clearTimeout(negotiationTimerRef.current);
      }
      negotiationTimerRef.current = window.setTimeout(() => {
        negotiationTimerRef.current = null;
        if (pcRef.current === pc) {
          void sendOfferNow(pc);
        }
      }, 30);
    },
    [sendOfferNow]
  );

  const closePeerConnection = useCallback(() => {
    clearWatchdogTimers();
    webrtcConnectedRef.current = false;
    stopRelayFallback();
    if (negotiationTimerRef.current !== null) {
      window.clearTimeout(negotiationTimerRef.current);
      negotiationTimerRef.current = null;
    }
    if (iceFlushTimerRef.current !== null) {
      window.clearTimeout(iceFlushTimerRef.current);
      iceFlushTimerRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onnegotiationneeded = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    audioSenderRef.current = null;
    pendingIncomingCandidatesRef.current = [];
    outgoingIceQueueRef.current = [];
    gatheredLocalCandidatesRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    isSettingRemoteAnswerPendingRef.current = false;
    needsRenegotiationRef.current = false;
    setVoiceWarning(null);
    stopVadMonitor('remote');
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.srcObject = null;
    }
    remoteStreamRef.current = null;
  }, [clearWatchdogTimers, stopRelayFallback, stopVadMonitor]);

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: iceConfigRef.current,
      iceCandidatePoolSize: 4,
    });
    pcRef.current = pc;

    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioSenderRef.current = pc.addTrack(audioTrack, localStreamRef.current);
      }
    } else if (stateRef.current.mySlot === 1) {
      const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
      audioSenderRef.current = transceiver.sender;
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        queueOutgoingIce(event.candidate.toJSON());
      } else {
        flushOutgoingIce();
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      remoteStreamRef.current = stream;
      ensureRemoteAudioElement(stream);
      startVadMonitor(stream, 'remote');
      event.track.onunmute = () => {
        ensureRemoteAudioElement(stream);
      };
    };

    pc.onnegotiationneeded = () => {
      if (stateRef.current.mySlot !== 1 && !localStreamRef.current) {
        return;
      }
      scheduleNegotiation(pc);
    };

    const handleConnectionProgress = () => {
      const iceState = pc.iceConnectionState;
      const connState = pc.connectionState;

      if (
        iceState === 'connected' ||
        iceState === 'completed' ||
        connState === 'connected'
      ) {
        clearWatchdogTimers();
        webrtcConnectedRef.current = true;
        stopRelayFallback();
        attachReceiverTracks(pc);
        setVoiceWarning(null);
        setVoiceStatus('connected');
        return;
      }

      webrtcConnectedRef.current = false;

      if (iceState === 'disconnected' || iceState === 'failed' || connState === 'failed') {
        if (!relayConnectedRef.current) {
          setVoiceStatus('reconnecting');
        }
        void activateRelayFallback();
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
          if (stateRef.current.mySlot === 1 || localStreamRef.current) {
            scheduleNegotiation(pc);
          }
        }
        return;
      }

      if (iceState === 'closed' || connState === 'closed') {
        clearWatchdogTimers();
        if (!relayConnectedRef.current) {
          setVoiceStatus('disconnected');
        }
        return;
      }

      if (!relayConnectedRef.current) {
        setVoiceStatus('connecting');
      }
    };

    pc.oniceconnectionstatechange = handleConnectionProgress;
    pc.onconnectionstatechange = handleConnectionProgress;

    return pc;
  }, [
    activateRelayFallback,
    attachReceiverTracks,
    clearWatchdogTimers,
    ensureRemoteAudioElement,
    flushOutgoingIce,
    queueOutgoingIce,
    scheduleNegotiation,
    startVadMonitor,
    stopRelayFallback,
  ]);

  const startConnectionWatchdog = useCallback(() => {
    clearWatchdogTimers();
    if (relayActivationTimerRef.current !== null) {
      window.clearTimeout(relayActivationTimerRef.current);
    }

    // Activate automatic WSS voice relay if WebRTC ICE hasn't connected within 3.5s
    relayActivationTimerRef.current = window.setTimeout(() => {
      relayActivationTimerRef.current = null;
      if (!webrtcConnectedRef.current && stateRef.current.opponentConnected) {
        void activateRelayFallback();
      }
    }, 3500);

    const restartTimer = window.setTimeout(() => {
      const pc = pcRef.current;
      if (!pc || !stateRef.current.opponentConnected) return;
      if (!webrtcConnectedRef.current && typeof pc.restartIce === 'function') {
        pc.restartIce();
        if (stateRef.current.mySlot === 1 || localStreamRef.current) {
          scheduleNegotiation(pc);
        }
      }
    }, 7000);

    const warnTimer = window.setTimeout(() => {
      if (!stateRef.current.opponentConnected) return;
      if (!webrtcConnectedRef.current && !relayConnectedRef.current) {
        setVoiceWarning(
          'Audio connection is taking longer than expected. Tap Retry Audio.'
        );
      }
    }, 12000);

    watchdogTimersRef.current = [restartTimer, warnTimer];
  }, [activateRelayFallback, clearWatchdogTimers, scheduleNegotiation]);

  // Register Signaling listeners persistently BEFORE connection lifecycle runs
  useEffect(() => {
    const addCandidateSafe = async (pc: RTCPeerConnection, candidate: RTCIceCandidateInit) => {
      if (!pc.remoteDescription) {
        pendingIncomingCandidatesRef.current.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Ignore stale or incompatible candidate
      }
    };

    const flushPendingIncoming = async (pc: RTCPeerConnection) => {
      const queued = pendingIncomingCandidatesRef.current.splice(
        0,
        pendingIncomingCandidatesRef.current.length
      );
      for (const candidate of queued) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
    };

    const handleOffer = async (raw: unknown) => {
      const payload = raw as { fromPlayerId: string; sdp: RTCSessionDescriptionInit };
      const { roomCode: activeRoom, myPlayerId: selfId, mySlot: slot } = stateRef.current;
      if (!payload?.sdp || !activeRoom || payload.fromPlayerId === selfId) return;

      const pc = createPeerConnection();
      const polite = slot === 2;
      const readyForOffer =
        !makingOfferRef.current &&
        (pc.signalingState === 'stable' || isSettingRemoteAnswerPendingRef.current);
      const offerCollision = payload.sdp.type === 'offer' && !readyForOffer;

      ignoreOfferRef.current = !polite && offerCollision;
      if (ignoreOfferRef.current) {
        return;
      }

      try {
        await pc.setRemoteDescription(payload.sdp);
        await flushPendingIncoming(pc);

        if (payload.sdp.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            socket.emit('voice:answer', { sdp: pc.localDescription.toJSON() });
          }
        }
        attachReceiverTracks(pc);
        if (needsRenegotiationRef.current && pc.signalingState === 'stable') {
          scheduleNegotiation(pc);
        }
      } catch {
        // Ignore transient signaling race
      }
    };

    const handleAnswer = async (raw: unknown) => {
      const payload = raw as { fromPlayerId: string; sdp: RTCSessionDescriptionInit };
      const { roomCode: activeRoom, myPlayerId: selfId } = stateRef.current;
      if (!payload?.sdp || !activeRoom || payload.fromPlayerId === selfId) return;
      const pc = pcRef.current;
      if (!pc || pc.signalingState !== 'have-local-offer') return;

      try {
        isSettingRemoteAnswerPendingRef.current = true;
        await pc.setRemoteDescription(payload.sdp);
        await flushPendingIncoming(pc);
        attachReceiverTracks(pc);
        if (
          needsRenegotiationRef.current &&
          (pc.signalingState as RTCSignalingState) === 'stable'
        ) {
          scheduleNegotiation(pc);
        }
      } catch {
        // Ignore stale answer
      } finally {
        isSettingRemoteAnswerPendingRef.current = false;
      }
    };

    const handleIceCandidate = async (raw: unknown) => {
      const payload = raw as { fromPlayerId: string; candidate: RTCIceCandidateInit };
      const { roomCode: activeRoom, myPlayerId: selfId } = stateRef.current;
      if (!payload?.candidate || !activeRoom || payload.fromPlayerId === selfId) return;
      const pc = pcRef.current;
      if (!pc) {
        pendingIncomingCandidatesRef.current.push(payload.candidate);
        return;
      }
      await addCandidateSafe(pc, payload.candidate);
    };

    const handleIceCandidates = async (raw: unknown) => {
      const payload = raw as { fromPlayerId: string; candidates: RTCIceCandidateInit[] };
      const { roomCode: activeRoom, myPlayerId: selfId } = stateRef.current;
      if (
        !payload ||
        !Array.isArray(payload.candidates) ||
        !activeRoom ||
        payload.fromPlayerId === selfId
      ) {
        return;
      }
      const pc = pcRef.current;
      for (const cand of payload.candidates) {
        if (!pc) {
          pendingIncomingCandidatesRef.current.push(cand);
        } else {
          await addCandidateSafe(pc, cand);
        }
      }
    };

    const handlePeerReady = async () => {
      const { roomCode: activeRoom, opponentConnected: peerOnline, mySlot: slot } =
        stateRef.current;
      if (!activeRoom || !peerOnline) return;
      const pc = createPeerConnection();
      if (slot === 1 && !webrtcConnectedRef.current) {
        if (pc.signalingState === 'stable') {
          scheduleNegotiation(pc);
        } else if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
          socket.emit('voice:offer', { sdp: pc.localDescription.toJSON() });
          if (gatheredLocalCandidatesRef.current.length > 0) {
            socket.emit('voice:ice-candidates', {
              candidates: gatheredLocalCandidatesRef.current,
            });
          }
        }
      }
    };

    const handleOpponentSpeaking = (raw: unknown) => {
      const payload = raw as { playerId: string; speaking: boolean };
      if (payload && payload.playerId !== stateRef.current.myPlayerId) {
        setIsOpponentSpeaking(Boolean(payload.speaking));
      }
    };

    const handleSocketAudioChunk = (raw: unknown) => {
      const payload = raw as { fromPlayerId?: string; d?: string };
      if (
        payload &&
        typeof payload.d === 'string' &&
        payload.fromPlayerId !== stateRef.current.myPlayerId
      ) {
        playRelayedAudioChunk(payload.d);
      }
    };

    socket.on('voice:offer', handleOffer);
    socket.on('voice:answer', handleAnswer);
    socket.on('voice:ice-candidate', handleIceCandidate);
    socket.on('voice:ice-candidates', handleIceCandidates);
    socket.on('voice:peer-ready', handlePeerReady);
    socket.on('voice:speaking', handleOpponentSpeaking);
    socket.on('voice:audio-chunk', handleSocketAudioChunk);

    return () => {
      socket.off('voice:offer', handleOffer);
      socket.off('voice:answer', handleAnswer);
      socket.off('voice:ice-candidate', handleIceCandidate);
      socket.off('voice:ice-candidates', handleIceCandidates);
      socket.off('voice:peer-ready', handlePeerReady);
      socket.off('voice:speaking', handleOpponentSpeaking);
      socket.off('voice:audio-chunk', handleSocketAudioChunk);
    };
  }, [
    attachReceiverTracks,
    createPeerConnection,
    playRelayedAudioChunk,
    scheduleNegotiation,
    socket,
  ]);

  // Manage PeerConnection lifecycle based on room & opponent presence
  useEffect(() => {
    if (!roomCode || !myPlayerId) {
      closePeerConnection();
      setVoiceStatus('idle');
      return;
    }

    if (!opponentConnected) {
      closePeerConnection();
      setVoiceStatus('waiting-peer');
      return;
    }

    setVoiceStatus('connecting');
    setVoiceWarning(null);
    const pc = createPeerConnection();
    socket.emit('voice:ready');
    startConnectionWatchdog();

    if (mySlot === 1 && pc.signalingState === 'stable') {
      scheduleNegotiation(pc);
    }
  }, [
    closePeerConnection,
    createPeerConnection,
    myPlayerId,
    mySlot,
    opponentConnected,
    roomCode,
    scheduleNegotiation,
    socket,
    startConnectionWatchdog,
  ]);

  const retryVoiceConnection = useCallback(() => {
    const { roomCode: activeRoom, opponentConnected: peerOnline, mySlot: slot } =
      stateRef.current;
    if (!activeRoom || !peerOnline) return;
    resumeRemoteAudio();
    closePeerConnection();
    setVoiceStatus('connecting');
    setVoiceWarning(null);
    const pc = createPeerConnection();
    socket.emit('voice:ready');
    startConnectionWatchdog();
    if (slot === 1 || localStreamRef.current) {
      scheduleNegotiation(pc);
    }
  }, [
    closePeerConnection,
    createPeerConnection,
    resumeRemoteAudio,
    scheduleNegotiation,
    socket,
    startConnectionWatchdog,
  ]);

  const enableMicrophone = useCallback(async () => {
    setPermissionError(null);
    // Unlock remote audio contexts immediately inside the user tap gesture
    ensurePlaybackCtx();
    resumeRemoteAudio();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setPermissionState('error');
      setPermissionError('Microphone access is unavailable in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }

      localStreamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = true;
      }

      micActiveRef.current = { enabled: true, muted: false };
      setPermissionState('granted');
      setMicEnabled(true);
      setMicMuted(false);
      startVadMonitor(stream, 'local');
      socket.emit('voice:state', { micEnabled: true, micMuted: false });

      if (relayActiveRef.current && !webrtcConnectedRef.current) {
        startRelayCapture();
      } else if (stateRef.current.opponentConnected && !webrtcConnectedRef.current) {
        // Ensure relay fallback spins up quickly if WebRTC ICE isn't connected yet
        void activateRelayFallback();
      }

      if (pcRef.current && audioTrack) {
        const pc = pcRef.current;
        const transceivers = pc.getTransceivers();
        const audioTransceiver =
          transceivers.find(
            (t) =>
              t.mid !== null &&
              (t.receiver.track?.kind === 'audio' || t.sender === audioSenderRef.current)
          ) ??
          transceivers.find(
            (t) =>
              t.sender === audioSenderRef.current || t.receiver.track?.kind === 'audio'
          );

        if (audioTransceiver) {
          audioTransceiver.direction = 'sendrecv';
          await audioTransceiver.sender.replaceTrack(audioTrack);
          audioSenderRef.current = audioTransceiver.sender;
          scheduleNegotiation(pc);
        } else {
          audioSenderRef.current = pc.addTrack(audioTrack, stream);
          scheduleNegotiation(pc);
        }

        if (!webrtcConnectedRef.current) {
          startConnectionWatchdog();
        }
      }
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setPermissionState('denied');
        setPermissionError(
          'Microphone permission was denied. Enable mic access in browser settings and try again.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setPermissionState('error');
        setPermissionError('No microphone device found on this device.');
      } else {
        setPermissionState('error');
        setPermissionError(
          err instanceof Error ? err.message : 'Unable to access microphone.'
        );
      }
    }
  }, [
    activateRelayFallback,
    ensurePlaybackCtx,
    resumeRemoteAudio,
    scheduleNegotiation,
    socket,
    startConnectionWatchdog,
    startRelayCapture,
    startVadMonitor,
  ]);

  const disableMicrophone = useCallback(() => {
    stopVadMonitor('local');
    stopRelayCapture();
    micActiveRef.current = { enabled: false, muted: false };
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (audioSenderRef.current) {
      void audioSenderRef.current.replaceTrack(null).catch(() => {});
    }
    setMicEnabled(false);
    setMicMuted(false);
    lastEmittedSpeakingRef.current = false;
    socket.emit('voice:speaking', { speaking: false });
    socket.emit('voice:state', { micEnabled: false, micMuted: false });
  }, [socket, stopRelayCapture, stopVadMonitor]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    resumeRemoteAudio();
    const nextMuted = !micMuted;
    micActiveRef.current = { enabled: true, muted: nextMuted };
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMicMuted(nextMuted);
    if (nextMuted) {
      setIsSelfSpeaking(false);
      lastEmittedSpeakingRef.current = false;
      socket.emit('voice:speaking', { speaking: false });
    }
    socket.emit('voice:state', { micEnabled: true, micMuted: nextMuted });
  }, [micMuted, resumeRemoteAudio, socket]);

  const teardownVoice = useCallback(() => {
    stopVadMonitor('all');
    stopRelayFallback();
    micActiveRef.current = { enabled: false, muted: false };
    if (opponentSpeakingTimerRef.current !== null) {
      window.clearTimeout(opponentSpeakingTimerRef.current);
      opponentSpeakingTimerRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    closePeerConnection();
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.remove();
      remoteAudioElRef.current = null;
    }
    if (vadCtxRef.current && vadCtxRef.current.state !== 'closed') {
      void vadCtxRef.current.close().catch(() => {});
      vadCtxRef.current = null;
    }
    if (playbackCtxRef.current && playbackCtxRef.current.state !== 'closed') {
      void playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
    setMicEnabled(false);
    setMicMuted(false);
    setVoiceStatus('idle');
    setVoiceWarning(null);
    setAudioPlaybackBlocked(false);
  }, [closePeerConnection, stopRelayFallback, stopVadMonitor]);

  useEffect(() => {
    return () => {
      teardownVoice();
    };
  }, [teardownVoice]);

  return {
    micEnabled,
    micMuted,
    permissionState,
    permissionError,
    voiceStatus,
    voiceWarning,
    isSelfSpeaking,
    isOpponentSpeaking,
    hasTurnServer,
    audioPlaybackBlocked,
    enableMicrophone,
    disableMicrophone,
    toggleMute,
    resumeRemoteAudio,
    retryVoiceConnection,
    teardownVoice,
  };
}
