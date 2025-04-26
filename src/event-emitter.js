/**
 * Custom EventEmitter implementation for cross-environment compatibility
 * Works in both browser and Node.js environments
 */

/**
 * EventEmitter class
 * Provides methods to register event listeners and emit events
 */
export default class EventEmitter {
  /**
   * Create a new EventEmitter
   */
  constructor() {
    this._events = new Map();
    this._onceEvents = new Map();
  }

  /**
   * Add an event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   * @returns {EventEmitter} - Returns this for chaining
   */
  on(event, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Listener must be a function");
    }

    // Create array for event if it doesn't exist
    if (!this._events.has(event)) {
      this._events.set(event, []);
    }

    // Add listener to event array
    this._events.get(event).push(listener);

    return this;
  }

  /**
   * Add a one-time event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   * @returns {EventEmitter} - Returns this for chaining
   */
  once(event, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Listener must be a function");
    }

    // Create wrapper that removes itself after execution
    const wrapper = (...args) => {
      this.removeListener(event, wrapper);
      listener.apply(this, args);
    };

    // Store reference to original listener
    wrapper.originalListener = listener;

    // Register the wrapper as a listener
    return this.on(event, wrapper);
  }

  /**
   * Remove an event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function to remove
   * @returns {EventEmitter} - Returns this for chaining
   */
  removeListener(event, listener) {
    if (!this._events.has(event)) {
      return this;
    }

    const eventListeners = this._events.get(event);

    // Filter out the matching listener
    const filteredListeners = eventListeners.filter((registered) => {
      return (
        registered !== listener &&
        (!registered.originalListener ||
          registered.originalListener !== listener)
      );
    });

    if (filteredListeners.length === 0) {
      this._events.delete(event);
    } else {
      this._events.set(event, filteredListeners);
    }

    return this;
  }

  /**
   * Remove all listeners for an event or all events
   * @param {string} [event] - Event name, omit to remove all events
   * @returns {EventEmitter} - Returns this for chaining
   */
  removeAllListeners(event) {
    if (event) {
      this._events.delete(event);
    } else {
      this._events.clear();
    }

    return this;
  }

  /**
   * Get all listeners for an event
   * @param {string} event - Event name
   * @returns {Function[]} - Array of listeners
   */
  listeners(event) {
    return this._events.has(event) ? [...this._events.get(event)] : [];
  }

  /**
   * Emit an event with provided arguments
   * @param {string} event - Event name
   * @param {...any} args - Arguments to pass to listeners
   * @returns {boolean} - True if the event had listeners, false otherwise
   */
  emit(event, ...args) {
    if (!this._events.has(event)) {
      return false;
    }

    const listeners = this._events.get(event);

    // Make a copy to avoid issues if listeners are added/removed during emission
    const listenersCopy = [...listeners];

    for (const listener of listenersCopy) {
      try {
        listener.apply(this, args);
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error);
      }
    }

    return true;
  }

  /**
   * Get the number of listeners for an event
   * @param {string} event - Event name
   * @returns {number} - Number of listeners
   */
  listenerCount(event) {
    return this._events.has(event) ? this._events.get(event).length : 0;
  }

  /**
   * Add a listener, alias for .on()
   */
  addListener(event, listener) {
    return this.on(event, listener);
  }

  /**
   * Get all event names
   * @returns {string[]} - Array of event names
   */
  eventNames() {
    return Array.from(this._events.keys());
  }
}
