/**
 * Utility functions for WebDHT
 */
import { sha1 as sha1Hash, generateRandomId } from "./sha1.js";

/**
 * Environment detection
 */
const ENV = {
  BROWSER: typeof window !== 'undefined' && typeof window.document !== 'undefined',
  NODE: typeof process !== 'undefined' && process.versions && !!process.versions.node
};

/**
 * Cross-platform Buffer implementation
 * Uses Node.js Buffer in Node environment, or polyfills in browser
 */
const BufferPolyfill = {
  from: function(data) {
    if (ENV.NODE) {
      // Use native Buffer in Node.js
      return Buffer.from(data);
    } else {
      // Use TextEncoder in browser for strings
      if (typeof data === 'string') {
        return new TextEncoder().encode(data);
      }
      // For other types, use Uint8Array
      return new Uint8Array(data);
    }
  },
  isBuffer: function(obj) {
    if (ENV.NODE) {
      return Buffer.isBuffer(obj);
    } else {
      return obj instanceof Uint8Array;
    }
  },
  // Add other Buffer methods as needed
};

/**
 * Create a SHA1 hash of the input
 * @param {string} input - The input to hash
 * @return {Promise<string>} The SHA1 hash as hex string
 */
async function sha1(input) {
  return await sha1Hash(input);
}

/**
 * Convert any input to a string
 * @param {any} input
 * @return {string}
 */
function toBuffer(input) {
  if (typeof input === "string") return input;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(input))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return String(input);
}

/**
 * Convert any input to a buffer-like object
 * @param {any} input
 * @return {Uint8Array} - Buffer-like object
 */
function toBufferObject(input) {
  return BufferPolyfill.from(input);
}

/**
 * Calculate XOR distance between two node IDs (hex strings)
 * @param {string} id1 - First node ID (hex string)
 * @param {string} id2 - Second node ID (hex string)
 * @return {string} XOR distance as hex string
 */
function distance(id1, id2) {
  // Convert hex strings to numbers and calculate XOR
  const len = Math.min(id1.length, id2.length);
  let result = "";

  for (let i = 0; i < len; i += 2) {
    const byte1 = parseInt(id1.slice(i, i + 2), 16);
    const byte2 = parseInt(id2.slice(i, i + 2), 16);
    result += (byte1 ^ byte2).toString(16).padStart(2, "0");
  }

  return result;
}

/**
 * Compare two hex strings - returns negative if a < b, positive if a > b, 0 if equal
 * @param {string} a - First hex string
 * @param {string} b - Second hex string
 * @return {number} Comparison result
 */
function compareBuffers(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Determine if a bit at a specific position is set
 * @param {string} id - Node ID (hex string)
 * @param {number} bit - Bit position (0-indexed)
 * @return {boolean} True if the bit is set
 */
function getBit(id, bit) {
  const byteIndex = Math.floor(bit / 8);
  const bitIndex = bit % 8;
  // Get the byte as a number from the hex string
  const byteValue = parseInt(id.slice(byteIndex * 2, byteIndex * 2 + 2), 16);
  return !!(byteValue & (1 << (7 - bitIndex)));
}

/**
 * Get the longest common prefix length between two node IDs
 * @param {string} id1 - First node ID (hex string)
 * @param {string} id2 - Second node ID (hex string)
 * @return {number} Length of longest common prefix in bits
 */
function commonPrefixLength(id1, id2) {
  const distHex = distance(id1, id2);
  let count = 0;

  for (let i = 0; i < distHex.length; i += 2) {
    const byte = parseInt(distHex.slice(i, i + 2), 16);
    if (byte === 0) {
      count += 8;
      continue;
    }

    let b = byte;
    while ((b & 0x80) === 0 && count < 8) {
      count++;
      b <<= 1;
    }
    break;
  }

  return count;
}

/**
 * Generate a random node ID
 * @return {Promise<string>} Random node ID as hex string
 */
async function generateRandomID() {
  return await generateRandomId();
}

/**
 * Convert buffer to hex string
 * @param {string} buf - Already hex string
 * @return {string} - Same hex string
 */
function bufferToHex(buf) {
  // If already a string, assume it's a hex string
  if (typeof buf === "string") return buf;

  // If it's an array-like object, convert to hex
  if (buf && typeof buf.length === "number") {
    return Array.from(buf)
      .map((b) => (typeof b === "number" ? b : 0).toString(16).padStart(2, "0"))
      .join("");
  }

  return "";
}

/**
 * Hex string to buffer (just returns the hex string since we're using strings as IDs)
 * @param {string} hex - Hex string
 * @return {string} - Same hex string
 */
function hexToBuffer(hex) {
  return hex;
}

export {
  ENV,
  sha1,
  toBuffer,
  toBufferObject,
  distance,
  compareBuffers,
  getBit,
  commonPrefixLength,
  generateRandomID,
  bufferToHex,
  hexToBuffer,
  BufferPolyfill as Buffer,
};