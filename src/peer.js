/**
 * Peer connection handler
 */
import EventEmitter from "./event-emitter.js";
import { getSimplePeer } from "./peer-factory.js";
import { ENV, bufferToHex } from "./utils.js";
import Logger from "./logger.js";

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

    this.nodeId           = options.nodeId;
    this.peerId           = options.peerId;
    this.peerIdHex        = this.peerId ? bufferToHex(this.peerId) : null;
    this.connected        = false;
    this.destroyed        = false;
    this.initialized      = false;
    this.debug            = options.debug || false;
    this._routedPeers     = new Set();
    this.receivedCandidates = new Set();

    // Initialize logger
    this.logger = new Logger("Peer");

    // Retry / reconnection options
    this.reconnectTimer      = options.reconnectTimer || 0;
    this.iceCompleteTimeout  = options.iceCompleteTimeout || 0;
    this.retries             = options.retries || 0;
    this.currentRetry        = 0;
    this.reconnectTimeout    = null;
    this.iceTimeoutTimer     = null;

    // Build simple-peer options
    const simplePeerOptions = {
      initiator: options.initiator || false,
      trickle:   options.trickle !== false,
      config: {
        iceServers: options.iceServers || [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" }
        ]
      },
      wrtc:         options.wrtc,
      sdpTransform: options.sdpTransform
    };

    this.options = {
      ...simplePeerOptions,
      ...options.simplePeerOptions
    };

    this.signalQueue = [];
    if (options.signal) {
      this.signalQueue.push(options.signal);
    }

    // Kick off async init
    this._initialize();
  }

  /** @private */
  _logDebug(...args) {
    if (this.debug && this.logger?.debug) {
      const prefix = `Peer:${this.peerIdHex?.substring(0, 8) || "unknown"}`;
      this.logger.debug(`[${prefix}]`, ...args);
    }
  }

  /** @private */
  async _initialize() {
    try {
      if (ENV.NODE && !this.options.wrtc) {
        try {
          const moduleName = "@koush/wrtc";
          const wrtcModule = await import(/* @vite-ignore */ moduleName);
          this.options.wrtc = wrtcModule.default;
        } catch (wrtcErr) {
          this._logDebug("Failed to import wrtc in Node:", wrtcErr.message);
        }
      }

      const createPeer = await getSimplePeer();
      this.peer = (
        typeof createPeer === "function" &&
        createPeer.prototype &&
        createPeer.prototype._isSimplePeer
      )
        ? new createPeer(this.options)
        : new createPeer(this.options);

      this._setupListeners();
      this.initialized = true;

      while (this.signalQueue.length > 0 && !this.connected) {
        this.signal(this.signalQueue.shift());
      }
      if (this.connected) {
        this.signalQueue = [];
      }
      this._logDebug(`Peer initialized (${this.peerIdHex?.substring(0, 8)})`);
    } catch (err) {
      this._logDebug("Initialization error:", err.message);
      this.emit("error", err, this.peerIdHex);
    }
  }

  /** @private */
  _setupListeners() {
    this.peer.on("signal", (data) => {
      this.emit("signal", data, this.peerIdHex);
    });

    this.peer.on("connect", () => {
      this.connected = true;
      this.currentRetry = 0;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (this.iceTimeoutTimer) {
        clearTimeout(this.iceTimeoutTimer);
        this.iceTimeoutTimer = null;
      }
      this.signalQueue = [];
      this.emit("connect", this.peerIdHex);
    });

    this.peer.on("data", (data) => {
      this.emit("data", data, this.peerIdHex);
      try {
        const msg = JSON.parse(data.toString());
        this.emit("message", msg, this.peerIdHex);
      } catch {
        // ignore non-JSON
      }
    });

    this.peer.on("close", () => {
      this.connected = false;
      this.emit("close", this.peerIdHex);
      if (this.reconnectTimer > 0 && this.currentRetry < this.retries) {
        this._logDebug(`Closed — retry ${this.currentRetry+1}/${this.retries} in ${this.reconnectTimer}ms`);
        this.currentRetry++;
        this.reconnectTimeout = setTimeout(() => {
          if (!this.destroyed) this._initialize();
        }, this.reconnectTimer);
      } else {
        this.destroy();
      }
    });

    this.peer.on("error", (err) => {
      this._logDebug(`Error:`, err.message);
      this.emit("error", err, this.peerIdHex);
      if (
        err.message?.includes("Ice connection failed") ||
        err.message?.includes("ICE failed") ||
        err.code === "ERR_ICE_CONNECTION_FAILURE"
      ) {
        this._logDebug(`ICE failure — retrying if configured`);
        this.peer.destroy();
      }
    });

    if (this.iceCompleteTimeout > 0) {
      this.iceTimeoutTimer = setTimeout(() => {
        if (this.peer && !this.connected) {
          this._logDebug(`ICE timeout after ${this.iceCompleteTimeout}ms`);
          this.peer.destroy();
        }
      }, this.iceCompleteTimeout);
    }
  }

  /**
   * Process incoming signal
   * @param {Object} data
   */
  signal(data) {
    if (
      !data ||
      typeof data !== "object" ||
      !data.type ||
      !["offer", "answer", "candidate", "renegotiate", "PING", "PONG", "SIGNAL", "ROUTE_TEST"].includes(data.type)
    ) {
      this._logDebug(`Invalid signal`, data);
      throw new Error("Invalid signal data");
    }
    if ((data.type === "candidate" && !data.candidate) || (data.type === "PING" && !data.sender)) {
      this._logDebug(`Missing ICE candidate`, data);
      throw new Error("ICE candidate missing");
    }
    if ((["offer","answer"].includes(data.type) && !data.sdp) || (data.type === "SIGNAL" && !data.target)) {
      this._logDebug(`Missing SDP`, data);
      throw new Error("SDP missing");
    }

// Enhanced logging for ICE candidate handling
    if (data.type === 'candidate' && data.candidate) {
      console.log(`[ICE Debug] Received ICE candidate in peer.js: ${data.candidate.substring(0, 30)}...`);
    }
    if (data.type === 'candidate' && data.candidate) {
      if (this.receivedCandidates.has(data.candidate)) {
        this._logDebug(`Duplicate ICE candidate, skipping`);
        return;
      }
      this.receivedCandidates.add(data.candidate);
    }

    if (this.connected) {
      this._logDebug(`Ignoring signal — already connected`);
      return;
    }
    if (!this.initialized || !this.peer) {
      this._logDebug(`Queueing signal`);
      this.signalQueue.push(data);
      return;
    }

    try {
      this.peer.signal(data);
    } catch (err) {
      this._logDebug(`Signal processing failed`, err.message);
      throw err;
    }
  }

  /**
   * Send data (object/Buffer/string)
   */
  send(data) {
    if (!this.connected || this.destroyed || !this.initialized || !this.peer) {
      return false;
    }
    if (typeof data === "object" && !(data instanceof Uint8Array)) {
      data = JSON.stringify(data);
    }
    try {
      this.peer.send(data);
      return true;
    } catch (err) {
      this.emit("error", err, this.peerIdHex);
      return false;
    }
  }

  /** Destroy this peer */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connected = false;
    this._routedPeers = new Set();
    if (this.initialized && this.peer) {
      this.peer.destroy();
    }
    this.emit("destroyed", this.peerIdHex);
  }

  /** @private */
  _hasRoutedTo(peerId) {
    return this._routedPeers.has(peerId);
  }

  /** @private */
  _addRoutedPeer(peerId) {
    this._routedPeers.add(peerId);
  }
}

export default Peer;