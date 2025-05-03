/**
 * Azure Transport for WebDHT
 * 
 * Handles client connection to Azure services for signaling
 * Supports Azure Web PubSub for real-time communication
 */
import EventEmitter from "../src/event-emitter.js";
import { ENV, distance } from "../src/utils.js";
import Logger from "../src/logger.js";

class AzureTransport extends EventEmitter {
  /**
     * Create a new Azure transport
     * @param {Object} options - Transport options
     * @param {string} options.connectionString - Azure Web PubSub connection string
     * @param {string} options.hubName - Azure Web PubSub hub name
     * @param {string} [options.peerId] - Local peer ID (optional, can be set later via register)
     * @param {boolean} options.useSignalR - Use Azure SignalR Service instead of Web PubSub (default: false)
     * @param {string} options.signalREndpoint - SignalR Service endpoint (required if useSignalR is true)
     * @param {string} options.accessKey - SignalR Service access key (required if useSignalR is true)
     * @param {boolean} options.autoReconnect - Whether to automatically reconnect (default: true)
     * @param {number} options.reconnectDelay - Delay between reconnection attempts in ms (default: 5000)
     * @param {number} options.maxReconnectAttempts - Maximum number of reconnection attempts (default: 10)
     * @param {boolean} options.debug - Enable debug logging
     */
  constructor(options = {}) {
    super();
    
    // Required options
    this.connectionString = options.connectionString;
    this.hubName = options.hubName;
    this.peerId = options.peerId || null; // peerId is now optional
    
    // SignalR specific options
    this.useSignalR = options.useSignalR || false;
    this.signalREndpoint = options.signalREndpoint;
    this.accessKey = options.accessKey;
    
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
    
    // Azure client instances
    this.client = null;
    this.connection = null;
    
    // Initialize logger
    this.logger = new Logger("AzureTransport");
    
    // Connect immediately if required options are provided
    if ((this.connectionString && this.hubName) || 
        (this.useSignalR && this.signalREndpoint && this.accessKey)) {
      this.connect();
    }
  }
  
  /**
   * Helper for conditional debug logging
   * @private
   */
  _logDebug(...args) {
    if (this.debug && this.logger?.debug) {
      const prefix = `Azure:${this.peerId ? this.peerId.substring(0, 8) : 'unregistered'}`;
      this.logger.debug(`[${prefix}]`, ...args);
    }
  }
  
  /**
   * Load Azure SDK dynamically
   * @private
   * @returns {Promise<Object>} Azure SDK client
   */
  async _loadAzureSDK() {
    this._logDebug("Loading Azure SDK");
    
    if (ENV.NODE) {
      try {
        if (this.useSignalR) {
          // In Node.js, use dynamic import for SignalR
          const { HubConnectionBuilder } = await import('@microsoft/signalr');
          return { HubConnectionBuilder };
        } else {
          // In Node.js, use dynamic import for Web PubSub
          const { WebPubSubClient } = await import('@azure/web-pubsub-client');
          return { WebPubSubClient };
        }
      } catch (err) {
        throw new Error(`Failed to load Azure SDK for Node.js: ${err.message}`);
      }
    } else {
      // In browser, Azure SDKs must be loaded via script tag
      if (this.useSignalR) {
        if (typeof signalR === 'undefined') {
          throw new Error('SignalR SDK not loaded. Include <script src="https://cdn.jsdelivr.net/npm/@microsoft/signalr@latest/dist/browser/signalr.min.js"></script> in your HTML');
        }
        return { HubConnectionBuilder: window.signalR.HubConnectionBuilder };
      } else {
        if (typeof WebPubSubClient === 'undefined') {
          throw new Error('Azure Web PubSub SDK not loaded. Include <script src="https://cdn.jsdelivr.net/npm/@azure/web-pubsub-client@latest/dist/browser/index.min.js"></script> in your HTML');
        }
        return { WebPubSubClient: window.WebPubSubClient };
      }
    }
  }
  
  /**
   * Connect to Azure Web PubSub or SignalR Service
   * @param {Object} options - Optional connection parameters to override constructor options
   */
  async connect(options = {}) {
    if (this.connected) {
      this._logDebug("Already connected");
      return;
    }
    
    // Update options if provided
    if (options.connectionString) this.connectionString = options.connectionString;
    if (options.hubName) this.hubName = options.hubName;
    if (options.useSignalR !== undefined) this.useSignalR = options.useSignalR;
    if (options.signalREndpoint) this.signalREndpoint = options.signalREndpoint;
    if (options.accessKey) this.accessKey = options.accessKey;
    
    // Validate required options
    if (this.useSignalR) {
      if (!this.signalREndpoint || !this.accessKey) {
        const error = new Error("Missing required Azure SignalR options (signalREndpoint or accessKey)");
        this._logDebug(error.message);
        this.emit("error", error);
        return;
      }
    } else {
      if (!this.connectionString || !this.hubName) {
        const error = new Error("Missing required Azure Web PubSub options (connectionString or hubName)");
        this._logDebug(error.message);
        this.emit("error", error);
        return;
      }
    }
    
    try {
      // Get Azure SDK client
      const azureSdk = await this._loadAzureSDK();
      
      if (this.useSignalR) {
        // SignalR Service connection
        this._logDebug(`Connecting to Azure SignalR Service: ${this.signalREndpoint}`);
        const { HubConnectionBuilder } = azureSdk;
        
        this.client = new HubConnectionBuilder()
          .withUrl(`${this.signalREndpoint}/client/?hub=${this.hubName}`, {
            accessTokenFactory: () => this.accessKey
          })
          .withAutomaticReconnect({
            nextRetryDelayInMilliseconds: retryContext => {
              if (retryContext.elapsedMilliseconds < this.maxReconnectAttempts * this.reconnectDelay) {
                return this.reconnectDelay;
              } else {
                return null;
              }
            }
          })
          .build();
          
        // Set up event handlers
        this._setupSignalRListeners();
        
        // Start the connection
        await this.client.start();
      } else {
        // Web PubSub connection
        this._logDebug(`Connecting to Azure Web PubSub: ${this.hubName}`);
        const { WebPubSubClient } = azureSdk;
        
        this.client = new WebPubSubClient({
          connectionString: this.connectionString,
          hub: this.hubName
        });
        
        // Set up event handlers
        this._setupWebPubSubListeners();
        
        // Start the connection
        await this.client.start();
      }
      
      // Emit connect event
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Register this peer if we have an ID
      if (this.peerId) {
        this.register(this.peerId);
      }
      
      this.emit("connect");
    } catch (err) {
      this._logDebug("Azure connection error:", err.message);
      this.emit("error", err);
      this._handleDisconnect();
    }
  }
  
  /**
   * Setup Azure SignalR Service event listeners
   * @private
   */
  _setupSignalRListeners() {
    this.client.onclose((error) => {
      this._logDebug("SignalR connection closed", error);
      this._handleDisconnect();
    });
    
    // Register message handlers
    this.client.on("registered", (peerId, peers) => {
      this._logDebug(`Registered with Azure, peer ID: ${peerId}`);
      this._logDebug(`Available peers: ${peers.length}`);
      
      // Store peerId that was assigned by the server
      this.peerId = peerId;
      
      // Check if we can calculate XOR distance (we need our own peerId)
      let peerList = peers;
      
      if (this.peerId) {
        try {
          // Filter and sort peers by XOR distance (closest first)
          peerList = peers
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
        } catch (err) {
          this._logDebug(`Error calculating peer distances: ${err.message}`);
        }
      }
      
      // Store available peers
      peerList.forEach(peerId => this.registeredPeers.add(peerId));
      
      // Emit the registered event with peer list
      this.emit("registered", peerId, peerList);
    });
    
    this.client.on("new_peer", (peerId) => {
      this._logDebug(`New peer joined: ${peerId}`);
      
      // Check if we can calculate XOR distance (we need our own peerId)
      if (!this.peerId) {
        // If we don't have our own ID yet, just add the peer and emit the event
        this.registeredPeers.add(peerId);
        this.emit("new_peer", peerId);
        return;
      }
      
      try {
        // Calculate XOR distance to the new peer
        const newPeerDistance = distance(this.peerId, peerId);
        
        // Calculate distances to existing peers and include the new peer
        const allPeers = [...this.registeredPeers, peerId];
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
        if (closestPeers.includes(peerId)) {
          this.emit("new_peer", peerId);
        } else {
          this._logDebug(`New peer ${peerId} is not among the ${this.K} closest peers; ignoring`);
        }
      } catch (err) {
        // If any error occurs during distance calculation, fall back to simple behavior
        this._logDebug(`Error calculating peer distances: ${err.message}`);
        this.registeredPeers.add(peerId);
        this.emit("new_peer", peerId);
      }
    });
    
    this.client.on("signal", (peerId, signal) => {
      this._logDebug(`Received signal from ${peerId}`);
      this.emit("signal", peerId, signal);
    });
    
    this.client.on("error", (message) => {
      this._logDebug(`Server error: ${message}`);
      this.emit("server_error", message);
    });
  }
  
  /**
   * Setup Azure Web PubSub event listeners
   * @private
   */
  _setupWebPubSubListeners() {
    this.client.on("disconnected", () => {
      this._logDebug("Web PubSub connection closed");
      this._handleDisconnect();
    });
    
    // Handle incoming messages
    this.client.on("message", (message) => {
      try {
        const data = JSON.parse(message.data);
        this._handleMessage(data);
      } catch (err) {
        this._logDebug("Error parsing message:", err.message);
        this.emit("error", new Error("Invalid message format"));
      }
    });
  }
  
  /**
   * Handle disconnection from Azure services
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
   * Handle incoming messages from Azure Web PubSub
   * @private
   * @param {Object} message - Parsed JSON message
   */
  _handleMessage(message) {
    this._logDebug("Received message:", message.type);
    
    switch (message.type) {
      case "registered":
        // Server confirmed our registration
        this._logDebug(`Registered with Azure, peer ID: ${message.peerId}`);
        this._logDebug(`Available peers: ${message.peers.length}`);
        
        // Store peerId that was assigned by the server
        this.peerId = message.peerId;
        
        // Check if we can calculate XOR distance (we need our own peerId)
        let peerList = message.peers;
        
        if (this.peerId) {
          try {
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
          } catch (err) {
            this._logDebug(`Error calculating peer distances: ${err.message}`);
          }
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
          break;
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
   * Register this client with the Azure signaling service
   * @param {string} peerId - Peer ID to register
   * @returns {boolean|Promise<boolean>} - Whether the registration was successful
   */
  register(peerId) {
    if (!this.connected) {
      this._logDebug("Cannot register: not connected to Azure");
      return false;
    }
    
    if (!peerId) {
      this._logDebug("Cannot register: no peer ID provided");
      return false;
    }
    
    this.peerId = peerId;
    this._logDebug(`Registering with Azure using peer ID: ${peerId}`);
    
    if (this.useSignalR) {
      // For SignalR, invoke the register method
      return this.client.invoke("Register", peerId)
        .then(() => true)
        .catch(err => {
          this._logDebug("Error registering with SignalR:", err.message);
          this.emit("error", err);
          return false;
        });
    } else {
      // For Web PubSub, send a register message
      return this.send({
        type: "register",
        peerId
      });
    }
  }
  
  /**
   * Send a signal to another peer via Azure
   * @param {string} targetPeerId - Target peer ID
   * @param {Object} signal - Signal data
   */
  signal(targetPeerId, signal) {
    if (!this.peerId) {
      this._logDebug("Cannot signal: not registered with a peer ID");
      return false;
    }
    
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

    if (this.useSignalR) {
      return this.client.invoke("Signal", targetPeerId, signal)
        .then(() => true)
        .catch(err => {
          this._logDebug("Error sending signal with SignalR:", err.message);
          this.emit("error", err);
          return false;
        });
    } else {
      return this.send({
        type: "signal",
        target: targetPeerId,
        signal
      });
    }
  }
  
  /**
   * Send data to the Azure service
   * @param {Object} data - Data object to send
   * @returns {boolean|Promise<boolean>} - Whether the send was successful
   */
  async send(data) {
    if (!this.connected || this.destroyed) {
      this._logDebug("Cannot send: not connected to Azure");
      return false;
    }
    
    if (!this.peerId && data.type !== "register") {
      this._logDebug("Cannot send: not registered with a peer ID");
      return false;
    }
    
    try {
      if (this.useSignalR) {
        // SignalR uses method invocation
        await this.client.invoke("SendMessage", JSON.stringify(data));
      } else {
        // Web PubSub uses sendEvent or publish
        await this.client.sendEvent({
          data: JSON.stringify(data),
          dataType: "json"
        });
      }
      return true;
    } catch (err) {
      this._logDebug("Error sending data to Azure:", err.message);
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
   * Close the Azure connection
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.client) {
      this._logDebug("Closing Azure connection");
      
      if (this.useSignalR) {
        // Stop SignalR connection
        this.client.stop().catch(err => {
          this._logDebug("Error stopping SignalR connection:", err.message);
        });
      } else {
        // Stop Web PubSub connection
        this.client.stop().catch(err => {
          this._logDebug("Error stopping Web PubSub connection:", err.message);
        });
      }
      
      this.client = null;
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

export default AzureTransport;