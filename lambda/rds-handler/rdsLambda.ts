import {
  GetQueueAttributesCommand,
  GetQueueAttributesCommandInput,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  GetMetricDataCommandInput,
  GetMetricDataCommandOutput,
  MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SQSEvent, SQSRecord, SQSBatchResponse, SQSBatchItemFailure } from "aws-lambda";
import { createConnection, Connection } from "mysql2/promise";
import * as fs from 'fs';
import * as path from 'path';
import * as process from "process";

const ssmClient = new SecretsManagerClient();
const cloudwatchClient = new CloudWatchClient();
const sqsClient = new SQSClient();
const SQS_MESSAGE_LIMIT = parseInt(process.env.SQS_MESSAGE_LIMIT!);
const DB_CPU_LIMIT = parseInt(process.env.DB_CPU_LIMIT!);
const DB_CONNECTION_LIMIT = parseInt(process.env.DB_CONNECTION_LIMIT!);
const DB_METRIC_DURATION = parseInt(process.env.DB_METRIC_DURATION!);

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  console.log("request:", JSON.stringify(event, null, 2));
  console.log(`Getting secret for ${process.env.RDS_SECRET_NAME}`);
  const secret = await retrieveSecret();
  const { Records: messages } = event;

  if (!secret) {
    console.error("Secret is not found");
    return createFailResponse(messages);
  }
  const { username, password, dbInstanceIdentifier: dbIdentifier } = JSON.parse(secret);
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    console.error("Queue url is not found");
    return createFailResponse(messages);
  }
  const CHECK_COUNT = Number(process.env.CHECK_COUNT);
  const jitter = rand(0, 3);

  // Check if it's OK to insert
  for (let i=0; i<CHECK_COUNT + jitter; i++) {
    const shouldBeRest = await checkThrottle(dbIdentifier, queueUrl);
    console.log("Should be rest?", shouldBeRest);
    if (shouldBeRest) await sleep(0);
    else break;
  }

  const connection = await createConnection({
    host:  process.env.PROXY_ENDPOINT,
    user:  username,
    password:  password,
    database: 'traffic',
    ssl  : {
      ca: fs.readFileSync(path.resolve() + '/AmazonRootCA1.pem')
    }
  });

  console.log("Start to insert records");
  const batchItemFailures: SQSBatchItemFailure[] = [];
  await Promise.allSettled(messages.map(async (message: SQSRecord) => {
    const { body } = message;
    const jsonBody = JSON.parse(body);
    try {
      await insertRecord(connection, jsonBody);
    } catch (e) {
      const err = e as MySQLError;
      if (err.code === 'ER_DUP_ENTRY') {
        console.log("Not UQ values and check errored json Body :", JSON.parse(body));
      }
      else {
        console.error("Check errored json Body :", JSON.parse(body));
        console.error(err);
        const batchItemFailure: SQSBatchItemFailure = {
          itemIdentifier: message.messageId
        };
        batchItemFailures.push(batchItemFailure);
      }
    }
  }));

  connection.destroy();

  return {
    batchItemFailures: batchItemFailures,
  };
};

const createFailResponse = (messages: SQSRecord[]): SQSBatchResponse => {
  const retryMessages = messages.map((m): SQSBatchItemFailure => {
    return { itemIdentifier: m.messageId }
  });
  return {
    batchItemFailures: retryMessages
  };
}

// Retrieve the username and password for MySQL from secrets manager
const retrieveSecret = async () => {
  const secretCommand = new GetSecretValueCommand({ SecretId: process.env.RDS_SECRET_NAME });
  const secret = await ssmClient.send(secretCommand);
  const isSecretPresent = !!secret;
  if (isSecretPresent) return secret.SecretString;
  else return null;
}

// Check if the lambda need to stop the insert
const checkThrottle = async (dbIdentifier: string, queueUrl: string) => {
  const isRdsThrottle = await checkRDSThrottle(dbIdentifier);
  const isQueueThrottle = await checkQueueThrottle(queueUrl);
  console.log("Throttle Status[RDS, SQS] :", isRdsThrottle, isQueueThrottle);
  return isRdsThrottle || isQueueThrottle;
}

const checkRDSMetricNotExist = (metric: MetricDataResult) => {
  return !metric || !metric.Values || metric.Values.length === 0;
}

const checkRDSThrottle = async (dbIdentifier: string) => {
  try {
    const {MetricDataResults: metrics} = await getRDSMetrics(dbIdentifier, DB_METRIC_DURATION);
    if (!metrics || metrics.length === 0 || checkRDSMetricNotExist(metrics[0]) || checkRDSMetricNotExist(metrics[1])) {
      console.log("Can't get metric about RDS. Please check this.");
      return false;
    }
    const connectionMetrics = metrics[0].Values!;
    const cpuMetrics = metrics[1].Values!;
    console.log("Database Connection Metric :", connectionMetrics);
    console.log("Database CPU Metric:", cpuMetrics);
    const isConnectionThrottle = !!(connectionMetrics.find((numOfConnection) => numOfConnection > DB_CONNECTION_LIMIT));
    const isCPUThrottle = !!(cpuMetrics.find((numOfCPU) => numOfCPU > DB_CPU_LIMIT));
    const isThrottleCondition = isConnectionThrottle || isCPUThrottle;
    return isThrottleCondition;
  } catch (error) {
    console.log("Error when checking rds throttle", error);
    return true;
  }
}

const checkQueueThrottle = async (queueUrl: string) => {
  const { Attributes: attributes } = await getQueueMessageMetrics(queueUrl);
  if (!attributes) {
    console.error("Attributes is not existed");
    return false;
  }
  const numberOfMessages = parseInt(attributes["ApproximateNumberOfMessages"]);
  const numberOfMessagesDelayed = parseInt(attributes["ApproximateNumberOfMessagesDelayed"]);
  const numberOfMessagesNotVisible = parseInt(attributes["ApproximateNumberOfMessagesNotVisible"]);
  console.log("Message Condition :", numberOfMessages, numberOfMessagesDelayed, numberOfMessagesNotVisible);
  const numOfMessagesNotVisibleThrottle = numberOfMessagesNotVisible > SQS_MESSAGE_LIMIT;
  const isThrottleCondition = numOfMessagesNotVisibleThrottle;
  return isThrottleCondition;
}

// Get Queue metrics about messages
const getQueueMessageMetrics = async (queueUrl:string) => {
  const getAttributeInput: GetQueueAttributesCommandInput = {
    QueueUrl: queueUrl,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesDelayed", "ApproximateNumberOfMessagesNotVisible"],
  }
  const command = new GetQueueAttributesCommand(getAttributeInput);
  return await sqsClient.send(command);
}

// Get RDS metrics
const getRDSMetrics = async (dbIdentifier: string, min: number): Promise<GetMetricDataCommandOutput> => {
  const now = new Date();
  const input: GetMetricDataCommandInput = {
    MetricDataQueries: [
      {
        Id: "databaseConnectionMetrics",
        MetricStat: {
          Metric: {
            Namespace: "AWS/RDS",
            MetricName: "DatabaseConnections",
            Dimensions: [
              {
                Name: 'DBInstanceIdentifier',
                Value: dbIdentifier,
              },
            ],
          },
          Period: 60,
          Stat: "Average",
          Unit: "Count",
        },
      },
      {
        Id: "databaseCPUMetrics",
        MetricStat: {
          Metric: {
            Namespace: "AWS/RDS",
            MetricName: "CPUUtilization",
            Dimensions: [
              {
                Name: 'DBInstanceIdentifier',
                Value: dbIdentifier,
              },
            ],
          },
          Period: 60,
          Stat: "Average",
          Unit: "Percent",
        },
      },
    ],
    StartTime: new Date(now.getTime() - 1 * 1000 * 60 * min),
    EndTime: now,
  };
  const command = new GetMetricDataCommand(input);
  return await cloudwatchClient.send(command);
}

const insertRecord = async (connection: Connection, jsonBody: any) => {
  await connection.query(`INSERT INTO demo(event_id, user_id, created_at) VALUES ('${jsonBody["eventId"]}', ${jsonBody["userId"]}, '${jsonBody["createdAt"]}')`);
}

const rand = (min: number, max: number) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const sleep = (seconds: number) => {
  const jitter = rand(0, 1500);
  return new Promise(resolve => {
    // Use jitter for preventing requests from flooding at the same time
    setTimeout(resolve, seconds * 1000 + jitter);
  });
}

export interface MySQLError {
  readonly code: string | undefined;
}