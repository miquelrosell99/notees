/**
 * Frontend logging utility
 * 
 * Provides structured logging with levels, context, and optional remote reporting.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
  error?: Error;
}

interface LoggerConfig {
  minLevel: LogLevel;
  enableConsole: boolean;
  enableRemote: boolean;
  remoteEndpoint?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '#9E9E9E',
  info: '#2196F3',
  warn: '#FF9800',
  error: '#F44336',
};

class Logger {
  private config: LoggerConfig = {
    minLevel: import.meta.env.DEV ? 'debug' : 'info',
    enableConsole: true,
    enableRemote: false,
  };
  
  private module: string;
  private buffer: LogEntry[] = [];
  private maxBufferSize = 100;
  
  constructor(module: string) {
    this.module = module;
  }
  
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.minLevel];
  }
  
  private formatMessage(entry: LogEntry): string[] {
    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.module}]`;
    const style = `color: ${LOG_COLORS[entry.level]}; font-weight: bold`;
    return [`%c${prefix}`, style, entry.message];
  }
  
  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;
    
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      data,
    };
    
    // Add to buffer
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
    
    // Console output
    if (this.config.enableConsole) {
      const [format, style, msg] = this.formatMessage(entry);
      const logFn = console[level] || console.log;
      
      if (data !== undefined) {
        logFn(format, style, msg, data);
      } else {
        logFn(format, style, msg);
      }
    }
    
    // Remote logging (if enabled)
    if (this.config.enableRemote && level === 'error') {
      this.sendRemote(entry);
    }
  }
  
  private async sendRemote(entry: LogEntry): Promise<void> {
    if (!this.config.remoteEndpoint) return;
    
    try {
      await fetch(this.config.remoteEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch {
      // Silently fail - don't log errors about logging
    }
  }
  
  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }
  
  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }
  
  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }
  
  error(message: string, error?: Error | unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'error',
      module: this.module,
      message,
    };
    
    if (error instanceof Error) {
      entry.error = error;
      entry.data = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else if (error !== undefined) {
      entry.data = error;
    }
    
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
    
    if (this.config.enableConsole) {
      const [format, style, msg] = this.formatMessage(entry);
      if (error) {
        console.error(format, style, msg, error);
      } else {
        console.error(format, style, msg);
      }
    }
    
    if (this.config.enableRemote) {
      this.sendRemote(entry);
    }
  }
  
  /**
   * Get recent log entries (useful for debugging)
   */
  getBuffer(): LogEntry[] {
    return [...this.buffer];
  }
  
  /**
   * Clear the log buffer
   */
  clearBuffer(): void {
    this.buffer = [];
  }
  
  /**
   * Create a child logger with a sub-module name
   */
  child(subModule: string): Logger {
    return new Logger(`${this.module}:${subModule}`);
  }
  
  /**
   * Time a function execution
   */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const duration = (performance.now() - start).toFixed(2);
      this.debug(`${label} completed in ${duration}ms`);
      return result;
    } catch (error) {
      const duration = (performance.now() - start).toFixed(2);
      this.error(`${label} failed after ${duration}ms`, error);
      throw error;
    }
  }
  
  /**
   * Create a performance marker
   */
  mark(name: string): () => void {
    const start = performance.now();
    return () => {
      const duration = (performance.now() - start).toFixed(2);
      this.debug(`${name}: ${duration}ms`);
    };
  }
}

// Logger factory with caching
const loggers = new Map<string, Logger>();

export function getLogger(module: string): Logger {
  if (!loggers.has(module)) {
    loggers.set(module, new Logger(module));
  }
  return loggers.get(module)!;
}

// Root logger
export const logger = getLogger('app');

// Expose to window for debugging
if (import.meta.env.DEV) {
  (window as unknown as { __loggers: Map<string, Logger> }).__loggers = loggers;
  (window as unknown as { __logger: Logger }).__logger = logger;
}

export default logger;
