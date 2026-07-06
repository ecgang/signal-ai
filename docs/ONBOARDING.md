# Onboarding — for a first-time user (start here, Dustin)

You've been invited to a signal-ai chat. This gets you from nothing to talking in
the group in a few minutes. You do **not** need to understand the crypto to use
it — but if you want to, the honest threat model is in [`SECURITY.md`](../SECURITY.md).

You need two things from whoever invited you:

1. **An invite code** — the relay is invite-gated (closed alpha). It's a short
   string like `LETMEIN`. Ask the person who invited you.
2. **A username to pick** — anything unclaimed, e.g. `dustin`. You'll use it to
   log back in later.

Pick **one** of the two paths below. The Docker path needs nothing but Docker;
the dev path needs Node.

---

## Path A — Docker (nothing to install but Docker)

If you have [Docker](https://docs.docker.com/get-docker/) — and nothing else —
this is the whole thing. No Node, no pnpm, no build tools.

```sh
git clone https://github.com/ecgang/signal-ai.git
cd signal-ai
docker build -f apps/cli/Dockerfile -t signalai .        # one-time, ~2–3 min
```

Then sign up (the `-it` is required — it's what gives you the full-screen UI;
the named volume `signalai-state` keeps you logged in between runs):

```sh
docker run -it -v signalai-state:/data signalai signup --invite <CODE> --username dustin
```

Next time, just log back in — same volume, no invite code needed:

```sh
docker run -it -v signalai-state:/data signalai login --username dustin
```

The image talks to the hosted alpha relay by default, so there's no server for
you to run.

---

## Path B — Dev flow (Node 20+, one command)

If you have [Node 20+](https://nodejs.org), a single script does the checks,
installs the workspace, and drops you into the chat:

```sh
git clone https://github.com/ecgang/signal-ai.git
cd signal-ai
./scripts/onboard.sh signup --invite <CODE> --username dustin
```

Returning later:

```sh
./scripts/onboard.sh login --username dustin
```

(That script is just a friendly wrapper around
`pnpm --filter @signalai/cli dev -- …` — the same command the main README uses.)

---

## Once you're in

You land in an interactive client. A few things worth knowing:

- **You don't need to create the group.** Once the person who invited you sends
  their first message, **your terminal auto-joins that conversation** — you can
  reply immediately. No `/new`, no accepting an invite.
- `signup` vs `login`: **`signup` once** (with the invite code), **`login`
  every time after** (just your username). Your identity lives in the state
  volume/dir, not on the server.
- Talk to the AI member by **@mentioning** it: `@ai what should we do Saturday?`
  By default it only replies when mentioned. (Whoever runs the chat can flip it
  to reply-to-everything with `/ai active`.)
- **`/verify <username>`** prints a person's safety fingerprint. Compare it with
  them over a channel you already trust (a phone call, in person) — then a `✓`
  shows next to them in `/members` until their key changes. This is how you know
  the relay isn't impersonating anyone.
- `/members` shows who's in the room; `/help` lists every command; `/quit`
  exits (your session is saved).

## One honesty note about the AI member

The AI is a **member of the conversation**, not the server — it decrypts
messages the same way you do, because it was invited in. When it's run against a
**remote** language-model provider, the text of a message it's replying to is
sent to that provider to generate the reply. Running the model **locally** keeps
that text on the operator's machine. Inviting `@ai` is consent to whichever the
operator has configured. The full trade-off is in
[`docs/CONFIDENTIAL-INFERENCE.md`](./CONFIDENTIAL-INFERENCE.md) and
[`SECURITY.md`](../SECURITY.md).

## If something breaks

- **"invalid invite code"** — codes are single-relay and can be one-time; ask
  for a fresh one.
- **The UI looks garbled / doesn't go full-screen** — you dropped into the
  plain fallback shell because there was no TTY. With Docker, make sure you
  passed `-it`. It still works, it's just line-by-line.
- **"username already taken"** — pick another; usernames are first-come on the
  relay.
