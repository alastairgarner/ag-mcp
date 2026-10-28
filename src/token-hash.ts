import { hashToken } from './auth.js';

// Only stdin, never argv/environment. Output is a digest, never the raw token.
try {
  if (process.argv.length !== 2) throw new Error('Read the token from stdin, not arguments');
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string' || input.length + chunk.length > 258) throw new Error('Invalid token input');
    input += chunk;
  }
  const token = input.replace(/\r?\n$/, '');
  process.stdout.write(hashToken(token) + '\n');
} catch {
  console.error('Expected one token on stdin: 32–256 URL-safe characters. No token was printed.');
  process.exitCode = 1;
}
