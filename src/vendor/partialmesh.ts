import SimplePeer from 'simple-peer/simplepeer.min.js';
import type { Instance as SimplePeerInstance } from 'simple-peer';

export interface PartialMeshConfig {
  minPeers?: number;
  maxPeers?: number;
  signalingServer?: string;
  sessionId?: string;
  autoDiscover?: boolean;
  autoConnect?: boolean;
  iceServers?: RTCIceServer[];
  connectionTimeoutMs?: number;
  maintenanceIntervalMs?: number;
  underConnectedResetMs?: number;
}

export interface PeerConnection {
  id: string;
  peer: SimplePeerInstance;
  connected: boolean;
  initiator: boolean;
}

export type PartialMeshEvents = {
  'signaling:connected': (data: { clientId: string; rawClientId?: string }) => void;
  'signaling:disconnected': () => void;
  'signaling:error': (error: any) => void;
  'peer:connected': (peerId: string) => void;
  'peer:disconnected': (peerId: string) => void;
  'peer:data': (data: { peerId: string; data: any }) => void;
  'peer:error': (data: { peerId: string; error: any }) => void;
  'peer:discovered': (peerId: string) => void;
  'mesh:ready': () => void;
};

/**
 * PartialMesh - WebRTC peer-to-peer partial mesh networking library
 *
 * Uses UniWRTC for signaling and maintains a configurable number of peer connections.
 */
export class PartialMesh {
  private config: Required<PartialMeshConfig>;
  private peers: Map<string, PeerConnection> = new Map();
  private uniwrtcClient: any = null;
  private discoveredPeers: Set<string> = new Set();
  private clientId: string | null = null;
  private eventHandlers: Map<keyof PartialMeshEvents, Set<Function>> = new Map();
  private connecting: Set<string> = new Set();
  private connectionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private underConnectedSinceMs: number | null = null;
  private lastHardResetAtMs: number = 0;

  constructor(config: PartialMeshConfig = {}) {
    this.config = {
      minPeers: config.minPeers ?? 2,
      maxPeers: config.maxPeers ?? 10,
      signalingServer: config.signalingServer ?? 'wss://signal.peer.ooo',
      sessionId: config.sessionId ?? 'default-session',
      autoDiscover: config.autoDiscover ?? true,
      autoConnect: config.autoConnect ?? true,
      iceServers: config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
      connectionTimeoutMs: config.connectionTimeoutMs ?? 25_000,
      maintenanceIntervalMs: config.maintenanceIntervalMs ?? 2_000,
      underConnectedResetMs: config.underConnectedResetMs ?? 0,
    } as Required<PartialMeshConfig>;

    const events: (keyof PartialMeshEvents)[] = [
      'signaling:connected',
      'signaling:disconnected',
      'signaling:error',
      'peer:connected',
      'peer:disconnected',
      'peer:data',
      'peer:error',
      'peer:discovered',
      'mesh:ready',
    ];
    events.forEach((event) => this.eventHandlers.set(event, new Set()));
  }

  private normalizePeerId(peerId: string | null | undefined): string {
    return (peerId ?? '').trim();
  }

  async init(): Promise<void> {
    const { default: UniWRTCClient } = await import('uniwrtc/client-browser.js');

    let signalingUrl = this.config.signalingServer;
    if (signalingUrl.includes('signal.peer.ooo')) {
      const url = new URL(signalingUrl);
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.protocol === 'http:') url.protocol = 'ws:';
      const normalizedPath = url.pathname.replace(/\/+$/, '');
      if (normalizedPath === '' || normalizedPath === '/') {
        url.pathname = '/ws';
      } else if (normalizedPath !== '/ws') {
        url.pathname = '/ws';
      }
      if (!url.searchParams.get('room')) {
        url.searchParams.set('room', this.config.sessionId);
      }
      signalingUrl = url.toString();
    }

    this.uniwrtcClient = new UniWRTCClient(signalingUrl, {
      autoReconnect: true,
      reconnectDelay: 3000,
    });

    this.uniwrtcClient.on('connected', (data: { clientId: string }) => {
      const rawClientId = data?.clientId;
      this.clientId = this.normalizePeerId(rawClientId);
      this.emit('signaling:connected', { clientId: this.clientId, rawClientId });

      if (this.config.autoDiscover) {
        this.uniwrtcClient.joinSession(this.config.sessionId);
      }

      if (this.config.autoConnect) {
        this.startMaintenanceLoop();
      }
    });

    this.uniwrtcClient.on('disconnected', () => {
      this.emit('signaling:disconnected');
    });

    this.uniwrtcClient.on('joined', (data: { sessionId: string; clients: string[] }) => {
      const selfId = this.normalizePeerId(this.clientId);
      data.clients.forEach((rawPeerId: string) => {
        const peerId = this.normalizePeerId(rawPeerId);
        if (peerId && peerId !== selfId) {
          this.discoveredPeers.add(peerId);
          this.emit('peer:discovered', peerId);
        }
      });
      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
    });

    this.uniwrtcClient.on('peer-joined', (data: { peerId: string }) => {
      const selfId = this.normalizePeerId(this.clientId);
      const peerId = this.normalizePeerId(data.peerId);
      if (peerId && peerId !== selfId) {
        this.discoveredPeers.add(peerId);
        this.emit('peer:discovered', peerId);
        if (this.config.autoConnect) {
          this.maintainPeerConnections();
        }
      }
    });

    this.uniwrtcClient.on('peer-left', (data: { peerId: string }) => {
      const peerId = this.normalizePeerId(data.peerId);
      if (!peerId) return;
      this.discoveredPeers.delete(peerId);
      this.removePeer(peerId, true);
    });

    this.uniwrtcClient.on('offer', async (data: { peerId: string; offer: RTCSessionDescriptionInit }) => {
      await this.handleOffer(data.peerId, data.offer);
    });

    this.uniwrtcClient.on('answer', async (data: { peerId: string; answer: RTCSessionDescriptionInit }) => {
      await this.handleAnswer(data.peerId, data.answer);
    });

    this.uniwrtcClient.on('ice-candidate', async (data: { peerId: string; candidate: RTCIceCandidateInit }) => {
      await this.handleIceCandidate(data.peerId, data.candidate);
    });

    this.uniwrtcClient.on('error', (error: any) => {
      this.emit('signaling:error', error);
    });

    await this.uniwrtcClient.connect();
  }

  private startMaintenanceLoop(): void {
    if (this.maintenanceTimer) return;
    if (!this.config.maintenanceIntervalMs || this.config.maintenanceIntervalMs <= 0) return;
    this.maintenanceTimer = setInterval(() => {
      try {
        this.maintainPeerConnections();
        this.maybeHardResetUnderConnected();
      } catch {
        // ignore
      }
    }, this.config.maintenanceIntervalMs);
  }

  private maybeHardResetUnderConnected(): void {
    const thresholdMs = this.config.underConnectedResetMs;
    if (!thresholdMs || thresholdMs <= 0) return;

    const connected = this.getConnectedPeers().length;
    const hasEnoughCandidates = this.discoveredPeers.size >= this.config.minPeers;
    const underConnected = connected < this.config.minPeers && hasEnoughCandidates;

    const now = Date.now();
    if (!underConnected) {
      this.underConnectedSinceMs = null;
      return;
    }

    if (this.underConnectedSinceMs == null) {
      this.underConnectedSinceMs = now;
      return;
    }

    if (now - this.underConnectedSinceMs < thresholdMs) return;
    if (now - this.lastHardResetAtMs < thresholdMs) return;

    this.hardReset('under-connected');
  }

  public hardReset(reason: string = 'manual'): void {
    this.lastHardResetAtMs = Date.now();
    this.underConnectedSinceMs = null;

    for (const t of this.connectionTimers.values()) {
      clearTimeout(t);
    }
    this.connectionTimers.clear();

    for (const peerConnection of this.peers.values()) {
      try {
        if (!peerConnection.peer.destroyed) peerConnection.peer.destroy();
      } catch {
        // ignore
      }
    }
    this.peers.clear();
    this.connecting.clear();

    try {
      if (this.uniwrtcClient && this.config.sessionId) {
        this.uniwrtcClient.joinSession(this.config.sessionId);
      }
    } catch {
      // ignore
    }

    if (this.config.autoConnect) {
      try {
        this.maintainPeerConnections();
      } catch {
        // ignore
      }
    }

    try {
      console.warn(`[PartialMesh] hardReset(${reason}) clientId=${this.clientId ?? ''} discovered=${this.discoveredPeers.size}`);
    } catch {
      // ignore
    }
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    let peerConnection = this.peers.get(normalizedPeerId);
    if (peerConnection?.initiator) {
      try {
        peerConnection.peer.destroy();
      } catch {
        // ignore
      }
      this.removePeer(normalizedPeerId, false);
      peerConnection = undefined;
    }

    if (!peerConnection) {
      peerConnection = this.createPeerConnection(normalizedPeerId, false);
    }

    try {
      peerConnection.peer.signal(offer);
    } catch (err) {
      console.error(`Error signaling offer from peer ${peerId}:`, err);
    }
  }

  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    const peerConnection = this.peers.get(normalizedPeerId);
    if (!peerConnection) return;

    try {
      peerConnection.peer.signal(answer);
    } catch (err) {
      console.error(`Error signaling answer from peer ${peerId}:`, err);
    }
  }

  private async handleIceCandidate(peerId: string, candidate: any): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    const peerConnection = this.peers.get(normalizedPeerId);
    if (peerConnection) {
      try {
        peerConnection.peer.signal({ type: 'candidate', candidate: candidate });
      } catch (err) {
        console.error(`Error adding ICE candidate from peer ${peerId}:`, err);
      }
    }
  }

  private createPeerConnection(peerId: string, initiator: boolean): PeerConnection {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: this.config.iceServers },
    });

    const peerConnection: PeerConnection = {
      id: peerId,
      peer,
      connected: false,
      initiator,
    };

    const existingTimer = this.connectionTimers.get(peerId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      const current = this.peers.get(peerId);
      if (!current || current.connected) return;
      if (current.peer.destroyed) return;
      this.connecting.delete(peerId);
      this.emit('peer:error', { peerId, error: new Error('Connection timeout') });
      try {
        current.peer.destroy();
      } catch {
        // ignore
      }
      this.removePeer(peerId);
    }, this.config.connectionTimeoutMs);
    this.connectionTimers.set(peerId, timer);

    peer.on('signal', (signal: any) => {
      if (signal.type === 'offer') {
        this.uniwrtcClient.sendOffer(signal, peerId);
      } else if (signal.type === 'answer') {
        this.uniwrtcClient.sendAnswer(signal, peerId);
      } else if (signal.candidate) {
        this.uniwrtcClient.sendIceCandidate(signal.candidate, peerId);
      }
    });

    peer.on('connect', () => {
      peerConnection.connected = true;
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.emit('peer:connected', peerId);
      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
      if (this.getConnectedPeers().length >= this.config.minPeers) {
        this.emit('mesh:ready');
      }
    });

    peer.on('data', (data: any) => {
      this.emit('peer:data', { peerId, data });
    });

    peer.on('close', () => {
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.removePeer(peerId);
    });

    peer.on('error', (err: any) => {
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.emit('peer:error', { peerId, error: err });
      this.removePeer(peerId);
    });

    this.peers.set(peerId, peerConnection);
    return peerConnection;
  }

  private maintainPeerConnections(): void {
    const currentPeerCount = this.peers.size;
    const connectingCount = this.connecting.size;
    const totalInProgress = currentPeerCount + connectingCount;

    if (totalInProgress < this.config.minPeers) {
      const needed = this.config.minPeers - totalInProgress;
      const available = Array.from(this.discoveredPeers).filter(
        (peerId) => !this.peers.has(peerId) && !this.connecting.has(peerId),
      );
      if (available.length === 0) return;
      const selfId = this.normalizePeerId(this.clientId);
      const sorted = available.slice().sort();
      let offset = 0;
      if (selfId) {
        let hash = 0;
        for (let i = 0; i < selfId.length; i++) {
          hash = (hash * 31 + selfId.charCodeAt(i)) >>> 0;
        }
        offset = sorted.length ? hash % sorted.length : 0;
      }
      for (let i = 0; i < Math.min(needed, sorted.length); i++) {
        const peerId = sorted[(offset + i) % sorted.length];
        this.connectToPeer(peerId);
      }
    } else if (currentPeerCount > this.config.maxPeers) {
      const toDrop = currentPeerCount - this.config.maxPeers;
      const peerIds = Array.from(this.peers.keys());
      for (let i = 0; i < toDrop; i++) {
        this.disconnectFromPeer(peerIds[i]);
      }
    }
  }

  public connectToPeer(peerId: string): void {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || this.peers.has(normalizedPeerId) || this.connecting.has(normalizedPeerId) || normalizedPeerId === selfId) {
      return;
    }
    if (this.peers.size >= this.config.maxPeers) {
      console.warn('Max peers reached, cannot connect to more peers');
      return;
    }
    const initiator = selfId ? selfId < normalizedPeerId : true;
    this.connecting.add(normalizedPeerId);
    this.createPeerConnection(normalizedPeerId, initiator);
  }

  public disconnectFromPeer(peerId: string): void {
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId) return;
    this.removePeer(normalizedPeerId, false);
  }

  private removePeer(peerId: string, forgetDiscovered: boolean = false): void {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection) {
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      if (!peerConnection.peer.destroyed) {
        peerConnection.peer.destroy();
      }
      this.peers.delete(peerId);
      this.connecting.delete(peerId);
      if (forgetDiscovered) {
        this.discoveredPeers.delete(peerId);
      }
      this.emit('peer:disconnected', peerId);
      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
    }
  }

  public send(peerId: string, data: string | Buffer | ArrayBuffer): void {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection && peerConnection.connected) {
      peerConnection.peer.send(data);
    } else {
      throw new Error(`Peer ${peerId} is not connected`);
    }
  }

  public broadcast(data: string | Buffer | ArrayBuffer): void {
    this.peers.forEach((peerConnection) => {
      if (peerConnection.connected) {
        peerConnection.peer.send(data);
      }
    });
  }

  public getConnectedPeers(): string[] {
    return Array.from(this.peers.values())
      .filter((pc) => pc.connected)
      .map((pc) => pc.id);
  }

  public getDiscoveredPeers(): string[] {
    return Array.from(this.discoveredPeers);
  }

  public getPeerCount(): number {
    return this.peers.size;
  }

  public getClientId(): string | null {
    return this.clientId;
  }

  public on<K extends keyof PartialMeshEvents>(event: K, handler: PartialMeshEvents[K]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.add(handler);
    }
  }

  public off<K extends keyof PartialMeshEvents>(event: K, handler: PartialMeshEvents[K]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  private emit<K extends keyof PartialMeshEvents>(event: K, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          (handler as any)(...args);
        } catch (err) {
          console.error(`Error in event handler for ${String(event)}:`, err);
        }
      });
    }
  }

  public destroy(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    for (const t of this.connectionTimers.values()) {
      clearTimeout(t);
    }
    this.connectionTimers.clear();

    this.peers.forEach((peerConnection) => {
      if (!peerConnection.peer.destroyed) {
        peerConnection.peer.destroy();
      }
    });
    this.peers.clear();
    this.connecting.clear();
    this.discoveredPeers.clear();
    this.clientId = null;
    this.underConnectedSinceMs = null;
    this.lastHardResetAtMs = 0;

    if (this.uniwrtcClient) {
      this.uniwrtcClient.disconnect();
      this.uniwrtcClient = null;
    }
  }
}

export default PartialMesh;
