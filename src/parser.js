// src/parser.js
import { parseLockfile } from './format-library.js';

export function parsePackageLock(content) {
  return parseLockfile(content);
}
