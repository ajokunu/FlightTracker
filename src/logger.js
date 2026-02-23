import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'flight-tracker.log');

fs.mkdirSync(LOG_DIR, { recursive: true });

function timestamp() {
  return new Date().toISOString();
}

function writeToFile(line) {
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Silent fail — don't crash on log write errors
  }
}

function formatArgs(args) {
  return args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
}

export const logger = {
  info(...args) {
    const msg = `[${timestamp()}] INFO  ${formatArgs(args)}`;
    console.log(msg);
    writeToFile(msg);
  },
  warn(...args) {
    const msg = `[${timestamp()}] WARN  ${formatArgs(args)}`;
    console.warn(msg);
    writeToFile(msg);
  },
  error(...args) {
    const msg = `[${timestamp()}] ERROR ${formatArgs(args)}`;
    console.error(msg);
    writeToFile(msg);
  },
  debug(...args) {
    const msg = `[${timestamp()}] DEBUG ${formatArgs(args)}`;
    writeToFile(msg);
  },
};
