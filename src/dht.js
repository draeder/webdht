/**
 * Kademlia DHT implementation
 */
import EventEmitter from './event-emitter.js';
import Peer from './peer.js';
import { 
  sha1, 
  toBuffer, 
  distance, 
  compareBuffers, 
  getBit, 
  commonPrefixLength, 
  generateRandomID,
  bufferToHex,
  hexToBuffer
} from './utils.js';

// Kademlia constants
const K = 20;               // Size of k-buckets
const ALPHA = 3;            // Concurrency parameter for iterative lookups
const BUCKET_COUNT = 160;   // Number of k-buckets (SHA1 is 160 bits)
const MAX_STORE_SIZE = 1000; // Maximum number of key-value pairs to store
const REPLICATE_INTERVAL = 3600000; // Replication interval (1 hour)
const REPUBLISH_INTERVAL = 86400000; // Republication interval (24 hours)

/**
 * K-bucket implementation
 */
class KBucket {
  constructor(localNodeId, debug = false) { // Add debug flag
    this.localNodeId = localNodeId;
    this.nodes = [];
    this.debug = debug; // Store debug flag
  }

  _logDebug(...args) { // Add debug logger method
    if (this.debug) {
      console.debug('[KBucket]', ...args);
    }
  }

  /**
   * Add a node to the bucket
   * @param {Object} node - Node to add
   * @return {boolean} True if node was added
   */
  add(node) {
    // Always compare IDs as hex strings for consistency
    const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
    const localNodeIdHex = typeof this.localNodeId === 'string' ? this.localNodeId : bufferToHex(this.localNodeId);
    // Don't add ourselves
    if (nodeIdHex === localNodeIdHex) {
      this._logDebug('Attempted to add self, skipping:', nodeIdHex); // Use _logDebug
      return false;
    }
    // Check if node already exists
    const nodeIndex = this.nodes.findIndex(n => {
      const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
      return nIdHex === nodeIdHex;
    });
    if (nodeIndex >= 0) {
      // Move existing node to the end (most recently seen)
      const existingNode = this.nodes[nodeIndex];
      this.nodes.splice(nodeIndex, 1);
      this.nodes.push(existingNode);
      this._logDebug('Node already exists, moved to end:', nodeIdHex); // Use _logDebug
      return false;
    }
    // Add new node if bucket not full
    if (this.nodes.length < K) {
      this.nodes.push({ ...node, id: nodeIdHex }); // Store as hex string
      this._logDebug('Added node:', nodeIdHex); // Use _logDebug
      return true;
    }
    // Bucket full, can't add
    this._logDebug('Bucket full, could not add:', nodeIdHex); // Use _logDebug
    return false;
  }
  /**
   * Remove a node from the bucket
   * @param {Buffer|string} nodeId - ID of node to remove
   * @return {boolean} True if node was removed
   */
  remove(nodeId) {
    const nodeIdHex = typeof nodeId === 'string' ? nodeId : bufferToHex(nodeId);
    const nodeIndex = this.nodes.findIndex(n => {
      const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
      return nIdHex === nodeIdHex;
    });
    if (nodeIndex >= 0) {
      this.nodes.splice(nodeIndex, 1);
      this._logDebug('Removed node:', nodeIdHex); // Use _logDebug
      return true;
    }
    return false;
  }

  /**
   * Get closest nodes to the target ID
   * @param {Buffer} targetId - Target node ID
   * @param {number} count - Maximum number of nodes to return
   * @return {Array} Array of closest nodes
   */
  getClosestNodes(targetId, count = K) {
    // Ensure unique node IDs and sort by distance
    const seen = new Set();
    return this.nodes
      .filter(n => {
        const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
        if (seen.has(nIdHex)) return false;
        seen.add(nIdHex);
        return true;
      })
      .sort((a, b) => {
        if (!a || !b || !a.id || !b.id) {
          console.error('Invalid node IDs for sorting');
          return 0;
        }
        const distA = distance(a.id, targetId);
        const distB = distance(b.id, targetId);
        return compareBuffers(distA, distB);
      })
      .slice(0, count);
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
  constructor(options = {}) {
    super();
    
    // Use async function and emit 'ready' event when done
    this._initialize(options);
  }
  
  /**
   * Initialize the DHT node asynchronously
   * @private
   */
  async _initialize(options) {
    try {
      this.debug = !!options.debug; // Store debug option, default false
      this._logDebug('Initializing DHT with options:', options); // Use _logDebug

      // Initialize node ID (always string-based with our simplified approach)
      this.nodeId = options.nodeId || await generateRandomID();

      // We're already using hex strings, so no conversion needed
      this.nodeIdHex = this.nodeId;

      // Initialize routing table (k-buckets)
      // Pass the debug flag to KBucket constructor
      this.buckets = Array(BUCKET_COUNT).fill().map(() => new KBucket(this.nodeId, this.debug));

      // Initialize storage
      this.storage = new Map();
      this.storageTimestamps = new Map();

      // Initialize peer connections
      this.peers = new Map();

      // Message handlers
      this.messageHandlers = {
        PING: this._handlePing.bind(this),
        FIND_NODE: this._handleFindNode.bind(this),
        FIND_VALUE: this._handleFindValue.bind(this),
        STORE: this._handleStore.bind(this)
      };

      // Bootstrap if nodes provided
      if (options.bootstrap && Array.isArray(options.bootstrap) && options.bootstrap.length > 0) {
        this._bootstrap(options.bootstrap);
      }

      // Setup maintenance intervals
      this._setupMaintenance();

      // Log node creation (use console.log for important info)
      console.log(`DHT node created with ID: ${this.nodeIdHex}`);

      // Emit ready event with the node ID
      this.emit('ready', this.nodeIdHex);
    } catch (error) {
      console.error('Error initializing DHT node:', error);
      this.emit('error', error);
    }
  }

  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug) {
      console.debug(`[DHT ${this.nodeIdHex.substring(0, 4)}]`, ...args);
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
    }, REPLICATE_INTERVAL);
    
    // Republish data
    this.republishInterval = setInterval(() => {
      this._republishData();
    }, REPUBLISH_INTERVAL);
  }
  
  /**
   * Get the appropriate bucket index for a node ID
   * @param {Buffer} nodeId - Node ID
   * @return {number} Bucket index
   * @private
   */
  _getBucketIndex(nodeId) {
    const prefixLength = commonPrefixLength(this.nodeId, nodeId);
    return Math.min(prefixLength, BUCKET_COUNT - 1);
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
    console.log(`Bootstrapping DHT with ${nodes.length} nodes...`);
    
    // Connect to bootstrap nodes
    nodes.forEach(node => {
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
  connect(peerInfo) {
    // With our simplified approach, all IDs are hex strings
    const peerIdHex = peerInfo.id;
    const peerId = peerIdHex;
    
    // Check if already connected
    if (this.peers.has(peerIdHex)) {
      const peer = this.peers.get(peerIdHex);
      
      // If there's signal data, pass it along
      if (peerInfo.signal && peer) {
        peer.signal(peerInfo.signal);
      }
      
      return peer;
    }
    
    // Create new peer connection
    const peer = new Peer({
      nodeId: this.nodeId,
      peerId: peerId,
      initiator: true,
      signal: peerInfo.signal
    });
    
    // Add to peers map
    this.peers.set(peerIdHex, peer);
    
    // Set up event handlers
    this._setupPeerHandlers(peer);
    
    return peer;
  }
  
  /**
   * Set up event handlers for a peer
   * @param {Peer} peer - Peer instance
   * @private
   */
  _setupPeerHandlers(peer) {
    // Forward signal events
    peer.on('signal', (data, peerId) => {
      this.emit('signal', { id: peerId, signal: data });
    });
    // Handle successful connection
    peer.on('connect', peerId => {
      console.log(`Connected to peer: ${peerId}`);
      // Add node to routing table
      this._addNode({
        id: hexToBuffer(peerId),
        host: null,
        port: null
      });
      this.emit('peer:connect', peerId);
      // Send a PING to the peer
      peer.send({
        type: 'PING',
        sender: this.nodeIdHex
      });
      // Replicate relevant key-value pairs to the new peer if it is now among the K closest for any key
      this._replicateToNewPeer(peerId);
    });
    
    // Handle messages
    peer.on('message', (message, peerId) => {
      if (message && message.type && this.messageHandlers[message.type]) {
        this.messageHandlers[message.type](message, peerId);
      }
    });
    
    // Handle disconnect
    peer.on('close', peerId => {
      console.log(`Disconnected from peer: ${peerId}`);
      this.peers.delete(peerId);
      this.emit('peer:disconnect', peerId);
    });
    
    // Handle errors
    peer.on('error', (err, peerId) => {
      console.error(`Error with peer ${peerId}:`, err.message);
      this.emit('peer:error', { peer: peerId, error: err.message });
    });
  }
  
  /**
   * Signal a peer
   * @param {Object} data - Signal data
   * @param {string} data.id - Peer ID (hex)
   * @param {Object} data.signal - WebRTC signal data
   */
  signal(data) {
    if (!data || !data.id || !data.signal) return;
    
    const peerId = data.id;
    
    // Check if we know this peer
    if (this.peers.has(peerId)) {
      this.peers.get(peerId).signal(data.signal);
      return;
    }
    
    // Create new peer if we don't know it
    const peer = new Peer({
      nodeId: this.nodeId,
      peerId: hexToBuffer(peerId),
      initiator: false
    });
    
    this.peers.set(peerId, peer);
    this._setupPeerHandlers(peer);
    peer.signal(data.signal);
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
      port: null
    });
    
    // Respond with a PONG
    peer.send({
      type: 'PONG',
      sender: this.nodeIdHex
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
      port: null
    });
    
    // Find closest nodes to target
    const targetId = hexToBuffer(message.target);
    let nodes = [];
    
    for (let i = 0; i < BUCKET_COUNT; i++) {
      nodes = nodes.concat(this.buckets[i].nodes);
    }
    
    nodes = nodes
      .sort((a, b) => {
        const distA = distance(a.id, targetId);
        const distB = distance(b.id, targetId);
        return compareBuffers(distA, distB);
      })
      .slice(0, K)
      .map(node => ({
        id: bufferToHex(node.id)
      }));
    
    // Send response
    peer.send({
      type: 'FIND_NODE_RESPONSE',
      sender: this.nodeIdHex,
      nodes: nodes
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
      port: null
    });
    // Always hash the incoming key for lookup, unless already a 40-char hex string
    const keyStr = message.key;
    const keyHashHex = /^[a-fA-F0-9]{40}$/.test(keyStr) ? keyStr : bufferToHex(sha1(keyStr));
    // If we have the value, return it
    if (this.storage.has(keyHashHex)) {
      peer.send({
        type: 'FIND_VALUE_RESPONSE',
        sender: this.nodeIdHex,
        key: keyHashHex,
        value: this.storage.get(keyHashHex)
      });
      return;
    }
    // Otherwise, return closest nodes
    // Use the hashed key as the target
    this._handleFindNode({ ...message, target: keyHashHex }, peerId);
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
      port: null
    });
    // Validate and hash the incoming key for storage
    let keyStr = message.key;
    this._logDebug('Received STORE with key:', keyStr, 'from peer:', peerId); // Use _logDebug
    if (typeof keyStr !== "string" || !keyStr.trim() || keyStr === ":" || keyStr === "undefined" || keyStr === "null") {
      // Invalid key, do not store
      console.warn('[DHT._handleStore] Invalid key, not storing:', keyStr);
      peer.send({
        type: 'STORE_RESPONSE',
        sender: this.nodeIdHex,
        success: false,
        key: keyStr
      });
      return;
    }
    let keyHashHex;
    if (/^[a-fA-F0-9]{40}$/.test(keyStr)) {
      keyHashHex = keyStr;
    } else {
      try {
        const hash = await sha1(keyStr);
        keyHashHex = bufferToHex(hash);
        this._logDebug('sha1(keyStr):', hash); // Use _logDebug
        this._logDebug('bufferToHex(sha1(keyStr)):', keyHashHex); // Use _logDebug
      } catch (e) {
        console.error('[DHT._handleStore] Error hashing key:', keyStr, e);
        peer.send({
          type: 'STORE_RESPONSE',
          sender: this.nodeIdHex,
          success: false,
          key: keyStr
        });
        return;
      }
    }
    const value = message.value;
    // Store the key-value pair using the hashed key
    this._logDebug('Storing value under keyHashHex:', keyHashHex, 'original key:', keyStr); // Use _logDebug
    this.storage.set(keyHashHex, value);
    this.storageTimestamps.set(keyHashHex, Date.now());
    // Limit storage size
    if (this.storage.size > MAX_STORE_SIZE) {
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
    // Send response
    peer.send({
      type: 'STORE_RESPONSE',
      sender: this.nodeIdHex,
      success: true,
      key: keyStr // Send back original key for confirmation
    });
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
    for (let i = 0; i < BUCKET_COUNT; i++) {
      nodes = nodes.concat(this.buckets[i].nodes);
    }
    // Ensure unique node IDs and only connected peers
    const seen = new Set();
    nodes = nodes.filter(n => {
      const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
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
      .slice(0, K);
    if (nodes.length === 0) {
      return [];
    }
    const queriedNodes = new Set();
    let closestNodes = [...nodes];
    while (nodes.length > 0) {
      const nodesToQuery = [];
      for (let i = 0; i < nodes.length && nodesToQuery.length < ALPHA; i++) {
        const node = nodes[i];
        const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        if (!queriedNodes.has(nodeIdHex)) {
          nodesToQuery.push(node);
          queriedNodes.add(nodeIdHex);
        }
      }
      if (nodesToQuery.length === 0) break;
      const promises = nodesToQuery.map(async node => {
        const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        const peer = this.peers.get(nodeIdHex);
        if (!peer || !peer.connected) {
          return [];
        }
        return new Promise(resolve => {
          const timeout = setTimeout(() => {
            resolve([]);
          }, 5000);
          const responseHandler = (message, sender) => {
            if (sender !== nodeIdHex || 
                message.type !== 'FIND_NODE_RESPONSE' || 
                !message.nodes) {
              return;
            }
            clearTimeout(timeout);
            peer.removeListener('message', responseHandler);
            const responseNodes = message.nodes
              .filter(n => n && n.id)
              .map(n => ({
                id: hexToBuffer(n.id),
                host: null,
                port: null
              }));
            resolve(responseNodes);
          };
          peer.on('message', responseHandler);
          peer.send({
            type: 'FIND_NODE',
            sender: this.nodeIdHex,
            target: targetHex
          });
        });
      });
      const results = await Promise.all(promises);
      let newNodes = results.flat();
      // Ensure uniqueness and only connected
      const seenNew = new Set();
      newNodes = newNodes.filter(n => {
        const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
        if (seen.has(nIdHex) || seenNew.has(nIdHex)) return false;
        seenNew.add(nIdHex);
        seen.add(nIdHex);
        if (nIdHex === this.nodeIdHex) return false;
        const peer = this.peers.get(nIdHex);
        return peer && peer.connected;
      });
      newNodes.forEach(node => {
        this._addNode(node);
      });
      closestNodes = [...closestNodes, ...newNodes]
        .filter((n, i, arr) => {
          const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
          return arr.findIndex(x => (typeof x.id === 'string' ? x.id : bufferToHex(x.id)) === nIdHex) === i;
        })
        .sort((a, b) => {
          const distA = distance(a.id, target);
          const distB = distance(b.id, target);
          return compareBuffers(distA, distB);
        })
        .slice(0, K);
      nodes = closestNodes.filter(node => {
        const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        return !queriedNodes.has(nodeIdHex);
      });
    }
    return closestNodes.map(node => ({
      id: typeof node.id === 'string' ? node.id : bufferToHex(node.id)
    }));
  }
  
  /**
   * Store a value in the DHT
   * @param {string} key - Key to store
   * @param {*} value - Value to store
   * @return {Promise<boolean>} Success flag
   */
  async put(key, value) {
    const keyStr = typeof key === 'string' ? key : key.toString();
    const keyHash = await sha1(keyStr);
    const keyHashHex = bufferToHex(keyHash);
    this._logDebug('put - key:', keyStr, 'keyHashHex:', keyHashHex); // Use _logDebug
    // Always store locally as well (for redundancy)
    this.storage.set(keyHashHex, value);
    this.storageTimestamps.set(keyHashHex, Date.now());
    // Find K closest nodes to the key
    const nodes = await this.findNode(keyHashHex);
    this._logDebug('put - Closest nodes for key:', nodes.map(n => n.id)); // Use _logDebug
    if (nodes.length === 0) {
      this._logDebug('put - No nodes found, storing locally only.'); // Use _logDebug
      return true;
    }
    // Send STORE to all K closest nodes
    const promises = nodes.map(async node => {
      const peer = this.peers.get(node.id);
      if (!peer || !peer.connected) {
        this._logDebug('put - Peer not connected:', node.id); // Use _logDebug
        return false;
      }
      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          this._logDebug('put - STORE timeout for peer:', node.id); // Use _logDebug
          resolve(false);
        }, 5000); // 5 second timeout for STORE

        const responseHandler = (message, sender) => {
          if (sender !== node.id ||
              message.type !== 'STORE_RESPONSE' ||
              message.key !== keyStr) { // Check original key in response
            return;
          }
          clearTimeout(timeout);
          peer.removeListener('message', responseHandler);
          this._logDebug('put - STORE response from peer:', node.id, 'success:', message.success); // Use _logDebug
          resolve(message.success);
        };

        peer.on('message', responseHandler);
        this._logDebug('put - Sending STORE to peer:', node.id, 'key:', keyStr); // Use _logDebug
        peer.send({
          type: 'STORE',
          sender: this.nodeIdHex,
          key: keyStr, // Send original key
          value: value
        });
      });
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(Boolean).length;
    this._logDebug('put - STORE operation completed. Success count:', successCount, 'out of', nodes.length); // Use _logDebug
    return successCount > 0; // Consider successful if at least one node stored it
  }

  /**
   * Get a value from the DHT
   * @param {string} key - Key to retrieve
   * @return {Promise<*>} Value or null if not found
   */
  async get(key) {
    const keyStr = typeof key === 'string' ? key : key.toString();
    const keyHash = await sha1(keyStr);
    const keyHashHex = bufferToHex(keyHash);
    this._logDebug('get - key:', keyStr, 'keyHashHex:', keyHashHex); // Use _logDebug

    // Check local storage first
    if (this.storage.has(keyHashHex)) {
      this._logDebug('get - Found value locally'); // Use _logDebug
      return this.storage.get(keyHashHex);
    }

    // Iterative lookup similar to findNode
    let nodes = [];
    for (let i = 0; i < BUCKET_COUNT; i++) {
      nodes = nodes.concat(this.buckets[i].nodes);
    }
    // Ensure unique node IDs and only connected peers
    const seen = new Set();
    nodes = nodes.filter(n => {
      const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
      if (seen.has(nIdHex)) return false;
      seen.add(nIdHex);
      if (nIdHex === this.nodeIdHex) return false;
      const peer = this.peers.get(nIdHex);
      return peer && peer.connected;
    });

    nodes = nodes
      .sort((a, b) => {
        const distA = distance(a.id, keyHash);
        const distB = distance(b.id, keyHash);
        return compareBuffers(distA, distB);
      })
      .slice(0, K);

    if (nodes.length === 0) {
      this._logDebug('get - No connected peers to query.'); // Use _logDebug
      return null;
    }

    const queriedNodes = new Set();
    let closestNodes = [...nodes];
    let foundValue = null;
    let nodesToQueryNext = [...nodes]; // Start with initial closest nodes

    while (nodesToQueryNext.length > 0 && foundValue === null) {
      const currentBatch = [];
      for (let i = 0; i < nodesToQueryNext.length && currentBatch.length < ALPHA; i++) {
        const node = nodesToQueryNext[i];
        const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        if (!queriedNodes.has(nodeIdHex)) {
          currentBatch.push(node);
          queriedNodes.add(nodeIdHex);
        }
      }

      if (currentBatch.length === 0) break; // No new nodes to query in this round

      this._logDebug('get - Querying batch:', currentBatch.map(n => (typeof n.id === 'string' ? n.id : bufferToHex(n.id)).substring(0, 4))); // Use _logDebug

      const promises = currentBatch.map(async node => {
        const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        const peer = this.peers.get(nodeIdHex);
        if (!peer || !peer.connected) {
          return { nodes: [] }; // Return empty nodes if peer disconnected
        }

        return new Promise(resolve => {
          const timeout = setTimeout(() => {
            this._logDebug('get - FIND_VALUE timeout for peer:', nodeIdHex); // Use _logDebug
            resolve({ nodes: [] }); // Resolve with empty nodes on timeout
          }, 5000); // 5 second timeout

          const responseHandler = (message, sender) => {
            if (sender !== nodeIdHex ||
                message.type !== 'FIND_VALUE_RESPONSE' ||
                message.key !== keyHashHex) { // Check the hash key in response
              return;
            }
            clearTimeout(timeout);
            peer.removeListener('message', responseHandler);

            if (message.value !== undefined) {
              this._logDebug('get - Received VALUE from peer:', nodeIdHex); // Use _logDebug
              resolve({ value: message.value, source: nodeIdHex });
            } else if (message.nodes) {
              this._logDebug('get - Received NODES from peer:', nodeIdHex, message.nodes.map(n => n.id.substring(0, 4))); // Use _logDebug
              const responseNodes = message.nodes
                .filter(n => n && n.id)
                .map(n => ({
                  id: hexToBuffer(n.id), // Keep as buffer internally for distance calc
                  host: null,
                  port: null
                }));
              resolve({ nodes: responseNodes });
            } else {
              resolve({ nodes: [] }); // Empty response if neither value nor nodes
            }
          };

          peer.on('message', responseHandler);
          this._logDebug('get - Sending FIND_VALUE to peer:', nodeIdHex, 'keyHash:', keyHashHex); // Use _logDebug
          peer.send({
            type: 'FIND_VALUE',
            sender: this.nodeIdHex,
            key: keyHashHex // Send the hash key
          });
        });
      });

      const results = await Promise.all(promises);
      let newPotentialNodes = [];

      for (const result of results) {
        if (result.value !== undefined) {
          foundValue = result.value;
          const sourcePeerId = result.source;
          this._logDebug('get - Found value from peer:', sourcePeerId); // Use _logDebug

          // Cache the value locally after finding it
          this.storage.set(keyHashHex, foundValue);
          this.storageTimestamps.set(keyHashHex, Date.now());
          this._logDebug('get - Cached value locally.'); // Use _logDebug

          // Optimization: Store the value on the closest node that *didn't* have it
          const closestNodeWithoutValue = closestNodes
            .find(n => (typeof n.id === 'string' ? n.id : bufferToHex(n.id)) !== sourcePeerId);

          if (closestNodeWithoutValue) {
            const nodeToStoreOnId = typeof closestNodeWithoutValue.id === 'string' ? closestNodeWithoutValue.id : bufferToHex(closestNodeWithoutValue.id);
            const peerToStoreOn = this.peers.get(nodeToStoreOnId);
            if (peerToStoreOn && peerToStoreOn.connected) {
              this._logDebug('get - Caching value on closer peer:', nodeToStoreOnId.substring(0, 4)); // Use _logDebug
              peerToStoreOn.send({
                type: 'STORE',
                sender: this.nodeIdHex,
                key: keyStr, // Send original key for STORE
                value: foundValue
              });
            }
          }
          break; // Exit loop once value is found
        }
        if (result.nodes) {
          newPotentialNodes = newPotentialNodes.concat(result.nodes);
        }
      }

      if (foundValue !== null) break; // Exit outer loop if value found

      // Process new nodes found
      const newlyDiscoveredNodes = [];
      const seenNew = new Set(); // Track nodes added in this iteration
      newPotentialNodes.forEach(node => {
        const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        // Add only if not self, not already seen/queried, and connected
        if (nodeIdHex !== this.nodeIdHex && !queriedNodes.has(nodeIdHex) && !seen.has(nodeIdHex) && !seenNew.has(nodeIdHex)) {
           const peer = this.peers.get(nodeIdHex);
           if (peer && peer.connected) {
             this._addNode(node); // Add to our routing table
             newlyDiscoveredNodes.push(node);
             seenNew.add(nodeIdHex);
             seen.add(nodeIdHex); // Add to overall seen set
           }
        }
      });

      // Update closestNodes list and determine next nodes to query
      closestNodes = [...closestNodes, ...newlyDiscoveredNodes]
        .filter((n, i, arr) => { // Unique nodes
          const nIdHex = typeof n.id === 'string' ? n.id : bufferToHex(n.id);
          return arr.findIndex(x => (typeof x.id === 'string' ? x.id : bufferToHex(x.id)) === nIdHex) === i;
        })
        .sort((a, b) => { // Sort by distance to key
          const distA = distance(a.id, keyHash);
          const distB = distance(b.id, keyHash);
          return compareBuffers(distA, distB);
        })
        .slice(0, K); // Keep only K closest

      // Find nodes from the updated closest list that haven't been queried yet
      nodesToQueryNext = closestNodes.filter(node => {
        const nodeIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        return !queriedNodes.has(nodeIdHex);
      });

      this._logDebug('get - Iteration complete. Closest nodes:', closestNodes.map(n=>(typeof n.id === 'string' ? n.id : bufferToHex(n.id)).substring(0,4)), 'Next to query:', nodesToQueryNext.map(n=>(typeof n.id === 'string' ? n.id : bufferToHex(n.id)).substring(0,4))); // Use _logDebug

    } // End while loop

    this._logDebug('get - Lookup finished. Value found:', foundValue !== null); // Use _logDebug
    return foundValue;
  }

  // ... existing code ...

  /**
   * Replicate data to K closest nodes for each key
   * @private
   */
  _replicateData() {
    this._logDebug('Starting data replication...'); // Use _logDebug
    this.storage.forEach(async (value, keyHashHex) => {
      const keyHash = hexToBuffer(keyHashHex);
      const nodes = await this.findNode(keyHashHex); // Find current K closest
      this._logDebug(`Replicating key ${keyHashHex.substring(0,4)} to ${nodes.length} nodes`); // Use _logDebug
      nodes.forEach(node => {
        const peer = this.peers.get(node.id);
        if (peer && peer.connected && node.id !== this.nodeIdHex) { // Don't send to self
          // We need the original key to send STORE, but we only have the hash.
          // This is a limitation of simple replication without storing original keys.
          // A better approach would involve storing { originalKey, value, timestamp }
          // For now, we can't reliably replicate without the original key.
          // console.warn(`Cannot replicate key ${keyHashHex} without original key.`);

          // Alternative (if we decide to STORE using hash as key - less user friendly):
          /*
          this._logDebug(`Sending STORE (replication) for ${keyHashHex.substring(0,4)} to ${node.id.substring(0,4)}`);
          peer.send({
            type: 'STORE',
            sender: this.nodeIdHex,
            key: keyHashHex, // Send hash as key
            value: value
          });
          */
        }
      });
    });
  }

  /**
   * Republish data originally stored by this node
   * @private
   */
  _republishData() {
    // This requires tracking which keys were originally published by this node.
    // For simplicity, we'll republish everything this node currently holds.
    this._logDebug('Starting data republication...'); // Use _logDebug
    this.storage.forEach((value, keyHashHex) => {
      // Again, we face the issue of not having the original key.
      // We'd need to modify the `put` method to store the original key alongside the hash/value
      // or store a flag indicating this node is the originator.
      this._logDebug(`Attempting to republish key ${keyHashHex.substring(0,4)} (needs original key)`); // Use _logDebug
      // Example if original key was stored:
      // const originalKey = this.getOriginalKeyForHash(keyHashHex); // Hypothetical function
      // if (originalKey) {
      //   this.put(originalKey, value);
      // }
    });
  }

  /**
   * Replicate relevant data to a newly connected peer
   * @param {string} newPeerIdHex - The ID of the newly connected peer
   * @private
   */
  async _replicateToNewPeer(newPeerIdHex) {
    this._logDebug(`Checking replication needs for new peer: ${newPeerIdHex.substring(0,4)}`); // Use _logDebug
    const newPeerIdBuffer = hexToBuffer(newPeerIdHex);

    for (const [keyHashHex, value] of this.storage.entries()) {
      const keyHashBuffer = hexToBuffer(keyHashHex);
      const closestNodes = await this.findNode(keyHashHex); // Find K closest nodes *now*

      // Check if the new peer is among the K closest for this key
      const isNewPeerClosest = closestNodes.some(node => node.id === newPeerIdHex);

      if (isNewPeerClosest) {
        const peer = this.peers.get(newPeerIdHex);
        if (peer && peer.connected) {
          // Again, the limitation of not having the original key prevents direct STORE.
          this._logDebug(`New peer ${newPeerIdHex.substring(0,4)} is close to key ${keyHashHex.substring(0,4)}, replication needed (requires original key).`); // Use _logDebug
          // If original key was available:
          // const originalKey = this.getOriginalKeyForHash(keyHashHex);
          // if (originalKey) {
          //   peer.send({ type: 'STORE', sender: this.nodeIdHex, key: originalKey, value: value });
          // }
        }
      }
    }
  }

}

export default DHT;