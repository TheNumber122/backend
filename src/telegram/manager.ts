import { TelegramClient } from "@mtcute/node";
import dotenv from "dotenv";
import { supabase } from "../db/supabase";

dotenv.config();

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH!;

class InMemoryKeyValueRepository {
  private store = new Map<string, Uint8Array>();
  private initialized = false;

  async set(key: string, value: Uint8Array) {
    if (!this.initialized) await this.setup();
    this.store.set(key, value);
  }

  async get(key: string) {
    if (!this.initialized) await this.setup();
    return this.store.get(key) ?? null;
  }

  async delete(key: string) {
    if (!this.initialized) await this.setup();
    this.store.delete(key);
  }

  async deleteAll() {
    if (!this.initialized) await this.setup();
    this.store.clear();
  }

  async setup() {
    if (this.initialized) return;
    this.initialized = true;
  }

  async destroy() {
    if (!this.initialized) return;
    await this.deleteAll();
    this.initialized = false;
  }
}

class InMemoryAuthKeysRepository {
  private keys = new Map<number, Uint8Array | null>();
  private tempKeys = new Map<string, { key: Uint8Array; expires: number }>();
  private initialized = false;

  async set(dc: number, key: Uint8Array | null) {
    if (!this.initialized) await this.setup();
    this.keys.set(dc, key);
  }

  async get(dc: number) {
    if (!this.initialized) await this.setup();
    return this.keys.get(dc) ?? null;
  }

  async setTemp(
    dc: number,
    idx: number,
    key: Uint8Array | null,
    expires: number
  ) {
    if (!this.initialized) await this.setup();
    if (key) this.tempKeys.set(`${dc}:${idx}`, { key, expires });
    else this.tempKeys.delete(`${dc}:${idx}`);
  }

  async getTemp(dc: number, idx: number, now: number) {
    if (!this.initialized) await this.setup();
    const entry = this.tempKeys.get(`${dc}:${idx}`);
    if (entry && now < entry.expires) return entry.key;
    return null;
  }

  async deleteByDc(dc: number) {
    if (!this.initialized) await this.setup();
    this.keys.delete(dc);
    for (const k of Array.from(this.tempKeys.keys())) {
      if (k.startsWith(`${dc}:`)) this.tempKeys.delete(k);
    }
  }

  async deleteAll() {
    if (!this.initialized) await this.setup();
    this.keys.clear();
    this.tempKeys.clear();
  }

  async setup() {
    if (this.initialized) return;
    this.initialized = true;
  }

  async destroy() {
    if (!this.initialized) return;
    await this.deleteAll();
    this.initialized = false;
  }
}

class InMemoryStorageDriver {
  private initialized = false;

  async load() {
    if (!this.initialized) await this.setup();
  }

  async save() {
    if (!this.initialized) await this.setup();
  }

  async destroy() {
    if (!this.initialized) return;
    this.initialized = false;
  }

  async setup() {
    if (this.initialized) return;
    this.initialized = true;
  }
}

class InMemoryPeersRepository {
  private entities = new Map<any, any>();
  private usernameIndex = new Map<string, any>();
  private phoneIndex = new Map<string, any>();
  private initialized = false;

  async store(peer: any) {
    if (!this.initialized) await this.setup();
    const old = this.entities.get(peer.id);
    if (old) {
      if (old.usernames)
        old.usernames.forEach((username: string) =>
          this.usernameIndex.delete(username)
        );
      if (old.phone) this.phoneIndex.delete(old.phone);
    }
    if (peer.usernames)
      for (const username of peer.usernames)
        this.usernameIndex.set(username, peer.id);
    if (peer.phone) this.phoneIndex.set(peer.phone, peer.id);
    this.entities.set(peer.id, peer);
  }

  async getById(id: any) {
    if (!this.initialized) await this.setup();
    return this.entities.get(id) ?? null;
  }

  async getByUsername(username: string) {
    if (!this.initialized) await this.setup();
    const id = this.usernameIndex.get(username.toLowerCase());
    if (!id) return null;
    const ent = this.entities.get(id);
    if (!ent || ent.isMin) return null;
    return ent;
  }

  async getByPhone(phone: string) {
    if (!this.initialized) await this.setup();
    const id = this.phoneIndex.get(phone);
    if (!id) return null;
    const ent = this.entities.get(id);
    if (!ent || ent.isMin) return null;
    return ent;
  }

  async deleteAll() {
    if (!this.initialized) await this.setup();
    this.entities.clear();
    this.phoneIndex.clear();
    this.usernameIndex.clear();
  }

  async setup() {
    if (this.initialized) return;
    this.initialized = true;
  }

  async destroy() {
    if (!this.initialized) return;
    await this.deleteAll();
    this.initialized = false;
  }
}

class InMemoryRefMessagesRepository {
  private refs = new Map<any, Set<string>>();
  private initialized = false;

  async store(peerId: any, chatId: any, msgId: any) {
    if (!this.initialized) await this.setup();
    if (!this.refs.has(peerId)) this.refs.set(peerId, new Set());
    this.refs.get(peerId)!.add(`${chatId}:${msgId}`);
  }

  async getByPeer(peerId: any) {
    if (!this.initialized) await this.setup();
    const refs = this.refs.get(peerId);
    if (!refs?.size) return null;
    const [ref] = refs;
    if (!ref) return null;
    const [chatId, msgId] = ref.split(":");
    if (chatId === undefined || msgId === undefined) return null;
    return [Number(chatId), Number(msgId)] as [number, number];
  }

  async delete(chatId: any, msgIds: any[]) {
    if (!this.initialized) await this.setup();
    for (const refs of this.refs.values()) {
      for (const msg of msgIds) refs.delete(`${chatId}:${msg}`);
    }
  }

  async deleteByPeer(peerId: any) {
    if (!this.initialized) await this.setup();
    this.refs.delete(peerId);
  }

  async deleteAll() {
    if (!this.initialized) await this.setup();
    this.refs.clear();
  }

  async setup() {
    if (this.initialized) return;
    this.initialized = true;
  }

  async destroy() {
    if (!this.initialized) return;
    await this.deleteAll();
    this.initialized = false;
  }
}

class InMemoryTelegramStorage {
  readonly driver = new InMemoryStorageDriver();
  readonly kv = new InMemoryKeyValueRepository();
  readonly authKeys = new InMemoryAuthKeysRepository();
  readonly peers = new InMemoryPeersRepository();
  readonly refMessages = new InMemoryRefMessagesRepository();

  async destroy() {
    await Promise.all([
      this.driver.destroy(),
      this.kv.destroy(),
      this.authKeys.destroy(),
      this.peers.destroy(),
      this.refMessages.destroy(),
    ]);
  }
}

// In-memory storage: phone -> { client, storage }
type SessionEntry = {
  client: TelegramClient;
  storage: InMemoryTelegramStorage;
};
const sessionStore = new Map<string, SessionEntry>();
const codeHashStore = new Map<string, string>();
// Phones that passed the code step and are now waiting for a 2FA password.
const awaitingPassword = new Set<string>();

// Serializes account operations so only one account is ever active at a time.
// Chained promises: each caller waits for the previous one to release.
let accountLock: Promise<void> = Promise.resolve();
export async function withAccountLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = accountLock;
  let release!: () => void;
  accountLock = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function logSessionCount() {
  console.log(`[Telegap] Accounts in memory: ${sessionStore.size}`);
}

// Destroy every in-memory client except (optionally) one. We only ever want a
// single account logged in at a time: lingering clients keep running mtcute's
// updates loop, which spams channelDifferenceTooLong / get_state warnings and
// wastes connections. Call this before bringing any client online.
export async function clearAllSessionsExcept(keepPhone?: string) {
  const phones = Array.from(sessionStore.keys()).filter((p) => p !== keepPhone);
  for (const p of phones) {
    await clearSession(p);
  }
}

export function getSessionCount() {
  return sessionStore.size;
}

export async function clearSession(phone: string) {
  try {
    const entry = sessionStore.get(phone);
    if (entry) {
      // Properly destroy the TelegramClient
      await entry.client.destroy();
      // Clean up all storage components
      await entry.storage.destroy();
      sessionStore.delete(phone);
    }
    codeHashStore.delete(phone);
    awaitingPassword.delete(phone);
  } catch (err) {
    console.error(`[Telegap] Error cleaning up session for ${phone}:`, err);
    sessionStore.delete(phone);
    codeHashStore.delete(phone);
    awaitingPassword.delete(phone);
  }
}

async function createClient(
  phone?: string,
  skipValidation = false
): Promise<TelegramClient> {
  try {
    let entry: SessionEntry | undefined;
    if (phone && sessionStore.has(phone)) {
      entry = sessionStore.get(phone);
      if (entry && entry.client) {
        // During the login handshake (send-code → verify) the client is
        // connected but not yet authorized, so getMe() would throw and
        // clearSession() would wipe the pending code hash. Skip the check
        // and reuse the in-flight client as-is.
        if (skipValidation) {
          return entry.client;
        }
        try {
          // Check if the client is still valid by trying a simple operation
          await entry.client.getMe();
          return entry.client;
        } catch (clientErr) {
          // Client is invalid or destroyed, remove it
          await clearSession(phone);
        }
      }
    }

    // Enforce a single live account: tear down any other clients before we
    // bring a new one online. This prevents two accounts being logged in at
    // once and stops orphaned update loops.
    if (phone) await clearAllSessionsExcept(phone);

    // Create new client
    const storage = new InMemoryTelegramStorage();
    const client = new TelegramClient({
      apiId: API_ID,
      apiHash: API_HASH,
      storage,
    });

    entry = { client, storage };
    if (phone) sessionStore.set(phone, entry);

    if (!entry) {
      throw new Error("Failed to create TelegramClient session entry");
    }
    return entry.client;
  } catch (err) {
    if (phone) {
      await clearSession(phone);
    }
    throw err;
  }
}

export async function sendLoginCode(phone: string): Promise<void> {
  const client = await createClient(phone);
  try {
    const codeResult = await client.sendCode({ phone });
    if ("phoneCodeHash" in codeResult) {
      codeHashStore.set(phone, codeResult.phoneCodeHash);
    } else {
      throw new Error("Failed to send code: phoneCodeHash missing");
    }
  } catch (err) {
    await clearSession(phone);
    throw err;
  }
}

export async function verifyLoginCode(
  phone: string,
  code: string,
  password?: string
) {
  // Reuse the pending client from send-code without validating it — the
  // account isn't authorized yet, so a getMe() check would destroy the session
  // (and the stored code hash) before we can sign in.
  const client = await createClient(phone, true);

  // Persist a signed-in user to Supabase and return it. Login is complete, so
  // drop the transient login state (but keep the authorized client in memory).
  const saveUser = async (user: any) => {
    const sessionString = await client.exportSession();
    let username: string | null = null;
    if (user && user.username) username = user.username;
    else if (user && user.firstName) username = user.firstName;

    await supabase.from("telegram_accounts").upsert({
      phone,
      session_string: sessionString,
      groups_count: 0, // Initialize groups count for new accounts
      username,
    });
    // Session is safely persisted to the DB — kill the in-memory client so we
    // don't stay connected (and so its updates loop stops). It'll be re-imported
    // from the stored session_string only when an operation actually needs it.
    await clearSession(phone);
    return user;
  };

  // Submit the 2FA password against the account's Two-Step Verification.
  const submitPassword = async () => {
    if (!password) {
      // Keep the session alive so a follow-up call with the password succeeds.
      throw new Error(
        "This account has 2-step verification (2FA) enabled. A password is required."
      );
    }
    try {
      const user = await client.checkPassword(password);
      return await saveUser(user);
    } catch (passwordErr: any) {
      const t = String(passwordErr?.message ?? passwordErr?.text ?? "");
      // Wrong password is retryable — keep the session so the user can re-enter
      // it without starting over. Only a lost session forces a restart.
      if (t.includes("PASSWORD_HASH_INVALID") || /password/i.test(t)) {
        throw new Error("Invalid 2FA password. Please try again.");
      }
      await clearSession(phone);
      throw passwordErr;
    }
  };

  // Already past the code step — the code is consumed, so go straight to the
  // password check instead of re-running signIn (which would fail).
  if (awaitingPassword.has(phone)) {
    return await submitPassword();
  }

  const phoneCodeHash = codeHashStore.get(phone);
  if (!phoneCodeHash) {
    // In-memory hash is gone (e.g. backend restarted between send-code and
    // verify). Tell the caller to request a fresh code rather than a vague 500.
    throw new Error(
      "Login session expired. Please request a new code and try again."
    );
  }

  try {
    const user = await client.signIn({ phone, phoneCodeHash, phoneCode: code });
    return await saveUser(user);
  } catch (err: any) {
    const errText = String(err?.message ?? err?.text ?? err ?? "");

    // 2FA detection is deliberately broad: mtcute reports this as a friendly
    // "2FA is enabled, use a password to login." message, not the raw
    // SESSION_PASSWORD_NEEDED RPC error.
    const needsPassword =
      err?.type === "SESSION_PASSWORD_NEEDED" ||
      errText.includes("SESSION_PASSWORD_NEEDED") ||
      /2fa|2-step|two-step|password/i.test(errText);

    if (needsPassword) {
      // The code was accepted; remember that so a later call skips signIn and
      // goes straight to checkPassword. Do NOT clear the session here.
      awaitingPassword.add(phone);
      return await submitPassword();
    }

    // A wrong or incomplete code is retryable: Telegram accepts another attempt
    // on the same code hash. Keep the client + hash so the user can just retype.
    if (
      errText.includes("PHONE_CODE_INVALID") ||
      errText.includes("PHONE_CODE_EMPTY")
    ) {
      throw new Error("Invalid code. Please check the digits and try again.");
    }

    // Expired code or any other fatal error — reset so the user starts fresh.
    await clearSession(phone);
    throw err;
  }
}

export async function getClientByPhone(phone: string): Promise<TelegramClient> {
  try {
    if (sessionStore.has(phone)) {
      return createClient(phone);
    }

    const { data, error } = await supabase
      .from("telegram_accounts")
      .select("session_string")
      .eq("phone", phone)
      .single();
    if (error || !data?.session_string) {
      console.error(
        `[Telegap] No session found in Supabase for phone: ${phone}`
      );
      throw new Error("No session found for this phone.");
    }

    const sessionString = data.session_string;

    const client = await createClient(phone);
    try {
      await client.importSession(sessionString);
      return client;
    } catch (err) {
      console.error(`[Telegap] Failed to import session for ${phone}:`, err);
      await clearSession(phone);
      throw err;
    }
  } catch (err) {
    await clearSession(phone);
    throw err;
  }
}

export async function handleTelegramRateLimit(
  phone: string,
  error: any
): Promise<number | null> {
  // Check for flood wait patterns in error message
  const floodWaitPatterns = [
    /wait of (\d+) seconds/i,
    /FLOOD_WAIT_(\d+)/i,
    /flood wait.*?(\d+)/i,
  ];

  for (const pattern of floodWaitPatterns) {
    const match = error.message.match(pattern);
    if (match) {
      const waitSeconds = parseInt(match[1]);
      const floodWaitUntil = new Date(Date.now() + waitSeconds * 1000);

      // Real Telegram flood wait: block via flood_wait_until, separate from the
      // 24h window marker so it can trigger before the 50/24h cap is reached.
      // Don't touch groups_created_24h or next_available_time.
      const { error: updateError } = await supabase
        .from("telegram_accounts")
        .update({
          flood_wait_until: floodWaitUntil.toISOString(),
        })
        .eq("phone", phone);

      if (updateError) {
        console.error("Failed to update account for flood wait:", updateError);
      } else {
        const hours = Math.round(waitSeconds / 3600);
        console.log(
          `[Telegap] Account ${phone} marked as unavailable for ${waitSeconds} seconds (${hours} hours) due to flood wait`
        );
      }

      return waitSeconds;
    }
  }

  // Check for other rate limit patterns
  if (
    error.message &&
    (error.message.includes("rate limit") ||
      error.message.includes("RATE_LIMIT") ||
      error.message.includes("too many requests"))
  ) {
    // For other rate limits, set a default 1-hour wait
    const waitSeconds = 3600; // 1 hour default
    const floodWaitUntil = new Date(Date.now() + waitSeconds * 1000);

    const { error: updateError } = await supabase
      .from("telegram_accounts")
      .update({
        flood_wait_until: floodWaitUntil.toISOString(),
      })
      .eq("phone", phone);

    if (updateError) {
      console.error("Failed to update account for rate limit:", updateError);
    } else {
      console.log(
        `[Telegap] Account ${phone} marked as unavailable for ${waitSeconds} seconds due to rate limit`
      );
    }

    return waitSeconds;
  }

  return null;
}

// List of random username parts for group names
const adjectives = [
  "cool",
  "awesome",
  "amazing",
  "super",
  "mega",
  "ultra",
  "epic",
  "pro",
  "elite",
  "prime",
  "master",
  "legend",
  "hero",
  "champion",
  "warrior",
  "ninja",
  "wizard",
  "dragon",
  "phoenix",
  "titan",
];

const nouns = [
  "star",
  "moon",
  "sun",
  "sky",
  "ocean",
  "mountain",
  "river",
  "forest",
  "crystal",
  "diamond",
  "thunder",
  "lightning",
  "storm",
  "fire",
  "ice",
  "wind",
  "earth",
  "metal",
  "wood",
  "water",
];

export function generateRandomUsername(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 999) + 1;
  return `${adj}_${noun}${num}`;
}
