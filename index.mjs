/**
 * rust-ping ESM entry point
 *
 * Re-exports from the CJS module so ESM consumers can use import syntax.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const binding = require('./index.js');

export const {
  session,
  createSession,
  Session,
  PingTimeoutError,
  DestinationUnreachableError,
  NativePingSession,
} = binding;

export default binding;
