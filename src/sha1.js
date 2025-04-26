/**
 * Simple SHA1 implementation that works in both Node.js and browser environments
 * This is a minimal, self-contained module with no external dependencies
 */

// Environment detection
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

// Detect if crypto API is available in browser
const hasCryptoApi =
  typeof crypto !== "undefined" &&
  typeof crypto.subtle !== "undefined" &&
  typeof crypto.subtle.digest === "function";

/**
 * Convert a string to Uint8Array
 * @param {string} str - Input string
 * @return {Uint8Array} - UTF-8 encoded bytes
 */
function strToUint8Array(str) {
  return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to hex string
 * @param {Uint8Array} bytes - Input bytes
 * @return {string} - Hex string
 */
function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a SHA1 hash using Node.js crypto module
 * @param {string} input - Input string
 * @return {Promise<string>} - Hex encoded SHA1 hash
 */
async function nodeSha1(input) {
  // Use native Node.js crypto
  const crypto = await import("crypto");
  const hash = crypto.createHash("sha1");
  hash.update(input);
  return hash.digest("hex");
}

/**
 * Create a SHA1 hash using browser's Web Crypto API
 * @param {string} input - Input string
 * @return {Promise<string>} - Hex encoded SHA1 hash
 */
async function browserCryptoSha1(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a SHA1 hash
 * @param {string} input - Input string
 * @return {Promise<string>} - Hex encoded SHA1 hash
 */
export async function sha1(input) {
  // Use the appropriate implementation
  if (isNode) {
    return await nodeSha1(input);
  } else if (hasCryptoApi) {
    return await browserCryptoSha1(input);
  } else {
    throw new Error("No SHA1 implementation available");
  }
}

/**
 * Generate a random ID using SHA1
 * @return {Promise<string>} - Hex encoded SHA1 hash
 */
export async function generateRandomId() {
  // Create a random string
  const randomStr =
    Math.random().toString(36) +
    Date.now().toString(36) +
    Math.random().toString(36);
  // Hash it with SHA1
  return await sha1(randomStr);
}

export default {
  sha1,
  generateRandomId,
};
