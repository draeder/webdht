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
      // First import SimplePeer
      let simplePeerModule;
      try {
        simplePeerModule = await import('simple-peer');
        SimplePeer = simplePeerModule.default || simplePeerModule;
      } catch (spErr) {
        console.error('Failed to import simple-peer:', spErr.message);
        throw new Error('Could not load SimplePeer module in Node.js');
      }
      
      // Try to load wrtc for Node.js
      try {
        // Dynamic import wrtc
        const wrtc = await import('@koush/wrtc');
        const wrtcImpl = wrtc.default || wrtc;
        
        console.log('Successfully loaded @koush/wrtc module for Node.js WebRTC support');
        
        // Return a wrapped constructor that includes wrtc by default
        SimplePeer = function(options) {
          return new (simplePeerModule.default || simplePeerModule)({
            wrtc: wrtcImpl,
            ...options
          });
        };
        
        return SimplePeer;
      } catch (wrtcErr) {
        console.warn('wrtc not available, SimplePeer will use default WebRTC implementation:', wrtcErr.message);
        // Fallback to CommonJS require for wrtc
        try {
          // Try using require as a fallback
          const wrtcRequire = require('@koush/wrtc');
          console.log('Successfully loaded wrtc using require()'); 
          
          SimplePeer = function(options) {
            return new (simplePeerModule.default || simplePeerModule)({
              wrtc: wrtcRequire,
              ...options
            });
          };
          
          return SimplePeer;
        } catch (reqErr) {
          console.warn('Failed to load wrtc with require():', reqErr.message);
          return SimplePeer;
        }
      }
    } catch (err) {
      console.error('Failed to set up SimplePeer with WebRTC in Node.js:', err.message);
      throw new Error('Could not set up WebRTC environment');
    }
  } else {
    // Browser environment - first check if SimplePeer is on window (from CDN)
    if (typeof window !== 'undefined' && window.SimplePeer) {
      SimplePeer = window.SimplePeer;
      return SimplePeer;
    }
    
    // If not on window, try to load from CDN
    if (typeof window !== 'undefined') {
      try {
        console.log('Loading SimplePeer from CDN...');
        // Create a script tag to load SimplePeer from CDN
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/simple-peer@latest/simplepeer.min.js';
        script.async = true;
        
        // Wait for script to load
        const loaded = new Promise((resolve, reject) => {
          script.onload = () => {
            if (window.SimplePeer) {
              resolve(window.SimplePeer);
            } else {
              reject(new Error('SimplePeer not found after CDN load'));
            }
          };
          script.onerror = (err) => reject(new Error(`Failed to load SimplePeer CDN: ${err.message}`));
        });
        
        document.head.appendChild(script);
        SimplePeer = await loaded;
        return SimplePeer;
      } catch (cdnErr) {
        console.error('Failed to load SimplePeer from CDN:', cdnErr.message);
      }
    }
    
    // Fallback to trying dynamic import (though this would require bundling)
    try {
      console.warn('Falling back to dynamic import of SimplePeer in browser');
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
