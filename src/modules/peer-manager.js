/**
 * Peer Manager module for Kademlia DHT implementation
 * Handles peer lifecycle and optimization
 */
import EventEmitter from '../event-emitter.js';
import { bufferToHex } from '../utils.js';

export class PeerManager extends EventEmitter {
  /**
   * Create a new peer manager
   * @param {Object} options - Options
   */
  constructor(options = {}) {
    super();
    
    this.debug = options.debug || false;
    this.maxPeers = options.maxPeers || Infinity;
    this.nodeId = options.nodeId; // Local node ID
    
    // Peer tracking
    this.peers = new Map(); // peerId -> Peer object
    
    // DHT capability tracking
    this.dhtCapablePeers = new Map(); // peerId -> {successCount, lastSuccess, routes: Set()}
    this.dhtRoutes = new Map(); // targetId -> Set(routePeerId)
    this.dhtReadiness = false;
    this.dhtReadinessTimestamp = 0;
    this.DHT_SIGNAL_THRESHOLD = options.dhtSignalThreshold || 2;
  }

  /**
   * Set the local node ID
   * @param {string|Buffer} nodeId - Local node ID
   */
  setNodeId(nodeId) {
    this.nodeId = nodeId;
    this.nodeIdHex = typeof nodeId === 'string' ? nodeId : bufferToHex(nodeId);
  }

  /**
   * Register a peer with the manager
   * @param {Object} peer - Peer object
   * @param {string} peerId - Peer ID
   * @returns {boolean} True if peer was registered
   */
  registerPeer(peer, peerId) {
    // Don't allow self-connections
    if (peerId === this.nodeIdHex) return false;
    
    // Check if we're already tracking this peer
    if (this.peers.has(peerId)) return false;
    
    // Check if we've hit max peers
    if (this.peers.size >= this.maxPeers) {
      // Attempt to make room for the new peer
      if (!this._makeRoomForPeer(peerId)) {
        return false; // Couldn't make room
      }
    }
    
    // Register the peer
    this.peers.set(peerId, peer);
    
    // Set up event handlers
    peer.on('connect', () => {
      if (this.debug) console.debug(`[PeerManager] Peer ${peerId.substring(0, 8)}... connected`);
      this._handlePeerConnect(peerId);
    });
    
    peer.on('close', () => {
      if (this.debug) console.debug(`[PeerManager] Peer ${peerId.substring(0, 8)}... disconnected`);
      this._handlePeerDisconnect(peerId);
    });
    
    peer.on('error', (err) => {
      if (this.debug) console.debug(`[PeerManager] Peer ${peerId.substring(0, 8)}... error:`, err.message);
    });
    
    return true;
  }

  /**
   * Disconnect a peer
   * @param {string} peerId - Peer ID to disconnect
   */
  disconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    // Destroy the peer connection
    peer.destroy();
    
    // Remove from our tracking
    this.peers.delete(peerId);
    
    // Clean up DHT tracking
    this.dhtCapablePeers.delete(peerId);
    
    // Clean up any DHT routes
    for (const [targetId, routes] of this.dhtRoutes.entries()) {
      routes.delete(peerId);
      if (routes.size === 0) {
        this.dhtRoutes.delete(targetId);
      }
    }
    
    // Emit disconnection event
    this.emit('peer:disconnect', peerId);
    
    // Update DHT readiness
    this._updateDHTReadiness();
  }

  /**
   * Get a peer by ID
   * @param {string} peerId - Peer ID
   * @returns {Object|null} Peer object or null if not found
   */
  getPeer(peerId) {
    return this.peers.get(peerId) || null;
  }

  /**
   * Get all peer IDs
   * @param {Function} filter - Optional filter function
   * @returns {Array} Array of peer IDs
   */
  getPeerIds(filter = null) {
    if (filter) {
      return Array.from(this.peers.entries())
        .filter(([id, peer]) => filter(id, peer))
        .map(([id]) => id);
    }
    return Array.from(this.peers.keys());
  }

  /**
   * Get all connected peer IDs
   * @returns {Array} Array of connected peer IDs
   */
  getConnectedPeerIds() {
    return this.getPeerIds((_, peer) => peer.connected);
  }

  /**
   * Get DHT-capable peer IDs
   * @returns {Array} Array of DHT-capable peer IDs
   */
  getDHTCapablePeerIds() {
    return Array.from(this.dhtCapablePeers.entries())
      .filter(([_, info]) => info.successCount >= this.DHT_SIGNAL_THRESHOLD)
      .map(([id]) => id);
  }

  /**
   * Record a successful DHT signal through a peer
   * @param {string} peerId - Peer ID
   * @param {string} targetId - Target ID
   */
  recordDHTSignalSuccess(peerId, targetId) {
    // Update DHT capable peer tracking
    if (!this.dhtCapablePeers.has(peerId)) {
      this.dhtCapablePeers.set(peerId, {
        successCount: 1,
        lastSuccess: Date.now(),
        routes: new Set([targetId])
      });
    } else {
      const info = this.dhtCapablePeers.get(peerId);
      info.successCount++;
      info.lastSuccess = Date.now();
      info.routes.add(targetId);
    }
    
    // Record DHT route
    if (!this.dhtRoutes.has(targetId)) {
      this.dhtRoutes.set(targetId, new Set([peerId]));
    } else {
      this.dhtRoutes.get(targetId).add(peerId);
    }
    
    // Update DHT readiness
    this._updateDHTReadiness();
  }

  /**
   * Get best DHT routes to a target
   * @param {string} targetId - Target ID
   * @param {number} maxRoutes - Maximum routes to return
   * @returns {Array} Array of route peer IDs
   */
  getDHTRoutes(targetId, maxRoutes = 3) {
    if (!this.dhtRoutes.has(targetId)) return [];
    
    // Get all routes for this target
    const routes = Array.from(this.dhtRoutes.get(targetId));
    
    // Filter to only include connected peers
    const connectedRoutes = routes.filter(id => {
      const peer = this.peers.get(id);
      return peer && peer.connected;
    });
    
    // Sort by success count
    connectedRoutes.sort((a, b) => {
      const infoA = this.dhtCapablePeers.get(a);
      const infoB = this.dhtCapablePeers.get(b);
      return (infoB?.successCount || 0) - (infoA?.successCount || 0);
    });
    
    return connectedRoutes.slice(0, maxRoutes);
  }

  /**
   * Check if a peer is DHT-capable
   * @param {string} peerId - Peer ID
   * @returns {boolean} True if peer is DHT-capable
   */
  isDHTCapable(peerId) {
    return this.dhtCapablePeers.has(peerId) && 
           this.dhtCapablePeers.get(peerId).successCount >= this.DHT_SIGNAL_THRESHOLD;
  }

  /**
   * Check if the local node is DHT-ready
   * @returns {boolean} True if node is DHT-ready
   */
  isDHTReady() {
    return this.dhtReadiness;
  }

  /**
   * Handle peer connection
   * @param {string} peerId - Peer ID
   * @private
   */
  _handlePeerConnect(peerId) {
    if (this.debug) console.debug(`[PeerManager] Handling peer connect for ${peerId.substring(0, 8)}...`);
    
    // Emit connection event
    this.emit('peer:connect', peerId);
    
    // Update DHT readiness check
    this._updateDHTReadiness();
  }

  /**
   * Handle peer disconnection
   * @param {string} peerId - Peer ID
   * @private
   */
  _handlePeerDisconnect(peerId) {
    this.peers.delete(peerId);
    
    // Clean up DHT tracking
    this.dhtCapablePeers.delete(peerId);
    
    // Clean up any DHT routes
    for (const [targetId, routes] of this.dhtRoutes.entries()) {
      routes.delete(peerId);
      if (routes.size === 0) {
        this.dhtRoutes.delete(targetId);
      }
    }
    
    // Emit disconnection event
    this.emit('peer:disconnect', peerId);
    
    // Update DHT readiness
    this._updateDHTReadiness();
  }

  /**
   * Try to make room for a new peer
   * @param {string} newPeerId - New peer ID
   * @returns {boolean} True if room was made
   * @private
   */
  _makeRoomForPeer(newPeerId) {
    if (this.peers.size < this.maxPeers) return true;
    
    // Find the furthest peer
    const furthestPeerId = this._findFurthestPeer();
    if (!furthestPeerId) return false;
    
    // Check if we should replace it
    if (this._shouldReplacePeer(newPeerId, furthestPeerId)) {
      this.disconnectPeer(furthestPeerId);
      return true;
    }
    
    return false;
  }

  /**
   * Find the furthest peer by XOR distance
   * @returns {string|null} Furthest peer ID or null if none
   * @private
   */
  _findFurthestPeer() {
    if (!this.nodeIdHex || this.peers.size === 0) return null;
    
    let furthestPeer = null;
    let maxDistance = BigInt(0);
    
    for (const peerId of this.peers.keys()) {
      const distance = this._calculateDistance(this.nodeIdHex, peerId);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthestPeer = peerId;
      }
    }
    
    return furthestPeer;
  }

  /**
   * Calculate XOR distance between two node IDs
   * @param {string} nodeId1 - First node ID
   * @param {string} nodeId2 - Second node ID
   * @returns {BigInt} XOR distance
   * @private
   */
  _calculateDistance(nodeId1, nodeId2) {
    return BigInt(`0x${nodeId1}`) ^ BigInt(`0x${nodeId2}`);
  }

  /**
   * Determine if a new peer should replace an existing one
   * @param {string} newPeerId - New peer ID
   * @param {string} existingPeerId - Existing peer ID
   * @returns {boolean} True if new peer should replace existing
   * @private
   */
  _shouldReplacePeer(newPeerId, existingPeerId) {
    // Check if the existing peer is DHT-capable
    const isExistingPeerDhtCapable = this.isDHTCapable(existingPeerId);
    
    // Never replace DHT-capable peers
    if (isExistingPeerDhtCapable) return false;
    
    // Compare distances
    const newDistance = this._calculateDistance(this.nodeIdHex, newPeerId);
    const existingDistance = this._calculateDistance(this.nodeIdHex, existingPeerId);
    
    return newDistance < existingDistance;
  }

  /**
   * Update DHT readiness status
   * @private
   */
  _updateDHTReadiness() {
    // Count DHT-capable peers
    const dhtCapablePeerCount = this.getDHTCapablePeerIds().length;
    
    const wasReady = this.dhtReadiness;
    
    // Update DHT readiness based on number of DHT-capable peers
    this.dhtReadiness = dhtCapablePeerCount >= 2;
    
    // If readiness changed, emit event
    if (this.dhtReadiness !== wasReady) {
      this.dhtReadinessTimestamp = Date.now();
      this.emit('dht:ready', this.dhtReadiness);
    }
  }
}