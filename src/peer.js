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
    this.peerIdHex = this.peerId ? bufferToHex(this.peerId) : null;
    this.connected = false;
    this.destroyed = false;
    this.initialized = false;
    this.peer = null;
    
    console.log(`Creating peer connection to ${this.peerIdHex?.substr(0, 8) || 'unknown'} (initiator: ${options.initiator})`);
    
    // Initialize the peer connection
    this._initialize(options);
  }
  
  /**
   * Initialize the peer connection
   * @private
   */
  async _initialize(options) {
    try {
      console.log(`Initializing peer connection to ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
      const SimplePeer = await getSimplePeer();
      
      // Create the SimplePeer instance
      this.peer = new SimplePeer({
        initiator: options.initiator,
        trickle: false
      });
      this.initialized = true;
      
      console.log(`Peer instance created for ${this.peerIdHex?.substr(0, 8) || 'unknown'}, initiator: ${options.initiator}`);
      
      // Handle signaling data
      this.peer.on('signal', data => {
        console.log(`Signal data generated for peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
        this.emit('signal', data, this.peerIdHex);
      });
      
      // Handle connection
      this.peer.on('connect', () => {
        console.log(`Connection established with peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
        this.connected = true;
        this.emit('connect', this.peerIdHex);
      });
      
      // Handle data
      this.peer.on('data', data => {
        // Parse JSON data if it's a string
        let message = data;
        if (typeof data === 'string') {
          try {
            message = JSON.parse(data);
          } catch (err) {
            // Not JSON, leave as is
          }
        }
        
        console.log(`Received data from peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
        this.emit('message', message, this.peerIdHex);
      });
      
      // Handle errors
      this.peer.on('error', err => {
        console.error(`Peer connection error with ${this.peerIdHex?.substr(0, 8) || 'unknown'}:`, err.message);
        this.emit('error', err, this.peerIdHex);
      });
      
      // Handle close
      this.peer.on('close', () => {
        console.log(`Connection closed with peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
        this.connected = false;
        this.emit('close', this.peerIdHex);
      });
      
      // If signal data was provided, use it
      if (options.signal) {
        console.log(`Using provided signal data for peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
        this.peer.signal(options.signal);
      }
    } catch (err) {
      console.error(`Failed to initialize peer connection to ${this.peerIdHex?.substr(0, 8) || 'unknown'}:`, err.message);
      this.emit('error', err, this.peerIdHex);
    }
  }
  
  /**
   * Signal the peer with WebRTC signaling data
   * @param {Object} data - Signaling data
   */
  signal(data) {
    if (!this.initialized || !this.peer || this.destroyed) {
      console.warn(`Cannot signal peer ${this.peerIdHex?.substr(0, 8) || 'unknown'} - not initialized or destroyed`);
      return;
    }
    
    console.log(`Signaling peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
    try {
      this.peer.signal(data);
    } catch (err) {
      console.error(`Error signaling peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}:`, err.message);
      this.emit('error', err, this.peerIdHex);
    }
  }
  
  /**
   * Send data to the peer
   * @param {Object|Buffer|string} data - Data to send
   */
  send(data) {
    if (!this.connected || this.destroyed || !this.initialized || !this.peer) {
      console.warn(`Cannot send to peer ${this.peerIdHex?.substr(0, 8) || 'unknown'} - not connected or initialized`);
      return false;
    }
    
    if (typeof data === 'object' && !(data instanceof Uint8Array)) {
      data = JSON.stringify(data);
    }
    
    try {
      console.log(`Sending data to peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
      this.peer.send(data);
      return true;
    } catch (err) {
      console.error(`Error sending to peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}:`, err.message);
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
      console.log(`Destroying connection to peer ${this.peerIdHex?.substr(0, 8) || 'unknown'}`);
      this.peer.destroy();
    }
    this.emit('destroyed', this.peerIdHex);
  }
}

export default Peer;
