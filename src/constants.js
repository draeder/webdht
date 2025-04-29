// Kademlia constants
export const DEFAULT_K = 20; // Default size of k-buckets
export const DEFAULT_ALPHA = 3; // Default concurrency parameter
export const DEFAULT_BUCKET_COUNT = 160; // SHA1 is 160 bits
export const DEFAULT_MAX_STORE_SIZE = 1000;
export const DEFAULT_REPLICATE_INTERVAL = 3600000; // 1 hour
export const DEFAULT_REPUBLISH_INTERVAL = 86400000; // 24 hours
export const DEFAULT_MAX_KEY_SIZE = 1024; // 1KB
export const DEFAULT_MAX_VALUE_SIZE = 64000; // 64KB

// Message types for Kademlia protocol
export const KADEMLIA_MESSAGE_TYPES = {
  PING: 'PING',
  PONG: 'PONG',
  FIND_NODE: 'FIND_NODE',
  FIND_NODE_RESPONSE: 'FIND_NODE_RESPONSE',
  FIND_VALUE: 'FIND_VALUE',
  FIND_VALUE_RESPONSE: 'FIND_VALUE_RESPONSE',
  STORE: 'STORE',
  SIGNAL: 'SIGNAL'
};