#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import * as dotenv from 'dotenv';
import { loadConfig } from '../lib/config';
import { ToolsStack } from '../lib/tools-stack';
import { GatewayStack } from '../lib/gateway-stack';

dotenv.config();

const app = new cdk.App();
const config = loadConfig(app);

const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
};

// Data + Lambda tools
const toolsStack = new ToolsStack(app, `${config.prefix}-MCP-Tools-banking`, { env, config });

// AgentCore Gateway (MCP server for Amazon Connect). Depends on toolsStack through the Lambda references,
// so `cdk deploy --all` deploys toolsStack first, then this stack, in one run.
new GatewayStack(app, `${config.prefix}-MCP-Gateway-banking`, {
    env,
    config,
    branchToolsFn: toolsStack.branchToolsFn,
    loanToolsFn: toolsStack.loanToolsFn,
});

cdk.Tags.of(app).add('project', 'horizon-bank-mcp-tools');
