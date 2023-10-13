# How to run load-tester.jmx

1. Launch the EC2 instance at same VPC. The subnet should be **public** for downloading JMeter through the internet.

2. Run these commands
```shell
$ sudo su

$ yum update -y

$ sudo yum install java-17-amazon-corretto -y

# I used 5.5 version. 
## However, You can use any other version according to the JMeter test schedule.
$ wget https://dlcdn.apache.org//jmeter/binaries/apache-jmeter-5.5.tgz

$ tar -xf apache-jmeter-5.5.tgz
```

3. Set the jmx file at same directory using scp or vi

4. Run the .jmx

```shell

$ ./apache-jmeter-5.5/bin/jmeter -n -t ./load-tester.jmx -l ./result.jtl
```