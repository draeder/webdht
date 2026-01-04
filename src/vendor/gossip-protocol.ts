export type GossipProtocolOptions = {
  maxHops?: number;
  directRetryIntervalMs?: number;
  directRetryCount?: number;
};

export type GossipMessage = {
  id: string;
  timestamp: number;
  hops: number;
  maxHops: number;
  sender: string | null;
  data: unknown;
  metadata: Record<string, unknown>;
  type: 'gossip';
};

export type GossipDirectMetadata = {
  kind: 'direct';
  target: string;
};

export type GossipStats = {
  totalMessagesTracked: number;
  recentMessages: Array<{
    id: string;
    timestamp: number;
    sender: string | null;
    hops: number;
    age: number;
  }>;
  connectedPeers: number;
  discoveredPeers: number;
};

interface MeshLike {
  on(event: 'peer:data', handler: (data: { peerId: string; data: any }) => void): void;
  on(event: 'peer:connected' | 'peer:disconnected', handler: (peerId: string) => void): void;
  getClientId(): string | null;
  getConnectedPeers(): string[];
  getDiscoveredPeers(): string[];
  send(peerId: string, data: string | Buffer | ArrayBuffer): void;
}

type GossipEvents = {
  messageReceived: (data: { message: GossipMessage; local: boolean; fromPeer?: string }) => void;
  peerConnected: (data: { peerId: string }) => void;
  peerDisconnected: (data: { peerId: string }) => void;
};

export class GossipProtocol {
  private mesh: MeshLike;
  private messageLog: Map<string, { timestamp: number; sender: string | null; hops: number }> = new Map();
  private maxHops: number;
  private directRetryIntervalMs: number;
  private directRetryCount: number;
  private callbacks: Partial<Record<keyof GossipEvents, Set<Function>>> = {};
  private peers: Map<string, { connected: boolean; timestamp: number }> = new Map();
  private retryTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(mesh: MeshLike, options: GossipProtocolOptions = {}) {
    this.mesh = mesh;
    this.maxHops = options.maxHops ?? 5;
    this.directRetryIntervalMs = options.directRetryIntervalMs ?? 1_500;
    this.directRetryCount = options.directRetryCount ?? 10;
    this.setupMeshListeners();
  }

  private setupMeshListeners(): void {
    this.mesh.on('peer:data', ({ peerId, data }) => {
      const parsed = this.tryParseGossipMessage(data);
      if (!parsed) return;
      this.handleIncomingMessage(parsed, peerId);
    });

    this.mesh.on('peer:connected', (peerId) => {
      this.peers.set(peerId, { connected: true, timestamp: Date.now() });
      this.emit('peerConnected', { peerId });
    });

    this.mesh.on('peer:disconnected', (peerId) => {
      this.peers.delete(peerId);
      this.emit('peerDisconnected', { peerId });
    });
  }

  broadcast(data: unknown, metadata: Record<string, unknown> = {}): string {
    const sender = this.mesh.getClientId();
    const message: GossipMessage = {
      id: this.generateMessageId(sender),
      timestamp: Date.now(),
      hops: 0,
      maxHops: this.maxHops,
      sender,
      data,
      metadata,
      type: 'gossip',
    };

    this.messageLog.set(message.id, {
      timestamp: message.timestamp,
      sender: message.sender,
      hops: 0,
    });

    this.propagate(message);
    this.emit('messageReceived', { message, local: true });
    return message.id;
  }

  /**
   * Best-effort direct message delivery to a target peer using the same multi-hop
   * gossip propagation mechanism.
   *
   * Note: This will still traverse intermediate peers; recipients should filter
   * by metadata.target.
   */
  direct(targetPeerId: string, data: unknown, metadata: Record<string, unknown> = {}): string {
    const sender = this.mesh.getClientId();
    const target = (targetPeerId ?? '').trim();
    if (!target) {
      throw new Error('direct() requires a targetPeerId');
    }

    const directMeta: GossipDirectMetadata = {
      kind: 'direct',
      target,
    };

    const message: GossipMessage = {
      id: this.generateMessageId(sender),
      timestamp: Date.now(),
      hops: 0,
      maxHops: this.maxHops,
      sender,
      data,
      metadata: { ...metadata, ...directMeta },
      type: 'gossip',
    };

    this.messageLog.set(message.id, {
      timestamp: message.timestamp,
      sender: message.sender,
      hops: 0,
    });

    this.propagate(message);
    this.scheduleDirectRetries(message);
    this.emit('messageReceived', { message, local: true });
    return message.id;
  }

  private scheduleDirectRetries(message: GossipMessage): void {
    if (!this.directRetryCount || this.directRetryCount <= 0) return;
    if (!this.directRetryIntervalMs || this.directRetryIntervalMs <= 0) return;

    let remaining = this.directRetryCount;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) return;
      try {
        this.propagate(message);
      } catch {
        // best-effort
      }
      const next = setTimeout(tick, this.directRetryIntervalMs);
      this.retryTimers.add(next);
    };

    const first = setTimeout(tick, this.directRetryIntervalMs);
    this.retryTimers.add(first);
  }

  propagate(message: GossipMessage): void {
    const connectedPeers = this.mesh.getConnectedPeers();
    for (const peerId of connectedPeers) {
      if (peerId === message.sender) continue;
      const forwarded: GossipMessage = { ...message, hops: message.hops + 1 };
      try {
        this.mesh.send(peerId, JSON.stringify(forwarded));
      } catch {
        // best-effort
      }
    }
  }

  handleIncomingMessage(message: GossipMessage, fromPeerId: string): void {
    const alreadySeen = this.messageLog.has(message.id);
    if (alreadySeen) return;

    this.messageLog.set(message.id, {
      timestamp: Date.now(),
      sender: message.sender,
      hops: message.hops,
    });

    this.emit('messageReceived', { message, local: false, fromPeer: fromPeerId });
    if (message.hops < message.maxHops) {
      this.propagate(message);
    }
  }

  getStats(): GossipStats {
    const now = Date.now();
    const messages = Array.from(this.messageLog.entries()).map(([id, info]) => ({
      id,
      timestamp: info.timestamp,
      sender: info.sender,
      hops: info.hops,
      age: now - info.timestamp,
    }));

    return {
      totalMessagesTracked: this.messageLog.size,
      recentMessages: messages.filter((m) => m.age < 60_000),
      connectedPeers: this.mesh.getConnectedPeers().length,
      discoveredPeers: this.mesh.getDiscoveredPeers().length,
    };
  }

  cleanup(maxAgeMs: number = 10 * 60_000): void {
    const now = Date.now();
    for (const [id, info] of this.messageLog.entries()) {
      if (now - info.timestamp > maxAgeMs) {
        this.messageLog.delete(id);
      }
    }
  }

  on<K extends keyof GossipEvents>(event: K, callback: GossipEvents[K]): void {
    const existing = this.callbacks[event];
    if (existing) {
      existing.add(callback);
      return;
    }
    this.callbacks[event] = new Set([callback]);
  }

  off<K extends keyof GossipEvents>(event: K, callback: GossipEvents[K]): void {
    const existing = this.callbacks[event];
    if (!existing) return;
    existing.delete(callback);
  }

  destroy(): void {
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.messageLog.clear();
    this.peers.clear();
    this.callbacks = {};
  }

  private emit<K extends keyof GossipEvents>(event: K, data: Parameters<GossipEvents[K]>[0]): void {
    const cbs = this.callbacks[event];
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        (cb as any)(data);
      } catch {
        // ignore
      }
    }
  }

  private tryParseGossipMessage(raw: any): GossipMessage | null {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw && typeof raw.toString === 'function') {
      text = raw.toString();
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(raw));
    } else if (raw && raw.buffer instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw);
    } else {
      return null;
    }

    try {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.type !== 'gossip' || typeof parsed.id !== 'string') return null;
      return parsed as GossipMessage;
    } catch {
      return null;
    }
  }

  private generateMessageId(sender: string | null): string {
    const safeSender = (sender ?? 'unknown').toString();
    return `${safeSender}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

