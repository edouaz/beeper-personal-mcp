import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hashOwnerPassword } from './oauth.mjs';

if (!process.stdout.isTTY || process.argv.length !== 3) {
  process.stderr.write('Run interactively: node setup-owner.mjs /secure/path/oauth-owner.env\n');
  process.exit(1);
}
const password = randomBytes(32).toString('base64url');
const hash = hashOwnerPassword(password);
writeFileSync(process.argv[2], `OAUTH_OWNER_PASSWORD_HASH=${hash}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`Save this owner password in your password manager. It will not be shown again.\n\n${password}\n\n`);
