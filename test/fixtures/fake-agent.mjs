#!/usr/bin/env node
// A stand-in coding agent CLI for tests. It never touches a real provider or
// network; it only echoes controlled JSON events based on FAKE_AGENT_MODE so
// job-supervisor and adapter tests exercise real process lifecycle behavior.

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const mode = process.env.FAKE_AGENT_MODE ?? "success";
  const stdin = await readStdin();

  switch (mode) {
    case "success": {
      emit({ type: "session", session_id: "sess-fake-1" });
      emit({ type: "progress", text: `echo:${stdin.trim()}` });
      emit({ type: "final", text: "done" });
      process.exit(0);
      break;
    }
    case "failure": {
      emit({ type: "session", session_id: "sess-fake-2" });
      process.stderr.write("boom\n");
      process.exit(1);
      break;
    }
    case "malformed": {
      process.stdout.write("not-json-line\n");
      emit({ type: "final", text: "recovered" });
      process.exit(0);
      break;
    }
    case "hang": {
      // Ignores SIGTERM so tests can prove SIGKILL escalation actually happens. An unresolved
      // promise alone would not keep the event loop alive once stdin closes, so hold it open
      // with a live interval instead.
      process.on("SIGTERM", () => {});
      emit({ type: "session", session_id: "sess-fake-hang" });
      setInterval(() => {}, 1000);
      break;
    }
    case "echo-argv": {
      emit({ type: "final", text: JSON.stringify(process.argv.slice(2)) });
      process.exit(0);
      break;
    }
    default: {
      process.stderr.write(`unknown FAKE_AGENT_MODE: ${mode}\n`);
      process.exit(2);
    }
  }
}

main();
