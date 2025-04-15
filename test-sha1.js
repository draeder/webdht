/**
 * Simple test for our custom SHA1 implementation
 */
import { sha1 } from './src/sha1.js';

// Test cases with known SHA1 hashes
const testCases = [
  { input: 'abc', expected: '0xa9993e364706816aba3e25717850c26c9cd0d89d' },
  { input: '', expected: '0xda39a3ee5e6b4b0d3255bfef95601890afd80709' },
  { input: 'The quick brown fox jumps over the lazy dog', expected: '0x2fd4e1c67a2d28fced849ee1bb76e7391b93eb12' },
  { input: 'The quick brown fox jumps over the lazy cog', expected: '0xde9f2c7fd25e1b3afad3e85a0bd17d9b100db4b3' }
];

// Run test cases
console.log('Testing custom SHA1 implementation:');
console.log('-----------------------------------');

for (const test of testCases) {
  // Calculate the hash
  const hash = sha1(test.input);
  
  // Convert to hex string for comparison
  const hashHex = '0x' + Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Check if the hash matches the expected value
  const passed = hashHex === test.expected;
  
  // Output the result
  console.log(`Input: "${test.input}"`);
  console.log(`Expected: ${test.expected}`);
  console.log(`Actual:   ${hashHex}`);
  console.log(`Result: ${passed ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('-----------------------------------');
}
