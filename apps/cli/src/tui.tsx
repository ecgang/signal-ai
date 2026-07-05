/**
 * Ink (React-for-terminals) full-screen TUI over {@link CliApp}. Like `main.ts`'s
 * readline path it contains NO conversation logic — it renders {@link RenderedLine}s
 * from the app and forwards a submitted line to `app.handleInput`. The single UX
 * win over readline: input lives in its own persistent box, so a sent message is
 * painted exactly ONCE (the app's formatted echo) — no terminal echo double-print.
 *
 * Only mounted when stdout/stdin are TTYs (Ink requires a TTY); `main.ts` falls
 * back to the readline loop otherwise (tests, pipes, CI).
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { CliApp, ConversationView, SidebarMember } from "./app.js";
import type { CliConfig } from "./config.js";
import type { CliSession } from "./session.js";
import type { RenderedLine, RenderKind } from "./render.js";

/** Ink colour per line-kind (reuses render.ts kinds; unknown kinds fall through to default). */
function colorFor(kind: RenderKind): string | undefined {
  switch (kind) {
    case "message":
      return undefined; // default terminal foreground — the main content
    case "info":
      return "cyan";
    case "system":
      return "gray";
    case "warn":
      return "yellow";
    case "error":
      return "red";
    case "connection":
      return "magenta";
    default:
      return undefined;
  }
}

/** One sidebar member row: `● name  (role)` + fingerprint + verified/ai annotations. */
function MemberRow({ m }: { m: SidebarMember }): ReactElement {
  const marker = m.isAi ? (m.aiActive ? "●" : "○") : "•";
  const markerColor = m.isAi ? (m.aiActive ? "green" : "gray") : "blueBright";
  const shortFp = m.fingerprint.split(" ").slice(0, 2).join(" ");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={markerColor}>{marker} </Text>
        <Text bold>{m.name}</Text>
        {m.isSelf ? <Text color="gray"> (you)</Text> : null}
        {m.verified ? <Text color="green"> ✓</Text> : null}
      </Box>
      <Text color="gray">
        {"  "}
        {m.role}
        {m.isAi ? ` · AI ${m.aiActive ? "active" : "passive"}` : ""}
      </Text>
      <Text color="gray">
        {"  "}
        {shortFp}
      </Text>
    </Box>
  );
}

/** The right-hand member sidebar; shows a placeholder until a conversation is active. */
function Sidebar({ view, width }: { view: ConversationView | undefined; width: number }): ReactElement {
  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        Members{view ? ` (${view.members.length})` : ""}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {view === undefined ? (
          <Text color="gray">no active conversation</Text>
        ) : view.members.length === 0 ? (
          <Text color="gray">(none yet)</Text>
        ) : (
          view.members.map((m) => <MemberRow key={m.userId} m={m} />)
        )}
      </Box>
    </Box>
  );
}

interface TuiProps {
  app: CliApp;
  session: CliSession;
  config: CliConfig;
}

function Tui({ app, session }: TuiProps): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [lines, setLines] = useState<RenderedLine[]>([]);
  const [view, setView] = useState<ConversationView | undefined>(undefined);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState<{ rows: number; cols: number }>({
    rows: stdout.rows ?? 24,
    cols: stdout.columns ?? 80,
  });

  // Refresh the header/sidebar projection from the app (async: may hit the relay).
  const refreshView = useCallback((): void => {
    void app
      .conversationView()
      .then((v) => setView(v))
      .catch(() => undefined);
  }, [app]);

  // Wire the app's async output sink into React state; seed the scrollback with
  // any lines already emitted before mount, then refresh the sidebar.
  useEffect(() => {
    setLines([...app.emittedLines]);
    app.setSink((incoming) => {
      setLines((prev) => [...prev, ...incoming]);
      // Membership / mode / connection changes arrive via the sink — re-project.
      refreshView();
    });
    refreshView();
    return () => {
      // Detach so a late async emit can't setState after unmount.
      app.setSink(() => undefined);
    };
  }, [app, refreshView]);

  // Track terminal resize so the scrollback window and layout stay correct.
  useEffect(() => {
    const onResize = (): void => {
      setSize({ rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Ctrl-C exits cleanly (mirrors readline SIGINT) without going through /quit.
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      void quit();
    }
  });

  const quit = useCallback(async (): Promise<void> => {
    await session.close().catch(() => undefined);
    exit();
    // Give Ink a tick to unmount before the process ends.
    setTimeout(() => process.exit(0), 0);
  }, [session, exit]);

  const submit = useCallback(
    (raw: string): void => {
      const trimmed = raw.trim();
      setInput("");
      if (trimmed.length === 0) return;
      setBusy(true);
      void (async () => {
        try {
          const out = await app.handleInput(trimmed);
          if (out.length > 0) setLines((prev) => [...prev, ...out]);
          refreshView();
        } finally {
          setBusy(false);
        }
        if (trimmed === "/quit") await quit();
      })();
    },
    [app, refreshView, quit],
  );

  const sidebarWidth = Math.max(24, Math.min(36, Math.floor(size.cols * 0.32)));
  // Reserve rows for header (1) + input (1) + pane border (2) + breathing room.
  const paneRows = Math.max(3, size.rows - 5);
  const visible = lines.slice(-paneRows);

  const memberCount = view?.members.length ?? 0;
  const headerLabel = view?.label ?? "(no conversation)";

  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Box paddingX={1} justifyContent="space-between">
        <Text>
          <Text bold color="cyan">
            {headerLabel}
          </Text>
          <Text color="gray">
            {"  "}
            {memberCount} member{memberCount === 1 ? "" : "s"}
          </Text>
        </Text>
        <Text color="gray">signalai</Text>
      </Box>

      <Box flexGrow={1} flexDirection="row">
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          overflow="hidden"
        >
          {visible.length === 0 ? (
            <Text color="gray">connected. type /help for commands, /quit to exit.</Text>
          ) : (
            visible.map((l, i) => (
              <Text key={`${l.ts}-${i}`} color={colorFor(l.kind)} wrap="truncate-end">
                {l.text}
              </Text>
            ))
          )}
        </Box>
        <Sidebar view={view} width={sidebarWidth} />
      </Box>

      <Box paddingX={1}>
        <Text color={busy ? "yellow" : "green"}>{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="type a message or /command" />
      </Box>
    </Box>
  );
}

/**
 * Mounts the Ink TUI and resolves when it unmounts (via `/quit`, Ctrl-C, or the
 * app calling `exit`). `main.ts` calls this only when stdout/stdin are TTYs.
 */
export async function runTui(session: CliSession, config: CliConfig, app: CliApp): Promise<void> {
  // Deferred import keeps `ink`/`react` off the readline (non-TTY) code path.
  const { render } = await import("ink");
  const instance = render(<Tui app={app} session={session} config={config} />);
  await instance.waitUntilExit();
}
