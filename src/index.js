/**
 * WebDHT - Kademlia-like DHT for browsers and Node.js
 *
 * A distributed hash table implementation that works in browsers using WebRTC (simple-peer)
 * for peer discovery and message routing. Can also work in Node.js with environment detection.
 */

// Import components
import DHT from "./dht.js";
import Peer from "./peer.js";
import * as utils from "./utils.js";
import { sha1 as simpleSha1, generateRandomId } from "./sha1.js";

// Export the DHT class as the default export
export default DHT;

// Also export utils and peer for advanced usage
export { Peer, utils };

// Export SHA1 functions directly for convenience
export { simpleSha1 as sha1, generateRandomId };
export const { bufferToHex, hexToBuffer, Buffer } = utils;