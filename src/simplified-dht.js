/**
 * SimplifiedDHT - A streamlined DHT implementation focusing on core functionality
 * This implementation prioritizes simplicity and reliability over advanced features
 */

// Import core utilities
const isBrowser = typeof window !== 'undefined';
const crypto = isBrowser ? require('crypto-browserify') : require('crypto');

/**
 * Generate a SHA1 hash for a given value
 * @param {string} value - Value to hash
 * @return {string} Hex string representation of hash
 */
function sha1(value) {
  if (typeof value !== 'string') {
    value = String(value);
  }
  return crypto.createHash('sha1').update(value).digest('hex');
}

/**
 * Simple DHT implementation - focused on core functionality
 */
class SimplifiedDHT {
  /**
   * Create a new DHT instance
   * @param {Object} options - Configuration options
   * @param {string} options.nodeId - Optional node ID, will be generated if not provided
   */
  constructor(options = {}) {
    // Core properties
    this.nodeId = options.nodeId || sha1(Math.random().toString(36) + Date.now());
    this.storage = new Map(); // Local key-value storage
    this.peers = new Map();   // Connected peers: id -> peerObject

    // Debug settings
    this.debug = options.debug || false;
    
    // Setup 
    this._setupEventHandlers();
    
    this.log('DHT node created with ID:', this.nodeId);
  }

  /**
   * Set up message handlers
   * @private
   */
  _setupEventHandlers() {
    // Define core message handlers
    this.messageHandlers = {
      'PUT': this._handlePut.bind(this),
      'GET': this._handleGet.bind(this),
      'GET_RESPONSE': this._handleGetResponse.bind(this)
    };
    
    this.pendingRequests = new Map(); // Track pending requests by ID
    
    this.log('DHT message handlers initialized');
  }
  
  /**
   * Log messages if debug is enabled
   * @private
   */
  log(...args) {
    if (this.debug) {
      console.log(' ', ...args);
    }
  }

  /**
   * Add a peer to the DHT
   * @param {string} peerId - The peer's ID
   * @param {Object} peer - The peer object with send method
   */
  addPeer(peerId, peer) {
    if (!peerId || !peer) {
      this.log('Invalid peer or peerId');
      return false;
    }
    
    // Store normalized peer object - the only requirement is having a send method
    const normalizedPeer = {
      id: peerId,
      // Ensure peer has a send method
      send: (data) => {
        if (typeof peer.send === 'function') {
          try {
            // Add sender info to all outgoing messages
            const message = {
              ...data,
              sender: this.nodeId
            };
            
            this.log(`Sending ${message.type} to ${peerId.substring(0, 8)}...`, message);
            return peer.send(message);
          } catch (err) {
            this.log(`Error sending to peer ${peerId.substring(0, 8)}...`, err.message);
            return false;
          }
        } else {
          this.log(`Peer ${peerId.substring(0, 8)}... has no send method`);
          return false;
        }
      },
      // Track if peer is connected
      connected: true
    };
    
    this.peers.set(peerId, normalizedPeer);
    this.log(`Added peer ${peerId.substring(0, 8)}...`);
    return true;
  }
  
  /**
   * Remove a peer from the DHT
   * @param {string} peerId - The peer's ID to remove
   */
  removePeer(peerId) {
    if (this.peers.has(peerId)) {
      this.peers.delete(peerId);
      this.log(`Removed peer ${peerId.substring(0, 8)}...`);
      return true;
    }
    return false;
  }

  /**
   * Handle incoming messages from peers
   * @param {Object} message - The message object
   * @param {string} senderId - ID of the sending peer
   */
  handleMessage(message, senderId) {
    if (!message || !message.type) {
      this.log('Received invalid message', message);
      return;
    }
    
    this.log(`Received ${message.type} from ${senderId.substring(0, 8)}...`, message);
    
    // Route message to appropriate handler
    const handler = this.messageHandlers[message.type];
    if (handler) {
      handler(message, senderId);
    } else {
      this.log(`No handler for message type: ${message.type}`);
    }
  }

  /**
   * Store a value in the DHT
   * @param {string} key - Key under which to store the value
   * @param {*} value - Value to store
   * @return {Promise<boolean>} Success indicator
   */
  async put(key, value) {
    // Convert key to string if needed and hash for consistent storage
    const keyStr = typeof key === 'string' ? key : String(key);
    const keyHash = sha1(keyStr);
    
    this.log(`PUT operation: key=${keyStr}, hashed=${keyHash.substring(0, 8)}...`);
    
    // Store locally
    this.storage.set(keyHash, value);
    
    // Also store with original key for direct lookups
    this.storage.set(keyStr, value);
    
    // Broadcast to all peers
    const promises = [];
    
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.connected) {
        promises.push(new Promise(resolve => {
          peer.send({
            type: 'PUT',
            key: keyHash,
            originalKey: keyStr,
            value: value
          });
          resolve(true);
        }));
      }
    }
    
    // Wait for broadcasts to complete
    await Promise.all(promises);
    
    this.log(`PUT complete for ${keyStr}`);
    return true;
  }

  /**
   * Retrieve a value from the DHT
   * @param {string} key - Key to retrieve
   * @param {Object} options - Options for retrieval
   * @param {number} options.timeout - Timeout in ms (default 5000)
   * @return {Promise<*>} Retrieved value or null
   */
  async get(key, options = {}) {
    // Convert key to string if needed
    const keyStr = typeof key === 'string' ? key : String(key);
    const keyHash = sha1(keyStr);
    
    this.log(`GET operation: key=${keyStr}, hashed=${keyHash.substring(0, 8)}...`);
    
    // Check local storage first (try both hashed and original key)
    if (this.storage.has(keyHash)) {
      const value = this.storage.get(keyHash);
      this.log(`Found value locally for ${keyStr}`);
      return value;
    }
    
    // Also check original key
    if (this.storage.has(keyStr)) {
      const value = this.storage.get(keyStr);
      this.log(`Found value locally for original key ${keyStr}`);
      return value;
    }
    
    // Not found locally, query the network
    this.log(`Value not in local storage, querying network for ${keyStr}`);
    
    // Generate a unique request ID
    const requestId = Math.random().toString(36).substring(2, 15);
    
    // Create a promise that will be resolved when we get a response
    const responsePromise = new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.log(`GET request timed out for ${keyStr}`);
          this.pendingRequests.delete(requestId);
          resolve(null);
        }
      }, options.timeout || 5000);
      
      // Store the request handlers
      this.pendingRequests.set(requestId, {
        key: keyHash,
        originalKey: keyStr,
        resolve: (value) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          resolve(value);
        },
        timestamp: Date.now()
      });
    });
    
    // Send the query to all connected peers
    let queriedPeers = 0;
    
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.connected) {
        peer.send({
          type: 'GET',
          key: keyHash,
          originalKey: keyStr,
          requestId: requestId
        });
        queriedPeers++;
      }
    }
    
    this.log(`GET request sent to ${queriedPeers} peers for ${keyStr}`);
    
    // If no peers to query, return null immediately
    if (queriedPeers === 0) {
      this.pendingRequests.delete(requestId);
      return null;
    }
    
    // Wait for response or timeout
    return responsePromise;
  }

  /**
   * Handle PUT message from peer
   * @private
   */
  _handlePut(message, senderId) {
    if (!message.key || message.value === undefined) {
      this.log('Invalid PUT message');
      return;
    }
    
    // Store the value locally
    this.storage.set(message.key, message.value);
    
    // Also store with original key if provided
    if (message.originalKey) {
      this.storage.set(message.originalKey, message.value);
    }
    
    this.log(`Stored value from ${senderId.substring(0, 8)}...`, 
      `key=${message.key.substring(0, 8)}...`, 
      message.value);
  }

  /**
   * Handle GET message from peer
   * @private
   */
  _handleGet(message, senderId) {
    if (!message.key || !message.requestId) {
      this.log('Invalid GET message');
      return;
    }
    
    const peer = this.peers.get(senderId);
    if (!peer) {
      this.log(`Peer ${senderId.substring(0, 8)}... not found for GET response`);
      return;
    }
    
    let value = null;
    
    // Try to find value using hashed key
    if (this.storage.has(message.key)) {
      value = this.storage.get(message.key);
    } 
    // Also try original key
    else if (message.originalKey && this.storage.has(message.originalKey)) {
      value = this.storage.get(message.originalKey);
    }
    
    // Send response back
    peer.send({
      type: 'GET_RESPONSE',
      key: message.key,
      originalKey: message.originalKey,
      requestId: message.requestId,
      value: value
    });
    
    this.log(`Responded to GET from ${senderId.substring(0, 8)}...`, 
      `key=${message.key.substring(0, 8)}...`, 
      `found=${value !== null}`);
  }

  /**
   * Handle GET_RESPONSE message from peer
   * @private
   */
  _handleGetResponse(message, senderId) {
    if (!message.requestId || !this.pendingRequests.has(message.requestId)) {
      this.log('Invalid GET_RESPONSE or no pending request');
      return;
    }
    
    const request = this.pendingRequests.get(message.requestId);
    
    // Verify this is a response for the key we requested
    if (request.key !== message.key) {
      this.log('Key mismatch in GET_RESPONSE');
      return;
    }
    
    if (message.value !== null) {
      this.log(`Got value for ${request.originalKey} from ${senderId.substring(0, 8)}...`);
      
      // Store value locally for future use
      this.storage.set(message.key, message.value);
      if (message.originalKey) {
        this.storage.set(message.originalKey, message.value);
      }
      
      // Resolve the pending request
      request.resolve(message.value);
    } else {
      this.log(`Peer ${senderId.substring(0, 8)}... has no value for ${request.originalKey}`);
    }
  }
  
  /**
   * Close the DHT and cleanup
   */
  close() {
    // Clear all pending requests
    for (const [requestId, request] of this.pendingRequests.entries()) {
      request.resolve(null);
    }
    this.pendingRequests.clear();
    
    // Clear all peers
    this.peers.clear();
    
    this.log('DHT closed');
  }
}

module.exports = SimplifiedDHT;
