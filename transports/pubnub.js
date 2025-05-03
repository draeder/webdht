/**
 * PubNub Transport for WebDHT
 * 
 * Handles client connection to PubNub real-time messaging platform for signaling
 */
import EventEmitter from "../src/event-emitter.js";
import { ENV, distance } from "../src/utils.js";
import Logger from "../src/logger.js";

class PubNubTransport extends EventEmitter {
  /**
   * Create a new PubNub transport
   * @param {Object} options - Transport options
   * @param {string} options.publishKey - PubNub publish key
   * @param {string} options.subscribeKey - PubNub subscribe key
   * @param {string} options.secretKey - PubNub secret key (optional, server-side only)
   * @param {string} [options.peerId] - Local peer ID (optional, can be set later via register method)
   * @param {string} options.channelName - Channel name to use (default: "webdht")
   * @param {boolean} options.ssl - Use secure connection (default: true)
   * @param {boolean} options.autoReconnect - Whether to automatically reconnect (default: true)
   * @param {number} options.reconnectDelay - Delay between reconnection attempts in ms (default: 5000)
   * @param {number} options.maxReconnectAttempts - Maximum number of reconnection attempts (default: 10)
   * @param {boolean} options.debug - Enable debug logging
   */
  constructor(options = {}) {
    super();
    
    // Required options
    this.publishKey = options.publishKey;
    this.subscribeKey = options.subscribeKey;
    this.secretKey = options.secretKey;
    this.peerId = options.peerId || null;
    
    // Optional settings with defaults
    this.channelName = options.channelName || "webdht";
    this.ssl = options.ssl !== false;
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectDelay = options.reconnectDelay || 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.debug = options.debug || false;
    
    // Standard Kademlia DHT parameter - number of closest peers to return
    this.K = 20;
    
    // State tracking
    this.connected = false;
    this.destroyed = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.registeredPeers = new Set();
    
    // Initialize logger
    this.logger = new Logger("PubNubTransport");
    
    // Connect immediately if keys are provided
    if (this.publishKey && this.subscribeKey) {
      this.connect();
    }
  }
  
  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug && this.logger?.debug) {
      const prefix = `PubNub:${this.peerId ? this.peerId.substring(0, 8) : 'unregistered'}`;
      this.logger.debug(`[${prefix}]`, ...args);
    }
  }
  
  /**
   * Load PubNub SDK dynamically
   * @private
   * @returns {Promise<Object>} PubNub SDK instance
   */
  async _loadPubNubSDK() {
    this._logDebug("Loading PubNub SDK");
    
    if (ENV.NODE) {
      try {
        // In Node.js, use dynamic import
        const { default: PubNub } = await import('pubnub');
        return PubNub;
      } catch (err) {
        throw new Error(`Failed to load PubNub SDK for Node.js: ${err.message}. Make sure to install it with 'npm install pubnub'`);
      }
    } else {
      // In browser, PubNub SDK must be loaded via script tag
      if (typeof PubNub === 'undefined') {
        throw new Error('PubNub SDK not loaded. Include <script src="https://cdn.pubnub.com/sdk/javascript/pubnub.min.js"></script> in your HTML');
      }
      
      // Use global PubNub object
      return window.PubNub;
    }
  }
  
  /**
   * Connect to PubNub
   * @param {Object} config - Optional configuration to override the one provided in constructor
   */
  async connect(config) {
    if (this.pubnub) {
      this._logDebug("Already connected or connecting");
      return;
    }
    
    if (config) {
      if (config.publishKey) this.publishKey = config.publishKey;
      if (config.subscribeKey) this.subscribeKey = config.subscribeKey;
      if (config.secretKey) this.secretKey = config.secretKey;
      if (config.channelName) this.channelName = config.channelName;
    }
    
    if (!this.publishKey || !this.subscribeKey) {
      const error = new Error("PubNub publish key and subscribe key are required");
      this._logDebug(error.message);
      this.emit("error", error);
      return;
    }
    
    try {
      const PubNub = await this._loadPubNubSDK();
      
      this._logDebug(`Connecting to PubNub with channel: ${this.channelName}`);
      
      // Create PubNub instance
      const pubnubConfig = {
        publishKey: this.publishKey,
        subscribeKey: this.subscribeKey,
        uuid: this.peerId || `temp-${crypto.randomUUID()}`, // Use temporary ID if peerId not provided
        ssl: this.ssl,
        heartbeatInterval: 30, // Send heartbeats every 30 seconds
        presenceTimeout: 60     // Consider a client offline after 60 seconds of no heartbeats
      };
      
      // Add secret key if provided (server-side only)
      if (this.secretKey && ENV.NODE) {
        pubnubConfig.secretKey = this.secretKey;
      }
      
      this.pubnub = new PubNub(pubnubConfig);
      
      // Setup listeners for PubNub events
      this._setupListeners();
      
      // Subscribe to the channel
      this.pubnub.subscribe({
        channels: [this.channelName],
        withPresence: true // Enable presence events to track who's online
      });
      
      // Mark as connected
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Register this peer if we have an ID
      if (this.peerId) {
        this._logDebug(`Auto-registering with peer ID: ${this.peerId}`);
        this.register(this.peerId);
      }
      
      this.emit("connect");
    } catch (err) {
      this._logDebug("PubNub connection error:", err.message);
      this.emit("error", err);
      this._handleDisconnect();
    }
  }
  
  /**
   * Setup PubNub event listeners
   * @private
   */
  _setupListeners() {
    // Set up listener for messages and presence events
    const listener = {
      message: (messageEvent) => {
        try {
          const { channel, message, publisher } = messageEvent;
          
          // Ignore messages from self - compare with UUID or peerId
          if (publisher === this.pubnub.getUUID() ||
              (this.peerId && publisher === this.peerId)) return;
          
          this._logDebug(`Received message on ${channel} from ${publisher}`, message);
          this._handleMessage(message, publisher);
        } catch (err) {
          this._logDebug("Error handling message:", err.message);
          this.emit("error", new Error(`Error processing message: ${err.message}`));
        }
      },
      presence: (presenceEvent) => {
        const { action, uuid, channel, occupancy } = presenceEvent;
        
        this._logDebug(`Presence event: ${action} - ${uuid} on ${channel}. Occupancy: ${occupancy}`);
        
        // Handle different presence events
        switch (action) {
          case 'join':
            if (uuid !== this.pubnub.getUUID()) {
              // Calculate XOR distance to the new peer
              const newPeerDistance = distance(this.peerId, uuid);
              
              // Calculate distances to existing peers and include the new peer
              const allPeers = [...this.registeredPeers, uuid];
              const peerDistances = allPeers.map(id => ({
                id: id,
                distance: distance(this.peerId, id)
              }));
              
              // Sort by XOR distance
              peerDistances.sort((a, b) => {
                if (a.distance < b.distance) return -1;
                if (a.distance > b.distance) return 1;
                return 0;
              });
              
              // Keep only the K closest peers
              const closestPeers = peerDistances.slice(0, this.K).map(peer => peer.id);
              
              // Update the registered peers set
              this.registeredPeers.clear();
              closestPeers.forEach(id => this.registeredPeers.add(id));
              
              // Only emit new_peer event if the new peer is among the K closest
              if (closestPeers.includes(uuid)) {
                this.emit("new_peer", uuid);
              } else {
                this._logDebug(`New peer ${uuid} is not among the ${this.K} closest peers; ignoring`);
              }
            }
            break;
          case 'leave':
          case 'timeout':
            this.registeredPeers.delete(uuid);
            this.emit("peer_left", uuid);
            break;
          case 'state-change':
            // Handle state changes if needed
            break;
        }
      },
      status: (statusEvent) => {
        const { category, operation } = statusEvent;
        this._logDebug(`Status event: ${category} for operation: ${operation}`, statusEvent);
        
        switch (category) {
          case 'PNConnectedCategory':
            // This is called when the client first connects or reconnects
            this._logDebug('PubNub connection established');
            
            // Request the current occupants list to update our registeredPeers
            this.pubnub.hereNow({
              channels: [this.channelName],
              includeUUIDs: true
            }).then(response => {
              const channel = response.channels[this.channelName];
              const peers = channel.occupants.map(occupant => occupant.uuid);
              
              // Remove self from the list
              const selfIndex = peers.indexOf(this.pubnub.getUUID());
              if (selfIndex !== -1) {
                peers.splice(selfIndex, 1);
              }
              
              this._logDebug(`Current peers: ${peers.length}`);
              
              // Get current peer ID - use UUID if peerId is not set
              const currentPeerId = this.peerId || this.pubnub.getUUID();
              let sortedPeers = peers;
              
              try {
                // Filter and sort peers by XOR distance (closest first)
                sortedPeers = peers
                  .map(id => ({
                    id: id,
                    distance: distance(currentPeerId, id)
                  }))
                  .sort((a, b) => {
                    if (a.distance < b.distance) return -1;
                    if (a.distance > b.distance) return 1;
                    return 0;
                  })
                  // Take only the K closest peers (K=20 as per Kademlia standard)
                  .slice(0, this.K)
                  // Map back to just the peer IDs
                  .map(peer => peer.id);
                
                this._logDebug(`Closest ${sortedPeers.length} peers selected by XOR distance`);
              } catch (err) {
                this._logDebug(`Error calculating peer distances: ${err.message}`);
              }
              
              // Update registered peers
              this.registeredPeers.clear();
              sortedPeers.forEach(peer => this.registeredPeers.add(peer));
              
              // Inform peer registration complete
              if (this.peerId) {
                this.emit("registered", this.peerId, sortedPeers);
              } else {
                this.emit("registered", this.pubnub.getUUID(), sortedPeers);
              }
            }).catch(err => {
              this._logDebug('Error fetching current peers:', err);
              this.emit("error", new Error(`Failed to fetch peer list: ${err.message}`));
            });
            
            break;
            
          case 'PNNetworkDownCategory':
            // This is triggered when the network goes down
            this._logDebug('Network connection lost');
            this._handleDisconnect();
            break;
            
          case 'PNNetworkUpCategory':
            // This is triggered when the network comes back online
            this._logDebug('Network connection restored');
            break;
            
          case 'PNReconnectedCategory':
            // This is triggered when the client reconnects after a disconnect
            this._logDebug('Reconnected to PubNub');
            this.connected = true;
            break;
            
          case 'PNAccessDeniedCategory':
          case 'PNBadRequestCategory':
            // Handle auth failures or bad requests
            this._logDebug(`PubNub error: ${category}`);
            this.emit("error", new Error(`PubNub access error: ${category}`));
            break;
        }
      }
    };
    
    // Add listener to PubNub instance
    this.pubnub.addListener(listener);
    this.listener = listener;
  }
  
  /**
   * Handle PubNub disconnection
   * @private
   */
  _handleDisconnect() {
    if (!this.connected) return;
    
    this.connected = false;
    this.registeredPeers.clear();
    this.emit("disconnect");
    
    // Attempt to reconnect if configured
    if (this.autoReconnect && !this.destroyed) {
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        
        this._logDebug(`Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        this.reconnectTimer = setTimeout(() => {
          if (!this.destroyed) {
            this.connect();
          }
        }, this.reconnectDelay);
      } else {
        this._logDebug(`Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
        this.emit("reconnect_failed");
      }
    }
  }
  
  /**
   * Handle incoming PubNub messages
   * @private
   * @param {Object} message - Message data
   * @param {string} publisher - Publisher UUID
   */
  _handleMessage(message, publisher) {
    if (!message || !message.type) {
      this._logDebug("Received invalid message format");
      return;
    }
    
    this._logDebug("Received message:", message.type);
    
    switch (message.type) {
      case "signal":
        // Received signaling data from another peer
        this._logDebug(`Received signal from ${publisher}`);
        this.emit("signal", publisher, message.signal);
        break;
        
      case "register":
        // A peer is announcing its presence
        this._logDebug(`Peer registered: ${publisher}`);
        
        // Calculate XOR distance to the new peer
        const newPeerDistance = distance(this.peerId, publisher);
        
        // Calculate distances to existing peers and include the new peer
        const allPeers = [...this.registeredPeers, publisher];
        const peerDistances = allPeers.map(id => ({
          id: id,
          distance: distance(this.peerId, id)
        }));
        
        // Sort by XOR distance
        peerDistances.sort((a, b) => {
          if (a.distance < b.distance) return -1;
          if (a.distance > b.distance) return 1;
          return 0;
        });
        
        // Keep only the K closest peers
        const closestPeers = peerDistances.slice(0, this.K).map(peer => peer.id);
        
        // Update the registered peers set
        this.registeredPeers.clear();
        closestPeers.forEach(id => this.registeredPeers.add(id));
        
        // Only emit new_peer event if the new peer is among the K closest
        if (closestPeers.includes(publisher)) {
          this.emit("new_peer", publisher);
        } else {
          this._logDebug(`New peer ${publisher} is not among the ${this.K} closest peers; ignoring`);
        }
        break;
        
      case "error":
        // Server reported an error
        this._logDebug(`Error message: ${message.message}`);
        this.emit("server_error", message.message);
        break;
        
      default:
        // Unknown message type
        this._logDebug(`Unknown message type: ${message.type}`);
        this.emit("unknown_message", message);
    }
  }
  
  /**
   * Register this client with the PubNub network
   * @param {string} peerId - Peer ID to register
   */
  register(peerId) {
    if (!this.connected) {
      this._logDebug("Cannot register: not connected to PubNub");
      return false;
    }
    
    // Update peerId
    this.peerId = peerId;
    this._logDebug(`Registering with peer ID: ${peerId}`);
    
    // Update the UUID if different
    if (this.pubnub.getUUID() !== peerId) {
      // Unfortunately we can't change UUID after initialization in PubNub
      // So we'll have to reconnect with the new UUID
      this.disconnect();
      this.connect();
      return true;
    }
    
    // Announce registration to other peers
    return this.send({
      type: "register",
      peerId
    });
  }
  
  /**
   * Send a signal to another peer
   * @param {string} targetPeerId - Target peer ID
   * @param {Object} signal - Signal data
   */
  signal(targetPeerId, signal) {
    if (!signal || typeof signal !== 'object') {
      this._logDebug("Invalid signal format");
      this.emit("error", new Error("Signal must be an object"));
      return false;
    }
    
    const validTypes = ['offer', 'answer', 'candidate', 'renegotiate'];
    if (!validTypes.includes(signal.type)) {
      this._logDebug(`Invalid signal type: ${signal.type}`);
      this.emit("error", new Error(`Invalid signal type: ${signal.type}`));
      return false;
    }
    
    return this.send({
      type: "signal",
      target: targetPeerId,
      signal
    });
  }
  
  /**
   * Send data via PubNub
   * @param {Object} data - Data object to send
   * @returns {boolean} - Whether the send was successful
   */
  send(data) {
    if (!this.connected || this.destroyed) {
      this._logDebug("Cannot send: not connected to PubNub");
      return false;
    }
    
    if (!this.peerId) {
      this._logDebug("Warning: sending without registered peerId");
    }
    
    try {
      // If the message has a specific target, we can use a direct message
      if (data.target) {
        this._logDebug(`Sending direct message to ${data.target}`);
        
        this.pubnub.publish({
          channel: this.channelName,
          message: {
            ...data,
            sender: this.peerId || 'unregistered'
          },
          meta: {
            targetUUID: data.target
          }
        }).catch(err => {
          this._logDebug("Error sending direct message:", err.message);
          this.emit("error", err);
        });
      } else {
        // Otherwise broadcast to the channel
        this._logDebug("Broadcasting message to channel");
        
        this.pubnub.publish({
          channel: this.channelName,
          message: {
            ...data,
            sender: this.peerId || 'unregistered'
          }
        }).catch(err => {
          this._logDebug("Error broadcasting message:", err.message);
          this.emit("error", err);
        });
      }
      
      return true;
    } catch (err) {
      this._logDebug("Error sending data via PubNub:", err.message);
      this.emit("error", err);
      return false;
    }
  }
  
  /**
   * Get the list of registered peers
   * @returns {Array} Array of peer IDs
   */
  getRegisteredPeers() {
    return Array.from(this.registeredPeers);
  }
  
  /**
   * Close the PubNub connection
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.pubnub) {
      this._logDebug("Closing PubNub connection");
      
      // Unsubscribe from the channel
      this.pubnub.unsubscribe({
        channels: [this.channelName]
      });
      
      // Remove listeners
      if (this.listener) {
        this.pubnub.removeListener(this.listener);
        this.listener = null;
      }
      
      // Release the PubNub instance
      this.pubnub = null;
    }
    
    this.connected = false;
    this.registeredPeers.clear();
  }
  
  /**
   * Destroy the transport
   */
  destroy() {
    this.destroyed = true;
    this.disconnect();
    this.emit("destroyed");
  }
}

export default PubNubTransport;