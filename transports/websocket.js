/**
 * WebSocket Transport for WebDHT
 * 
 * Handles client connection to the signaling server using WebSockets
 */
import EventEmitter from "../src/event-emitter.js";
import { ENV, distance } from "../src/utils.js";
import Logger from "../src/logger.js";
// Import WebSocket library conditionally based on environment
let WebSocket;
if (ENV.BROWSER) {
  WebSocket = window.WebSocket;
} else if (ENV.NODE) {
  const wsModule = await import('ws');
  WebSocket = wsModule.default;
} else {
  throw new Error('Unsupported environment for WebSocket transport');
}

class WebSocketTransport extends EventEmitter {
  /**
   * Create a new WebSocket transport
   * @param {Object} options - Transport options
   * @param {string} options.url - WebSocket server URL
   * @param {string} options.peerId - Local peer ID (optional, can be set later via register)
   * @param {boolean} options.autoReconnect - Whether to automatically reconnect (default: true)
   * @param {number} options.reconnectDelay - Delay between reconnection attempts in ms (default: 5000)
   * @param {number} options.maxReconnectAttempts - Maximum number of reconnection attempts (default: 10)
   * @param {boolean} options.debug - Enable debug logging
   */
  constructor(options = {}) {
    super();
    
    // Required options
    this.url = options.url;
    
    // Optional settings with defaults
    this.peerId = options.peerId; // Can be set later via register
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
    this.logger = new Logger("WebSocketTransport");
    
    // Connect immediately if URL is provided
    if (this.url) {
      this.connect();
    }
  }
  
  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug && this.logger?.debug) {
      const prefix = `WS:${this.peerId ? this.peerId.substring(0, 8) : 'unregistered'}`;
      this.logger.debug(`[${prefix}]`, ...args);
    }
  }
  
  /**
   * Connect to the WebSocket server
   * @param {string} url - Optional URL to override the one provided in constructor
   */
  connect(url) {
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || 
                         this.socket.readyState === WebSocket.OPEN)) {
      this._logDebug("Already connected or connecting");
      return;
    }
    
    if (url) {
      this.url = url;
    }
    
    if (!this.url) {
      const error = new Error("No WebSocket URL provided");
      this._logDebug(error.message);
      this.emit("error", error);
      return;
    }
    
    try {
      this._logDebug(`Connecting to ${this.url}`);
      
      // Create WebSocket instance
      this.socket = new WebSocket(this.url);
      
      this._setupListeners();
    } catch (err) {
      this._logDebug("Connection error:", err.message);
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
      this._logDebug("WebSocket connected");
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Register this peer if we have an ID
      if (this.peerId) {
        this.register(this.peerId);
      }
      
      this.emit("connect");
    };
    
    this.socket.onclose = (event) => {
      this._logDebug(`WebSocket closed: ${event.code} ${event.reason}`);
      this._handleDisconnect();
    };
    
    this.socket.onerror = (err) => {
      this._logDebug("WebSocket error:", err);
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
        this._logDebug(`Registered with server, peer ID: ${message.peerId}`);
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
   * Register this client with the server
   * @param {string} peerId - Peer ID to register
   * @returns {boolean} - Whether the registration was successful
   * @description Can be called after connection if peerId wasn't provided in constructor
   */
  register(peerId) {
    if (!this.connected) {
      this._logDebug("Cannot register: not connected");
      return false;
    }
    
    this.peerId = peerId;
    this._logDebug(`Registering with peer ID: ${peerId}`);
    
    return this.send({
      type: "register",
      peerId
    });
  }
  
  /**
   * Send a signal to another peer
   * @param {string} targetPeerId - Target peer ID
   * @param {Object} signal - Signal data
   * @returns {boolean} - Whether the signal was sent successfully
   */
  signal(targetPeerId, signal) {
    if (!this.peerId) {
      this._logDebug("Cannot signal: no peerId registered");
      this.emit("error", new Error("Cannot signal without a registered peerId"));
      return false;
    }
    
    // Enhanced signal validation before sending
    if (!signal) {
      this._logDebug("Cannot signal: signal data is null or undefined");
      this.emit("error", new Error("Cannot send null or undefined signal data"));
      return false;
    }
    
    // Ensure signal has a type (required for WebRTC)
    if (!signal.type) {
      this._logDebug("Signal missing type field");
      this.emit("error", new Error("Cannot send signal without type field"));
      return false;
    }
    
    // Validate signal type
    const validSignalTypes = ['offer', 'answer', 'candidate', 'renegotiate', 'PING'];
    if (!validSignalTypes.includes(signal.type)) {
      this._logDebug(`Warning: Unknown signal type ${signal.type}`);
      // Still allow it for compatibility, but log warning
    }
    
    // Validate offer/answer signals
    if (signal.type === 'offer' || signal.type === 'answer') {
      if (!signal.sdp) {
        this._logDebug(`Invalid ${signal.type} signal: missing SDP`);
        this.emit("error", new Error(`Cannot send ${signal.type} signal without SDP`));
        return false;
      }
    }
    
    // Validate candidate signals
    if (signal.type === 'candidate' && !signal.candidate) {
      this._logDebug("Invalid ICE candidate: missing candidate data");
      this.emit("error", new Error("Cannot send ICE candidate without candidate data"));
      return false;
    }
    
    return this.send({
      type: "signal",
      target: targetPeerId,
      signal
    });
  }
  
  /**
   * Send data to the WebSocket server
   * @param {Object} data - Data object to send
   * @returns {boolean} - Whether the send was successful
   */
  send(data) {
    if (!this.connected || this.destroyed) {
      this._logDebug("Cannot send: not connected");
      return false;
    }
    
    try {
      this.socket.send(JSON.stringify(data));
      return true;
    } catch (err) {
      this._logDebug("Error sending data:", err.message);
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
   * Close the WebSocket connection
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.socket) {
      this._logDebug("Closing WebSocket connection");
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

export default WebSocketTransport;