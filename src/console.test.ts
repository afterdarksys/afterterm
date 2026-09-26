import assert from "node:assert/strict";
import { it } from "node:test";
import { consoleInput, DEFAULT_CONSOLE, reconnectPath } from "./console.ts";
it("normalizes pasted line endings once and keeps escape/control bytes intact", () => {
  assert.equal(consoleInput("a\r\nb\nc\r\x1b[A\x03", { ...DEFAULT_CONSOLE, lineEnding: "crlf" }), "a\r\nb\r\nc\r\n\x1b[A\x03");
  assert.equal(consoleInput("\x7f\r", { ...DEFAULT_CONSOLE, backspace: "bs", lineEnding: "lf" }), "\b\n");
});

it("reconnect follows USB identity and refuses ambiguous adapters", () => {
  const config = { ...DEFAULT_CONSOLE, path: "/dev/old", identity: "usb:1:2:serial", autoReconnect: true };
  const port = { path: "/dev/new", identity: config.identity, label: "USB" };
  assert.equal(reconnectPath(config, [port]), "/dev/new");
  assert.throws(() => reconnectPath(config, []), /Waiting/);
  assert.throws(() => reconnectPath(config, [port, { ...port, path: "/dev/other" }]), /Multiple/);
  assert.throws(() => reconnectPath({ ...config, identity: undefined }, [port]), /requires/);
});
