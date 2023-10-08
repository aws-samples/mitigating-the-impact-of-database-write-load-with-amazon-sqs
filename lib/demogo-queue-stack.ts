import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2"
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Dashboard, GraphWidget, Metric } from 'aws-cdk-lib/aws-cloudwatch';
import * as dotenv from 'dotenv';
import {SqsEventSource} from "aws-cdk-lib/aws-lambda-event-sources";
dotenv.config({ path: __dirname + '/.env'});

export class DemogoQueueStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // RDS needs to be setup in a VPC
    const vpc = new ec2.Vpc(this, id+'-vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'public-subnet-1',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'public-subnet-2',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private-subnet-1',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'private-subnet-2',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ]
    });

    // We need this security group to add an ingress rule and allow our lambda to query the proxy
    const lambdaToRDSProxyGroup = new ec2.SecurityGroup(this, 'Lambda to RDS Proxy Connection', {
      vpc
    });
    // We need this security group to allow our proxy to query our MySQL Instance
    const dbConnectionGroup = new ec2.SecurityGroup(this, 'Proxy to DB Connection', {
      vpc
    });

    const ec2InstanceSG = new ec2.SecurityGroup(this, id+'-ec2-instance-sg', {
      vpc
    });

    dbConnectionGroup.addIngressRule(dbConnectionGroup, ec2.Port.tcp(3306), 'allow db connection');
    dbConnectionGroup.addIngressRule(lambdaToRDSProxyGroup, ec2.Port.tcp(3306), 'allow lambda connection');
    dbConnectionGroup.addIngressRule(ec2InstanceSG, ec2.Port.tcp(3306), 'allow instance connection')

    const databaseUsername = process.env.DB_USERNAME;
    const rdsSecretName = `dev/${id}`

    // Dynamically generate the username and password, then store in secrets manager
    const databaseCredentialsSecret = new secrets.Secret(this, 'DBCredentialsSecret', {
      secretName: rdsSecretName,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: databaseUsername,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    new ssm.StringParameter(this, 'DBCredentialsArn', {
      parameterName: 'rds-credentials-arn',
      stringValue: databaseCredentialsSecret.secretArn,
    });

    // MySQL DB Instance (delete protection turned off because pattern is for learning.)
    // re-enable delete protection for a real implementation
    const rdsInstance = new rds.DatabaseInstance(this, 'DBInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7_37
      }),
      credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.MEDIUM),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      securityGroups: [dbConnectionGroup],
      databaseName: 'traffic',
      enablePerformanceInsights: true
    });

    // Create an RDS Proxy
    const proxy = rdsInstance.addProxy(id+'-proxy', {
      secrets: [databaseCredentialsSecret],
      debugLogging: true,
      vpc,
      securityGroups: [dbConnectionGroup]
    });
    
    // Workaround for bug where TargetGroupName is not set but required
    const targetGroup = proxy.node.children.find((child:any) => {
      return child instanceof rds.CfnDBProxyTargetGroup
    }) as rds.CfnDBProxyTargetGroup

    targetGroup.addPropertyOverride('TargetGroupName', 'default');

    // Queue with Lambda
    const queue = new sqs.Queue(this, id+'-queue', {
      visibilityTimeout: cdk.Duration.seconds(180)
    });

    const cloudwatchMetricsPolicy = new iam.PolicyStatement({
      actions: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricData'],
      resources: ['*']
    })

    // Lambda to Interact with RDS Proxy
    const rdsLambda = new lambda.Function(this, id+'-rdsProxyHandler', {
      runtime: lambda.Runtime.NODEJS_16_X,
      code: lambda.Code.fromAsset('lambda/rds-handler'), 
      handler: 'rdsLambda.handler',
      vpc: vpc,
      securityGroups: [lambdaToRDSProxyGroup],
      environment: {
        PROXY_ENDPOINT: proxy.endpoint,
        RDS_SECRET_NAME: rdsSecretName,
        SQS_QUEUE_URL: queue.queueUrl,
        CHECK_COUNT: "4",
        SQS_MESSAGE_LIMIT: "10000",
        DB_CPU_LIMIT: "10",
        DB_CONNECTION_LIMIT: "80",
        DB_METRIC_DURATION: "2"
      },
      initialPolicy: [ cloudwatchMetricsPolicy ],
      timeout: cdk.Duration.seconds(30)
    });
    databaseCredentialsSecret.grantRead(rdsLambda);
    queue.grantConsumeMessages(rdsLambda);

    rdsLambda.addEventSource(
        new SqsEventSource(queue, {
          batchSize: 10,
          maxConcurrency: 500,
          reportBatchItemFailures: true
        }),
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, id+'-alb', {
      vpc,
      vpcSubnets: { onePerAz: true, subnetType: ec2.SubnetType.PUBLIC },
      internetFacing: true,
    });

    const listener = alb.addListener('Listener', {
      port: 80,
      open: true,
    });

    const forkedUrl: String = process.env.FORKED_URL!!;
    const delimiter = "//";
    const credentialPos = forkedUrl.indexOf(delimiter) + delimiter.length;
    const gitUrl = forkedUrl.slice(0, credentialPos)
        + process.env.GITHUB_USERNAME + ":" + process.env.GITHUB_TOKEN + "@"
        + forkedUrl.slice(credentialPos);
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
        'sudo su',
        'yum update -y',
        'yum install git -y',
        'yum install java-17-amazon-corretto-devel -y',
        'yum install wget -y',
        'wget https://services.gradle.org/distributions/gradle-8.2.1-bin.zip',
        'mkdir /opt/gradle',
        'unzip -d /opt/gradle gradle-8.2.1-bin.zip',
        'rm -rf ./gradle-8.2.1-bin.zip',
        'echo -e "export GRADLE_HOME=/opt/gradle/gradle-8.2.1\\nexport PATH=\\${GRADLE_HOME}/bin:\\${PATH}" > /etc/profile.d/gradle.sh',
        'chmod +x /etc/profile.d/gradle.sh',
        'source /etc/profile.d/gradle.sh',
        `git clone ${gitUrl}`,
        'cd /aws-database-queue/demo',
        `sed -i "s|{RDS_HOST_NAME}|${proxy.endpoint}|g" -i ./src/main/resources/application.yml`,
        `sed -i "s|{CREDENTIAL_NAME}|${rdsSecretName}|g" -i ./src/main/resources/application.yml`,
        `sed -i "s/{AWS_ACCESS_KEY}/${process.env.AWS_ACCESS_KEY}/g" -i ./src/main/resources/application.yml`,
        `sed -i "s|{AWS_SECRET_KEY}|${process.env.AWS_SECRET_KEY}|g" -i ./src/main/resources/application.yml`,
        `sed -i "s/{SQS_QUEUE_NAME}/${queue.queueName}/g" -i ./src/main/resources/application.yml`,
        `sed -i "s|{SQS_QUEUE_URL}|${queue.queueUrl}|g" -i ./src/main/resources/application.yml`,
        'chmod +x ./gradlew',
        './gradlew build',
        'sleep 15m',
        'nohup java -jar ./build/libs/demo-0.0.1-SNAPSHOT.jar > nohup.out 2>&1 &'
    );

    ec2InstanceSG.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(22),
        'allow SSH connections from anywhere',
    );

    // 👇 create auto-scaling group
    const asg = new autoscaling.AutoScalingGroup(this, id+'-asg', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: ec2InstanceSG,
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE3,
          ec2.InstanceSize.SMALL,
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      userData,
      defaultInstanceWarmup: cdk.Duration.minutes(20),
      minCapacity: 4,
      maxCapacity: 4,
    });

    databaseCredentialsSecret.grantRead(asg);

    // 👇 add target to the ALB listener
    listener.addTargets('default-target', {
      port: 8080,
      targets: [asg],
      healthCheck: {
        path: '/',
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 5,
        interval: cdk.Duration.seconds(30),
      },
    });

    // 👇 add scaling policy for the Auto Scaling Group
    asg.scaleOnCpuUtilization('cpu-util-scaling', {
      targetUtilizationPercent: 75,
    });

    const dashboard = new Dashboard(this, id + '-dashboard', {
      dashboardName: 'rds-dashboard'
    });

    const cpuUtilWidget = new GraphWidget({
      width: 24,
      title: 'Database CPUUtilization',
      left: [
          new Metric({
            metricName: 'CPUUtilization',
            namespace: 'AWS/RDS',
            statistic: 'avg',
            label: 'CPU',
            period: cdk.Duration.minutes(1),
            dimensionsMap: {
              'DBInstanceIdentifier': rdsInstance.instanceIdentifier
            }
          })
      ]
    });

    const queueWidget = new GraphWidget({
      width:24,
      title: 'Queue Message Metrics',
      left: [
          new Metric({
            metricName: 'ApproximateNumberOfMessagesNotVisible',
            namespace: 'AWS/SQS',
            statistic: 'avg',
            label: 'MsgNotVisible',
            period: cdk.Duration.minutes(1),
            dimensionsMap: {
              'QueueName': queue.queueName
            }
          }),
        new Metric({
          metricName: 'ApproximateNumberOfMessagesVisible',
          namespace: 'AWS/SQS',
          statistic: 'avg',
          label: 'MsgVisible',
          period: cdk.Duration.minutes(1),
          dimensionsMap: {
            'QueueName': queue.queueName
          }
        })
      ]
    })

    dashboard.addWidgets(cpuUtilWidget);
    dashboard.addWidgets(queueWidget)

    new cdk.CfnOutput(this, 'ALB DNS Name', {
      value: alb.loadBalancerDnsName ?? 'Something went wrong with the deploy'
    });

    new cdk.CfnOutput(this, 'Queue URL', {
      value: queue.queueUrl ?? 'Something went wrong with the deploy'
    });
  }
}