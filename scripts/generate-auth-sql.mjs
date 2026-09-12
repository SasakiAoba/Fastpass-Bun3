import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { argon2idAsync } from "@noble/hashes/argon2.js";

const password = readFileSync(0, "utf8").replace(/[\r\n]+$/u, "");
if (password.length < 10 || password.length > 256) {
  throw new Error("Password must be between 10 and 256 characters.");
}

const memory = 19_456;
const iterations = 2;
const parallelism = 1;
const salt = randomBytes(16);
const derived = await argon2idAsync(new TextEncoder().encode(password), salt, {
  m: memory,
  t: iterations,
  p: parallelism,
  dkLen: 32,
  maxmem: 64 * 1024 * 1024,
  asyncTick: 10,
});
const encode = (value) => Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const hash = `$argon2id$v=19$m=${memory},t=${iterations},p=${parallelism}$${encode(salt)}$${encode(derived)}`;

process.stdout.write(`INSERT INTO auth_credentials (singleton_id, password_hash, algorithm, memory_kib, iterations, parallelism, auth_generation, created_at_ms, updated_at_ms)\nVALUES (1, '${hash}', 'argon2id', ${memory}, ${iterations}, ${parallelism}, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)\nON CONFLICT(singleton_id) DO UPDATE SET password_hash = excluded.password_hash, algorithm = excluded.algorithm, memory_kib = excluded.memory_kib, iterations = excluded.iterations, parallelism = excluded.parallelism, auth_generation = auth_credentials.auth_generation + 1, updated_at_ms = excluded.updated_at_ms;\n`);
