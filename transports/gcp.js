/**
 * Google Cloud Platform Transport for WebDHT
 * 
 * Handles client connection to GCP services for signaling
 * Supports Google Cloud Pub/Sub for real-time communication
 */
import EventEmitter from "../src/event-emitter.js";
import { ENV } from "../src/utils.js";
import Logger from "../src/logger.js";

class GCPTransport extends EventEmitter {
  /**
   * Create a new GCP transport
   * @param {Object} options - Transport options
   * @param {string} options.projectId - GCP project ID
   * @param {string} options.topicName - Pub/Sub topic name for signaling messages
   * @param {string} options.subscriptionName - Pub/Sub subscription name
   * @param {string} options.credentials - GCP service account credentials JSON (optional, can use environment variables)
   * @param {string} [options.peerId] - Local peer ID (optional, can be set later via register method)
   * @param {boolean} options.autoReconnect - Whether to automatically reconnect (default: true)
   * @param {number} options.reconnectDelay - Delay between reconnection attempts in ms (default: 5000)
   * @param {number} options.maxReconnectAttempts - Maximum number of reconnection attempts (default: 10)
   * @param {boolean} options.debug - Enable debug logging
   */
  constructor(options = {}) {
    super();
    
    // Required options
    this.projectId = options.projectId;
    this.topicName = options.topicName;
    this.subscriptionName = options.subscriptionName;
    this.peerId = options.peerId;
    
    // GCP credentials
    this.credentials = options.credentials;
    
    // Optional settings with defaults
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectDelay = options.reconnectDelay || 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.debug = options.debug || false;
    
    // State tracking
    this.connected = false;
    this.destroyed = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.registeredPeers = new Set();
    
    // Initialize logger
    this.logger = new Logger("GCPTransport");
    
    // Pub/Sub client instances
    this.pubSubClient = null;
    this.topic = null;
    this.subscription = null;
    this.messageHandler = null;
    
    // Connect immediately if required options are provided
    if (this.projectId && this.topicName && this.subscriptionName) {
      this.connect();
    }
  }
  
  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug && this.logger?.debug) {
      const prefix = `GCP:${this.peerId ? this.peerId.substring(0, 8) : 'unregistered'}`;
      this.logger.debug(`[${prefix}]`, ...args);
    }
  }
  
  /**
   * Load Google Cloud Pub/Sub client dynamically
   * @private
   * @returns {Promise<Object>} PubSub client
   */
  async _loadPubSubClient() {
    this._logDebug("Loading Google Cloud Pub/Sub client");
    
    if (ENV.NODE) {
      try {
        // In Node.js, use dynamic import
        const { PubSub } = await import('@google-cloud/pubsub');
        
        const options = {
          projectId: this.projectId
        };
        
        // Use provided credentials if available
        if (this.credentials) {
          options.credentials = JSON.parse(this.credentials);
        }
        
        return new PubSub(options);
      } catch (err) {
        throw new Error(`Failed to load Google Cloud Pub/Sub for Node.js: ${err.message}`);
      }
    } else {
      // In browser, we would typically use a backend service
      // since Pub/Sub client is not designed for browser use
      throw new Error('Direct Pub/Sub connection is not supported in browsers. Use a backend proxy or WebSocket bridge.');
    }
  }
  
  /**
   * Connect to Google Cloud Pub/Sub
   * @param {Object} options - Optional connection parameters to override constructor options
   */
  async connect(options = {}) {
    if (this.connected) {
      this._logDebug("Already connected");
      return;
    }
    
    // Update options if provided
    if (options.projectId) this.projectId = options.projectId;
    if (options.topicName) this.topicName = options.topicName;
    if (options.subscriptionName) this.subscriptionName = options.subscriptionName;
    if (options.credentials) this.credentials = options.credentials;
    if (options.peerId) this.peerId = options.peerId;
    
    if (!this.projectId || !this.topicName || !this.subscriptionName) {
      const error = new Error("Missing required GCP options (projectId, topicName, or subscriptionName)");
      this._logDebug(error.message);
      this.emit("error", error);
      return;
    }
    
    try {
      // Get Pub/Sub client
      this.pubSubClient = await this._loadPubSubClient();
      this._logDebug(`Connecting to GCP Pub/Sub: ${this.projectId}/${this.topicName}`);
      
      // Get topic and subscription
      this.topic = this.pubSubClient.topic(this.topicName);
      this.subscription = this.topic.subscription(this.subscriptionName);
      
      // Setup message handler
      this.messageHandler = this._setupMessageHandler();
      
      // Emit connect event
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Register this peer if we have an ID
      if (this.peerId) {
        this.register(this.peerId);
      }
      
      this.emit("connect");
    } catch (err) {
      this._logDebug("GCP connection error:", err.message);
      this.emit("error", err);
      this._handleDisconnect();
    }
  }
  
  /**
   * Setup Pub/Sub message handler
   * @private
   * @returns {Function} Unsubscribe function
   */
  _setupMessageHandler() {
    this._logDebug("Setting up Pub/Sub message handler");
    
    const messageHandler = (message) => {
      try {
        // Acknowledge the message
        message.ack();
        
        // Parse the message data
        const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
        this._handleMessage(data);
      } catch (err) {
        this._logDebug("Error handling message:", err.message);
        message.nack(); // Negative acknowledgment
      }
    };
    
    // Subscribe to messages
    this.subscription.on('message', messageHandler);
    
    // Return function to remove listener
    return () => {
      this.subscription.removeListener('message', messageHandler);
    };
  }
  
  /**
   * Handle Pub/Sub disconnection
   * @private
   */
  _handleDisconnect() {
    // Clean up message handler
    if (this.messageHandler) {
      this.messageHandler();
      this.messageHandler = null;
    }
    
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
   * Handle incoming Pub/Sub messages
   * @private
   * @param {Object} message - Parsed JSON message
   */
  _handleMessage(message) {
    this._logDebug("Received message:", message.type);
    
    switch (message.type) {
      case "registered":
        // Server confirmed our registration
        this._logDebug(`Registered with GCP, peer ID: ${message.peerId}`);
        this._logDebug(`Available peers: ${message.peers.length}`);
        
        // Store available peers
        message.peers.forEach(peerId => this.registeredPeers.add(peerId));
        
        // Emit the registered event with peer list
        this.emit("registered", message.peerId, message.peers);
        break;
        
      case "new_peer":
        // A new peer joined the network
        this._logDebug(`New peer joined: ${message.peerId}`);
        this.registeredPeers.add(message.peerId);
        this.emit("new_peer", message.peerId);
        break;
        
      case "signal":
        // Received signaling data from another peer
        this._logDebug(`Received signal from ${message.peerId}`);
        this.emit("signal", message.peerId, message.signal);
        break;
        
      case "error":
        // Server reported an error
        this._logDebug(`Server error: ${message.message}`);
        this.emit("server_error", message.message);
        break;
        
      default:
        // Unknown message type
        this._logDebug(`Unknown message type: ${message.type}`);
        this.emit("unknown_message", message);
    }
  }
  
  /**
   * Register this client with the GCP signaling service
   * @param {string} peerId - Peer ID to register
   * @returns {Promise<boolean>} - Whether the registration was successful
   */
  register(peerId) {
    if (!this.connected) {
      this._logDebug("Cannot register: not connected to GCP");
      return false;
    }
    
    if (!peerId) {
      const error = new Error("Cannot register: no peer ID provided");
      this._logDebug(error.message);
      this.emit("error", error);
      return false;
    }
    
    this.peerId = peerId;
    this._logDebug(`Registering with GCP using peer ID: ${peerId}`);
    
    return this.send({
      type: "register",
      peerId
    });
  }
  
  /**
   * Send a signal to another peer via GCP
   * @param {string} targetPeerId - Target peer ID
   * @param {Object} signal - Signal data
   */
  signal(targetPeerId, signal) {
    if (!this.peerId) {
      this._logDebug("Cannot signal: no peer ID set");
      this.emit("error", new Error("Cannot signal without a peer ID"));
      return false;
    }
    
    return this.send({
      type: "signal",
      target: targetPeerId,
      signal
    });
  }
  
  /**
   * Send data to the GCP Pub/Sub topic
   * @param {Object} data - Data object to send
   * @returns {Promise<boolean>} - Whether the send was successful
   */
  async send(data) {
    if (!this.connected || this.destroyed) {
      this._logDebug("Cannot send: not connected to GCP");
      return false;
    }
    
    try {
      // Add sender ID to the message
      const messageData = {
        ...data
      };
      
      // Add sender ID if available
      if (this.peerId) {
        messageData.sender = this.peerId;
      }
      
      // Publish the message to the topic
      const messageBuffer = Buffer.from(JSON.stringify(messageData));
      const messageId = await this.topic.publish(messageBuffer);
      
      this._logDebug(`Message published, ID: ${messageId}`);
      return true;
    } catch (err) {
      this._logDebug("Error sending data to GCP:", err.message);
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
   * Close the GCP Pub/Sub connection
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.messageHandler) {
      this._logDebug("Removing Pub/Sub message handler");
      this.messageHandler();
      this.messageHandler = null;
    }
    
    this.connected = false;
    this.registeredPeers.clear();
    this.pubSubClient = null;
    this.topic = null;
    this.subscription = null;
    
    this._logDebug("Disconnected from GCP Pub/Sub");
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

export default GCPTransport;