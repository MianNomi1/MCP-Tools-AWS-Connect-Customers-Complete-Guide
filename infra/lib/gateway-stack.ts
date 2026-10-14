import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { ProjectConfig } from './config';

export interface GatewayStackProps extends cdk.StackProps {
    config: ProjectConfig;
    branchToolsFn: lambda.IFunction;
    loanToolsFn: lambda.IFunction;
}

const S = agentcore.SchemaDefinitionType; // shorthand for schema types

// Placeholder used only between gateway creation and the audience patch (seconds, same deployment).
const PENDING_AUDIENCE = 'pending-gateway-id';

export class GatewayStack extends cdk.Stack {
    public readonly gateway: agentcore.Gateway;

    constructor(scope: Construct, id: string, props: GatewayStackProps) {
        super(scope, id, props);

        const connectInstanceUrl = props.config.connectInstanceUrl.replace(/\/+$/, '');
        // The discovery URL must be built from the Connect access URL, not the instance ARN or ID.
        if (!/^https:\/\/[^/]+$/.test(connectInstanceUrl)) {
            throw new Error(
                `connectInstanceUrl must be the Connect access URL, e.g. https://my-instance.my.connect.aws. Got: "${props.config.connectInstanceUrl}"`,
            );
        }

        // ---------- 1. AgentCore Gateway (MCP server) ----------
        // Inbound auth is CUSTOM_JWT from creation: the authorizer type cannot be changed later.
        // Connect's token carries the gateway ID as "aud"; that ID only exists after creation,
        // so step 3 patches allowedAudience in the same deployment.
        this.gateway = new agentcore.Gateway(this, 'BankingToolsGateway', {
            gatewayName: 'horizon-bank-mcp-tools-connect',
            description: 'MCP tools for the Horizon Bank assistant. This will eventually be used as a tool for multiple sources',
            authorizerConfiguration: agentcore.GatewayAuthorizer.usingCustomJwt({
                discoveryUrl: `${connectInstanceUrl}/.well-known/openid-configuration`,
                allowedAudience: [PENDING_AUDIENCE],
            }),
        });

        // ---------- 2. Targets: the tool contracts the agent will see ----------
        // The model chooses the tool based on the description
        this.gateway.addLambdaTarget('BranchMCPToolsTarget', {
            gatewayTargetName: 'branch-tools',
            description: 'Branch locations, live open/closed status and staffing',
            lambdaFunction: props.branchToolsFn,
            toolSchema: agentcore.ToolSchema.fromInline([
                {
                    name: 'list_branch_cities',
                    description: 'List all cities where Horizon Bank has at least one branch.',
                    inputSchema: { type: S.OBJECT, properties: {} },
                },
                {
                    name: 'get_branch_status',
                    description:
                        'Get whether each Horizon Bank branch in a city is open right now, with today\'s hours, weekly hours, address and services.',
                    inputSchema: {
                        type: S.OBJECT,
                        properties: {
                            city: { type: S.STRING, description: 'City name, for example "Chicago" or "New York".' },
                        },
                        required: ['city'],
                    },
                },
                {
                    name: 'get_branch_representatives',
                    description:
                        'Get how many representatives (tellers, customer service, loan officers) work at each branch in a city.',
                    inputSchema: {
                        type: S.OBJECT,
                        properties: {
                            city: { type: S.STRING, description: 'City name, for example "Boston".' },
                        },
                        required: ['city'],
                    },
                },
            ]),
        });

        this.gateway.addLambdaTarget('LoanMCPToolsTarget', {
            gatewayTargetName: 'loan-tools',
            description: 'Loan products, indicative eligibility and repayment estimates',
            lambdaFunction: props.loanToolsFn,
            toolSchema: agentcore.ToolSchema.fromInline([
                {
                    name: 'list_loan_products',
                    description: 'List loan products with their current interest rates, limits and eligibility rules.',
                    inputSchema: { type: S.OBJECT, properties: {} },
                },
                {
                    name: 'check_loan_eligibility',
                    description:
                        'Check indicative loan eligibility using the bank\'s rules. Returns eligible true/false, reasons, and the indicative maximum amount.',
                    inputSchema: {
                        type: S.OBJECT,
                        properties: {
                            product_type: { type: S.STRING, description: 'One of: personal, car, home.' },
                            monthly_salary: { type: S.NUMBER, description: 'Gross monthly salary in USD. If the customer gave a range, use the LOWER bound.' },
                            existing_monthly_debt: { type: S.NUMBER, description: 'Total existing monthly debt repayments in USD. Use 0 if none.' },
                            requested_amount: { type: S.NUMBER, description: 'Loan amount requested in USD, if the customer gave one.' },
                            tenure_months: { type: S.INTEGER, description: 'Requested loan term in months, if given.' },
                        },
                        required: ['product_type', 'monthly_salary'],
                    },
                },
                {
                    name: 'calculate_emi',
                    description: 'Calculate the monthly repayment (EMI), total repayment and total interest for a loan.',
                    inputSchema: {
                        type: S.OBJECT,
                        properties: {
                            principal: { type: S.NUMBER, description: 'Loan amount in USD.' },
                            annual_interest_rate: { type: S.NUMBER, description: 'Annual interest rate in percent, for example 7.9.' },
                            tenure_months: { type: S.INTEGER, description: 'Loan term in months.' },
                        },
                        required: ['principal', 'annual_interest_rate', 'tenure_months'],
                    },
                },
            ]),
        });

        // ---------- 3. Custom resource: allowedAudience = gateway ID ----------
        const audienceFn = new lambda.Function(this, 'GatewayAudienceFn', {
            runtime: lambda.Runtime.PYTHON_3_13,
            architecture: lambda.Architecture.ARM_64,
            handler: 'handler.on_event',
            timeout: cdk.Duration.minutes(14),
            memorySize: 256,
            description: 'Sets the AgentCore Gateway JWT allowed audience to the gateway ID',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/gateway_audience')),
            logGroup: new logs.LogGroup(this, 'GatewayAudienceLogs', {
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });
        audienceFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock-agentcore:GetGateway', 'bedrock-agentcore:UpdateGateway'],
            resources: [this.gateway.gatewayArn],
        }));
        // UpdateGateway re-sends the gateway's execution role, which requires PassRole.
        audienceFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['iam:PassRole'],
            resources: [this.gateway.role.roleArn],
            conditions: { StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' } },
        }));

        const provider = new cr.Provider(this, 'GatewayAudienceProvider', {
            onEventHandler: audienceFn,
            logGroup: new logs.LogGroup(this, 'GatewayAudienceProviderLogs', {
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        const cfnGateway = this.gateway.node.defaultChild as agentcore.CfnGateway;
        const audience = new cdk.CustomResource(this, 'GatewayAudience', {
            serviceToken: provider.serviceToken,
            properties: {
                GatewayId: this.gateway.gatewayId,
                // Changes whenever CloudFormation updates the gateway (which resets the audience
                // to the placeholder), so the patch runs again in that same deployment.
                GatewayUpdatedAt: cfnGateway.attrUpdatedAt,
            },
        });
        // Patch only after the gateway and both targets exist.
        audience.node.addDependency(this.gateway);

        // ---------- 4. Outputs ----------
        new cdk.CfnOutput(this, 'GatewayUrl', { value: this.gateway.gatewayUrl! });
        new cdk.CfnOutput(this, 'GatewayId', { value: this.gateway.gatewayId });
        new cdk.CfnOutput(this, 'GatewayDiscoveryUrl', { value: `${connectInstanceUrl}/.well-known/openid-configuration` });
    }
}
