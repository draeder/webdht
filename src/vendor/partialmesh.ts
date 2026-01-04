import { getSimplePeer } from '../peer-factory.js';
import type { Instance as SimplePeerInstance } from 'simple-peer';

export interface PartialMeshConfig {
  minPeers?: number;
  maxPeers?: number;
  /**
   * When true, the mesh will not proactively disconnect peers (no swaps/evictions/shuffles),
   * and will not hard-reset the mesh. Note: peers can still disconnect due to WebRTC/network.
   */
  neverDisconnectPeers?: boolean;
  signalingServer?: string;
  sessionId?: string;
  autoDiscover?: boolean;
  autoConnect?: boolean;
  iceServers?: RTCIceServer[];
  trickle?: boolean;
  debug?: boolean;
  connectionTimeoutMs?: number;
  maintenanceIntervalMs?: number;
  underConnectedResetMs?: number;
  restartOnBelowMinPeers?: boolean;
  bootstrapGraceMs?: number;
}

export interface PeerConnection {
  id: string;
  peer: SimplePeerInstance;
  connected: boolean;
  initiator: boolean;
  createdAtMs: number;
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
  'mesh:reset': (data: { reason: string }) => void;
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
  private discoveredPeerLastSeenAtMs: Map<string, number> = new Map();
  // Public signaling can reorder messages; ICE candidates may arrive before the
  // corresponding offer/answer. Buffer them to avoid dropping early candidates
  // (Firefox tends to be less forgiving when candidates are missing).
  private pendingIceCandidates: Map<string, any[]> = new Map();
  private clientId: string | null = null;
  private selfHash32: number | null = null;
  private eventHandlers: Map<keyof PartialMeshEvents, Set<Function>> = new Map();
  private connecting: Set<string> = new Set();
  private connectionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private peerFailureCount: Map<string, number> = new Map();
  private peerCooldownUntilMs: Map<string, number> = new Map();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private underConnectedSinceMs: number | null = null;
  private lastHardResetAtMs: number = 0;
  private lastSessionRefreshAtMs: number = 0;
  private lastShuffleAtMs: number = 0;
  private lastGrowAtMs: number = 0;
  private bootstrapGraceUntilMs: number = 0;
  private everReachedMinPeers: boolean = false;
  private isHardResetting: boolean = false;
  private lastBelowMinResetAtMs: number = 0;
  private peersInGracePeriod: Set<string> = new Set();
  private gracePeriodAnswers: Map<string, RTCSessionDescriptionInit> = new Map();

  constructor(config: PartialMeshConfig = {}) {
    this.config = {
      minPeers: config.minPeers ?? 2,
      maxPeers: config.maxPeers ?? 10,
      neverDisconnectPeers: config.neverDisconnectPeers ?? false,
      signalingServer: config.signalingServer ?? 'wss://signal.peer.ooo',
      sessionId: config.sessionId ?? 'default-session',
      autoDiscover: config.autoDiscover ?? true,
      autoConnect: config.autoConnect ?? true,
      iceServers: config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
      trickle: config.trickle ?? false,
      debug: config.debug ?? false,
      connectionTimeoutMs: config.connectionTimeoutMs ?? 25_000,
      maintenanceIntervalMs: config.maintenanceIntervalMs ?? 2_000,
      underConnectedResetMs: config.underConnectedResetMs ?? 0,
      restartOnBelowMinPeers: config.restartOnBelowMinPeers ?? false,
      bootstrapGraceMs: config.bootstrapGraceMs ?? 12_000,
    } as Required<PartialMeshConfig>;

    // Ensure the invariant is achievable.
    if (this.config.maxPeers < this.config.minPeers) {
      this.config.maxPeers = this.config.minPeers;
    }

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
      'mesh:reset',
    ];
    events.forEach((event) => this.eventHandlers.set(event, new Set()));
  }

  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[PartialMesh]', ...args);
    }
  }

  private describeCandidate(candidate: any): any {
    try {
      const candStr = String(candidate?.candidate ?? candidate ?? '');
      const typ = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(candStr)?.[1] ?? 'unknown';
      const protocol = /\budp\b/i.test(candStr) ? 'udp' : (/\btcp\b/i.test(candStr) ? 'tcp' : 'unknown');
      return {
        typ,
        protocol,
        sdpMid: candidate?.sdpMid,
        sdpMLineIndex: candidate?.sdpMLineIndex,
      };
    } catch {
      return { typ: 'unknown' };
    }
  }

  private normalizePeerId(peerId: string | null | undefined): string {
    return (peerId ?? '').trim();
  }

  private prefersInitiatorWith(peerId: string): boolean {
    const selfId = this.normalizePeerId(this.clientId);
    const other = this.normalizePeerId(peerId);
    if (!selfId || !other) return false;
    return selfId < other;
  }

  // Synchronous, deterministic 32-bit hash for peer IDs.
  // Used for XOR distance selection (Kademlia-style) without requiring async crypto.
  private hash32(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
      h >>>= 0;
    }
    return h >>> 0;
  }

  private xorDistance(peerId: string): number {
    const self = this.selfHash32;
    if (self == null) return 0xffffffff;
    return (self ^ this.hash32(peerId)) >>> 0;
  }

  private sortByXorDistance(peerIds: string[]): string[] {
    const ids = peerIds.slice();
    ids.sort((a, b) => {
      const da = this.xorDistance(a);
      const db = this.xorDistance(b);
      if (da !== db) return da - db;
      // Stable tie-breaker
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return ids;
  }

  private isCoolingDown(peerId: string): boolean {
    const until = this.peerCooldownUntilMs.get(peerId);
    return until != null && Date.now() < until;
  }

  private markPeerFailure(peerId: string, reason: string): void {
    const prev = this.peerFailureCount.get(peerId) ?? 0;
    const next = Math.min(prev + 1, 5);
    this.peerFailureCount.set(peerId, next);

    // Linear backoff (not exponential) to avoid starving the peer pool on public servers.
    // Cap at 30s so we keep trying even after repeated failures.
    const now = Date.now();
    const baseMs = 1_500;
    const maxMs = 30_000;
    const backoffMs = Math.min(maxMs, baseMs * next);
    const jitterMs = Math.floor(Math.random() * 500);
    this.peerCooldownUntilMs.set(peerId, now + backoffMs + jitterMs);
    this.log('Peer failure cooldown', { peerId, reason, failures: next, backoffMs });
  }

  private maybeEagerConnectToDiscoveredPeer(peerId: string, source: string): void {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;
    if (this.peers.has(normalizedPeerId) || this.connecting.has(normalizedPeerId)) return;
    if (this.isCoolingDown(normalizedPeerId)) return;

    // Only nodes that already have at least one direct connection should
    // proactively pull in joiners. This avoids everyone dialing everyone
    // simultaneously at cold start, while still letting the mesh grow.
    if (this.getConnectedPeers().length <= 0) return;

    // Avoid offer/answer glare by ensuring only one side of a pair dials.
    // If we are not the deterministic initiator for this peer, wait for them.
    if (!this.prefersInitiatorWith(normalizedPeerId)) return;

    const currentPeerCount = this.peers.size;
    const connectedCount = this.getConnectedPeers().length;

    // In "never disconnect" mode, don't swap/evict to make room.
    if (this.config.neverDisconnectPeers) {
      if (currentPeerCount < this.config.maxPeers) {
        this.connectToPeer(normalizedPeerId);
      }
      return;
    }

    // If we have capacity, connect immediately.
    if (currentPeerCount < this.config.maxPeers) {
      this.connectToPeer(normalizedPeerId);
      return;
    }

    // If we're saturated but have slack above minPeers, swap one out to make room.
    // This prevents stable cliques from refusing to incorporate late joiners.
    if (connectedCount > this.config.minPeers) {
      const connectedIds = this.getConnectedPeers();
      if (connectedIds.length > 0) {
        const sorted = this.sortByXorDistance(connectedIds);
        const dropId = sorted[sorted.length - 1];
        if (dropId) {
          this.log('Eager swap for joiner', { source, dropId, joiner: normalizedPeerId });
          this.disconnectFromPeer(dropId);
          this.connectToPeer(normalizedPeerId);
        }
      }
      return;
    }

    // Otherwise: we cannot safely drop (would violate minPeers). Best-effort:
    // if maxPeers is consumed by stale pending dials, evict one and try.
    const now = Date.now();
    const evictAfterMs = 8_000;
    const pending = Array.from(this.peers.values())
      .filter((pc) => !pc.connected)
      .filter((pc) => (now - (pc.createdAtMs || 0)) >= evictAfterMs);
    pending.sort((a, b) => a.createdAtMs - b.createdAtMs);
    const pc = pending[0];
    if (pc) {
      this.removePeer(pc.id, false, false);
      this.connectToPeer(normalizedPeerId);
    }
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

    this.log('Using signaling URL', signalingUrl, 'session', this.config.sessionId);

    this.uniwrtcClient = new UniWRTCClient(signalingUrl, {
      autoReconnect: true,
      reconnectDelay: 3000,
    });

    this.uniwrtcClient.on('connected', (data: { clientId: string }) => {
      const rawClientId = data?.clientId;
      this.clientId = this.normalizePeerId(rawClientId);
      this.selfHash32 = this.clientId ? this.hash32(this.clientId) : null;

      // It's impossible to satisfy minPeers immediately at startup.
      // Allow a brief bootstrap window, then enforce invariants.
      this.bootstrapGraceUntilMs = Date.now() + Math.max(0, this.config.bootstrapGraceMs);
      this.everReachedMinPeers = false;

      this.emit('signaling:connected', { clientId: this.clientId, rawClientId });
      this.log('Signaling connected as', this.clientId);

      if (this.config.autoDiscover) {
        this.uniwrtcClient.joinSession(this.config.sessionId);
      }

      if (this.config.autoConnect) {
        this.startMaintenanceLoop();
      }
    });

    this.uniwrtcClient.on('disconnected', () => {
      this.emit('signaling:disconnected');
      this.log('Signaling disconnected');
    });

    // When UniWRTC auto-reconnects, it fires 'connected' again but we need to rejoin.
    // The 'connected' handler above already does joinSession, so we're covered.
    // But we should also handle reconnection by clearing stale state if needed.

    this.uniwrtcClient.on('joined', (data: { sessionId: string; clients: string[] }) => {
      const selfId = this.normalizePeerId(this.clientId);
      this.log('Joined session', data.sessionId, 'with peers', data.clients?.length ?? 0);

      const now = Date.now();

      // IMPORTANT: do NOT treat the roster snapshot as authoritative.
      // Public signaling rosters/events can be partial or briefly stale; replacing
      // the discovered set makes "indirect" peers flicker/disappear.
      // Instead, only refresh last-seen timestamps for peers present in the snapshot.
      const prev = new Set(this.discoveredPeers);

      (data.clients ?? []).forEach((rawPeerId: string) => {
        const peerId = this.normalizePeerId(rawPeerId);
        if (peerId && peerId !== selfId) {
          this.discoveredPeers.add(peerId);
          this.discoveredPeerLastSeenAtMs.set(peerId, now);
        }
      });

      // Ensure currently-connected peers remain marked as recently seen.
      for (const peerId of this.getConnectedPeers()) {
        const normalized = this.normalizePeerId(peerId);
        if (normalized && normalized !== selfId) {
          this.discoveredPeers.add(normalized);
          this.discoveredPeerLastSeenAtMs.set(normalized, now);
        }
      }

      // Emit discovered for newly-seen peers only.
      for (const peerId of this.discoveredPeers) {
        if (!prev.has(peerId)) {
          this.emit('peer:discovered', peerId);
          this.maybeEagerConnectToDiscoveredPeer(peerId, 'joined');
        }
      }
      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
    });

    this.uniwrtcClient.on('peer-joined', (data: { peerId: string }) => {
      const selfId = this.normalizePeerId(this.clientId);
      const peerId = this.normalizePeerId(data.peerId);
      if (peerId && peerId !== selfId) {
        this.discoveredPeers.add(peerId);
        this.discoveredPeerLastSeenAtMs.set(peerId, Date.now());
        this.emit('peer:discovered', peerId);
        this.log('Peer joined', peerId);
        this.maybeEagerConnectToDiscoveredPeer(peerId, 'peer-joined');
        if (this.config.autoConnect) {
          this.maintainPeerConnections();
        }
      }
    });

    this.uniwrtcClient.on('peer-left', (data: { peerId: string }) => {
      const peerId = this.normalizePeerId(data.peerId);
      if (!peerId) return;
      this.discoveredPeers.delete(peerId);
      this.discoveredPeerLastSeenAtMs.delete(peerId);
      // Never tear down a WebRTC peer purely because signaling says they left;
      // public rosters can be stale/partial and WebRTC may still be healthy.
      // In neverDisconnectPeers mode, we only forget discovery; the WebRTC link
      // will close naturally if it is actually gone.
      const pc = this.peers.get(peerId);
      if (this.config.neverDisconnectPeers && pc?.connected) {
        this.log('Ignoring peer-left for connected peer (neverDisconnectPeers)', { peerId });
        return;
      }

      this.removePeer(peerId, true);
      this.log('Peer left', peerId);
    });

    this.uniwrtcClient.on('offer', async (data: { peerId: string; offer: RTCSessionDescriptionInit }) => {
      this.log('Received offer from', data.peerId);
      await this.handleOffer(data.peerId, data.offer);
    });

    this.uniwrtcClient.on('answer', async (data: { peerId: string; answer: RTCSessionDescriptionInit }) => {
      this.log('Received answer from', data.peerId);
      await this.handleAnswer(data.peerId, data.answer);
    });

    this.uniwrtcClient.on('ice-candidate', async (data: { peerId: string; candidate: RTCIceCandidateInit }) => {
      this.log('Received ice-candidate from', data.peerId, this.describeCandidate(data?.candidate));
      await this.handleIceCandidate(data.peerId, data.candidate);
    });

    this.uniwrtcClient.on('error', (error: any) => {
      this.emit('signaling:error', error);
      this.log('Signaling error', error);
    });

    await this.uniwrtcClient.connect();
  }

  private startMaintenanceLoop(): void {
    if (this.maintenanceTimer) return;
    if (!this.config.maintenanceIntervalMs || this.config.maintenanceIntervalMs <= 0) return;
    this.maintenanceTimer = setInterval(() => {
      try {
        this.maintainPeerConnections();
        this.maybeHardResetBelowMinPeers('maintenance');
        this.maybeHardResetUnderConnected();
        this.maybeRefreshSessionPeers();
      } catch {
        // ignore
      }
    }, this.config.maintenanceIntervalMs);
  }

  private maybeHardResetBelowMinPeers(trigger: string): void {
    if (this.config.neverDisconnectPeers) return;
    if (!this.config.restartOnBelowMinPeers) return;
    if (this.isHardResetting) return;
    if (!this.clientId) return;

    const connected = this.getConnectedPeers().length;
    if (connected >= this.config.minPeers) {
      this.everReachedMinPeers = true;
      return;
    }

    // If we have never reached minPeers, repeated resets are counter-productive
    // (e.g., ICE/TURN limitations). In that case, keep discovery state stable
    // and rely on per-peer backoff/retry rather than thrashing the whole mesh.
    if (!this.everReachedMinPeers) return;

    const now = Date.now();
    if (now < this.bootstrapGraceUntilMs) return;

    const cooldownMs = 2_000;
    if (now - this.lastBelowMinResetAtMs < cooldownMs) return;
    this.lastBelowMinResetAtMs = now;
    this.hardReset(`below-minPeers:${trigger}`);
  }

  private maybeRefreshSessionPeers(): void {
    if (!this.uniwrtcClient) return;
    if (!this.config.sessionId) return;
    const now = Date.now();

    const connected = this.getConnectedPeers().length;
    const discovered = this.discoveredPeers.size;
    const underConnected = connected < this.config.minPeers && discovered < this.config.minPeers;

    // On some public signaling servers, incremental peer-joined events can be
    // delayed or dropped. If we never refresh the session roster, the discovered
    // set can stagnate at (or near) the connected set, which prevents the UI
    // from ever showing any indirect peers.
    const discoveryStalled = discovered <= connected;

    // Refresh more frequently when we're under-connected to speed convergence;
    // otherwise keep the low frequency to avoid spamming public servers.
    const refreshIntervalMs = (underConnected || discoveryStalled) ? 2_500 : 10_000;
    if (now - this.lastSessionRefreshAtMs < refreshIntervalMs) return;
    this.lastSessionRefreshAtMs = now;
    try {
      this.uniwrtcClient.joinSession(this.config.sessionId);
    } catch {
      // best-effort
    }
  }

  private maybeHardResetUnderConnected(): void {
    if (this.config.neverDisconnectPeers) return;
    const thresholdMs = this.config.underConnectedResetMs;
    if (!thresholdMs || thresholdMs <= 0) return;

    const now = Date.now();
    if (now < this.bootstrapGraceUntilMs) return;

    // Avoid thrashing in environments where we never manage to reach minPeers
    // (e.g. ICE failures due to missing TURN). Resets won't help and can make
    // indirect discovery appear to flicker.
    if (!this.everReachedMinPeers) {
      this.underConnectedSinceMs = null;
      return;
    }

    const connected = this.getConnectedPeers().length;
    const discovered = this.discoveredPeers.size;
    const hasEnoughCandidates = discovered >= this.config.minPeers;
    const underConnected = connected < this.config.minPeers;
    if (!underConnected) {
      this.underConnectedSinceMs = null;
      return;
    }

    // If we don't even have enough candidates, resetting can't repair the mesh.
    // Wait for discovery to improve.
    if (!hasEnoughCandidates) {
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
    if (this.config.neverDisconnectPeers) {
      this.log('Ignoring hardReset (neverDisconnectPeers)', { reason });
      return;
    }
    if (this.isHardResetting) return;
    this.isHardResetting = true;

    this.lastHardResetAtMs = Date.now();
    this.underConnectedSinceMs = null;
    this.bootstrapGraceUntilMs = Date.now() + Math.max(0, this.config.bootstrapGraceMs);
    this.everReachedMinPeers = false;

    // Keep discovery state across resets to avoid "indirect" peers disappearing.
    // Expiry is handled via TTL in getDiscoveredPeers() and peer-left events.

    this.emit('mesh:reset', { reason });

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

    // Allow close/error cascades to settle before enabling another reset.
    setTimeout(() => {
      this.isHardResetting = false;
    }, 0);
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    // Deterministic role selection to avoid offer glare.
    // Normally only the preferred initiator (selfId < peerId) should generate offers,
    // but on a constrained/saturated mesh we must still accept inbound offers to
    // avoid deadlocks (e.g. preferred initiator can't dial due to maxPeers pressure).
    const wePreferInitiator = this.prefersInitiatorWith(normalizedPeerId);

    const connectedCount = this.getConnectedPeers().length;
    const underConnected = connectedCount < this.config.minPeers;
    const cannotInitiateNow =
      this.isCoolingDown(normalizedPeerId) ||
      (!this.config.neverDisconnectPeers && this.peers.size >= this.config.maxPeers) ||
      this.connecting.size > 0 ||
      underConnected;

    let peerConnection = this.peers.get(normalizedPeerId);
    if (peerConnection?.initiator) {
      // Offer glare resolution:
      // - If we are the preferred initiator for this pair, keep our outbound attempt.
      // - Otherwise, yield to the inbound offer and become the responder.
      if (!peerConnection.connected) {
        if (wePreferInitiator) {
          this.log('Ignoring inbound offer during glare (we are initiator)', { peerId: normalizedPeerId });
          return;
        }
        try {
          peerConnection.peer.destroy();
        } catch {
          // ignore
        }
        this.removePeer(normalizedPeerId, false);
        peerConnection = undefined;
      } else {
        // Already connected: ignore unexpected offers.
        this.log('Ignoring offer on already-connected peer', { peerId: normalizedPeerId });
        return;
      }
    }

    // If we prefer initiator for this pair, only accept the inbound offer when we
    // can't reasonably initiate right now. Otherwise ignore it and let our outbound
    // dial win (or start one if missing).
    if (wePreferInitiator) {
      if (!peerConnection && !cannotInitiateNow) {
        if (!this.connecting.has(normalizedPeerId)) {
          this.connectToPeer(normalizedPeerId);
        }
        this.log('Ignoring unexpected offer (we are initiator)', { peerId: normalizedPeerId });
        return;
      }
    }

    // Ensure we have capacity to accept an inbound offer.
    // If we're saturated, evict a stale pending dial first; otherwise (if safe)
    // swap out a connected peer with slack above minPeers.
    if (!this.config.neverDisconnectPeers && !peerConnection && this.peers.size >= this.config.maxPeers) {
      const now = Date.now();
      const evictAfterMs = 8_000;
      const pending = Array.from(this.peers.values())
        .filter((pc) => !pc.connected)
        .filter((pc) => (now - (pc.createdAtMs || 0)) >= evictAfterMs);
      pending.sort((a, b) => a.createdAtMs - b.createdAtMs);
      const stale = pending[0];
      if (stale) {
        this.removePeer(stale.id, false, false);
      } else {
        const connected = this.getConnectedPeers();
        if (connected.length > this.config.minPeers) {
          const sorted = this.sortByXorDistance(connected);
          const dropId = sorted[sorted.length - 1];
          if (dropId) {
            this.disconnectFromPeer(dropId);
          }
        }
      }

      if (this.peers.size >= this.config.maxPeers && !this.peers.has(normalizedPeerId)) {
        this.log('Dropping inbound offer (no capacity)', { peerId: normalizedPeerId, maxPeers: this.config.maxPeers });
        return;
      }
    }

    if (!peerConnection) {
      peerConnection = await this.createPeerConnection(normalizedPeerId, false);
    }

    try {
      peerConnection.peer.signal(offer);
      this.flushPendingIceCandidates(normalizedPeerId);
    } catch (err) {
      console.error(`Error signaling offer from peer ${peerId}:`, err);
    }
  }

  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    const peerConnection = this.peers.get(normalizedPeerId);
    
    // If peer is in grace period (destroyed by ICE failure), buffer the answer
    if (this.peersInGracePeriod.has(normalizedPeerId)) {
      this.log('Answer arrived during grace period, buffering for retry', normalizedPeerId);
      this.gracePeriodAnswers.set(normalizedPeerId, answer);
      // Trigger immediate retry with buffered answer
      this.peersInGracePeriod.delete(normalizedPeerId);
      this.connecting.delete(normalizedPeerId);
      if (peerConnection) {
        this.peers.delete(normalizedPeerId);
      }
      await this.connectToPeer(normalizedPeerId);
      return;
    }
    
    if (!peerConnection) return;
    if (!peerConnection.initiator) {
      // Only initiators should receive answers; ignore to avoid corrupting state.
      return;
    }

    try {
      peerConnection.peer.signal(answer);
      this.flushPendingIceCandidates(normalizedPeerId);
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
        
        // Firefox often declares ICE failed before srflx candidates arrive.
        // If we get an srflx candidate and ICE already failed, restart.
        const candDesc = this.describeCandidate(candidate);
        if (candDesc.typ === 'srflx') {
          try {
            const pc: RTCPeerConnection | undefined = (peerConnection.peer as any)?._pc;
            if (pc && pc.iceConnectionState === 'failed' && peerConnection.initiator) {
              this.log('Received srflx after ICE failed, restarting', { peerId: normalizedPeerId });
              // Destroy and recreate the connection
              setTimeout(() => {
                if (this.peers.has(normalizedPeerId)) {
                  this.removePeer(normalizedPeerId, false, false);
                  this.connectToPeer(normalizedPeerId);
                }
              }, 100);
            }
          } catch {
            // best-effort
          }
        }
      } catch (err) {
        console.error(`Error adding ICE candidate from peer ${peerId}:`, err);
      }
      return;
    }

    // Buffer until we have a peer connection (usually created when we receive an offer).
    const pending = this.pendingIceCandidates.get(normalizedPeerId) ?? [];
    pending.push(candidate);
    // Cap growth in case of misbehaving peers.
    if (pending.length > 64) pending.splice(0, pending.length - 64);
    this.pendingIceCandidates.set(normalizedPeerId, pending);
  }

  private flushPendingIceCandidates(peerId: string): void {
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId) return;
    const peerConnection = this.peers.get(normalizedPeerId);
    if (!peerConnection) return;

    const pending = this.pendingIceCandidates.get(normalizedPeerId);
    if (!pending || pending.length === 0) return;
    this.pendingIceCandidates.delete(normalizedPeerId);

    for (const candidate of pending) {
      try {
        peerConnection.peer.signal({ type: 'candidate', candidate });
      } catch {
        // best-effort
      }
    }
  }

  private async createPeerConnection(peerId: string, initiator: boolean): Promise<PeerConnection> {
    const SimplePeer = await getSimplePeer();
    const peer = new SimplePeer({
      initiator,
      trickle: this.config.trickle,
      config: { 
        iceServers: this.config.iceServers,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      },
      // More lenient timeouts for Firefox
      offerOptions: {
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      },
      answerOptions: {},
      // Firefox needs more time to gather candidates - default is 5s, bump to 15s
      iceCompleteTimeout: 15000,
    });

    this.log('Creating peer connection', { peerId, initiator, trickle: this.config.trickle });

    // Extra diagnostics: Firefox often fails ICE without TURN, and these state
    // transitions are the quickest signal of what's happening.
    try {
      const pc: RTCPeerConnection | undefined = (peer as any)?._pc;
      if (pc) {
        const originalIceHandler = pc.oniceconnectionstatechange;
        pc.oniceconnectionstatechange = (event) => {
          this.log('ICE state', { peerId, state: pc.iceConnectionState });
          if (originalIceHandler) originalIceHandler.call(pc, event);
        };
        
        const originalConnHandler = pc.onconnectionstatechange;
        pc.onconnectionstatechange = (event) => {
          this.log('PC connection state', { peerId, state: (pc as any).connectionState });
          if (originalConnHandler) originalConnHandler.call(pc, event);
        };
        
        const originalSigHandler = pc.onsignalingstatechange;
        pc.onsignalingstatechange = (event) => {
          this.log('Signaling state', { peerId, state: pc.signalingState });
          if (originalSigHandler) originalSigHandler.call(pc, event);
        };
      }
    } catch {
      // best-effort
    }

    const peerConnection: PeerConnection = {
      id: peerId,
      peer,
      connected: false,
      initiator,
      createdAtMs: Date.now(),
    };

    const existingTimer = this.connectionTimers.get(peerId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      const current = this.peers.get(peerId);
      if (!current || current.connected) return;
      if (current.peer.destroyed) return;
      this.connecting.delete(peerId);
      this.emit('peer:error', { peerId, error: new Error('Connection timeout') });
      this.markPeerFailure(peerId, 'timeout');
      this.log('Connection timeout', peerId);
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
        this.log('Sending offer to', peerId);
        this.uniwrtcClient.sendOffer(signal, peerId);
      } else if (signal.type === 'answer') {
        this.log('Sending answer to', peerId);
        this.uniwrtcClient.sendAnswer(signal, peerId);
      } else if (signal.candidate) {
        this.log('Sending candidate to', peerId, this.describeCandidate(signal.candidate));
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
      this.log('Peer connected', peerId);
      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
      if (this.getConnectedPeers().length >= this.config.minPeers) {
        this.everReachedMinPeers = true;
        this.emit('mesh:ready');
      }
    });

    peer.on('data', (data: any) => {
      this.emit('peer:data', { peerId, data });
    });

    peer.on('close', () => {
      this.log('Peer closed', peerId);
      
      // If this peer is in grace period, don't immediately remove it
      if (this.peersInGracePeriod.has(peerId)) {
        this.log('Peer in grace period, deferring close handling', peerId);
        return;
      }
      
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      if (!peerConnection.connected) {
        this.markPeerFailure(peerId, 'closed-before-connect');
      }
      this.removePeer(peerId);
    });

    peer.on('error', (err: any) => {
      this.log('Peer error', peerId, err);
      
      // Firefox can declare ICE failed before the answer arrives over signaling.
      // If we're the initiator and haven't received the answer yet, give it
      // a few more seconds before destroying the connection.
      const pc: RTCPeerConnection | undefined = (peer as any)?._pc;
      const isIceError = String(err?.message ?? '').includes('Ice connection failed');
      const hasRemoteDescription = pc?.remoteDescription != null;
      
      this.log('Error check', { 
        peerId, 
        initiator, 
        isIceError, 
        hasRemoteDescription,
        signalingState: pc?.signalingState 
      });
      
      if (initiator && isIceError && !hasRemoteDescription) {
        this.log('ICE failed before answer received, giving signaling 3s grace period', peerId);
        this.peersInGracePeriod.add(peerId);
        
        setTimeout(() => {
          // If answer arrived during grace period, handleAnswer already triggered retry
          if (!this.peersInGracePeriod.has(peerId)) {
            this.log('Grace period complete: answer arrived, retry already triggered', peerId);
            this.gracePeriodAnswers.delete(peerId);
            return;
          }
          
          this.peersInGracePeriod.delete(peerId);
          this.gracePeriodAnswers.delete(peerId);
          
          // Re-check: if connection recovered somehow, do nothing
          const current = this.peers.get(peerId);
          if (current && current.connected && !current.peer.destroyed) {
            this.log('Grace period complete: peer recovered', peerId);
            return;
          }
          
          // Still no answer, proceed with failure
          this.log('Grace period complete: peer still failed', peerId);
          this.connecting.delete(peerId);
          const t = this.connectionTimers.get(peerId);
          if (t) {
            clearTimeout(t);
            this.connectionTimers.delete(peerId);
          }
          this.emit('peer:error', { peerId, error: err });
          this.markPeerFailure(peerId, String(err?.message ?? 'error'));
          this.removePeer(peerId);
        }, 3000);
        return;
      }
      
      // Immediate failure for other errors
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.emit('peer:error', { peerId, error: err });
      this.markPeerFailure(peerId, String(err?.message ?? 'error'));
      this.removePeer(peerId);
    });

    this.peers.set(peerId, peerConnection);
    return peerConnection;
  }

  private maintainPeerConnections(): void {
    // Note: peers in `connecting` are also present in `peers`, so do NOT
    // double-count them. Our invariant is about *connected* peers.
    const currentPeerCount = this.peers.size;
    const connectedCount = this.getConnectedPeers().length;

    // Hard requirement mode: do not proactively disconnect/evict/swap.
    // We still allow connecting (optionally beyond maxPeers) and we still react
    // to WebRTC-level disconnects.
    if (this.config.neverDisconnectPeers) {
      const available = this.getDiscoveredPeers().filter(
        (peerId) => !this.peers.has(peerId) && !this.connecting.has(peerId) && !this.isCoolingDown(peerId),
      );
      if (available.length === 0) return;

      const pickId = this.sortByXorDistance(available)[0];
      if (pickId) {
        this.connectToPeer(pickId);
      }
      return;
    }
    const capacity = Math.max(0, this.config.maxPeers - currentPeerCount);

    const now = Date.now();

    // If we're at maxPeers but have fewer than maxPeers *connected*, one (or more)
    // slots are being consumed by stalled, never-connected dials. Under maxPeers=3
    // this can permanently strand late joiners. Evict stale pending dials to free slots.
    if (currentPeerCount >= this.config.maxPeers && connectedCount < this.config.maxPeers) {
      const evictAfterMs = 8_000;
      const pending = Array.from(this.peers.values())
        .filter((pc) => !pc.connected)
        .filter((pc) => (now - (pc.createdAtMs || 0)) >= evictAfterMs);
      pending.sort((a, b) => a.createdAtMs - b.createdAtMs);
      const slotsToFree = Math.max(1, currentPeerCount - (this.config.maxPeers - 1));
      const toEvict = pending.slice(0, slotsToFree);
      for (const pc of toEvict) {
        this.removePeer(pc.id, false, false);
      }
    }

    // If we're under-connected, connect to enough peers to reach minPeers.
    // Never connect to ALL discovered peers; that can accidentally create a full mesh
    // and defeat the purpose of a *partial* mesh.
    if (connectedCount < this.config.minPeers) {
      // Under-connected: dial sequentially (one at a time). This significantly
      // reduces glare/offer storms under lossy public signaling while still
      // ensuring progress.
      if (this.connecting.size > 0) return;

      const available = this.getDiscoveredPeers().filter(
        (peerId) => !this.peers.has(peerId) && !this.connecting.has(peerId) && !this.isCoolingDown(peerId),
      );
      const needed = Math.max(0, this.config.minPeers - connectedCount);

      // If we're under-connected but at (or over) maxPeers due to stalled
      // in-flight dials, evict the oldest non-connected peers to free slots.
      // Otherwise we can get stuck below minPeers until the timeout fires.
      const slotsMissing = Math.max(0, needed - capacity);
      if (slotsMissing > 0) {
        const now = Date.now();
        const evictAfterMs = 8_000;
        const pending = Array.from(this.peers.values())
          .filter((pc) => !pc.connected)
          .filter((pc) => (now - (pc.createdAtMs || 0)) >= evictAfterMs);
        pending.sort((a, b) => a.createdAtMs - b.createdAtMs);
        const toEvict = pending.slice(0, slotsMissing);
        for (const pc of toEvict) {
          this.removePeer(pc.id, false, false);
        }
      }

      if (available.length === 0) return;

      const refreshedCapacity = Math.max(0, this.config.maxPeers - this.peers.size);
      const toConnect = Math.min(1, needed, refreshedCapacity, available.length);
      if (toConnect <= 0) return;

      // Choose closest peers by XOR distance (Kademlia-style) for faster, more stable convergence.
      const chosen = this.sortByXorDistance(available).slice(0, toConnect);
      for (const peerId of chosen) {
        this.connectToPeer(peerId);
      }
      return;
    }

    // If we have spare candidates, rotate connections to improve mixing.
    const available = this.getDiscoveredPeers().filter(
      (peerId) => !this.peers.has(peerId) && !this.connecting.has(peerId) && !this.isCoolingDown(peerId),
    );

    // If we're healthy (>= minPeers) but not saturated (< maxPeers), proactively
    // add a connection occasionally. This reduces the chance that small cliques
    // form under maxPeers=3 and leave late-joining peers stranded at 0.
    if (available.length > 0 && connectedCount >= this.config.minPeers && connectedCount < this.config.maxPeers) {
      const now = Date.now();
      const growIntervalMs = 2_500;
      if (now - this.lastGrowAtMs >= growIntervalMs) {
        this.lastGrowAtMs = now;
        const pickId = this.sortByXorDistance(available)[0];
        if (pickId) {
          this.connectToPeer(pickId);
          return;
        }
      }
    }

    if (available.length > 0 && connectedCount >= this.config.minPeers) {
      const now = Date.now();
      const shuffleIntervalMs = available.length >= 3 ? 3_000 : 6_000;
      if (now - this.lastShuffleAtMs >= shuffleIntervalMs) {
        const connectedIds = this.getConnectedPeers();
        if (connectedIds.length > 0) {
          const dropIdx = Math.floor(Math.random() * connectedIds.length);
          const dropId = connectedIds[dropIdx];
          const pickId = this.sortByXorDistance(available)[0];

          this.lastShuffleAtMs = now;

          // Never disconnect below minPeers.
          // If we have slack (connected > minPeers), we can safely drop one.
          // If we're exactly at minPeers, only add (up to maxPeers); dropping would
          // temporarily violate the invariant.
          if (connectedCount > this.config.minPeers) {
            // If saturated at maxPeers, swap by dropping then connecting.
            if (currentPeerCount >= this.config.maxPeers) {
              this.disconnectFromPeer(dropId);
              this.connectToPeer(pickId);
            } else {
              // Otherwise, connect then drop (still stays >= minPeers).
              this.connectToPeer(pickId);
              this.disconnectFromPeer(dropId);
            }
          } else {
            // At minPeers: only grow if allowed.
            if (currentPeerCount < this.config.maxPeers) {
              this.connectToPeer(pickId);
            }
          }
        }
      }
    }

    // Otherwise, enforce maxPeers cap
    if (currentPeerCount > this.config.maxPeers) {
      // Never drop below minPeers while enforcing maxPeers.
      const target = Math.max(this.config.maxPeers, this.config.minPeers);
      const toDrop = Math.max(0, currentPeerCount - target);
      const pending = Array.from(this.peers.values()).filter((pc) => !pc.connected);
      pending.sort((a, b) => a.createdAtMs - b.createdAtMs);
      const connected = Array.from(this.peers.values()).filter((pc) => pc.connected);
      connected.sort((a, b) => a.createdAtMs - b.createdAtMs);

      let remaining = toDrop;
      for (const pc of pending) {
        if (remaining <= 0) break;
        this.removePeer(pc.id, false, false);
        remaining--;
      }
      for (const pc of connected) {
        if (remaining <= 0) break;
        this.disconnectFromPeer(pc.id);
        remaining--;
      }
    }
  }

  public async connectToPeer(peerId: string): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || this.peers.has(normalizedPeerId) || this.connecting.has(normalizedPeerId) || normalizedPeerId === selfId) {
      return;
    }
    if (this.isCoolingDown(normalizedPeerId)) {
      return;
    }
    if (!this.config.neverDisconnectPeers && this.peers.size >= this.config.maxPeers) {
      console.warn('Max peers reached, cannot connect to more peers');
      return;
    }

    // Deterministic initiator selection: only one side dials to avoid glare.
    // However, when we're under-connected we must be able to make progress even
    // when we're the responder; otherwise we can remain at d0 long enough for
    // higher-level protocols/tests to target an unreachable peer.
    const connectedCount = this.getConnectedPeers().length;
    const underConnected = connectedCount < this.config.minPeers;
    const initiator = underConnected ? true : this.prefersInitiatorWith(normalizedPeerId);
    if (!initiator) {
      // We are the responder for this pair; wait for their offer.
      return;
    }

    this.connecting.add(normalizedPeerId);
    await this.createPeerConnection(normalizedPeerId, initiator);
  }

  public disconnectFromPeer(peerId: string): void {
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId) return;

    if (this.config.neverDisconnectPeers) {
      this.log('Refusing to disconnect (neverDisconnectPeers)', { peerId: normalizedPeerId });
      return;
    }

    // Never voluntarily drop below minPeers.
    // Remote disconnects can still happen; maintenance will heal those.
    const connected = this.getConnectedPeers().length;
    if (connected <= this.config.minPeers) {
      this.log('Refusing to disconnect below minPeers', { peerId: normalizedPeerId, connected, minPeers: this.config.minPeers });
      return;
    }
    this.removePeer(normalizedPeerId, false);
  }

  private removePeer(peerId: string, forgetDiscovered: boolean = false, triggerMaintain: boolean = true): void {
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
      this.pendingIceCandidates.delete(peerId);
      if (forgetDiscovered) {
        this.discoveredPeers.delete(peerId);
      }
      this.emit('peer:disconnected', peerId);

      // If configured, enforce the invariant by restarting the mesh immediately
      // when we dip below minPeers.
      this.maybeHardResetBelowMinPeers('disconnect');

      if (triggerMaintain && this.config.autoConnect && !this.isHardResetting) {
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
    // Expire peers that haven't been seen in a while. This protects against
    // public signaling servers that sometimes retain stale session rosters.
    const now = Date.now();
    const ttlMs = 30_000;

    const connected = new Set(this.getConnectedPeers());
    const result: string[] = [];

    const toDelete: string[] = [];

    for (const peerId of this.discoveredPeers) {
      if (connected.has(peerId)) {
        result.push(peerId);
        continue;
      }
      const lastSeen = this.discoveredPeerLastSeenAtMs.get(peerId);
      if (lastSeen != null && now - lastSeen <= ttlMs) {
        result.push(peerId);
      } else {
        // TTL expiry: stop showing/considering this peer and free memory.
        toDelete.push(peerId);
      }
    }

    for (const peerId of toDelete) {
      this.discoveredPeers.delete(peerId);
      this.discoveredPeerLastSeenAtMs.delete(peerId);
    }

    return result;
  }

  /**
   * Add peer IDs as discovered candidates.
   *
   * This helps in environments where public signaling rosters are partial
   * or event delivery is unreliable; higher-level protocols (like gossip)
   * can still surface peer IDs that we can attempt to connect to.
   */
  public learnPeers(peerIds: string[]): void {
    const selfId = this.normalizePeerId(this.clientId);
    const now = Date.now();
    for (const raw of peerIds ?? []) {
      const peerId = this.normalizePeerId(raw);
      if (!peerId) continue;
      if (selfId && peerId === selfId) continue;
      this.discoveredPeers.add(peerId);
      this.discoveredPeerLastSeenAtMs.set(peerId, now);
      this.maybeEagerConnectToDiscoveredPeer(peerId, 'learnPeers');
    }

    if (this.config.autoConnect) {
      this.maintainPeerConnections();
    }
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
    this.discoveredPeerLastSeenAtMs.clear();
    this.clientId = null;
    this.underConnectedSinceMs = null;
    this.lastHardResetAtMs = 0;
    this.lastSessionRefreshAtMs = 0;
    this.bootstrapGraceUntilMs = 0;
    this.everReachedMinPeers = false;
    this.isHardResetting = false;
    this.lastBelowMinResetAtMs = 0;

    if (this.uniwrtcClient) {
      this.uniwrtcClient.disconnect();
      this.uniwrtcClient = null;
    }
  }
}

export default PartialMesh;
