import { ENV } from './utils.js';

class Logger {
  constructor(moduleName) {
    this.moduleName = moduleName;
    // Use environment detection to safely get log level
    this.logLevel = this.getLogLevel();
  }

  getLogLevel() {
    // Node.js environment
    if (ENV.NODE && typeof process !== 'undefined' && process.env) {
      return process.env.LOG_LEVEL || 'info';
    }
    // Browser environment
    else if (ENV.BROWSER && typeof window !== 'undefined') {
      // Check for global log level variable
      return window.LOG_LEVEL || 'info';
    }
    // Default fallback
    return 'info';
  }

  debug(...args) {
    if (this.shouldLog('debug')) {
      console.debug(this.format('debug', ...args));
    }
  }

  info(...args) {
    if (this.shouldLog('info')) {
      console.info(this.format('info', ...args));
    }
  }

  warn(...args) {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', ...args));
    }
  }

  error(...args) {
    if (this.shouldLog('error')) {
      console.error(this.format('error', ...args));
    }
  }

  format(level, ...args) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] [${this.moduleName}] ${args.join(' ')}`;
  }

  shouldLog(level) {
    const levels = ['error', 'warn', 'info', 'debug'];
    return levels.indexOf(level) <= levels.indexOf(this.logLevel);
  }
}

export default Logger;