# Horizon Bank: MCP tools for Amazon Connect AI agents (AgentCore Gateway)

End-to-end guide: deploy the MCP tools with CDK, connect them to Amazon Connect, and build an agentic self-service bank agent for voice and chat.

Assumptions: the Amazon Connect instance exists, AI agents (Connect assistant domain) are enabled, and the knowledge base is created, synced and associated.

---

## 1. What this project is

```
Customer (voice / chat)
   -> Amazon Connect flow
      -> Connect assistant block (creates the AI session)
      -> Get customer input (Conversational AI bot with AMAZON.QinConnectIntent)
         -> Orchestrator AI agent (your prompt + tools)
            -> Retrieve tool          -> Knowledge base (already set up)
            -> MCP tools (JWT auth)   -> AgentCore Gateway "horizon-bank-mcp-tools-connect"
                                           -> target branch-tools -> Lambda BranchToolsFn -> DynamoDB branches table
                                           -> target loan-tools   -> Lambda LoanToolsFn   -> DynamoDB loan products table
         -> Return to Control: Complete / Escalate -> back to the flow
```

| Path | Purpose |
|---|---|
| `infra/bin/mcp-tools.ts` | CDK app. Creates the tools stack and the gateway stack |
| `infra/lib/config.ts` | Prefix, Region and Connect access URL (from `infra/.env`) |
| `infra/lib/tools-stack.ts` | Tools stack: 2 DynamoDB tables, 2 tool Lambdas |
| `infra/lib/gateway-stack.ts` | Gateway stack: AgentCore Gateway (JWT), 2 Lambda targets with 6 tool schemas, audience custom resource |
| `lambdas/gateway_audience/handler.py` | Custom resource that sets the gateway's allowed audience to its own ID |
| `lambdas/branch_tools/handler.py` | `list_branch_cities`, `get_branch_status`, `get_branch_representatives` |
| `lambdas/loan_tools/handler.py` | `list_loan_products`, `check_loan_eligibility`, `calculate_emi` |
| `data/*.json` | Seed data (10 branches, 3 loan products) |
| `scripts/seed_data.py` | Writes seed data into the tables using `infra/outputs.json` |
| `prompts/HorizonBankOrchestrationPrompt.txt` | Orchestration AI prompt |
| `prompts/ToolInstructions.txt` | Per-tool instructions for the AI agent |
| `prompts/FlowMessages.txt` | Text for the flow blocks |

The gateway passes the tool name to Lambda as `<target>___<tool>` in `context.client_context.custom["bedrockAgentCoreToolName"]`. Both handlers split on `___`, so they work as-is.

---

## 3. Prerequisites on your machine

| Tool | Version |
|---|---|
| Node.js | 20+ (your machine has 20.19.3) |
| AWS CLI | v2 (you have 2.34.x) |
| Python | 3.10 or newer. `mcp==1.30.0` does not install on 3.8, and your default `python3` is 3.8. Use `python3.12`. |
| AWS credentials | Admin or equivalent in the account and Region of the Connect instance |

```bash
aws login          # or: aws configure / aws sso login
aws sts get-caller-identity
```

---

## 4. Deploy (one run)

### 4.0 Deploy

Check the discovery URL first:

```bash
curl -s https://<alias>.my.connect.aws/.well-known/openid-configuration
```

It must return JSON with an `issuer` and a `jwks_uri`. Then deploy:

```bash
cd infra
npm ci
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>   # once per account/Region
npx cdk deploy --all --outputs-file outputs.json
```

Run it from `infra/`. `scripts/outputs.py` reads `infra/outputs.json`. The gateway stack takes a little longer because the custom resource waits for the gateway to return to `READY` after the patch.

Outputs:

| Stack | Output | Used for |
|---|---|---|
| Tools | `BranchesTableName`, `LoanProductsTableName` | Seeding |
| Tools | `BranchToolsFunctionName`, `LoanToolsFunctionName` | Lambda tests and logs |
| Gateway | `GatewayId` | Connect integration check (5.1), CLI checks |
| Gateway | `GatewayUrl` | Reference (`https://<gatewayId>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp`) |
| Gateway | `GatewayDiscoveryUrl` | Must match the curl check above |

### 4.1 Verify the gateway

```bash
aws bedrock-agentcore-control get-gateway --gateway-identifier <GatewayId> --region <REGION> \
  --query '{status:status,auth:authorizerType,cfg:authorizerConfiguration,proto:protocolConfiguration}'
aws bedrock-agentcore-control list-gateway-targets --gateway-identifier <GatewayId> --region <REGION> \
  --query 'items[].{name:name,status:status}'
```

Expect:

- status `READY` and `CUSTOM_JWT`
- `allowedAudience` = `["<GatewayId>"]`, not `pending-gateway-id`
- `supportedVersions` containing `2025-03-26`
- both targets `READY`

### 4.2 Seed the data

```bash
cd ..   # project root
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/seed_data.py
```

Expected:

```
Wrote 10 items to <BranchesTableName>
Wrote 3 items to <LoanProductsTableName>
```

## 5. Amazon Connect setup

Do these steps in this order. Step 5.1 is in the AWS console (Amazon Connect > Integrations). Everything else is in the Connect admin website (`https://<alias>.my.connect.aws`).

### 5.1 Register the gateway as an MCP server (AWS console)

1. AWS console > Amazon Connect > Integrations > Add integration.
2. Display name: `HorizonBank-Tools`. Description: `Horizon Bank branch and loan tools`.
3. Integration type: MCP server.
4. Integration details: select the gateway `horizon-bank-mcp-tools-connect`. Do this after section 4.2 shows the real audience.
5. Instance association: select your instance. It must be the instance whose discovery URL is configured on the gateway.
6. Choose Add integration.

Rules from the docs:

- One gateway can be associated with only one instance and one MCP integration.
- Connect discovers tools when the integration is added. If you change gateway auth, the URL or roles later, delete the integration and add it again.

### 5.2 Security profile for the AI agent

Users > Security profiles > Add new security profile.

- Name: `HorizonBank-AI-Agent`
- Description: `Tools the Horizon Bank self-service AI agent may call`
- Permissions:
  - Agent Applications > Connect assistant: View. This is required for the knowledge base Retrieve tool.
  - The MCP tools for the `HorizonBank-Tools` integration: allow all six tools (`list_branch_cities`, `get_branch_status`, `get_branch_representatives`, `list_loan_products`, `check_loan_eligibility`, `calculate_emi`). The tools are listed under your integration's display name. The exact section label can vary between console versions.
  - Do not grant `x_amz_bedrock_agentcore_search` if it is listed.
- Save.

If the integration or its tools are not listed, the gateway handshake failed. See section 9.

Your own admin user also needs AI agent designer permissions: AI agents, AI prompts and AI guardrails (All), Channels and Flows > Bots (All) and Flows (All). The Admin profile already has these.

### 5.3 Orchestration AI prompt

AI agent designer > AI prompts > Create AI prompt.

1. AI prompt type: Orchestration.
2. Name: `HorizonBankOrchestrationPrompt`.
3. Replace the editor content with the full contents of `prompts/HorizonBankOrchestrationPrompt.txt`. It keeps the required `<message>` formatting and the `{{$.toolConfigurationList}}`, `{{$.conversationHistory}}` and `{{$.locale}}` variables.
4. Model: choose from the dropdown. AWS recommends Claude Sonnet for orchestration.
5. Save, then Publish. The AI agent can only select a published version.

The agent only shows text the model wraps in `<message>` tags. Do not remove those instructions from the prompt.

### 5.4 Orchestrator AI agent

AI agent designer > AI agents > Create AI agent.

1. AI agent type: Orchestration.
2. Copy from existing: `SelfServiceOrchestrator`.
3. Name: `HorizonBankSelfServiceAgent`.
4. Locale: `en_US`. This must match the Lex bot locale and the Set voice language.
5. Prompt: select `HorizonBankOrchestrationPrompt` (the published version).
6. Security profiles: select `HorizonBank-AI-Agent`.
5. Tools:
   - Keep the defaults Complete and Escalate (Return to Control). The flow branches on these exact names.
   - Keep Retrieve (knowledge base).
   - Add tool > Add existing AI Tool > Namespace: `HorizonBank-Tools`. Add all six tools.
   - For each tool, paste the matching text from `prompts/ToolInstructions.txt` into Instructions.
8. Optional: add a guardrail.
9. Save, then Publish.

### 5.5 Set it as the default self-service agent

AI agent designer > AI agents > Default AI Agent Configurations > Self Service row > select `HorizonBankSelfServiceAgent` > Save.

### 5.6 Conversational AI bot (Amazon Lex, built in the Connect admin website)

The flow needs an Amazon Lex V2 bot with the built-in intent `AMAZON.QinConnectIntent`. This intent hands each customer turn to the Connect AI agent, which is your orchestrator with its tools. A bot created in the Connect admin website is a normal Lex V2 bot, billed by Amazon Lex. It is already available to the instance's flows, so you don't need a separate association step.

About "Lex with Bedrock": Lex also offers the Bedrock-powered intents `AMAZON.QnAIntent` and `AMAZON.BedrockAgentIntent`. They don't use the Connect AI agent or the MCP tools, and AWS says they cannot be in the same bot locale as `AMAZON.QinConnectIntent`. Don't add them.

Permissions: your user's security profile needs Channels and Flows > Bots > Create. The Admin profile has it.

#### 5.6.1 Create the bot

1. Admin website > Conversational AI > Bots > Create bot. Some doc pages show the path as Routing > Flows > Conversational AI.
2. Details:
   - Bot name: `HorizonBankSelfServiceBot`
   - Bot description: `Front door to the Horizon Bank AI agent`
   - COPPA: No
3. Choose Create.
4. On the bot configuration page, choose Add language. Pick English (US). This must match the Set voice block (5.7) and the AI agent locale `en_US` (5.4).

#### 5.6.2 Enable the AI agent intent

1. Open the bot and choose the Configuration tab.
2. Turn on the `AMAZON.QinConnectIntent` toggle. The toggle is labelled as the agent assist / AI agent intent.
3. In the Enable dialog, choose your Connect assistant ARN from the dropdown (section 6). Choose Confirm.
4. Build the English (US) language.

`AMAZON.QinConnectIntent` is triggered when an utterance doesn't match any other intent in the bot. So don't add custom intents with sample utterances. Any such intent would take customer turns away from the AI agent. The docs say every bot contains the built-in fallback intent by default. If the build still asks for a custom intent, add one named `Placeholder` with a single sample utterance nobody would say (for example `placeholder intent do not use`).

#### 5.6.3 Version and alias

1. Versions tab > Create version > description `v1 AI agent intent` > Create.
2. Aliases tab > Create alias:
   - Name: `live`
   - Version: the version you just created
   - Turn on Enable for use in flow and flow modules. AWS marks this as required to use the bot in a flow.
3. Choose Create.

#### 5.6.4 Chat message streaming

- Instances created after December 2025 have AI message streaming on by default (`MESSAGE_STREAMING` = true).
- Older instances must enable it, otherwise orchestrator chat messages can fail to render. See "Enable message streaming for AI-powered chat".
- Streaming needs `lex:RecognizeMessageAsync` in the bot's resource-based policy. New bot associations get it automatically. If the bot was associated before streaming was enabled, add it in the Lex console > bot > Resource-based policy.

You can't test this intent from the bot's own test window. The intent needs a Connect AI session, and the Connect assistant flow block creates that session. Test through the flow (section 8).

### 5.7 Contact flow: `HorizonBank-SelfService`

Admin website > Routing > Flows > Create flow. The type is Contact flow (inbound). Name it `HorizonBank-SelfService`.

Search the block palette by block name, drag the blocks in, and connect them exactly as in the table. Every Error branch must be connected, or the flow can't be published. The only text the flow needs is in `prompts/FlowMessages.txt`. The AI agent speaks everything else.

| # | Block | Configuration | Branches |
|---|---|---|---|
| 1 | Entry | – | → 2 |
| 2 | Set logging behavior | Enable flow logging. This sends flow logs to CloudWatch for troubleshooting. | Success → 3 |
| 3 | Set voice | Language: English (US). Voice: any. For Lex V2 the language must match the bot language. | Success → 4. Error → 4 |
| 4 | Set recording and analytics behavior | Enable conversational analytics, real-time. The Connect assistant block docs say this is required for AI agents on calls. It is not needed for chat, and the setting has no effect on chat contacts. Contact Lens charges apply. | Success → 5 |
| 5 | Connect assistant | Connect assistant domain ARN: your assistant ARN (section 6). Leave the Agent Assistance orchestration agent empty. Self-service uses the default Self Service agent set in 5.5. This block creates the AI session the Lex intent needs. | Success → 6. Error → 10 |
| 6 | Get customer input | Amazon Lex tab: bot `HorizonBankSelfServiceBot`, alias `live`. Customer prompt or bot initialization: Text-to-speech or chat text, using the "Welcome" text. Intents: none. (If you created `Placeholder`, add it and connect its branch → 10.) | Default → 5. Error → 10 |
| 7 | Check contact attributes | Attribute to check: Namespace Lex, Key Session attributes, Session attribute key `Tool`. Conditions: Equals `Complete`; Equals `Escalate`. | Complete → 11. Escalate → 8. No match → 10 |
| 8 | Set working queue | By queue: `BasicQueue` (or your banking queue) | Success → 9. Error → 10 |
| 9 | Transfer to queue | Transfer to queue tab | At capacity → 10. Error → 10 |
| 10 | Play prompt | Text-to-speech or chat text: the "Error" text | → 11 |
| 11 | Disconnect / hang up | – | – |

Save, then Publish.

How the flow behaves, according to the agentic self-service docs:
- The conversation stays inside block 6 for as many turns as needed. The AI agent calls the MCP tools and Retrieve there, without going back to the flow.
- When the AI agent calls a Return to Control tool (`Complete` or `Escalate`), the conversation ends. Control leaves block 6 through Default, and the tool name is stored in the Lex session attribute `Tool`. Block 7 reads it.
- The orchestration prompt makes the agent thank the customer before Complete and announce the transfer before Escalate. So the flow doesn't play extra goodbye or transfer messages.
- The legacy (non-agentic) self-service sent ESCALATION to the Error branch. That doesn't apply here.

Optional: to show escalation context to the human agent, replace the default Escalate with a custom Return to Control tool that has input fields (docs: "Create custom Return to Control tools"). Then add Set contact attributes between 7 and 8, copying from Namespace Lex, Session attributes.

### 5.8 Attach the flow to channels

- Voice: Channels > Phone numbers > claim or choose a number > Contact flow / IVR: `HorizonBank-SelfService` > Save.
- Chat: Channels > Communications widget > Add widget > Chat flow: `HorizonBank-SelfService`. Add allowed domains (for example `http://localhost` for testing). Or use the Test chat in the admin website and select the flow.

---

## 8. Test scripts (expected answers come from `data/`)

| Say / type | Expected |
|---|---|
| "Is your Seattle branch open?" | Temporarily closed for renovation until November 30, 2026. Suggests Bellevue or the mobile app. |
| "How many staff are at the New York branches?" | 2 branches: Manhattan Midtown 13 (6 tellers, 4 customer service, 3 loan officers), Brooklyn Heights 6 |
| "Do you have a branch in Paris?" | No, then lists the 9 cities |
| "Car loan, I earn 6,000 a month, 500 existing debt, want 30,000 over 60 months" | Eligible at 5.9 percent, with the indicative disclaimer |
| "What's the monthly payment on 30,000 at 5.9 percent for 60 months?" | 606.86 per month, total 36,411.43, interest 6,411.43 |
| "My app keeps crashing" | Steps from the knowledge base (Retrieve) |
| "I want to speak to a person" | Agent says it is connecting you, then Escalate → blocks 8 and 9 → queue |
| "No, that's all, thanks" | Agent thanks you, then Complete → block 11 disconnect |

I checked the loan and EMI figures against the handler code with the seed data.

---

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Integration or tools missing in the security profile or the "Add existing AI Tool" namespace list | Gateway `allowedAudience` = gateway ID. Discovery URL correct, and it resolves with curl. Gateway in the same Region as Connect. `2025-03-26` in supportedVersions. Then delete and re-add the integration (5.1). |
| Agent "thinks" but the customer sees or hears nothing | Prompt is missing the `<message>` tags. For chat, message streaming is off. |
| `Tool is not allowed` | Tool not granted in the `HorizonBank-AI-Agent` security profile, or the profile is not attached to the AI agent |
| Tool returns `{"error": "Internal error..."}` | CloudWatch log groups of `BranchToolsFn` / `LoanToolsFn` |
| `Unknown tool` | Target or tool name changed. The handlers expect the names in `gateway-stack.ts`. |
| Flow never reaches Complete or Escalate | Tool names in the AI agent must be exactly `Complete` / `Escalate` (case-sensitive), matching block 7 |
| Bot or alias not selectable in Get customer input | Alias was created without Enable for use in flow and flow modules (5.6.3). Refresh the flow designer. |
| Get customer input goes straight to Error | Connect assistant block (5) missing or not before block 6. Assistant ARN in the intent differs from the block. Set voice language doesn't match the bot language. |
| `get_branch_status` returns "Internal error" and the Lambda log shows `ZoneInfoNotFoundError` | The runtime has no time zone data. Add `tzdata` to the branch Lambda package. Not expected, see 2.6. |
| `seed_data.py` says "Output is not present" | Stack name fix (2.5), and `outputs.json` written from `infra/` |
| `Authorizer type cannot be updated for an existing gateway` | The gateway was created with a different authorizer type. The type can't change in place. Give the gateway a new construct ID and `gatewayName` so CloudFormation replaces it, or follow 4.0 if you came from the single-stack version. |
| Gateway stack fails on `GatewayAudience` | Open the `GatewayAudienceFn` CloudWatch log. `AccessDenied` means an action is missing from its role policy. Add the action named in the error. A status error includes the gateway's `statusReasons`. |
| `allowedAudience` still shows `pending-gateway-id` | The custom resource didn't run or failed. Check the gateway stack events and the `GatewayAudienceFn` log. |
| Tool timeout | MCP tool calls in Connect time out after 30 s. The Lambda timeout is 10 s. |

Gateway logs are not on by default. Add them in the AgentCore console > Gateways > your gateway > Log delivery. Metrics are under the CloudWatch namespace `AWS/Bedrock-AgentCore`.

---

## 10. Security notes

- The gateway accepts only JWTs from your Connect instance's discovery URL with the gateway ID as audience. Before the patch runs, the placeholder audience rejects all calls.
- Lambdas have read-only DynamoDB access. The gateway role can only invoke the two functions.
- `loan_tools` logs argument names only, never salary values. `branch_tools` logs arguments (only a city).
- The tools return indicative information only. They make no account changes and need no customer authentication. Add customer authentication before you add any tool that reads or changes real customer data.

---

## 11. Clean up

1. Connect: unassign the phone number or widget, then delete the flow, the bot `HorizonBankSelfServiceBot`, the AI agent, the prompt and the security profile.
2. AWS console > Amazon Connect > Integrations: remove the instance association, then delete `HorizonBank-Tools`. An integration can't be deleted while it is still associated.
3. `cd infra && npx cdk destroy --all`. The tables and log groups use `RemovalPolicy.DESTROY`, so the data is deleted.

---

## Sources

- [Integrate an MCP server with Connect](https://docs.aws.amazon.com/connect/latest/adminguide/3p-apps-mcp-server.html)
- [Use agentic self-service](https://docs.aws.amazon.com/connect/latest/adminguide/agentic-self-service.html)
- [How to use orchestrator AI agents](https://docs.aws.amazon.com/connect/latest/adminguide/use-orchestration-ai-agent.html)
- [Assign security profile permissions to AI agents](https://docs.aws.amazon.com/connect/latest/adminguide/ai-agent-security-profile-permissions.html)
- [AMAZON.QinConnectIntent (Lex V2)](https://docs.aws.amazon.com/lexv2/latest/dg/built-in-intent-qinconnect.html)
- [Create a bot in the Connect admin website](https://docs.aws.amazon.com/connect/latest/adminguide/work-bot-building-experience.html)
- [Create an agent assist intent](https://docs.aws.amazon.com/connect/latest/adminguide/create-qic-intent-connect.html)
- [Create bot versions and aliases](https://docs.aws.amazon.com/connect/latest/adminguide/create-bot-version.html)
- [Create a flow and add your bot](https://docs.aws.amazon.com/connect/latest/adminguide/create-bot-flow.html)
- [DynamoDB reserved words](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html)
- [Connect assistant block](https://docs.aws.amazon.com/connect/latest/adminguide/connect-assistant-block.html)
- [Agentic self-service chat end to end](https://docs.aws.amazon.com/connect/latest/adminguide/setup-agentic-selfservice-end-to-end.html)
- [AWS::BedrockAgentCore::Gateway](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-gateway.html)
- [re:Post: troubleshooting AgentCore Gateway with Connect AI agents](https://repost.aws/articles/ARMJsX8dGTT1azK-Mt1rNAxQ/troubleshooting-amazon-bedrock-agentcore-gateway-connection-issues-with-amazon-connect-customer-ai-agents)
- [AWS blog: Customize AI in Amazon Connect Customer](https://aws.amazon.com/blogs/contact-center/customize-ai-in-amazon-connect-customer-agents-prompts-and-guardrails/)

Content from these sources was rephrased for compliance with licensing restrictions.
