/**
 * Routing Table module for Kademlia DHT implementation
 * Manages k-buckets for node lookups and routing
 */
import { 
  bufferToHex, 
  hexToBuffer, 
  distance, 
  compareBuffers, 
  commonPrefixLength
} from '../utils.js';
import KBucket from '../kbucket.js';
import EventEmitter from '../event-emitter.js';

export class RoutingTable extends EventEmitter {
  /**
   * Create a new routing table
   * @param {Buffer|string} nodeId - Local node ID 
   * @param {Object} options - Options
   */
  constructor(nodeId, options = {}) {
    super();
    
    this.nodeId = nodeId;
    this.nodeIdHex = typeof nodeId === 'string' ? nodeId : bufferToHex(nodeId);
    this.k = options.k || 20; // Max nodes per bucket
    this.alpha = options.alpha || 3; // Concurrency parameter
    this.bucketCount = options.bucketCount || 160; // Number of buckets (160 bits for SHA-1)
    this.debug = options.debug || false;
    
    // Initialize buckets
    this.buckets = [new KBucket(this.nodeId, '', 0, this.debug, this.k)];
  }

  /**
   * Set the node ID (needed for lazy initialization)
   * @param {Buffer|string} nodeId - Local node ID
   */
  setNodeId(nodeId) {
    this.nodeId = nodeId;
    this.nodeIdHex = typeof nodeId === 'string' ? nodeId : bufferToHex(nodeId);
    
    // Reinitialize buckets with new node ID
    this.buckets = [new KBucket(this.nodeId, '', 0, this.debug, this.k)];
  }

  /**
   * Add a node to the routing table
   * @param {Object} node - Node to add
   * @param {string|Buffer} node.id - Node ID
   * @returns {boolean} True if node was added
   */
  addNode(node) {
    if (!node || !node.id) return false;
    
    const nodeId = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
    
    // Don't add self
    if (nodeId === this.nodeIdHex) return false;
    
    // Find appropriate bucket by calculating XOR distance
    const bucketIndex = this._getBucketIndex(nodeId);
    
    // Ensure bucket exists
    while (bucketIndex >= this.buckets.length) {
      this._splitBucket(this.buckets.length - 1);
    }
    
    return this.buckets[bucketIndex].add(node);
  }

  /**
   * Remove a node from the routing table
   * @param {string|Buffer} nodeId - Node ID to remove
   * @returns {boolean} True if node was removed
   */
  removeNode(nodeId) {
    const nodeIdHex = typeof nodeId === 'string' ? nodeId : bufferToHex(nodeId);
    let removed = false;
    
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.buckets[i].remove(nodeIdHex)) {
        removed = true;
      }
    }
    
    return removed;
  }

  /**
   * Find the closest nodes to a target ID
   * @param {string|Buffer} targetId - Target ID to find nodes for
   * @param {number} count - Maximum number of nodes to return
   * @returns {Array} Array of closest nodes
   */
  closest(targetId, count = this.k) {
    const targetIdHex = typeof targetId === 'string' ? targetId : bufferToHex(targetId);
    
    // Use KBucket's getClosestNodes for each bucket and combine results
    let closestNodes = [];
    
    for (let i = 0; i < this.buckets.length; i++) {
      const bucketNodes = this.buckets[i].getClosestNodes(targetIdHex, count);
      closestNodes = closestNodes.concat(bucketNodes);
    }
    
    // Sort by distance and return top count
    closestNodes.sort((a, b) => {
      const distA = distance(a.id, targetIdHex);
      const distB = distance(b.id, targetIdHex);
      return compareBuffers(distA, distB);
    });
    
    return closestNodes.slice(0, count);
  }

  /**
   * Get the appropriate bucket index for a node ID
   * @param {string|Buffer} nodeId - Node ID
   * @returns {number} Bucket index
   * @private
   */
  _getBucketIndex(nodeId) {
    const nodeIdHex = typeof nodeId === 'string' ? nodeId : bufferToHex(nodeId);
    const prefixLength = commonPrefixLength(this.nodeIdHex, nodeIdHex);
    return Math.min(prefixLength, this.buckets.length - 1);
  }

  /**
   * Get all nodes in the routing table
   * @returns {Array} Array of all nodes
   */
  getAllNodes() {
    let allNodes = [];
    
    // Recursive function to collect nodes from KBucket and its children
    const collectNodes = (bucket) => {
      allNodes = allNodes.concat(bucket.nodes);
      
      if (bucket.left) collectNodes(bucket.left);
      if (bucket.right) collectNodes(bucket.right);
    };
    
    // Collect from all top-level buckets
    for (let i = 0; i < this.buckets.length; i++) {
      collectNodes(this.buckets[i]);
    }
    
    return allNodes;
  }

  /**
   * Split a bucket at the specified index
   * @param {number} index - Index of the bucket to split
   * @private
   */
  _splitBucket(index) {
    if (index >= this.buckets.length) return;
    
    const bucket = this.buckets[index];
    if (bucket.left || bucket.right) {
      // This bucket is already split internally
      return;
    }
    
    // Force split the bucket
    bucket._split();
    
    // Replace this bucket with its left and right children
    this.buckets.splice(index, 1, bucket.left, bucket.right);
    
    // Clear references to prevent memory leaks
    bucket.left = null;
    bucket.right = null;
  }
  
  /**
   * Get bucket statistics
   * @returns {Array} Array of bucket statistics
   */
  getBucketStats() {
    const stats = [];
    
    // Helper function to get stats recursively
    const getStats = (bucket, index, depth = 0) => {
      // Count nodes in this bucket and all children
      let nodeCount = bucket.nodes.length;
      
      if (bucket.left) {
        nodeCount += bucket.left.nodes.length;
        getStats(bucket.left, index * 2, depth + 1);
      }
      
      if (bucket.right) {
        nodeCount += bucket.right.nodes.length;
        getStats(bucket.right, index * 2 + 1, depth + 1);
      }
      
      stats.push({
        index,
        depth,
        size: nodeCount,
        capacity: this.k,
        prefix: bucket.prefix
      });
    };
    
    // Get stats for all top-level buckets
    for (let i = 0; i < this.buckets.length; i++) {
      getStats(this.buckets[i], i);
    }
    
    return stats;
  }

  /**
   * Check if a node exists in the routing table
   * @param {string|Buffer} nodeId - Node ID to check
   * @returns {boolean} True if node exists
   */
  hasNode(nodeId) {
    return this.getNode(nodeId) !== null;
  }

  /**
   * Get a node from the routing table
   * @param {string|Buffer} nodeId - Node ID to get
   * @returns {Object|null} Node object or null if not found
   */
  getNode(nodeId) {
    const nodeIdHex = typeof nodeId === 'string' ? nodeId : bufferToHex(nodeId);
    
    // Helper function to search recursively through bucket and its children
    const findNode = (bucket) => {
      // Search in current bucket's nodes
      const node = bucket.nodes.find(node => {
        const nIdHex = typeof node.id === 'string' ? node.id : bufferToHex(node.id);
        return nIdHex === nodeIdHex;
      });
      
      if (node) return node;
      
      // If not found and bucket has children, search in them
      if (bucket.left) {
        const leftResult = findNode(bucket.left);
        if (leftResult) return leftResult;
      }
      
      if (bucket.right) {
        const rightResult = findNode(bucket.right);
        if (rightResult) return rightResult;
      }
      
      return null;
    };
    
    // Search in all buckets
    for (let i = 0; i < this.buckets.length; i++) {
      const result = findNode(this.buckets[i]);
      if (result) return result;
    }
    
    return null;
  }
}