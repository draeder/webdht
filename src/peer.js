/**
 * Peer connection handler
 */
import EventEmitter from './event-emitter.js';
import { getSimplePeer } from './peer-factory.js';
import { ENV, bufferToHex } from './utils.js';

class Peer extends EventEmitter {
  /**
   * Create a new peer connection
   * @param {Object} options - Connection options
   * @param {Buffer} options.nodeId - Local node ID
   * @param {Buffer} options.peerId - Remote peer ID 
   * @param {boolean} options.initiator - Whether this peer is the initiator
   * @param {Object} options.signal - Signal data (optional)
   */
  constructor(options = {}) {
    super();
    
    this.nodeId = options.nodeId;
    this.peerId = options.peerId;
    
    // Handle both Buffer and hex string peer IDs
    if (typeof this.peerId === 'string') {
      this.peerIdHex = this.peerId;
    } else if (this.peerId) {
      // Convert Buffer to hex string
      this.peerIdHex = bufferToHex(this.peerId);
      // Ensure peerId is also a string for simplePeer
      this.peerId = this.peerIdHex;
    } else {
      this.peerIdHex = null;
    }
    
    console.log(`Creating peer connection with ${this.peerIdHex ? this.peerIdHex.substring(0, 8) + '...' : 'unknown'}`);
    
    this.connected = false;
    this.destroyed = false;
    this.initialized = false;
    
    // Store options for later initialization
    this.options = {
      initiator: options.initiator || false,
      trickle: options.trickle !== false, // Default to true
      config: {
        iceServers: options.iceServers || [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    };
    
    // Initialize the peer (async)
    this._initialize();
    
    // Handle incoming signals (queue them until initialized)
    this.signalQueue = [];
    if (options.signal) {
      console.log('Signal data provided at initialization, queueing');
      this.signalQueue.push(options.signal);
    }
  }
  
  /**
   * Initialize the peer connection (async)
   * @private
   */
  async _initialize() {
    if (this.destroyed) {
      console.log('Cannot initialize destroyed peer');
      return;
    }
    
    if (this.initialized) {
      console.log('Peer already initialized');
      return;
    }
    
    console.log(`Initializing peer connection with ${this.peerIdHex?.substring(0, 8)}... (initiator=${this.options.initiator})`);
    
    try {
      // Get the SimplePeer constructor
      const SimplePeer = await getSimplePeer();
      
      // Add enhanced WebRTC configuration
      const enhancedOptions = {
        ...this.options,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.stunprotocol.org:3478' },
          ]
        },
        // Additional options for better reliability
        trickle: true,
        sdpTransform: (sdp) => {
          // Log the SDP for debugging
          console.log(`[${this.options.initiator ? 'INITIATOR' : 'RESPONDER'}] SDP generated for ${this.peerIdHex?.substring(0, 8)}`);
          return sdp;
        },
        objectMode: false,  // Use Uint8Array binary data
      };
      
      // Create the peer connection with enhanced options
      this.peer = new SimplePeer(enhancedOptions);
      this.initialized = true;
      console.log(`SimplePeer created for ${this.peerIdHex?.substring(0, 8)}... as ${this.options.initiator ? 'INITIATOR' : 'RESPONDER'}`);
      
      // Set up event handlers
      this._setupPeerHandlers();
      
      // Process queued signals
      if (this.signalQueue.length > 0) {
        console.log(`Processing ${this.signalQueue.length} queued signals for ${this.peerIdHex?.substring(0, 8)}...`);
        
        // Sort signals - offers first, then candidates
        this.signalQueue.sort((a, b) => {
          if (a.type === 'offer') return -1;
          if (b.type === 'offer') return 1;
          if (a.type === 'answer') return -1;
          if (b.type === 'answer') return 1;
          return 0;
        });
        
        while (this.signalQueue.length > 0) {
          const signal = this.signalQueue.shift();
          console.log(`Processing queued signal type=${signal.type || 'unknown'} for ${this.peerIdHex?.substring(0, 8)}...`);
          if (this.peer) this.peer.signal(signal);
        }
      }
    } catch (err) {
      console.error(`Error initializing peer ${this.peerIdHex?.substring(0, 8)}:`, err);
      this.emit('error', err, this.peerIdHex);
    }
  }
  
  /**
   * Setup event listeners for the peer
   * @private
   */
  _setupPeerHandlers() {
    if (!this.peer) {
      console.error('Cannot setup handlers - peer not initialized');
      return;
    }
    
    console.log(`Setting up handlers for peer ${this.peerIdHex?.substring(0, 8)}...`);
    
    this.peer.on('signal', data => {
      console.log(`Peer: Generated signal data for ${this.peerIdHex?.substring(0, 8)}...`, data.type || 'no type');
      // Make sure to pass both the signal data AND the peer ID
      this.emit('signal', data, this.peerIdHex);
    });
    
    this.peer.on('connect', () => {
      console.log(`!!!! SUCCESSFULLY CONNECTED to peer ${this.peerIdHex?.substring(0, 8)}... !!!`);
      this.connected = true;
      
      // Send a ping immediately to confirm the connection works
      try {
        this.send({type: 'PING', sender: this.peerIdHex});
        console.log(`Sent initial PING to ${this.peerIdHex?.substring(0, 8)}`);
      } catch (err) {
        console.error(`Failed to send initial PING: ${err.message}`);
      }
      
      this.emit('connect', this.peerIdHex);
    });
    
    this.peer.on('data', data => {
      console.log(`Received raw data from peer ${this.peerIdHex?.substring(0, 8)}...`);
      
      // First, emit the raw data event regardless of format
      this.emit('data', data, this.peerIdHex);
      
      let message;
      try {
        // Handle different data formats (string, Uint8Array, etc.)
        if (typeof data === 'string') {
          message = JSON.parse(data);
        } else if (data instanceof Uint8Array) {
          const decoder = new TextDecoder();
          const str = decoder.decode(data);
          message = JSON.parse(str);
        } else if (typeof data === 'object' && data !== null) {
          // Already an object
          message = data;
        } else {
          // Unknown format
          console.log(`Received data in unknown format from ${this.peerIdHex?.substring(0, 8)}...`);
          return;
        }
        
        // Automatically respond to PING with PONG to maintain connection
        if (message.type === 'PING') {
          this.send({type: 'PONG', sender: this.peerIdHex});
          console.log(`Received PING, sent PONG to ${this.peerIdHex?.substring(0, 8)}`);
        }
        
        // Log all DHT-related messages for debugging
        if (message.type && ['STORE', 'FIND_VALUE', 'FIND_NODE', 'STORE_RESPONSE', 'FIND_VALUE_RESPONSE'].includes(message.type)) {
          console.log(`DHT message from ${this.peerIdHex?.substring(0, 8)}: ${message.type}`, 
            message.key ? `key=${message.key.substring(0, 8)}...` : '');
        }
        
        // Emit the parsed message event
        this.emit('message', message, this.peerIdHex);
      } catch (err) {
        console.error(`Error parsing message from ${this.peerIdHex?.substring(0, 8)}:`, err.message);
      }
    });
    
    this.peer.on('close', () => {
      console.log(`WebRTC connection closed for peer ${this.peerIdHex?.substring(0, 8)}`);
      this.connected = false;
      this.emit('close', this.peerIdHex);
    });
    
    this.peer.on('error', err => {
      console.error(`WebRTC error with peer ${this.peerIdHex?.substring(0, 8)}: ${err.message}`);
      this.emit('error', err, this.peerIdHex);
    });
  }
  
  /**
   * Signal the peer connection
   * @param {Object} data - Signal data
   */
  signal(data) {
    if (this.destroyed) {
      console.log(`Cannot signal destroyed peer ${this.peerIdHex?.substring(0, 8)}...`);
      return;
    }
    
    // CRITICAL FIX: Implement robust signal handling and state conflict prevention
    if (data && data.type === 'offer' && this.options.initiator) {
      console.error(`STATE CONFLICT: Received offer but we're already the initiator for ${this.peerIdHex?.substring(0, 8)}...`);
      
      // Need to destroy this peer and recreate as non-initiator
      console.log(`FIXING STATE CONFLICT: Recreating peer ${this.peerIdHex?.substring(0, 8)}... as non-initiator`);
      
      // Save the offer to apply after recreation
      const offerToApply = data;
      
      // Recreate SimplePeer with reversed initiator flag
      this.destroy();
      
      // Set initiator to false and recreate
      this.options.initiator = false;
      this.initialized = false;
      this.signalQueue = [offerToApply]; // Queue the offer
      this._initialize();
      return;
    }
    
    if (data && data.type === 'answer' && !this.options.initiator) {
      console.error(`STATE CONFLICT: Received answer but we're not the initiator for ${this.peerIdHex?.substring(0, 8)}...`);
      // This is less critical - we can just log the error but continue
    }
    
    if (!this.initialized) {
      // If the peer isn't initialized yet, queue the signal
      console.log(`Queueing signal for uninitialized peer ${this.peerIdHex?.substring(0, 8)}...`);
      this.signalQueue.push(data);
      // Initialize the peer
      this._initialize();
      return;
    }
    
    if (!this.peer) {
      console.log(`Cannot signal peer ${this.peerIdHex?.substring(0, 8)}... - peer not initialized`);
      return;
    }
    
    // Pass the signal to the SimplePeer instance
    console.log(`Signaling peer ${this.peerIdHex?.substring(0, 8)}... with signal type ${data.type || 'candidate'}`);
    try {
      // Log better signal information
      console.log(`Sending signal type=${data.type || 'unknown'} to peer ${this.peerIdHex?.substring(0, 8)}...`);
      this.peer.signal(data);
    } catch (err) {
      console.error(`Error signaling peer ${this.peerIdHex?.substring(0, 8)}...:`, err);
      this.emit('error', err, this.peerIdHex);
    }
  }
  
  /**
   * Send data to the peer
   * @param {Object|Buffer|string} data - Data to send
   */
  send(data) {
    if (!this.connected || this.destroyed || !this.initialized || !this.peer) {
      console.warn(`Cannot send to peer ${this.peerIdHex?.substring(0, 8)}: not connected or destroyed`);
      return false;
    }
    
    try {
      // Convert objects to JSON strings
      if (typeof data === 'object' && !(data instanceof Uint8Array)) {
        // Log DHT protocol messages for debugging
        if (data.type && ['STORE', 'FIND_VALUE', 'FIND_NODE', 'STORE_RESPONSE', 'FIND_VALUE_RESPONSE'].includes(data.type)) {
          console.log(`Sending DHT ${data.type} to ${this.peerIdHex?.substring(0, 8)}`, 
            data.key ? `key=${data.key.substring(0, 8)}...` : '');
        }
        
        data = JSON.stringify(data);
      }
      
      this.peer.send(data);
      return true;
    } catch (err) {
      console.error(`Error sending to peer ${this.peerIdHex?.substring(0, 8)}:`, err.message);
      this.emit('error', err, this.peerIdHex);
      return false;
    }
  }
  
  /**
   * Destroy the peer connection
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connected = false;
    if (this.initialized && this.peer) {
      this.peer.destroy();
    }
    this.emit('destroyed', this.peerIdHex);
  }
}

export default Peer;
