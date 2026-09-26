import assert from "node:assert/strict";
import { it } from "node:test";
import { sshHostConfig } from "./ssh.ts";
const available = { client: "/usr/bin/ssh", kex: ["diffie-hellman-group14-sha1"], host_key: ["ssh-rsa"], cipher: [], mac: [] };
it("SSH exceptions append only supported algorithms for one exact host", () => {
  const text = sshHostConfig("switch.example.net", { host_key: "ssh-rsa" }, available);
  assert.equal(text, "Host switch.example.net\n    HostKeyAlgorithms +ssh-rsa\n");
  assert.ok(!text.includes("StrictHostKeyChecking"));
  for (const host of ["*", "foo bar", "host\nProxyCommand evil", "!host"]) assert.throws(() => sshHostConfig(host, { host_key: "ssh-rsa" }, available));
  assert.throws(() => sshHostConfig("switch", { host_key: "ssh-dss" }, available), /Unsupported/);
});
