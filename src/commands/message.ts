import { randomInt, randomUUID } from "node:crypto";
import type { DataTokenTarget } from "../auth.js";
import { ResultCommand as Command } from "../command-runner.js";
import {
  policyStatusWarnings,
  requireMessageRead,
  requireMessageSend,
  resolvePolicies,
  type MessageTarget
} from "../policy.js";
import {
  getMessage,
  listMessages,
  resolveDirectMessageTarget,
  sendMessage
} from "../teams-client.js";
import { clearStatus } from "../terminal.js";

import { type CommandServices } from "../command-services.js";
import { messageBody, parsePageSize, resolvePolicyMessageTarget, selectedSendTarget, selectedTarget, type SendTargetOptions, type TargetOptions } from "../inputs.js";
import { commandResult } from "../output.js";
import { withStatus } from "../terminal.js";

export function registerMessageCommand(program: Command, services: CommandServices): void {
  const { paths, subjectPath, interactiveAuth } = services;
  const message = program.command("message").description("Read and send Microsoft Teams messages");
  message.command("list").description("List a server-provided page of messages")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--page-size <number>", "Server page size from 1 to 200", parsePageSize)
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page")
    .option("--json", "Output stable JSON")
    .action(async (options: TargetOptions & {
      pageSize?: number;
      cursor?: string;
      json?: boolean;
    }) => {
      if (options.cursor && options.pageSize !== undefined) {
        throw new Error("--cursor cannot be combined with --page-size");
      }
      const target = selectedTarget(options);
      const result = await withStatus("Fetching messages…", () =>
        services.data(["chat", "skype"], async (session, runtime) => {
          const policyTarget = resolvePolicyMessageTarget(runtime.identity, target);
          return listMessages(session, target, options, undefined, async () => {
            const current = await resolvePolicies(paths, subjectPath);
            runtime.reportPolicyWarnings(policyStatusWarnings(current));
            runtime.reportPolicyWarnings(requireMessageRead(current, runtime.identity, policyTarget));
          });
        }, interactiveAuth));
      return commandResult("messages", result);
    });
  message.command("get").description("Get one message by ID")
    .argument("<message-id>", "Teams message ID")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--json", "Output stable JSON")
    .action(async (messageId: string, options: TargetOptions & { json?: boolean; }) => {
      const target = selectedTarget(options);
      const result = await withStatus("Fetching message…", () =>
        services.data(["chat", "skype"], async (session, runtime) => {
          const policyTarget = resolvePolicyMessageTarget(runtime.identity, target);
          return getMessage(session, target, messageId, undefined, async () => {
            const current = await resolvePolicies(paths, subjectPath);
            runtime.reportPolicyWarnings(policyStatusWarnings(current));
            runtime.reportPolicyWarnings(requireMessageRead(current, runtime.identity, policyTarget));
          });
        }, interactiveAuth));
      return commandResult("message", result);
    });
  message.command("send").description("Send one policy-authorized plain-text message")
    .option("--person <email-or-id>", "Recipient email address or Microsoft user object ID")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--body <text>", "Plain-text message body; otherwise read stdin")
    .option("--json", "Output stable JSON")
    .action(async (options: SendTargetOptions & { body?: string; json?: boolean; }) => {
      const selection = selectedSendTarget(options);
      const body = await messageBody(options.body);
      const requestId = `${Date.now()}${randomInt(1_000_000).toString().padStart(6, "0")}`;
      const sessionId = randomUUID();
      let externalRecipientConfirmed = false;
      const result = await withStatus("Sending message…", async () => {
        const targets: readonly DataTokenTarget[] = typeof selection === "string"
          ? ["access", "chat", "skype"]
          : ["chat", "skype"];
        return services.data(targets, async (session, runtime) => {
          let target: MessageTarget;
          let policyTarget: MessageTarget;
          let confirmation: { recipient: string; tenant: string; } | undefined;
          if (typeof selection === "string") {
            const direct = await resolveDirectMessageTarget(session, selection);
            if (selection.includes("@") && !direct.sameTenantMember && !externalRecipientConfirmed) {
              confirmation = {
                recipient: direct.person.displayName ?? direct.person.email ?? selection,
                tenant: direct.person.tenantName ?? direct.person.tenantId ?? "an unverified tenant",
              };
            }
            target = direct.target;
            policyTarget = direct.target;
          } else {
            target = selection;
            policyTarget = resolvePolicyMessageTarget(runtime.identity, target);
          }
          runtime.reportPolicyWarnings(requireMessageSend(runtime.policies, runtime.identity, policyTarget));
          if (confirmation) {
            clearStatus();
            if (!await interactiveAuth.confirm(
              `${confirmation.recipient} is not verified as a member of the current tenant (${confirmation.tenant}). Send the message anyway?`,
            )) {
              throw new Error(
                `Message not sent. Confirm the external recipient in an interactive terminal, or use the recipient's Microsoft user object ID when you already know it.`,
              );
            }
            externalRecipientConfirmed = true;
          }
          return sendMessage(session, target, body, requestId, sessionId, async () => {
            const currentPolicies = await resolvePolicies(paths, subjectPath);
            runtime.reportPolicyWarnings(policyStatusWarnings(currentPolicies));
            runtime.reportPolicyWarnings(requireMessageSend(currentPolicies, runtime.identity, policyTarget));
          });
        }, interactiveAuth);
      });
      return commandResult("sent", result);
    });
}
