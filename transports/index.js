/**
 * Transport Manager for WebDHT
 * 
 * Provides a registry and factory for different transport implementations,
 * including dynamic WebSocket selection for browser vs. Node.js.
 */
import EventEmitter from "../src/event-emitter.js";
import Logger from "../src/logger.js";

import WebSocketTransport from './websocket.js';
import AWSTransport from './aws.js';
import AzureTransport from './azure.js';
import PubNubTransport from './pubnub.js';
import { ENV } from '../src/utils.js';

// Dynamically import 'ws' only in Node.js
let NodeWebSocket = null;
if (ENV.NODE) {
  const wsModule = await import('ws');
  NodeWebSocket = wsModule.default;
}

class TransportManager extends EventEmitter {
  /**
   * @returns {typeof WebSocket} – the WebSocket constructor for this environment
   */
  getWebSocket() {
    return ENV.NODE ? NodeWebSocket : window.WebSocket;
  }

  /**
   * @param {{ debug?: boolean }} [options]
   */
  constructor(options = {}) {
    super();
    this.debug = options.debug || false;
    this.logger = new Logger("TransportManager");

    // Registry of transports
    this.transports = new Map();

    // Register built-ins
    this.register('websocket', WebSocketTransport);
    this.register('aws', AWSTransport);
    this.register('azure', AzureTransport);
    this.register('pubnub', PubNubTransport);

    this._logDebug(
      "Initialized with transports:",
      Array.from(this.transports.keys()).join(', ')
    );
  }

  /** @private */
  _logDebug(...args) {
    if (this.debug && this.logger.debug) {
      this.logger.debug("[TransportManager]", ...args);
    }
  }

  /**
   * Register a transport class.
   * @param {string} name
   * @param {new(...args:any[]) => any} TransportClass
   * @returns {this}
   */
  register(name, TransportClass) {
    if (!name || typeof name !== 'string') {
      throw new Error('Transport name must be a non-empty string');
    }
    if (typeof TransportClass !== 'function') {
      throw new Error('Transport class must be a constructor function');
    }
    this.transports.set(name.toLowerCase(), TransportClass);
    this._logDebug(`Registered transport: ${name}`);
    this.emit('transport:registered', name);
    return this;
  }

  /**
   * Unregister a transport.
   * @param {string} name
   * @returns {boolean}
   */
  unregister(name) {
    const key = name.toLowerCase();
    const removed = this.transports.delete(key);
    if (removed) {
      this._logDebug(`Unregistered transport: ${name}`);
      this.emit('transport:unregistered', name);
    }
    return removed;
  }

  /**
   * Check if a transport is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.transports.has(name.toLowerCase());
  }

  /**
   * List all registered transport names.
   * @returns {string[]}
   */
  getAvailableTransports() {
    return Array.from(this.transports.keys());
  }

  /**
   * Create a new transport instance.
   * For 'websocket', injects the correct WebSocket constructor via options.WebSocket.
   * @param {string} name
   * @param {object} [options={}]
   * @returns {object}
   */
  create(name, options = {}) {
    const key = name.toLowerCase();
    if (!this.transports.has(key)) {
      throw new Error(`Transport '${name}' is not registered`);
    }

    const TransportClass = this.transports.get(key);
    // Determine debug flag
    const debugFlag = options.debug !== undefined ? options.debug : this.debug;
    // Build constructor options
    const ctorOpts = { ...options, debug: debugFlag };
    // For WebSocketTransport, pass in the right constructor
    if (key === 'websocket') {
      ctorOpts.WebSocket = this.getWebSocket();
    }

    const instance = new TransportClass(ctorOpts);
    this._logDebug(`Created transport: ${name}`, instance);
    this.emit('transport:created', name, instance);
    return instance;
  }

  /**
   * Retrieve the transport class itself.
   * @param {string} name
   * @returns {new(...args:any[]) => any}
   */
  getTransportClass(name) {
    const key = name.toLowerCase();
    if (!this.transports.has(key)) {
      throw new Error(`Transport '${name}' is not registered`);
    }
    return this.transports.get(key);
  }
}

const transportManager = new TransportManager();

export {
  WebSocketTransport,
  AWSTransport,
  AzureTransport,
  PubNubTransport,
  TransportManager
};
export default transportManager;
