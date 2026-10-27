import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

// Exercise the real stdio proxy against a deterministic native peer. No Copilot
// process, authentication, settings changes or model requests are needed.
test("proxy preserves negotiation, native metadata, permissions, load and close lifecycle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "copilot-proxy-"));
  const logPath = join(root, "requests.jsonl");
  const peerPath = join(root, "peer.mjs");
  mkdirSync(join(root, ".github", "skills", "disabled-skill"), { recursive: true });
  writeFileSync(join(root, ".github", "skills", "disabled-skill", "SKILL.md"),
    "---\nname: disabled-skill\ndescription: must not appear\n---\n");
  writeFileSync(peerPath, `
    import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    const update = (sessionId, update) => send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update}});
    const configOptions = [{id:"mode",category:"mode",type:"select",currentValue:"native#agent",options:[{value:"native#agent",name:"Agent"},{value:"native#plan",name:"Plan"}]},
      {id:"model",category:"model",type:"select",currentValue:"allowed",options:[{value:"allowed",name:"Allowed"}]}];
    const pending = new Map();
    const stateRoot = ${JSON.stringify(join(root, "state"))};
    createInterface({input:process.stdin}).on("line", (line) => {
      const m=JSON.parse(line);
      appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(m)+"\\n");
      const reply = (result) => send({jsonrpc:"2.0",id:m.id,result});
      if (!m.method) {
        const original = pending.get(m.id);
        if (original) send({jsonrpc:"2.0",id:original.id,result:{stopReason:"end_turn",permission:m.result}});
        return;
      }
      if (m.method==="initialize") reply({protocolVersion:1,agentInfo:{name:"fake",version:"1.0.93",_meta:{received:m.params}},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},close:{}}}});
      else if (m.method==="session/new" || m.method==="session/load") {
        const sessionId=m.params.sessionId || "new-session";
        mkdirSync(stateRoot+"/"+sessionId,{recursive:true});
        writeFileSync(stateRoot+"/"+sessionId+"/events.jsonl",JSON.stringify({type:"model.call_start",data:{model:"old-history-model"}})+"\\n");
        update(sessionId,{sessionUpdate:"available_commands_update",availableCommands:[{name:"context",description:"Native context"},{name:"enabled-skill",description:"Enabled skill"},{name:"autopilot",description:"Native autopilot"}]});
        if (m.method==="session/load") update(sessionId,{sessionUpdate:"user_message_chunk",content:{type:"text",text:"history"}});
        reply({...(m.method==="session/new" ? {sessionId} : {}),configOptions});
      }
      else if (m.method==="session/set_config_option") reply({configOptions});
      else if (m.method==="session/prompt") {
        if (m.params.prompt[0].text==="approve") {
          pending.set("permission",m);
          send({jsonrpc:"2.0",id:"permission",method:"session/request_permission",params:{sessionId:m.params.sessionId,options:[{optionId:"once",kind:"allow_once",name:"Allow"}],toolCall:{toolCallId:"tool",title:"Read"}}});
        } else {
          if (m.params.prompt[0].text.includes("gpt-5.6-luna")) {
            update(m.params.sessionId,{sessionUpdate:"tool_call",toolCallId:"skill",toolName:"skill",rawInput:{skill:"test-runner"}});
            appendFileSync(stateRoot+"/"+m.params.sessionId+"/events.jsonl",JSON.stringify({type:"model.call_start",data:{model:"different-recorded-model"}})+"\\n");
          }
          update(m.params.sessionId,{sessionUpdate:"usage_update",used:7,size:100});
          reply({stopReason:"end_turn",usage:{inputTokens:7,outputTokens:0}});
        }
      }
      else if (m.id!==undefined) reply({});
    });
  `);
  const child = spawn(process.execPath, ["bin/copilot-acp-adapter.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, COPILOT_COMMAND: process.execPath,
      COPILOT_GITHUB_TOKEN: "fake-test-token",
      COPILOT_SESSION_STATE_PATH: join(root, "state"),
      COPILOT_ACP_ARGS: JSON.stringify([peerPath]), COPILOT_ACP_TRANSPORT: "stdio", COPILOT_CWD: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); rmSync(root, { recursive: true, force: true }); });
  const messages = [];
  const pending = new Map();
  let nextId = 0;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 5000);
    pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    send({ id, method, params });
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.method === "session/request_permission") {
      send({ id: message.id, result: { outcome: { outcome: "selected", optionId: "once" } } });
    } else if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const initParams = { protocolVersion: 1, clientInfo: { name: "emacs", version: "test" },
    clientCapabilities: { fs: { readTextFile: true }, terminal: true, _meta: { rawEvents: true } }, _meta: { extension: "preserved" } };
  const initialized = await request("initialize", initParams);
  assert.deepEqual(initialized.agentInfo._meta.nativeAgentInfo._meta.received, initParams);
  assert.equal(initialized.agentCapabilities.sessionCapabilities.additionalDirectories, undefined);
  const session = await request("session/new", { cwd: root, mcpServers: [] });
  assert.deepEqual(session.configOptions.map((o) => o.id), ["mode", "model"]);
  assert.deepEqual(session.models.availableModels.map((o) => o.modelId), ["allowed"]);
  const { commands } = await request("_commands/list", { sessionId: session.sessionId });
  assert.equal(commands.some((o) => o.name === "enabled-skill"), true);
  for (const name of ["disabled-skill", "resume", "tasks", "limits"]) assert.equal(commands.some((o) => o.name === name), false, name);
  assert.equal((await request("session/prompt", { sessionId: session.sessionId, text: "/resume" })).stopReason, "error");
  const result = await request("session/prompt", { sessionId: session.sessionId, text: "/context" });
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 0 });
  assert.equal(messages.some((m) => m.params?.update?.sessionUpdate === "usage_update"), true);
  const modelPrompt = [{ type: "text", text: "run the tests with gpt-5.6-luna" }, { type: "text", text: "with the test-runner skill" }];
  await request("session/prompt", { sessionId: session.sessionId, prompt: modelPrompt });
  const modelReport = messages.find((m) => m.params?.update?._meta?.activity === "model-request-report")?.params.update;
  assert.equal(modelReport.sessionUpdate, "agent_message_chunk");
  assert.deepEqual(modelReport._meta.recordedModels, ["different-recorded-model"]);
  assert.equal(modelReport._meta.requestedSessionModel, "allowed");
  assert.deepEqual(modelReport._meta.skills, ["test-runner"]);
  assert.deepEqual(modelReport._meta.delegations, []);
  assert.equal((await request("session/prompt", { sessionId: session.sessionId, text: "approve" })).permission.outcome.optionId, "once");
  await request("session/set_config_option", { sessionId: session.sessionId, configId: "mode", value: "native#plan" });
  await request("session/prompt", { sessionId: session.sessionId, text: "/autopilot" });
  const loaded = await request("session/load", { sessionId: "loaded", cwd: root, mcpServers: [] });
  assert.equal(loaded.sessionId, "loaded");
  assert.equal(messages.filter((m) => m.params?.update?.content?.text === "history").length, 1);
  await request("session/prompt", { sessionId: "loaded", text: "/exit" });
  const afterClose = await request("_commands/list", { sessionId: "loaded" });
  assert.equal(afterClose.commands.some((o) => o.name === "enabled-skill"), false);
  await request("closeSession", { sessionId: session.sessionId });
  // Restart after a credential change must negotiate the exact same capabilities.
  await request("authenticate", { methodId: "api-key" });
  await request("authenticate", { methodId: "copilot-login" });
  const requests = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.filter((m) => m.method === "initialize").map((m) => m.params), [initParams, initParams]);
  assert.equal(requests.some((m) => m.method === "session/set_mode"), false);
  assert.equal(requests.some((m) => m.method === "session/prompt" && m.params.prompt[0].text === "/resume"), false);
  assert.equal(requests.some((m) => m.method === "session/prompt" && m.params.prompt[0].text === "/autopilot"), true);
  assert.deepEqual(requests.find((m) => m.method === "session/prompt" && m.params.prompt[0].text.includes("gpt-5.6-luna")).params.prompt, modelPrompt);
  assert.deepEqual(requests.filter((m) => m.method === "session/close").map((m) => m.params.sessionId), ["loaded", "new-session"]);
  assert.equal(requests.some((m) => m.method === "authenticate" && m.params.methodId === "copilot-login"), true);
});
