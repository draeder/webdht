import EventEmitter from '../event-emitter.js';
import { bufferToHex, hexToBuffer } from '../utils.js';
import { sha1 } from '../sha1.js';

export class StorageEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.storage = new Map();
    this.storageTimestamps = new Map();
    this.maxStoreSize = options.maxStoreSize || 1000;
    this.replicateInterval = options.replicateInterval || 60000;
    this.republishInterval = options.republishInterval || 3600000;
    this.debug = options.debug || false;
    
    // Track maintenance intervals
    this.maintenanceIntervals = [];
  }

  /**
   * Start the maintenance routines for data replication and republishing
   */
  startMaintenance() {
    // Clear any existing intervals
    this.stopMaintenance();
    
    // Set up new intervals
    this.maintenanceIntervals.push(
      setInterval(() => this._replicateData(), this.replicateInterval)
    );
    
    this.maintenanceIntervals.push(
      setInterval(() => this._republishData(), this.republishInterval)
    );
  }
  
  /**
   * Stop all maintenance routines
   */
  stopMaintenance() {
    this.maintenanceIntervals.forEach(interval => clearInterval(interval));
    this.maintenanceIntervals = [];
  }

  /**
   * Store a value in the DHT
   * @param {string|Buffer} key - Key to store under
   * @param {any} value - Value to store
   * @param {Object} options - Storage options
   * @returns {string} - The key hash
   */
  async put(key, value, options = {}) {
    // Ensure key is a hex string
    const keyHash = typeof key === 'string' && /^[a-fA-F0-9]{40}$/.test(key) 
      ? key 
      : bufferToHex(await this._hashKey(key));
    
    // Ensure we don't exceed storage capacity
    if (this.storage.size >= this.maxStoreSize) {
      this._evictOldestEntry();
    }
    
    // Store with metadata
    this.storage.set(keyHash, {
      value,
      timestamp: Date.now(),
      replicatedTo: new Set(options.replicatedTo || []),
      publisher: options.publisher || null
    });
    
    this.storageTimestamps.set(keyHash, Date.now());
    
    // If not a replication, emit event for replication
    if (!options.isRepublish) {
      this.emit('value:stored', { key: keyHash, value });
    }
    
    return keyHash;
  }

  /**
   * Retrieve a value from the DHT
   * @param {string|Buffer} key - Key to look up
   * @returns {any} Retrieved value or null if not found
   */
  async get(key) {
    // Ensure key is a hex string
    const keyHash = typeof key === 'string' && /^[a-fA-F0-9]{40}$/.test(key)
      ? key
      : bufferToHex(await this._hashKey(key));
    
    // Check local storage first
    if (this.storage.has(keyHash)) {
      const storedData = this.storage.get(keyHash);
      if (storedData.value !== undefined) {
        return storedData.value;
      } else {
        // Remove invalid entry
        this.storage.delete(keyHash);
        this.storageTimestamps.delete(keyHash);
      }
    }
    
    // If not found locally, request to query peers
    this.emit('value:requested', { key: keyHash });
    
    // The peer query and response is handled by the DHT class
    // which will call put() with the result if found
    
    // Return null for now - the actual network query is handled elsewhere
    return null;
  }
  
  /**
   * Store a value received from a peer
   * @param {Object} data - Storage data
   * @param {string} data.key - Key hash
   * @param {any} data.value - Value to store
   * @param {string} data.publisher - ID of publishing peer
   */
  storeRemoteValue(data) {
    if (this.storage.size >= this.maxStoreSize) {
      this._evictOldestEntry();
    }
    
    this.storage.set(data.key, {
      value: data.value,
      timestamp: data.timestamp || Date.now(),
      replicatedTo: new Set(),
      publisher: data.publisher || 'remote'
    });
    
    this.storageTimestamps.set(data.key, Date.now());
  }
  
  /**
   * Get a list of all keys in storage
   * @returns {Array<string>} Array of key hashes
   */
  getKeys() {
    return Array.from(this.storage.keys());
  }
  
  /**
   * Get storage info for a specific key
   * @param {string} keyHash - Key hash
   * @returns {Object|null} Storage metadata or null if not found
   */
  getStorageInfo(keyHash) {
    if (!this.storage.has(keyHash)) return null;
    
    const data = this.storage.get(keyHash);
    return {
      timestamp: data.timestamp,
      replicatedTo: Array.from(data.replicatedTo),
      publisher: data.publisher
    };
  }
  
  /**
   * Mark a key as replicated to a specific peer
   * @param {string} keyHash - Key hash
   * @param {string} peerId - Peer ID
   */
  markReplicated(keyHash, peerId) {
    const data = this.storage.get(keyHash);
    if (data && data.replicatedTo) {
      data.replicatedTo.add(peerId);
    }
  }

  /**
   * Hash a key using SHA-1
   * @private
   */
  async _hashKey(key) {
    return typeof key === 'string' ? await sha1(key) : key;
  }
  
  /**
   * Evict the oldest entry from storage
   * @private
   */
  _evictOldestEntry() {
    if (this.storage.size === 0) return;
    
    let oldestKey = null;
    let oldestTime = Infinity;
    
    for (const [key, time] of this.storageTimestamps.entries()) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.storage.delete(oldestKey);
      this.storageTimestamps.delete(oldestKey);
    }
  }
  
  /**
   * Replicate data to other nodes
   * @private
   */
  _replicateData() {
    // Emit replication events for each key
    // The DHT class will handle the actual replication
    for (const [keyHash, data] of this.storage.entries()) {
      this.emit('value:replicate', {
        key: keyHash,
        value: data.value,
        timestamp: data.timestamp,
        replicatedTo: Array.from(data.replicatedTo)
      });
    }
  }
  
  /**
   * Republish all data
   * @private
   */
  _republishData() {
    // Emit republish events for each key
    // The DHT class will handle the actual republishing
    for (const [keyHash, data] of this.storage.entries()) {
      this.emit('value:republish', {
        key: keyHash,
        value: data.value,
        timestamp: data.timestamp
      });
    }
  }
}