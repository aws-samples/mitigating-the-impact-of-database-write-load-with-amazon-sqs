package com.databasequeue.demo;

import com.amazonaws.xray.AWSXRay;
import com.amazonaws.xray.AWSXRayRecorderBuilder;
import com.amazonaws.xray.jakarta.servlet.AWSXRayServletFilter;
import com.amazonaws.xray.plugins.EC2Plugin;
import com.amazonaws.xray.strategy.LogErrorContextMissingStrategy;
import com.amazonaws.xray.strategy.sampling.CentralizedSamplingStrategy;
import lombok.val;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import jakarta.servlet.Filter;

@Configuration
public class WebConfig {
    static {
        val builder = AWSXRayRecorderBuilder.standard().withPlugin(new EC2Plugin());

        val ruleFile = WebConfig.class.getResource("/sampling-rules.json");
        builder.withSamplingStrategy(new CentralizedSamplingStrategy(ruleFile));
        builder.withContextMissingStrategy(new LogErrorContextMissingStrategy());
        AWSXRay.setGlobalRecorder(builder.build());
    }

    @Bean
    public Filter TracingFilter() {
        return new AWSXRayServletFilter("DemoApp");
    }
}
