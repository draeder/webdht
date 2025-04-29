class Logger {
  constructor(moduleName) {
    this.moduleName = moduleName;
    this.logLevel = process.env.LOG_LEVEL || 'info';
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