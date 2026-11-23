import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { IceConfigResponse, PlayerSlot } from '../shared/gameConstants.ts';

export type VoiceConnectionStatus =
  | 'idle'
  | 'waiting-peer'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type MicPermissionState = 'prompt' | 'granted' | 'denied' | 'error';

interface UseWebRTCVoiceOptions {
  socket: Socket;
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
  isSelfSpeaking: boolean;
  isOpponentSpeaking: boolean;
  hasTurnServer: boolean;
  audioPlaybackBlocked: boolean;
  enableMicrophone: () => Promise<void>;
  disableMicrophone: () => void;
  toggleMute: () => void;
  resumeRemoteAudio: () => void;
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
  const [isSelfSpeaking, setIsSelfSpeaking] = useState(false);
  const [isOpponentSpeaking, setIsOpponentSpeaking] = useState(false);
  const [hasTurnServer, setHasTurnServer] = useState(false);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);
  const iceConfigRef = useRef<RTCIceServer[]>([
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ]);

  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const isSettingRemoteAnswerPendingRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const localVadIntervalRef = useRef<number | null>(null);
  const remoteVadIntervalRef = useRef<number | null>(null);
  const vadCtxRef = useRef<AudioContext | null>(null);
  const lastEmittedSpeakingRef = useRef(false);

  const polite = mySlot === 2;

  // Fetch STUN/TURN ICE configuration once on mount
  useEffect(() => {
    let active = true;
    fetch('/api/ice-config')
      .then((res) => res.json())
      .then((data: IceConfigResponse) => {
        if (active && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          iceConfigRef.current = data.iceServers;
          setHasTurnServer(Boolean(data.hasTurn));
        }
      })
      .catch(() => {
        // Keep default STUN fallback
      });
    return () => {
      active = false;
    };
  }, []);

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
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
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
          } else {
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
      audio.style.display = 'none';
      document.body.appendChild(audio);
      remoteAudioElRef.current = audio;
    }
    const audioEl = remoteAudioElRef.current;
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

  const resumeRemoteAudio = useCallback(() => {
    const audioEl = remoteAudioElRef.current;
    if (!audioEl) return;
    audioEl
      .play()
      .then(() => {
        setAudioPlaybackBlocked(false);
      })
      .catch(() => {
        setAudioPlaybackBlocked(true);
      });
  }, []);

  const closePeerConnection = useCallback(() => {
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
    pendingCandidatesRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    isSettingRemoteAnswerPendingRef.current = false;
    stopVadMonitor('remote');
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.srcObject = null;
    }
    remoteStreamRef.current = null;
  }, [stopVadMonitor]);

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: iceConfigRef.current,
      iceCandidatePoolSize: 4,
    });
    pcRef.current = pc;

    // Ensure at least a recvonly audio transceiver exists so we can hear opponent
    // even before we enable our own microphone.
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioSenderRef.current = pc.addTrack(audioTrack, localStreamRef.current);
      }
    } else {
      const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
      audioSenderRef.current = transceiver.sender;
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('voice:ice-candidate', {
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      remoteStreamRef.current = stream;
      ensureRemoteAudioElement(stream);
      startVadMonitor(stream, 'remote');
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          socket.emit('voice:offer', { sdp: pc.localDescription.toJSON() });
        }
      } catch {
        // Handled by glare/renegotiation
      } finally {
        makingOfferRef.current = false;
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'checking' || state === 'new') {
        setVoiceStatus('connecting');
      } else if (state === 'connected' || state === 'completed') {
        setVoiceStatus('connected');
      } else if (state === 'disconnected') {
        setVoiceStatus('reconnecting');
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } else if (state === 'failed') {
        setVoiceStatus('reconnecting');
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } else if (state === 'closed') {
        setVoiceStatus('disconnected');
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        setVoiceStatus('connected');
      } else if (state === 'connecting') {
        setVoiceStatus('connecting');
      } else if (state === 'failed') {
        setVoiceStatus('reconnecting');
      }
    };

    return pc;
  }, [ensureRemoteAudioElement, socket, startVadMonitor]);

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
    const pc = createPeerConnection();
    socket.emit('voice:ready');

    if (mySlot === 1 && pc.signalingState === 'stable') {
      makingOfferRef.current = true;
      pc.setLocalDescription()
        .then(() => {
          if (pc.localDescription) {
            socket.emit('voice:offer', { sdp: pc.localDescription.toJSON() });
          }
        })
        .catch(() => {})
        .finally(() => {
          makingOfferRef.current = false;
        });
    }
  }, [
    closePeerConnection,
    createPeerConnection,
    myPlayerId,
    mySlot,
    opponentConnected,
    roomCode,
    socket,
  ]);

  // Socket.IO WebRTC Signaling listeners (Perfect Negotiation)
  useEffect(() => {
    const handleOffer = async (payload: {
      fromPlayerId: string;
      sdp: RTCSessionDescriptionInit;
    }) => {
      if (!roomCode || payload.fromPlayerId === myPlayerId) return;
      const pc = createPeerConnection();
      const description = payload.sdp;

      const readyForOffer =
        !makingOfferRef.current &&
        (pc.signalingState === 'stable' || isSettingRemoteAnswerPendingRef.current);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      ignoreOfferRef.current = !polite && offerCollision;
      if (ignoreOfferRef.current) {
        return;
      }

      try {
        await pc.setRemoteDescription(description);
        for (const candidate of pendingCandidatesRef.current) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        pendingCandidatesRef.current = [];

        if (description.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            socket.emit('voice:answer', { sdp: pc.localDescription.toJSON() });
          }
        }
      } catch {
        // Ignore transient signaling errors during rapid reconnects
      }
    };

    const handleAnswer = async (payload: {
      fromPlayerId: string;
      sdp: RTCSessionDescriptionInit;
    }) => {
      if (!roomCode || payload.fromPlayerId === myPlayerId) return;
      const pc = pcRef.current;
      if (!pc) return;
      try {
        isSettingRemoteAnswerPendingRef.current = true;
        await pc.setRemoteDescription(payload.sdp);
        for (const candidate of pendingCandidatesRef.current) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        pendingCandidatesRef.current = [];
      } catch {
        // Ignore stale answers
      } finally {
        isSettingRemoteAnswerPendingRef.current = false;
      }
    };

    const handleIceCandidate = async (payload: {
      fromPlayerId: string;
      candidate: RTCIceCandidateInit;
    }) => {
      if (!roomCode || payload.fromPlayerId === myPlayerId) return;
      const pc = pcRef.current;
      if (!pc || !pc.remoteDescription) {
        pendingCandidatesRef.current.push(payload.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch {
        if (!ignoreOfferRef.current) {
          // Ignore malformed/stale candidate
        }
      }
    };

    const handlePeerReady = async () => {
      if (!roomCode || !opponentConnected) return;
      const pc = createPeerConnection();
      // Polite/Slot-1 initiates fresh offer when peer reconnects
      if (mySlot === 1 && pc.signalingState === 'stable') {
        try {
          makingOfferRef.current = true;
          await pc.setLocalDescription();
          if (pc.localDescription) {
            socket.emit('voice:offer', { sdp: pc.localDescription.toJSON() });
          }
        } catch {
          // Ignore
        } finally {
          makingOfferRef.current = false;
        }
      }
    };

    const handleOpponentSpeaking = (payload: {
      playerId: string;
      speaking: boolean;
    }) => {
      if (payload.playerId !== myPlayerId) {
        setIsOpponentSpeaking(Boolean(payload.speaking));
      }
    };

    socket.on('voice:offer', handleOffer);
    socket.on('voice:answer', handleAnswer);
    socket.on('voice:ice-candidate', handleIceCandidate);
    socket.on('voice:peer-ready', handlePeerReady);
    socket.on('voice:speaking', handleOpponentSpeaking);

    return () => {
      socket.off('voice:offer', handleOffer);
      socket.off('voice:answer', handleAnswer);
      socket.off('voice:ice-candidate', handleIceCandidate);
      socket.off('voice:peer-ready', handlePeerReady);
      socket.off('voice:speaking', handleOpponentSpeaking);
    };
  }, [createPeerConnection, myPlayerId, mySlot, opponentConnected, roomCode, socket]);

  const enableMicrophone = useCallback(async () => {
    setPermissionError(null);
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

      // Stop any previous local tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }

      localStreamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = true;
      }

      setPermissionState('granted');
      setMicEnabled(true);
      setMicMuted(false);
      startVadMonitor(stream, 'local');
      socket.emit('voice:state', { micEnabled: true, micMuted: false });

      if (pcRef.current && audioTrack) {
        const pc = pcRef.current;
        const transceivers = pc.getTransceivers();
        const audioTransceiver = transceivers.find(
          (t) =>
            t.sender === audioSenderRef.current ||
            t.receiver.track?.kind === 'audio'
        );

        if (audioTransceiver) {
          audioTransceiver.direction = 'sendrecv';
          await audioTransceiver.sender.replaceTrack(audioTrack);
          audioSenderRef.current = audioTransceiver.sender;
          // Explicitly renegotiate because replaceTrack alone does not fire onnegotiationneeded when direction changes
          if (pc.signalingState === 'stable') {
            makingOfferRef.current = true;
            try {
              await pc.setLocalDescription();
              if (pc.localDescription) {
                socket.emit('voice:offer', {
                  sdp: pc.localDescription.toJSON(),
                });
              }
            } finally {
              makingOfferRef.current = false;
            }
          }
        } else {
          audioSenderRef.current = pc.addTrack(audioTrack, stream);
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
  }, [socket, startVadMonitor]);

  const disableMicrophone = useCallback(() => {
    stopVadMonitor('local');
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
  }, [socket, stopVadMonitor]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !micMuted;
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
  }, [micMuted, socket]);

  const teardownVoice = useCallback(() => {
    stopVadMonitor('all');
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
    setMicEnabled(false);
    setMicMuted(false);
    setVoiceStatus('idle');
    setAudioPlaybackBlocked(false);
  }, [closePeerConnection, stopVadMonitor]);

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
    isSelfSpeaking,
    isOpponentSpeaking,
    hasTurnServer,
    audioPlaybackBlocked,
    enableMicrophone,
    disableMicrophone,
    toggleMute,
    resumeRemoteAudio,
    teardownVoice,
  };
}
