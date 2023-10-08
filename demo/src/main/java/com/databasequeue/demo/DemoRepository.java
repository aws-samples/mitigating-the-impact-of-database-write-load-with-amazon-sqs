package com.databasequeue.demo;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DemoRepository extends JpaRepository<DemoEntity, Long> {
    List<DemoEntity> findTop20ByOrderByIdDesc();
    List<DemoEntity> findTop20ByOrderByCreatedAtDesc();
}
