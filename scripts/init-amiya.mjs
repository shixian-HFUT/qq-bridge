// Prepare a new checkout; existing configuration and state are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
function create(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 }); console.log('Created', relative); }
  catch (error) { if (error.code !== 'EEXIST') throw error; console.log('Kept', relative); }
}
create('config.json', fs.readFileSync(path.join(root, 'config.amiya.example.json')));
create('state/current-role.json', JSON.stringify({ role: '阿米娅', mode: 'active' }) + '\n');
create('state/mode.json', JSON.stringify({ mode: 'reserved2' }) + '\n');
create('services/livingmemory/config/service.json', fs.readFileSync(path.join(root, 'services/livingmemory/config/service.example.json')));
console.log('Set ownerQQ, allow lists and provider credentials before starting. LivingMemory is disabled in the example.');
