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

    // Store base options (wrtc will be added later if needed)
    this.options = {
      initiator: options.initiator || false,
      trickle: options.trickle !== false,
      config: {
        iceServers: options.iceServers || [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      },
      wrtc: options.wrtc // might be undefined
    };

    this.signalQueue = [];
    if (options.signal) {
      this.signalQueue.push(options.signal);
    }

    // Initialize asynchronously
    this._initialize();
  }

  /**
   * Initialize the peer connection (async)
   * @private
   */
  async _initialize() {
    try {
      if (ENV.NODE && !this.options.wrtc) {
        try {
          const wrtcModule = await import('@koush/wrtc');
          this.options.wrtc = wrtcModule.default;
        } catch (wrtcErr) {
          console.warn('Failed to import wrtc in Node:', wrtcErr.message);
        }
      }

      const createPeer = await getSimplePeer();
      this.peer = typeof createPeer === 'function' && createPeer.prototype && createPeer.prototype._isSimplePeer
        ? new createPeer(this.options)
        : new createPeer(this.options);

      this._setupListeners();
      this.initialized = true;

      while (this.signalQueue.length > 0) {
        const signal = this.signalQueue.shift();
        this.signal(signal);
      }
    } catch (err) {
      console.error('Failed to initialize peer:', err.message);
      this.emit('error', err, this.peerIdHex);
    }
  }

  /**
   * Setup event listeners for the peer
   * @private
   */
  _setupListeners() {
    this.peer.on('signal', data => {
      this.emit('signal', data, this.peerIdHex);
    });

    this.peer.on('connect', () => {
      this.connected = true;
      this.emit('connect', this.peerIdHex);
    });

    this.peer.on('data', data => {
      this.emit('data', data, this.peerIdHex);
      try {
        const message = JSON.parse(data.toString());
        this.emit('message', message, this.peerIdHex);
      } catch {
        // Non-JSON data; ignore
      }
    });

    this.peer.on('close', () => {
      this.connected = false;
      this.emit('close', this.peerIdHex);
      this.destroy();
    });

    this.peer.on('error', err => {
      this.emit('error', err, this.peerIdHex);
    });
  }

  /**
   * Signal the peer
   * @param {Object} data - Signal data
   */
  signal(data) {
    if (this.destroyed) return;

    if (!this.initialized || !this.peer) {
      this.signalQueue.push(data);
      return;
    }

    this.peer.signal(data);
  }

  /**
   * Send data to the peer
   * @param {Object|Buffer|string} data - Data to send
   */
  send(data) {
    if (!this.connected || this.destroyed || !this.initialized || !this.peer) return false;

    if (typeof data === 'object' && !(data instanceof Uint8Array)) {
      data = JSON.stringify(data);
    }

    try {
      this.peer.send(data);
      return true;
    } catch (err) {
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
