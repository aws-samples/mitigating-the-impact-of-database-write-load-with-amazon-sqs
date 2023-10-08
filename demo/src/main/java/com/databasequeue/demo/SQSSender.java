package com.databasequeue.demo;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import io.awspring.cloud.sqs.operations.SqsTemplate;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import lombok.val;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Slf4j
@RequiredArgsConstructor
@Service
public class SQSSender {
        @Value("${spring.cloud.aws.sqs.queue.url}")
        private String queue;

        private final ObjectMapper objectMapper = new ObjectMapper().registerModule(new JavaTimeModule());
        private final SqsTemplate template;

        public void sendMessage(DemoVo msg){
            try {
                val message = objectMapper.writeValueAsString(msg);
                template.send(to -> to
                        .queue(queue)
                        .payload(message));
            } catch (JsonProcessingException ex) {
                log.error(ex.getMessage());
            }
        }
}
