import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { ProjectConfig } from './config';

export interface ToolsStackProps extends cdk.StackProps {
    config: ProjectConfig;
}

export class ToolsStack extends cdk.Stack {
    public readonly branchToolsFn: lambda.Function;
    public readonly loanToolsFn: lambda.Function;

    constructor(scope: Construct, id: string, props: ToolsStackProps) {
        super(scope, id, props);

        // ---------- 1. DynamoDB tables ----------
        const branchesTable = new dynamodb.TableV2(this, 'BranchesTableToolCheck', {
            partitionKey: { name: 'city', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'branch_id', type: dynamodb.AttributeType.STRING },
            billing: dynamodb.Billing.onDemand(),
            encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const loanProductsTable = new dynamodb.TableV2(this, 'LoanProductsTableToolCheck', {
            partitionKey: { name: 'product_type', type: dynamodb.AttributeType.STRING },
            billing: dynamodb.Billing.onDemand(),
            encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ---------- 2. Lambda functions (one per tool domain) ----------
        const commonProps = {
            runtime: lambda.Runtime.PYTHON_3_13,
            architecture: lambda.Architecture.ARM_64,
            handler: 'handler.lambda_handler',
            timeout: cdk.Duration.seconds(10),
            memorySize: 256,
        };

        const branchToolsFn = (this.branchToolsFn = new lambda.Function(this, 'BranchMCPToolsFn', {
            ...commonProps,
            description: 'Branch status and representative tools for AgentCore Gateway',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/branch_tools')),
            environment: { BRANCHES_TABLE: branchesTable.tableName },
            logGroup: new logs.LogGroup(this, 'BranchToolsLogs', {
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        }));
        branchesTable.grantReadData(branchToolsFn); // read-only: least privilege

        const loanToolsFn = (this.loanToolsFn = new lambda.Function(this, 'LoanMCPToolsFn', {
            ...commonProps,
            description: 'Loan eligibility and EMI tools for AgentCore Gateway',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/loan_tools')),
            environment: { LOAN_PRODUCTS_TABLE: loanProductsTable.tableName },
            logGroup: new logs.LogGroup(this, 'LoanToolsLogs', {
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        }));
        loanProductsTable.grantReadData(loanToolsFn);

        // The AgentCore Gateway and its targets live in GatewayStack (gateway-stack.ts).

        // ---------- 3. Outputs ----------
        new cdk.CfnOutput(this, 'BranchesTableName', { value: branchesTable.tableName });
        new cdk.CfnOutput(this, 'LoanProductsTableName', { value: loanProductsTable.tableName });
        new cdk.CfnOutput(this, 'BranchToolsFunctionName', { value: branchToolsFn.functionName });
        new cdk.CfnOutput(this, 'LoanToolsFunctionName', { value: loanToolsFn.functionName });
    }
}