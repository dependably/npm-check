// src/parser.js
import fs from 'fs';
import { parseLockfile as parseLockfileFromFormat, stringifyLockfile } from './format-library.js';

export function parseLockfile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseLockfileFromFormat(content);
}

export function serializeLockfile(filePath, data, overwrite = false) {
  if (!overwrite && fs.existsSync(filePath)) {
    throw new Error(`File ${filePath} already exists`);
  }
  const content = stringifyLockfile(data);
  fs.writeFileSync(filePath, content, 'utf8');
}
