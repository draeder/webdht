/**
 * SimplePeer factory for cross-environment compatibility
 * Handles the different ways of loading simple-peer in Node.js and browser
 */
import { ENV } from './utils.js';

// Dynamic import for SimplePeer
let SimplePeer = null;

/**
 * Get the SimplePeer constructor
 * @returns {Promise<Function>} - Promise resolving to the SimplePeer constructor
 */
export async function getSimplePeer() {
  if (SimplePeer !== null) return SimplePeer;
  
  if (ENV.NODE) {
    // Node.js environment
    try {
      const simplePeerModule = await import('simple-peer');
      SimplePeer = simplePeerModule.default;
      
      // Try to load wrtc for Node.js
      try {
        const wrtcModule = await import('@koush/wrtc');
        const wrtc = wrtcModule.default;
        
        // Return a wrapped constructor that includes wrtc by default
        return function NodeSimplePeer(options = {}) {
          return new SimplePeer({
            wrtc,
            ...options
          });
        };
      } catch (wrtcErr) {
        console.warn('Failed to import @koush/wrtc:', wrtcErr.message);
        return SimplePeer;
      }
    } catch (err) {
      console.error('Failed to import simple-peer:', err.message);
      throw err;
    }
  } else {
    // Browser environment
    // In the browser, we expect simple-peer to be available globally
    // or via the import map in the HTML
    try {
      // Try to load from window if available (for script tag inclusion)
      if (typeof window !== 'undefined' && window.SimplePeer) {
        SimplePeer = window.SimplePeer;
        return SimplePeer;
      }
      
      // Try to load using dynamic import
      const simplePeerModule = await import('simple-peer');
      SimplePeer = simplePeerModule.default || simplePeerModule;
      return SimplePeer;
    } catch (err) {
      console.error('Failed to load SimplePeer in browser:', err.message);
      
      // Check if SimplePeer is available on the window object (from CDN script tag)
      if (typeof window !== 'undefined' && window.SimplePeer) {
        SimplePeer = window.SimplePeer;
        return SimplePeer;
      }
      
      throw new Error('Could not load SimplePeer. Make sure it is properly included.');
    }
  }
}

export default { getSimplePeer };
