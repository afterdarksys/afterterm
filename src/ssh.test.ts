import assert from "node:assert/strict";
import { it } from "node:test";
import { sshDestination, sshHostConfig, sshPort, sshSessionDestination } from "./ssh.ts";
const available = { client: "/usr/bin/ssh", kex: ["diffie-hellman-group14-sha1"], host_key: ["ssh-rsa"], cipher: [], mac: [] };
it("SSH exceptions append only supported algorithms for one exact host", () => {
  const text = sshHostConfig("switch.example.net", { host_key: "ssh-rsa" }, available);
  assert.equal(text, "Host switch.example.net\n    HostKeyAlgorithms +ssh-rsa\n");
  assert.ok(!text.includes("StrictHostKeyChecking"));
  for (const host of ["*", "foo bar", "host\nProxyCommand evil", "!host"]) assert.throws(() => sshHostConfig(host, { host_key: "ssh-rsa" }, available));
  assert.throws(() => sshHostConfig("switch", { host_key: "ssh-dss" }, available), /Unsupported/);
});

it("SSH connect accepts a host, an optional user, and an optional port", () => {
  assert.equal(sshDestination({ host: "web1", user: null, port: null }), "web1");
  assert.equal(sshDestination({ host: " web1 ", user: " alice ", port: 2222 }), "alice@web1");
  assert.equal(sshDestination({ host: "[2001:db8::1]", user: "alice", port: null }), "alice@[2001:db8::1]");
  assert.equal(sshDestination({ host: "192.0.2.10", user: "", port: 22 }), "192.0.2.10");
  assert.equal(sshPort("22"), 22);
  assert.equal(sshPort(""), null);
  assert.equal(sshPort("0"), null);
  assert.equal(sshPort("65536"), null);
  assert.equal(sshPort("22abc"), null);
  for (const host of ["web1 -o ProxyCommand=id", "web1; echo nope", "fe80::1", "-web", "user@host", "*", ""]) {
    assert.equal(sshDestination({ host, user: null, port: null }), null, host);
  }
  assert.equal(sshDestination({ host: "web1", user: "-o", port: null }), null);
  assert.equal(sshDestination({ host: "web1", user: null, port: 0 }), null);
  assert.equal(sshSessionDestination("/usr/bin/ssh", ["-t", "-p", "2222", "--", "alice@web1"]), "alice@web1");
  assert.equal(sshSessionDestination("/usr/local/bin/sahconnect", ["connect", "web1"]), null);
  assert.equal(sshSessionDestination("/usr/bin/ssh", ["-t", "web1"]), null);
});
