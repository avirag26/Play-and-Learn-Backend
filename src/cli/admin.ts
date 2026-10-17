/**
 * Manage admin accounts from the server (the API never lets anyone change roles):
 *
 *   npm run admin -- create <email> <name...>   new admin account; asks for a password
 *   npm run admin -- promote <email>            give an existing account the admin role
 *   npm run admin -- demote <email>             take the admin role away
 *   npm run admin -- list                       show all admins
 *
 * The password can also be piped in (one line on stdin) for scripts.
 */
import { ConflictException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as argon2 from 'argon2';
import { setServers } from 'node:dns';
import { createInterface } from 'node:readline';
import { AppModule } from '../app.module.js';
import { UsersService } from '../users/users.service.js';

const USAGE = `Usage:
  npm run admin -- create <email> <name...>
  npm run admin -- promote <email>
  npm run admin -- demote <email>
  npm run admin -- list`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Piped input is collected as soon as the script starts: by the time the password is asked for,
 * starting the app may already have drained stdin.
 */
const pipedLines: Promise<string[]> | null = process.stdin.isTTY
  ? null
  : new Promise((resolve) => {
      const lines: string[] = [];
      const reader = createInterface({ input: process.stdin });
      reader.on('line', (line) => lines.push(line));
      reader.once('close', () => resolve(lines));
    });

/** Reads a line without echoing it when typed at a terminal; takes the first piped line otherwise. */
async function readSecret(prompt: string): Promise<string> {
  if (pipedLines) return (await pipedLines).shift() ?? '';
  const stdin = process.stdin;
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function askNewPassword(): Promise<string> {
  const password = await readSecret('Password for the admin account (at least 8 characters): ');
  if (password.length < 8 || password.length > 128) throw new Error('The password must be 8 to 128 characters.');
  if (process.stdin.isTTY && (await readSecret('Type it again: ')) !== password) throw new Error("The passwords don't match.");
  return password;
}

async function run(users: UsersService, [command, email, ...rest]: string[]): Promise<void> {
  if (command === 'list') {
    const admins = await users.listAdmins();
    console.log(admins.length ? admins.map((admin) => `${admin.email}  (${admin.name})`).join('\n') : 'No admins yet. Create one with: npm run admin -- create <email> <name>');
    return;
  }
  if (!['create', 'promote', 'demote'].includes(command ?? '') || !email || !EMAIL.test(email)) throw new Error(USAGE);
  const address = email.trim().toLowerCase();

  if (command === 'create') {
    const name = rest.join(' ').trim() || 'Admin';
    const password = await askNewPassword();
    await users.createAdmin(address, name, await argon2.hash(password, { type: argon2.argon2id }));
    console.log(`Created admin ${address}. Sign in to the admin app with this email and password.`);
    return;
  }

  const updated = await users.setRole(address, command === 'promote' ? 'admin' : 'user');
  if (!updated) throw new Error(`No account uses ${address}. Create it with: npm run admin -- create ${address} <name>`);
  console.log(command === 'promote' ? `${address} is now an admin.${updated.hasPassword ? '' : ' Note: this account has no password (Google only), and the admin app signs in with email + password.'}` : `${address} is no longer an admin.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') { console.log(USAGE); return; }
  // Same DNS workaround as the server (see main.ts); .env was loaded when AppModule was imported.
  const dnsServers = process.env.DNS_SERVERS?.split(',').map((server) => server.trim()).filter(Boolean);
  if (dnsServers?.length) setServers(dnsServers);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    await run(app.get(UsersService), args);
  } finally {
    await app.close();
    // Stop waiting for piped input the command didn't need, so the process can exit.
    if (pipedLines) process.stdin.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConflictException || error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
