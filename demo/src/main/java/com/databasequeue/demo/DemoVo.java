package com.databasequeue.demo;

import java.time.LocalDateTime;

public record DemoVo(
        Long eventId,
        Long userId,
        LocalDateTime createdAt
) {}
