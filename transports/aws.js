/**
 * AWS Transport for WebDHT
 * 
 * Handles client connection to AWS services for signaling
 * Supports AWS API Gateway WebSocket API for real-time communication
 */
import EventEmitter from "../src/event-emitter.js";
import { ENV, distance } from "../src/utils.js";
import Logger from "../src/logger.js";

class AWSTransport extends EventEmitter {
  /**
   * Create a new AWS transport
   * @param {Object} options - Transport options
   * @param {string} options.webSocketUrl - AWS API Gateway WebSocket URL
   * @param {string} options.region - AWS region
   * @param {string} options.accessKeyId - AWS access key ID (optional, can use environment variables)
   * @param {string} options.secretAccessKey - AWS secret access key (optional, can use environment variables)
   * @param {string} options.sessionToken - AWS session token (optional)
   * @param {string} [options.peerId] - Local peer ID (optional, can be set later via register method)
   * @param {boolean} options.autoReconnect - Whether to automatically reconnect (default: true)
   * @param {number} options.reconnectDelay - Delay between reconnection attempts in ms (default: 5000)
   * @param {number} options.maxReconnectAttempts - Maximum number of reconnection attempts (default: 10)
   * @param {boolean} options.debug - Enable debug logging
   */
  constructor(options = {}) {
    super();
    
    // Required options
    this.webSocketUrl = options.webSocketUrl;
    this.region = options.region;
    
    // peerId can be optional and set later via register method
    this.peerId = options.peerId || null;
    
    // AWS credentials
    this.credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken
    };
    
    // Optional settings with defaults
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
    this.logger = new Logger("AWSTransport");
    
    // Connect immediately if URL is provided
    if (this.webSocketUrl) {
      this.connect();
    }
  }
  
  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug && this.logger?.debug) {
      const prefix = `AWS:${this.peerId ? this.peerId.substring(0, 8) : 'unregistered'}`;
      this.logger.debug(`[${prefix}]`, ...args);
    }
  }
  
  /**
   * Load AWS SDK dynamically (to avoid bundling issues)
   * @private
   * @returns {Promise<Object>} AWS SDK modules
   */
  async _loadAWSSDK() {
    this._logDebug("Loading AWS SDK");
    
    if (ENV.NODE) {
      try {
        // In Node.js, use dynamic import
        const AWS = await import('aws-sdk');
        return {
          AWS,
          credentials: new AWS.Credentials(this.credentials)
        };
      } catch (err) {
        throw new Error(`Failed to load AWS SDK for Node.js: ${err.message}`);
      }
    } else {
      // In browser, AWS SDK must be loaded via script tag
      if (typeof AWS === 'undefined') {
        throw new Error('AWS SDK not loaded. Include <script src="https://sdk.amazonaws.com/js/aws-sdk-2.x.x.min.js"></script> in your HTML');
      }
      
      // Use global AWS object
      return {
        AWS: window.AWS,
        credentials: new AWS.Credentials(this.credentials)
      };
    }
  }
  
  /**
   * Sign WebSocket URL with AWS credentials
   * @private
   * @returns {Promise<string>} Signed WebSocket URL
   */
  async _getSignedUrl() {
    try {
      const { AWS, credentials } = await this._loadAWSSDK();
      
      // Configure AWS with credentials if provided
      if (this.credentials.accessKeyId && this.credentials.secretAccessKey) {
        AWS.config.update({
          region: this.region,
          credentials
        });
      } else {
        // Use environment variables or instance profiles
        AWS.config.update({ region: this.region });
      }
      
      // For browser usage, we return the plain WebSocket URL
      // as signing would typically be done by a backend service
      if (ENV.BROWSER) {
        return this.webSocketUrl;
      }
      
      // For Node.js, we can use AWS SDK to sign the URL
      const apigatewaymanagementapi = new AWS.ApiGatewayManagementApi({
        apiVersion: '2018-11-29',
        endpoint: this.webSocketUrl.replace('wss://', '')
      });
      
      // This is a simplified version - in a real implementation,
      // you would use IAM authentication and AWS SigV4 to sign the WebSocket URL
      return this.webSocketUrl;
    } catch (err) {
      this._logDebug("Error signing WebSocket URL:", err.message);
      throw err;
    }
  }
  
  /**
   * Connect to the AWS WebSocket API
   * @param {string} url - Optional URL to override the one provided in constructor
   */
  async connect(url) {
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || 
                         this.socket.readyState === WebSocket.OPEN)) {
      this._logDebug("Already connected or connecting");
      return;
    }
    
    if (url) {
      this.webSocketUrl = url;
    }
    
    if (!this.webSocketUrl) {
      const error = new Error("No AWS WebSocket URL provided");
      this._logDebug(error.message);
      this.emit("error", error);
      return;
    }
    
    try {
      // Get signed WebSocket URL for secure connections
      const signedUrl = await this._getSignedUrl();
      this._logDebug(`Connecting to AWS WebSocket API: ${this.webSocketUrl}`);
      
      // Create WebSocket instance
      this.socket = new WebSocket(signedUrl);
      
      this._setupListeners();
    } catch (err) {
      this._logDebug("AWS connection error:", err.message);
      this.emit("error", err);
      this._handleDisconnect();
    }
  }
  
  /**
   * Setup WebSocket event listeners
   * @private
   */
  _setupListeners() {
    this.socket.onopen = () => {
      this._logDebug("AWS WebSocket connected");
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Register this peer if we have an ID
      if (this.peerId) {
        this.register(this.peerId);
      }
      
      this.emit("connect");
    };
    
    this.socket.onclose = (event) => {
      this._logDebug(`AWS WebSocket closed: ${event.code} ${event.reason}`);
      this._handleDisconnect();
    };
    
    this.socket.onerror = (err) => {
      this._logDebug("AWS WebSocket error:", err);
      this.emit("error", err);
    };
    
    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this._handleMessage(message);
      } catch (err) {
        this._logDebug("Error parsing message:", err.message);
        this.emit("error", new Error("Invalid message format"));
      }
    };
  }
  
  /**
   * Handle WebSocket disconnection
   * @private
   */
  _handleDisconnect() {
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
   * Handle incoming WebSocket messages
   * @private
   * @param {Object} message - Parsed JSON message
   */
  _handleMessage(message) {
    this._logDebug("Received message:", message.type);
    
    switch (message.type) {
      case "registered":
        // Server confirmed our registration
        this._logDebug(`Registered with AWS, peer ID: ${message.peerId}`);
        this._logDebug(`Available peers: ${message.peers.length}`);
        
        // Store peerId that was assigned by the server
        this.peerId = message.peerId;
        
        // Check if we can calculate XOR distance (we need our own peerId)
        let peerList = message.peers;
        
        if (this.peerId) {
          // Filter and sort peers by XOR distance (closest first)
          peerList = message.peers
            .map(id => ({
              id: id,
              distance: distance(this.peerId, id)
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
        }
        
        // Store available peers
        peerList.forEach(peerId => this.registeredPeers.add(peerId));
        
        // Emit the registered event with peer list
        this.emit("registered", message.peerId, peerList);
        break;
        
      case "new_peer":
        // A new peer joined the network
        this._logDebug(`New peer joined: ${message.peerId}`);
        
        // Check if we can calculate XOR distance (we need our own peerId)
        if (!this.peerId) {
          // If we don't have our own ID yet, just add the peer and emit the event
          this.registeredPeers.add(message.peerId);
          this.emit("new_peer", message.peerId);
          return;
        }
        
        try {
          // Calculate XOR distance to the new peer
          const newPeerDistance = distance(this.peerId, message.peerId);
          
          // Calculate distances to existing peers and include the new peer
          const allPeers = [...this.registeredPeers, message.peerId];
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
          if (closestPeers.includes(message.peerId)) {
            this.emit("new_peer", message.peerId);
          } else {
            this._logDebug(`New peer ${message.peerId} is not among the ${this.K} closest peers; ignoring`);
          }
        } catch (err) {
          // If any error occurs during distance calculation, fall back to simple behavior
          this._logDebug(`Error calculating peer distances: ${err.message}`);
          this.registeredPeers.add(message.peerId);
          this.emit("new_peer", message.peerId);
        }
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
   * Register this client with the AWS signaling server
   * @param {string} peerId - Peer ID to register
   * @returns {boolean} - Whether the registration was successful
   */
  register(peerId) {
    if (!this.connected) {
      this._logDebug("Cannot register: not connected to AWS");
      return false;
    }
    
    if (!peerId) {
      this._logDebug("Cannot register: no peer ID provided");
      return false;
    }
    
    this.peerId = peerId;
    this._logDebug(`Registering with AWS using peer ID: ${peerId}`);
    
    return this.send({
      action: "register",  // Uses 'action' instead of 'type' for API Gateway compatibility
      peerId
    });
  }
  
  /**
   * Send a signal to another peer via AWS
   * @param {string} targetPeerId - Target peer ID
   * @param {Object} signal - Signal data
   * @returns {boolean} - Whether the signal was sent successfully
   */
  signal(targetPeerId, signal) {
    if (!this.peerId) {
      this._logDebug("Cannot signal: no local peer ID set");
      return false;
    }
    return this.send({
      action: "signal",  // Uses 'action' instead of 'type' for API Gateway compatibility
      target: targetPeerId,
      signal
    });
  }
  
  /**
   * Send data to the AWS WebSocket server
   * @param {Object} data - Data object to send
   * @returns {boolean} - Whether the send was successful
   */
  send(data) {
    if (!this.connected || this.destroyed) {
      this._logDebug("Cannot send: not connected to AWS");
      return false;
    }
    
    try {
      this.socket.send(JSON.stringify(data));
      return true;
    } catch (err) {
      this._logDebug("Error sending data to AWS:", err.message);
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
   * Close the AWS WebSocket connection
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.socket) {
      this._logDebug("Closing AWS WebSocket connection");
      this.socket.close();
      this.socket = null;
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

export default AWSTransport;