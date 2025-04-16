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
   * @param {Buffer|string} targetId - Target node ID (Buffer or hex string)
   * @param {number} count - Maximum number of nodes to return
   * @return {Array} Array of closest nodes with Peer references
   */
  getClosestNodes(targetId, count = K) {
    // Ensure we have a proper target ID to work with
    let targetHex;
    
    // Convert to hex string format for consistent comparison
    if (typeof targetId === 'string') {
      targetHex = targetId;
    } else if (targetId && (targetId instanceof Uint8Array || 
             (typeof Buffer !== 'undefined' && Buffer.isBuffer(targetId)))) {
      targetHex = bufferToHex(targetId);
    } else {
      console.error('Invalid targetId type:', typeof targetId);
      targetHex = String(targetId); // Fallback conversion
    }
    
    console.log(`Finding closest nodes to ${targetHex.substring(0, 8)}...`);
    
    // Start with nodes from our buckets
    const nodesWithPeers = [];
    
    // First collect all nodes from buckets
    for (let i = 0; i < BUCKET_COUNT; i++) {
      for (const node of this.buckets[i].nodes) {
        // Only include nodes that we can communicate with
        const peerInstance = this.peers.get(node.id);
        if (peerInstance && (peerInstance.connected || typeof peerInstance.send === 'function')) {
          nodesWithPeers.push({
            id: node.id,
            peer: peerInstance
          });
        }
      }
    }
    
    // Then include any connected peers not already in buckets
    for (const [peerId, peerInstance] of this.peers.entries()) {
      if (peerInstance && (peerInstance.connected || typeof peerInstance.send === 'function')) {
        // Check if this peer is already included
        const alreadyIncluded = nodesWithPeers.some(node => node.id === peerId);
        if (!alreadyIncluded && peerId !== this.nodeIdHex) {
          nodesWithPeers.push({
            id: peerId,
            peer: peerInstance
          });
        }
      }
    }
    
    console.log(`Found ${nodesWithPeers.length} active peers/nodes for DHT operations`);
    
    // Sort by XOR distance to target and take top 'count'
    return nodesWithPeers
      .sort((a, b) => {
        const distA = distance(a.id, targetHex);
        const distB = distance(b.id, targetHex);
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
      
      // Set up message handlers for DHT protocol
      this.messageHandlers = {
        'PING': this._handlePing.bind(this),
        'STORE': this._handleStore.bind(this),
        'FIND_NODE': this._handleFindNode.bind(this),
        'FIND_VALUE': this._handleFindValue.bind(this)
      };
      
      console.log('DHT message handlers initialized');
      
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
   * @param {string|Object} peerInfo - Peer ID string or peer information object
   * @param {string} [peerInfo.id] - Peer ID if peerInfo is an object
   * @param {Object} [peerInfo.signal] - Signaling data (optional)
   * @param {boolean} [peerInfo.initiator] - Whether this peer is the initiator
   * @return {Peer} Peer instance
   */
  connect(peerInfo) {
    // Handle if peerInfo is just a string (the peer ID)
    let peerIdHex;
    let signalData;
    let isInitiator = true; // Default behavior
    
    if (typeof peerInfo === 'string') {
      peerIdHex = peerInfo;
      signalData = null;
    } else {
      // With our simplified approach, all IDs are hex strings
      peerIdHex = peerInfo.id;
      signalData = peerInfo.signal || null;
      isInitiator = peerInfo.initiator !== false; // Default to true unless explicitly false
    }
  
    console.log(`DHT.connect called for peer: ${peerIdHex.substring(0, 8)}... (initiator=${isInitiator})`);
    
    // Don't connect to self
    if (peerIdHex === this.nodeIdHex) {
      console.log('Skipping connection to self');
      return null;
    }
    
    // This is critical - immediately add the peer to our routing table
    // so that it gets discovered during node lookups
    console.log(`Adding peer ${peerIdHex.substring(0, 8)}... to routing table`);
    this._addNode({
      id: peerIdHex, // Already a string in our implementation
      host: null, 
      port: null
    });
    
    // ALWAYS destroy existing peer connections to prevent state conflicts
    // This is critical for reliable WebRTC connections
    if (this.peers.has(peerIdHex)) {
      const existingPeer = this.peers.get(peerIdHex);
      console.log(`Destroying existing peer ${peerIdHex.substring(0, 8)}... (connected=${existingPeer.connected})`);
      
      try {
        // Cleanup any existing keepalive intervals
        if (existingPeer._keepAliveInterval) {
          clearInterval(existingPeer._keepAliveInterval);
          existingPeer._keepAliveInterval = null;
        }
        
        // Properly destroy the peer to clean up WebRTC resources
        existingPeer.destroy();
        this.peers.delete(peerIdHex);
      } catch (err) {
        console.error(`Error cleaning up existing peer: ${err.message}`);
      }
    }
    
    console.log(`Creating brand new peer connection to ${peerIdHex.substring(0, 8)}... as ${isInitiator ? 'INITIATOR' : 'RESPONDER'}`);
    
    try {
      // Create new peer connection with explicit initiator flag
      const peer = new Peer({
        nodeId: this.nodeId,
        peerId: peerIdHex,
        initiator: isInitiator
      });
      
      // Add to peers map immediately
      this.peers.set(peerIdHex, peer);
      
      // Set up event handlers
      this._setupPeerHandlers(peer);
      
      // If there's signal data, pass it along after a short delay
      // This helps ensure the peer is fully initialized
      if (signalData) {
        console.log(`Will pass signal data to peer ${peerIdHex.substring(0, 8)}... after brief delay`);
        setTimeout(() => {
          if (peer && !peer.destroyed) {
            console.log(`Now passing initial signal data to peer ${peerIdHex.substring(0, 8)}...`);
            peer.signal(signalData);
          }
        }, 100);
      }
      
      return peer;
    } catch (err) {
      console.error(`Error creating peer connection to ${peerIdHex.substring(0, 8)}:`, err);
      this.peers.delete(peerIdHex); // Clean up if creation fails
      throw err;
    }
  }
  
  /**
   * Set up event handlers for a peer
   * @param {Peer} peer - Peer instance
   * @private
   */
  _setupPeerHandlers(peer) {
    // Forward signal events
    peer.on('signal', (data) => {
      console.log(`DHT: Got signal event from peer ${peer.peerIdHex.substring(0, 8)}...`, data);
      this.emit('signal', { 
        targetNodeId: peer.peerIdHex,
        signal: data 
      });
    });
    
    // Handle successful connection
    peer.on('connect', peerId => {
      console.log(`[DHT] Connection established with peer: ${peerId}`);
      
      // Add node to routing table
      this._addNode({
        id: peerId, // Already a string in our implementation
        host: null,
        port: null
      });
      
      // Set up keepalive - send a PING every 10 seconds to maintain connection
      peer._keepAliveInterval = setInterval(() => {
        if (peer.connected) {
          console.log(`Sending keepalive PING to peer ${peerId.substring(0, 8)}...`);
          try {
            peer.send({
              type: 'PING',
              sender: this.nodeIdHex
            });
          } catch (err) {
            console.error(`Failed to send keepalive PING to ${peerId.substring(0, 8)}: ${err.message}`);
          }
        }
      }, 10000);
      
      this.emit('peer:connect', peerId);
    });
    
    // Handle message events
    peer.on('message', (message, peerId) => {
      console.log(`Received ${message.type || 'unknown'} message from ${peerId.substring(0, 8)}...`);
      
      // Automatically respond to PING messages
      if (message && message.type === 'PING') {
        try {
          peer.send({
            type: 'PONG',
            sender: this.nodeIdHex
          });
          console.log(`Responded to PING from ${peerId.substring(0, 8)} with PONG`);
        } catch (err) {
          console.error(`Error sending PONG response: ${err.message}`);
        }
      }
      
      if (message && message.type && this.messageHandlers[message.type]) {
        try {
          this.messageHandlers[message.type](message, peerId);
        } catch (err) {
          console.error(`Error handling ${message.type} message:`, err.message);
        }
      }
    });
    
    // Handle disconnect
    peer.on('close', peerId => {
      console.log(`[DHT] Disconnected from peer: ${peerId}`);
      
      // Clear the keepalive interval
      if (peer._keepAliveInterval) {
        clearInterval(peer._keepAliveInterval);
        peer._keepAliveInterval = null;
      }
      
      // Remove from peers map
      this.peers.delete(peerId);
      
      // Try to reconnect after a delay
      setTimeout(() => {
        if (!this.peers.has(peerId) && peerId !== this.nodeIdHex) {
          console.log(`[DHT] Attempting to reconnect to peer: ${peerId}`);
          this.connect(peerId);
        }
      }, 5000);
      
      this.emit('peer:disconnect', peerId);
    });
    
    // Handle errors
    peer.on('error', (err, peerId) => {
      console.error(`[DHT] Error with peer ${peerId}:`, err.message);
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
    if (!data || !data.id || !data.signal) {
      console.error('Invalid signal data:', data);
      return;
    }
    
    const peerId = data.id;
    console.log(`Processing signal for peer: ${peerId.substring(0, 8)}...`);
    
    // Check if we know this peer
    if (this.peers.has(peerId)) {
      console.log(`Found existing peer ${peerId.substring(0, 8)}..., passing signal`);
      this.peers.get(peerId).signal(data.signal);
      return;
    }
    
    // Create new peer if we don't know it
    console.log(`Creating new peer for ${peerId.substring(0, 8)}... as non-initiator`);
    const peer = new Peer({
      nodeId: this.nodeId,
      peerId: peerId, // Use the string ID directly, don't convert to buffer
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
      id: message.sender, // Already a string in our implementation
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
      id: message.sender, // Already a string in our implementation
      host: null,
      port: null
    });
    
    // Find closest nodes to target
    const targetId = message.target; // Already a string in our implementation
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
        id: node.id
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
    if (!peer) {
      console.error(`Cannot handle FIND_VALUE - peer ${peerId.substring(0, 8)} not found`);
      return;
    }
    
    // Add sender to routing table
    this._addNode({
      id: message.sender, // Already a string in our implementation
      host: null,
      port: null
    });
    
    const key = message.key;
    const originalKey = message.originalKey || key;
    console.log(`Looking up key ${key.substring(0, 8)}... (original: ${originalKey}) for peer ${peerId.substring(0, 8)}...`);
    
    // Look for the value in different ways to maximize chances of finding it
    let value = null;
    
    // 1. Check if we have it using the exact requested key
    if (this.storage.has(key)) {
      value = this.storage.get(key);
      console.log(`Found value for exact key ${key.substring(0, 8)}...`);
    } 
    // 2. Check if we have it with original key (unhashed) if different
    else if (originalKey && originalKey !== key && this.storage.has(originalKey)) {
      value = this.storage.get(originalKey);
      console.log(`Found value using original key ${originalKey}`);
    }
    // 3. Check if we have a key mapping that can help us find it
    else if (this.keyMapping && this.keyMapping.has(originalKey)) {
      const mappedKey = this.keyMapping.get(originalKey);
      if (this.storage.has(mappedKey)) {
        value = this.storage.get(mappedKey);
        console.log(`Found value using key mapping ${originalKey} -> ${mappedKey}`);
      }
    }
    
    // If we found a value by any method, return it
    if (value !== null) {
      console.log(`Sending found value for key to ${peerId.substring(0, 8)}...`);
      peer.send({
        type: 'FIND_VALUE_RESPONSE',
        sender: this.nodeIdHex,
        key: key,
        originalKey: originalKey,
        value: value
      });
      return;
    }
    
    console.log(`Value for key ${key.substring(0, 8)}... not found locally by any method`);
    
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
    if (!peer) {
      console.error(`Cannot handle STORE - peer ${peerId.substring(0, 8)} not found`);
      return;
    }
    
    // Add sender to routing table
    this._addNode({
      id: message.sender, // Already a string in our implementation
      host: null,
      port: null
    });
    
    const key = message.key;
    const value = message.value;
    const originalKey = message.originalKey || key;
    const timestamp = message.timestamp || Date.now();
    
    console.log(`Received STORE for key=${originalKey} (hash: ${key.substring(0, 8)}...) from ${peerId.substring(0, 8)}...`);
    console.log(`Storing value: ${JSON.stringify(value).substring(0, 100)}${JSON.stringify(value).length > 100 ? '...' : ''}`);
    
    // Initialize key mapping if it doesn't exist
    if (!this.keyMapping) this.keyMapping = new Map();
    
    // Store both the key hash and original key mapping
    this.keyMapping.set(originalKey, key);
    
    // Store the key-value pair with timestamp
    this.storage.set(key, value);
    this.storageTimestamps.set(key, timestamp);
    
    // For backward compatibility and direct key lookup, also store by original key
    this.storage.set(originalKey, value);
    this.storageTimestamps.set(originalKey, timestamp);
    
    // Log storage contents for debugging
    console.log(`DHT storage now contains ${this.storage.size} items`);
    
    // Only propagate if this isn't already a propagated message
    // This prevents infinite loops of value propagation between peers
    if (!message.propagated) {
      // Re-propagate this value to all other connected peers
      // This ensures values spread through the entire network
      this._propagateStoredValue(key, value, originalKey, peerId);
    }
    
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
    console.log(`Sending STORE_RESPONSE to ${peerId.substring(0, 8)}... for key ${key.substring(0, 8)}...`);
    try {
      peer.send({
        type: 'STORE_RESPONSE',
        sender: this.nodeIdHex,
        success: true,
        key: key
      });
    } catch (err) {
      console.error(`Failed to send STORE_RESPONSE: ${err.message}`);
    }
  }
  
  /**
   * Find node in the DHT
   * @param {string|Buffer} targetId - Target node ID to find
   * @return {Promise<Array>} Array of found nodes
   */
  async findNode(targetId) {
    // Work with consistent hex string IDs throughout
    let targetHex;
    
    // Check if it's already a string
    if (typeof targetId === 'string') {
      targetHex = targetId;
    } 
    // Check for Buffer or Uint8Array in a browser-safe way
    else if (targetId && (targetId instanceof Uint8Array || 
             (typeof Buffer !== 'undefined' && Buffer.isBuffer(targetId)))) {
      targetHex = bufferToHex(targetId);
    } 
    // Fallback for other types
    else {
      console.error('Invalid targetId type:', typeof targetId);
      targetHex = String(targetId); // Fallback conversion
    }
    
    console.log(`Finding nodes closest to ${targetHex.substring(0, 8)}...`);
    
    // *** IMPORTANT: Always include ALL connected peers in our search results ***
    // This is critical for proper DHT operation in a browser environment
    // where the number of connected peers is usually small
    
    // First collect nodes from buckets
    let nodesFromBuckets = [];
    for (let i = 0; i < BUCKET_COUNT; i++) {
      nodesFromBuckets = nodesFromBuckets.concat(this.buckets[i].nodes);
    }
    
    console.log(`Found ${nodesFromBuckets.length} nodes in buckets`);
    
    // Then collect all directly connected peers
    const connectedPeers = [];
    
    // Debug peers map
    console.log(`Debug - Peers map contains ${this.peers.size} entries`);    
    
    // CRITICAL: First make sure we actually detect all connected peers correctly
    for (const [peerId, peer] of this.peers.entries()) {
      console.log(`Debug - Peer ${peerId.substring(0, 8)}... connected=${peer?.connected || false}`);
      
      // Some browser WebRTC implementations may not set the connected flag as expected
      // So we also check if the peer has a send method as an additional check
      const isPeerConnected = peer && (peer.connected || typeof peer.send === 'function');
      
      if (isPeerConnected && peerId !== this.nodeIdHex) {
        console.log(`Adding connected peer ${peerId.substring(0, 8)}... to search results`);
        
        // Ensure this peer is in our bucket for future lookups
        this._addNode({
          id: peerId, // Already a string in our implementation
          host: null,
          port: null
        });
        
        // Include in our connected peers list
        connectedPeers.push({
          id: peerId, // Already a string in our implementation
          host: null,
          port: null,
          // CRITICAL FIX: Store peer reference directly in the result
          peer: peer
        });
      }
    }
    
    console.log(`Found ${connectedPeers.length} directly connected peers`);
    
    // Combine and deduplicate nodes from both sources
    let allNodes = [...nodesFromBuckets];
    
    // Add any connected peers that aren't already in our buckets
    for (const connectedPeer of connectedPeers) {
      if (!nodesFromBuckets.some(node => node.id === connectedPeer.id)) {
        allNodes.push(connectedPeer);
      }
    }
    
    // Sort by distance and take K closest
    const sortedNodes = allNodes
      .sort((a, b) => {
        const distA = distance(a.id, targetHex);
        const distB = distance(b.id, targetHex);
        return compareBuffers(distA, distB);
      })
      .slice(0, K);
      
    console.log(`Returning ${sortedNodes.length} total nodes (combined from buckets and direct connections)`);
    
    // If no nodes found, return empty array
    if (sortedNodes.length === 0) {
      return [];
    }
    
    // Return the K closest nodes
    return sortedNodes.map(node => ({
      id: node.id,
      host: node.host || null,
      port: node.port || null,
      // CRITICAL FIX: Include the peer reference in the returned nodes
      peer: node.peer || this.peers.get(node.id)
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
    
    console.log(`PUT operation: key=${keyStr}, hashed to ${keyHashHex.substring(0, 8)}...`);
    
    // Store locally with both original key and hashed key
    this.storage.set(keyStr, value);
    this.storageTimestamps.set(keyStr, Date.now());
    
    this.storage.set(keyHashHex, value);
    this.storageTimestamps.set(keyHashHex, Date.now());
    
    // Create/update key mapping
    if (!this.keyMapping) this.keyMapping = new Map();
    this.keyMapping.set(keyStr, keyHashHex);
    
    // CRITICAL IMPROVEMENT: First broadcast to ALL connected peers directly
    console.log('Broadcasting value to ALL connected peers directly');
    const directBroadcasts = [];
    
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer && peer.connected && peerId !== this.nodeIdHex) {
        console.log(`Direct broadcast to peer ${peerId.substring(0, 8)}...`);
        
        directBroadcasts.push(new Promise(resolve => {
          try {
            // Send with both keys to maximize compatibility
            peer.send({
              type: 'STORE',
              sender: this.nodeIdHex,
              key: keyHashHex,
              originalKey: keyStr,
              value: value,
              timestamp: Date.now()
            });
            resolve(true);
          } catch (err) {
            console.error(`Failed direct broadcast to ${peerId.substring(0, 8)}...: ${err.message}`);
            resolve(false);
          }
        }));
      }
    }
    
    // Wait for all direct broadcasts
    await Promise.all(directBroadcasts);
    
    // Then use the DHT protocol to find nodes closest to the key
    const nodes = await this.findNode(keyHashHex);
    
    if (nodes.length === 0) {
      console.log('No additional nodes found via DHT protocol, using direct broadcast only');
      return true; // We've already stored locally and broadcast directly
    }
    
    console.log(`Found ${nodes.length} nodes via DHT protocol for ${keyHashHex.substring(0, 8)}...`);
    
    // Store on closest nodes (if not already done via direct broadcast)
    const promises = nodes.map(node => {
      return new Promise(resolve => {
        // FIXED: Log all peer IDs for debugging
        console.log(`DEBUG: Looking for peer with ID ${node.id.substring(0, 8)}... for STORE operation`);
        
        // Try direct lookup
        let peer = this.peers.get(node.id);
        
        // If not found, try to match by substring (IDs might be partially matched)
        if (!peer) {
          for (const [peerId, peerObj] of this.peers.entries()) {
            // Check if peerId contains or is contained in node.id (partial match)
            if (peerId.includes(node.id.substring(0, 16)) || node.id.includes(peerId.substring(0, 16))) {
              console.log(`Found potential peer match for STORE: ${peerId.substring(0, 8)}... for node ID ${node.id.substring(0, 8)}...`);
              peer = peerObj;
              break;
            }
          }
        }
        
        if (!peer || !peer.connected) {
          console.log(`No connected peer found for node ID ${node.id.substring(0, 8)}... during STORE operation`);
          resolve(false);
          return;
        }
        
        console.log(`Storing value for key ${keyHashHex.substring(0, 8)}... on peer ${node.id.substring(0, 8)}...`);
        
        // Set timeout
        const timeout = setTimeout(() => {
          console.log(`Store operation timed out for ${node.id.substring(0, 8)}...`);
          resolve(false);
        }, 5000);
        
        // Register message handler safely based on what's available
        const responseHandler = ({ type, sender, ...message }) => {
          // Skip other message types and senders
          if (message.type !== 'STORE_RESPONSE') return;
          if (sender !== node.id) return;
          
          // Get key that was requested
          const requestedKey = message.key;
          if (requestedKey !== keyHashHex) return; // Not response to our query safely
          
          try {
            if (typeof peer.removeListener === 'function') {
              peer.removeListener('message', responseHandler);
            } else if (typeof peer.removeEventListener === 'function') {
              peer.removeEventListener('message', responseHandler);
            }
          } catch (e) {
            console.warn(`Could not remove message listener: ${e.message}`);
          }
          
          resolve(message.success === true);
        };
        
        // Register handler - our Peer class extends a custom EventEmitter
        try {
          // Directly attach event handler - should work with our custom EventEmitter
          peer.on('message', responseHandler);
          
          // Also attach a data handler as backup
          if (peer.peer && typeof peer.peer.on === 'function') {
            peer.peer.on('data', data => {
              try {
                // If data is string, try to parse as JSON
                if (typeof data === 'string') {
                  const parsed = JSON.parse(data);
                  responseHandler(parsed);
                } else if (data instanceof Uint8Array) {
                  // Handle binary data if needed
                  const decoder = new TextDecoder();
                  const str = decoder.decode(data);
                  const parsed = JSON.parse(str);
                  responseHandler(parsed);
                }
              } catch (e) {
                // Ignore parsing errors - might not be JSON
              }
            });
          }
        } catch (err) {
          console.error(`Cannot register message handler for peer ${node.id.substring(0, 8)}...: ${err.message}`);
          return resolve(false);
        }
        
        // CRITICAL FIX: Check if peer has 'send' method first, and verify it's a proper peer object
        if (!peer || typeof peer.send !== 'function') {
          console.error(`Invalid peer object for ${node.id.substring(0, 8)}... - not a proper Peer instance or missing send method`);
          
          // Try to get the actual peer from our direct connections
          const actualPeer = this.peers.get(node.id);
          if (actualPeer && typeof actualPeer.send === 'function') {
            console.log(`Found actual Peer instance for ${node.id.substring(0, 8)}... using direct connection`);
            peer = actualPeer; // Replace with the actual peer instance
          } else {
            console.error(`No valid Peer instance found for ${node.id.substring(0, 8)}...`);
            clearTimeout(timeout);
            return resolve(false);
          }
        }
        
        // Send the STORE message
        try {
          console.log(`Sending STORE message to peer ${node.id.substring(0, 8)}...`);
          peer.send({
            type: 'STORE',
            sender: this.nodeIdHex,
            key: keyHashHex,
            originalKey: keyStr, // Include the original key for better lookup
            value: value,
            timestamp: Date.now() // Include timestamp to prevent stale values
          });
        } catch (sendError) {
          console.error(`Error sending STORE to peer: ${sendError.message}`);
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
    
    // Wait for protocol-based stores to complete
    const results = await Promise.all(promises);
    
    // Consider successful if we've stored locally (which we have)
    return true;
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
    
    console.log(`GET operation: key=${keyStr}, hashed to ${keyHashHex.substring(0, 8)}...`);
    
    // Check local storage first
    if (this.storage.has(keyHashHex)) {
      const storedValue = this.storage.get(keyHashHex);
      console.log(`Found value for key=${keyStr} (hash: ${keyHashHex.substring(0, 8)}...) in local storage: ${JSON.stringify(storedValue)}`);
      return storedValue;
    }
    
    // Check if we have the original key stored directly (for migration/compatibility)
    if (this.storage.has(keyStr)) {
      const directValue = this.storage.get(keyStr);
      console.log(`Found value for unhashed key=${keyStr} in local storage: ${JSON.stringify(directValue)}`);
      return directValue;
    }
    
    console.log(`Value for key ${keyHashHex.substring(0, 8)}... not in local storage, searching network`);
    
    // Find nodes closest to the key (pass the hex string, not the buffer)
    const nodes = await this.findNode(keyHashHex);
    console.log(`Found ${nodes.length} nodes to query for key ${keyHashHex.substring(0, 8)}...`);
    
    if (nodes.length === 0) {
      console.log('No nodes to query, returning null');
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
        console.log(`Querying node ${node.id.substring(0, 8)}... for value`);
        
        // *** CRITICAL DEBUGGING ***
        // Get the original peer from the map
        const peer = this.peers.get(node.id);
        console.log(`PEER DEBUG - Looking up peer ${node.id.substring(0, 8)}...`);
        console.log(`PEER DEBUG - Peer found in map: ${peer ? 'YES' : 'NO'}`);
        if (peer) {
          console.log(`PEER DEBUG - Peer type: ${peer.constructor?.name || 'unknown'}`);
          console.log(`PEER DEBUG - Has send method: ${typeof peer.send === 'function' ? 'YES' : 'NO'}`);
          console.log(`PEER DEBUG - Has on method: ${typeof peer.on === 'function' ? 'YES' : 'NO'}`);
          console.log(`PEER DEBUG - Connected flag: ${peer.connected ? 'YES' : 'NO'}`);
          // Check if this is a SimplePeer wrapper
          if (peer._peer) {
            console.log(`PEER DEBUG - Has internal _peer property: YES`);
            console.log(`PEER DEBUG - Internal peer type: ${peer._peer.constructor?.name || 'unknown'}`);
          }
        }
        
        // CRITICAL FIX: Use the proper peer instance
        // If this is one of our custom Peer instances with an internal SimplePeer instance,
        // we need to use the wrapper which has our custom event emitters attached
        let activePeer = peer;
        
        // EMERGENCY WORKAROUND: If the peer has no 'on' method but does have 'send',
        // create a basic wrapper that can at least send messages
        if (peer && typeof peer.send === 'function' && typeof peer.on !== 'function') {
          console.log(`EMERGENCY FIX: Creating event emitter wrapper for peer ${node.id.substring(0, 8)}...`);
          
          // Create a basic EventEmitter-like wrapper around the raw peer object
          activePeer = {
            _rawPeer: peer,
            _events: {},
            
            // Basic event emitter functionality
            on: function(event, callback) {
              console.log(`Registering handler for '${event}' event`);
              if (!this._events[event]) this._events[event] = [];
              this._events[event].push(callback);
            },
            
            removeListener: function(event, callback) {
              console.log(`Removing handler for '${event}' event`);
              if (this._events[event]) {
                this._events[event] = this._events[event].filter(cb => cb !== callback);
              }
            },
            
            emit: function(event, data) {
              if (this._events[event]) {
                this._events[event].forEach(callback => callback(data));
              }
            },
            
            // Forward send method to raw peer
            send: function(data) {
              console.log(`Forwarding send to raw peer: ${JSON.stringify(data).substring(0, 100)}`);
              return this._rawPeer.send(data);
            },
            
            // Forward connected property
            get connected() {
              return this._rawPeer.connected;
            }
          };
          
          console.log(`Created wrapper with event emitter capabilities`);
        }
        
        // Use the same robust connection check we use in findNode
        // Some browser WebRTC implementations may not set the connected flag as expected
        // So we also check if the peer has a send method as an additional check
        const isPeerConnected = activePeer && (activePeer.connected || typeof activePeer.send === 'function');
        
        if (!isPeerConnected) {
          console.log(`Peer ${node.id.substring(0, 8)}... not connected (connected=${activePeer?.connected}, hasSendMethod=${typeof activePeer?.send === 'function'}), skipping`);
          return null;
        }
        
        console.log(`Using peer ${node.id.substring(0, 8)}... to look up value`);
        
        return new Promise(resolve => {
          // Reference to data handler for cleanup
          let dataHandler = null;
          
          // Set timeout
          const timeout = setTimeout(() => {
            console.log(`Internal GET query timed out for ${node.id.substring(0, 8)}... after 15s`);
            
            // Clean up ALL listeners safely
            try {
              // Clean up message listener
              if (typeof activePeer.removeListener === 'function') {
                activePeer.removeListener('message', responseHandler);
                
                // Also remove data handler if it was registered
                if (dataHandler) {
                  activePeer.removeListener('data', dataHandler);
                  console.log(`Removed 'data' event handler on timeout`);
                }
              } 
              // Some implementations use removeEventListener instead
              else if (typeof activePeer.removeEventListener === 'function') {
                activePeer.removeEventListener('message', responseHandler);
                
                // Also remove data handler if it was registered
                if (dataHandler) {
                  activePeer.removeEventListener('data', dataHandler);
                  console.log(`Removed 'data' event handler on timeout`);
                }
              }
            } catch (e) {
              console.warn(`Could not remove event listeners: ${e.message}`);
            }
            resolve(null);
          }, 15000); // Increased timeout to 15 seconds
          
          // Register message handler safely based on what's available
          const responseHandler = ({ type, sender, ...message }) => {
            // Skip other message types and senders
            if (message.type !== 'FIND_VALUE_RESPONSE' && message.type !== 'FIND_NODE_RESPONSE') return;
            if (sender !== node.id) return;
            
            // Get key that was requested
            const requestedKey = message.key;
            if (requestedKey !== keyHashHex) return; // Not response to our query safely
            
            try {
              if (typeof activePeer.removeListener === 'function') {
                activePeer.removeListener('message', responseHandler);
              } else if (typeof activePeer.removeEventListener === 'function') {
                activePeer.removeEventListener('message', responseHandler);
              }
            } catch (e) {
              console.warn(`Could not remove message listener: ${e.message}`);
            }
            
            // Check if it's a value response
            if (message.type === 'FIND_VALUE_RESPONSE') {
              // Make sure it's for our key - either by exact match or original key
              const matchesKey = message.key === keyHashHex || 
                                 (message.originalKey && message.originalKey === keyStr);
                                 
              if (!matchesKey) {
                console.log(`Received FIND_VALUE_RESPONSE but key doesn't match our request`);
                return;
              }
              
              // Store locally if found elsewhere - store with BOTH keys for future lookups
              if (message.value !== null) {
                console.log(`Storing remotely found value locally with multiple keys for future lookups`);
                
                // Store with hashed key
                this.storage.set(keyHashHex, message.value);
                this.storageTimestamps.set(keyHashHex, Date.now());
                
                // Also store with original key
                this.storage.set(keyStr, message.value);
                this.storageTimestamps.set(keyStr, Date.now());
                
                // Update keyMapping if it exists
                if (!this.keyMapping) this.keyMapping = new Map();
                this.keyMapping.set(keyStr, keyHashHex);
              }
              
              resolve(message.value);
              return;
            }
            
            // If it's a node response, indicates value not found on that peer
            if (message.type === 'FIND_NODE_RESPONSE') {
              clearTimeout(timeout);
              console.log(`Received FIND_NODE_RESPONSE (value not found) for key ${keyHashHex.substring(0, 8)}... from ${sender.substring(0, 8)}...`);
              // Clean up listener safely
              try {
                // Use the removeListener method from our EventEmitter
                activePeer.removeListener('message', responseHandler);
                
                // Also remove data handler if it was registered
                if (dataHandler) {
                  activePeer.removeListener('data', dataHandler);
                }
                
                // Also cleanup nested peer if it exists
                if (activePeer.peer && typeof activePeer.peer.removeListener === 'function') {
                  activePeer.peer.removeListener('data', responseHandler);
                }
              } catch (e) {
                console.warn(`Could not remove message listener: ${e.message}`);
              }
              resolve(null);
            }
          };
          
          // Since we're now passing the peer instance directly, this check should always pass
          // but we'll keep it as a safeguard
          if (!activePeer || typeof activePeer.on !== 'function') {
            console.error(`Invalid peer object for ${node.id.substring(0, 8)}... - not a proper Peer instance (type: ${typeof activePeer}, constructor: ${activePeer?.constructor?.name})`);
            return resolve(null);
          }
          
          try {
            // WebRTC peers might use 'data' event instead of 'message'
            // Let's attach handlers for both event types to be safe
            
            // Handle 'message' event (our custom Peer wrapper)
            activePeer.on('message', responseHandler);
            console.log(`Attached 'message' handler to peer ${node.id.substring(0, 8)}...`);
            
            // CRITICAL: Also handle 'data' event (original WebRTC simple-peer)
            // This is often the event that's actually fired in browser environments
            try {
              // Create a dedicated data handler so we can reference it for removal later
              dataHandler = (data) => {
                try {
                  // Parse the data if it's JSON
                  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                  console.log(`Received 'data' event with:`, parsed);
                  // Call the responseHandler with the parsed data
                  responseHandler(parsed);
                } catch (e) {
                  console.error(`Error parsing data event: ${e.message}`);
                }
              };
              
              // Register the data handler with the peer
              activePeer.on('data', dataHandler);
              console.log(`Also attached 'data' handler to peer ${node.id.substring(0, 8)}...`);
            } catch (dataEventError) {
              console.log(`Note: Peer doesn't support 'data' events: ${dataEventError.message}`);
            }
          } catch (err) {
            console.error(`Error attaching message handlers to peer ${node.id.substring(0, 8)}...: ${err.message}`);
            return resolve(null);
          }
          
          // Send the query via the activePeer
          try {
            console.log(`Sending FIND_VALUE query to peer ${node.id.substring(0, 8)}...`);
            activePeer.send({
              type: 'FIND_VALUE',
              sender: this.nodeIdHex,
              key: keyHashHex,
              originalKey: keyStr  // Include original unhashed key to improve lookup chances
            });
            console.log(`FIND_VALUE query sent successfully to peer ${node.id.substring(0, 8)}...`);
          } catch (err) {
            console.error(`Error sending FIND_VALUE query to peer ${node.id.substring(0, 8)}...: ${err.message}`);
            resolve(null); // Resolve with null if we can't even send the query
          }  
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
  /**
   * Propagate a stored value to other connected peers (except originator)
   * @param {string} key - Key to propagate
   * @param {*} value - Value to propagate
   * @param {string} originalKey - Original key if different from key
   * @param {string} skipPeerId - Peer ID to skip (typically the sender)
   * @return {number} Number of peers propagated to
   * @private
   */
  _propagateStoredValue(key, value, originalKey, skipPeerId) {
    let propagationCount = 0;
    
    // Find all connected peers except the one who sent us the value
    for (const [peerId, peer] of this.peers.entries()) {
      // Skip self and the original sender
      if (peerId === this.nodeIdHex || peerId === skipPeerId) continue;
      
      // Check if the peer is connected
      const isPeerConnected = peer && (peer.connected || typeof peer.send === 'function');
      
      if (isPeerConnected) {
        try {
          console.log(`Propagating value for key ${key.substring(0, 8)}... to peer ${peerId.substring(0, 8)}...`);
          
          // Send the stored value to this peer
          peer.send({
            type: 'STORE',
            sender: this.nodeIdHex,
            key: key,
            originalKey: originalKey || key,
            value: value,
            timestamp: Date.now(),
            propagated: true // Mark as a propagated message to prevent infinite loops
          });
          
          propagationCount++;
        } catch (err) {
          console.error(`Failed to propagate value to peer ${peerId.substring(0, 8)}...: ${err.message}`);
        }
      }
    }
    
    console.log(`Propagated value to ${propagationCount} other peers`);
    return propagationCount;
  }
  
  /**
   * Replicate data to other nodes
   * @private
   */
  async _replicateData() {
    // Skip if no data to replicate
    if (this.storage.size === 0) return;
    
    for (const [key, value] of this.storage.entries()) {
      // Find nodes closest to the key (key is already a string in our implementation)
      const nodes = await this.findNode(key);

      
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
