package com.databasequeue.demo;

import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;

import java.time.LocalDateTime;
import java.util.*;

import lombok.val;

@RestController
@RequiredArgsConstructor
@RequestMapping("")
public class DemoController {

    private final DemoRepository repository;
    private final SQSSender queueSender;

    private long generateRandomLongWithRange (long min, long max) {
       return min + (long) (Math.random() * (max - min));
    }

    private DemoVo generateRandomData () {
        val eventId = generateRandomLongWithRange(1L, 30000L);
        val userId = generateRandomLongWithRange(1L, 1000L);
        val now = LocalDateTime.now();
        return new DemoVo(eventId, userId, now);
    }

    private void insertDataCasual() {
        val data = generateRandomData();
        val entity = DemoEntity.builder()
                .eventId(data.eventId())
                .userId(data.userId())
                .createdAt(data.createdAt())
                .build();
        repository.save(entity);
    }

    private void insertDataWithQueue() {
        val message = generateRandomData();
        queueSender.sendMessage(message);
    }

    @PostMapping("/demo")
    public ResponseEntity<Map<String, Boolean>> insertData (@RequestParam Boolean useQueue) {
        if (useQueue) {
            insertDataWithQueue();
        } else {
            insertDataCasual();
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("success", true));
    }

    @GetMapping("/demo")
    public ResponseEntity<List<DemoEntity>> getData (@RequestParam(required = false) Boolean orderByTimestamp) {
        if (orderByTimestamp == null || !orderByTimestamp) {
            return ResponseEntity.ok(repository.findTop20ByOrderByIdDesc());
        } else {
            return ResponseEntity.ok(repository.findTop20ByOrderByCreatedAtDesc());
        }
    }

    @GetMapping("")
    public ResponseEntity<String> healthcheck () {
        return ResponseEntity.ok("Welcome to AWS-Database-Queue");
    }
}
