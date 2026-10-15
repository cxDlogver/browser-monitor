# CLI 验收执行记录

批次：2026-10-13T12-12-03-098Z-5ea1a2。实际执行 47 / 47 项，通过 42 项，失败 5 项。结论：尚未全部通过。

每项 case-result.json 保留 R1 / R2 的预期、命令实际输出、具体断言及证据哈希。真实业务输入来自 F:\CX_notes\cx-learn-notes\browser-monitor\Plan\evidence\2026-10-13T11-31-09-545Z-9983c2；公共故障使用独立受控 HTTP 夹具，数据库边界使用实际 SQL 与注明的受控快照时钟。

- AC-01-01：passed，[AC-01-01 记录](AC-01-01/case-result.json)
- AC-01-02：passed，[AC-01-02 记录](AC-01-02/case-result.json)
- AC-01-03：passed，[AC-01-03 记录](AC-01-03/case-result.json)
- AC-02-01：passed，[AC-02-01 记录](AC-02-01/case-result.json)
- AC-02-02：passed，[AC-02-02 记录](AC-02-02/case-result.json)
- AC-02-03：failed，[AC-02-03 记录](AC-02-03/case-result.json)；relation "project_origins" does not exist
- AC-02-04：passed，[AC-02-04 记录](AC-02-04/case-result.json)
- AC-03-01：passed，[AC-03-01 记录](AC-03-01/case-result.json)
- AC-03-02：passed，[AC-03-02 记录](AC-03-02/case-result.json)
- AC-03-03：failed，[AC-03-03 记录](AC-03-03/case-result.json)；use-failed: {
  "schemaVersion": 1,
  "ok": false,
  "command": "project use",
  "context": null,
  "data": null,
  "meta": {
    "source": "platform_api",
    "warnings": []
  },
  "error": {
    "code": "CONTEXT_MISSING",
    "message": "项目上下文文件无法读取或已损坏。",
    "details": null
  }
}


2 !== 8

- AC-04-01：passed，[AC-04-01 记录](AC-04-01/case-result.json)
- AC-04-02：passed，[AC-04-02 记录](AC-04-02/case-result.json)
- AC-04-03：passed，[AC-04-03 记录](AC-04-03/case-result.json)
- AC-05-01：passed，[AC-05-01 记录](AC-05-01/case-result.json)
- AC-05-02：passed，[AC-05-02 记录](AC-05-02/case-result.json)
- AC-05-03：passed，[AC-05-03 记录](AC-05-03/case-result.json)
- AC-06-01：passed，[AC-06-01 记录](AC-06-01/case-result.json)
- AC-06-02：passed，[AC-06-02 记录](AC-06-02/case-result.json)
- AC-06-03：passed，[AC-06-03 记录](AC-06-03/case-result.json)
- AC-06-04：passed，[AC-06-04 记录](AC-06-04/case-result.json)
- AC-06-05：passed，[AC-06-05 记录](AC-06-05/case-result.json)
- AC-07-01：passed，[AC-07-01 记录](AC-07-01/case-result.json)
- AC-07-02：passed，[AC-07-02 记录](AC-07-02/case-result.json)
- AC-08-01：passed，[AC-08-01 记录](AC-08-01/case-result.json)
- AC-08-02：passed，[AC-08-02 记录](AC-08-02/case-result.json)
- AC-08-03：passed，[AC-08-03 记录](AC-08-03/case-result.json)
- AC-08-04：passed，[AC-08-04 记录](AC-08-04/case-result.json)
- AC-09-01：passed，[AC-09-01 记录](AC-09-01/case-result.json)
- AC-09-02：passed，[AC-09-02 记录](AC-09-02/case-result.json)
- AC-09-03：passed，[AC-09-03 记录](AC-09-03/case-result.json)
- AC-10-01：passed，[AC-10-01 记录](AC-10-01/case-result.json)
- AC-10-02：passed，[AC-10-02 记录](AC-10-02/case-result.json)
- AC-10-03：passed，[AC-10-03 记录](AC-10-03/case-result.json)
- AC-10-04：passed，[AC-10-04 记录](AC-10-04/case-result.json)
- AC-11-01：passed，[AC-11-01 记录](AC-11-01/case-result.json)
- AC-11-02：passed，[AC-11-02 记录](AC-11-02/case-result.json)
- AC-11-03：passed，[AC-11-03 记录](AC-11-03/case-result.json)
- AC-11-04：passed，[AC-11-04 记录](AC-11-04/case-result.json)
- AC-11-05：failed，[AC-11-05 记录](AC-11-05/case-result.json)；list capability
+ actual - expected

+ 'PROJECT_UNAVAILABLE'
- 'CAPABILITY_UNAVAILABLE'

- AC-12-01：passed，[AC-12-01 记录](AC-12-01/case-result.json)
- AC-12-02：passed，[AC-12-02 记录](AC-12-02/case-result.json)
- AC-12-03：failed，[AC-12-03 记录](AC-12-03/case-result.json)；slow: {
  "schemaVersion": 1,
  "ok": false,
  "command": "health",
  "context": {
    "baseUrl": "http://127.0.0.1:49717",
    "projectId": null
  },
  "data": {
    "target": "http://127.0.0.1:49717",
    "checkedAt": "2026-10-13T12:15:07.948Z",
    "connectivity": {
      "state": "pass",
      "source": "http_responses",
      "reason": "已收到平台响应"
    },
    "liveness": {
      "state": "pass",
      "source": "/health/live",
      "reason": "平台确认",
      "details": {
        "status": "ok"
      }
    },
    "readiness": {
      "state": "unknown",
      "source": "/health/ready",
      "reason": "REQUEST_TIMEOUT"
    },
    "managementApi": {
      "state": "unknown",
      "authentication": "unknown",
      "source": "/api/v1/auth/me",
      "reason": "REQUEST_TIMEOUT"
    },
    "limitations": [
      "基础健康不证明 Worker 正常或特定项目已经写入、处理。"
    ]
  },
  "meta": {
    "source": "platform_api",
    "warnings": []
  },
  "error": {
    "code": "CAPABILITY_UNAVAILABLE",
    "message": "部分健康检查无法取得必要证据。",
    "details": null
  }
}


4 !== 5

- AC-NET-01：passed，[AC-NET-01 记录](AC-NET-01/case-result.json)
- AC-NET-02：passed，[AC-NET-02 记录](AC-NET-02/case-result.json)
- AC-E2E-01：passed，[AC-E2E-01 记录](AC-E2E-01/case-result.json)
- AC-E2E-02：failed，[AC-E2E-02 记录](AC-E2E-02/case-result.json)；relation "project_origins" does not exist
- AC-E2E-03：passed，[AC-E2E-03 记录](AC-E2E-03/case-result.json)
