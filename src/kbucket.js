import { 
  bufferToHex,
  hexToBuffer,
  getBit,
  distance,
  compareBuffers
} from "./utils.js";
import {
  DEFAULT_K,
  DEFAULT_BUCKET_COUNT
} from "./constants.js";

/**
 * K-bucket implementation
 */
export default class KBucket {
  constructor(
    localNodeId,
    prefix = "",
    prefixLength = 0,
    debug = false,
    k = DEFAULT_K
  ) {
    this.localNodeId = localNodeId;
    this.prefix = prefix;
    this.prefixLength = prefixLength;
    this.nodes = [];
    this.debug = debug;
    this.K = k;
    this.BUCKET_COUNT = DEFAULT_BUCKET_COUNT;
    this.left = null;
    this.right = null;
  }

  _logDebug(...args) {
    if (this.debug) {
      console.debug("[KBucket]", ...args);
    }
  }

  add(node) {
    const nodeIdHex = typeof node.id === "string" ? node.id : bufferToHex(node.id);
    const localNodeIdHex = typeof this.localNodeId === "string" ?
      this.localNodeId : bufferToHex(this.localNodeId);

    if (nodeIdHex === localNodeIdHex) {
      this._logDebug("Attempted to add self, skipping:", nodeIdHex);
      return false;
    }

    if (this.left && this.right) {
      const bit = getBit(hexToBuffer(nodeIdHex), this.prefixLength);
      return bit ? this.right.add(node) : this.left.add(node);
    }

    const nodeIndex = this.nodes.findIndex(n => {
      const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
      return nIdHex === nodeIdHex;
    });

    if (nodeIndex >= 0) {
      const existingNode = this.nodes[nodeIndex];
      this.nodes.splice(nodeIndex, 1);
      this.nodes.push(existingNode);
      return false;
    }

    if (this.nodes.length < this.K) {
      this.nodes.push({ ...node, id: nodeIdHex });
      return true;
    }

    if (this.prefixLength < this.BUCKET_COUNT - 1) {
      this._split();
      return this.add(node);
    }

    return false;
  }

  _split() {
    if (this.left || this.right) return;

    this.left = new KBucket(
      this.localNodeId,
      this.prefix + "0",
      this.prefixLength + 1,
      this.debug,
      this.K
    );

    this.right = new KBucket(
      this.localNodeId,
      this.prefix + "1",
      this.prefixLength + 1,
      this.debug,
      this.K
    );

    for (const node of this.nodes) {
      const bit = getBit(hexToBuffer(node.id), this.prefixLength);
      bit ? this.right.add(node) : this.left.add(node);
    }

    this.nodes = [];
  }

  getClosestNodes(targetId, count = null) {
    const k = count || this.K;
    const targetIdHex = typeof targetId === "string" ? targetId : bufferToHex(targetId);
    
    if (this.left && this.right) {
      const bit = getBit(hexToBuffer(targetIdHex), this.prefixLength);
      const first = bit ? this.right : this.left;
      const second = bit ? this.left : this.right;

      let nodes = first.getClosestNodes(targetIdHex, k);
      if (nodes.length < k) {
        nodes = nodes.concat(second.getClosestNodes(targetIdHex, k - nodes.length));
      }
      return nodes;
    }

    const seen = new Set();
    return this.nodes
      .filter(n => {
        const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
        return !seen.has(nIdHex) && seen.add(nIdHex);
      })
      .sort((a, b) => compareBuffers(
        distance(a.id, targetIdHex),
        distance(b.id, targetIdHex)
      ))
      .slice(0, k);
  }

  remove(nodeId) {
    const nodeIdHex = typeof nodeId === "string" ? nodeId : bufferToHex(nodeId);

    if (this.left && this.right) {
      const bit = getBit(hexToBuffer(nodeIdHex), this.prefixLength);
      return bit ? this.right.remove(nodeId) : this.left.remove(nodeId);
    }

    const nodeIndex = this.nodes.findIndex(n => {
      const nIdHex = typeof n.id === "string" ? n.id : bufferToHex(n.id);
      return nIdHex === nodeIdHex;
    });

    if (nodeIndex >= 0) {
      this.nodes.splice(nodeIndex, 1);
      return true;
    }
    return false;
  }
}