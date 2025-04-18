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
  constructor(localNodeId) {
    this.localNodeId = localNodeId;
    this.nodes = [];
  }
  
  /**
   * Add a node to the bucket
   * @param {Object} node - Node to add
   * @return {boolean} True if node was added
   */
  add(node) {
    // Don't add ourselves
    if (node.id === this.localNodeId) {
      return false;
    }
    
    // Check if node already exists
    const nodeIndex = this.nodes.findIndex(n => 
      n.id === node.id
    );
    
    if (nodeIndex >= 0) {
      // Move existing node to the end (most recently seen)
      const existingNode = this.nodes[nodeIndex];
      this.nodes.splice(nodeIndex, 1);
      this.nodes.push(existingNode);
      return false;
    }
    
    // Add new node if bucket not full
    if (this.nodes.length < K) {
      this.nodes.push(node);
      return true;
    }
    
    // Bucket full, can't add
    return false;
  }
  
  /**
   * Remove a node from the bucket
   * @param {Buffer} nodeId - ID of node to remove
   * @return {boolean} True if node was removed
   */
  remove(nodeId) {
    const nodeIndex = this.nodes.findIndex(n => 
      n.id === nodeId
    );
    
    if (nodeIndex >= 0) {
      this.nodes.splice(nodeIndex, 1);
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
    return [...this.nodes]
      .sort((a, b) => {
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
      // Initialize node ID (always string-based with our simplified approach)
      this.nodeId = options.nodeId || await generateRandomID();
      
      // We're already using hex strings, so no conversion needed
      this.nodeIdHex = this.nodeId;
      
      // Initialize routing table (k-buckets)
      this.buckets = Array(BUCKET_COUNT).fill().map(() => new KBucket(this.nodeId));
      
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
      
      // Log node creation
      console.log(`DHT node created with ID: ${this.nodeIdHex}`);
      
      // Emit ready event with the node ID
      this.emit('ready', this.nodeIdHex);
    } catch (error) {
      console.error('Error initializing DHT node:', error);
      this.emit('error', error);
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
    
    const key = message.key;
    
    // If we have the value, return it
    if (this.storage.has(key)) {
      peer.send({
        type: 'FIND_VALUE_RESPONSE',
        sender: this.nodeIdHex,
        key: key,
        value: this.storage.get(key)
      });
      return;
    }
    
    // Otherwise, return closest nodes
    this._handleFindNode(message, peerId);
  }
  
  /**
   * Handle a STORE message
   * @param {Object} message - Message object
   * @param {string} peerId - Sender peer ID
   * @private
   */
  _handleStore(message, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    // Add sender to routing table
    this._addNode({
      id: hexToBuffer(message.sender),
      host: null,
      port: null
    });
    
    const key = message.key;
    const value = message.value;
    
    // Store the key-value pair
    this.storage.set(key, value);
    this.storageTimestamps.set(key, Date.now());
    
    // Limit storage size
    if (this.storage.size > MAX_STORE_SIZE) {
      // Get oldest key
      let oldestKey = null;
      let oldestTime = Infinity;
      
      for (const [k, time] of this.storageTimestamps.entries()) {
        if (time < oldestTime) {
          oldestTime = time;
          oldestKey = k;
        }
      }
      
      // Remove oldest entry
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
      key: key
    });
  }
  
  /**
   * Find a node in the DHT
   * @param {string|Buffer} targetId - Target node ID
   * @return {Promise<Array>} Closest nodes to the target
   */
  async findNode(targetId) {
    // With our simplified approach, all IDs are hex strings
    const targetHex = targetId;
    const target = targetId;
    
    // Initialize nodes set with closest nodes from our routing table
    let nodes = [];
    for (let i = 0; i < BUCKET_COUNT; i++) {
      nodes = nodes.concat(this.buckets[i].nodes);
    }
    
    nodes = nodes
      .sort((a, b) => {
        const distA = distance(a.id, target);
        const distB = distance(b.id, target);
        return compareBuffers(distA, distB);
      })
      .slice(0, K);
    
    // If no nodes in routing table, return empty result
    if (nodes.length === 0) {
      return [];
    }
    
    // Track queried nodes and closest nodes found
    const queriedNodes = new Set();
    let closestNodes = [...nodes];
    
    // Use iterative parallel lookup
    while (nodes.length > 0) {
      // Take up to ALPHA unqueried nodes
      const nodesToQuery = [];
      for (let i = 0; i < nodes.length && nodesToQuery.length < ALPHA; i++) {
        const node = nodes[i];
        const nodeIdHex = bufferToHex(node.id);
        
        if (!queriedNodes.has(nodeIdHex)) {
          nodesToQuery.push(node);
          queriedNodes.add(nodeIdHex);
        }
      }
      
      if (nodesToQuery.length === 0) break;
      
      // Query selected nodes in parallel
      const promises = nodesToQuery.map(async node => {
        const nodeIdHex = bufferToHex(node.id);
        const peer = this.peers.get(nodeIdHex);
        
        if (!peer || !peer.connected) {
          return [];
        }
        
        return new Promise(resolve => {
          // Set timeout
          const timeout = setTimeout(() => {
            resolve([]);
          }, 5000);
          
          // Create one-time response handler
          const responseHandler = (message, sender) => {
            if (sender !== nodeIdHex || 
                message.type !== 'FIND_NODE_RESPONSE' || 
                !message.nodes) {
              return;
            }
            
            // Remove handler and timeout
            clearTimeout(timeout);
            peer.removeListener('message', responseHandler);
            
            // Process response nodes
            const responseNodes = message.nodes
              .filter(n => n && n.id)
              .map(n => ({
                id: hexToBuffer(n.id),
                host: null,
                port: null
              }));
            
            resolve(responseNodes);
          };
          
          // Send query
          peer.on('message', responseHandler);
          peer.send({
            type: 'FIND_NODE',
            sender: this.nodeIdHex,
            target: targetHex
          });
        });
      });
      
      // Wait for all queries to complete
      const results = await Promise.all(promises);
      const newNodes = results.flat();
      
      // Add new nodes to routing table
      newNodes.forEach(node => {
        this._addNode(node);
      });
      
      // Update closest nodes
      closestNodes = [...closestNodes, ...newNodes]
        .sort((a, b) => {
          const distA = distance(a.id, target);
          const distB = distance(b.id, target);
          return compareBuffers(distA, distB);
        })
        .slice(0, K);
      
      // Update nodes to query
      nodes = closestNodes.filter(node => {
        const nodeIdHex = bufferToHex(node.id);
        return !queriedNodes.has(nodeIdHex);
      });
    }
    
    return closestNodes.map(node => ({
      id: bufferToHex(node.id)
    }));
  }
  
  /**
   * Store a value in the DHT
   * @param {string} key - Key to store
   * @param {*} value - Value to store
   * @return {Promise<boolean>} Success flag
   */
  async put(key, value) {
    // Convert key to string if needed
    const keyStr = typeof key === 'string' ? key : key.toString();
    
    // Hash the key to get target ID
    const keyHash = sha1(keyStr);
    const keyHashHex = bufferToHex(keyHash);
    
    // First, find nodes closest to the key
    const nodes = await this.findNode(keyHash);
    
    if (nodes.length === 0) {
      // Store locally if no nodes found
      this.storage.set(keyHashHex, value);
      this.storageTimestamps.set(keyHashHex, Date.now());
      return true;
    }
    
    // Store on closest nodes
    const promises = nodes.map(async node => {
      const peer = this.peers.get(node.id);
      
      if (!peer || !peer.connected) {
        return false;
      }
      
      return new Promise(resolve => {
        // Set timeout
        const timeout = setTimeout(() => {
          resolve(false);
        }, 5000);
        
        // Create one-time response handler
        const responseHandler = (message, sender) => {
          if (sender !== node.id || 
              message.type !== 'STORE_RESPONSE' || 
              message.key !== keyHashHex) {
            return;
          }
          
          // Remove handler and timeout
          clearTimeout(timeout);
          peer.removeListener('message', responseHandler);
          
          resolve(message.success === true);
        };
        
        // Send store request
        peer.on('message', responseHandler);
        peer.send({
          type: 'STORE',
          sender: this.nodeIdHex,
          key: keyHashHex,
          value: value
        });
      });
    });
    
    // Wait for all stores to complete
    const results = await Promise.all(promises);
    
    // Store locally as well
    this.storage.set(keyHashHex, value);
    this.storageTimestamps.set(keyHashHex, Date.now());
    
    // Consider successful if at least one node stored it
    return results.some(r => r === true);
  }
  
  /**
   * Retrieve a value from the DHT
   * @param {string} key - Key to retrieve
   * @return {Promise<*>} Retrieved value or null
   */
  async get(key) {
    // Convert key to string if needed
    const keyStr = typeof key === 'string' ? key : key.toString();
    
    // Hash the key to get target ID
    const keyHash = sha1(keyStr);
    const keyHashHex = bufferToHex(keyHash);
    
    // Check local storage first
    if (this.storage.has(keyHashHex)) {
      return this.storage.get(keyHashHex);
    }
    
    // Find nodes closest to the key
    const nodes = await this.findNode(keyHash);
    
    if (nodes.length === 0) {
      return null;
    }
    
    // Track queried nodes
    const queriedNodes = new Set();
    
    // Use iterative parallel lookup
    for (let i = 0; i < nodes.length; i += ALPHA) {
      // Take up to ALPHA unqueried nodes
      const nodesToQuery = [];
      for (let j = 0; j < ALPHA && i + j < nodes.length; j++) {
        const node = nodes[i + j];
        
        if (!queriedNodes.has(node.id)) {
          nodesToQuery.push(node);
          queriedNodes.add(node.id);
        }
      }
      
      if (nodesToQuery.length === 0) break;
      
      // Query selected nodes in parallel
      const promises = nodesToQuery.map(async node => {
        const peer = this.peers.get(node.id);
        
        if (!peer || !peer.connected) {
          return null;
        }
        
        return new Promise(resolve => {
          // Set timeout
          const timeout = setTimeout(() => {
            resolve(null);
          }, 5000);
          
          // Create one-time response handler
          const responseHandler = (message, sender) => {
            if (sender !== node.id) {
              return;
            }
            
            // Check if it's a value response
            if (message.type === 'FIND_VALUE_RESPONSE' && 
                message.key === keyHashHex) {
              // Remove handler and timeout
              clearTimeout(timeout);
              peer.removeListener('message', responseHandler);
              
              // Store value locally
              this.storage.set(keyHashHex, message.value);
              this.storageTimestamps.set(keyHashHex, Date.now());
              
              resolve(message.value);
              return;
            }
            
            // If it's a node response, just resolve null
            if (message.type === 'FIND_NODE_RESPONSE') {
              clearTimeout(timeout);
              peer.removeListener('message', responseHandler);
              resolve(null);
            }
          };
          
          // Send query
          peer.on('message', responseHandler);
          peer.send({
            type: 'FIND_VALUE',
            sender: this.nodeIdHex,
            key: keyHashHex
          });
        });
      });
      
      // Wait for all queries to complete
      const results = await Promise.all(promises);
      
      // Return first non-null result
      for (const result of results) {
        if (result !== null) {
          return result;
        }
      }
    }
    
    // Not found
    return null;
  }
  
  /**
   * Replicate data to other nodes
   * @private
   */
  async _replicateData() {
    // Skip if no data to replicate
    if (this.storage.size === 0) return;
    
    for (const [key, value] of this.storage.entries()) {
      // Find nodes closest to the key
      const keyHash = hexToBuffer(key);
      const nodes = await this.findNode(keyHash);
      
      // Replicate to closest nodes
      for (const node of nodes) {
        const peer = this.peers.get(node.id);
        
        if (peer && peer.connected) {
          peer.send({
            type: 'STORE',
            sender: this.nodeIdHex,
            key: key,
            value: value
          });
        }
      }
    }
  }
  
  /**
   * Republish all stored data
   * @private
   */
  async _republishData() {
    // Skip if no data to republish
    if (this.storage.size === 0) return;
    
    for (const [key, value] of this.storage.entries()) {
      // Update timestamp
      this.storageTimestamps.set(key, Date.now());
      
      // Re-store value
      await this.put(key, value);
    }
  }
  
  /**
   * Close the DHT and all connections
   */
  close() {
    // Clear maintenance intervals
    clearInterval(this.replicateInterval);
    clearInterval(this.republishInterval);
    
    // Close all peer connections
    for (const peer of this.peers.values()) {
      peer.destroy();
    }
    
    this.peers.clear();
    this.emit('close');
  }
}

export default DHT;
