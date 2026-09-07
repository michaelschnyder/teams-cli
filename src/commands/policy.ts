import { ResultCommand as Command } from "../command-runner.js";
import {
  requireRuntimeIdentity
} from "../config.js";
import { inspectPolicyStore, startPolicyEditor } from "../policy-editor.js";
import {
  activatePolicy,
  canonicalSubjectPath,
  initializePolicy,
  loadPolicyStore,
  policyProtectionInstruction,
  policyStatusWarnings,
  requireMessageRead,
  requireMessageSend,
  requireRawTokenExport,
  resolvePolicies,
  resolvePolicyByName
} from "../policy.js";
import { CLI_VERSION } from "../version.js";

import { type CommandServices } from "../command-services.js";
import { collect, selectedTarget, type TargetOptions } from "../inputs.js";
import { commandResult } from "../output.js";
import { policyWarningReporter } from "../runtime.js";
import { notice } from "../terminal.js";

export function registerPolicyCommand(program: Command, services: CommandServices): void {
  const { paths, subjectPath } = services;
  const policy = program.command("policy").description("Manage subject-based safety policies");
  policy.command("init").description("Create a restrictive inactive policy")
    .argument("<name>", "Policy name")
    .option("--subject <absolute-path-glob>", "Subject path glob; repeat for multiple paths", collect, [])
    .action(async (name: string, policyOptions: { subject: string[]; }) => {
      const context = await services.context();
      const record = await initializePolicy(paths, name, context, policyOptions.subject, subjectPath);

      notice("Warning: The policy is in audit mode and is not enforcing restrictions.\n");
      return commandResult("ack", { action: "Created inactive policy", name: record.policy.name, file: record.file });
    });
  policy.command("list").description("List all policies")
    .action(async () => {
      const records = await loadPolicyStore(paths);
      return commandResult("list", { title: "Policies", items: records.map(record => ({ name: record.policy.name, active: record.policy.active, file: record.file })) });
    });
  policy.command("show").description("Show one named policy or policies applying to a path")
    .argument("[name]", "Policy name")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (name: string | undefined, policyOptions: { path?: string; }) => {
      const reportWarnings = policyWarningReporter();
      if (name) {
        const record = await resolvePolicyByName(paths, name);
        reportWarnings(record.permissionWarnings);
        return commandResult("record", { file: record.file, policy: record.policy });
      }
      const resolved = await resolvePolicies(paths, policyOptions.path ?? subjectPath);
      reportWarnings(policyStatusWarnings(resolved));
      return commandResult("record", { subjectPath: resolved.subjectPath, policies: resolved.policies.map(record => ({ file: record.file, policy: record.policy })) });
    });
  const policyCheck = policy.command("check").description("Check an effective policy decision");
  policyCheck.command("send").description("Check a chat or channel send")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (checkOptions: TargetOptions & { path?: string; }) => {
      const context = await services.context();
      const identity = requireRuntimeIdentity(context);
      const resolved = await resolvePolicies(paths, checkOptions.path ?? subjectPath);
      const reportWarnings = policyWarningReporter();
      reportWarnings(policyStatusWarnings(resolved));
      reportWarnings(requireMessageSend(resolved, identity, selectedTarget(checkOptions)));
      return commandResult("record", { allowed: true, activePolicies: resolved.policies.filter(record => record.policy.active).length, subjectPath: resolved.subjectPath });
    });
  policyCheck.command("read").description("Check a chat or channel message read")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (checkOptions: TargetOptions & { path?: string; }) => {
      const context = await services.context();
      const identity = requireRuntimeIdentity(context);
      const resolved = await resolvePolicies(paths, checkOptions.path ?? subjectPath);
      const reportWarnings = policyWarningReporter();
      reportWarnings(policyStatusWarnings(resolved));
      reportWarnings(requireMessageRead(resolved, identity, selectedTarget(checkOptions)));
      return commandResult("record", { allowed: true, activePolicies: resolved.policies.filter(record => record.policy.active).length, subjectPath: resolved.subjectPath });
    });
  policyCheck.command("raw-tokens").description("Check raw bearer-token export")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (checkOptions: { path?: string; }) => {
      const context = await services.context();
      const identity = requireRuntimeIdentity(context);
      const resolved = await resolvePolicies(paths, checkOptions.path ?? subjectPath);
      const reportWarnings = policyWarningReporter();
      reportWarnings(policyStatusWarnings(resolved));
      reportWarnings(requireRawTokenExport(resolved, identity));
      return commandResult("record", { allowed: true, activePolicies: resolved.policies.filter(record => record.policy.active).length, subjectPath: resolved.subjectPath });
    });
  policy.command("activate").description("Activate one policy for enforcement")
    .argument("<name>", "Policy name")
    .action(async (name: string) => {
      const activated = await activatePolicy(await resolvePolicyByName(paths, name));

      const instruction = policyProtectionInstruction(activated.file);
      if (instruction) {
        notice(`Warning: Recommended additional protection: ${instruction}\n`);
      } else {
        notice("Warning: Protect the active policy with an administrator-managed read-only ACL.\n");
      }
      return commandResult("ack", { action: "Activated policy", name: activated.policy.name, file: activated.file });
    });
  policy.command("edit").description("Open the temporary browser policy editor")
    .argument("[name]", "Policy name to select")
    .option("--port <number>", "Local editor port", (value: string) => {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
      return port;
    })
    .option("--open", "Open the editor in the system browser")
    .action(async (name: string | undefined, editorOptions: { port?: number; open?: boolean; }) => {
      const context = await services.context();
      const result = await startPolicyEditor({
        paths,
        context,
        ...(subjectPath ? { subjectStart: subjectPath } : {}),
        ...(name ? { requestedName: name } : {}),
        ...(editorOptions.port ? { port: editorOptions.port } : {}),
        open: editorOptions.open ?? false,
        version: CLI_VERSION,
      });
      const canonical = await canonicalSubjectPath(subjectPath);
      const records = await inspectPolicyStore(paths, canonical);
      const active = records.filter((record) => record.applies && record.policy?.active).length;
      return commandResult("ack", { action: "Policy editor closed", reason: result.reason, activePolicies: active, subjectPath: canonical });
    });

}
