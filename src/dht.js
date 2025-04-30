/**
 * Kademlia DHT implementation
 */
import EventEmitter from "./event-emitter.js";
import Peer from "./peer.js";
import {
  sha1,
  toBuffer,
  toBufferObject,
  distance,
  compareBuffers,
  getBit,
  commonPrefixLength,
  generateRandomID,
  bufferToHex,
  hexToBuffer,
  Buffer,
} from "./utils.js";
import Logger from './logger.js';

// Default Kademlia constants
const DEFAULT_K = 20; // Default size of k-buckets
const DEFAULT_ALPHA = 3; // Default concurrency parameter for iterative lookups
const DEFAULT_BUCKET_COUNT = 160; // Default number of k-buckets (SHA1 is 160 bits)
const DEFAULT_MAX_STORE_SIZE = 1000; // Default maximum number of key-value pairs to store
const DEFAULT_REPLICATE_INTERVAL = 3600000; // Default replication interval (1 hour)
const DEFAULT_REPUBLISH_INTERVAL = 86400000; // Default republication interval (24 hours)
const DEFAULT_MAX_KEY_SIZE = 1024; // Default maximum size of key in bytes (1KB)
const DEFAULT_MAX_VALUE_SIZE = 64000; // Default maximum size of value in bytes (64KB)

/**
 * K-bucket implementation
 */
class KBucket {
  constructor(
    localNodeId,
    prefix = "",
    prefixLength = 0,
    debug = false,
    k = DEFAULT_K
  ) {
    this.localNodeId = localNodeId;
    this.prefix = prefix;
    this.prefixLength = prefixLength;
    this.nodes = [];
    this.debug = debug;
    this.K = k; // Use provided k value
    this.BUCKET_COUNT = DEFAULT_BUCKET_COUNT; // Add this line to fix the issue
    this.left = null; // 0 bucket after split
    this.right = null; // 1 bucket after split
  }

  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug) {
      // Create a prefix with the class name and the first few characters of the local node ID
      const prefix = this.localNodeId ?
        `[KBucket:${typeof this.localNodeId === 'string' ?
          this.localNodeId.substring(0, 4) :
          bufferToHex(this.localNodeId).substring(0, 4)}]` :
        '[KBucket:init]';
      
      // Format args to include the prefix
      console.debug(prefix, ...args);
    }
  }

  /**
   * Add a node to the bucket
   * @param {Object} node - Node to add
   * @return {boolean} True if node was added
   */
  add(node) {
    // Always compare IDs as hex strings for consistency
    const nodeIdHex =
      typeof node.id === "string" ? node.id : bufferToHex(node.id);
    const localNodeIdHex =
      typeof this.localNodeId === "string"
        ? this.localNodeId
        : bufferToHex(this.localNodeId);

    // Don't add ourselves
    if (nodeIdHex === localNodeIdHex) {
      this._logDebug("Attempted to add self, skipping:", nodeIdHex);
      return false;
    }

    // If we're split, delegate to the appropriate child bucket
    if (this.left && this.right) {
      const bit = getBit(hexToBuffer(nodeIdHex), this.prefixLength);
      return bit ? this.right.add(node) : this.left.add(node);
    }

    // Check if node already exists
    const nodeIndex = this.nodes.findIndex((n) => {
      const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
      return nIdHex === nodeIdHex;
    });

    if (nodeIndex >= 0) {
      // Move existing node to the end (most recently seen)
      const existingNode = this.nodes[nodeIndex];
      this.nodes.splice(nodeIndex, 1);
      this.nodes.push(existingNode);
      return false;
    }

    // If bucket not full, add the node
    if (this.nodes.length < this.K) {
      // Use instance K value instead of constant
      this.nodes.push({ ...node, id: nodeIdHex });
      return true;
    }

    // Bucket is full, try to split if we haven't reached max depth
    if (this.prefixLength < this.BUCKET_COUNT - 1) {
      this._split();
      // After splitting, try to add again
      return this.add(node);
    }

    // Bucket is full and can't split further
    return false;
  }

  /**
   * Split the bucket into two child buckets
   * @private
   */
  _split() {
    if (this.left || this.right) return; // Already split

    this.left = new KBucket(
      this.localNodeId,
      this.prefix + "0",
      this.prefixLength + 1,
      this.debug,
      this.K, // Pass K value to child buckets
      this.BUCKET_COUNT // Pass BUCKET_COUNT to child buckets
    );

    this.right = new KBucket(
      this.localNodeId,
      this.prefix + "1",
      this.prefixLength + 1,
      this.debug,
      this.K, // Pass K value to child buckets
      this.BUCKET_COUNT // Pass BUCKET_COUNT to child buckets
    );

    // Redistribute existing nodes
    for (const node of this.nodes) {
      const bit = getBit(hexToBuffer(node.id), this.prefixLength);
      if (bit) {
        this.right.add(node);
      } else {
        this.left.add(node);
      }
    }

    // Clear nodes from this bucket since they're now in children
    this.nodes = [];
  }

  /**
   * Get closest nodes to the target ID
   * @param {Buffer} targetId - Target node ID
   * @param {number} count - Maximum number of nodes to return
   * @return {Array} Array of closest nodes
   */
  getClosestNodes(targetId, count = null) {
    // Make count parameter optional
    const k = count || this.K; // Use provided count or instance K value
    if (this.left && this.right) {
      // If split, get nodes from appropriate child bucket
      const bit = getBit(targetId, this.prefixLength);
      const first = bit ? this.right : this.left;
      const second = bit ? this.left : this.right;

      let nodes = first.getClosestNodes(targetId, k);
      if (nodes.length < k) {
        nodes = nodes.concat(
          second.getClosestNodes(targetId, k - nodes.length)
        );
      }
      return nodes;
    }

    // If not split, return nodes from this bucket
    const seen = new Set();
    return this.nodes
      .filter((n) => {
        const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
        if (seen.has(nIdHex)) return false;
        seen.add(nIdHex);
        return true;
      })
      .sort((a, b) => {
        const distA = distance(a.id, targetId);
        const distB = distance(b.id, targetId);
        return compareBuffers(distA, distB);
      })
      .slice(0, count);
  }

  /**
   * Remove a node from the bucket
   * @param {Buffer|string} nodeId - ID of node to remove
   * @return {boolean} True if node was removed
   */
  remove(nodeId) {
    const nodeIdHex = typeof nodeId === "string" ? nodeId : bufferToHex(nodeId);

    // If split, delegate to appropriate child
    if (this.left && this.right) {
      const bit = getBit(hexToBuffer(nodeIdHex), this.prefixLength);
      return bit ? this.right.remove(nodeId) : this.left.remove(nodeId);
    }

    const nodeIndex = this.nodes.findIndex((n) => {
      const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
      return nIdHex === nodeIdHex;
    });

    if (nodeIndex >= 0) {
      this.nodes.splice(nodeIndex, 1);
      this._logDebug("Removed node:", nodeIdHex);
      return true;
    }
    return false;
  }
}

/**
 * Main DHT implementation
 */
class DHT extends EventEmitter {
  /**
   * Create a new DHT node
   * @param {Object} options - DHT options
   * @param {Buffer|string} options.nodeId - Node ID (optional, random if not provided)
   * @param {Array} options.bootstrap - Bootstrap nodes (optional)
   */

  /**
   * Disconnect from a peer
   * @param {string} peerId - ID of peer to disconnect
   */
  disconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      // Clean up peer connection
      peer.destroy();
      this.peers.delete(peerId);

      // Remove from routing table
      for (let i = 0; i < this.BUCKET_COUNT; i++) {
        this.buckets[i].remove(peerId);
      }

      // Clean up any stored data for this peer
      for (const [key, value] of this.storage.entries()) {
        if (value.replicatedTo && value.replicatedTo.has(peerId)) {
          value.replicatedTo.delete(peerId);
        }
      }
    }
    // Always emit disconnect event, even if peer wasn't found
    this.emit("peer:disconnect", peerId, "disconnected");
  }
  constructor(options = {}) {
    super();
    options = { ...options.dhtOptions }
    // Initialize Kademlia parameters with defaults or user-provided values
    console.log("🥰", "DHT options", options)
    this.K = options.k || DEFAULT_K;
    this.ALPHA = options.alpha || DEFAULT_ALPHA;
    this.BUCKET_COUNT = options.bucketCount || DEFAULT_BUCKET_COUNT;
    this.MAX_STORE_SIZE = options.maxStoreSize || DEFAULT_MAX_STORE_SIZE;
    this.REPLICATE_INTERVAL =
      options.replicateInterval || DEFAULT_REPLICATE_INTERVAL;
    this.REPUBLISH_INTERVAL =
      options.republishInterval || DEFAULT_REPUBLISH_INTERVAL;
    this.MAX_KEY_SIZE = options.maxKeySize || DEFAULT_MAX_KEY_SIZE;
    this.MAX_VALUE_SIZE = options.maxValueSize || DEFAULT_MAX_VALUE_SIZE;
    
    // DHT signaling optimization parameters
    this.DHT_SIGNAL_THRESHOLD = options.dhtSignalThreshold || 2; // Reduced from 3 to 2
    this.DHT_ROUTE_REFRESH_INTERVAL = options.dhtRouteRefreshInterval || 15000; // Reduced from 30s to 15s
    this.AGGRESSIVE_DISCOVERY = true; // Always enable aggressive discovery
    this.TIERED_ROUTING = options.tieredRouting !== false; // Enable tiered routing by default
    
    // Add diagnostic counters
    this._dhtSignalAttempts = 0;
    this._serverSignalAttempts = 0;
    
    // Use async function and emit 'ready' event when done
    this._initialize(options);
  }

  /**
   * Initialize the DHT node asynchronously
   * @private
   */
  async _initialize(options) {
    try {
      this.debug = !!options.debug;
      this.maxPeers =
        typeof options.maxPeers === "number" && options.maxPeers > 0
          ? options.maxPeers
          : Infinity;

      // Initialize logger
      this.logger = new Logger("DHT");

      // Store simple-peer options to pass to new peer connections
      this.simplePeerOptions = options.simplePeerOptions || {};

      // Initialize node ID first
      this.nodeId = options.nodeId || (await generateRandomID());
      this.nodeIdHex = this.nodeId;

      this._logDebug("Initializing DHT with options:", {
        ...options,
        maxPeers: this.maxPeers,
        k: this.K,
        alpha: this.ALPHA,
        bucketCount: this.BUCKET_COUNT,
        maxStoreSize: this.MAX_STORE_SIZE,
        maxKeySize: this.MAX_KEY_SIZE,
        maxValueSize: this.MAX_VALUE_SIZE,
        dhtSignalThreshold: this.DHT_SIGNAL_THRESHOLD,
        dhtRouteRefreshInterval: this.DHT_ROUTE_REFRESH_INTERVAL,
        aggressiveDiscovery: this.AGGRESSIVE_DISCOVERY,
        tieredRouting: this.TIERED_ROUTING
      });

      // Initialize routing table (k-buckets) with configured K value
      this.buckets = Array(this.BUCKET_COUNT)
        .fill()
        .map(() => new KBucket(this.nodeId, "", 0, this.debug, this.K));

      // Initialize storage
      this.storage = new Map();
      this.storageTimestamps = new Map();

      // Initialize peer connections
      this.peers = new Map();
      
      // Track DHT signaling capabilities
      this.dhtCapablePeers = new Map(); // peerId -> {successCount, lastSuccess, routes: Set()}
      this.dhtRoutes = new Map(); // targetId -> Set(routePeerId)
      this.dhtReadiness = false; // Whether this node is ready for DHT signaling
      this.dhtReadinessTimestamp = 0; // When this node became DHT-ready

      // Message handlers
      this.messageHandlers = {
        PING: this._handlePing.bind(this),
        FIND_NODE: this._handleFindNode.bind(this),
        FIND_VALUE: this._handleFindValue.bind(this),
        STORE: this._handleStore.bind(this),
        SIGNAL: this._handleSignal.bind(this),
      };

      // Bootstrap if nodes provided
      if (
        options.bootstrap &&
        Array.isArray(options.bootstrap) &&
        options.bootstrap.length > 0
      ) {
        this._bootstrap(options.bootstrap);
      }

      // Setup maintenance intervals
      this._setupMaintenance();

      // Log node creation with maxPeers info
      this.logger.info(
        `Node created with ID: ${this.nodeIdHex}, maxPeers: ${this.maxPeers}`
      );

      // Emit ready event with the node ID
      this.emit("ready", this.nodeIdHex);
      
      // Start periodic DHT route refresh
      this._setupDHTRouteRefresh();
    } catch (error) {
      this._logDebug("Error initializing DHT node:", error);
      this.emit("error", error);
    }
  }

  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug && this.logger?.debug) {
      // Ensure nodeIdHex exists before trying to use substring
      const prefix = this.nodeIdHex ? this.nodeIdHex.substring(0, 4) : "init";
      
      // Format args to include the node ID prefix at the beginning
      const formattedArgs = [`[${prefix}]`, ...args];
      
      // Use the Logger instance only when this.debug is true
      this.logger.debug(...formattedArgs);
    }
  }

  /**
   * Setup periodic maintenance tasks
   * @private
   */
  _setupMaintenance() {
    // Replicate data to other nodes
    this.replicateInterval = setInterval(() => {
      this._replicateData();
    }, this.REPLICATE_INTERVAL);

    // Republish data
    this.republishInterval = setInterval(() => {
      this._republishData();
    }, this.REPUBLISH_INTERVAL);
    
    // Check DHT readiness periodically
    setInterval(() => {
      this._updateDHTReadiness();
    }, 10000); // Check every 10 seconds
  }
  
  /**
   * Update DHT readiness status based on connected DHT-capable peers
   * @private
   */
  _updateDHTReadiness() {
    // Skip if we checked recently
    const now = Date.now();
    if (now - this.dhtReadinessTimestamp < 5000) return; // Don't check more than once every 5 seconds
    
    // Count DHT-capable peers (peers that have successfully used DHT signaling)
    const dhtCapablePeerCount = Array.from(this.dhtCapablePeers.values())
      .filter(info => info.successCount >= this.DHT_SIGNAL_THRESHOLD)
      .length;
    
    const wasReady = this.dhtReadiness;
    
    // Update DHT readiness based on number of DHT-capable peers
    // Reduce threshold from 3 to 2 to make nodes DHT-ready sooner
    this.dhtReadiness = dhtCapablePeerCount >= 2;
    
    // Log state change
    if (this.dhtReadiness !== wasReady) {
      this.dhtReadinessTimestamp = now;
      if (this.dhtReadiness) {
        this._logDebug(`Node is now DHT-ready with ${dhtCapablePeerCount} DHT-capable peers`);
        this.emit('dht:ready', true);
      } else {
        this._logDebug(`Node is no longer DHT-ready, only ${dhtCapablePeerCount} DHT-capable peers`);
        this.emit('dht:ready', false);
      }
    }
  }
  
  /**
   * Set up periodic DHT route refresh to maintain optimal routing paths
   * @private
   */
  _setupDHTRouteRefresh() {
    // Periodically refresh DHT routes to ensure optimal paths
    this.dhtRouteRefreshInterval = setInterval(() => {
      this._refreshDHTRoutes();
    }, this.DHT_ROUTE_REFRESH_INTERVAL);
  }
  
  /**
   * Refresh DHT routes by testing and establishing new routes
   * @private
   */
  async _refreshDHTRoutes() {
    if (this.peers.size < 2) return; // Need at least 2 peers for routing
    
    this._logDebug("Refreshing DHT routes...");
    
    // Get all connected peers
    const connectedPeers = Array.from(this.peers.entries())
      .filter(([_, peer]) => peer.connected)
      .map(([peerId, _]) => peerId);
    
    if (connectedPeers.length < 2) return;
    
    // Prioritize DHT-capable peers for route establishment
    const dhtCapablePeerIds = Array.from(this.dhtCapablePeers.keys())
      .filter(id => this.peers.has(id) && this.peers.get(id).connected);
    
    // Prioritize peers with more connections for tiered routing
    const peerConnectionCounts = new Map();
    
    // Count connections for each peer
    for (const peerId of connectedPeers) {
      let connectionCount = 0;
      
      // Count direct connections
      if (this.peers.has(peerId) && this.peers.get(peerId).connected) {
        connectionCount++;
      }
      
      // Count DHT routes
      if (this.dhtRoutes.has(peerId)) {
        connectionCount += this.dhtRoutes.get(peerId).size;
      }
      
      peerConnectionCounts.set(peerId, connectionCount);
    }
    
    // Sort peers by connection count (descending) for tiered routing
    const sortedPeers = [...connectedPeers].sort((a, b) => {
      const countA = peerConnectionCounts.get(a) || 0;
      const countB = peerConnectionCounts.get(b) || 0;
      return countB - countA; // Descending order
    });
    
    // For each pair of peers, try to establish a route if one doesn't exist
    // Prioritize routes between DHT-capable peers
    for (let i = 0; i < sortedPeers.length; i++) {
      const peerA = sortedPeers[i];
      const isPeerADhtCapable = dhtCapablePeerIds.includes(peerA);
      
      for (let j = i + 1; j < sortedPeers.length; j++) {
        const peerB = sortedPeers[j];
        const isPeerBDhtCapable = dhtCapablePeerIds.includes(peerB);
        
        // Prioritize routes between DHT-capable peers
        // Always try to establish routes between peers, even if they're not DHT-capable
        // This helps increase DHT signaling by creating more potential routes
        if (!isPeerADhtCapable && !isPeerBDhtCapable && !this.AGGRESSIVE_DISCOVERY) {
          // Don't skip non-DHT-capable peer pairs anymore
          this._logDebug(`Attempting route between non-DHT-capable peers ${peerA.substring(0, 8)}... and ${peerB.substring(0, 8)}...`);
        }
        
        // Check if we already have a route between these peers
        const routeExists =
          (this.dhtRoutes.has(peerA) && this.dhtRoutes.get(peerA).has(peerB)) ||
          (this.dhtRoutes.has(peerB) && this.dhtRoutes.get(peerB).has(peerA));
        
        if (!routeExists) {
          // Try to establish a route between these peers
          this._logDebug(`Attempting to establish DHT route between ${peerA.substring(0, 8)}... and ${peerB.substring(0, 8)}...`);
          
          // Choose which peer to route through based on connection count (tiered approach)
          const routeFromA = peerConnectionCounts.get(peerA) >= peerConnectionCounts.get(peerB);
          
          if (routeFromA) {
            // Route from A to B
            const peerAObj = this.peers.get(peerA);
            if (peerAObj && peerAObj.connected) {
              peerAObj.send({
                type: "SIGNAL",
                sender: this.nodeIdHex,
                originalSender: this.nodeIdHex,
                signal: { type: "ROUTE_TEST", timestamp: Date.now() },
                target: peerB,
                ttl: 3,
                viaDht: true,
                signalPath: [this.nodeIdHex]
              });
            }
          } else {
            // Route from B to A
            const peerBObj = this.peers.get(peerB);
            if (peerBObj && peerBObj.connected) {
              peerBObj.send({
                type: "SIGNAL",
                sender: this.nodeIdHex,
                originalSender: this.nodeIdHex,
                signal: { type: "ROUTE_TEST", timestamp: Date.now() },
                target: peerA,
                ttl: 3,
                viaDht: true,
                signalPath: [this.nodeIdHex]
              });
            }
          }
        }
      }
    }
    
    // Log current DHT routes
    this._logDebug("Current DHT routes:");
    for (const [targetId, routes] of this.dhtRoutes.entries()) {
      this._logDebug(`- To ${targetId.substring(0, 8)}...: ${Array.from(routes).map(id => id.substring(0, 8) + '...').join(', ')}`);
    }
  }
  
  /**
   * Update DHT readiness status based on successful DHT signals
   * @private
   */
  // This is a duplicate method - removing it as it's already defined above

  /**
   * Get the appropriate bucket index for a node ID
   * @param {Buffer} nodeId - Node ID
   * @return {number} Bucket index
   * @private
   */
  _getBucketIndex(nodeId) {
    const prefixLength = commonPrefixLength(this.nodeId, nodeId);
    return Math.min(prefixLength, this.BUCKET_COUNT - 1);
  }

  /**
   * Add a node to the routing table
   * @param {Object} node - Node to add
   * @return {boolean} True if node was added
   * @private
   */
  _addNode(node) {
    if (!node || !node.id) return false;

    const bucketIndex = this._getBucketIndex(node.id);
    return this.buckets[bucketIndex].add(node);
  }

  /**
   * Bootstrap the DHT with known nodes
   * @param {Array} nodes - Bootstrap nodes
   * @private
   */
  _bootstrap(nodes) {
    this.logger.info(`Bootstrapping DHT with ${nodes.length} nodes...`);

    // Connect to bootstrap nodes
    nodes.forEach((node) => {
      this.connect(node);
    });

    // Find nodes close to ourself to populate routing table
    setTimeout(() => {
      this.findNode(this.nodeId);
    }, 1000);
  }

  /**
   * Connect to a peer
   * @param {Object} peerInfo - Peer information
   * @param {string|Buffer} peerInfo.id - Peer ID
   * @param {Object} peerInfo.signal - Signaling data (optional)
   * @return {Peer} Peer instance
   */
  /**
   * Calculate XOR distance between two node IDs
   * @private
   */
  _calculateDistance(nodeId1, nodeId2) {
    const id1 = typeof nodeId1 === "string" ? nodeId1 : bufferToHex(nodeId1);
    const id2 = typeof nodeId2 === "string" ? nodeId2 : bufferToHex(nodeId2);
    return BigInt(`0x${id1}`) ^ BigInt(`0x${id2}`);
  }

  /**
   * Evaluate if a new peer should replace an existing one based on XOR distance
   * @private
   */
  _shouldReplacePeer(newPeerId, existingPeerId) {
    // Check if the new peer is DHT-capable
    const isNewPeerDhtCapable = this.dhtCapablePeers.has(newPeerId) &&
                               this.dhtCapablePeers.get(newPeerId).successCount >= this.DHT_SIGNAL_THRESHOLD;
    
    // Check if the existing peer is DHT-capable
    const isExistingPeerDhtCapable = this.dhtCapablePeers.has(existingPeerId) &&
                                    this.dhtCapablePeers.get(existingPeerId).successCount >= this.DHT_SIGNAL_THRESHOLD;
    
    // If one is DHT-capable and the other isn't, prioritize the DHT-capable one
    if (isNewPeerDhtCapable && !isExistingPeerDhtCapable) {
      return true; // Replace non-DHT-capable peer with DHT-capable one
    }
    
    if (!isNewPeerDhtCapable && isExistingPeerDhtCapable) {
      return false; // Don't replace DHT-capable peer with non-DHT-capable one
    }
    
    // If both are DHT-capable or both are not, fall back to distance comparison
    const newDistance = this._calculateDistance(this.nodeIdHex, newPeerId);
    const existingDistance = this._calculateDistance(
      this.nodeIdHex,
      existingPeerId
    );
    return newDistance < existingDistance;
  }

  /**
   * Find the furthest peer in our current peer set
   * @private
   */
  _findFurthestPeer() {
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
   * Attempt to replace a less optimal peer with a new one
   * @private
   */
  async _rebalancePeers(newPeerId) {
    const furthestPeerId = this._findFurthestPeer();

    if (!furthestPeerId) return false;

    if (this._shouldReplacePeer(newPeerId, furthestPeerId)) {
      this._logDebug(
        `Replacing further peer ${furthestPeerId} with closer peer ${newPeerId}`
      );

      // Disconnect the further peer
      const oldPeer = this.peers.get(furthestPeerId);
      if (oldPeer) {
        oldPeer.destroy();
        this.peers.delete(furthestPeerId);
        this.emit("peer:disconnect", furthestPeerId, "replaced");
      }

      return true; // Allow the new connection
    }

    return false; // Keep existing peers
  }

  /**
   * Connect to a peer
   * @param {Object} peerInfo - Peer information
   * @param {string|Buffer} peerInfo.id - Peer ID
   * @param {Object} peerInfo.signal - Signaling data (optional)
   * @return {Peer|null} Peer instance or null if connection not allowed
   */
  async connect(peerInfo) {
    if (!peerInfo || !peerInfo.id) {
      throw new Error("Invalid peer info");
    }

    const peerId =
      typeof peerInfo.id === "string" ? peerInfo.id : bufferToHex(peerInfo.id);

    // Don't connect to self
    if (peerId === this.nodeIdHex) {
      throw new Error("Cannot connect to self");
    }

    // Check if we're already connected
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId);
    }

    // Check if we've reached max peers
    if (this.peers.size >= this.maxPeers) {
      // Find the furthest peer to potentially replace
      const furthestPeer = this._findFurthestPeer();
      if (furthestPeer && this._shouldReplacePeer(peerId, furthestPeer)) {
        // Disconnect the furthest peer
        this.disconnect(furthestPeer);
      } else {
        throw new Error(
          "Max peers reached and new peer not closer than existing peers"
        );
      }
    }

    // Extract WebRTC-specific options
    const {
      initiator = true,
      reconnectTimer,
      iceCompleteTimeout,
      retries,
      simplePeerOptions: peerSpecificOptions
    } = peerInfo;

    // Merge the simple-peer options with any peer-specific options
    const mergedOptions = {
      ...this.simplePeerOptions,
      ...(peerSpecificOptions || {})
    };

    // Create new peer connection with merged options
    const peer = new Peer({
      nodeId: this.nodeId,
      peerId: peerId,
      initiator: initiator,
      signal: peerInfo.signal,
      reconnectTimer: reconnectTimer,
      iceCompleteTimeout: iceCompleteTimeout,
      retries: retries,
      ...mergedOptions, // Merge in the simple-peer options
    });

    this.peers.set(peerId, peer);
    this._setupPeerHandlers(peer);

    // Add to routing table
    this._addNode({ id: peerId });

    // Replicate relevant key-value pairs to the new peer if it is now among the K closest for any key
    this._replicateToNewPeer(peerId);

    // After establishing connection, try to discover more peers through this new peer
    peer.once("connect", async () => {
      this._logDebug(`Connected to new peer ${peerId.substring(0, 8)}..., discovering more peers`);
      
      // If we have other peers, try to establish DHT routes between this new peer and existing peers
      // But limit to only one direction to reduce signaling traffic
      if (this.peers.size > 1) {
        this._logDebug(`Establishing DHT routes for new peer ${peerId.substring(0, 8)}...`);
        
        // For each existing peer (except the new one), try to establish a DHT route to the new peer
        // Establish routes to more peers to improve DHT connectivity
        const existingPeerEntries = Array.from(this.peers.entries())
          .filter(([existingPeerId, existingPeer]) =>
            existingPeerId !== peerId && existingPeer.connected);
        
        // Increase the number of peers to establish routes with to improve DHT connectivity
        // Use all available peers instead of just 3
        const peersToRoute = existingPeerEntries;
        
        for (const [existingPeerId, existingPeer] of peersToRoute) {
          this._logDebug(`Establishing DHT route between ${existingPeerId.substring(0, 8)}... and ${peerId.substring(0, 8)}...`);
          
          // Only establish route in one direction to reduce signaling traffic
          // The reverse route will be established when needed
          this._routeSignalThroughDHT(existingPeerId, peerId, { type: "PING" }, 2, [this.nodeIdHex]);
        }
      }
      
      // Wait a short time to ensure the connection is stable
      setTimeout(async () => {
        try {
          // Try to discover more peers through the DHT, but limit the number
          const discoveredPeers = await this.discoverPeers(Math.min(3, this.K));
          
          if (discoveredPeers.length > 0) {
            this._logDebug(`Discovered ${discoveredPeers.length} additional peers through DHT after connecting to ${peerId.substring(0, 8)}...`);
            
            // Connect to more discovered peers to improve DHT connectivity
            for (let i = 0; i < Math.min(3, discoveredPeers.length); i++) {
              const discoveredPeerId = discoveredPeers[i];
              
              // Skip if we're already connected
              if (this.peers.has(discoveredPeerId) || discoveredPeerId === this.nodeIdHex) {
                continue;
              }
              
              this._logDebug(`Connecting to discovered peer: ${discoveredPeerId.substring(0, 8)}...`);
              try {
                await this.connect({ id: discoveredPeerId });
              } catch (err) {
                this._logDebug(`Failed to connect to discovered peer ${discoveredPeerId.substring(0, 8)}...: ${err.message}`);
              }
            }
          }
        } catch (err) {
          this._logDebug(`Error during peer discovery after connecting to ${peerId.substring(0, 8)}...: ${err.message}`);
        }
      }, 2000);
    });

    return peer;
  }

  /**
   * Set up event handlers for a peer
   * @param {Peer} peer - Peer instance
   * @private
   */
  _setupPeerHandlers(peer) {
    // Forward signal events
    peer.on("signal", (data, peerId) => {
      // Detect WebRTC signaling messages
      const isWebRTCSignal = data && (data.type === 'offer' || data.type === 'answer' || data.candidate);
      
      // For WebRTC signaling, always use the server to ensure reliable connection establishment
      if (isWebRTCSignal) {
        this._logDebug(`Using server for WebRTC signal to ${peerId}`);
        this._serverSignalAttempts++;
        this._logDebug(`Signal stats - DHT: ${this._dhtSignalAttempts}, Server: ${this._serverSignalAttempts}, Ratio: ${Math.round((this._dhtSignalAttempts / (this._dhtSignalAttempts + this._serverSignalAttempts)) * 100)}%`);
        this.emit("signal", { id: peerId, signal: data, viaDht: false });
        return;
      }
      
      // Check if this is a new peer (one with no or few connections)
      const isNewPeer = this.peers.size <= 1;
      
      // Check if we're DHT-ready
      const isDHTReady = this.dhtReadiness;
      
      // New peers or non-DHT-ready peers use the server
      if (isNewPeer || !isDHTReady) {
        if (isNewPeer) {
          this._logDebug(`New peer with ${this.peers.size} connections using server for signal to ${peerId}`);
        } else {
          this._logDebug(`Node not DHT-ready yet, using server for signal to ${peerId}`);
        }
        this._serverSignalAttempts++;
        this._logDebug(`Signal stats - DHT: ${this._dhtSignalAttempts}, Server: ${this._serverSignalAttempts}, Ratio: ${Math.round((this._dhtSignalAttempts / (this._dhtSignalAttempts + this._serverSignalAttempts)) * 100)}%`);
        this.emit("signal", { id: peerId, signal: data, viaDht: false });
        return;
      }
      
      // For established and DHT-ready peers, try to use DHT routing
      try {
        // Check if we have a known route to this peer
        if (this.dhtRoutes.has(peerId) && this.dhtRoutes.get(peerId).size > 0) {
          // Use a known route
          const routes = Array.from(this.dhtRoutes.get(peerId));
          
          // Prioritize routes through DHT-capable peers
          const dhtCapableRoutes = routes.filter(routeId =>
            this.dhtCapablePeers.has(routeId) &&
            this.dhtCapablePeers.get(routeId).successCount >= this.DHT_SIGNAL_THRESHOLD
          );
          
          const routeToUse = dhtCapableRoutes.length > 0 ?
            dhtCapableRoutes[Math.floor(Math.random() * dhtCapableRoutes.length)] : // Random DHT-capable route
            routes[Math.floor(Math.random() * routes.length)]; // Random route if no DHT-capable ones
          
          const routePeer = this.peers.get(routeToUse);
          if (routePeer && routePeer.connected) {
            this._logDebug(`Using known DHT route to ${peerId.substring(0, 8)}... via ${routeToUse.substring(0, 8)}...`);
            
            routePeer.send({
              type: "SIGNAL",
              sender: this.nodeIdHex,
              originalSender: this.nodeIdHex,
              signal: data,
              target: peerId,
              ttl: 3,
              viaDht: true,
              signalPath: [this.nodeIdHex]
            });
            
            // Don't emit the signal event since we're routing through DHT
            this._dhtSignalAttempts++;
            this._logDebug(`Signal stats - DHT: ${this._dhtSignalAttempts}, Server: ${this._serverSignalAttempts}, Ratio: ${Math.round((this._dhtSignalAttempts / (this._dhtSignalAttempts + this._serverSignalAttempts)) * 100)}%`);
            return;
          }
        }
        
        // If no known route, find other peers to route through (excluding the target peer)
        const otherPeers = Array.from(this.peers.entries())
          .filter(([id, p]) => id !== peerId && p.connected);
          
        if (otherPeers.length > 0) {
          // Prioritize DHT-capable peers for routing
          const dhtCapablePeers = otherPeers.filter(([id, _]) =>
            this.dhtCapablePeers.has(id) &&
            this.dhtCapablePeers.get(id).successCount >= this.DHT_SIGNAL_THRESHOLD
          );
          
          const peersToUse = dhtCapablePeers.length > 0 ? dhtCapablePeers : otherPeers;
          
          // Take up to 3 peers with aggressive discovery, 2 otherwise
          const routingPeers = this.AGGRESSIVE_DISCOVERY ?
            peersToUse.slice(0, 3) :
            peersToUse.slice(0, 2);
          
          if (routingPeers.length > 0) {
            this._logDebug(`Routing signal to ${peerId} through DHT using ${routingPeers.length} peers`);
            
            // Try multiple routing peers for better success rate
            for (const [routePeerId, routePeer] of routingPeers) {
              this._logDebug(`Routing signal to ${peerId} via peer ${routePeerId.substring(0, 8)}...`);
              routePeer.send({
                type: "SIGNAL",
                sender: this.nodeIdHex,
                originalSender: this.nodeIdHex,
                signal: data,
                target: peerId,
                ttl: 3,
                viaDht: true,
                signalPath: [this.nodeIdHex]
              });
            }
            
            // Don't emit the signal event since we're routing through DHT
            this._dhtSignalAttempts++;
            this._logDebug(`Signal stats - DHT: ${this._dhtSignalAttempts}, Server: ${this._serverSignalAttempts}, Ratio: ${Math.round((this._dhtSignalAttempts / (this._dhtSignalAttempts + this._serverSignalAttempts)) * 100)}%`);
            return;
          }
        }
      } catch (err) {
        this._logDebug(`Error routing signal through DHT: ${err.message}`);
      }
      
      // Fall back to server only if DHT routing failed and we have no other option
      this._logDebug(`Falling back to server for signal to ${peerId} (no DHT routes available)`);
      this._serverSignalAttempts++;
      this._logDebug(`Signal stats - DHT: ${this._dhtSignalAttempts}, Server: ${this._serverSignalAttempts}, Ratio: ${Math.round((this._dhtSignalAttempts / (this._dhtSignalAttempts + this._serverSignalAttempts)) * 100)}%`);
      this.emit("signal", { id: peerId, signal: data, viaDht: false });
    });
    
    // Handle successful connection
    peer.on("connect", (peerId) => {
      this._logDebug(`Connected to peer: ${peerId}`);
      // Add node to routing table
      this._addNode({
        id: hexToBuffer(peerId),
        host: null,
        port: null,
      });
      this.emit("peer:connect", peerId);
      // Send a PING to the peer
      peer.send({
        type: "PING",
        sender: this.nodeIdHex,
      });
      // Replicate relevant key-value pairs to the new peer if it is now among the K closest for any key
      this._replicateToNewPeer(peerId);
      
      // Immediately try to establish DHT routes with this new peer
      if (this.peers.size > 1) {
        this._logDebug(`Establishing DHT routes for newly connected peer ${peerId.substring(0, 8)}...`);
        
        // Find other peers to establish routes through
        const otherPeers = Array.from(this.peers.entries())
          .filter(([id, p]) => id !== peerId && p.connected)
          .slice(0, 3); // Take up to 3 peers
          
        for (const [routePeerId, routePeer] of otherPeers) {
          this._logDebug(`Establishing DHT route between ${peerId.substring(0, 8)}... and ${routePeerId.substring(0, 8)}...`);
          routePeer.send({
            type: "SIGNAL",
            sender: this.nodeIdHex,
            originalSender: peerId,
            signal: { type: "PING" },
            target: routePeerId,
            ttl: 3,
            viaDht: true,
            signalPath: [this.nodeIdHex]
          });
        }
      }
    });

    // Handle messages
    peer.on("message", (message, peerId) => {
      if (message && message.type && this.messageHandlers[message.type]) {
        this.messageHandlers[message.type](message, peerId);
      }
    });

    // Handle disconnect
    peer.on("close", (peerId) => {
      // console.log(`Disconnected from peer: ${peerId}`);
      this.peers.delete(peerId);
      this.emit("peer:disconnect", peerId);
    });

    // Handle errors
    peer.on("error", (err, peerId) => {
      // _logDebug(`Error with peer ${peerId}:`, err.message);
      this.emit("peer:error", { peer: peerId, error: err.message });
    });
  }

  /**
   * Signal a peer
   * @param {Object} data - Signal data
   * @param {string} data.id - Peer ID (hex)
   * @param {Object} data.signal - WebRTC signal data
   */
  signal(data) {
    if (!data || !data.id || !data.signal) return null;

    const peerId = data.id;
    const viaDht = data.viaDht || false;
    // Check if trickle ICE is disabled in our options
    const isTrickleDisabled = this.simplePeerOptions && this.simplePeerOptions.trickle === false;

    // Check if this is an ICE candidate or WebRTC signaling message
    const isIceCandidate = data.signal && data.signal.candidate;
    const isWebRTCSignal = data.signal && (data.signal.type === 'offer' || data.signal.type === 'answer');

    // When trickle is disabled, we should receive fewer ICE candidates
    // Log unexpected ICE candidates for debugging
    if (isTrickleDisabled && isIceCandidate) {
      this._logDebug(`Warning: Received ICE candidate with trickle disabled from ${peerId.substring(0, 8)}...`);
    } else {
      this._logDebug(`Received signal ${isWebRTCSignal ? data.signal.type : (isIceCandidate ? 'ICE' : 'unknown')} from ${peerId.substring(0, 8)}..., via ${viaDht ? 'DHT' : 'server'}`);
    }

    // Check if we know this peer
    if (this.peers.has(peerId)) {
      const peer = this.peers.get(peerId);
      
      // Pass the signal to the peer
      peer.signal(data.signal);
      
      // Implement the specific signaling flow:
      // If this is a bootstrap peer receiving a signal from a new peer via server,
      // we should establish DHT routes to other peers
      
      // Only do this for non-WebRTC signals to avoid interfering with connection establishment
      if (!viaDht && !isWebRTCSignal && !isIceCandidate) {
        // Check if we're likely a bootstrap peer (we have multiple connections)
        const isBootstrapPeer = this.peers.size > 2;
        
        if (isBootstrapPeer) {
          this._logDebug(`Bootstrap peer received signal from ${peerId.substring(0, 8)}..., establishing DHT routes to other peers`);
          
          // Get other peers (excluding the one that just signaled us)
          const otherPeers = Array.from(this.peers.entries())
            .filter(([id, p]) => id !== peerId && p.connected);
            
          if (otherPeers.length > 0) {
            // First, establish a DHT route back to the signaling peer
            this._routeSignalThroughDHT(peerId, this.nodeIdHex, { type: "PING" }, 2, [this.nodeIdHex]);
            
            // Then, establish routes between this new peer and other existing peers
            for (const [otherPeerId, otherPeer] of otherPeers) {
              if (otherPeer && otherPeer.connected) {
                this._logDebug(`Bootstrap peer establishing DHT route between ${peerId.substring(0, 8)}... and ${otherPeerId.substring(0, 8)}...`);
                
                // Send a signal to the other peer to connect to the new peer
                otherPeer.send({
                  type: "SIGNAL",
                  sender: this.nodeIdHex,
                  originalSender: peerId,
                  signal: { type: "PING" },
                  target: otherPeerId,
                  ttl: 2,
                  viaDht: true,
                  signalPath: [this.nodeIdHex]
                });
                
                // Also send a signal to the new peer to connect to the other peer
                peer.send({
                  type: "SIGNAL",
                  sender: this.nodeIdHex,
                  originalSender: otherPeerId,
                  signal: { type: "PING" },
                  target: peerId,
                  ttl: 2,
                  viaDht: true,
                  signalPath: [this.nodeIdHex]
                });
              }
            }
          }
        }
      }
      
      return peer;
    }

    // If we're at max peers, try to rebalance
    if (this.peers.size >= this.maxPeers) {
      if (!this._rebalancePeers(peerId)) {
        this._logDebug(
          `Max peers (${this.maxPeers}) reached and ${peerId} not closer than existing peers`
        );
        this.emit("peer:limit_reached", peerId);
        return null;
      }
    }

    // Extract WebRTC-specific options from the data
    const {
      reconnectTimer,
      iceCompleteTimeout,
      retries,
      simplePeerOptions: peerSpecificOptions
    } = data;

    // Create new peer with improved ICE handling
    const peer = new Peer({
      nodeId: this.nodeId,
      peerId: peerId,
      initiator: false,
      reconnectTimer: reconnectTimer || 3000, // Default to 3 seconds
      iceCompleteTimeout: iceCompleteTimeout || 5000, // Default to 5 seconds
      retries: retries || 2, // Default to 2 retries
      simplePeerOptions: peerSpecificOptions || this.simplePeerOptions
    });

    this.peers.set(peerId, peer);
    this._setupPeerHandlers(peer);
    peer.signal(data.signal);

    // After establishing connection, try to discover more peers through this new peer
    peer.once("connect", async () => {
      this._logDebug(`Connected to new peer ${peerId.substring(0, 8)}..., implementing DHT signaling flow`);
      
      // Implement the specific signaling flow:
      // If we're a new peer that just connected to a bootstrap peer via server,
      // the bootstrap peer should help us connect to other peers via DHT
      
      // Check if we're likely a new peer (we have few connections)
      const isNewPeer = this.peers.size <= 2;
      
      if (isNewPeer) {
        this._logDebug(`New peer connected to bootstrap peer ${peerId.substring(0, 8)}..., waiting for DHT connections`);
        // As a new peer, we don't initiate DHT connections - we wait for the bootstrap peer to do it
      } else {
        // We're likely a bootstrap peer that just connected to a new peer
        this._logDebug(`Bootstrap peer connected to new peer ${peerId.substring(0, 8)}..., establishing DHT routes to other peers`);
        
        // Get other peers (excluding the one that just connected)
        const otherPeers = Array.from(this.peers.entries())
          .filter(([id, p]) => id !== peerId && p.connected);
          
        if (otherPeers.length > 0) {
          // Establish routes between this new peer and other existing peers
          for (const [otherPeerId, otherPeer] of otherPeers) {
            if (otherPeer && otherPeer.connected) {
              this._logDebug(`Bootstrap peer establishing DHT route between ${peerId.substring(0, 8)}... and ${otherPeerId.substring(0, 8)}...`);
              
              // Send a signal to the other peer to connect to the new peer
              otherPeer.send({
                type: "SIGNAL",
                sender: this.nodeIdHex,
                originalSender: peerId,
                signal: { type: "PING" },
                target: otherPeerId,
                ttl: 2,
                viaDht: true,
                signalPath: [this.nodeIdHex]
              });
              
              // Also send a signal to the new peer to connect to the other peer
              peer.send({
                type: "SIGNAL",
                sender: this.nodeIdHex,
                originalSender: otherPeerId,
                signal: { type: "PING" },
                target: peerId,
                ttl: 2,
                viaDht: true,
                signalPath: [this.nodeIdHex]
              });
            }
          }
        }
      }
      
      // Wait a short time to ensure the connection is stable
      setTimeout(async () => {
        try {
          // Try to discover more peers through the DHT
          const discoveredPeers = await this.discoverPeers(Math.min(5, this.K));
          
          if (discoveredPeers.length > 0) {
            this._logDebug(`Discovered ${discoveredPeers.length} additional peers through DHT after connecting to ${peerId.substring(0, 8)}...`);
            
            // Connect to a subset of discovered peers to avoid connection storms
            // Connect to more discovered peers to improve DHT connectivity
            for (let i = 0; i < Math.min(4, discoveredPeers.length); i++) {
              const discoveredPeerId = discoveredPeers[i];
              
              // Skip if we're already connected
              if (this.peers.has(discoveredPeerId) || discoveredPeerId === this.nodeIdHex) {
                continue;
              }
              
              this._logDebug(`Connecting to discovered peer: ${discoveredPeerId.substring(0, 8)}...`);
              try {
                await this.connect({ id: discoveredPeerId });
              } catch (err) {
                this._logDebug(`Failed to connect to discovered peer ${discoveredPeerId.substring(0, 8)}...: ${err.message}`);
              }
            }
          }
        } catch (err) {
          this._logDebug(`Error during peer discovery after connecting to ${peerId.substring(0, 8)}...: ${err.message}`);
        }
      }, 2000);
    });

    return peer;
  }

  /**
   * Handle a PING message
   * @param {Object} message - Message object
   * @param {string} peerId - Sender peer ID
   * @private
   */
  _handlePing(message, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Add sender to routing table
    this._addNode({
      id: hexToBuffer(message.sender),
      host: null,
      port: null,
    });

    // Respond with a PONG
    peer.send({
      type: "PONG",
      sender: this.nodeIdHex,
    });
  }

  /**
   * Handle a FIND_NODE message
   * @param {Object} message - Message object
   * @param {string} peerId - Sender peer ID
   * @private
   */
  _handleFindNode(message, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Add sender to routing table
    this._addNode({
      id: hexToBuffer(message.sender),
      host: null,
      port: null,
    });

    // Find closest nodes to target
    const targetId = hexToBuffer(message.target);
    let nodes = [];

    for (let i = 0; i < this.BUCKET_COUNT; i++) {
      nodes = nodes.concat(this.buckets[i].nodes);
    }
    
    // Filter to only include connected peers (except self)
    const seen = new Set();
    nodes = nodes.filter((n) => {
      const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
      if (seen.has(nIdHex)) return false;
      seen.add(nIdHex);
      // Only include connected peers (except self)
      if (nIdHex === this.nodeIdHex) return false;
      const peer = this.peers.get(nIdHex);
      return peer && peer.connected;
    });

    nodes = nodes
      .sort((a, b) => {
        const distA = distance(a.id, targetId);
        const distB = distance(b.id, targetId);
        return compareBuffers(distA, distB);
      })
      .slice(0, this.K)
      .map((node) => ({
        id: bufferToHex(node.id),
      }));

    // Send response
    peer.send({
      type: "FIND_NODE_RESPONSE",
      sender: this.nodeIdHex,
      nodes: nodes,
    });
  }

  /**
   * Handle a FIND_VALUE message
   * @param {Object} message - Message object
   * @param {string} peerId - Sender peer ID
   * @private
   */
  _handleFindValue(message, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    // Add sender to routing table
    this._addNode({
      id: hexToBuffer(message.sender),
      host: null,
      port: null,
    });
    // Always hash the incoming key for lookup, unless already a 40-char hex string
    const keyStr = message.key;
    const keyHashHex = /^[a-fA-F0-9]{40}$/.test(keyStr)
      ? keyStr
      : bufferToHex(sha1(toBuffer(keyStr)));

    // Check local storage first
    if (this.storage.has(keyHashHex)) {
      const value = this.storage.get(keyHashHex).value;
      if (typeof value !== "undefined") {
        peer.send({
          type: "FIND_VALUE_RESPONSE",
          sender: this.nodeIdHex,
          value: value,
          key: keyHashHex,
        });
        return;
      }
    }

    // If not found, immediately find K closest nodes and send them in response
    let closestNodes = [];
    for (let i = 0; i < this.BUCKET_COUNT; i++) {
      closestNodes = closestNodes.concat(this.buckets[i].nodes);
    }
    closestNodes = closestNodes
      .sort((a, b) => {
        const distA = distance(a.id, hexToBuffer(keyHashHex));
        const distB = distance(b.id, hexToBuffer(keyHashHex));
        return compareBuffers(distA, distB);
      })
      .slice(0, this.K)
      .map((node) => ({
        id: bufferToHex(node.id),
      }));

    peer.send({
      type: "FIND_VALUE_RESPONSE",
      sender: this.nodeIdHex,
      nodes: closestNodes,
      key: keyHashHex,
    });
  }

  /**
   * Handle a STORE message
   * @param {Object} message - Message object
   * @param {string} peerId - Sender peer ID
   * @private
   */
  async _handleStore(message, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Add sender to routing table
    this._addNode({
      id: hexToBuffer(message.sender),
      host: null,
      port: null,
    });

    // Validate key presence and type
    const keyStr = message.key;
    if (
      typeof keyStr !== "string" ||
      !keyStr.trim() ||
      keyStr === ":" ||
      keyStr === "undefined" ||
      keyStr === "null"
    ) {
      _logDebug("[DHT._handleStore] Invalid key:", keyStr);
      peer.send({
        type: "STORE_RESPONSE",
        sender: this.nodeIdHex,
        success: false,
        key: keyStr,
        error: "Invalid key",
      });
      return;
    }
    // Validate key size
    if (Buffer.from(keyStr).length > this.MAX_KEY_SIZE) {
      _logDebug("[DHT._handleStore] Key too large:", keyStr);
      peer.send({
        type: "STORE_RESPONSE",
        sender: this.nodeIdHex,
        success: false,
        key: keyStr,
        error: "Key too large",
      });
      return;
    }

    // Validate value presence
    const value = message.value;
    if (typeof value === "undefined" || value === null) {
      _logDebug("[DHT._handleStore] Value is undefined or null");
      peer.send({
        type: "STORE_RESPONSE",
        sender: this.nodeIdHex,
        success: false,
        key: keyStr,
        error: "Value is undefined or null",
      });
      return;
    }

    // Validate value size
    const valueSize =
      typeof value === "string"
        ? Buffer.from(value).length
        : Buffer.isBuffer(value)
        ? value.length
        : Buffer.from(JSON.stringify(value)).length;

    if (valueSize > this.MAX_VALUE_SIZE) {
      _logDebug("[DHT._handleStore] Value too large:", valueSize, "bytes");
      peer.send({
        type: "STORE_RESPONSE",
        sender: this.nodeIdHex,
        success: false,
        key: keyStr,
        error: "Value exceeds maximum size",
      });
      return;
    }

    // Hash the key if not already a valid hash
    let keyHashHex;
    if (/^[a-fA-F0-9]{40}$/.test(keyStr)) {
      keyHashHex = keyStr;
    } else {
      try {
        const hash = await sha1(keyStr);
        keyHashHex = bufferToHex(hash);
        this._logDebug("Key hash:", keyHashHex);
      } catch (err) {
        _logDebug("[DHT._handleStore] Error hashing key:", err);
        peer.send({
          type: "STORE_RESPONSE",
          sender: this.nodeIdHex,
          success: false,
          key: keyStr,
          error: "Error processing key",
        });
        return;
      }
    }

    // Store the value
    // Store with metadata structure for consistency with put() method
    const timestamp = Date.now();
    this.storage.set(keyHashHex, {
      value,
      timestamp,
      replicatedTo: new Set(),
    });
    this.storageTimestamps.set(keyHashHex, timestamp);

    // Enforce storage size limit
    if (this.storage.size > this.MAX_STORE_SIZE) {
      let oldestKey = null;
      let oldestTime = Infinity;

      for (const [k, time] of this.storageTimestamps.entries()) {
        if (time < oldestTime) {
          oldestTime = time;
          oldestKey = k;
        }
      }

      if (oldestKey) {
        this.storage.delete(oldestKey);
        this.storageTimestamps.delete(oldestKey);
      }
    }

    // Send success response
    peer.send({
      type: "STORE_RESPONSE",
      sender: this.nodeIdHex,
      success: true,
      key: keyStr,
    });
  }
  
  /**
   * Handle a SIGNAL message
   * @param {Object} message - Message object
   * @param {string} peerId - Sender peer ID
   * @private
   */
  _handleSignal(message, peerId) {
    this._logDebug(`Received SIGNAL message from ${peerId.substring(0, 8)}...`);
    
    // Add sender to routing table
    this._addNode({
      id: hexToBuffer(message.sender),
      host: null,
      port: null,
    });
    
    // Extract the signal data
    const signal = message.signal;
    const targetId = message.target || this.nodeIdHex;
    const originalSender = message.originalSender || peerId;
    const isDhtRouted = message.sender !== originalSender || message.viaDht === true;
    const ttl = message.ttl !== undefined ? message.ttl : 3; // Default TTL of 3 hops
    
    // Track signal path to prevent loops
    const signalPath = message.signalPath || [];
    
    // Check if this node has already processed this signal
    if (signalPath.includes(this.nodeIdHex)) {
      this._logDebug(`Signal loop detected! Signal from ${originalSender.substring(0, 8)}... to ${targetId.substring(0, 8)}... has already passed through this node.`);
      return; // Prevent the loop by not processing this signal again
    }
    
    // Add this node to the signal path
    const updatedSignalPath = [...signalPath, this.nodeIdHex];
    
    if (!signal) {
      this._logDebug(`Invalid SIGNAL message from ${peerId.substring(0, 8)}...: missing signal data`);
      return;
    }
    
    // If the target is us, process the signal
    if (targetId === this.nodeIdHex) {
      this._logDebug(`Processing signal from ${originalSender.substring(0, 8)}...`);
      
      // Log whether this signal came through the DHT or not
      if (isDhtRouted) {
        this._logDebug(`Signal from ${originalSender.substring(0, 8)}... was routed through the DHT`);
        
        // Track successful DHT signal routing
        if (!this.dhtCapablePeers.has(originalSender)) {
          this.dhtCapablePeers.set(originalSender, {
            successCount: 1,
            lastSuccess: Date.now(),
            routes: new Set(signalPath.filter(id => id !== this.nodeIdHex && id !== originalSender))
          });
        } else {
          const peerInfo = this.dhtCapablePeers.get(originalSender);
          peerInfo.successCount++;
          peerInfo.lastSuccess = Date.now();
          
          // Add any new routes we've discovered
          signalPath.forEach(id => {
            if (id !== this.nodeIdHex && id !== originalSender) {
              peerInfo.routes.add(id);
            }
          });
        }
        
        // Update DHT routes
        if (!this.dhtRoutes.has(originalSender)) {
          this.dhtRoutes.set(originalSender, new Set());
        }
        
        // Add the last hop as a direct route
        if (signalPath.length > 0) {
          const lastHop = signalPath[signalPath.length - 1];
          if (lastHop !== this.nodeIdHex && lastHop !== originalSender) {
            this.dhtRoutes.get(originalSender).add(lastHop);
          }
        }
        
        // Check if we should update DHT readiness
        this._updateDHTReadiness();
      } else {
        this._logDebug(`Signal from ${originalSender.substring(0, 8)}... came directly (not through DHT)`);
      }
      
      // Emit the signal event with additional metadata to indicate if it was DHT-routed
      // Use batching for the response if appropriate
      if (this.SIGNAL_BATCH_INTERVAL > 0) {
        this._batchSignal(originalSender, signal, isDhtRouted);
      } else {
        this.emit("signal", {
          id: originalSender,
          signal: signal,
          viaDht: isDhtRouted
        });
      }
    }
    // If the target is another peer, forward the signal
    else if (this.peers.has(targetId)) {
      this._logDebug(`Forwarding signal from ${originalSender.substring(0, 8)}... to ${targetId.substring(0, 8)}...`);
      const targetPeer = this.peers.get(targetId);
      if (targetPeer && targetPeer.connected) {
        // Compress the signal if enabled
        const signalToSend = this.SIGNAL_COMPRESSION_ENABLED ?
          this._compressSignal(signal) : signal;
          
        targetPeer.send({
          type: "SIGNAL",
          sender: peerId,
          originalSender: originalSender,
          signal: signalToSend,
          target: targetId,
          viaDht: true,  // Mark as DHT-routed
          ttl: ttl - 1,  // Decrement TTL
          signalPath: updatedSignalPath // Include the updated signal path
        });
      }
    }
    // If we don't know the target, try to find it in the DHT (only if TTL > 0)
    else if (ttl > 0) {
      this._logDebug(`Unknown target ${targetId.substring(0, 8)}... for signal from ${originalSender.substring(0, 8)}..., trying to route through DHT (TTL: ${ttl})`);
      
      // Try to find the closest peers to the target
      this._routeSignalThroughDHT(targetId, originalSender, signal, ttl - 1, updatedSignalPath);
    } else {
      this._logDebug(`TTL expired for signal from ${originalSender.substring(0, 8)}... to ${targetId.substring(0, 8)}...`);
    }
  }
  
  /**
   * Route a signal through the DHT to reach a target peer
   * @private
   */
  async _routeSignalThroughDHT(targetId, senderId, signal, ttl = 3, signalPath = []) {
    try {
      // If TTL is 0 or less, don't route further
      if (ttl <= 0) {
        this._logDebug(`TTL expired for signal from ${senderId.substring(0, 8)}... to ${targetId.substring(0, 8)}...`);
        return;
      }
      
      // Check if we have a known direct route to the target
      if (this.dhtRoutes.has(targetId) && this.dhtRoutes.get(targetId).size > 0) {
        const knownRoutes = Array.from(this.dhtRoutes.get(targetId));
        
        // Prioritize DHT-capable peers for routing
        const dhtCapableRoutes = knownRoutes.filter(routeId =>
          this.dhtCapablePeers.has(routeId) &&
          this.dhtCapablePeers.get(routeId).successCount >= this.DHT_SIGNAL_THRESHOLD &&
          !signalPath.includes(routeId) // Avoid loops
        );
        if (dhtCapableRoutes.length > 0) {
          // Use a known DHT-capable route
          const routeId = dhtCapableRoutes[Math.floor(Math.random() * dhtCapableRoutes.length)];
          const routePeer = this.peers.get(routeId);
          
          if (routePeer && routePeer.connected) {
            this._logDebug(`Using known DHT-capable route to ${targetId.substring(0, 8)}... via ${routeId.substring(0, 8)}...`);
              
            routePeer.send({
              type: "SIGNAL",
              sender: this.nodeIdHex,
              originalSender: senderId,
              signal: signalToSend,
              target: targetId,
              ttl: ttl,
              viaDht: true,
              signalPath: [...signalPath, this.nodeIdHex]
            });
            
            return; // Successfully routed through known DHT-capable peer
          }
        }
        
        // If no DHT-capable routes, try any known route
        const availableRoutes = knownRoutes.filter(routeId =>
          !signalPath.includes(routeId) && // Avoid loops
          this.peers.has(routeId) &&
          this.peers.get(routeId).connected
        );
        
        if (availableRoutes.length > 0) {
          // Use a known route
          const routeId = availableRoutes[Math.floor(Math.random() * availableRoutes.length)];
          const routePeer = this.peers.get(routeId);
          
          this._logDebug(`Using known route to ${targetId.substring(0, 8)}... via ${routeId.substring(0, 8)}...`);
          
          // Compress the signal if enabled
          const signalToSend = this.SIGNAL_COMPRESSION_ENABLED ?
            this._compressSignal(signal) : signal;
            
          routePeer.send({
            type: "SIGNAL",
            sender: this.nodeIdHex,
            originalSender: senderId,
            signal: signalToSend,
            target: targetId,
            ttl: ttl,
            viaDht: true,
            signalPath: [...signalPath, this.nodeIdHex]
          });
          
          return; // Successfully routed through known peer
        }
      }
      
      // If no known routes, find the closest nodes to the target
      this._logDebug(`Finding closest nodes to ${targetId.substring(0, 8)}... for routing signal (TTL: ${ttl})`);
      
      // Get all nodes from our buckets
      let nodes = [];
      for (let i = 0; i < this.BUCKET_COUNT; i++) {
        nodes = nodes.concat(this.buckets[i].nodes);
      }
      
      // Filter to only connected peers and sort by distance to target
      const connectedNodes = nodes
        .filter(node => {
          const nodeIdHex = typeof node.id === "string" ? node.id : bufferToHex(node.id);
          
          // Don't route to nodes that are already in the signal path (prevents loops)
          if (signalPath.includes(nodeIdHex)) return false;
          
          // Don't route to self, target, or original sender
          if (nodeIdHex === this.nodeIdHex || nodeIdHex === targetId || nodeIdHex === senderId) return false;
          
          const peer = this.peers.get(nodeIdHex);
          return peer && peer.connected;
        });
      
      if (connectedNodes.length === 0) {
        this._logDebug(`No connected nodes available to route signal to ${targetId.substring(0, 8)}...`);
        return;
      }
      
      // Prioritize DHT-capable peers
      const dhtCapableNodes = connectedNodes.filter(node => {
        const nodeIdHex = typeof node.id === "string" ? node.id : bufferToHex(node.id);
        return this.dhtCapablePeers.has(nodeIdHex) &&
               this.dhtCapablePeers.get(nodeIdHex).successCount >= this.DHT_SIGNAL_THRESHOLD;
      });
      
      // Sort nodes by distance to target
      const sortByDistance = nodes => nodes.sort((a, b) => {
        const aId = typeof a.id === "string" ? a.id : bufferToHex(a.id);
        const bId = typeof b.id === "string" ? b.id : bufferToHex(b.id);
        const distA = this._calculateDistance(aId, targetId);
        const distB = this._calculateDistance(bId, targetId);
        return distA < distB ? -1 : distA > distB ? 1 : 0;
      });
      
      // Sort both node lists by distance
      const sortedDhtCapableNodes = sortByDistance(dhtCapableNodes);
      const sortedRegularNodes = sortByDistance(connectedNodes);
      
      // Determine how many nodes to route through based on DHT readiness and aggressive discovery
      const routeCount = this.AGGRESSIVE_DISCOVERY ?
        (this.dhtReadiness ? 3 : 5) : // More aggressive when not DHT-ready
        (this.dhtReadiness ? 2 : 3);  // Less aggressive when DHT-ready
      
      // Prefer DHT-capable nodes, but fall back to regular nodes if needed
      const nodesToUse = sortedDhtCapableNodes.length >= routeCount ?
        sortedDhtCapableNodes.slice(0, routeCount) :
        [...sortedDhtCapableNodes, ...sortedRegularNodes.slice(0, routeCount - sortedDhtCapableNodes.length)];
      
      // Forward the signal to each selected node
      for (const node of nodesToUse) {
        const nodeIdHex = typeof node.id === "string" ? node.id : bufferToHex(node.id);
        const peer = this.peers.get(nodeIdHex);
        
        if (peer && peer.connected) {
          const isDhtCapable = this.dhtCapablePeers.has(nodeIdHex) &&
                              this.dhtCapablePeers.get(nodeIdHex).successCount >= this.DHT_SIGNAL_THRESHOLD;
          
          this._logDebug(`Routing signal from ${senderId.substring(0, 8)}... to ${targetId.substring(0, 8)}... via ${nodeIdHex.substring(0, 8)}... (${isDhtCapable ? 'DHT-capable' : 'regular'}, TTL: ${ttl})`);
          
          // Compress the signal if enabled
          const signalToSend = this.SIGNAL_COMPRESSION_ENABLED ?
            this._compressSignal(signal) : signal;
            
          peer.send({
            type: "SIGNAL",
            sender: this.nodeIdHex,
            originalSender: senderId,
            signal: signalToSend,
            target: targetId,
            ttl: ttl,
            viaDht: true,
            signalPath: [...signalPath, this.nodeIdHex]
          });
        }
      }
    } catch (err) {
      this._logDebug(`Error routing signal through DHT: ${err.message}`);
    }
  }

  /**
   * Find a node in the DHT
   * @param {string|Buffer} targetId - Target node ID
   * @return {Promise<Array>} Closest nodes to the target
   */
  async findNode(targetId) {
    const targetHex = targetId;
    const target = targetId;
    let nodes = [];
    for (let i = 0; i < this.BUCKET_COUNT; i++) {
      nodes = nodes.concat(this.buckets[i].nodes);
    }
    // Ensure unique node IDs and only connected peers
    const seen = new Set();
    nodes = nodes.filter((n) => {
      const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
      if (seen.has(nIdHex)) return false;
      seen.add(nIdHex);
      // Only include connected peers (except self)
      if (nIdHex === this.nodeIdHex) return false;
      const peer = this.peers.get(nIdHex);
      return peer && peer.connected;
    });
    nodes = nodes
      .sort((a, b) => {
        const distA = distance(a.id, target);
        const distB = distance(b.id, target);
        return compareBuffers(distA, distB);
      })
      .slice(0, this.K);
    if (nodes.length === 0) {
      return [];
    }
    const queriedNodes = new Set();
    let closestNodes = [...nodes];
    while (nodes.length > 0) {
      const nodesToQuery = [];
      for (
        let i = 0;
        i < nodes.length && nodesToQuery.length < this.ALPHA;
        i++
      ) {
        const node = nodes[i];
        const nodeIdHex =
          typeof node.id === "string" ? node.id : bufferToHex(node.id);
        if (!queriedNodes.has(nodeIdHex)) {
          nodesToQuery.push(node);
          queriedNodes.add(nodeIdHex);
        }
      }
      if (nodesToQuery.length === 0) break;
      const promises = nodesToQuery.map(async (node) => {
        const nodeIdHex =
          typeof node.id === "string" ? node.id : bufferToHex(node.id);
        const peer = this.peers.get(nodeIdHex);
        if (!peer || !peer.connected) {
          return [];
        }
        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve([]);
          }, 5000);
          const responseHandler = (message, sender) => {
            if (
              sender !== nodeIdHex ||
              message.type !== "FIND_NODE_RESPONSE" ||
              !message.nodes
            ) {
              return;
            }
            clearTimeout(timeout);
            peer.removeListener("message", responseHandler);
            const responseNodes = message.nodes
              .filter((n) => n && n.id)
              .map((n) => ({
                id: hexToBuffer(n.id),
                host: null,
                port: null,
              }));
            resolve(responseNodes);
          };
          peer.on("message", responseHandler);
          peer.send({
            type: "FIND_NODE",
            sender: this.nodeIdHex,
            target: targetHex,
          });
        });
      });
      const results = await Promise.all(promises);
      let newNodes = results.flat();
      // Ensure uniqueness and only connected
      const seenNew = new Set();
      newNodes = newNodes.filter((n) => {
        const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
        if (seen.has(nIdHex) || seenNew.has(nIdHex)) return false;
        seenNew.add(nIdHex);
        seen.add(nIdHex);
        if (nIdHex === this.nodeIdHex) return false;
        const peer = this.peers.get(nIdHex);
        return peer && peer.connected;
      });
      newNodes.forEach((node) => {
        this._addNode(node);
      });
      closestNodes = [...closestNodes, ...newNodes]
        .filter((n, i, arr) => {
          const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
          // Only include if we have room for more peers or already connected
          if (!this.peers.has(nIdHex) && this.peers.size >= this.maxPeers) {
            return false;
          }
          return (
            arr.findIndex(
              (x) =>
                (typeof x.id === "string" ? x.id : bufferToHex(x.id)) === nIdHex
            ) === i
          );
        })
        .sort((a, b) => {
          const distA = distance(a.id, target);
          const distB = distance(b.id, target);
          return compareBuffers(distA, distB);
        })
        .slice(0, this.K);
      nodes = closestNodes.filter((node) => {
        const nodeIdHex =
          typeof node.id === "string" ? node.id : bufferToHex(node.id);
        return !queriedNodes.has(nodeIdHex);
      });
    }
    return closestNodes.map((node) => ({
      id: typeof node.id === "string" ? node.id : bufferToHex(node.id),
    }));
  }

  /**
   * Store a value in the DHT
   * @param {string} key - Key to store
   * @param {*} value - Value to store
   * @return {Promise<boolean>} Success flag
   */
  async put(key, value) {
    // Validate input sizes
    const keySize = Buffer.from(key).length;
    const valueSize = Buffer.from(value).length;

    if (keySize > this.MAX_KEY_SIZE) {
      throw new Error(`Key size exceeds maximum (${this.MAX_KEY_SIZE} bytes)`);
    }
    if (valueSize > this.MAX_VALUE_SIZE) {
      throw new Error(
        `Value size exceeds maximum (${this.MAX_VALUE_SIZE} bytes)`
      );
    }

    // Check storage limit
    if (this.storage.size >= this.MAX_STORE_SIZE) {
      // Remove oldest entry
      const oldestKey = Array.from(this.storageTimestamps.keys()).sort(
        (a, b) => this.storageTimestamps.get(a) - this.storageTimestamps.get(b)
      )[0];
      if (oldestKey) {
        this.storage.delete(oldestKey);
        this.storageTimestamps.delete(oldestKey);
      }
    }

    const keyStr = typeof key === "string" ? key : key.toString();
    const keyHash = await sha1(keyStr);
    const keyHashHex = bufferToHex(keyHash);
    this._logDebug("put - key:", keyStr, "keyHashHex:", keyHashHex);

    // Store the value with metadata
    const timestamp = Date.now();
    this.storage.set(keyHashHex, {
      value,
      timestamp,
      replicatedTo: new Set(),
    });
    this.storageTimestamps.set(keyHashHex, timestamp);

    // Find K closest nodes to the key
    const nodes = await this.findNode(keyHashHex);
    this._logDebug(
      "put - Closest nodes for key:",
      nodes.map((n) => n.id)
    );

    if (nodes.length === 0) {
      this._logDebug("put - No nodes found, storing locally only.");
      return true;
    }

    // Send STORE to all K closest nodes
    const promises = nodes.map(async (node) => {
      const peer = this.peers.get(node.id);
      if (!peer || !peer.connected) {
        this._logDebug("put - Peer not connected:", node.id);
        return false;
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this._logDebug("put - STORE timeout for peer:", node.id);
          resolve(false);
        }, 5000);

        const responseHandler = (message, sender) => {
          if (
            sender !== node.id ||
            message.type !== "STORE_RESPONSE" ||
            message.key !== keyStr
          ) {
            return;
          }
          clearTimeout(timeout);
          peer.removeListener("message", responseHandler);

          if (message.success) {
            // Track successful replication
            const stored = this.storage.get(keyHashHex);
            if (stored) {
              stored.replicatedTo.add(node.id);
            }
          }

          this._logDebug(
            "put - STORE response from peer:",
            node.id,
            "success:",
            message.success
          );
          resolve(message.success);
        };

        peer.on("message", responseHandler);
        this._logDebug("put - Sending STORE to peer:", node.id, "key:", keyStr);
        peer.send({
          type: "STORE",
          sender: this.nodeIdHex,
          key: keyStr,
          value: value,
        });
      });
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(Boolean).length;
    this._logDebug(
      "put - STORE operation completed. Success count:",
      successCount,
      "out of",
      nodes.length
    );
    return successCount > 0;
  }

  /**
   * Get a value from the DHT
   * @param {string} key - Key to look up
   * @return {Promise<any>} Retrieved value
   */
  async get(key) {
    // Hash the key unless it's already a hash
    const keyHashHex = /^[a-fA-F0-9]{40}$/.test(key)
      ? key
      : bufferToHex(await sha1(key));

    this._logDebug(`get - Looking up key: ${key}, hash: ${keyHashHex}`);

    // Check local storage first
    if (this.storage.has(keyHashHex)) {
      const storedData = this.storage.get(keyHashHex);
      // Return just the value, not the metadata
      if (storedData.value !== undefined) {
        this._logDebug(`get - Found value in local storage for key: ${key}`);
        return storedData.value;
      } else {
        this._logDebug(`get - Found undefined value in local storage for key: ${key}, removing invalid entry`);
        // Remove invalid entry
        this.storage.delete(keyHashHex);
        this.storageTimestamps.delete(keyHashHex);
      }
    }

    this._logDebug(`get - Value not found locally, querying DHT for key: ${key}`);

    // Find closest nodes to the key
    const keyBuffer = hexToBuffer(keyHashHex);
    let closestNodes = [];

    for (let i = 0; i < this.BUCKET_COUNT; i++) {
      closestNodes = closestNodes.concat(this.buckets[i].nodes);
    }

    closestNodes = closestNodes
      .filter((n) => {
        const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
        return nIdHex !== this.nodeIdHex && this.peers.has(nIdHex);
      })
      .sort((a, b) => {
        const distA = distance(a.id, keyBuffer);
        const distB = distance(b.id, keyBuffer);
        return compareBuffers(distA, distB);
      })
      .slice(0, this.K);

    this._logDebug(`get - Found ${closestNodes.length} nodes to query for key: ${key}`);

    // Query nodes in parallel with timeout
    const queryNode = async (node) => {
      const nodeIdHex =
        typeof node.id === "string" ? node.id : bufferToHex(node.id);
      const peer = this.peers.get(nodeIdHex);

      if (!peer || !peer.connected) {
        this._logDebug(`get - Peer ${nodeIdHex.substring(0, 8)}... not connected, skipping`);
        return null;
      }

      this._logDebug(`get - Querying peer ${nodeIdHex.substring(0, 8)}... for key: ${key}`);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this._logDebug(`get - Timeout querying peer ${nodeIdHex.substring(0, 8)}... for key: ${key}`);
          resolve(null);
        }, 5000); // 5s timeout

        const messageHandler = (msg) => {
          if (msg.type === "FIND_VALUE_RESPONSE" && msg.key === keyHashHex) {
            clearTimeout(timeout);
            peer.removeListener("message", messageHandler);
            
            if (msg.value === undefined) {
              this._logDebug(`get - Peer ${nodeIdHex.substring(0, 8)}... returned undefined for key: ${key}`);
              resolve(null);
            } else {
              this._logDebug(`get - Peer ${nodeIdHex.substring(0, 8)}... returned value for key: ${key}`);
              resolve(msg.value);
            }
          }
        };

        peer.on("message", messageHandler);
        peer.send({
          type: "FIND_VALUE",
          sender: this.nodeIdHex,
          key: keyHashHex,
        });
      });
    };

    // Query nodes in parallel
    const results = await Promise.all(closestNodes.map(queryNode));

    // Return first non-null result
    for (const result of results) {
      if (result !== null && result !== undefined) {
        // Store result locally for future use with metadata structure
        const timestamp = Date.now();
        this._logDebug(`get - Found value for key: ${key}, storing locally`);
        this.storage.set(keyHashHex, {
          value: result,
          timestamp,
          replicatedTo: new Set(),
        });
        this.storageTimestamps.set(keyHashHex, timestamp);
        return result;
      }
    }

    this._logDebug(`get - No value found for key: ${key} in DHT`);
    return null;
  }
  
  /**
   * Replicate data to K closest nodes for each key
   * @private
   */
  _replicateData() {
    this._logDebug("Starting data replication..."); // Use _logDebug
    this.storage.forEach(async (storedData, keyHashHex) => {
      const keyHash = hexToBuffer(keyHashHex);
      const nodes = await this.findNode(keyHashHex); // Find current K closest
      this._logDebug(
        `Replicating key ${keyHashHex.substring(0, 4)} to ${nodes.length} nodes`
      ); // Use _logDebug
      nodes.forEach((node) => {
        const peer = this.peers.get(node.id);
        if (peer && peer.connected && node.id !== this.nodeIdHex) {
          // Don't send to self
          this._logDebug(
            `Sending STORE (replication) for ${keyHashHex.substring(
              0,
              4
            )} to ${node.id.substring(0, 4)}`
          );
          peer.send({
            type: "STORE",
            sender: this.nodeIdHex,
            key: keyHashHex, // Use hash as key for replication
            value: storedData.value, // Send only the value, not the metadata
          });
        }
      });
    });
  }

  /**
   * Republish data originally stored by this node
   * @private
   */
  _republishData() {
    this._logDebug("Starting data republication..."); // Use _logDebug
    this.storage.forEach(async (storedData, keyHashHex) => {
      this._logDebug(`Republishing key ${keyHashHex.substring(0, 4)}`);
      const nodes = await this.findNode(keyHashHex);
      nodes.forEach((node) => {
        const peer = this.peers.get(node.id);
        if (peer && peer.connected && node.id !== this.nodeIdHex) {
          peer.send({
            type: "STORE",
            sender: this.nodeIdHex,
            key: keyHashHex,
            value: storedData.value, // Send only the value, not the metadata
          });
        }
      });
    });
  }

  /**
   * Replicate relevant data to a newly connected peer
   * @param {string} newPeerIdHex - The ID of the newly connected peer
   * @private
   */
  async _replicateToNewPeer(newPeerIdHex) {
    this._logDebug(
      `Checking replication needs for new peer: ${newPeerIdHex.substring(0, 4)}`
    ); // Use _logDebug
    const newPeerIdBuffer = hexToBuffer(newPeerIdHex);

    for (const [keyHashHex, storedData] of this.storage.entries()) {
      const keyHashBuffer = hexToBuffer(keyHashHex);
      const closestNodes = await this.findNode(keyHashHex); // Find K closest nodes *now*

      // Check if the new peer is among the K closest for this key
      const isNewPeerClosest = closestNodes.some(
        (node) => node.id === newPeerIdHex
      );

      if (isNewPeerClosest) {
        const peer = this.peers.get(newPeerIdHex);
        if (peer && peer.connected) {
          this._logDebug(
            `New peer ${newPeerIdHex.substring(
              0,
              4
            )} is close to key ${keyHashHex.substring(0, 4)}, replicating...`
          );
          peer.send({
            type: "STORE",
            sender: this.nodeIdHex,
            key: keyHashHex,
            value: storedData.value, // Send only the value, not the metadata
          });
        }
      }
    }
  }

  /**
   * Discover peers through the DHT network
   * @param {number} count - Number of peers to discover (default: K)
   * @return {Promise<Array>} Array of discovered peer IDs
   */
  async discoverPeers(count = this.K) {
    this._logDebug(`Discovering peers through DHT (count: ${count})...`);
    
    // First, find nodes close to a random ID to get a diverse set of peers
    const randomId = await generateRandomID();
    const discoveredNodes = await this.findNode(randomId);
    
    // Then, find nodes close to our own ID to get peers that should be in our routing table
    const closeSelfNodes = await this.findNode(this.nodeId);
    
    // If we're DHT-ready, also find nodes close to some of our DHT-capable peers
    // to improve the DHT mesh connectivity
    let dhtCapableNodes = [];
    if (this.dhtReadiness && this.dhtCapablePeers.size > 0) {
      // Get up to 3 DHT-capable peers
      const dhtCapablePeerIds = Array.from(this.dhtCapablePeers.keys())
        .filter(id => this.dhtCapablePeers.get(id).successCount >= this.DHT_SIGNAL_THRESHOLD)
        .slice(0, 3);
      
      // Find nodes close to each DHT-capable peer
      for (const peerId of dhtCapablePeerIds) {
        try {
          const peerNodes = await this.findNode(peerId);
          dhtCapableNodes = [...dhtCapableNodes, ...peerNodes];
        } catch (err) {
          this._logDebug(`Error finding nodes close to DHT-capable peer ${peerId.substring(0, 8)}...: ${err.message}`);
        }
      }
    }
    
    // Combine the results, removing duplicates
    const allNodes = [...discoveredNodes, ...closeSelfNodes, ...dhtCapableNodes];
    const uniqueNodes = [];
    const seenIds = new Set();
    
    for (const node of allNodes) {
      const nodeIdHex = typeof node.id === "string" ? node.id : bufferToHex(node.id);
      if (!seenIds.has(nodeIdHex) && nodeIdHex !== this.nodeIdHex) {
        seenIds.add(nodeIdHex);
        uniqueNodes.push({
          ...node,
          isDhtCapable: this.dhtCapablePeers.has(nodeIdHex) &&
                        this.dhtCapablePeers.get(nodeIdHex).successCount >= this.DHT_SIGNAL_THRESHOLD
        });
      }
    }
    
    // First prioritize DHT-capable peers
    const dhtCapablePeers = uniqueNodes.filter(node => node.isDhtCapable);
    const regularPeers = uniqueNodes.filter(node => !node.isDhtCapable);
    
    // Sort each group by XOR distance to our node ID
    const sortByDistance = nodes => nodes.sort((a, b) => {
      const distA = distance(a.id, this.nodeId);
      const distB = distance(b.id, this.nodeId);
      return compareBuffers(distA, distB);
    });
    
    const sortedDhtCapablePeers = sortByDistance(dhtCapablePeers);
    const sortedRegularPeers = sortByDistance(regularPeers);
    
    // Combine the sorted lists, prioritizing DHT-capable peers
    // Take all DHT-capable peers first, then fill remaining slots with regular peers
    const dhtPeersToTake = Math.min(sortedDhtCapablePeers.length, count);
    const regularPeersToTake = Math.min(sortedRegularPeers.length, count - dhtPeersToTake);
    
    const resultNodes = [
      ...sortedDhtCapablePeers.slice(0, dhtPeersToTake),
      ...sortedRegularPeers.slice(0, regularPeersToTake)
    ];
    
    this._logDebug(`Discovered ${resultNodes.length} peers through DHT (${dhtPeersToTake} DHT-capable)`);
    return resultNodes.map(node => typeof node.id === "string" ? node.id : bufferToHex(node.id));
  }
  
  /**
   * Check if a peer is directly connected or can be reached through the DHT
   * @param {string} peerId - Peer ID to check
   * @return {Promise<boolean>} True if peer is directly connected or can be reached through DHT
   */
  async canReachPeerDirectly(peerId) {
    this._logDebug(`Checking if peer ${peerId.substring(0, 8)}... can be reached through DHT`);
    this._logDebug(`Current peers: ${Array.from(this.peers.keys()).map(id => id.substring(0, 8) + '...').join(', ')}`);
    
    // If the peer is directly connected, we can reach it
    if (this.peers.has(peerId)) {
      this._logDebug(`Peer ${peerId.substring(0, 8)}... is directly connected`);
      return true;
    }
    
    // If we don't have any peers, we can't reach anything
    if (this.peers.size === 0) {
      this._logDebug(`No peers connected, can't reach ${peerId.substring(0, 8)}...`);
      return false;
    }
    
    try {
      // Try to find the peer through the DHT
      this._logDebug(`Searching for peer ${peerId.substring(0, 8)}... in DHT`);
      const closestNodes = await this.findNode(peerId);
      this._logDebug(`Found ${closestNodes.length} nodes in search for ${peerId.substring(0, 8)}...`);
      
      if (closestNodes.length > 0) {
        this._logDebug(`Closest nodes: ${closestNodes.map(node =>
          (typeof node.id === 'string' ? node.id : bufferToHex(node.id)).substring(0, 8) + '...'
        ).join(', ')}`);
      }
      
      // Check if we found the exact peer we're looking for
      const directPath = closestNodes.find(node => {
        const nodeId = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        return nodeId === peerId;
      });
      
      if (directPath) {
        this._logDebug(`Found direct path to peer ${peerId.substring(0, 8)}... through DHT`);
        return true;
      }
      
      // Check if we have any peers that are close to the target
      // These could potentially be used for routing
      const closeNodes = closestNodes.filter(node => {
        const nodeId = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        const distance = this._calculateDistance(nodeId, peerId);
        // Consider nodes "close" if they're within a certain distance threshold
        // This is a simplified approach - in a full implementation, you might use a more sophisticated metric
        return distance < BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'); // Arbitrary threshold
      });
      
      if (closeNodes.length > 0) {
        this._logDebug(`Found ${closeNodes.length} nodes close to ${peerId.substring(0, 8)}... that could be used for routing`);
        return true; // We can potentially reach the peer through routing
      }
      
      this._logDebug(`No path to peer ${peerId.substring(0, 8)}... found through DHT`);
      return false;
    } catch (err) {
      this._logDebug(`Error checking path to peer ${peerId.substring(0, 8)}...`, err);
      return false;
    }
  }
}

export default DHT;