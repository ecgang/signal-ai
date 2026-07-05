/**
 * Relay Fastify app. The relay only ever routes opaque ciphertext envelopes
 * and coordinates group membership — it never sees plaintext or key material.
 *
 * `buildApp` is the app factory: it wires routes/plugins onto a Fastify
 * instance without binding a port, so tests can exercise it via
 * `fastify.inject()` / a real WS client without an actual listening socket.
 * `start()` is the process entry point that also binds the port.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import websocketPlugin from "@fastify/websocket";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  SignupRequestSchema,
  SignupResponseSchema,
  PublishDeviceRequestSchema,
  PublishDeviceResponseSchema,
  FetchPreKeyBundleResponseSchema,
  CreateConversationRequestSchema,
  CreateConversationResponseSchema,
  InviteMemberRequestSchema,
  RemoveMemberRequestSchema,
  MutateMemberResponseSchema,
  SetAiModeRequestSchema,
  SetAiModeResponseSchema,
  ListMembersResponseSchema,
  WsFrameSchema,
  WsDeliverFrameSchema,
  WsSendFrameSchema,
} from "@signalai/proto";
import { loadConfig, type RelayConfig } from "./config.js";
import { authenticate, authenticateToken, generateToken, hashToken, InviteCodeLockout } from "./auth.js";
import {
  createPrismaClient,
  pingDb,
  registerDevice,
  fetchPreKeyBundles,
  createConversation,
  isActiveMember,
  canManageMembership,
  inviteMember,
  removeMember,
  setAiMode,
  getAiMode,
  listMembers,
  listActiveConversationIds,
  enqueueEnvelope,
  drainPendingEnvelopes,
  ackEnvelopes,
  type StoredEnvelope,
} from "./db.js";

// Re-exported so @signalai/client-sdk's E2E test suite can spin up a real
// relay + Postgres connection in-process (see packages/client-sdk/test)
// without duplicating relay bootstrap logic.
export { createPrismaClient } from "./db.js";

/**
 * The `auth` and `hello` frames are the relay's own WS connection handshake
 * (proving who is on the socket and which device it represents) — a pure
 * transport concern no other package speaks, so they stay local rather than
 * widening the shared proto union. The `send` frame, by contrast, is a real
 * client->relay wire shape that @signalai/client-sdk also produces, so it
 * lives in @signalai/proto and is imported above.
 */
const WsAuthFrameSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
  deviceId: z.number().int().nonnegative(),
});
const WsHelloFrameSchema = z.object({
  type: z.literal("hello"),
  deviceId: z.number().int().nonnegative(),
});

const MAX_ENVELOPE_BYTES = 64 * 1024;

/**
 * Per-connection flood guard: at most MAX_FRAMES_PER_WINDOW frames per
 * RATE_WINDOW_MS on a single socket, after which it is closed. This is the
 * authenticated per-device message-rate limit — distinct from the per-IP REST
 * limiter — bounding how fast one client can push envelopes at the relay.
 */
const MAX_FRAMES_PER_WINDOW = 200;
const RATE_WINDOW_MS = 10_000;

/**
 * Sentinel WebSocket subprotocol for the header-auth path. A client offers
 * `[WS_BEARER_SUBPROTOCOL, <token>]`; the relay echoes only the sentinel and
 * reads the bearer token from the *other* offered subprotocol, so the token
 * is carried in a request header (not a query string) and never echoed back.
 */
const WS_BEARER_SUBPROTOCOL = "signalai-bearer";

/** Registry key for a live device connection. */
const connKey = (userId: string, deviceId: number): string => `${userId}:${deviceId}`;

/**
 * Renders a stored envelope into a `deliver` frame, validating through the
 * shared proto schema on the way out (narrows the DB's Int `type` to the
 * wire's 2|3 and rejects a corrupt row rather than delivering something the
 * recipient can't decrypt). Used by both the offline drain and the live push.
 */
function buildDeliverFrame(env: StoredEnvelope): string {
  const frame = WsDeliverFrameSchema.parse({
    type: "deliver",
    envelope: {
      conversationId: env.conversationId,
      senderUserId: env.senderUserId,
      senderDeviceId: env.senderDeviceId,
      recipientDeviceId: env.recipientDeviceId,
      seq: Number(env.seq),
      ciphertext: Buffer.from(env.ciphertext).toString("base64"),
      type: env.type,
    },
  });
  return JSON.stringify(frame);
}

/** A live device connection's delivery sink, registered in `liveSockets` while the socket is open. */
interface LiveConn {
  deliver(env: StoredEnvelope): void;
}

const SignupBodySchema = SignupRequestSchema.extend({
  inviteCode: z.string().min(1),
});

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export function buildApp(config: RelayConfig, prisma: PrismaClient): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma);

  const inviteLockout = new InviteCodeLockout();

  await_register(app, rateLimit, {
    global: false,
  });
  await_register(app, websocketPlugin, {
    // A ws client that offers subprotocols aborts the handshake unless the
    // server selects one. Clients using the header-auth path offer
    // [WS_BEARER_SUBPROTOCOL, <token>] — we echo ONLY the sentinel, never the
    // token, so the bearer never lands in a response header. Connections that
    // offer no subprotocol (the auth-frame path) are unaffected (false = none).
    options: {
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(WS_BEARER_SUBPROTOCOL) ? WS_BEARER_SUBPROTOCOL : false,
    },
  });

  // -------------------------------------------------------------------
  // Auth guard: every route except /signup + /health requires a bearer
  // token that resolves to a user.
  // -------------------------------------------------------------------
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/signup" || request.url === "/health" || request.url.startsWith("/ws")) {
      return;
    }
    const principal = await authenticate(prisma, request.headers.authorization);
    if (!principal) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.principal = principal;
  });

  app.get("/health", async (_request, reply) => {
    const ok = await pingDb(prisma).catch(() => false);
    return reply.code(ok ? 200 : 503).send({ db: ok ? "ok" : "error" });
  });

  app.post(
    "/signup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = SignupBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const ip = request.ip;

      if (inviteLockout.isLocked(ip)) {
        return reply.code(429).send({ error: "locked_out" });
      }
      if (!config.inviteCodes.includes(parsed.data.inviteCode)) {
        inviteLockout.recordFailure(ip);
        return reply.code(403).send({ error: "invalid_invite_code" });
      }
      inviteLockout.recordSuccess(ip);

      const existing = await prisma.user.findUnique({ where: { username: parsed.data.username } });
      if (existing) return reply.code(409).send({ error: "username_taken" });

      const token = generateToken();
      const user = await prisma.user.create({
        data: { username: parsed.data.username, tokenHash: hashToken(token) },
      });

      const body: z.infer<typeof SignupResponseSchema> & { token: string } = {
        userId: user.id,
        token,
      };
      return reply.code(201).send(body);
    },
  );

  app.post(
    "/devices",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = PublishDeviceRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      if (parsed.data.userId !== request.principal!.userId) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await registerDevice(prisma, { userId: parsed.data.userId, bundle: parsed.data.bundle });
      const body: z.infer<typeof PublishDeviceResponseSchema> = { ok: true };
      return reply.code(201).send(body);
    },
  );

  app.get("/users/:username/bundle", async (request, reply) => {
    const { username } = request.params as { username: string };
    const deviceIdRaw = (request.query as Record<string, string | undefined>).deviceId;
    const deviceId = deviceIdRaw !== undefined ? Number(deviceIdRaw) : undefined;
    if (deviceIdRaw !== undefined && (!Number.isInteger(deviceId) || deviceId! < 0)) {
      return reply.code(400).send({ error: "invalid_device_id" });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return reply.code(404).send({ error: "not_found" });

    const bundles = await fetchPreKeyBundles(prisma, { userId: user.id, deviceId });
    const body: z.infer<typeof FetchPreKeyBundleResponseSchema> = { bundles };
    return reply.code(200).send(body);
  });

  // Fetch prekey bundles directly by opaque userId (not username). Same authz
  // as the username route (any authenticated principal may fetch anyone's
  // public prekeys — standard Signal behavior). Enables a member that only
  // knows a co-member's userId (e.g. the AI agent, which learns members from
  // listMembers with no username) to establish a session. An unknown userId
  // simply has no active devices → `{ bundles: [] }` (200, not 404): the caller
  // distinguishes an empty result itself.
  app.get("/users/by-id/:userId/bundle", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const deviceIdRaw = (request.query as Record<string, string | undefined>).deviceId;
    const deviceId = deviceIdRaw !== undefined ? Number(deviceIdRaw) : undefined;
    if (deviceIdRaw !== undefined && (!Number.isInteger(deviceId) || deviceId! < 0)) {
      return reply.code(400).send({ error: "invalid_device_id" });
    }

    const bundles = await fetchPreKeyBundles(prisma, { userId, deviceId });
    const body: z.infer<typeof FetchPreKeyBundleResponseSchema> = { bundles };
    return reply.code(200).send(body);
  });

  app.post("/conversations", async (request, reply) => {
    const parsed = CreateConversationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (parsed.data.creatorUserId !== request.principal!.userId) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const conversationId = await createConversation(prisma, {
      creatorUserId: parsed.data.creatorUserId,
      memberUserIds: parsed.data.memberUserIds,
      aiMode: parsed.data.aiMode,
    });
    const body: z.infer<typeof CreateConversationResponseSchema> = { conversationId };
    return reply.code(201).send(body);
  });

  app.post("/conversations/:id/invite", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = InviteMemberRequestSchema.safeParse({ ...(request.body as object), conversationId: id });
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (!(await canManageMembership(prisma, id, request.principal!.userId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await inviteMember(prisma, id, parsed.data.userId);
    const body: z.infer<typeof MutateMemberResponseSchema> = { ok: true };
    return reply.code(200).send(body);
  });

  app.post("/conversations/:id/remove", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RemoveMemberRequestSchema.safeParse({ ...(request.body as object), conversationId: id });
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (!(await canManageMembership(prisma, id, request.principal!.userId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await removeMember(prisma, id, parsed.data.userId);
    const body: z.infer<typeof MutateMemberResponseSchema> = { ok: true };
    return reply.code(200).send(body);
  });

  app.patch("/conversations/:id/ai-mode", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SetAiModeRequestSchema.safeParse({ ...(request.body as object), conversationId: id });
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (!(await isActiveMember(prisma, id, request.principal!.userId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await setAiMode(prisma, id, parsed.data.enabled);
    const body: z.infer<typeof SetAiModeResponseSchema> = { ok: true };
    return reply.code(200).send(body);
  });

  app.get("/conversations/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await isActiveMember(prisma, id, request.principal!.userId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const members = await listMembers(prisma, id);
    const aiMode = await getAiMode(prisma, id);
    const body: z.infer<typeof ListMembersResponseSchema> = { members, aiMode };
    return reply.code(200).send(body);
  });

  // -------------------------------------------------------------------
  // WebSocket: per-device mailbox. Auth happens via the
  // Sec-WebSocket-Protocol header OR a first post-connect `auth` frame —
  // NEVER via a query-string token, which would end up in proxy/access
  // logs. A query-string `token` is rejected outright before upgrade.
  // -------------------------------------------------------------------
  // Registry of live device connections, so an envelope enqueued for a
  // currently-connected recipient is pushed immediately instead of waiting for
  // that recipient to reconnect and drain. Keyed by `${userId}:${deviceId}`.
  const liveSockets = new Map<string, LiveConn>();
  app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket, request) => {
      void handleWsConnection(scoped, prisma, socket, request, liveSockets);
    });
  });

  return app;

  // Small local helper so `await app.register(...)` reads top-to-bottom
  // without making buildApp itself async (route registration below still
  // needs to run synchronously relative to callers awaiting on the
  // returned promise from register calls made through Fastify's plugin
  // system, which resolves once encapsulated).
  function await_register(target: FastifyInstance, plugin: any, opts?: any) {
    target.register(plugin, opts);
  }
}

async function handleWsConnection(
  app: FastifyInstance,
  prisma: PrismaClient,
  socket: import("ws").WebSocket,
  request: FastifyRequest,
  liveSockets: Map<string, LiveConn>,
): Promise<void> {
  const url = new URL(request.url, "http://localhost");
  if (url.searchParams.has("token")) {
    socket.close(4001, "token must not be sent as a query parameter");
    return;
  }

  let userId: string | undefined;
  let deviceId: number | undefined;

  // Header-auth path: the client offers [WS_BEARER_SUBPROTOCOL, <token>]. The
  // token is the offered subprotocol that is NOT the sentinel. Resolving the
  // token hits the DB, so it runs as a promise the frame queue starts from
  // (below) rather than an `await` here — otherwise a `hello` frame arriving
  // during that DB round-trip would land before the message listener is
  // attached and be dropped (ws does not buffer for absent listeners).
  const protoHeader = request.headers["sec-websocket-protocol"];
  const offered = typeof protoHeader === "string" ? protoHeader.split(",").map((p) => p.trim()) : [];
  const headerToken = offered.find((p) => p && p !== WS_BEARER_SUBPROTOCOL);
  const headerAuth: Promise<void> = headerToken
    ? authenticateToken(prisma, headerToken).then((principal) => {
        if (!principal) {
          socket.close(4003, "invalid token");
          return;
        }
        userId = principal.userId;
      })
    : Promise.resolve();

  const authenticated = (): boolean => userId !== undefined && deviceId !== undefined;

  const onFirstFrames = async (raw: unknown): Promise<boolean> => {
    // Still need a deviceId (header path) or full auth (no header yet).
    const hello = WsHelloFrameSchema.safeParse(raw);
    if (hello.success && userId !== undefined) {
      deviceId = hello.data.deviceId;
      return true;
    }
    const auth = WsAuthFrameSchema.safeParse(raw);
    if (auth.success) {
      const principal = await authenticateToken(prisma, auth.data.token);
      if (!principal) {
        socket.close(4003, "invalid token");
        return false;
      }
      userId = principal.userId;
      deviceId = auth.data.deviceId;
      return true;
    }
    socket.close(4002, "expected auth/hello frame");
    return false;
  };

  // Live delivery state for THIS device. `draining` marks the window between
  // sending `ready` and finishing the post-`ready` mailbox drain: envelopes
  // pushed live from another connection during that window are buffered and
  // flushed *after* the drain, so a live push can never land ahead of an
  // older, still-draining envelope (which would deliver out of order). The
  // recipient dedups by msgId, so an envelope seen in both paths is harmless.
  let draining = false;
  let liveBuffer: StoredEnvelope[] = [];
  const liveConn: LiveConn = {
    deliver(env) {
      if (draining) {
        liveBuffer.push(env);
      } else if (socket.readyState === socket.OPEN) {
        socket.send(buildDeliverFrame(env));
      }
    },
  };

  const drainAndPush = async (): Promise<void> => {
    if (!authenticated()) return;
    const conversationIds = await listActiveConversationIds(prisma, userId!);
    const pending = await drainPendingEnvelopes(prisma, {
      recipientUserId: userId!,
      recipientDeviceId: deviceId!,
      conversationIds,
    });
    for (const envelope of pending) {
      if (socket.readyState === socket.OPEN) socket.send(buildDeliverFrame(envelope));
    }
  };

  // Register this connection as the live sink for its device once
  // authenticated, and clear it on close (only if we're still the current
  // sink for that key — a reconnect may have replaced us).
  const registerLive = (): void => {
    if (authenticated()) liveSockets.set(connKey(userId!, deviceId!), liveConn);
  };
  socket.on("close", () => {
    if (authenticated() && liveSockets.get(connKey(userId!, deviceId!)) === liveConn) {
      liveSockets.delete(connKey(userId!, deviceId!));
    }
  });

  // Process one connection's frames strictly in the order they arrived, and
  // only after header-token auth (if any) has resolved — so a `hello`/`send`
  // frame can never be handled before `userId` is set. Serializing also stops
  // concurrent handlers from racing on envelope insertion, which would let a
  // single sender's messages persist (and deliver) out of order.
  let processing: Promise<void> = headerAuth;
  let windowStart = Date.now();
  let framesInWindow = 0;
  socket.on("message", (data: Buffer) => {
    processing = processing.then(() => handleFrame(data)).catch(() => undefined);
  });

  function handleFrame(data: Buffer): Promise<void> {
    return (async () => {
      const now = Date.now();
      if (now - windowStart > RATE_WINDOW_MS) {
        windowStart = now;
        framesInWindow = 0;
      }
      if (++framesInWindow > MAX_FRAMES_PER_WINDOW) {
        socket.close(1008, "message rate exceeded");
        return;
      }
      if (data.byteLength > MAX_ENVELOPE_BYTES) {
        socket.close(1009, "envelope too large");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        socket.close(4000, "invalid json");
        return;
      }

      if (!authenticated()) {
        const ok = await onFirstFrames(parsed);
        if (ok && authenticated()) {
          socket.send(JSON.stringify({ type: "ready" }));
          draining = true;
          registerLive();
          await drainAndPush();
          // Flush envelopes that arrived live during the drain, then leave the
          // buffered window. This tail is synchronous (no await), so no live
          // push can slip between the flush and clearing `draining`.
          const buffered = liveBuffer;
          liveBuffer = [];
          draining = false;
          for (const env of buffered) {
            if (socket.readyState === socket.OPEN) socket.send(buildDeliverFrame(env));
          }
        }
        return;
      }

      const sendFrame = WsSendFrameSchema.safeParse(parsed);
      if (sendFrame.success) {
        const envelope = sendFrame.data.envelope;
        if (envelope.senderUserId !== userId || envelope.senderDeviceId !== deviceId) {
          socket.close(4003, "sender mismatch");
          return;
        }
        if (!(await isActiveMember(prisma, envelope.conversationId, userId!))) {
          socket.close(4003, "not an active member");
          return;
        }
        // The send frame is already addressed to exactly one recipient
        // (the client fans a group message out into one frame per recipient
        // device), so recipientUserId comes from the frame, not the sender.
        const stored = await enqueueEnvelope(prisma, {
          conversationId: envelope.conversationId,
          recipientUserId: sendFrame.data.recipientUserId,
          recipientDeviceId: envelope.recipientDeviceId,
          senderUserId: envelope.senderUserId,
          senderDeviceId: envelope.senderDeviceId,
          type: envelope.type,
          ciphertext: envelope.ciphertext,
        });
        // Live-push only if the recipient device holds an open connection AND
        // is still an active member of this conversation. The membership check
        // mirrors the drain's `listActiveConversationIds` filter — without it a
        // removed member with a live socket would receive envelopes the drain
        // refuses, breaking the removal guarantee. Offline or removed
        // recipients fall through to the persisted row (gated at drain time),
        // so delivery still recovers for the offline case.
        const target = liveSockets.get(connKey(sendFrame.data.recipientUserId, envelope.recipientDeviceId));
        if (target && (await isActiveMember(prisma, envelope.conversationId, sendFrame.data.recipientUserId))) {
          target.deliver(stored);
        }
        return;
      }

      const frame = WsFrameSchema.safeParse(parsed);
      if (!frame.success) {
        socket.close(4000, "malformed frame");
        return;
      }
      if (frame.data.type === "ack") {
        await ackEnvelopes(prisma, {
          recipientUserId: userId!,
          recipientDeviceId: deviceId!,
          conversationId: frame.data.conversationId,
          seq: BigInt(frame.data.seq),
        });
        return;
      }
      if (frame.data.type === "subscribe") {
        if (!(await isActiveMember(prisma, frame.data.conversationId, userId!))) {
          socket.close(4003, "not an active member");
          return;
        }
        await drainAndPush();
      }
    })();
  }

  app.log?.debug?.({ msg: "ws connected" });
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: import("./auth.js").AuthenticatedPrincipal;
  }
}

export function start(config: RelayConfig = loadConfig()): Promise<FastifyInstance> {
  const prisma = createPrismaClient(config.databaseUrl);
  const app = buildApp(config, prisma);
  return app.listen({ port: config.port, host: "0.0.0.0" }).then(() => app);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
