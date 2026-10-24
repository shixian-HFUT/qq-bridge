import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillImageOutbox } from '../src/image-outbox-backfill.js';

const rootFlag = process.argv.indexOf('--root');
const root = rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1]) : fileURLToPath(new URL('..', import.meta.url));
console.log(JSON.stringify(backfillImageOutbox(path.join(root, 'state/image-sends.json'), path.join(root, 'state/pi'), {
  apply: process.argv.includes('--apply'),
})));
