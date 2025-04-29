/**
 * Kademlia DHT implementation - Composition Root
 */
import EventEmitter from "./event-emitter.js";
import {
  bufferToHex,
  hexToBuffer,
  generateRandomID,
  distance,
  compareBuffers
} from "./utils.js";
import { sha1 } from "./sha1.js";
import {
  DEFAULT_K,
  DEFAULT_ALPHA,
  DEFAULT_BUCKET_COUNT,
  DEFAULT_MAX_STORE_SIZE,
  DEFAULT_REPLICATE_INTERVAL,
  DEFAULT_REPUBLISH_INTERVAL,
  DEFAULT_MAX_KEY_SIZE,
  DEFAULT_MAX_VALUE_SIZE
} from "./constants.js";

// Import the modular components
import { RoutingTable } from './modules/routing-table.js';
import { PeerManager } from './modules/peer-manager.js';
import { StorageEngine } from './modules/storage-engine.js';
import { NetworkManager } from './modules/network-manager.js';

/**
 * Main DHT implementation that serves as a composition root for the modular components
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
    
    // Initialize core DHT configuration
    this.debug = !!options.debug;
    this.maxPeers = typeof options.maxPeers === "number" && options.maxPeers > 0
      ? options.maxPeers
      : Infinity;
    
    // Initialize the modules
    this.routingTable = new RoutingTable(null, {
      k: options.k || DEFAULT_K,
      alpha: options.alpha || DEFAULT_ALPHA,
      bucketCount: options.bucketCount || DEFAULT_BUCKET_COUNT,
      debug: this.debug
    });

    this.peerManager = new PeerManager({
      maxPeers: this.maxPeers,
      debug: this.debug,
      dhtSignalThreshold: options.dhtSignalThreshold || 2
    });

    this.storageEngine = new StorageEngine({
      maxStoreSize: options.maxStoreSize || DEFAULT_MAX_STORE_SIZE,
      replicateInterval: options.replicateInterval || DEFAULT_REPLICATE_INTERVAL,
      republishInterval: options.republishInterval || DEFAULT_REPUBLISH_INTERVAL,
      debug: this.debug
    });

    this.networkManager = new NetworkManager({
      debug: this.debug,
      simplePeerOptions: options.simplePeerOptions || {}
    });
    
    // DHT signaling configuration
    this.DHT_SIGNAL_THRESHOLD = options.dhtSignalThreshold || 2;
    this.DHT_ROUTE_REFRESH_INTERVAL = options.dhtRouteRefreshInterval || 15000;
    this.AGGRESSIVE_DISCOVERY = true;
    this.TIERED_ROUTING = options.tieredRouting !== false;
    
    // Validation parameters
    this.MAX_KEY_SIZE = options.maxKeySize || DEFAULT_MAX_KEY_SIZE;
    this.MAX_VALUE_SIZE = options.maxValueSize || DEFAULT_MAX_VALUE_SIZE;
    
    // Wire up module events
    this._wireModuleEvents();
    
    // Initialize asynchronously
    this._initialize(options);
  }
  
  /**
   * Wire up events between modules
   * @private
   */
  _wireModuleEvents() {
    // Wire up PeerManager events
    this.peerManager.on('peer:connect', (peerId) => {
      this.emit('peer:connect', peerId);
      this._onPeerConnect(peerId);
    });
    
    this.peerManager.on('peer:disconnect', (peerId) => {
      this.emit('peer:disconnect', peerId);
      this.routingTable.removeNode(peerId);
    });
    
    this.peerManager.on('dht:ready', (isReady) => {
      this.emit('dht:ready', isReady);
    });
    
    // Wire up NetworkManager events
    this.networkManager.on('peer:connect', (peerId, peer) => {
      if (this.debug) console.debug(`[DHT] Network peer connected: ${peerId.substring(0, 8)}`);
      // Ensure PeerManager knows about the connection
      if (!this.peerManager.getPeer(peerId)) {
        this.peerManager.registerPeer(peer, peerId);
      }
    });
    
    this.networkManager.on('peer:disconnect', (peerId) => {
      if (this.debug) console.debug(`[DHT] Network peer disconnected: ${peerId.substring(0, 8)}`);
    });
    
    // Wire up StorageEngine events
    this.storageEngine.on('value:stored', (data) => {
      this.emit('value:stored', data);
    });
    
    this.storageEngine.on('value:replicate', (data) => {
      this._replicateValue(data);
    });
    
    this.storageEngine.on('value:republish', (data) => {
      this._republishValue(data);
    });
    
    // Wire up NetworkManager events
    this.networkManager.on('message:store', (data) => {
      this.storageEngine.storeRemoteValue(data);
    });
    
    this.networkManager.on('message:find_node', (data) => {
      this._handleFindNode(data);
    });
    
    this.networkManager.on('message:find_value', (data) => {
      this._handleFindValue(data);
    });
    
    this.networkManager.on('message:find_value_response', (data) => {
      // This event will be handled by listeners in the _distributedLookup method
      this.emit('message:find_value_response', data);
    });
    
    this.networkManager.on('message:find_node_response', (data) => {
      // This event will be handled by listeners in the _distributedLookup method
      this.emit('message:find_node_response', data);
    });
    
    this.networkManager.on('message:signal', (data) => {
      this._handleSignal(data);
    });
  }

  /**
   * Initialize DHT node
   * @param {Object} options - Initialization options
   * @private
   */
  async _initialize(options) {
    try {
      // Initialize node ID
      this.nodeId = options.nodeId || await generateRandomID();
      this.nodeIdHex = typeof this.nodeId === 'string' ? this.nodeId : bufferToHex(this.nodeId);
      
      this._logDebug("Initializing DHT node with ID:", this.nodeIdHex);
      
      // Initialize modules with node ID
      this.routingTable.setNodeId(this.nodeId);
      this.peerManager.setNodeId(this.nodeId);
      this.networkManager.nodeId = this.nodeIdHex;
      
      // Setup maintenance tasks
      this._setupMaintenance();
      
      // Expose the peers Map from NetworkManager
      // This is needed for the test script to check peer connections
      Object.defineProperty(this, 'peers', {
        get: () => this.networkManager.peers
      });
      
      // Bootstrap if nodes provided
      if (options.bootstrap && Array.isArray(options.bootstrap) && options.bootstrap.length > 0) {
        this._bootstrap(options.bootstrap);
      }
      
      this.emit('ready', this.nodeIdHex);
    } catch (err) {
      console.error('Error initializing DHT:', err);
      this.emit('error', err);
    }
  }
  
  /**
   * Set up maintenance tasks
   * @private
   */
  _setupMaintenance() {
    // Start storage engine maintenance
    this.storageEngine.startMaintenance();
    
    // Set up DHT route refresh
    this.dhtRouteRefreshInterval = setInterval(() => {
      this._refreshDHTRoutes();
    }, this.DHT_ROUTE_REFRESH_INTERVAL);
  }
  
  /**
   * Refresh DHT routes
   * @private
   */
  async _refreshDHTRoutes() {
    const connectedPeers = this.peerManager.getConnectedPeerIds();
    if (connectedPeers.length < 2) return;
    
    this._logDebug("Refreshing DHT routes...");
    
    // TODO: Implement DHT route refreshing by testing connections between peers
    // This is a complex operation that involves testing if peers can reach each other
    // through the DHT
  }
  
  /**
   * Log debug message
   * @private
   */
  _logDebug(...args) {
    if (this.debug) {
      const prefix = this.nodeIdHex ? this.nodeIdHex.substring(0, 4) : "init";
      console.debug(`[DHT ${prefix}]`, ...args);
    }
  }
  
  /**
   * Bootstrap the DHT with known nodes
   * @param {Array} nodes - Bootstrap nodes
   * @private
   */
  _bootstrap(nodes) {
    this._logDebug(`Bootstrapping DHT with ${nodes.length} nodes`);
    
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
   * Handle a new peer connection
   * @param {string} peerId - Peer ID
   * @private
   */
  _onPeerConnect(peerId) {
    this._logDebug(`Processing peer connect event for ${peerId.substring(0, 8)}...`);
    
    // Add to routing table
    this.routingTable.addNode({ id: peerId });
    
    // Replicate values to new peer
    this._replicateToNewPeer(peerId);
  }
  
  /**
   * Replicate values to a new peer
   * @param {string} peerId - Peer ID
   * @private
   */
  _replicateToNewPeer(peerId) {
    // Get all stored keys
    const keys = this.storageEngine.getKeys();
    this._logDebug(`Checking ${keys.length} keys for replication to new peer ${peerId.substring(0, 6)}...`);
    
    // For each key, check if the new peer is one of the k closest nodes
    keys.forEach(key => {
      // Get the current value
      const value = this.storageEngine.get(key);
      if (!value) return;
      
      // Get storage metadata
      const info = this.storageEngine.getStorageInfo(key);
      if (!info) return;
      
      // Check if this peer is already in the replicated list
      if (info.replicatedTo.includes(peerId)) return;
      
      // Get distance between key and peer
      const peerDistance = distance(key, peerId);
      
      // Get distance between key and furthest of the k closest nodes
      const closestNodes = this.routingTable.closest(key);
      if (closestNodes.length === 0) return;
      
      // If the new peer is closer than our furthest close node, replicate to it
      const furthestNode = closestNodes[closestNodes.length - 1];
      const furthestDistance = distance(key, furthestNode.id);
      
      if (compareBuffers(peerDistance, furthestDistance) <= 0) {
        this._logDebug(`Replicating key ${key.substring(0, 6)}... to new peer ${peerId.substring(0, 6)}`);
        
        // Send STORE message to the new peer
        this.networkManager.sendMessage(peerId, {
          type: 'STORE',
          key,
          value,
          timestamp: info.timestamp || Date.now(),
          sender: this.nodeIdHex
        });
        
        // Mark as replicated
        this.storageEngine.markReplicated(key, peerId);
      }
    });
  }

  /**
   * Replicate a value to other nodes
   * @param {Object} data - Value data
   * @private
   */
  _replicateValue(data) {
    const { key, value, timestamp, replicatedTo = [] } = data;
    
    // Find k closest nodes to the key
    const closestNodes = this.routingTable.closest(key);
    
    // Filter out nodes that have already received this value
    const targets = closestNodes.filter(node => !replicatedTo.includes(node.id));
    
    if (targets.length > 0) {
      this._logDebug(`Replicating key ${key.substring(0, 6)}... to ${targets.length} nodes`);
      
      // Send STORE message to each target
      targets.forEach(node => {
        this.networkManager.sendMessage(node.id, {
          type: 'STORE',
          key,
          value,
          timestamp: timestamp || Date.now(),
          sender: this.nodeIdHex
        });
        
        // Mark as replicated
        this.storageEngine.markReplicated(key, node.id);
      });
    }
  }
  
  /**
   * Republish a value
   * @param {Object} data - Value data
   * @private
   */
  _republishValue(data) {
    const { key, value } = data;
    
    // For republishing, we use a fresh timestamp
    // This extends the TTL of the value in the network
    const timestamp = Date.now();
    
    // Find k closest nodes to the key
    const closestNodes = this.routingTable.closest(key);
    
    if (closestNodes.length > 0) {
      this._logDebug(`Republishing key ${key.substring(0, 6)}... to ${closestNodes.length} nodes`);
      
      // Send STORE message to each target with fresh timestamp
      closestNodes.forEach(node => {
        this.networkManager.sendMessage(node.id, {
          type: 'STORE',
          key,
          value,
          timestamp,
          sender: this.nodeIdHex
        });
      });
      
      // Also update our local storage with fresh timestamp
      this.storageEngine.put(key, value, { isRepublish: true });
    }
  }
  
  /**
   * Handle find node request
   * @param {Object} data - Request data
   * @private
   */
  _handleFindNode(data) {
    const { target, requester } = data;
    const closestNodes = this.routingTable.closest(target);
    
    // Send response through network manager
    this.networkManager.sendMessage(requester, {
      type: 'FIND_NODE_RESPONSE',
      nodes: closestNodes
    });
  }
  
  /**
   * Handle find value request
   * @param {Object} data - Request data
   * @private
   */
  _handleFindValue(data) {
    const { key, requester } = data;
    const value = this.storageEngine.get(key);
    
    if (value) {
      // If we have the value, return it
      this.networkManager.sendMessage(requester, {
        type: 'FIND_VALUE_RESPONSE',
        key,
        value
      });
    } else {
      // Otherwise, return closest nodes
      const closestNodes = this.routingTable.closest(key);
      this.networkManager.sendMessage(requester, {
        type: 'FIND_NODE_RESPONSE',
        key,
        nodes: closestNodes
      });
    }
  }
  
  /**
   * Handle signal message
   * @param {Object} data - Signal data
   * @private
   */
  _handleSignal(data) {
    // TODO: Implement signal handling for WebRTC connections
  }

  /**
   * Validate key and value for storage
   * @param {string|Buffer} key - Key to validate
   * @param {any} value - Value to validate
   * @private
   */
  _validateStoreParams(key, value) {
    // Validate key
    if (!key) {
      throw new Error('Key is required');
    }
    
    const keyStr = typeof key === 'string' ? key : bufferToHex(key);
    if (keyStr.length > this.MAX_KEY_SIZE) {
      throw new Error(`Key size exceeds maximum of ${this.MAX_KEY_SIZE} bytes`);
    }
    
    // Validate value
    if (value === undefined || value === null) {
      throw new Error('Value cannot be null or undefined');
    }
    
    const valueSize = typeof value === 'string' 
      ? value.length 
      : JSON.stringify(value).length;
      
    if (valueSize > this.MAX_VALUE_SIZE) {
      throw new Error(`Value size exceeds maximum of ${this.MAX_VALUE_SIZE} bytes`);
    }
  }

  /**
   * Generate a hash for a key
   * @param {string|Buffer} key - Key to hash
   * @returns {Buffer} Hashed key
   * @private
   */
  async _hashKey(key) {
    if (typeof key !== 'string') {
      return key;
    }
    return await sha1(key);
  }

  // PUBLIC API METHODS

  /**
   * Connect to a peer
   * @param {Object} peerInfo - Peer information
   * @param {string|Buffer} peerInfo.id - Peer ID
   * @param {Object} peerInfo.signal - Signaling data (optional)
   * @returns {Object} Peer object
   */
  async connect(peerInfo) {
    if (!peerInfo || !peerInfo.id) {
      throw new Error('Invalid peer info');
    }
    
    const peerId = typeof peerInfo.id === 'string' ? peerInfo.id : bufferToHex(peerInfo.id);
    
    // Don't connect to self
    if (peerId === this.nodeIdHex) {
      throw new Error('Cannot connect to self');
    }
    
    // Check if already connected
    const existingPeer = this.peerManager.getPeer(peerId);
    if (existingPeer) {
      return existingPeer;
    }
    
    // Create new connection
    const peer = await this.networkManager.connect({
      id: peerId,
      signal: peerInfo.signal
    });
    
    if (this.debug) {
      console.debug(`[DHT] Connected to peer: ${peerId.substring(0, 8)}, peer object:`,
        { connected: peer.connected, id: peer.id });
    }
    
    // Register with peer manager
    this.peerManager.registerPeer(peer, peerId);
    
    return peer;
  }
  
  /**
   * Disconnect from a peer
   * @param {string} peerId - Peer ID
   */
  disconnect(peerId) {
    this.peerManager.disconnectPeer(peerId);
  }

  /**
   * Store a value in the DHT
   * @param {string|Buffer} key - Key to store under
   * @param {any} value - Value to store
   * @returns {Promise<string>} Key hash
   */
  async put(key, value) {
    this._validateStoreParams(key, value);
    const keyHash = await this._hashKey(key);
    const keyHashHex = typeof keyHash === 'string' ? keyHash : bufferToHex(keyHash);
    
    // Store locally
    await this.storageEngine.put(keyHash, value);
    
    // Find closest nodes to replicate to
    const closestNodes = this.routingTable.closest(keyHashHex);
    
    // Replicate to the closest nodes
    if (closestNodes.length > 0) {
      this._logDebug(`Replicating key ${keyHashHex.substring(0, 6)}... to ${closestNodes.length} nodes`);
      
      const timestamp = Date.now();
      const replicatedTo = new Set();
      
      // Send STORE message to each target
      for (const node of closestNodes) {
        const success = this.networkManager.sendMessage(node.id, {
          type: 'STORE',
          key: keyHashHex,
          value,
          timestamp,
          sender: this.nodeIdHex
        });
        
        if (success) {
          replicatedTo.add(node.id);
          this.storageEngine.markReplicated(keyHashHex, node.id);
        }
      }
    }
    
    return keyHashHex;
  }
  
  /**
   * Retrieve a value from the DHT
   * @param {string|Buffer} key - Key to look up
   * @returns {Promise<any>} Retrieved value
   */
  async get(key) {
    const keyHash = await this._hashKey(key);
    const keyHashHex = typeof keyHash === 'string' ? keyHash : bufferToHex(keyHash);
    
    // Try local storage first
    const localValue = await this.storageEngine.get(keyHashHex);
    if (localValue !== null) {
      return localValue;
    }
    
    // If not found locally, query other peers
    this._logDebug(`Value not found locally, querying peers for ${keyHashHex.substring(0, 6)}...`);
    
    // Find the closest nodes to ask
    const closestNodes = this.routingTable.closest(keyHashHex);
    if (closestNodes.length === 0) {
      this._logDebug('No peers to query');
      return null;
    }
    
    // Set up a distributed lookup with Promise
    return this._distributedLookup(keyHashHex, closestNodes);
  }
  
  /**
   * Perform a distributed lookup for a value
   * @param {string} keyHashHex - The key hash to look up
   * @param {Array} initialNodes - The initial nodes to query
   * @returns {Promise<any>} - The value if found, null otherwise
   * @private
   */
  async _distributedLookup(keyHashHex, initialNodes) {
    return new Promise((resolve, reject) => {
      // Set up state for this lookup
      const lookupId = `lookup_${Date.now()}_${Math.random().toString(16).substring(2, 8)}`;
      const queried = new Set();
      const pendingQueries = new Set();
      let resolved = false;
      
      // Set up timeout to avoid waiting forever
      const timeout = setTimeout(() => {
        if (!resolved) {
          this._logDebug(`Lookup ${lookupId} timed out for key ${keyHashHex.substring(0, 6)}...`);
          cleanup();
          resolve(null);
        }
      }, 10000); // 10 second timeout
      
      // Handler for FIND_VALUE_RESPONSE messages
      const responseHandler = (message) => {
        if (message.key !== keyHashHex) return;
        
        pendingQueries.delete(message.sender);
        
        if (message.value !== undefined) {
          // Value found!
          this._logDebug(`Found value for ${keyHashHex.substring(0, 6)}... from peer ${message.sender.substring(0, 6)}`);
          
          // Store in local cache
          this.storageEngine.storeRemoteValue({
            key: keyHashHex,
            value: message.value,
            publisher: message.sender
          });
          
          cleanup();
          resolved = true;
          resolve(message.value);
          return;
        }
        
        // If we got a FIND_NODE_RESPONSE instead (peer doesn't have the value)
        if (message.nodes && Array.isArray(message.nodes)) {
          // Queue up more nodes to query if we haven't found the value yet
          const newNodes = message.nodes.filter(node =>
            !queried.has(node.id) && node.id !== this.nodeIdHex
          );
          
          if (newNodes.length > 0) {
            queryNodes(newNodes);
          } else if (pendingQueries.size === 0) {
            // If no more nodes to query, we're done
            cleanup();
            resolve(null);
          }
        }
      };
      
      // Register handlers for this lookup
      this.networkManager.on('message:find_value_response', responseHandler);
      this.networkManager.on('message:find_node_response', responseHandler);
      
      // Clean up function to remove handlers and timeout
      const cleanup = () => {
        clearTimeout(timeout);
        this.networkManager.removeListener('message:find_value_response', responseHandler);
        this.networkManager.removeListener('message:find_node_response', responseHandler);
      };
      
      // Function to query a list of nodes
      const queryNodes = (nodes) => {
        nodes.forEach(node => {
          if (queried.has(node.id) || node.id === this.nodeIdHex) return;
          
          queried.add(node.id);
          pendingQueries.add(node.id);
          
          this._logDebug(`Querying peer ${node.id.substring(0, 6)} for key ${keyHashHex.substring(0, 6)}...`);
          
          this.networkManager.sendMessage(node.id, {
            type: 'FIND_VALUE',
            key: keyHashHex,
            requester: this.nodeIdHex,
            lookupId
          });
        });
      };
      
      // Start the lookup process with initial nodes
      queryNodes(initialNodes);
    });
  }
  
  /**
   * Find nodes close to a key
   * @param {string|Buffer} key - Key to find nodes for
   * @returns {Promise<Array>} Array of node IDs
   */
  async findNode(key) {
    const keyHash = await this._hashKey(key);
    const keyHashHex = typeof keyHash === 'string' ? keyHash : bufferToHex(keyHash);
    
    // Get closest nodes from routing table
    const localClosest = this.routingTable.closest(keyHashHex);
    
    // TODO: Implement actual node lookup by querying peers
    
    return localClosest;
  }
  
  /**
   * Signal to a peer directly or through the DHT
   * @param {Object} data - Signal data
   * @param {string} data.target - Target peer ID
   * @param {Object} data.signal - WebRTC signal data
   * @returns {Promise<boolean>} Success indicator
   */
  async signal(data) {
    if (!data || !data.target || !data.signal) {
      throw new Error('Invalid signal data');
    }
    
    const targetId = data.target;
    
    // Try direct connection first
    const directPeer = this.peerManager.getPeer(targetId);
    if (directPeer && directPeer.connected) {
      directPeer.send({
        type: 'SIGNAL',
        sender: this.nodeIdHex,
        signal: data.signal
      });
      return true;
    }
    
    // Try routing through DHT
    if (this.peerManager.isDHTReady()) {
      const routes = this.peerManager.getDHTRoutes(targetId);
      
      if (routes.length > 0) {
        // Route through first available peer
        const routePeerId = routes[0];
        const routePeer = this.peerManager.getPeer(routePeerId);
        
        if (routePeer && routePeer.connected) {
          routePeer.send({
            type: 'SIGNAL',
            sender: this.nodeIdHex,
            originalSender: this.nodeIdHex,
            signal: data.signal,
            target: targetId,
            ttl: 3,
            viaDht: true,
            signalPath: [this.nodeIdHex]
          });
          return true;
        }
      }
    }
    
    // No route found
    return false;
  }
  
  /**
   * Check if we can reach a peer directly
   * @param {string} peerId - Peer ID
   * @returns {Promise<boolean>} True if peer is directly reachable
   */
  async canReachPeerDirectly(peerId) {
    const peer = this.peerManager.getPeer(peerId);
    return !!(peer && peer.connected);
  }
}

export default DHT;
