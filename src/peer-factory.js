/**
 * SimplePeer factory for cross-environment compatibility
 * Handles the different ways of loading simple-peer in Node.js and browser
 */
import { ENV } from './utils.js';

// Dynamic import for SimplePeer
let SimplePeer = null;

// List of STUN servers for better NAT traversal
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// WebRTC configuration with enhanced reliability settings
const ENHANCED_WEBRTC_CONFIG = {
  iceServers: DEFAULT_ICE_SERVERS,
  iceTransportPolicy: 'all',
  sdpSemantics: 'unified-plan'
};

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
    // First check if SimplePeer is already available in global scope
    if (typeof window !== 'undefined' && window.SimplePeer) {
      SimplePeer = window.SimplePeer;
      return SimplePeer;
    }
    
    // Try to load using dynamic import if available in the browser
    try {
      const simplePeerModule = await import('simple-peer');
      SimplePeer = simplePeerModule.default || simplePeerModule;
      return SimplePeer;
    } catch (err) {
      console.log('Dynamic import of simple-peer failed, trying CDN:', err.message);
      
      // If all else fails, dynamically load from CDN
      return new Promise((resolve, reject) => {
        // If a script loading is already in progress, wait for it
        if (window._simplePeerLoading) {
          const checkInterval = setInterval(() => {
            if (window.SimplePeer) {
              clearInterval(checkInterval);
              SimplePeer = window.SimplePeer;
              resolve(SimplePeer);
            }
          }, 100);
          return;
        }
        
        // Mark that we're loading the script
        window._simplePeerLoading = true;
        
        // Create script element
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/simple-peer@9.11.1/simplepeer.min.js';
        script.async = true;
        
        script.onload = () => {
          console.log('SimplePeer loaded from CDN');
          if (window.SimplePeer) {
            SimplePeer = window.SimplePeer;
            resolve(SimplePeer);
          } else {
            reject(new Error('SimplePeer was loaded but not found in global scope'));
          }
        };
        
        script.onerror = (e) => {
          console.error('Failed to load SimplePeer from CDN:', e);
          reject(new Error('Failed to load SimplePeer from CDN'));
        };
        
        // Add to document head
        document.head.appendChild(script);
      });
    }
  }
}

export default { getSimplePeer };
