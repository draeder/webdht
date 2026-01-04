/**
 * SimplePeer factory for cross-environment compatibility
 * Handles the different ways of loading simple-peer in Node.js and browser
 */

/**
 * Local environment detection.
 * Keep this module self-contained so browser bundles don't pull in Node-only deps
 * via other utility modules.
 */
const ENV = {
  BROWSER: typeof window !== "undefined" && typeof window.document !== "undefined",
  NODE:
    typeof process !== "undefined" &&
    process.versions != null &&
    process.versions.node != null,
};

// Cache for SimplePeer constructor
let SimplePeer = null;
// Track if CDN loading has been initiated
let cdnLoadingPromise = null;

/**
 * Load SimplePeer from CDN in browser environment
 * This is called immediately when this module is imported
 */
function loadSimplePeerFromCDN() {
  if (!ENV.BROWSER || typeof window === "undefined") return;

  // Don't attempt to load if it's already loading or loaded
  if (SimplePeer !== null || cdnLoadingPromise !== null) return;

  // Check if SimplePeer is already available globally
  if (window.SimplePeer || window.simplePeer) {
    SimplePeer = window.SimplePeer || window.simplePeer;
    console.log("SimplePeer already available globally");
    return;
  }

  // Load from a reliable CDN
  console.log("Loading SimplePeer from CDN...");
  cdnLoadingPromise = new Promise((resolve, reject) => {
    // Create script tag for loading from CDN
    const script = document.createElement("script");

    // Set the source to the CDN URL
    // We use unpkg which is very reliable
    script.src = "https://unpkg.com/simple-peer@9.11.1/simplepeer.min.js";

    // Handle successful load
    script.onload = () => {
      if (window.SimplePeer) {
        console.log("SimplePeer loaded successfully from CDN");
        SimplePeer = window.SimplePeer;
        resolve(SimplePeer);
      } else {
        // If SimplePeer is lowercase on window (some CDNs do this)
        if (window.simplePeer) {
          console.log("simplePeer loaded successfully from CDN (lowercase)");
          SimplePeer = window.simplePeer;
          resolve(SimplePeer);
        } else {
          const error = new Error(
            "SimplePeer loaded from CDN but not available on window"
          );
          console.error(error);
          reject(error);
        }
      }
    };

    // Handle load error
    script.onerror = (err) => {
      const error = new Error("Failed to load SimplePeer from CDN");
      console.error(error);
      reject(error);
    };

    // Add the script to the document
    document.head.appendChild(script);
  });
}

// Immediately start loading SimplePeer from CDN if in browser
loadSimplePeerFromCDN();

/**
 * Get the SimplePeer constructor
 * @returns {Promise<Function>} - Promise resolving to the SimplePeer constructor
 */
export async function getSimplePeer() {
  // Return if we already have SimplePeer loaded
  if (SimplePeer !== null) return SimplePeer;

  if (ENV.NODE) {
    // Node.js environment
    try {
      const simplePeerModule = await import(/* @vite-ignore */ "simple-peer");
      SimplePeer = simplePeerModule.default;

      // Try to load wrtc for Node.js
      try {
        const moduleName = "@koush/wrtc";
        const wrtcModule = await import(/* @vite-ignore */ moduleName);
        const wrtc = wrtcModule.default;

        // Return a wrapped constructor that includes wrtc by default
        return function NodeSimplePeer(options = {}) {
          return new SimplePeer({
            wrtc,
            ...options,
          });
        };
      } catch (wrtcErr) {
        console.warn("Failed to import @koush/wrtc:", wrtcErr.message);
        return SimplePeer;
      }
    } catch (err) {
      console.error("Failed to import simple-peer:", err.message);
      throw err;
    }
  } else {
    // Browser environment
    console.log("Browser environment detected in getSimplePeer");

    // First check if SimplePeer is already available on window
    if (window.SimplePeer || window.simplePeer) {
      console.log("SimplePeer found globally on window");
      SimplePeer = window.SimplePeer || window.simplePeer;
      return SimplePeer;
    }

    // If we already started loading from CDN, wait for it to complete
    if (cdnLoadingPromise) {
      console.log("Waiting for CDN loading to complete...");
      try {
        SimplePeer = await cdnLoadingPromise;
        return SimplePeer;
      } catch (cdnError) {
        console.error("CDN loading failed:", cdnError);
        throw new Error(
          "Failed to load SimplePeer from CDN. Please check your network connection."
        );
      }
    }

    // If we somehow got here without starting CDN loading, start it now
    if (!cdnLoadingPromise) {
      console.log("Starting CDN loading from getSimplePeer...");
      loadSimplePeerFromCDN();

      // And wait for it to complete
      if (cdnLoadingPromise) {
        try {
          SimplePeer = await cdnLoadingPromise;
          return SimplePeer;
        } catch (error) {
          console.error("CDN loading failed after retry:", error);
          throw new Error(
            "Failed to load SimplePeer. Please refresh the page and try again."
          );
        }
      }
    }

    // If we still don't have SimplePeer, that's an error
    throw new Error(
      "Failed to load SimplePeer from CDN. Make sure you are connected to the internet."
    );
  }
}

export default { getSimplePeer };