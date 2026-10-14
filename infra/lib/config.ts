import { App } from 'aws-cdk-lib';

export interface ProjectConfig {
    prefix: string;
    region: string;
    /** Connect ACCESS URL (not the ARN), no trailing slash. Example: https://my-instance.my.connect.aws */
    connectInstanceUrl: string;
}

export function loadConfig(app: App): ProjectConfig {
    return {
        prefix: 'HorizonBankMCPTools',
        region: process.env.REGION || 'us-east-1', // must be the SAME Region as your Connect instance
        connectInstanceUrl: process.env.INSTANCE_URL || '',
    };
}
