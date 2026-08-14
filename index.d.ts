/**
 * rust-ping — High-performance ICMP ping for Node.js/Bun
 */

export interface PingOptions {
  /** Request timeout in ms (default: 2000) */
  timeout?: number;
  /** Number of retries on timeout (default: 1) */
  retries?: number;
  /** IP TTL value (default: 128) */
  ttl?: number;
  /** ICMP payload size in bytes (default: 64) */
  packetSize?: number;
}

export interface PingResult {
  /** Target hostname as provided */
  host: string;
  /** Resolved IP address */
  addr: string;
  /** Whether the host is reachable */
  alive: boolean;
  /** Round-trip time in ms */
  time: number;
  /** TTL from the reply packet */
  ttl: number;
  /** Reply payload size in bytes */
  bytes: number;
  /** ICMP sequence number */
  seq: number;
}

export interface PingStats {
  host: string;
  alive: boolean;
  /** Minimum RTT in ms */
  min: number;
  /** Maximum RTT in ms */
  max: number;
  /** Average RTT in ms */
  avg: number;
  /** Packet loss ratio (0–1) */
  packetLoss: number;
  replies: PingResult[];
  errors: Error[];
}

export interface SessionConfig extends PingOptions {
  /** Idle timeout in ms before auto-close (0 = never, default: 10000) */
  keepAlive?: number;
}

export declare class PingTimeoutError extends Error {
  name: 'PingTimeoutError';
  target: string;
  constructor(target: string);
}

export declare class DestinationUnreachableError extends Error {
  name: 'DestinationUnreachableError';
  target: string;
  icmpType: number;
  icmpCode: number;
  constructor(target: string, icmpType: number, icmpCode: number);
}

export declare class Session {
  constructor(options?: PingOptions);
  /** Ping a target. Returns stats when count > 1. */
  ping(target: string, opts?: { count?: number }): Promise<PingResult | PingStats>;
  /** Ping with a callback (net-ping compatible). */
  pingHost(target: string, callback: (error: Error | null, target: string, sent: Date, rcvd: Date) => void): void;
  /** Ping multiple targets concurrently. */
  pingBatch(targets: string[], opts?: { count?: number }): Promise<Map<string, PingResult | PingStats>>;
  /** Close the session and reject all pending requests. */
  close(): void;
}

export declare class DefaultSession {
  /** Update configuration (only when no session is active). */
  setConfig(config: SessionConfig): void;
  /** Ping a target (lazily creates the underlying session). */
  ping(target: string, opts?: { count?: number }): Promise<PingResult | PingStats>;
  /** Ping with a callback (net-ping compatible). */
  pingHost(target: string, callback: (error: Error | null, target: string, sent: Date, rcvd: Date) => void): void;
  /** Ping multiple targets concurrently. */
  pingBatch(targets: string[], opts?: { count?: number }): Promise<Map<string, PingResult | PingStats>>;
  /** Manually close the session. Can call setConfig() again afterwards. */
  close(): void;
}

/** Default session (lazy-init, auto-closes when idle). */
export declare const session: DefaultSession;

/** Create a custom Session with manual lifecycle management. */
export declare function createSession(options?: PingOptions): Session;

export { NativePingSession } from './binding';
