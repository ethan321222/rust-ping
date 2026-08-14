'use strict';

/**
 * rust-ping — High-performance ICMP ping module for Node.js
 *
 * Built on Rust via napi-rs with single-socket multiplexing.
 * Supports Callback, Promise, and Batch invocation styles.
 */

const { NativePingSession } = require('./binding');
const { EventEmitter } = require('events');

// ─── Error Types ─────────────────────────────────────────────

class PingTimeoutError extends Error {
  constructor(target) {
    super(`Ping timed out for ${target}`);
    this.name = 'PingTimeoutError';
    this.target = target;
  }
}

class DestinationUnreachableError extends Error {
  constructor(target, icmpType, icmpCode) {
    super(`Destination unreachable: ${target} (type=${icmpType}, code=${icmpCode})`);
    this.name = 'DestinationUnreachableError';
    this.target = target;
    this.icmpType = icmpType;
    this.icmpCode = icmpCode;
  }
}

// ─── Session Class ───────────────────────────────────────────

class Session extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} [options.timeout=2000]    Request timeout in ms
   * @param {number} [options.retries=1]       Number of retries on timeout
   * @param {number} [options.ttl=128]         IP TTL value
   * @param {number} [options.packetSize=64]   ICMP payload size in bytes
   */
  constructor(options = {}) {
    super();
    this._closed = false;
    this._nextSeq = 0;
    this._pending = new Map(); // seq → { resolve, reject, target, host }

    const nativeOpts = {
      timeout: options.timeout ?? 2000,
      retries: options.retries ?? 1,
      ttl: options.ttl ?? 128,
      packetSize: options.packetSize ?? 64,
    };

    this._native = new NativePingSession(
      nativeOpts,
      // onReply
      (_err, reply) => {
        const entry = this._pending.get(reply.seq);
        if (!entry) return;
        this._pending.delete(reply.seq);
        entry.resolve({
          host: entry.host,
          addr: reply.addr,
          alive: true,
          time: reply.time,
          ttl: reply.ttl,
          bytes: reply.bytes,
          seq: reply.seq,
        });
      },
      // onTimeout
      (_err, info) => {
        const entry = this._pending.get(info.seq);
        if (!entry) return;
        this._pending.delete(info.seq);
        entry.reject(new PingTimeoutError(entry.host));
      },
      // onError
      (_err, info) => {
        const entry = this._pending.get(info.seq);
        if (!entry) return;
        this._pending.delete(info.seq);
        entry.reject(
          new DestinationUnreachableError(entry.host, info.icmpType, info.icmpCode)
        );
      }
    );
  }

  // ─── Style 1: Callback (net-ping compatible) ────────────────

  /**
   * Ping with a callback (net-ping style).
   *
   * @param {string} target   IP address or hostname
   * @param {function} callback (error, target, sent, rcvd)
   */
  pingHost(target, callback) {
    const sent = new Date();
    this.ping(target)
      .then((result) => {
        const rcvd = new Date(sent.getTime() + result.time);
        callback(null, target, sent, rcvd);
      })
      .catch((err) => {
        callback(err, target, sent, sent);
      });
  }

  // ─── Style 2: Promise (async/await) ─────────────────────────

  /**
   * Ping with a Promise. When count > 1, returns aggregate stats.
   *
   * @param {string} target   IP address or hostname
   * @param {object} [opts]
   * @param {number} [opts.count=1]  Number of pings (returns stats when > 1)
   * @returns {Promise<PingResult|PingStats>}
   */
  async ping(target, opts = {}) {
    if (this._closed) {
      throw new Error('Session is closed');
    }

    const count = opts.count || 1;

    if (count === 1) {
      return this._sendOne(target);
    }

    // Multiple pings: send sequentially, then aggregate results
    const replies = [];
    const errors = [];

    for (let i = 0; i < count; i++) {
      try {
        const reply = await this._sendOne(target);
        replies.push(reply);
      } catch (err) {
        errors.push(err);
      }
    }

    const alive = replies.length > 0;
    const times = replies.map((r) => r.time);
    const packetLoss = errors.length / count;

    return {
      host: target,
      alive,
      min: alive ? Math.min(...times) : 0,
      max: alive ? Math.max(...times) : 0,
      avg: alive ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      packetLoss,
      replies,
      errors,
    };
  }

  // ─── Style 3: Batch (concurrent multi-target) ───────────────

  /**
   * Ping multiple targets concurrently.
   *
   * @param {string[]} targets   List of targets
   * @param {object} [opts]      Ping options applied to each target
   * @returns {Promise<Map<string, PingResult>>}
   */
  async pingBatch(targets, opts = {}) {
    const entries = await Promise.all(
      targets.map(async (target) => {
        try {
          const result = await this.ping(target, opts);
          return [target, result];
        } catch (err) {
          return [target, { host: target, alive: false, error: err.message }];
        }
      })
    );
    return new Map(entries);
  }

  // ─── Teardown ──────────────────────────────────────────────

  close() {
    if (this._closed) return;
    this._closed = true;
    this._native.close();

    // Reject all pending requests
    for (const [, entry] of this._pending) {
      entry.reject(new Error('Session closed'));
    }
    this._pending.clear();
    this.emit('close');
  }

  // ─── Internal ──────────────────────────────────────────────

  /**
   * Send a single ping and return a Promise for the reply.
   * @private
   */
  _sendOne(target) {
    return new Promise((resolve, reject) => {
      try {
        const seq = this._native.sendPing(target);
        this._pending.set(seq, { resolve, reject, target, host: target });
      } catch (err) {
        reject(err);
      }
    });
  }
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * Create a custom ping session with manual lifecycle management.
 *
 * @param {object} [options]
 * @param {number} [options.timeout=2000]    Request timeout in ms
 * @param {number} [options.retries=1]       Number of retries on timeout
 * @param {number} [options.ttl=128]         IP TTL value
 * @param {number} [options.packetSize=64]   ICMP payload size in bytes
 * @returns {Session}
 *
 * @example
 * const custom = createSession({ timeout: 5000 });
 * await custom.ping('8.8.8.8');
 * custom.close();
 */
function createSession(options) {
  return new Session(options);
}

// ─── DefaultSession (lazy-init wrapper with keepAlive) ───────

/**
 * Default session — lazily created, auto-closes after idle timeout.
 *
 * Usage:
 * - Call `session.ping(target)` directly — no manual setup or teardown needed.
 * - The underlying native session is created on first use and recycled
 *   automatically when idle for the configured keepAlive duration.
 */
class DefaultSession {
  constructor() {
    /** @type {Session|null} */
    this._session = null;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    /** @type {object} Native session configuration */
    this._config = {
      timeout: 2000,
      retries: 1,
      ttl: 128,
      packetSize: 64,
    };
    /** @type {number} Idle timeout in ms before auto-close (0 = never) */
    this._keepAlive = 10000;
  }

  // ─── Configuration ────────────────────────────────────────────

  /**
   * Update session configuration.
   *
   * Can only be called when no session is active (before the first ping,
   * or after close/keepAlive has reclaimed the session).
   * Throws if a session is currently active — call `close()` first.
   *
   * @param {object} config
   * @param {number} [config.timeout]     Request timeout in ms
   * @param {number} [config.retries]     Number of retries on timeout
   * @param {number} [config.ttl]         IP TTL value
   * @param {number} [config.packetSize]  ICMP payload size in bytes
   * @param {number} [config.keepAlive]   Idle timeout in ms (0 = never auto-close)
   * @throws {Error} If session is currently active
   *
   * @example
   * session.setConfig({ timeout: 5000, retries: 2, keepAlive: 30000 });
   * await session.ping('8.8.8.8'); // Uses the new configuration
   */
  setConfig(config) {
    if (this._session) {
      throw new Error(
        'Cannot setConfig while session is active. Call close() first.'
      );
    }
    if (config.keepAlive !== undefined) {
      this._keepAlive = config.keepAlive;
    }
    const { keepAlive, ...nativeConfig } = config;
    this._config = { ...this._config, ...nativeConfig };
  }

  // ─── Ping Methods (delegated to internal session) ────────────

  /**
   * Ping a target (lazily creates the underlying session).
   *
   * @param {string} target   IP address or hostname
   * @param {object} [opts]
   * @param {number} [opts.count=1]  Number of pings (returns stats when > 1)
   * @returns {Promise<object>}
   *
   * @example
   * const result = await session.ping('8.8.8.8');
   * console.log(result.time); // RTT in ms
   */
  async ping(target, opts) {
    return this._getOrCreate().ping(target, opts);
  }

  /**
   * Ping with a callback (net-ping compatible).
   *
   * @param {string} target   IP address or hostname
   * @param {function} callback  (error, target, sent, rcvd)
   */
  pingHost(target, callback) {
    this._getOrCreate().pingHost(target, callback);
  }

  /**
   * Ping multiple targets concurrently.
   *
   * @param {string[]} targets  List of targets
   * @param {object} [opts]     Ping options applied to each target
   * @returns {Promise<Map<string, object>>}
   *
   * @example
   * const results = await session.pingBatch(['8.8.8.8', '1.1.1.1']);
   */
  async pingBatch(targets, opts) {
    return this._getOrCreate().pingBatch(targets, opts);
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /**
   * Manually close the current session.
   *
   * After closing, you can call setConfig() again.
   * The next ping will automatically create a new session.
   */
  close() {
    this._clearKeepAliveTimer();
    if (this._session) {
      this._session.close();
      this._session = null;
    }
  }

  // ─── Internal ───────────────────────────────────────────────

  /** @private Get existing session or create a new one. */
  _getOrCreate() {
    if (!this._session) {
      this._session = new Session(this._config);
    }
    this._resetKeepAliveTimer();
    return this._session;
  }

  /** @private Reset the keepAlive idle timer. */
  _resetKeepAliveTimer() {
    this._clearKeepAliveTimer();
    if (this._keepAlive > 0) {
      this._timer = setTimeout(() => {
        // Still has pending requests — postpone close to next cycle
        if (this._session && this._session._pending.size > 0) {
          this._resetKeepAliveTimer();
          return;
        }
        this.close();
      }, this._keepAlive);
      // Allow the process to exit naturally
      if (this._timer.unref) {
        this._timer.unref();
      }
    }
  }

  /** @private Clear the keepAlive timer. */
  _clearKeepAliveTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// ─── Default Instance & Exports ──────────────────────────────

const defaultSession = new DefaultSession();

module.exports = {
  /** Default session (lazy-init, auto-closes when idle) */
  session: defaultSession,
  /** Create a custom Session with manual lifecycle management */
  createSession,
  /** Session class */
  Session,
  /** Thrown when a ping request times out */
  PingTimeoutError,
  /** Thrown when the destination is unreachable */
  DestinationUnreachableError,
  /** Low-level native binding (advanced usage) */
  NativePingSession,
};
