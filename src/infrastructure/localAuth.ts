const AUTH_KEY = "bun3-fastpass:local-auth:v1";
const SESSION_KEY = "bun3-fastpass:session:v2";
const LEGACY_SESSION_KEY = "bun3-fastpass:session:v1";
const ITERATIONS = 210_000;

type AuthRecord = {
  version: 1;
  algorithm: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  verifier: string;
  createdAtMs: number;
};

type LocalSession = {
  version: 2;
  authenticatedAtMs: number;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveVerifier(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt.buffer as ArrayBuffer,
      iterations,
    },
    keyMaterial,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function readAuthRecord(): AuthRecord | null {
  const raw = localStorage.getItem(AUTH_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AuthRecord>;
    if (
      value.version !== 1 ||
      value.algorithm !== "PBKDF2-SHA-256" ||
      typeof value.iterations !== "number" ||
      typeof value.salt !== "string" ||
      typeof value.verifier !== "string"
    ) {
      return null;
    }
    return value as AuthRecord;
  } catch {
    return null;
  }
}

export function hasLocalPassword(): boolean {
  return readAuthRecord() !== null;
}

export function validateNewPassword(password: string): string[] {
  const errors: string[] = [];
  if (password.length < 10) errors.push("10文字以上にしてください。");
  if (!/[A-Z]/.test(password)) errors.push("大文字を1文字以上含めてください。");
  if (!/[a-z]/.test(password)) errors.push("小文字を1文字以上含めてください。");
  if (!/[0-9]/.test(password)) errors.push("数字を1文字以上含めてください。");
  return errors;
}

export async function configureLocalPassword(password: string): Promise<void> {
  const errors = validateNewPassword(password);
  if (errors.length > 0) throw new Error(errors.join(" "));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const verifier = await deriveVerifier(password, salt, ITERATIONS);
  const record: AuthRecord = {
    version: 1,
    algorithm: "PBKDF2-SHA-256",
    iterations: ITERATIONS,
    salt: bytesToBase64(salt),
    verifier,
    createdAtMs: Date.now(),
  };
  localStorage.setItem(AUTH_KEY, JSON.stringify(record));
}

export async function verifyLocalPassword(password: string): Promise<boolean> {
  const record = readAuthRecord();
  if (!record) return false;
  const verifier = await deriveVerifier(password, base64ToBytes(record.salt), record.iterations);
  return constantTimeEqual(verifier, record.verifier);
}

export function beginLocalSession(nowMs = Date.now()): void {
  const session: LocalSession = {
    version: 2,
    authenticatedAtMs: nowMs,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionStorage.removeItem(LEGACY_SESSION_KEY);
}

export function endLocalSession(): void {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(LEGACY_SESSION_KEY);
}

export function isLocalSessionValid(): boolean {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  try {
    const session = JSON.parse(raw) as LocalSession;
    if (session.version !== 2 || !Number.isFinite(session.authenticatedAtMs)) {
      endLocalSession();
      return false;
    }
    return true;
  } catch {
    endLocalSession();
    return false;
  }
}

export function clearLocalCredential(): void {
  localStorage.removeItem(AUTH_KEY);
  endLocalSession();
}
